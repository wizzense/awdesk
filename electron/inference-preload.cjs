"use strict";

// Preload for the Ops widget (inference-widget.html). The renderer is sandboxed and
// sees exactly these verbs; every one lands on main's single InferenceOpsWidget, whose
// requests ride the signed-in aitherium.com session. `confirm` is passed
// through from the renderer's own confirm step, never invented here — main's
// InferenceOpsWidget.act() refuses a restart without it no matter who calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inferenceOps", {
  poll: () => ipcRenderer.invoke("desk:inference-poll"),
  act: (action, target, opts) => ipcRenderer.invoke("desk:inference-act", String(action), String(target), opts ?? {}),
  // Open the full web board (/workspace/ops) or the sign-in page. Main picks the
  // URL from a fixed pair; the renderer only names which.
  openWeb: (which) => ipcRenderer.send("desk:inference-open-web", which === "login" ? "login" : "board"),
  close: () => ipcRenderer.send("desk:inference-close"),
});
