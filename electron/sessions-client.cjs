"use strict";

/**
 * sessions-client.cjs — the Sessions pane's backend: the awdk harness daemon's
 * unified session directory (loopback :8362), read-only.
 *
 * WHY (2026-09-12, owner: "a proper interactive awsh/aithershell"): the daemon
 * already merges daemon-owned sessions with DISCOVERED interactive Claude Code
 * tabs (pid + start-time, so no cooperation is needed from the tab), and every
 * row carries its honest steer_capability. Slice 1 of COCKPIT-DESIGN.md is
 * read-only — "stop tab-cycling to check on things" — and this pane IS that
 * view: list + live tail, saying what it cannot do instead of pretending.
 *
 * Auth: Bearer from AITHER_HARNESS_TOKEN or ~/.aither/harness_token (the same
 * resolution order harness-client.ts documents). The token never leaves the
 * main process — the pane's frame only ever sees session rows and file tails.
 *
 * Failure is a RENDERED STATE: daemon down / no token -> { ok:false, note }
 * with the reason — never a thrown error, and never a fabricated empty list.
 * "Could not look" and "nothing is running" must not read the same.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = process.env.AITHER_HARNESS_URL || "http://127.0.0.1:8362";

function harnessToken() {
  if (process.env.AITHER_HARNESS_TOKEN) return process.env.AITHER_HARNESS_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "harness_token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function listSessions({ fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const token = harnessToken();
  if (!token) {
    return { ok: false, sessions: [], note: "no harness token (~/.aither/harness_token) — daemon never ran here?" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${DAEMON}/sessions/unified`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, sessions: [], note: `daemon refused the token (${res.status}) — restart it: adk harness serve` };
    }
    if (!res.ok) return { ok: false, sessions: [], note: `daemon answered ${res.status}` };
    const body = await res.json();
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    // generated_at/stale: the daemon serves a background-built snapshot and says
    // how old it is. Older daemons omit both; that reads as fresh.
    return {
      ok: true,
      sessions,
      note: `${sessions.length} session(s)`,
      generatedAt: typeof body.generated_at === "number" ? body.generated_at * 1000 : null,
      daemonStale: body.stale === true,
    };
  } catch (error) {
    const why = error && error.name === "AbortError"
      ? `daemon did not answer within ${Math.round(timeoutMs / 1000)}s`
      : "daemon unreachable (start it: adk harness serve)";
    return { ok: false, sessions: [], note: why };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call to the daemon, as a RENDERED result: { ok, status, body, note }.
 * Never throws -- a verb that fails says why in `note` (the daemon's own
 * `detail` when it gave one), because a button that silently does nothing is
 * the failure the Sessions pane exists to remove.
 */
async function daemonCall(method, route, body, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const token = harnessToken();
  if (!token) return { ok: false, status: 0, body: null, note: "no harness token (~/.aither/harness_token)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${DAEMON}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    if (!res.ok) {
      const detail = parsed && typeof parsed.detail === "string" ? parsed.detail : `daemon answered ${res.status}`;
      return { ok: false, status: res.status, body: parsed, note: detail };
    }
    return { ok: true, status: res.status, body: parsed, note: "" };
  } catch (error) {
    const why = error && error.name === "AbortError"
      ? `daemon did not answer within ${Math.round(timeoutMs / 1000)}s`
      : "daemon unreachable (start it: adk harness serve)";
    return { ok: false, status: 0, body: null, note: why };
  } finally {
    clearTimeout(timer);
  }
}

/** A session id goes into a URL path: refuse anything but a plain token. */
function safeId(sessionId) {
  const id = String(sessionId || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== ".." ? id : "";
}

const BAD_ID = Object.freeze({ ok: false, status: 0, body: null, note: "not a valid session id" });

/** Queue text for the session's NEXT prompt (the daemon's steering mailbox). */
function messageSession(sessionId, text, opts) {
  const id = safeId(sessionId);
  if (!id) return Promise.resolve({ ...BAD_ID });
  const clean = String(text || "").trim();
  if (!clean) return Promise.resolve({ ok: false, status: 0, body: null, note: "type a message first" });
  return daemonCall("POST", `/sessions/${id}/message`, { text: clean }, opts);
}

/** Raise the session's terminal window, or reopen it with --resume. */
function focusSession(sessionId, opts) {
  const id = safeId(sessionId);
  return id ? daemonCall("POST", `/sessions/${id}/focus`, {}, opts) : Promise.resolve({ ...BAD_ID });
}

/** Interrupt a daemon-owned session's current turn (managed sessions only). */
function interruptSession(sessionId, opts) {
  const id = safeId(sessionId);
  return id ? daemonCall("POST", `/sessions/${id}/interrupt`, undefined, opts) : Promise.resolve({ ...BAD_ID });
}

/** Where "New session" starts by default: $AITHER_SESSION_CWD, else the owner's
 *  main checkout when it exists on this machine, else the home directory. */
function defaultSessionCwd({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.AITHER_SESSION_CWD) return env.AITHER_SESSION_CWD;
  const main = "C:\\AitherOS-Fresh";
  return process.platform === "win32" && exists(main) ? main : os.homedir();
}

/** Start a new session; `harness` comes from the daemon's /harnesses. */
function spawnSession({ cwd = "", harness = "claude", title = "" } = {}, opts) {
  return daemonCall("POST", "/sessions", {
    harness: String(harness || "claude"),
    cwd: String(cwd || ""),
    title: String(title || ""),
  }, { timeoutMs: 20000, ...(opts || {}) });
}

/** The harnesses this box can start, installed ones only: [{ id, label }]. */
async function listHarnesses(opts) {
  const out = await daemonCall("GET", "/harnesses", undefined, opts);
  if (!out.ok) return { ok: false, harnesses: [], note: out.note };
  const rows = Array.isArray(out.body && out.body.harnesses) ? out.body.harnesses : [];
  return {
    ok: true,
    harnesses: rows.filter((h) => h && h.installed !== false)
      .map((h) => ({ id: String(h.id), label: String(h.label || h.id) })),
    note: "",
  };
}

/** The last `maxLines` lines of a transcript, capped by BYTES so a huge JSONL
 *  cannot stall the pane, and read from the END — a tail is all this view
 *  shows, and reading a 200 MB file to print its last page is how a live view
 *  becomes the slowest pane in the window. */
function tailTranscript(transcriptPath, { maxLines = 60, maxBytes = 512 * 1024 } = {}) {
  const p = String(transcriptPath || "");
  if (!p) return { ok: false, lines: [], note: "session has no transcript_path" };
  let fd = null;
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - maxBytes);
    fd = fs.openSync(p, "r");
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    // A byte-window can open mid-multibyte or mid-line; drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n").filter((l) => l.trim());
    return {
      ok: true,
      lines: lines.slice(-maxLines),
      truncated: start > 0 || lines.length > maxLines,
      note: "",
    };
  } catch (error) {
    return { ok: false, lines: [], note: `cannot read transcript: ${(error && error.message) || error}` };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

const STATUS_ORDER = { working: 0, "waiting-input": 1, idle: 2 };

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A short, prompt-sized brief of the owner's live sessions for the Command
 * agent (owner, 2026-09-22: "have context of all of my active sessions and
 * work"). Working sessions first. "Could not look" is said as such -- never an
 * empty list, which would read as "nothing is running".
 */
function sessionsBrief(result, { max = 15 } = {}) {
  if (!result || !result.ok) {
    return `The owner's active sessions: unknown right now (${(result && result.note) || "no answer"}).`;
  }
  const rows = [...result.sessions].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3),
  );
  if (!rows.length) return "The owner has no active agent sessions right now.";
  const lines = rows.slice(0, max).map((s) => {
    const summary = s.last_activity_summary ? ` -- ${clip(s.last_activity_summary, 90)}` : "";
    return `- [${s.status || "?"}] ${s.harness || "?"} ${String(s.id || "").slice(0, 12)}: ${clip(s.title, 70)}${summary}`;
  });
  const more = rows.length > max ? `\n(+${rows.length - max} more)` : "";
  return (
    `The owner's active agent sessions right now (${rows.length}), from the harness daemon:\n` +
    `${lines.join("\n")}${more}\n` +
    "When the owner asks about ongoing work, answer from these; to message or steer one, " +
    "use the awsh MCP tools (awsh_send / awsh_say) with its id."
  );
}

function agoLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/**
 * ONE main-process poller that Home, the Sessions pane and the Command agent all
 * read (2026-09-27). Each used to fetch on its own with a 3 s abort, so a daemon
 * busy for 4 s put "daemon did not answer within 3s" on Home while the Sessions
 * pane, polling separately, showed rows. Now one loop fetches every `intervalMs`
 * with a generous `timeoutMs`, keeps the last GOOD read with its timestamp, and
 * every reader gets the same view:
 *
 *  - fresh read            -> { ok:true, sessions, stale:false }
 *  - failed after a good   -> { ok:true, sessions: lastGood, stale:true,
 *                               note: "last known N sessions (Ns ago) — <why>" }
 *  - never a good read     -> { ok:false, note } (the only error a reader shows)
 *
 * Reads never wait on the network once one answer exists; the first read waits
 * for the first fetch (bounded by `timeoutMs`).
 */
function createSessionsPoller({
  list = listSessions,
  intervalMs = 3000,
  timeoutMs = 20000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let lastGood = null; // { sessions, at, generatedAt }
  let last = null; // the latest listSessions() result, good or not
  let inflight = null;
  let timer = null;
  let running = false;

  function tick() {
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => list({ timeoutMs }))
      .catch((error) => ({ ok: false, sessions: [], note: String((error && error.message) || error) }))
      .then((result) => {
        last = result || { ok: false, sessions: [], note: "no answer" };
        if (last.ok) {
          lastGood = { sessions: last.sessions || [], at: now(), generatedAt: last.generatedAt || null };
        }
        return view();
      })
      .finally(() => {
        inflight = null;
        if (running) {
          if (timer) clearTimer(timer);
          timer = setTimer(tick, intervalMs);
          if (timer && typeof timer.unref === "function") timer.unref();
        }
      });
    return inflight;
  }

  /** The current view, without touching the network. null = nothing read yet. */
  function view() {
    if (!last && !lastGood) return null;
    if (last && last.ok) {
      return { ...last, stale: Boolean(last.daemonStale), at: lastGood.at, ageMs: now() - lastGood.at };
    }
    if (lastGood) {
      const ageMs = now() - lastGood.at;
      const n = lastGood.sessions.length;
      const why = (last && last.note) ? ` — ${last.note}` : "";
      return {
        ok: true,
        sessions: lastGood.sessions,
        stale: true,
        at: lastGood.at,
        ageMs,
        staleNote: `last known ${n} session${n === 1 ? "" : "s"} (${agoLabel(ageMs)})`,
        note: `last known ${n} session${n === 1 ? "" : "s"} (${agoLabel(ageMs)})${why}`,
      };
    }
    return { ...last, stale: false };
  }

  /** Start the loop (idempotent). */
  function start() {
    if (running) return;
    running = true;
    void tick();
  }

  function stop() {
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  /** The shared view; starts the loop and waits only when nothing was ever read. */
  async function get() {
    start();
    return view() || (await (inflight || tick()));
  }

  return { start, stop, get, view, refresh: tick };
}

let shared = null;
/** The process-wide poller every sessions reader in main shares. */
function sharedSessionsPoller() {
  if (!shared) shared = createSessionsPoller();
  return shared;
}

module.exports = {
  listSessions,
  daemonCall,
  messageSession,
  focusSession,
  interruptSession,
  spawnSession,
  listHarnesses,
  defaultSessionCwd,
  tailTranscript,
  harnessToken,
  sessionsBrief,
  createSessionsPoller,
  sharedSessionsPoller,
  agoLabel,
  DAEMON,
};
