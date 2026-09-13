/**
 * GoRouter W2 — startup and page lifecycle (C06 §§5.1.1, 7.1, 13).
 *
 * Startup performs exactly one authority exchange (bootstrap handoff when the
 * frozen W1 shim captured one, otherwise a session read) followed by exactly one
 * snapshot read. The page enters the mutation-capable control surface only when
 * both a well-formed CSRF capability and a well-formed `{ snapshot: ... }`
 * envelope were obtained; every other outcome fails closed to a read-only or
 * reopen-required screen.
 *
 * The only global this page touches is the transient bootstrap handoff installed
 * by the frozen W1 shim, which is cleared before the first application request.
 * No mutation-capable helper is published on `window`.
 */
export const JS_BOOT = `
  function adoptAuthority(res) {
    if (res.kind === 'ok') {
      var token = (isObj(res.data) && isStr(res.data.csrf)) ? res.data.csrf : null;
      if (token === null || !isValidCsrf(token)) {
        // HTTP success without a usable capability: fail closed before any
        // control surface exists, and never attempt a second authority path.
        csrf = null;
        snapshot = null;
        scrubSecrets();
        phase = 'authorityError';
        render();
        return;
      }
      csrf = token;
      token = null;
      return readSnapshot().then(function (r) {
        if (r.ok) { render(); return; }
        if (r.cls === 'auth' || r.cls === 'csrf') { endAuthority(); render(); return; }
        phase = 'unavailable';
        showAlert(r.text);
        render();
      });
    }
    if (res.kind === 'http' && (res.status === 401 || res.status === 403)) {
      phase = 'noSession';
      render();
      return;
    }
    phase = 'startFailed';
    render();
  }

  function startup() {
    buildSkeleton();
    render();
    var handoff = window.__gorouterBootstrap || null;
    window.__gorouterBootstrap = null;
    if (handoff) {
      var body = JSON.stringify({ bootstrap: handoff });
      handoff = null;
      return request('./api/v1/bootstrap', { method: 'POST', payload: body }).then(function (res) {
        body = null;
        return adoptAuthority(res);
      });
    }
    return request('./api/v1/session', {}).then(function (res) {
      return adoptAuthority(res);
    });
  }

  // A BFCache or navigation restore must not resurrect a typed API key.
  window.addEventListener('pagehide', function () { scrubSecrets(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { startup(); });
  } else {
    startup();
  }
`
