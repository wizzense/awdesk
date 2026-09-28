"use strict";

/**
 * The Play pane's main-process half: reach the local play service, and start it when it is
 * not running.
 *
 * The play service (the companions that ride along in your games) is NOT part of the desk. It
 * registers how to start itself in ~/.aither/game_bridge/service.json -- {command, cwd, port} --
 * and records the port it actually bound in ~/.aither/game_bridge/inbox.json. The desk only
 * reads those two files, so it carries no path of any particular machine: on a box where the
 * service was never set up, the pane says so instead of guessing where it lives.
 *
 * Requests go out with NO Origin header (this is a native client), which the service admits;
 * browsers must present an aitherium.com or localhost Origin instead.
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DIR = path.join(os.homedir(), ".aither", "game_bridge");
const SERVICE_FILE = path.join(DIR, "service.json");
const PORT_FILE = path.join(DIR, "inbox.json");
const DEFAULT_PORT = 47940;
const START_WAIT_MS = 20_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function port() {
  const bound = readJson(PORT_FILE);
  if (bound && Number.isInteger(bound.port)) return bound.port;
  const svc = readJson(SERVICE_FILE);
  return svc && Number.isInteger(svc.port) ? svc.port : DEFAULT_PORT;
}

/** One HTTP call to the service. Resolves {status, body}; rejects only when nothing answers. */
function request(method, route, body, { timeoutMs = 15_000, portOverride } = {}) {
  const data = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: portOverride || port(),
      path: route,
      method,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { error: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy(new Error("play service timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function healthy() {
  try {
    const r = await request("GET", "/health", null, { timeoutMs: 2500 });
    return r.status === 200 && r.body && r.body.ok === true;
  } catch {
    return false;
  }
}

let starting = null;

/**
 * Make sure the service answers. Starts it from service.json when it does not, detached and
 * hidden, so it outlives a desk restart and never flashes a console window.
 * Resolves {ok, started?, error?}.
 */
function ensure({ spawnImpl = spawn, wait = START_WAIT_MS } = {}) {
  if (starting) return starting;
  starting = (async () => {
    if (await healthy()) return { ok: true };
    const svc = readJson(SERVICE_FILE);
    if (!svc || !Array.isArray(svc.command) || !svc.command.length) {
      return { ok: false, error: "The play service is not set up on this machine yet." };
    }
    try {
      const child = spawnImpl(svc.command[0], svc.command.slice(1), {
        cwd: svc.cwd || undefined, detached: true, stdio: "ignore", windowsHide: true,
      });
      child.unref();
    } catch (error) {
      return { ok: false, error: `Could not start the play service: ${error.message}` };
    }
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      if (await healthy()) return { ok: true, started: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error: "The play service did not come up in time." };
  })().finally(() => { starting = null; });
  return starting;
}

// Only these routes cross the bridge: the pane cannot be turned into a general HTTP client.
const ROUTES = new Set([
  "GET /health", "GET /state", "GET /doctor", "GET /companions",
  "POST /setup", "POST /start", "POST /stop", "POST /say", "POST /party", "POST /launch",
  "POST /invite", "GET /presence", "POST /presence",
]);

async function call(method, route, body) {
  const key = `${String(method).toUpperCase()} ${String(route)}`;
  if (!ROUTES.has(key)) return { ok: false, error: `not a play route: ${key}` };
  const up = await ensure();
  if (!up.ok) return { ok: false, error: up.error, notSetUp: true };
  try {
    const r = await request(String(method).toUpperCase(), String(route), body == null ? null : body,
      { timeoutMs: route === "/doctor" ? 90_000 : 20_000 });
    return r.body == null ? { ok: r.status < 400 } : r.body;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function register(ipcMain) {
  ipcMain.handle("desk:play", (_event, payload) =>
    call(payload && payload.method, payload && payload.route, payload && payload.body));
}

module.exports = { register, call, ensure, request, port, ROUTES, SERVICE_FILE, PORT_FILE };
