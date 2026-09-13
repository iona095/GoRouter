/**
 * GoRouter W2 — browser application core (C06 §§4, 5, 9, 12).
 *
 * Emitted verbatim into the single fixed `/assets/app.js` entry of the frozen
 * W1 asset map (no bundler, no package, no remote asset). This module holds the
 * page-level state container, safe DOM construction helpers, the execution-time
 * alias/capability validators, local display formatting, and the curated
 * status/reason -> message tables.
 *
 * Rules enforced here:
 * - every server/operator-derived value reaches the DOM through textContent or a
 *   property assignment; no markup sink is ever used;
 * - no server prose is surfaced: only stable `code`/`reason` values select a
 *   message from a local table, unknown values fall back to a generic message;
 * - no routine instrumentation is emitted into the production page.
 */
export const JS_CORE = `
  // ---- page state -------------------------------------------------------
  // csrf is the single browser authority string. It lives only in this closure
  // and is replaced solely by a successful bootstrap/session establishment.
  var csrf = null;
  var snapshot = null;          // the one reviewed WebSnapshot
  var phase = 'startup';        // startup|ready|blocked|noSession|authEnded|loggedOut|logoutUnconfirmed|unavailable
  var blockedKind = null;       // setup|corrupt|unsupported|secretStore
  var inFlight = false;         // at most one mutation request per page
  var mutationsLocked = false;  // set after an unconfirmed / unrefreshed result
  var refreshing = false;
  var logoutPending = false;
  var dialogState = null;       // open mutation form, if any
  var formInvalidated = false;  // a refresh closed an open form this cycle

  var ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;
  var CSRF_RE = /^[A-Za-z0-9_-]{43,64}$/;
  var LANES = ['go', 'zen'];

  // ---- safe DOM helpers -------------------------------------------------
  function elem(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clearNode(n) {
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  function byId(id) { return document.getElementById(id); }

  function appendAll(parent, kids) {
    for (var i = 0; i < kids.length; i++) { if (kids[i]) parent.appendChild(kids[i]); }
    return parent;
  }

  function button(label, cls, accessibleName) {
    var b = elem('button', cls, label);
    b.type = 'button';
    if (accessibleName) b.setAttribute('aria-label', accessibleName);
    return b;
  }

  // ---- validation -------------------------------------------------------
  // The alias rule mirrors the execution-time authoritative W0 rule
  // (src/state.ts ALIAS_RE). The submitted value is never trimmed, case-folded
  // or otherwise rewritten; the server stays authoritative.
  function isValidAlias(v) { return typeof v === 'string' && ALIAS_RE.test(v); }
  function isValidCsrf(v) { return typeof v === 'string' && CSRF_RE.test(v); }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function isStr(v) { return typeof v === 'string'; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function isStrArray(v) {
    if (!Array.isArray(v)) return false;
    for (var i = 0; i < v.length; i++) { if (!isStr(v[i])) return false; }
    return true;
  }

  // ---- display formatting ----------------------------------------------
  function formatStamp(raw) {
    if (!isStr(raw) || raw.length === 0) return 'Unknown';
    var d = new Date(raw);
    var t = d.getTime();
    if (t !== t) return 'Unknown';
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch (e) {
      return 'Unknown';
    }
  }

  function laneLabel(lane) { return lane === 'go' ? 'GO' : 'ZEN'; }

  function laneListText(usedBy) {
    var names = [];
    for (var i = 0; i < usedBy.length; i++) {
      if (usedBy[i] === 'go' || usedBy[i] === 'zen') names.push(laneLabel(usedBy[i]));
    }
    return names.length === 0 ? '' : names.join(', ');
  }

  // Deterministic display order: case-insensitive alias, then alias, then id.
  // The authoritative alias value itself is never rewritten.
  function sortedAccounts(list) {
    var copy = list.slice(0);
    copy.sort(function (a, b) {
      var la = a.alias.toLowerCase();
      var lb = b.alias.toLowerCase();
      if (la < lb) return -1;
      if (la > lb) return 1;
      if (a.alias < b.alias) return -1;
      if (a.alias > b.alias) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return copy;
  }

  function accountById(id) {
    if (!snapshot) return null;
    for (var i = 0; i < snapshot.accounts.length; i++) {
      if (snapshot.accounts[i].id === id) return snapshot.accounts[i];
    }
    return null;
  }

  // ---- curated user-facing messages -------------------------------------
  // Behaviour is driven by status/reason. Server prose is never rendered.
  var CONFLICT_TEXT = {
    state_generation_mismatch: 'State changed elsewhere. Review the refreshed values and try again.',
    route_version_mismatch: 'The route changed elsewhere. Review the refreshed values and try again.',
    account_version_mismatch: 'The account changed elsewhere. Review the refreshed values and try again.',
    alias_conflict: 'That alias already exists. Review the refreshed values and try again.',
    account_in_use: 'That account is still selected by a lane. Clear the lane first, then remove it.',
    target_not_selectable: 'That account is no longer selectable because its stored credential is missing.',
    not_found: 'That account no longer exists. Review the refreshed values and try again.'
  };

  var GENERIC_CONFLICT = 'State changed elsewhere. Review the refreshed values and try again.';
  var GENERIC_VALIDATION = 'The request was rejected as invalid. Check the values and try again.';
  var GENERIC_UNAVAILABLE = 'Web Control is temporarily unavailable. Try again in a moment.';
  var GENERIC_LOCAL = 'A local error stopped this action. Try again.';
  var UNKNOWN_RESULT = 'The result of this change is unknown. Nothing was retried. Refresh to review the current state before making another change.';
  var REFRESH_FAILED_AFTER_SUCCESS = 'The change was saved, but the displayed state could not be refreshed. Refresh successfully before making another change.';

  function conflictText(reason) {
    if (isStr(reason) && Object.prototype.hasOwnProperty.call(CONFLICT_TEXT, reason)) {
      return CONFLICT_TEXT[reason];
    }
    return GENERIC_CONFLICT;
  }

  // Classifies a settled request outcome into a local, safe user message class.
  // 'auth' and 'csrf' are authority-ending; 'conflict' requires refreshed review;
  // 'unknown' is the ambiguous/lost-response class (never auto-retried).
  function classify(res) {
    if (res.kind === 'network') return { cls: 'unknown', text: UNKNOWN_RESULT };
    if (res.status === 401) return { cls: 'auth', text: '' };
    if (res.status === 403) return { cls: 'csrf', text: '' };
    if (res.status === 404 || res.status === 409) return { cls: 'conflict', text: conflictText(res.reason) };
    if (res.status === 503) return { cls: 'unavailable', text: GENERIC_UNAVAILABLE };
    if (res.status >= 400 && res.status < 500) return { cls: 'validation', text: GENERIC_VALIDATION };
    return { cls: 'local', text: GENERIC_LOCAL };
  }
`
