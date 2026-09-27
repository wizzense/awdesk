"use strict";

/**
 * inference-window.cjs — the compact, always-on-top Ops widget.
 *
 * Per-node model list (state + live load) from the same `inference` feed the
 * web board /workspace/ops renders, with Restart / Re-probe / Logs sent to the
 * same Veil actions API. Requests ride the living-desktop partition, which is
 * where the owner's aitherium.com session cookie lives (one sign-in, shared) —
 * the widget stores no credential and holds no container map.
 *
 * Launch: tray / palette "Inference ops widget…", `awdesk --inference`.
 *
 * Named inference-* because ops-window.cjs / ops.html / desk:ops-* already
 * belong to the platform-ops (backups) pane.
 */

const electron = require("electron");
const { ipcMain, screen, session, shell } = electron;
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");
const { InferenceOpsWidget } = require("./inference-widget.cjs");

// The living desktop's partition (living-desktop-window.cjs PARTITION): the
// signed-in aitherium.com session this widget acts as.
const SESSION_PARTITION = "persist:living-desktop";

const ROUTE = "inference";
let widget = null;
let ipcWired = false;
/** How "Sign in" is satisfied. The session cookie must land in the PARTITION,
 *  not the owner's browser, so main wires this to the living desktop (which
 *  syncs the portal session into the partition on open). */
let signInHandler = null;

function setSignInHandler(fn) {
  signInHandler = typeof fn === "function" ? fn : null;
}

function getWidget() {
  if (!widget) {
    const ses = session.fromPartition(SESSION_PARTITION);
    // credentials:"include" is what makes Electron's session fetch attach the
    // partition's cookies; without it every action would read as signed-out.
    widget = new InferenceOpsWidget({ fetchImpl: (url, init) => ses.fetch(url, { ...init, credentials: "include" }) });
  }
  return widget;
}

function webUrl(which) {
  const base = getWidget().base;
  return which === "login" ? `${base}/login?returnUrl=%2Fworkspace%2Fops` : `${base}/workspace/ops`;
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle("desk:inference-poll", () => getWidget().poll());
  ipcMain.handle("desk:inference-act", (_event, action, target, opts) =>
    getWidget().act(String(action), String(target), opts && typeof opts === "object" ? { confirm: opts.confirm === true } : {}));
  ipcMain.on("desk:inference-open-web", (_event, which) => {
    if (which === "login" && signInHandler) { signInHandler(); return; }
    void shell.openExternal(webUrl(which === "login" ? "login" : "board"));
  });
  ipcMain.on("desk:inference-close", () => {
    closeRouteWindow(ROUTE);
  });
}

function createInferenceOpsWindow() {
  wireIpc();
  // Construction lives in presentation.cjs (the ROUTE_WINDOWS `inference`
  // spec); this module keeps the placement and the floating level.
  const fresh = !routeWindow(ROUTE);
  const win = openRouteWindow(ROUTE, { electron });
  if (fresh) {
    const { workArea } = screen.getPrimaryDisplay();
    const [width] = win.getSize();
    win.setPosition(workArea.x + workArea.width - width - 16, workArea.y + 16);
    win.setAlwaysOnTop(true, "floating");
  }
  return win;
}

function closeInferenceOpsWindow() {
  closeRouteWindow(ROUTE);
}

function isInferenceOpsWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = { createInferenceOpsWindow, setSignInHandler, closeInferenceOpsWindow, isInferenceOpsWindowOpen, getInferenceOpsWidget: getWidget, SESSION_PARTITION };
