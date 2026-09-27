"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { InferenceOpsWidget, baseUrl, deriveAlerts, readInference, summarize, toRows } = require("./inference-widget.cjs");

const PULSE = {
  inference: {
    measured_at: "2026-09-27T12:00:00Z",
    nodes: [{ id: "rtx5090", label: "RTX 5090", status: "online", vram_total_gb: 32, vram_used_gb: 28 }],
    models: [
      { key: "5090:orchestrator", id: "aither-orchestrator-8b", node: "rtx5090", engine: "vllm", state: "serving", live: { running: 2, waiting: 1, kv_cache_pct: 95 } },
      { key: "5090:bonsai", node: "rtx5090", state: "down" },
      { key: "dgx:pool", node: "dgx", state: "unmeasured" },
      { key: "5090:nomic", node: "rtx5090", state: "down", retiring: "replaced" },
    ],
    routing: [{ backend: "orchestrator", aliases: ["aither-orchestrator"], available: false, fallback: { backend: "deepseek_api", cloud: true } }],
  },
};

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = `${init.method || "GET"} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { impl, calls };
}

test("readInference tolerates an absent or malformed key (could-not-look is not empty)", () => {
  assert.equal(readInference(null), null);
  assert.equal(readInference({}), null);
  assert.deepEqual(readInference({ inference: { models: "x" } }).models, []);
});

test("deriveAlerts: down critical, KV warning, cloud fallback critical with the model's key, unmeasured info, retiring silent", () => {
  const alerts = deriveAlerts(readInference(PULSE));
  const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
  assert.equal(byId["down:5090:bonsai"].severity, "critical");
  assert.equal(byId["kv:5090:orchestrator"].severity, "warning");
  assert.equal(byId["route-cloud:orchestrator"].target, "5090:orchestrator");
  assert.equal(byId["unmeasured:dgx:pool"].severity, "info");
  assert.equal(byId["down:5090:nomic"], undefined);
  assert.equal(alerts[alerts.length - 1].severity, "info", "sorted most severe first");
});

test("routing: an available route with a cloud fallback is info (armed), a non-actionable lane offers reprobe only", () => {
  const alerts = deriveAlerts(readInference({ inference: {
    models: [{ key: "dgx:pool", id: "deepseek", node: "dgx", state: "down", actionable: false }],
    routing: [{ backend: "deepseek", aliases: ["reasoning"], available: true, fallback: { backend: "deepseek_api", model: "x", cloud: true } }],
  } }));
  const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
  assert.equal(byId["route-cloud-armed:deepseek"].severity, "info");
  assert.equal(byId["route-cloud:deepseek"], undefined);
  assert.deepEqual(byId["down:dgx:pool"].actions, ["reprobe"]);
  assert.deepEqual(toRows(readInference({ inference: { models: [{ key: "dgx:pool", node: "dgx", actionable: false }] } }))[0].models[0].actions, ["reprobe"]);
});

test("toRows groups models under nodes, including a node the feed did not list", () => {
  const rows = toRows(readInference(PULSE));
  const rtx = rows.find((r) => r.id === "rtx5090");
  assert.equal(rtx.models.length, 3);
  assert.deepEqual(rtx.vram, { used: 28, total: 32 });
  assert.equal(rows.find((r) => r.id === "dgx").models[0].state, "unmeasured");
  const orch = rtx.models.find((m) => m.key === "5090:orchestrator");
  assert.equal(orch.running, 2);
  assert.equal(orch.kv, 95);
});

test("InferenceOpsWidget requires a session-bound fetch (a bare fetch would carry no cookie)", () => {
  assert.throws(() => new InferenceOpsWidget({}), /session-bound fetchImpl/);
});

test("poll reads /api/platform-pulse and reports an absent inference key as not reported", async () => {
  const { impl, calls } = fakeFetch({ "GET /api/platform-pulse": { body: PULSE } });
  const w = new InferenceOpsWidget({ fetchImpl: impl, base: "https://aitherium.com" });
  const snap = await w.poll();
  assert.equal(snap.ok, true);
  assert.equal(snap.reported, true);
  assert.equal(calls[0].url, "https://aitherium.com/api/platform-pulse");
  assert.match(summarize(snap), /1\/4 serving, 2 critical/);

  const empty = new InferenceOpsWidget({ fetchImpl: fakeFetch({ "GET /api/platform-pulse": { body: { other: 1 } } }).impl });
  const s2 = await empty.poll();
  assert.equal(s2.reported, false);
  assert.equal(summarize(s2), "Ops: inference topology not reported");

  const down = new InferenceOpsWidget({ fetchImpl: fakeFetch({ "GET /api/platform-pulse": { status: 503 } }).impl });
  assert.equal((await down.poll()).ok, false);
});

test("act: restart is confirm-first at the choke point, bad input refused, nothing sent", async () => {
  const { impl, calls } = fakeFetch({});
  const w = new InferenceOpsWidget({ fetchImpl: impl });
  assert.equal((await w.act("restart", "5090:bonsai")).requiresConfirmation, true);
  assert.equal((await w.act("rm", "5090:bonsai")).ok, false);
  assert.equal((await w.act("reprobe", "../etc")).ok, false);
  assert.equal(calls.length, 0);
});

test("act: posts {action,target} only, and maps 401/403 to signed-out/forbidden", async () => {
  const ok = fakeFetch({ "POST /api/ops/actions": { body: { ok: true, container: "aither-llamacpp-bonsai" } } });
  const w = new InferenceOpsWidget({ fetchImpl: ok.impl, base: "https://aitherium.com" });
  const v = await w.act("restart", "5090:bonsai", { confirm: true });
  assert.equal(v.ok, true);
  assert.equal(ok.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { action: "restart", target: "5090:bonsai" });

  const w401 = new InferenceOpsWidget({ fetchImpl: fakeFetch({ "POST /api/ops/actions": { status: 401 } }).impl });
  assert.equal((await w401.act("reprobe", "5090:bonsai")).signedOut, true);
  const w403 = new InferenceOpsWidget({ fetchImpl: fakeFetch({ "POST /api/ops/actions": { status: 403, body: { error: "Platform operator only" } } }).impl });
  const f = await w403.act("reprobe", "5090:bonsai");
  assert.equal(f.forbidden, true);
  assert.equal(f.ok, false);
});

test("baseUrl only admits an https aitherium.com origin or loopback (the cookie never goes elsewhere)", () => {
  const prev = process.env.AWDESK_OPS_BASE;
  try {
    process.env.AWDESK_OPS_BASE = "https://evil.example.com";
    assert.equal(baseUrl(), "https://api.aitherium.com");
    process.env.AWDESK_OPS_BASE = "http://aitherium.com";
    assert.equal(baseUrl(), "https://api.aitherium.com");
    process.env.AWDESK_OPS_BASE = "https://portal.aitherium.com/x";
    assert.equal(baseUrl(), "https://portal.aitherium.com");
    process.env.AWDESK_OPS_BASE = "http://127.0.0.1:3000";
    assert.equal(baseUrl(), "http://127.0.0.1:3000");
  } finally {
    if (prev === undefined) delete process.env.AWDESK_OPS_BASE; else process.env.AWDESK_OPS_BASE = prev;
  }
});

test("the widget page uses only the preload verbs and confirms before a restart", () => {
  const html = fs.readFileSync(path.join(__dirname, "inference-widget.html"), "utf8");
  assert.match(html, /window\.inferenceOps\.poll\(/);
  assert.match(html, /window\.inferenceOps\.act\(/);
  assert.match(html, /confirm\s*:\s*true/);
  assert.doesNotMatch(html, /require\(|ipcRenderer/, "the sandboxed renderer never touches node or ipc directly");
  assert.match(html, /Content-Security-Policy/);
});
