"use strict";

/**
 * inference-widget.cjs — the Ops widget's backend: poll the inference topology and
 * send operator actions, through the SAME two doors the web board uses.
 *
 * Owner, 2026-09-27: "there should be a proper AitherOS desktop app/widget".
 * The Veil page /workspace/ops and this widget read one feed
 * (`/api/platform-pulse` key `inference`) and act through one API
 * (`POST /api/ops/actions`), so a desktop click and a browser click cannot
 * disagree about what a model key means or who may restart it. The widget holds
 * NO container map and NO credential of its own: the request rides the
 * signed-in aitherium.com session (the living-desktop partition cookie), and
 * Veil re-derives the operator from that session and fails closed.
 *
 * `restart` is confirm-first HERE, at the one choke point every surface shares
 * (the widget's button, a future bridge route, an MCP tool) — the same rule
 * FleetControl.run() applies to its DESTRUCTIVE verbs (security finding
 * 2026-09-19): a caller that skipped the button gets a refusal, not a restart.
 *
 * `deriveAlerts` mirrors AitherVeil/src/lib/ops-inference.ts; the test pins the
 * shared cases so the two cannot drift silently.
 */

// The API origin. aitherium.com is the static Pages export and answers /api/* with 404
// (measured 2026-09-27: the widget read "pulse HTTP 404"); api.aitherium.com serves Veil.
const DEFAULT_BASE = "https://api.aitherium.com";
const ACTIONS = Object.freeze(["restart", "reprobe", "logs"]);
const CONFIRM_FIRST = new Set(["restart"]);
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/;
const KV_SATURATION_PCT = 90;
const POLL_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 100_000;

function baseUrl() {
  const raw = process.env.AWDESK_OPS_BASE || DEFAULT_BASE;
  // Only https aitherium.com-family origins (or loopback for dev) may carry the session cookie.
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    const family = u.hostname === "aitherium.com" || u.hostname.endsWith(".aitherium.com");
    if ((u.protocol === "https:" && family) || loopback) return `${u.protocol}//${u.host}`;
  } catch { /* fall through */ }
  return DEFAULT_BASE;
}

/** The `inference` section of a pulse document, normalised, or null when absent. */
function readInference(pulse) {
  if (!pulse || typeof pulse !== "object") return null;
  const inf = pulse.inference;
  if (!inf || typeof inf !== "object") return null;
  return {
    ...inf,
    nodes: Array.isArray(inf.nodes) ? inf.nodes : [],
    models: Array.isArray(inf.models) ? inf.models.filter((m) => m && typeof m.key === "string") : [],
    routing: Array.isArray(inf.routing) ? inf.routing : [],
  };
}

function modelForBackend(inf, backend) {
  const b = String(backend || "").toLowerCase();
  return (inf.models || []).find((m) => m.key.toLowerCase() === b
    || String(m.id || "").toLowerCase() === b
    || m.key.toLowerCase().endsWith(`:${b}`));
}

/** restart/logs need a container on this host; a lane marked actionable:false gets reprobe only. */
function modelActions(m) {
  return m && m.actionable === false ? ["reprobe"] : ["reprobe", "restart", "logs"];
}

/** Alerts, most severe first. "unmeasured" is info, never critical. */
function deriveAlerts(inf) {
  if (!inf) return [];
  const out = [];
  for (const m of inf.models || []) {
    const name = m.id || m.key;
    if (m.retiring) continue;
    if (m.state === "down") {
      out.push({ id: `down:${m.key}`, severity: "critical", title: `${name} is down`, target: m.key, actions: modelActions(m) });
    } else if (m.state === "unmeasured") {
      out.push({ id: `unmeasured:${m.key}`, severity: "info", title: `${name} unmeasured`, target: m.key, actions: ["reprobe"] });
    }
    const kv = m.live && m.live.kv_cache_pct;
    if (m.state === "serving" && typeof kv === "number" && kv >= KV_SATURATION_PCT) {
      out.push({ id: `kv:${m.key}`, severity: "warning", title: `${name} KV ${Math.round(kv)}%`, target: m.key, actions: modelActions(m).filter((a) => a !== "restart") });
    }
  }
  for (const r of inf.routing || []) {
    const cloud = Boolean(r.fallback && r.fallback.cloud === true);
    const down = r.available === false;
    if (!down && !cloud) continue;
    const model = modelForBackend(inf, r.backend);
    const aliases = (r.aliases || []).join(", ") || r.backend;
    const acts = model ? modelActions(model).filter((a) => a !== "logs") : [];
    if (down && cloud) {
      out.push({ id: `route-cloud:${r.backend}`, severity: "critical", title: `${aliases} falling back to cloud`, target: model ? model.key : undefined, actions: acts });
    } else if (down) {
      out.push({ id: `route-down:${r.backend}`, severity: "warning", title: `${aliases} unavailable`, target: model ? model.key : undefined, actions: acts });
    } else {
      out.push({ id: `route-cloud-armed:${r.backend}`, severity: "info", title: `${aliases} has a cloud fallback armed`, target: model ? model.key : undefined, actions: [] });
    }
  }
  for (const n of inf.nodes || []) {
    if (n.status && !["online", "healthy", "up", "serving"].includes(n.status)) {
      out.push({ id: `node:${n.id}`, severity: n.status === "offline" || n.status === "down" ? "critical" : "warning", title: `${n.label || n.id} ${n.status}`, actions: [] });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Compact per-node rows for the widget: node -> models with state and live load. */
function toRows(inf) {
  if (!inf) return [];
  const byNode = new Map();
  for (const n of inf.nodes || []) byNode.set(n.id, { node: n, models: [] });
  for (const m of inf.models || []) {
    const id = m.node || m.key.split(":")[0] || "unknown";
    if (!byNode.has(id)) byNode.set(id, { node: { id }, models: [] });
    const live = m.live || {};
    byNode.get(id).models.push({
      key: m.key,
      name: m.id || m.key,
      state: m.state || "unmeasured",
      engine: m.engine || null,
      running: typeof live.running === "number" ? live.running : null,
      waiting: typeof live.waiting === "number" ? live.waiting : null,
      kv: typeof live.kv_cache_pct === "number" ? live.kv_cache_pct : null,
      retiring: m.retiring || null,
      actions: modelActions(m),
    });
  }
  return Array.from(byNode.values()).map(({ node, models }) => ({
    id: node.id,
    label: node.label || node.id,
    status: node.status || null,
    vram: node.vram_total_gb ? { used: node.vram_used_gb ?? null, total: node.vram_total_gb } : null,
    models,
  }));
}

/** One-line summary for a tray tooltip. */
function summarize(snapshot) {
  if (!snapshot || !snapshot.ok) return `Ops: ${snapshot?.error || "not polled yet"}`;
  if (!snapshot.reported) return "Ops: inference topology not reported";
  const models = snapshot.rows.flatMap((r) => r.models);
  const serving = models.filter((m) => m.state === "serving").length;
  const crit = snapshot.alerts.filter((a) => a.severity === "critical").length;
  return `Ops: ${serving}/${models.length} serving${crit ? `, ${crit} critical` : ""}`;
}

class InferenceOpsWidget {
  /**
   * @param {object} opts
   * @param {(url: string, init?: object) => Promise<Response>} opts.fetchImpl
   *   A fetch bound to the signed-in session (Electron `session.fetch`). Required:
   *   a default global fetch would carry no cookie and every action would 401.
   * @param {string} [opts.base]
   */
  constructor({ fetchImpl, base } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("InferenceOpsWidget needs a session-bound fetchImpl");
    this.fetchImpl = fetchImpl;
    this.base = base || baseUrl();
    this.last = null;
    this.inflight = null;
  }

  /** Poll the pulse. Never throws; `ok:false` carries why. */
  async poll() {
    try {
      const res = await this.fetchImpl(`${this.base}/api/platform-pulse`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.last = { ok: false, error: `pulse HTTP ${res.status}`, at: Date.now() };
        return this.last;
      }
      const inf = readInference(await res.json());
      this.last = {
        ok: true,
        reported: inf !== null,
        measured_at: inf ? inf.measured_at || null : null,
        rows: toRows(inf),
        alerts: deriveAlerts(inf),
        runners: inf ? inf.runners || null : null,
        at: Date.now(),
      };
      return this.last;
    } catch (error) {
      this.last = { ok: false, error: error?.message || String(error), at: Date.now() };
      return this.last;
    }
  }

  /** Send one action through Veil. Resolves with a verdict; never rejects. */
  async act(action, target, opts = {}) {
    if (!ACTIONS.includes(action)) return { ok: false, error: `unknown action "${action}"` };
    if (typeof target !== "string" || !TARGET_RE.test(target)) return { ok: false, error: "bad target" };
    if (CONFIRM_FIRST.has(action) && (!opts || opts.confirm !== true)) {
      return { ok: false, requiresConfirmation: true, action, target, error: `"${action}" requires explicit confirmation (confirm: true)` };
    }
    if (this.inflight) return { ok: false, busy: this.inflight, error: `busy: ${this.inflight}` };
    this.inflight = `${action}:${target}`;
    try {
      const res = await this.fetchImpl(`${this.base}/api/ops/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action, target }),
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
      });
      let body = {};
      try { body = await res.json(); } catch { body = {}; }
      if (res.status === 401) return { ok: false, signedOut: true, status: 401, error: "not signed in to aitherium.com" };
      if (res.status === 403) return { ok: false, forbidden: true, status: 403, error: body.error || "platform operator only" };
      return { ...body, ok: res.ok && body.ok !== false, status: res.status };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    } finally {
      this.inflight = null;
    }
  }
}

module.exports = {
  ACTIONS,
  CONFIRM_FIRST,
  DEFAULT_BASE,
  KV_SATURATION_PCT,
  InferenceOpsWidget,
  baseUrl,
  deriveAlerts,
  modelActions,
  readInference,
  summarize,
  toRows,
};
