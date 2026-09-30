"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sa = require("./signed-approval.cjs");

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-approve-"));
}

test("destructive kinds and proposal/plan facts route Approve to the passkey window", () => {
  for (const kind of ["awstorage-manage", "awstorage-suggestion", "awstorage-relocate", "AWSTORAGE-RELOCATE"]) {
    assert.equal(sa.answerRoute({ id: "d-1", kind }, "approve"), "window", kind);
  }
  // awstorage manage/suggest cards are kind "decision" -- the FACT marks them.
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["proposal_id: 12", "node: x"] }, "approve"), "window");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["plan_id: rp-3", "plan_sha256: ab"] }, "Approve"), "window");
});

test("reject and ordinary cards keep using awask", () => {
  assert.equal(sa.answerRoute({ kind: "awstorage-manage" }, "reject"), "awask");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["proposal_id: 1"] }, "REJECT"), "awask");
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["node: x"] }, "approve"), "awask");
  assert.equal(sa.answerRoute({ kind: "credential" }, "approve"), "awask");
  // a fact that merely MENTIONS the key is not the key
  assert.equal(sa.answerRoute({ kind: "decision", facts: ["see proposal_id: 1"] }, "approve"), "awask");
  assert.equal(sa.answerRoute(null, "approve"), "awask");
});

test("readCardRaw reads only a valid id inside the store", () => {
  const dir = tmpStore();
  fs.writeFileSync(path.join(dir, "d-abc.json"), JSON.stringify({ id: "d-abc", kind: "awstorage-manage" }));
  fs.writeFileSync(path.join(dir, "d-lie.json"), JSON.stringify({ id: "d-other" }));
  assert.equal(sa.readCardRaw("d-abc", dir).kind, "awstorage-manage");
  assert.equal(sa.readCardRaw("d-lie", dir), null, "file whose id disagrees is refused");
  assert.equal(sa.readCardRaw("../d-abc", dir), null);
  assert.equal(sa.readCardRaw("d-..", dir), null);
  assert.equal(sa.readCardRaw("d-missing", dir), null);
  assert.equal(sa.readCardRaw(42, dir), null);
});

test("portal origin: https or loopback http only, default aitherium.com", () => {
  assert.equal(sa.portalOrigin({}), "https://aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "https://portal.aitherium.com/x" }), "https://portal.aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "http://evil.example" }), "https://aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "https://u:p@aitherium.com" }), "https://aitherium.com");
  assert.equal(sa.portalOrigin({ AITHER_PORTAL_ORIGIN: "not a url" }), "https://aitherium.com");
  assert.equal(
    sa.approveUrl("d-1", "approve", "https://aitherium.com"),
    "https://aitherium.com/approve?card=d-1&choice=approve",
  );
  assert.equal(sa.approveUrl("d 1&x", "a/b", "https://aitherium.com"), "https://aitherium.com/approve?card=d+1%26x&choice=a%2Fb");
});

test("navigation guard allows the portal and *.aitherium.com only", () => {
  const o = "https://aitherium.com";
  assert.equal(sa.isAllowedApproveNavigation("https://aitherium.com/login?redirect=/approve", o), true);
  assert.equal(sa.isAllowedApproveNavigation("https://idp.aitherium.com/authorize", o), true);
  assert.equal(sa.isAllowedApproveNavigation("https://evilaitherium.com/", o), false);
  assert.equal(sa.isAllowedApproveNavigation("http://idp.aitherium.com/", o), false);
  assert.equal(sa.isAllowedApproveNavigation("file:///C:/x", o), false);
});

test("openApproveWindow: 520x640, persistent partition, no node, no popups; reused", () => {
  const made = [];
  class FakeWin {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.loaded = [];
      this.destroyed = false;
      this.webContents = {
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
        on: (ev, fn) => { this.handlers[ev] = fn; },
      };
      made.push(this);
    }
    on(ev, fn) { this.handlers["win:" + ev] = fn; }
    loadURL(u) { this.loaded.push(u); }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
  }
  const electron = {
    BrowserWindow: FakeWin,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const { buildHostedWindow } = require("./presentation.cjs");
  const build = (partition) => buildHostedWindow("approve", { electron, partition });
  const w = sa.openApproveWindow({ build, url: "https://aitherium.com/approve?card=d-1&choice=approve", origin: "https://aitherium.com" });
  assert.equal(w.opts.width, 520);
  assert.equal(w.opts.height, 640);
  assert.equal(w.opts.webPreferences.partition, "persist:aither-approve");
  assert.equal(w.opts.webPreferences.nodeIntegration, false);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.sandbox, true);
  assert.match(w.opts.webPreferences.preload, /approve-preload\.cjs$/);
  assert.deepEqual(w.openHandler(), { action: "deny" });
  let prevented = false;
  w.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
  assert.equal(prevented, true);
  // second approval reuses the same window (one Hello prompt surface, not a pile)
  const w2 = sa.openApproveWindow({ build, url: "https://aitherium.com/approve?card=d-2&choice=approve" });
  assert.equal(w2, w);
  assert.equal(made.length, 1);
  assert.equal(w.loaded.length, 2);
  // after close a new one is made
  w.handlers["win:closed"]();
  sa.openApproveWindow({ build, url: "https://aitherium.com/approve?card=d-3&choice=approve" });
  assert.equal(made.length, 2);
});

test("decisions-plane routes desk:deck-answer through signed-approval before awask", () => {
  const src = fs.readFileSync(path.join(__dirname, "decisions-plane.cjs"), "utf8");
  const i = src.indexOf('ipcMain.handle("desk:deck-answer"');
  assert.ok(i > 0);
  const body = src.slice(i, i + 2500);
  const route = body.indexOf("signedApproval.answerRoute(");
  const awask = body.indexOf("decisionCards.answerCardConfirmed(");
  assert.ok(route > 0 && awask > route, "answerRoute must be consulted before answerCard");
  assert.match(body, /readCardRaw\(id, decisionCards\.storeDir\(\)\)/);
  assert.match(body, /pending: true/);
});
