"use strict";

/**
 * sessions-window.cjs — the Sessions pane's standalone twin, and the owner of
 * its IPC.
 *
 * WHY THE HANDLERS LIVE HERE, not in console-window.cjs: a detached sessions
 * window must work on its own (the desk may never have opened the console this
 * session), and console-window's wireIpc only runs when the console opens. The
 * console's own rule is that a pane is a MODE, not a one-way door — a detach
 * button with no way back is how floating windows come back — so the pane gets
 * the same window treatment as Fleet and Command, via the same
 * ensureXxxIpc()/create/close/isOpen shape.
 *
 * Read-only (COCKPIT-DESIGN slice 1): list + tail, no steering.
 */

// The window itself is presentation.cjs's route "sessions" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.sessions.
// This module keeps the IPC; its create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "sessions";

// Same lazy-require rule as console-window.cjs: keep this module loadable
// under `node --test` without Electron.
function electron() {
  return require("electron");
}

let wired = false;

function ensureSessionsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  const sessions = require("./sessions-client.cjs");
  // The shared poller: the pane and Home read the SAME last-good view, so they
  // can no longer disagree about whether the daemon answered.
  ipcMain.handle("desk:sessions-list", () => sessions.sharedSessionsPoller().get());
  ipcMain.handle("desk:sessions-tail", (_event, _sessionId, transcriptPath) =>
    sessions.tailTranscript(transcriptPath));
  for (const [channel, handler] of Object.entries(sessionVerbHandlers(sessions))) {
    ipcMain.handle(channel, handler);
  }
}

/**
 * The four verbs plus the harness list, as `{ channel: (event, ...args) => result }`.
 * A verb that changed something refreshes the SHARED poller, so the pane, Home
 * and the Command agent see the new state on their next read instead of up to
 * one poll interval later. Pure (the client is injected) so it is testable
 * without Electron.
 */
function sessionVerbHandlers(sessions) {
  const after = async (promise) => {
    const result = await promise;
    if (result && result.ok) {
      try { void sessions.sharedSessionsPoller().refresh(); } catch { /* a refresh is a courtesy */ }
    }
    return result;
  };
  return {
    "desk:sessions-message": (_event, sessionId, text) => after(sessions.messageSession(sessionId, text)),
    "desk:sessions-focus": (_event, sessionId) => sessions.focusSession(sessionId),
    "desk:sessions-interrupt": (_event, sessionId) => after(sessions.interruptSession(sessionId)),
    "desk:sessions-spawn": (_event, options) => after(sessions.spawnSession({
      cwd: (options && options.cwd) || sessions.defaultSessionCwd(),
      harness: (options && options.harness) || "claude",
    })),
    "desk:sessions-harnesses": async () => ({
      ...(await sessions.listHarnesses()),
      defaultCwd: sessions.defaultSessionCwd(),
    }),
  };
}

function createSessionsWindow() {
  ensureSessionsIpc();
  // Deny-open, no-navigate, show+focus on ready and the dropped handle on
  // 'closed' are presentation's openRouteWindow -- the same fence every file page carries.
  return openRouteWindow(ROUTE, { electron: electron() });
}

function closeSessionsWindow() {
  closeRouteWindow(ROUTE);
}

function isSessionsWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = {
  ensureSessionsIpc, sessionVerbHandlers, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen,
};
