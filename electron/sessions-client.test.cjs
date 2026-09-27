"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listSessions, tailTranscript } = require("./sessions-client.cjs");

function fakeFetch({ status = 200, body = { sessions: [] }, throws = null } = {}) {
  return async (_url, opts) => {
    if (throws) throw throws;
    fakeFetch.lastOpts = opts;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

test("listSessions: happy path passes the bearer and returns the rows", async () => {
  process.env.AITHER_HARNESS_TOKEN = "test-token";
  try {
    const fetchImpl = fakeFetch({ body: { sessions: [{ id: "s1", title: "tab", status: "working" }] } });
    const result = await listSessions({ fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.sessions.length, 1);
    assert.equal(fakeFetch.lastOpts.headers.Authorization, "Bearer test-token");
  } finally {
    delete process.env.AITHER_HARNESS_TOKEN;
  }
});

test("listSessions: a refused token and an unreachable daemon are DIFFERENT notes", async () => {
  process.env.AITHER_HARNESS_TOKEN = "stale";
  try {
    const refused = await listSessions({ fetchImpl: fakeFetch({ status: 401 }) });
    assert.equal(refused.ok, false);
    assert.match(refused.note, /refused the token/);

    const down = await listSessions({ fetchImpl: fakeFetch({ throws: new Error("ECONNREFUSED") }) });
    assert.equal(down.ok, false);
    assert.match(down.note, /unreachable/);
    assert.deepEqual(down.sessions, []);
  } finally {
    delete process.env.AITHER_HARNESS_TOKEN;
  }
});

test("listSessions: no token anywhere is its own state, never an empty-but-fine list", async () => {
  const savedEnv = process.env.AITHER_HARNESS_TOKEN;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  delete process.env.AITHER_HARNESS_TOKEN;
  // os.homedir() on win32 reads USERPROFILE, NOT HOME -- overriding only HOME
  // left this test reading the REAL token file and passing for the wrong reason.
  const fakeHome = path.join(os.tmpdir(), "no-such-home-" + Date.now());
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const result = await listSessions({ fetchImpl: fakeFetch({}) });
    assert.equal(result.ok, false);
    assert.match(result.note, /no harness token/);
  } finally {
    if (savedEnv !== undefined) process.env.AITHER_HARNESS_TOKEN = savedEnv;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

test("tailTranscript: returns the LAST lines, and a byte window keeps whole lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-tail-test-"));
  const file = path.join(dir, "t.jsonl");
  try {
    const rows = [];
    for (let i = 1; i <= 200; i += 1) rows.push(JSON.stringify({ type: "user", n: i }));
    fs.writeFileSync(file, rows.join("\n") + "\n", "utf8");

    const full = tailTranscript(file, { maxLines: 10 });
    assert.equal(full.ok, true);
    assert.equal(full.lines.length, 10);
    assert.match(full.lines[9], /\{"type":"user","n":200\}/);

    // A byte window that starts mid-file must open on a line boundary -- a
    // half-line would render as a JSON parse failure on every poll.
    const windowed = tailTranscript(file, { maxLines: 50, maxBytes: 300 });
    assert.equal(windowed.ok, true);
    assert.equal(windowed.truncated, true);
    for (const line of windowed.lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tailTranscript: a missing path or file is a note, never a throw", () => {
  assert.equal(tailTranscript("").ok, false);
  const missing = tailTranscript(path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".jsonl"));
  assert.equal(missing.ok, false);
  assert.match(missing.note, /cannot read transcript/);
});

test("sessionsBrief: working first, capped, and 'could not look' is never an empty list", () => {
  const { sessionsBrief } = require("./sessions-client.cjs");
  const brief = sessionsBrief({
    ok: true,
    sessions: [
      { id: "idle-one-000000", status: "idle", harness: "awdk", title: "local loop" },
      { id: "work-one-000000", status: "working", harness: "claude", title: "fixing the fleet", last_activity_summary: "ran the gates" },
      { id: "wait-one-000000", status: "waiting-input", harness: "claude", title: "needs you" },
    ],
  }, { max: 2 });
  const lines = brief.split("\n");
  assert.match(lines[1], /^- \[working\] claude work-one-000: fixing the fleet -- ran the gates$/);
  assert.match(lines[2], /^- \[waiting-input\]/);
  assert.ok(brief.includes("(+1 more)"));
  assert.ok(brief.includes("awsh_send"));
  assert.match(sessionsBrief({ ok: false, sessions: [], note: "daemon unreachable" }), /unknown right now \(daemon unreachable\)/);
  assert.equal(sessionsBrief({ ok: true, sessions: [] }), "The owner has no active agent sessions right now.");
});

// ── the shared poller (one fetch loop; Home and the Sessions pane read it) ──

const { createSessionsPoller, agoLabel } = require("./sessions-client.cjs");

function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    pending,
  };
}

test("poller: a read after a failure serves the last GOOD rows, marked stale with their age", async () => {
  let clock = 1_000_000;
  const answers = [
    { ok: true, sessions: [{ id: "a" }, { id: "b" }], note: "2 session(s)" },
    { ok: false, sessions: [], note: "daemon did not answer within 20s" },
  ];
  const seenTimeouts = [];
  const timers = manualTimers();
  const poller = createSessionsPoller({
    list: async ({ timeoutMs }) => { seenTimeouts.push(timeoutMs); return answers.shift(); },
    now: () => clock,
    ...timers,
  });
  const first = await poller.get();
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  assert.equal(first.sessions.length, 2);
  assert.deepEqual(seenTimeouts, [20000], "one fetch, with the generous timeout");
  assert.equal(timers.pending.length, 1, "the next tick is scheduled");
  assert.equal(timers.pending[0].ms, 3000);

  clock += 42_000;
  await poller.refresh();
  const second = await poller.get();
  assert.equal(second.ok, true, "a known list is never turned into an error");
  assert.equal(second.stale, true);
  assert.equal(second.sessions.length, 2);
  assert.equal(second.staleNote, "last known 2 sessions (42s ago)");
  assert.match(second.note, /^last known 2 sessions \(42s ago\) — daemon did not answer/);
  poller.stop();
});

test("poller: an error is shown only when there was never a good read", async () => {
  const poller = createSessionsPoller({
    list: async () => ({ ok: false, sessions: [], note: "daemon unreachable" }),
    ...manualTimers(),
  });
  const view = await poller.get();
  assert.equal(view.ok, false);
  assert.equal(view.note, "daemon unreachable");
  poller.stop();
});

test("poller: concurrent readers share ONE in-flight fetch, and later reads do not wait", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const poller = createSessionsPoller({
    list: async () => { calls += 1; await gate; return { ok: true, sessions: [{ id: "a" }] }; },
    ...manualTimers(),
  });
  const reads = [poller.get(), poller.get(), poller.get()];
  release();
  const views = await Promise.all(reads);
  assert.equal(calls, 1);
  assert.ok(views.every((v) => v.ok && v.sessions.length === 1));

  // With a view in hand, a slow refresh does not hold the next reader.
  let hang;
  const poller2Hang = new Promise((resolve) => { hang = resolve; });
  const slow = createSessionsPoller({
    list: async () => { calls += 1; if (calls > 2) await poller2Hang; return { ok: true, sessions: [] }; },
    ...manualTimers(),
  });
  await slow.get();
  void slow.refresh(); // parks on poller2Hang
  const started = Date.now();
  const quick = await slow.get();
  assert.ok(Date.now() - started < 50);
  assert.equal(quick.ok, true);
  hang();
  poller.stop();
  slow.stop();
});

test("poller: the daemon's own stale flag passes through", async () => {
  const poller = createSessionsPoller({
    list: async () => ({ ok: true, sessions: [], daemonStale: true, generatedAt: 1 }),
    ...manualTimers(),
  });
  const view = await poller.get();
  assert.equal(view.ok, true);
  assert.equal(view.stale, true);
  poller.stop();
});

test("listSessions: carries the daemon's generated_at (ms) and stale", async () => {
  process.env.AITHER_HARNESS_TOKEN = "test-token";
  try {
    const result = await listSessions({
      fetchImpl: fakeFetch({ body: { sessions: [], generated_at: 1700000000.5, stale: true } }),
    });
    assert.equal(result.generatedAt, 1700000000500);
    assert.equal(result.daemonStale, true);
  } finally {
    delete process.env.AITHER_HARNESS_TOKEN;
  }
});

test("agoLabel: seconds, then minutes, then hours", () => {
  assert.equal(agoLabel(5_000), "5s ago");
  assert.equal(agoLabel(5 * 60_000), "5m ago");
  assert.equal(agoLabel(3 * 3_600_000), "3h ago");
});

test("every main-process sessions reader goes through the shared poller", () => {
  for (const file of ["home-ipc.cjs", "sessions-window.cjs", "command-agent.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(src, /sharedSessionsPoller\(\)/, `${file} reads the shared poller`);
    assert.doesNotMatch(src, /listSessions\(/, `${file} must not fetch on its own`);
  }
});

// ── sessions S1: the verbs ────────────────────────────────────────────────────

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const { status = 200, body = {} } = responses.shift() || {};
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { calls, fetchImpl };
}

async function withToken(fn) {
  process.env.AITHER_HARNESS_TOKEN = "test-token";
  try { return await fn(); } finally { delete process.env.AITHER_HARNESS_TOKEN; }
}

test("messageSession POSTs trimmed text to /message with the bearer", async () => {
  const { messageSession } = require("./sessions-client.cjs");
  await withToken(async () => {
    const { calls, fetchImpl } = recordingFetch([{ body: { ok: true, delivered_at: "next-prompt" } }]);
    const r = await messageSession("abc-123", "  look at CI  ", { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.body.delivered_at, "next-prompt");
    assert.match(calls[0].url, /\/sessions\/abc-123\/message$/);
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { text: "look at CI" });
  });
});

test("a refused verb carries the daemon's own detail, never a bare failure", async () => {
  const { focusSession, interruptSession } = require("./sessions-client.cjs");
  await withToken(async () => {
    const { fetchImpl } = recordingFetch([
      { status: 403, body: { detail: "focus is local only" } },
      { status: 404, body: { detail: "no such session" } },
    ]);
    const f = await focusSession("abc", { fetchImpl });
    assert.equal(f.ok, false);
    assert.equal(f.note, "focus is local only");
    const i = await interruptSession("abc", { fetchImpl });
    assert.equal(i.note, "no such session");
  });
});

test("a session id that is not a plain token never reaches a URL", async () => {
  const { messageSession, focusSession, interruptSession } = require("./sessions-client.cjs");
  await withToken(async () => {
    const { calls, fetchImpl } = recordingFetch([]);
    for (const bad of ["../x", "a/b", "", "..", "a b"]) {
      assert.equal((await messageSession(bad, "hi", { fetchImpl })).ok, false);
      assert.equal((await focusSession(bad, { fetchImpl })).ok, false);
      assert.equal((await interruptSession(bad, { fetchImpl })).ok, false);
    }
    assert.equal(calls.length, 0);
    // ...and an empty message is refused before the network too.
    assert.equal((await messageSession("abc", "   ", { fetchImpl })).note, "type a message first");
    assert.equal(calls.length, 0);
  });
});

test("spawnSession sends harness + cwd; listHarnesses keeps installed ones only", async () => {
  const { spawnSession, listHarnesses } = require("./sessions-client.cjs");
  await withToken(async () => {
    const { calls, fetchImpl } = recordingFetch([
      { body: { id: "new1" } },
      { body: { harnesses: [
        { id: "claude", label: "Claude Code", installed: true },
        { id: "gemini", label: "Gemini", installed: false },
      ] } },
    ]);
    const r = await spawnSession({ cwd: "C:\\w", harness: "claude" }, { fetchImpl });
    assert.equal(r.body.id, "new1");
    assert.match(calls[0].url, /\/sessions$/);
    assert.deepEqual(JSON.parse(calls[0].opts.body), { harness: "claude", cwd: "C:\\w", title: "" });
    const h = await listHarnesses({ fetchImpl });
    assert.deepEqual(h.harnesses, [{ id: "claude", label: "Claude Code" }]);
  });
});

test("defaultSessionCwd: env first, then the main checkout when it exists, else home", () => {
  const { defaultSessionCwd } = require("./sessions-client.cjs");
  assert.equal(defaultSessionCwd({ env: { AITHER_SESSION_CWD: "X:\\y" } }), "X:\\y");
  assert.equal(defaultSessionCwd({ env: {}, exists: () => false }), os.homedir());
  if (process.platform === "win32") {
    assert.equal(defaultSessionCwd({ env: {}, exists: () => true }), "C:\\AitherOS-Fresh");
  }
});

test("verb handlers refresh the shared poller only after a verb that succeeded", async () => {
  const { sessionVerbHandlers } = require("./sessions-window.cjs");
  let refreshed = 0;
  const fake = {
    sharedSessionsPoller: () => ({ refresh: () => { refreshed += 1; return Promise.resolve(); } }),
    messageSession: async (id, text) => ({ ok: id === "good", note: text }),
    focusSession: async () => ({ ok: true }),
    interruptSession: async () => ({ ok: false, note: "discovered" }),
    spawnSession: async (opts) => ({ ok: true, body: opts }),
    listHarnesses: async () => ({ ok: true, harnesses: [] }),
    defaultSessionCwd: () => "D:\\home",
  };
  const h = sessionVerbHandlers(fake);
  assert.deepEqual(Object.keys(h).sort(), [
    "desk:sessions-focus", "desk:sessions-harnesses", "desk:sessions-interrupt",
    "desk:sessions-message", "desk:sessions-spawn",
  ]);
  await h["desk:sessions-message"](null, "good", "hi");
  await h["desk:sessions-message"](null, "bad", "hi");
  await h["desk:sessions-interrupt"](null, "x");
  assert.equal(refreshed, 1);
  const spawned = await h["desk:sessions-spawn"](null, { harness: "", cwd: "" });
  assert.deepEqual(spawned.body, { cwd: "D:\\home", harness: "claude" });
  assert.equal((await h["desk:sessions-harnesses"]()).defaultCwd, "D:\\home");
});

test("the pane offers exactly the four verbs through its preload, and renders why_not", () => {
  const preload = fs.readFileSync(path.join(__dirname, "sessions-preload.cjs"), "utf8");
  for (const ch of ["desk:sessions-message", "desk:sessions-focus", "desk:sessions-interrupt",
    "desk:sessions-spawn", "desk:sessions-harnesses"]) {
    assert.match(preload, new RegExp(ch), `${ch} is bridged`);
  }
  const page = fs.readFileSync(path.join(__dirname, "sessions.html"), "utf8");
  assert.match(page, /why_not/, "a disabled verb must carry the daemon's reason");
  assert.match(page, /id="newSession"/);
  assert.match(page, /last_prompt/);
  // Model/transcript text is data: the verbs must not introduce innerHTML writes of row content.
  assert.doesNotMatch(page, /innerHTML\s*=\s*[^"'\s]/);
});
