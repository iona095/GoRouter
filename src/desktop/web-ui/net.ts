/**
 * GoRouter W2 — browser request discipline (C06 §§5, 13).
 *
 * Every production request is a same-scope relative W1 API v1 path issued only
 * in direct response to bootstrap/session startup, an explicit Refresh, an
 * explicit mutation, logout, or a contract-defined recovery step. There is no
 * polling, socket, worker, retry loop, mutation queue, or absolute URL.
 *
 * The wire envelope `{ snapshot: WebSnapshot }` is validated before it may
 * become the one reviewed snapshot. A mutation that returns HTTP success is
 * treated as committed even when its optional response payload is malformed,
 * and is never replayed.
 */
export const JS_NET = `
  // ---- transport --------------------------------------------------------
  // Resolves with a settled outcome; it never rejects, so no caller can turn a
  // transport failure into an implicit retry.
  function request(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (opts.withCsrf === true && isValidCsrf(csrf)) headers['x-gorouter-csrf'] = csrf;
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (opts.payload !== undefined && opts.payload !== null) init.body = opts.payload;
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (r.ok) return { kind: 'ok', status: r.status, data: data };
        var code = null;
        var reason = null;
        if (isObj(data) && isObj(data.error)) {
          if (isStr(data.error.code)) code = data.error.code;
          if (isStr(data.error.reason)) reason = data.error.reason;
        }
        return { kind: 'http', status: r.status, code: code, reason: reason };
      }, function () {
        // Headers arrived, body read failed: the status is still definite.
        if (r.ok) return { kind: 'ok', status: r.status, data: null };
        return { kind: 'http', status: r.status, code: null, reason: null };
      });
    }, function () {
      return { kind: 'network' };
    });
  }

  // ---- wire envelope validation ----------------------------------------
  // Returns the WebSnapshot carried by a well-formed { snapshot: ... } envelope,
  // or null. A malformed HTTP-200 body can therefore never be committed as the
  // reviewed snapshot and can never enable mutation controls.
  function readSnapshotEnvelope(data) {
    if (!isObj(data)) return null;
    var s = data.snapshot;
    if (!isObj(s)) return null;
    if (!isStr(s.stateGeneration) || s.stateGeneration.length === 0) return null;
    if (typeof s.initialized !== 'boolean') return null;
    if (typeof s.firstRun !== 'boolean') return null;
    if (typeof s.stateCorrupt !== 'boolean') return null;
    if (!isStr(s.secretStore)) return null;
    if (!(s.stateUnsupportedVersion === null || isInt(s.stateUnsupportedVersion))) return null;
    if (!(s.desktopUnsupportedVersion === null || isInt(s.desktopUnsupportedVersion))) return null;
    if (!isObj(s.routes)) return null;
    for (var li = 0; li < LANES.length; li++) {
      var r = s.routes[LANES[li]];
      if (!isObj(r)) return null;
      if (!(r.accountId === null || isStr(r.accountId))) return null;
      if (!(r.alias === null || isStr(r.alias))) return null;
      if (!isInt(r.version)) return null;
    }
    if (!Array.isArray(s.accounts)) return null;
    for (var ai = 0; ai < s.accounts.length; ai++) {
      var a = s.accounts[ai];
      if (!isObj(a)) return null;
      if (!isStr(a.id) || a.id.length === 0) return null;
      if (!isStr(a.alias)) return null;
      if (typeof a.secretPresent !== 'boolean') return null;
      if (!isStrArray(a.usedBy)) return null;
      if (!isStr(a.createdAtUtc) || !isStr(a.updatedAtUtc)) return null;
      if (!isInt(a.version)) return null;
    }
    if (!isObj(s.router) || !isStr(s.router.state) || !isStr(s.router.mode)) return null;
    return s;
  }

  // ---- reviewed-state transitions --------------------------------------
  function computePhase() {
    if (snapshot === null) return;
    if (snapshot.firstRun === true || snapshot.initialized === false) { phase = 'blocked'; blockedKind = 'setup'; return; }
    if (snapshot.stateCorrupt === true) { phase = 'blocked'; blockedKind = 'corrupt'; return; }
    if (snapshot.stateUnsupportedVersion !== null || snapshot.desktopUnsupportedVersion !== null) { phase = 'blocked'; blockedKind = 'unsupported'; return; }
    if (snapshot.secretStore !== 'ok') { phase = 'blocked'; blockedKind = 'secretStore'; return; }
    phase = 'ready';
    blockedKind = null;
  }

  // Committing new reviewed state always invalidates an open mutation form: a
  // form never silently adopts a generation/version the operator never saw.
  function commitSnapshot(s) {
    snapshot = s;
    computePhase();
    if (dialogState !== null) closeDialog('refreshed');
  }

  function endAuthority() {
    csrf = null;
    snapshot = null;
    mutationsLocked = false;
    scrubSecrets();
    closeDialog('authority');
    phase = 'authEnded';
  }

  function canMutate() {
    return phase === 'ready' && isValidCsrf(csrf) && snapshot !== null && !inFlight && !mutationsLocked;
  }

  // ---- snapshot read ----------------------------------------------------
  function readSnapshot() {
    return request('./api/v1/snapshot', {}).then(function (res) {
      if (res.kind === 'ok') {
        var s = readSnapshotEnvelope(res.data);
        if (s !== null) { commitSnapshot(s); return { ok: true }; }
        return { ok: false, cls: 'malformed', text: 'Web Control could not read the current state. Refresh to try again.' };
      }
      var c = classify(res);
      if (c.cls === 'auth' || c.cls === 'csrf') return { ok: false, cls: c.cls, text: '' };
      return { ok: false, cls: c.cls, text: c.text || GENERIC_LOCAL };
    });
  }

  // Explicit operator Refresh. Also the only way out of a locked mutation state.
  function doRefresh() {
    if (inFlight || refreshing) return Promise.resolve();
    refreshing = true;
    formInvalidated = false;
    applyEnabledState();
    return readSnapshot().then(function (r) {
      refreshing = false;
      if (r.ok) {
        mutationsLocked = false;
        clearAlert();
        // Closing an open form is the more important thing to say; do not
        // overwrite that announcement with the generic refresh confirmation.
        if (!formInvalidated) showStatus('State refreshed.');
        formInvalidated = false;
        render();
        return;
      }
      if (r.cls === 'auth' || r.cls === 'csrf') { endAuthority(); render(); return; }
      mutationsLocked = true;
      showAlert(r.text);
      render();
    });
  }

  // ---- the single mutation path ----------------------------------------
  // spec: { path, payload, successText }
  // Exactly one request. No queue, no retry, no second in-flight mutation.
  function sendMutation(spec) {
    if (inFlight) return Promise.resolve();
    if (!canMutate()) return Promise.resolve();
    inFlight = true;
    setPending(true);
    var payload = spec.payload;
    spec.payload = null;
    return request('./api/v1/' + spec.path, { method: 'POST', payload: payload, withCsrf: true })
      .then(function (res) {
        payload = null;
        return settleMutation(spec, res);
      })
      .then(null, function () {
        // A local error while settling must never strand the page in a pending
        // state, and must never be reported as a retryable server outcome.
        payload = null;
        mutationsLocked = true;
        showAlert(UNKNOWN_RESULT);
      })
      .then(function () {
        inFlight = false;
        setPending(false);
        render();
      });
  }

  function settleMutation(spec, res) {
    if (res.kind === 'ok') {
      // Definite HTTP success: the mutation committed (or was a no-op). The
      // optional response payload is never inspected, so a malformed field
      // cannot downgrade this to an ambiguous result or trigger a replay.
      closeDialog('settled');
      return readSnapshot().then(function (r) {
        if (r.ok) { clearAlert(); showStatus(spec.successText); return; }
        if (r.cls === 'auth' || r.cls === 'csrf') { endAuthority(); return; }
        mutationsLocked = true;
        showStatus(spec.successText);
        showAlert(REFRESH_FAILED_AFTER_SUCCESS);
      });
    }
    var c = classify(res);
    if (c.cls === 'auth' || c.cls === 'csrf') { endAuthority(); return Promise.resolve(); }
    if (c.cls === 'unknown') {
      // Lost/ambiguous response: completion is unknown. Nothing is retried and
      // no snapshot is read until the operator acts explicitly.
      closeDialog('settled');
      mutationsLocked = true;
      showAlert(c.text);
      return Promise.resolve();
    }
    if (c.cls === 'conflict') {
      closeDialog('settled');
      showAlert(c.text);
      return readSnapshot().then(function (r) {
        if (r.ok) return;
        if (r.cls === 'auth' || r.cls === 'csrf') { endAuthority(); return; }
        mutationsLocked = true;
      });
    }
    // Definite rejection; nothing committed. The operator resubmits explicitly.
    reportFailure(c.text);
    return Promise.resolve();
  }

  // ---- logout -----------------------------------------------------------
  function doLogout() {
    if (inFlight || logoutPending) return Promise.resolve();
    logoutPending = true;
    applyEnabledState();
    return request('./api/v1/logout', { method: 'POST', withCsrf: true }).then(function (res) {
      logoutPending = false;
      csrf = null;
      snapshot = null;
      mutationsLocked = false;
      scrubSecrets();
      closeDialog('authority');
      if (res.kind === 'ok') { phase = 'loggedOut'; render(); return; }
      // 401 is a definite response proving the session is already gone.
      if (res.kind === 'http' && res.status === 401) { phase = 'loggedOut'; render(); return; }
      // Anything else is unconfirmed: the browser cannot clear an HttpOnly
      // cookie itself, so it must not claim the server session was revoked.
      phase = 'logoutUnconfirmed';
      render();
    });
  }
`
