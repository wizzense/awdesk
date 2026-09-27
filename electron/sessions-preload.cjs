"use strict";

/**
 * Bridge for the Sessions pane (sessions.html), injected by console-preload.cjs
 * because the pane is an iframe under nodeIntegrationInSubFrames.
 *
 * Reads: the session list (the daemon's unified directory) and a transcript tail.
 * Verbs (sessions S1): message (queued for the session's next prompt), focus
 * (raise its window, or reopen it), interrupt (daemon-owned sessions only) and
 * spawn. Each row carries the daemon's own `actions` -- what may be done and why
 * not -- so the pane offers a verb only where the daemon can honour it. The
 * bearer never reaches this frame; every call goes through main.
 */

const { contextBridge, ipcRenderer } = require("electron");

const id = (sessionId) => String(sessionId || "");

contextBridge.exposeInMainWorld("aitherSessions", {
  list: () => ipcRenderer.invoke("desk:sessions-list"),
  tail: (sessionId, transcriptPath) => ipcRenderer.invoke(
    "desk:sessions-tail", id(sessionId), String(transcriptPath || ""),
  ),
  message: (sessionId, text) => ipcRenderer.invoke("desk:sessions-message", id(sessionId), String(text || "")),
  focus: (sessionId) => ipcRenderer.invoke("desk:sessions-focus", id(sessionId)),
  interrupt: (sessionId) => ipcRenderer.invoke("desk:sessions-interrupt", id(sessionId)),
  spawn: (options) => ipcRenderer.invoke("desk:sessions-spawn", {
    cwd: String((options && options.cwd) || ""),
    harness: String((options && options.harness) || ""),
  }),
  harnesses: () => ipcRenderer.invoke("desk:sessions-harnesses"),
});
