"use strict";

/** The Play pane's bridge: every call goes through main (play-service.cjs), which holds the
 *  route allowlist and starts the service on demand. */
const { contextBridge, ipcRenderer } = require("electron");

const call = (method, route, body) => ipcRenderer.invoke("desk:play", { method, route, body });

contextBridge.exposeInMainWorld("aitherPlay", {
  health: () => call("GET", "/health"),
  state: () => call("GET", "/state"),
  doctor: () => call("GET", "/doctor"),
  companions: () => call("GET", "/companions"),
  setup: () => call("POST", "/setup", {}),
  start: (party) => call("POST", "/start", party && party.length ? { with: party } : {}),
  stop: () => call("POST", "/stop", {}),
  say: (text, to) => call("POST", "/say", to ? { text, to } : { text }),
  setParty: (party) => call("POST", "/party", { party }),
  launch: (game) => call("POST", "/launch", { game: game || "crimson-desert" }),
  invite: (hours) => call("POST", "/invite", { hours: hours || 24 }),
});
