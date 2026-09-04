using System.Text.RegularExpressions;

namespace GoRouterDesktop;

/// <summary>
/// First-run onboarding (only shown when snapshot.firstRun): welcome →
/// local credential shown ONCE (copy button) → add first account → select
/// Go/Zen lanes → OMP note (documentation reference only, no config
/// mutation) → desktop.set firstRunDone:true. Existing configuration is
/// never overwritten: account.add / route.set are additive control-channel
/// operations and nothing else is touched.
/// </summary>
public sealed partial class FirstRunFlow : Form
{
    private const int StepCount = 5;

    private static readonly Regex AliasRegex = GeneratedAliasRegex();

    private readonly IControlChannel _channel;
    private ShellSnapshot _snapshot;

    private int _step;
    private int _accountsAdded;

    // One-time local credential shown on step 2: tracked so it can be scrubbed
    // from UI memory and taken back from the clipboard on close/expiry.
    private string? _shownCredential;
    private System.Windows.Forms.Timer? _credentialClipboardTimer;
    /// <summary>Credential value the clipboard timer is currently armed for
    /// (null when disarmed). Prevents repeated Copy clicks from extending the
    /// exposure window and lets Tick null the field before disposing, so a
    /// later Stop() can never touch a disposed instance.</summary>
    private string? _clipboardArmedFor;

    private readonly Panel _content = new() { Dock = DockStyle.Fill, Padding = new Padding(24, 16, 24, 8) };
    private readonly Label _lblStep = new() { AutoSize = true, AccessibleName = "Onboarding step indicator" };
    private readonly Label _lblError = new()
    {
        AutoSize = true,
        ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C),
        MaximumSize = new Size(500, 0),
        AccessibleName = "Onboarding error",
    };
    private readonly Button _btnBack = new() { Text = "Back", AccessibleName = "Previous onboarding step" };
    private readonly Button _btnNext = new() { Text = "Next", AccessibleName = "Next onboarding step" };
    private readonly Button _btnClose = new() { Text = "Close", AccessibleName = "Close onboarding" };

    public FirstRunFlow(IControlChannel channel, ShellSnapshot snapshot)
    {
        _channel = channel;
        _snapshot = snapshot;

        Text = "GoRouter Desktop — first run";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(580, 460);

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 34,
            ColumnCount = 1,
            RowCount = 1,
            Padding = new Padding(24, 6, 24, 0),
            AccessibleName = "Onboarding header",
        };
        header.Controls.Add(_lblStep, 0, 0);

        var footer = new TableLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 48,
            ColumnCount = 3,
            RowCount = 1,
            Padding = new Padding(24, 6, 24, 10),
            AccessibleName = "Onboarding navigation",
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        _btnBack.TabIndex = 0;
        _btnNext.TabIndex = 1;
        _btnClose.TabIndex = 2;
        _btnBack.Click += (_, _) => ShowStep(_step - 1);
        _btnNext.Click += async (_, _) => await OnNextAsync();
        _btnClose.Click += (_, _) =>
        {
            DialogResult = DialogResult.Cancel;
            Close();
        };

        footer.Controls.Add(_btnClose, 0, 0);
        footer.Controls.Add(_btnBack, 1, 0);
        footer.Controls.Add(_btnNext, 2, 0);

        Controls.Add(_content);
        Controls.Add(header);
        Controls.Add(footer);

        ShowStep(1);
    }

    /// <summary>Recursively clears every TextBox under a container. Required
    /// because credential boxes live nested in layout panels — a flat
    /// Controls.OfType&lt;TextBox&gt;() finds none of them.</summary>
    private static void ClearTextBoxes(Control.ControlCollection controls)
    {
        foreach (Control child in controls)
        {
            if (child is TextBox txt) txt.Clear();
            if (child.HasChildren) ClearTextBoxes(child.Controls);
        }
    }

    private static void DisposeControls(Control.ControlCollection controls)
    {
        // Snapshot first: Control.Dispose() removes the control from its
        // parent collection, invalidating a live enumerator (every ShowStep
        // after the first would throw InvalidOperationException).
        for (int i = controls.Count - 1; i >= 0; i--)
        {
            controls[i]?.Dispose();
        }
    }

    /// <summary>Stops the clipboard timer without firing it. Returns the
    /// credential value it was armed for (null when disarmed) so callers can
    /// take the text back immediately instead of stranding it.</summary>
    private string? DisarmCredentialClipboardTimer()
    {
        var timer = _credentialClipboardTimer;
        var armedFor = _clipboardArmedFor;
        _credentialClipboardTimer = null;
        _clipboardArmedFor = null;
        if (timer is not null)
        {
            try { timer.Stop(); } catch { /* already fired */ }
            timer.Dispose();
        }
        return armedFor;
    }

    private void ShowStep(int step)
    {
        _step = step;
        // Scrub on navigation, not just on close: leaving the credential step
        // must not keep the one-time secret in the undisposed controls, in
        // _shownCredential, or on the clipboard. Navigating away ends the
        // clipboard exposure window NOW (the close-time backstop below keys
        // off _shownCredential, which is nulled here — without this the text
        // would be stranded indefinitely). Best effort (managed strings
        // cannot be zeroed), so the close-scrub stays as a backstop.
        var clipboardArmedFor = DisarmCredentialClipboardTimer();
        if (clipboardArmedFor is not null)
        {
            try
            {
                if (Clipboard.ContainsText() && Clipboard.GetText() == clipboardArmedFor)
                {
                    Clipboard.Clear();
                }
            }
            catch
            {
                // Contention at the exact navigation click: the disarm killed
                // the timer that would have retried, so arm ONE short retry
                // retaining the value (same bounded shape as the clipboard
                // timer's own retry — no loop). A second contention strands
                // only until manual overwrite; vanishingly narrow, accepted.
                var outstanding = clipboardArmedFor;
                var retry = new System.Windows.Forms.Timer { Interval = 5_000 };
                retry.Tick += (_, _) =>
                {
                    if (ReferenceEquals(_credentialClipboardTimer, retry))
                    {
                        _credentialClipboardTimer = null;
                        _clipboardArmedFor = null;
                    }
                    retry.Stop();
                    retry.Dispose();
                    try
                    {
                        if (Clipboard.ContainsText() && Clipboard.GetText() == outstanding)
                        {
                            Clipboard.Clear();
                        }
                    }
                    catch { /* best effort only */ }
                };
                _credentialClipboardTimer = retry;
                _clipboardArmedFor = outstanding;
                retry.Start();
            }
        }
        ClearTextBoxes(_content.Controls);
        DisposeControls(_content.Controls);
        _shownCredential = null;
        _content.Controls.Clear();
        _lblStep.Text = $"Step {step} of {StepCount}";
        _btnBack.Enabled = step > 1;
        _btnNext.Visible = true;
        _btnNext.Text = step switch
        {
            4 => "Apply & continue",
            5 => "Finish",
            _ => "Next",
        };
        _lblError.Text = "";

        switch (step)
        {
            case 1: ShowWelcome(); break;
            case 2: ShowCredential(); break;
            case 3: ShowAddAccount(); break;
            case 4: ShowSelectLanes(); break;
            case 5: ShowOmpNote(); break;
        }
    }

    private async Task OnNextAsync()
    {
        switch (_step)
        {
            case 4:
                var ok = await ApplyLaneSelectionAsync();
                if (!ok)
                {
                    return;
                }

                ShowStep(5);
                break;

            case 5:
                await CompleteAsync();
                break;

            default:
                ShowStep(_step + 1);
                break;
        }
    }

    // ------------------------------------------------------------------
    // Step content
    // ------------------------------------------------------------------

    private void ShowWelcome()
    {
        var layout = NewStepLayout();

        var title = new Label
        {
            Text = "Welcome to GoRouter Desktop",
            Font = new Font(Font.FontFamily, 14f, FontStyle.Bold),
            AutoSize = true,
            AccessibleName = "Welcome title",
        };
        var body = new Label
        {
            Text = "Your local GoRouter state has been initialized and a local control credential was created for OMP. It is shown on the next step — once." +
                   Environment.NewLine + Environment.NewLine +
                   "Next you will add a provider account and choose which account serves the Go and Zen lanes.",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            AccessibleName = "Welcome text",
        };

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(body, 0, 1);
        _content.Controls.Add(layout);
    }

    private async void ShowCredential()
    {
        var layout = NewStepLayout();

        var title = new Label
        {
            Text = "Your local control credential",
            Font = new Font(Font.FontFamily, 12f, FontStyle.Bold),
            AutoSize = true,
            AccessibleName = "Local credential title",
        };
        var intro = new Label
        {
            Text = "OMP uses this credential to reach GoRouter. It is shown only once.",
            AutoSize = true,
            AccessibleName = "Local credential intro",
        };
        var txtCredential = new TextBox
        {
            ReadOnly = true,
            Width = 480,
            TabIndex = 0,
            UseSystemPasswordChar = true,
            AccessibleName = "Local control credential (shown once)",
        };
        var btnCopy = new Button
        {
            Text = "Copy",
            AutoSize = true,
            TabIndex = 1,
            AccessibleName = "Copy local control credential",
        };
        var warning = new Label
        {
            Text = $"Treat this like a password. OMP sends it only to 127.0.0.1:{_snapshot.Settings.Port}.",
            AutoSize = true,
            ForeColor = Color.FromArgb(0x8A, 0x53, 0x00),
            MaximumSize = new Size(520, 0),
            AccessibleName = "Local credential handling warning",
        };
        var status = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C),
            MaximumSize = new Size(520, 0),
            AccessibleName = "Local credential availability",
        };

        btnCopy.Click += (_, _) =>
        {
            if (txtCredential.Text.Length > 0)
            {
                try
                {
                    Clipboard.SetText(txtCredential.Text);
                }
                catch
                {
                    // Locked clipboard: report honestly instead of arming a
                    // clear for text that never landed.
                    status.Text = "Could not copy: the clipboard is busy. Try again.";
                    return;
                }
                btnCopy.Text = "Copied";
                ArmCredentialClipboardClear(txtCredential.Text);
            }
        };

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(intro, 0, 1);
        layout.Controls.Add(txtCredential, 0, 2);
        layout.Controls.Add(btnCopy, 0, 3);
        layout.Controls.Add(warning, 0, 4);
        layout.Controls.Add(status, 0, 5);
        _content.Controls.Add(layout);

        try
        {
            var response = await _channel.CallAsync("localCred.once", null, 10_000);
            // Stale-continuation guard: navigating away during the fetch
            // disposes/scrubs these controls — a late arrival must not write
            // the fresh secret into a disposed box or resurrect
            // _shownCredential after the navigation scrub nulled it.
            if (_step != 2 || txtCredential.IsDisposed || layout.IsDisposed)
            {
                return;
            }
            if (response.Ok && response.TryDataAs<LocalCredentialData>(out var data) && !string.IsNullOrEmpty(data?.Credential))
            {
                txtCredential.Text = data.Credential;
                _shownCredential = data.Credential;
            }
            else
            {
                status.Text = "The local credential is no longer available (the one-time window was already consumed). It can be regenerated from the CLI.";
                btnCopy.Enabled = false;
            }
        }
        catch (Exception ex)
        {
            // Same stale-continuation guard as the success path: a fetch that
            // rejects after navigation must not touch disposed controls from
            // this async void (ObjectDisposedException would escape unhandled
            // and crash the form over a transient pipe error).
            if (_step != 2 || status.IsDisposed || btnCopy.IsDisposed)
            {
                return;
            }
            status.Text = UiText.Truncate("Could not fetch the local credential: " + ex.Message);
            btnCopy.Enabled = false;
        }
    }

    private void ShowAddAccount()
    {
        var layout = NewStepLayout();

        var title = new Label
        {
            Text = "Add your first account",
            Font = new Font(Font.FontFamily, 12f, FontStyle.Bold),
            AutoSize = true,
            AccessibleName = "Add account title",
        };
        var lblAlias = new Label
        {
            Text = "Alias",
            AutoSize = true,
            AccessibleName = "Alias label",
        };
        var txtAlias = new TextBox
        {
            Width = 280,
            TabIndex = 0,
            AccessibleName = "Account alias",
        };
        var lblSecret = new Label
        {
            Text = "Secret",
            AutoSize = true,
            AccessibleName = "Secret label",
        };
        var txtSecret = new TextBox
        {
            Width = 280,
            PasswordChar = '●',
            TabIndex = 1,
            AccessibleName = "Provider secret — never shown again",
        };
        var btnAdd = new Button
        {
            Text = "Add account",
            AutoSize = true,
            TabIndex = 2,
            AccessibleName = "Add account",
        };
        var status = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            AccessibleName = "Add account feedback",
        };

        _btnNext.Enabled = _accountsAdded > 0;

        btnAdd.Click += async (_, _) =>
        {
            var alias = txtAlias.Text.Trim();
            var secret = txtSecret.Text;
            if (alias.Length == 0)
            {
                status.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
                status.Text = "Enter an alias.";
                return;
            }

            if (!AliasRegex.IsMatch(alias))
            {
                status.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
                status.Text = "Alias must match [A-Za-z0-9._-]{1,64}.";
                return;
            }

            if (secret.Length == 0)
            {
                status.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
                status.Text = "Enter the provider secret.";
                return;
            }

            btnAdd.Enabled = false;
            status.Text = "Adding account…";
            try
            {
                var response = await _channel.CallAsync("account.add", new { alias, secret }, 15_000);
                if (response.Ok)
                {
                    _accountsAdded++;
                    status.ForeColor = Color.FromArgb(0x1B, 0x5E, 0x20);
                    status.Text = $"Account '{alias}' added.";
                    _btnNext.Enabled = true;
                    txtAlias.Clear();
                    txtSecret.Clear();
                }
                else
                {
                    status.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
                    status.Text = response.ErrorMessage ?? "Add account failed.";
                }
            }
            catch (Exception ex)
            {
                status.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
                status.Text = UiText.Truncate("Add account failed: " + ex.Message);
            }
            finally
            {
                btnAdd.Enabled = true;
            }
        };

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(lblAlias, 0, 1);
        layout.Controls.Add(txtAlias, 0, 2);
        layout.Controls.Add(lblSecret, 0, 3);
        layout.Controls.Add(txtSecret, 0, 4);
        layout.Controls.Add(btnAdd, 0, 5);
        layout.Controls.Add(status, 0, 6);
        _content.Controls.Add(layout);
    }

    private void ShowSelectLanes()
    {
        var layout = NewStepLayout();

        var title = new Label
        {
            Text = "Choose the account for each lane",
            Font = new Font(Font.FontFamily, 12f, FontStyle.Bold),
            AutoSize = true,
            AccessibleName = "Lane selection title",
        };

        var cmbGo = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Width = 300,
            TabIndex = 0,
            AccessibleName = "GO lane account selection",
        };
        var cmbZen = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Width = 300,
            TabIndex = 1,
            AccessibleName = "ZEN lane account selection",
        };
        FillLaneCombo(cmbGo, _snapshot.Routes.Go, _snapshot);
        FillLaneCombo(cmbZen, _snapshot.Routes.Zen, _snapshot);

        var note = new Label
        {
            Text = "New requests use the selected account; in-flight requests keep their original route. You can change this anytime from the tray or the control center.",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            AccessibleName = "Lane selection note",
        };

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(new Label { Text = "GO", AutoSize = true, AccessibleName = "GO label" }, 0, 1);
        layout.Controls.Add(cmbGo, 0, 2);
        layout.Controls.Add(new Label { Text = "ZEN", AutoSize = true, AccessibleName = "ZEN label" }, 0, 3);
        layout.Controls.Add(cmbZen, 0, 4);
        layout.Controls.Add(note, 0, 5);
        _content.Controls.Add(layout);
    }

    private async Task<bool> ApplyLaneSelectionAsync()
    {
        var combos = _content.Controls.OfType<ComboBox>().ToList();
        var cmbGo = combos.FirstOrDefault(c => c.AccessibleName?.StartsWith("GO", StringComparison.Ordinal) == true);
        var cmbZen = combos.FirstOrDefault(c => c.AccessibleName?.StartsWith("ZEN", StringComparison.Ordinal) == true);

        string? error = null;
        if (cmbGo is not null)
        {
            error = await ApplyLaneAsync("go", cmbGo, _snapshot.Routes.Go) ?? error;
        }

        if (cmbZen is not null)
        {
            error = await ApplyLaneAsync("zen", cmbZen, _snapshot.Routes.Zen) ?? error;
        }

        if (error is not null)
        {
            _lblError.Text = error;
            return false;
        }

        _snapshot = _channel.Snapshot ?? _snapshot;
        return true;
    }

    private async Task<string?> ApplyLaneAsync(string lane, ComboBox cmb, SnapshotRoute current)
    {
        var option = cmb.SelectedItem as AccountOption;
        var accountId = option?.Id;
        if (accountId == current.AccountId)
        {
            return null;
        }

        try
        {
            var response = accountId is null
                ? await _channel.CallAsync("route.clear", new { lane })
                : await _channel.CallAsync("route.set", new { lane, accountId });
            return response.Ok ? null : (response.ErrorMessage ?? "Route change failed.");
        }
        catch (Exception ex)
        {
            // Returned to a status label upstream: cap before crossing.
            return UiText.Truncate(ex.Message);
        }
    }

    private void ShowOmpNote()
    {
        var layout = NewStepLayout();

        var title = new Label
        {
            Text = "Connect OMP",
            Font = new Font(Font.FontFamily, 12f, FontStyle.Bold),
            AutoSize = true,
            AccessibleName = "OMP note title",
        };
        var body = new Label
        {
            Text = $"OMP reaches GoRouter through http://127.0.0.1:{_snapshot.Settings.Port} using the local credential shown earlier. " +
                   "The exact configuration steps are documented in docs/omp-integration.md (repository documentation).",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            AccessibleName = "OMP note text",
        };
        var note = new Label
        {
            Text = "GoRouter Desktop does not modify your OMP or OpenCode configuration. Everything on this screen is informational.",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            AccessibleName = "OMP note disclaimer",
        };

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(body, 0, 1);
        layout.Controls.Add(note, 0, 2);
        _content.Controls.Add(layout);
    }

    private TableLayoutPanel NewStepLayout()
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 8,
            AutoScroll = true,
            AccessibleName = "Onboarding step content",
        };
        for (var i = 0; i < 8; i++)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        layout.Controls.Add(_lblError, 0, 7);
        return layout;
    }

    private async Task CompleteAsync()
    {
        _btnNext.Enabled = false;
        try
        {
            var response = await _channel.CallAsync("desktop.set", new { firstRunDone = true }, 10_000);
            if (!response.Ok)
            {
                // the snapshot keeps firstRun true; keep the dialog open so the
                // completion is not silently lost (PS-04)
                _lblError.Text = "Could not finish setup: " + (response.ErrorMessage ?? "control service did not save the change");
                _lblError.Visible = true;
                _btnNext.Enabled = true;
                return;
            }
        }
        catch (Exception ex)
        {
            _lblError.Text = UiText.Truncate("Could not finish setup: " + ex.Message);
            _lblError.Visible = true;
            _btnNext.Enabled = true;
            return;
        }

        DialogResult = DialogResult.OK;
        Close();
    }

    private static void FillLaneCombo(ComboBox cmb, SnapshotRoute route, ShellSnapshot snapshot)
    {
        var options = ShellSnapshot.LaneOptions(snapshot, route, out var selectedIndex);
        cmb.Items.Clear();
        foreach (var option in options)
        {
            cmb.Items.Add(option);
        }

        if (selectedIndex >= 0 && selectedIndex < cmb.Items.Count)
        {
            cmb.SelectedIndex = selectedIndex;
        }
    }

    /// <summary>Takes the one-time credential back from the shared clipboard
    /// after a short window — but only if the clipboard still holds our exact
    /// text, so content the user copied afterwards is never clobbered. Armed
    /// once per credential value: repeated Copy clicks do not extend the
    /// exposure window.</summary>
    private void ArmCredentialClipboardClear(string credential)
    {
        if (_clipboardArmedFor == credential && _credentialClipboardTimer is not null)
        {
            return; // already armed for this value; do not extend the window
        }
        var prev = _credentialClipboardTimer;
        _credentialClipboardTimer = null;
        _clipboardArmedFor = null;
        if (prev is not null)
        {
            // prev is either live (Stop is safe) or already fired-and-nulled
            // (never a disposed instance: Tick nulls the field first).
            try { prev.Stop(); } catch { /* already disposed */ }
            prev.Dispose();
        }
        var timer = new System.Windows.Forms.Timer { Interval = 10_000 };
        timer.Tick += (_, _) =>
        {
            if (ReferenceEquals(_credentialClipboardTimer, timer))
            {
                _credentialClipboardTimer = null;
                _clipboardArmedFor = null;
            }
            timer.Stop();
            timer.Dispose();
            try
            {
                if (Clipboard.ContainsText() && Clipboard.GetText() == credential)
                {
                    Clipboard.Clear();
                }
            }
            catch
            {
                // Clipboard contention: one short retry instead of leaving the
                // credential indefinitely. Retry only if the user has not
                // armed a newer value since.
                if (_credentialClipboardTimer is null)
                {
                    var retry = new System.Windows.Forms.Timer { Interval = 5_000 };
                    retry.Tick += (_, _) =>
                    {
                        if (ReferenceEquals(_credentialClipboardTimer, retry))
                        {
                            _credentialClipboardTimer = null;
                            _clipboardArmedFor = null;
                        }
                        retry.Stop();
                        retry.Dispose();
                        try
                        {
                            if (Clipboard.ContainsText() && Clipboard.GetText() == credential)
                            {
                                Clipboard.Clear();
                            }
                        }
                        catch { /* best effort only */ }
                    };
                    _credentialClipboardTimer = retry;
                    // Keep the armed value so navigation-away can still take
                    // the text back during the retry window.
                    _clipboardArmedFor = credential;
                    retry.Start();
                }
            }
        };
        _credentialClipboardTimer = timer;
        _clipboardArmedFor = credential;
        timer.Start();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Use the disarmed value: after a navigation the timer/retry is the
        // sole owner of the credential (_shownCredential was nulled), so a
        // close inside the retry window must attempt the take-back itself.
        var disarmedFor = DisarmCredentialClipboardTimer();

        // Clear every TextBox recursively and unconditionally: the one-time
        // credential box lives nested in a layout panel, so a flat control
        // enumeration misses it — and a password-only filter misses it because
        // it is read-only, not masked.
        ClearTextBoxes(_content.Controls);

        // Take the credential back from the clipboard if it is still ours —
        // via the shown value or the disarmed timer/retry value (navigation
        // may have nulled the former while arming the latter).
        var takeBack = _shownCredential ?? disarmedFor;
        try
        {
            if (takeBack is not null && Clipboard.ContainsText() && Clipboard.GetText() == takeBack)
            {
                Clipboard.Clear();
            }
        }
        catch
        {
            // Best effort only: on contention the credential simply stays
            // on the clipboard, as before.
        }
        finally
        {
            _shownCredential = null;
        }

        base.OnFormClosing(e);
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$")]
    private static partial Regex GeneratedAliasRegex();
}
