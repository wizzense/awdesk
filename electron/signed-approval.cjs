"use strict";

/**
 * signed-approval -- approve a destructive decision card with a passkey
 * (Windows Hello on this box) instead of an unsigned `awask answer`.
 *
 * WHY. Genesis signs an owner receipt on POST /api/v1/decisions/{id}/answer only
 * for a fresh (<=15 min) webauthn/totp session (routers/decisions.py
 * `_signed_receipt`). awstorage refuses to apply a deletion/relocation approval
 * without that receipt. `awask answer` writes the card file directly and is
 * never signed, so the Deck's Approve on such a card recorded an answer that
 * approved NOTHING. For those cards the Approve opens Veil's /approve page in a
 * small window instead; Electron on Windows routes navigator.credentials.get()
 * to Windows Hello. Reject (and every ordinary card) still uses awask -- a
 * rejection needs no proof.
 *
 * READ-ONLY on the card store: the card is read here only to decide the route;
 * the renderer's payload never decides whether a card is destructive.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Card kinds whose approval a consumer verifies against a signed receipt. */
const SIGNED_ANSWER_KINDS = Object.freeze([
  "awstorage-manage",
  "awstorage-suggestion",
  "awstorage-relocate",
]);

/** Facts that bind a card to a proposal/plan a consumer will only apply when signed
 *  (awstorage manage.card_facts -> `proposal_id: <n>`; relocate -> `plan_id: <id>`). */
const SIGNED_FACT_KEYS = Object.freeze(["proposal_id", "plan_id"]);

/** Choice keys that decline: they need no proof and keep using awask. */
const DECLINE_KEYS = Object.freeze([
  "reject", "deny", "decline", "no", "cancel", "skip", "later", "dismiss",
  "ignore", "keep", "leave", "defer", "snooze",
]);

/** Session partition for the approve window: persistent, so the Veil login cookie
 *  (set by /api/me/webauthn/authenticate PUT) survives between approvals. */
const APPROVE_PARTITION = "persist:aither-approve";
const DEFAULT_PORTAL_ORIGIN = "https://aitherium.com";

const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** true when `raw` (the card JSON) needs a SIGNED approval. */
function requiresSignedAnswer(raw) {
  if (!raw || typeof raw !== "object") return false;
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (SIGNED_ANSWER_KINDS.includes(kind)) return true;
  const facts = Array.isArray(raw.facts) ? raw.facts : [];
  return facts.some((f) => {
    if (typeof f !== "string") return false;
    const i = f.indexOf(":");
    if (i <= 0) return false;
    return SIGNED_FACT_KEYS.includes(f.slice(0, i).trim().toLowerCase());
  });
}

/** true when `choice` declines (reject/deny/...), case-insensitive. */
function isDeclineChoice(choice) {
  const c = String(choice || "").trim().toLowerCase();
  return DECLINE_KEYS.includes(c);
}

/**
 * Where an answer goes: "window" (signed, passkey page) or "awask" (unsigned).
 * Unknown/unreadable card -> "awask": the pre-existing behaviour, and the
 * consumer still refuses an unsigned approval, so failing open here cannot
 * approve anything by itself.
 */
function answerRoute(raw, choice) {
  if (!requiresSignedAnswer(raw)) return "awask";
  return isDeclineChoice(choice) ? "awask" : "window";
}

/** The raw card JSON for `id` from the store, or null. The id is validated so a
 *  renderer-supplied value can never name a path outside the store. */
function readCardRaw(id, dir, fsImpl = fs) {
  if (typeof id !== "string" || !CARD_ID_RE.test(id) || id.includes("..")) return null;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    return raw && typeof raw === "object" && raw.id === id ? raw : null;
  } catch {
    return null;
  }
}

/** The portal origin: $AITHER_PORTAL_ORIGIN when it is https (or http on loopback
 *  for dev), else https://aitherium.com. Never a path, never a credential. */
function portalOrigin(env = process.env) {
  const rawValue = String((env && env.AITHER_PORTAL_ORIGIN) || "").trim();
  if (!rawValue) return DEFAULT_PORTAL_ORIGIN;
  try {
    const u = new URL(rawValue);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.username || u.password) return DEFAULT_PORTAL_ORIGIN;
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  } catch {
    /* fall through */
  }
  return DEFAULT_PORTAL_ORIGIN;
}

/** /approve?card=<id>&choice=<key> on the portal. */
function approveUrl(id, choice, origin = portalOrigin()) {
  const u = new URL("/approve", origin);
  u.searchParams.set("card", String(id));
  u.searchParams.set("choice", String(choice));
  return u.toString();
}

/** Navigation the approve window may follow: the portal origin itself, or any
 *  https *.aitherium.com (the IdP sign-in hop). Everything else is refused. */
function isAllowedApproveNavigation(target, origin = portalOrigin()) {
  try {
    const u = new URL(target);
    if (u.origin === new URL(origin).origin) return true;
    return u.protocol === "https:" &&
      (u.hostname === "aitherium.com" || u.hostname.endsWith(".aitherium.com"));
  } catch {
    return false;
  }
}

/**
 * Open (or re-focus) the approve window. `BrowserWindow` is injected so tests
 * run without Electron. Default webPreferences keep WebAuthn working (the
 * sandbox does not block navigator.credentials; Windows Hello is the platform
 * authenticator); nodeIntegration stays off and there is no preload -- the page
 * is remote content and gets no bridge.
 *
 * @returns the window
 */
let _approveWindow = null;
function openApproveWindow({ build, url, origin = portalOrigin(), log = () => {} }) {
  if (_approveWindow && !_approveWindow.isDestroyed()) {
    _approveWindow.loadURL(url);
    _approveWindow.show();
    _approveWindow.focus();
    return _approveWindow;
  }
  // Built by presentation.cjs (the one file that constructs windows): hosted spec
  // `approve`, sandboxed, no node, the persist:aither-approve cookie jar.
  const win = build(APPROVE_PARTITION);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedApproveNavigation(target, origin)) {
      log(`[approve] blocked navigation to ${target}`);
      event.preventDefault();
    }
  });
  win.on("closed", () => {
    if (_approveWindow === win) _approveWindow = null;
  });
  _approveWindow = win;
  win.loadURL(url);
  return win;
}

module.exports = {
  SIGNED_ANSWER_KINDS,
  SIGNED_FACT_KEYS,
  DECLINE_KEYS,
  APPROVE_PARTITION,
  DEFAULT_PORTAL_ORIGIN,
  requiresSignedAnswer,
  isDeclineChoice,
  answerRoute,
  readCardRaw,
  portalOrigin,
  approveUrl,
  isAllowedApproveNavigation,
  openApproveWindow,
};
