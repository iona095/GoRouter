/**
 * GoRouter W2 — page rendering (C06 §§4, 6, 9, 10, 11).
 *
 * One compact operational control surface: a read-only header, two lane cards,
 * the account list, and the authoritative blocking/terminal screens. Every
 * dynamic value reaches the DOM through textContent or a DOM property; no
 * markup sink and no inline style is ever used.
 *
 * The live regions are built once and are never torn down, so status and error
 * announcements are made in a region that already existed.
 */
export const JS_RENDER = `
  var ctl = { controls: [], refreshBtn: null, logoutBtn: null };

  function buildSkeleton() {
    var app = byId('app');
    clearNode(app);
    app.setAttribute('tabindex', '-1');
    var header = elem('header', 'app-header');
    header.id = 'app-header';
    var regions = elem('div');
    regions.id = 'regions';
    var alertRegion = elem('div');
    alertRegion.id = 'alert-region';
    alertRegion.setAttribute('role', 'alert');
    alertRegion.setAttribute('aria-live', 'assertive');
    var statusRegion = elem('div');
    statusRegion.id = 'status-region';
    statusRegion.setAttribute('role', 'status');
    statusRegion.setAttribute('aria-live', 'polite');
    regions.appendChild(alertRegion);
    regions.appendChild(statusRegion);
    var main = elem('main');
    main.id = 'main';
    var dlg = document.createElement('dialog');
    dlg.id = 'dialog';
    appendAll(app, [header, regions, main, dlg]);
  }

  // ---- banners ----------------------------------------------------------
  function bannerNode(cls, label, text) {
    var b = elem('div', 'banner ' + cls);
    b.appendChild(elem('p', 'banner-label', label));
    b.appendChild(elem('p', null, text));
    var d = button('Dismiss', 'link', 'Dismiss this message');
    d.addEventListener('click', function () {
      if (b.parentNode) clearNode(b.parentNode);
    });
    b.appendChild(d);
    return b;
  }

  function showAlert(text) {
    var r = byId('alert-region');
    clearNode(r);
    if (text) r.appendChild(bannerNode('banner-alert', 'Attention', text));
  }

  function clearAlert() { clearNode(byId('alert-region')); }

  function showStatus(text) {
    var r = byId('status-region');
    clearNode(r);
    if (text) r.appendChild(bannerNode('banner-status', 'Status', text));
  }

  // Routes a settled local failure to the form that caused it when one is open,
  // and to the page-level alert region otherwise.
  function reportFailure(text) {
    if (dialogState !== null) { setDialogError(text); return; }
    showAlert(text);
  }

  // ---- enablement -------------------------------------------------------
  function reg(el, pred) {
    ctl.controls.push({ el: el, pred: pred });
    return el;
  }

  function applyEnabledState() {
    var busy = inFlight || refreshing || logoutPending;
    for (var i = 0; i < ctl.controls.length; i++) {
      var c = ctl.controls[i];
      var ok = !busy && canMutate() && (c.pred ? c.pred() === true : true);
      c.el.disabled = !ok;
    }
    if (ctl.refreshBtn) ctl.refreshBtn.disabled = busy;
    if (ctl.logoutBtn) ctl.logoutBtn.disabled = busy;
    applyDialogPending();
  }

  // ---- top-level render -------------------------------------------------
  function render() {
    var active = document.activeElement;
    var focusId = active && active.id ? active.id : null;
    ctl.controls = [];
    ctl.refreshBtn = null;
    ctl.logoutBtn = null;
    renderHeader();
    renderMain();
    applyEnabledState();
    if (focusId) {
      var t = byId(focusId);
      if (t && typeof t.focus === 'function') t.focus();
    }
    // A dialog that closed during this settle restores focus by id, so the
    // rebuilt control receives it even though the original node is gone.
    applyPendingFocus();
  }

  function sessionStateText() {
    if (phase === 'startup') return 'Starting';
    if (phase === 'ready' || phase === 'blocked') return 'Active';
    if (phase === 'noSession') return 'Not started';
    if (phase === 'authEnded') return 'Ended';
    if (phase === 'loggedOut') return 'Logged out';
    if (phase === 'logoutUnconfirmed') return 'Unconfirmed';
    if (phase === 'authorityError' || phase === 'startFailed') return 'Not established';
    return 'Unavailable';
  }

  function fact(label, value) {
    var p = elem('p', 'header-fact');
    p.appendChild(elem('strong', null, label + ': '));
    p.appendChild(document.createTextNode(value));
    return p;
  }

  function headerHasActions() {
    return phase === 'ready' || phase === 'blocked' || phase === 'unavailable';
  }

  function renderHeader() {
    var h = byId('app-header');
    clearNode(h);
    var title = elem('div', 'header-title');
    title.appendChild(elem('h1', null, 'GoRouter Web Control'));
    h.appendChild(title);

    var facts = elem('div', 'header-facts');
    facts.appendChild(fact('Session', sessionStateText()));
    if (snapshot !== null) {
      facts.appendChild(fact('Router', snapshot.router.state + ' (' + snapshot.router.mode + ')'));
    }
    h.appendChild(facts);

    var actions = elem('div', 'header-actions');
    if (headerHasActions()) {
      var rb = button('Refresh', null, 'Refresh state');
      rb.id = 'btn-refresh';
      rb.addEventListener('click', function () { doRefresh(); });
      ctl.refreshBtn = rb;
      actions.appendChild(rb);
      var lb = button('Log out', null, 'Log out of Web Control');
      lb.id = 'btn-logout';
      lb.addEventListener('click', function () { doLogout(); });
      ctl.logoutBtn = lb;
      actions.appendChild(lb);
    }
    h.appendChild(actions);
  }

  function renderMain() {
    var main = byId('main');
    clearNode(main);
    if (phase === 'ready') {
      main.appendChild(renderRouting());
      main.appendChild(renderAccounts());
      return;
    }
    if (phase === 'blocked') { main.appendChild(renderBlocked()); return; }
    main.appendChild(renderTerminal());
  }

  // ---- routing ----------------------------------------------------------
  function renderRouting() {
    var sec = elem('section');
    sec.setAttribute('aria-labelledby', 'routing-h');
    var head = elem('div', 'section-head');
    var h2 = elem('h2', null, 'Routing');
    h2.id = 'routing-h';
    head.appendChild(h2);
    sec.appendChild(head);
    var grid = elem('div', 'lanes');
    for (var i = 0; i < LANES.length; i++) grid.appendChild(laneCard(LANES[i]));
    sec.appendChild(grid);
    return sec;
  }

  function laneCard(lane) {
    var route = snapshot.routes[lane];
    var card = elem('section', 'lane-card lane-card-' + lane);
    var hid = 'lane-' + lane + '-h';
    card.setAttribute('aria-labelledby', hid);

    var head = elem('div', 'lane-head');
    var h3 = elem('h3');
    h3.id = hid;
    h3.appendChild(elem('span', 'lane-tag', laneLabel(lane)));
    h3.appendChild(document.createTextNode(' lane'));
    head.appendChild(h3);
    card.appendChild(head);

    var selected = route.accountId !== null;
    var acct = selected ? accountById(route.accountId) : null;
    if (!selected) {
      card.appendChild(elem('p', 'lane-selected', 'Not selected'));
      card.appendChild(elem('p', 'lane-meta', 'Route state: no account selected'));
    } else {
      var alias = acct !== null ? acct.alias : (isStr(route.alias) ? route.alias : 'Unknown account');
      card.appendChild(elem('p', 'lane-selected', alias));
      card.appendChild(elem('p', 'lane-meta', 'Route state: account selected'));
      var chips = elem('p', 'lane-meta');
      if (acct !== null && acct.secretPresent === true) {
        chips.appendChild(elem('span', 'chip chip-ok', 'Credential: Stored'));
      } else {
        chips.appendChild(elem('span', 'chip chip-warn', 'Credential missing'));
      }
      card.appendChild(chips);
      if (acct === null || acct.secretPresent !== true) {
        card.appendChild(elem('p', 'lane-meta',
          'This lane still points at the account above. Replace its credential, or select another account below. Nothing is changed until you choose.'));
      }
    }

    var accounts = sortedAccounts(snapshot.accounts);
    var selId = 'lane-' + lane + '-select';
    var field = elem('div', 'field');
    var label = elem('label', null, laneLabel(lane) + ' account to select');
    label.setAttribute('for', selId);
    var sel = document.createElement('select');
    sel.id = selId;
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = accounts.length === 0 ? 'No accounts yet' : 'Choose an account';
    sel.appendChild(ph);
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      var o = document.createElement('option');
      o.value = a.id;
      if (a.secretPresent === true) {
        o.textContent = a.alias;
        if (a.id === route.accountId) o.selected = true;
      } else {
        o.textContent = a.alias + ' (credential missing, not selectable)';
        o.disabled = true;
      }
      sel.appendChild(o);
    }
    sel.addEventListener('change', function () { applyEnabledState(); });
    reg(sel, function () { return accounts.length > 0; });
    field.appendChild(label);
    field.appendChild(sel);

    var form = elem('div', 'lane-form');
    form.appendChild(field);
    if (accounts.length === 0) {
      form.appendChild(elem('p', 'lane-meta', 'Add an account with a stored credential before selecting this lane.'));
    }
    var actions = elem('div', 'lane-actions');
    var setBtn = button('Set route', 'primary', 'Set ' + laneLabel(lane) + ' route');
    setBtn.id = 'btn-set-' + lane;
    setBtn.addEventListener('click', function () { submitRouteSet(lane, sel.value); });
    reg(setBtn, function () { return sel.value !== '' && sel.value !== route.accountId; });
    actions.appendChild(setBtn);
    if (selected) {
      var clearBtn = button('Clear route', null, 'Clear ' + laneLabel(lane) + ' route');
      clearBtn.id = 'btn-clear-' + lane;
      clearBtn.addEventListener('click', function () { submitRouteClear(lane); });
      reg(clearBtn, null);
      actions.appendChild(clearBtn);
    }
    form.appendChild(actions);
    card.appendChild(form);
    return card;
  }

  // ---- accounts ---------------------------------------------------------
  function renderAccounts() {
    var sec = elem('section');
    sec.setAttribute('aria-labelledby', 'accounts-h');
    var head = elem('div', 'section-head');
    var h2 = elem('h2', null, 'Accounts');
    h2.id = 'accounts-h';
    head.appendChild(h2);
    var empty = snapshot.accounts.length === 0;
    if (!empty) head.appendChild(addAccountButton());
    sec.appendChild(head);
    if (empty) {
      var panel = elem('div', 'panel notice');
      panel.appendChild(elem('h2', null, 'No accounts yet'));
      panel.appendChild(elem('p', null,
        'GoRouter needs at least one account with a stored credential before the GO or ZEN lane can be selected.'));
      panel.appendChild(addAccountButton());
      sec.appendChild(panel);
      return sec;
    }
    var list = sortedAccounts(snapshot.accounts);
    var ul = elem('ul', 'account-list');
    for (var i = 0; i < list.length; i++) ul.appendChild(accountRow(list[i], i));
    sec.appendChild(ul);
    return sec;
  }

  function addAccountButton() {
    var b = button('Add account', 'primary', 'Add account');
    b.id = 'btn-add-account';
    b.addEventListener('click', function () { openAddDialog(b); });
    reg(b, null);
    return b;
  }

  function accountRow(a, idx) {
    var li = elem('li', 'account-row');
    var mainCol = elem('div', 'account-main');
    mainCol.appendChild(elem('p', 'account-alias', a.alias));

    var chips = elem('p', 'account-meta');
    chips.appendChild(elem('span',
      a.secretPresent === true ? 'chip chip-ok' : 'chip chip-warn',
      a.secretPresent === true ? 'Credential: Stored' : 'Credential: Missing'));
    var lanes = laneListText(a.usedBy);
    if (lanes === '') {
      chips.appendChild(elem('span', 'chip', 'Lane use: none'));
    } else {
      chips.appendChild(elem('span', 'chip chip-lane', 'Lane use: ' + lanes));
    }
    mainCol.appendChild(chips);
    mainCol.appendChild(elem('p', 'account-meta', 'Last updated: ' + formatStamp(a.updatedAtUtc)));
    li.appendChild(mainCol);

    var acts = elem('div', 'account-actions');
    var rep = button('Replace credential', null, 'Replace credential for account ' + a.alias);
    rep.id = 'acct-' + idx + '-replace';
    rep.addEventListener('click', function () { openReplaceDialog(a, rep); });
    reg(rep, null);
    acts.appendChild(rep);
    var ren = button('Rename', null, 'Rename account ' + a.alias);
    ren.id = 'acct-' + idx + '-rename';
    ren.addEventListener('click', function () { openRenameDialog(a, ren); });
    reg(ren, null);
    acts.appendChild(ren);
    li.appendChild(acts);

    var danger = elem('div', 'account-actions account-actions-danger');
    var inUse = laneListText(a.usedBy);
    var rem = button('Remove', 'danger', 'Remove account ' + a.alias);
    rem.id = 'acct-' + idx + '-remove';
    rem.addEventListener('click', function () { openRemoveDialog(a, rem); });
    reg(rem, function () { return a.usedBy.length === 0; });
    danger.appendChild(rem);
    if (inUse !== '') {
      danger.appendChild(elem('p', 'account-meta',
        'Clear the ' + inUse + ' route before removing this account.'));
    }
    li.appendChild(danger);
    return li;
  }

  // ---- blocking screens -------------------------------------------------
  function noticePanel(heading, paragraphs) {
    var panel = elem('div', 'panel notice');
    panel.appendChild(elem('h2', null, heading));
    for (var i = 0; i < paragraphs.length; i++) panel.appendChild(elem('p', null, paragraphs[i]));
    return panel;
  }

  function renderBlocked() {
    if (blockedKind === 'setup') {
      return noticePanel('Finish setup in the GoRouter desktop app', [
        'GoRouter has not completed first-run setup, so Web Control cannot add accounts or select lanes.',
        'Complete setup in the GoRouter desktop app, then use Refresh.'
      ]);
    }
    if (blockedKind === 'corrupt') {
      return noticePanel('Stored state is corrupt', [
        'Web Control is read-only because GoRouter reported that its stored state is corrupt.',
        'Repair or restore the state from the GoRouter desktop app. Only Refresh and Log out are available here.'
      ]);
    }
    if (blockedKind === 'unsupported') {
      var lines = ['Web Control is read-only because the stored data uses a schema this build does not support.'];
      if (snapshot.stateUnsupportedVersion !== null) {
        lines.push('Stored state schema version: ' + String(snapshot.stateUnsupportedVersion) + '.');
      }
      if (snapshot.desktopUnsupportedVersion !== null) {
        lines.push('Desktop settings schema version: ' + String(snapshot.desktopUnsupportedVersion) + '.');
      }
      lines.push('Update GoRouter from the desktop app. Only Refresh and Log out are available here.');
      return noticePanel('Unsupported data schema', lines);
    }
    return noticePanel('Credential store unavailable', [
      'Web Control is read-only because GoRouter cannot reach the local credential store.',
      'No account or route change can be made until the credential store is healthy again. Only Refresh and Log out are available here.'
    ]);
  }

  function renderTerminal() {
    if (phase === 'noSession') {
      return noticePanel('No Web Control session', [
        'This page has no GoRouter session.',
        'Open Web Control from the GoRouter desktop app to start one.'
      ]);
    }
    if (phase === 'authEnded') {
      return noticePanel('Session ended', [
        'This Web Control session is no longer valid, so no further changes can be made from this page.',
        'Reopen Web Control from the GoRouter desktop app.'
      ]);
    }
    if (phase === 'loggedOut') {
      return noticePanel('Logged out', [
        'The Web Control session was ended.',
        'Reopen Web Control from the GoRouter desktop app when you need it again.'
      ]);
    }
    if (phase === 'logoutUnconfirmed') {
      return noticePanel('Logout could not be confirmed', [
        'Logout could not be confirmed. Close this tab and reopen Web Control from the desktop app.',
        'This page has discarded its own copy of the session state, but it cannot confirm that the GoRouter session was ended.'
      ]);
    }
    if (phase === 'authorityError') {
      return noticePanel('Web Control could not start a secure session', [
        'GoRouter answered, but this page did not receive a usable session capability, so it has made no change and will not offer any.',
        'Close this tab and reopen Web Control from the GoRouter desktop app.'
      ]);
    }
    if (phase === 'startFailed') {
      return noticePanel('Web Control could not start', [
        'The browser could not complete a session with GoRouter on this computer.',
        'Close this tab and reopen Web Control from the GoRouter desktop app.'
      ]);
    }
    if (phase === 'startup') {
      return noticePanel('Starting Web Control', ['Contacting GoRouter on this computer.']);
    }
    return noticePanel('Web Control is unavailable', [
      'GoRouter did not return a usable view of the current state, so no account or route change can be made.',
      'Use Refresh to try again, or reopen Web Control from the GoRouter desktop app.'
    ]);
  }
`
