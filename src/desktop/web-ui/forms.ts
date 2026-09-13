/**
 * GoRouter W2 — mutation forms and dialogs (C06 §§5.6, 7, 8, 11).
 *
 * Every mutation form freezes the reviewed generation (and, for account forms,
 * the immutable account id and reviewed account version) at the moment it is
 * opened. A refreshed or conflicting snapshot invalidates the form instead of
 * silently substituting newer values.
 *
 * Credential values are ephemeral: the password field is cleared as soon as the
 * request payload has been serialised, and again on cancel, close, error and
 * page-lifecycle exit. Nothing is ever written to browser persistence, a URL, a
 * data attribute, or a log, and no reveal control exists.
 */
export const JS_FORMS = `
  // ---- secret hygiene ---------------------------------------------------
  function scrubSecrets() {
    var inputs = document.querySelectorAll('input[type=password]');
    for (var i = 0; i < inputs.length; i++) { inputs[i].value = ''; }
    if (dialogState !== null) dialogState.secretInput = null;
  }

  // ---- dialog plumbing --------------------------------------------------
  function focusableIn(root) {
    var nodes = root.querySelectorAll('button, input, select, textarea');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.disabled !== true && n.tabIndex !== -1) out.push(n);
    }
    return out;
  }

  function onDialogKeydown(e) {
    var dlg = byId('dialog');
    if (e.key === 'Escape') {
      // A pending mutation form is not dismissible by application UI.
      if (inFlight) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key !== 'Tab') return;
    var items = focusableIn(dlg);
    if (items.length === 0) { e.preventDefault(); dlg.focus(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    var cur = document.activeElement;
    var inside = dlg.contains(cur);
    if (e.shiftKey) {
      if (!inside || cur === first) { e.preventDefault(); last.focus(); }
    } else {
      if (!inside || cur === last) { e.preventDefault(); first.focus(); }
    }
  }

  function onDialogCancel(e) {
    if (inFlight) { e.preventDefault(); return; }
    e.preventDefault();
    closeDialog('cancel');
  }

  var pendingFocusId = null;

  /**
   * Moves focus to the recorded restoration target. The request is kept until it
   * actually lands: the first attempt can run while the closing modal still
   * makes the rest of the page inert, and the target may be replaced by the
   * re-render that follows a successful mutation.
   */
  function applyPendingFocus() {
    var id = pendingFocusId;
    if (id === null) return;
    var t = byId(id);
    if (!t || typeof t.focus !== 'function') { pendingFocusId = null; return; }
    t.focus();
    if (document.activeElement === t) pendingFocusId = null;
  }

  function onDialogClose() { applyPendingFocus(); }

  function applyDialogPending() {
    if (dialogState === null) return;
    var pendingNow = inFlight === true;
    if (dialogState.submitBtn) dialogState.submitBtn.disabled = pendingNow;
    if (dialogState.cancelBtn) dialogState.cancelBtn.disabled = pendingNow;
    var fields = dialogState.inputs || [];
    for (var i = 0; i < fields.length; i++) fields[i].disabled = pendingNow;
    if (dialogState.pendingNote) {
      dialogState.pendingNote.textContent = pendingNow ? 'Working. Please wait.' : '';
    }
    if (pendingNow && dialogState.pendingNote) dialogState.pendingNote.focus();
  }

  function setPending(on) {
    applyEnabledState();
    if (on !== true && dialogState !== null && dialogState.firstField) {
      dialogState.firstField.focus();
    }
  }

  function setDialogError(text) {
    if (dialogState === null || !dialogState.errorBox) { showAlert(text); return; }
    dialogState.errorBox.textContent = text;
    dialogState.errorBox.focus();
  }

  function setFieldError(field, text) {
    field.errorNode.textContent = text;
    if (text === '') {
      field.input.removeAttribute('aria-invalid');
    } else {
      field.input.setAttribute('aria-invalid', 'true');
    }
  }

  function closeDialog(why) {
    if (dialogState === null) return;
    var st = dialogState;
    scrubSecrets();
    dialogState = null;
    var dlg = byId('dialog');
    dlg.removeEventListener('keydown', onDialogKeydown);
    dlg.removeEventListener('cancel', onDialogCancel);
    // Focus restoration is deferred to the dialog's own close event: while the
    // modal is open everything outside it is inert, so a synchronous focus()
    // here would be discarded. Recording the target by id also survives the
    // re-render that follows a successful mutation.
    pendingFocusId = st.opener && st.opener.id ? st.opener.id : 'app';
    try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); applyPendingFocus(); }
    clearNode(dlg);
    if (why === 'refreshed') {
      formInvalidated = true;
      showStatus('The open form was closed because the displayed state changed. Reopen it to continue.');
    }
  }

  function textField(id, labelText, hintText) {
    var wrap = elem('div', 'field');
    var label = elem('label', null, labelText);
    label.setAttribute('for', id);
    var input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    var hint = elem('p', 'field-hint', hintText);
    hint.id = id + '-hint';
    var errorNode = elem('p', 'field-error');
    errorNode.id = id + '-error';
    input.setAttribute('aria-describedby', hint.id + ' ' + errorNode.id);
    appendAll(wrap, [label, input, hint, errorNode]);
    return { wrap: wrap, input: input, errorNode: errorNode };
  }

  function secretField(id, labelText, hintText) {
    var wrap = elem('div', 'field');
    var label = elem('label', null, labelText);
    label.setAttribute('for', id);
    var input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    var hint = elem('p', 'field-hint', hintText);
    hint.id = id + '-hint';
    var errorNode = elem('p', 'field-error');
    errorNode.id = id + '-error';
    input.setAttribute('aria-describedby', hint.id + ' ' + errorNode.id);
    appendAll(wrap, [label, input, hint, errorNode]);
    return { wrap: wrap, input: input, errorNode: errorNode };
  }

  // spec: { kind, title, opener, fields[], bodyNodes[], submitLabel, submitClass,
  //         submitName, onSubmit(state) }
  function openDialog(spec) {
    if (!canMutate()) return;
    closeDialog('replaced');
    var dlg = byId('dialog');
    clearNode(dlg);
    dlg.setAttribute('tabindex', '-1');
    dlg.setAttribute('aria-labelledby', 'dialog-title');

    var inner = elem('div', 'dialog-inner');
    var title = elem('h2', 'dialog-title', spec.title);
    title.id = 'dialog-title';
    inner.appendChild(title);

    var form = document.createElement('form');
    form.autocomplete = 'off';
    form.noValidate = true;
    var errorBox = elem('div', 'form-errors');
    errorBox.id = 'dialog-errors';
    errorBox.setAttribute('role', 'alert');
    errorBox.setAttribute('tabindex', '-1');
    form.appendChild(errorBox);
    form.setAttribute('aria-describedby', errorBox.id);

    var body = elem('div', 'dialog-body');
    var i;
    for (i = 0; i < spec.bodyNodes.length; i++) body.appendChild(spec.bodyNodes[i]);
    for (i = 0; i < spec.fields.length; i++) body.appendChild(spec.fields[i].wrap);
    form.appendChild(body);

    var pendingNote = elem('p', 'pending-note');
    pendingNote.id = 'dialog-pending';
    pendingNote.setAttribute('tabindex', '-1');
    pendingNote.setAttribute('aria-live', 'polite');
    form.appendChild(pendingNote);

    var actions = elem('div', 'dialog-actions');
    var cancelBtn = button('Cancel', null, 'Cancel and close this form');
    cancelBtn.id = 'dialog-cancel';
    cancelBtn.addEventListener('click', function () {
      if (inFlight) return;
      closeDialog('cancel');
    });
    var submitBtn = elem('button', spec.submitClass || 'primary', spec.submitLabel);
    submitBtn.type = 'submit';
    submitBtn.id = 'dialog-submit';
    if (spec.submitName) submitBtn.setAttribute('aria-label', spec.submitName);
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);
    inner.appendChild(form);
    dlg.appendChild(inner);

    var inputs = [];
    for (i = 0; i < spec.fields.length; i++) inputs.push(spec.fields[i].input);

    dialogState = {
      kind: spec.kind,
      opener: spec.opener || null,
      errorBox: errorBox,
      submitBtn: submitBtn,
      cancelBtn: cancelBtn,
      pendingNote: pendingNote,
      inputs: inputs,
      firstField: inputs.length > 0 ? inputs[0] : submitBtn,
      secretInput: spec.secretInput || null,
      // Reviewed values frozen at open time.
      gen: snapshot.stateGeneration,
      accountId: spec.accountId || null,
      accountVersion: spec.accountVersion === undefined ? null : spec.accountVersion,
      alias: spec.alias || null
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (inFlight) return;
      spec.onSubmit(dialogState);
    });
    dlg.addEventListener('keydown', onDialogKeydown);
    dlg.addEventListener('cancel', onDialogCancel);
    dlg.addEventListener('close', onDialogClose);
    // Focus the opener before showModal() so the dialog's own focus restoration
    // and the explicit restoration in closeDialog() agree on the same target,
    // however the control was activated (pointer, keyboard or programmatic).
    if (spec.opener && typeof spec.opener.focus === 'function') spec.opener.focus();
    dlg.showModal();
    dialogState.firstField.focus();
  }

  // ---- add account ------------------------------------------------------
  var ALIAS_HINT = '1 to 64 characters: letters, digits, dot, underscore or hyphen.';

  function openAddDialog(opener) {
    if (!canMutate()) return;
    var aliasF = textField('add-alias', 'Account alias', ALIAS_HINT);
    var secretF = secretField('add-secret', 'API key', 'The key is sent once and stored by GoRouter. It is never shown again.');
    openDialog({
      kind: 'add',
      title: 'Add account',
      opener: opener,
      bodyNodes: [],
      fields: [aliasF, secretF],
      submitLabel: 'Add account',
      submitName: 'Add this account',
      secretInput: secretF.input,
      onSubmit: function (st) {
        setDialogError('');
        setFieldError(aliasF, '');
        setFieldError(secretF, '');
        var alias = aliasF.input.value;
        var secret = secretF.input.value;
        var bad = false;
        if (!isValidAlias(alias)) { setFieldError(aliasF, 'Enter a valid alias. ' + ALIAS_HINT); bad = true; }
        if (secret.length === 0) { setFieldError(secretF, 'Enter the API key for this account.'); bad = true; }
        if (bad) {
          setDialogError('Check the highlighted fields and try again.');
          return;
        }
        var payload = JSON.stringify({ stateGeneration: st.gen, alias: alias, secret: secret });
        secret = '';
        secretF.input.value = '';
        sendMutation({ path: 'accounts/add', payload: payload, successText: 'Account added.' });
      }
    });
  }

  // ---- replace credential ----------------------------------------------
  function openReplaceDialog(account, opener) {
    if (!canMutate()) return;
    var secretF = secretField('replace-secret', 'New API key', 'The existing key is never shown. Entering a new key replaces it.');
    var lead = elem('p', null, 'Replace the stored credential for account ' + account.alias + '.');
    openDialog({
      kind: 'replace',
      title: 'Replace credential for ' + account.alias,
      opener: opener,
      bodyNodes: [lead],
      fields: [secretF],
      submitLabel: 'Replace credential',
      submitName: 'Replace credential for ' + account.alias,
      accountId: account.id,
      accountVersion: account.version,
      alias: account.alias,
      secretInput: secretF.input,
      onSubmit: function (st) {
        setDialogError('');
        setFieldError(secretF, '');
        var secret = secretF.input.value;
        if (secret.length === 0) {
          setFieldError(secretF, 'Enter the new API key.');
          setDialogError('Check the highlighted fields and try again.');
          return;
        }
        var payload = JSON.stringify({
          stateGeneration: st.gen,
          accountId: st.accountId,
          expectedAccountVersion: st.accountVersion,
          secret: secret
        });
        secret = '';
        secretF.input.value = '';
        sendMutation({ path: 'accounts/update', payload: payload, successText: 'Credential replaced.' });
      }
    });
  }

  // ---- rename -----------------------------------------------------------
  function openRenameDialog(account, opener) {
    if (!canMutate()) return;
    var aliasF = textField('rename-alias', 'New alias', ALIAS_HINT);
    aliasF.input.value = account.alias;
    var lead = elem('p', null, 'Rename account ' + account.alias + '.');
    openDialog({
      kind: 'rename',
      title: 'Rename ' + account.alias,
      opener: opener,
      bodyNodes: [lead],
      fields: [aliasF],
      submitLabel: 'Rename account',
      submitName: 'Rename account ' + account.alias,
      accountId: account.id,
      accountVersion: account.version,
      alias: account.alias,
      onSubmit: function (st) {
        setDialogError('');
        setFieldError(aliasF, '');
        var next = aliasF.input.value;
        if (!isValidAlias(next)) {
          setFieldError(aliasF, 'Enter a valid alias. ' + ALIAS_HINT);
          setDialogError('Check the highlighted fields and try again.');
          return;
        }
        if (next === st.alias) {
          setFieldError(aliasF, 'This is already the current alias.');
          setDialogError('Enter a different alias, or cancel.');
          return;
        }
        var payload = JSON.stringify({
          stateGeneration: st.gen,
          accountId: st.accountId,
          expectedAccountVersion: st.accountVersion,
          newAlias: next
        });
        sendMutation({ path: 'accounts/rename', payload: payload, successText: 'Account renamed.' });
      }
    });
  }

  // ---- remove -----------------------------------------------------------
  function openRemoveDialog(account, opener) {
    if (!canMutate()) return;
    if (account.usedBy.length > 0) return;
    var lead = elem('p', null, 'Remove the account ' + account.alias + ' and its stored credential from GoRouter?');
    var warn = elem('p', null, 'This cannot be undone from Web Control. A lane that later needs this account must be pointed at a different one.');
    openDialog({
      kind: 'remove',
      title: 'Remove ' + account.alias,
      opener: opener,
      bodyNodes: [lead, warn],
      fields: [],
      submitLabel: 'Remove ' + account.alias,
      submitClass: 'danger',
      submitName: 'Confirm removal of account ' + account.alias,
      accountId: account.id,
      accountVersion: account.version,
      alias: account.alias,
      onSubmit: function (st) {
        setDialogError('');
        var payload = JSON.stringify({
          stateGeneration: st.gen,
          accountId: st.accountId,
          expectedAccountVersion: st.accountVersion
        });
        sendMutation({ path: 'accounts/remove', payload: payload, successText: 'Account removed.' });
      }
    });
  }

  // ---- route mutations --------------------------------------------------
  function submitRouteSet(lane, accountId) {
    if (!canMutate()) return;
    if (!isStr(accountId) || accountId === '') return;
    var route = snapshot.routes[lane];
    if (accountId === route.accountId) return;
    var target = accountById(accountId);
    if (target === null || target.secretPresent !== true) return;
    var payload = JSON.stringify({
      stateGeneration: snapshot.stateGeneration,
      lane: lane,
      accountId: accountId,
      expectedRouteVersion: route.version,
      expectedTargetAccountVersion: target.version
    });
    sendMutation({ path: 'routes/set', payload: payload, successText: laneLabel(lane) + ' route updated.' });
  }

  function submitRouteClear(lane) {
    if (!canMutate()) return;
    var route = snapshot.routes[lane];
    if (route.accountId === null) return;
    var payload = JSON.stringify({
      stateGeneration: snapshot.stateGeneration,
      lane: lane,
      expectedRouteVersion: route.version
    });
    sendMutation({ path: 'routes/clear', payload: payload, successText: laneLabel(lane) + ' route cleared.' });
  }
`
