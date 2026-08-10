using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GoRouterDesktop;

/// <summary>
/// Test-only UX evidence driver: renders the control center (or a dialog /
/// onboarding step) offscreen with an injected snapshot and writes
/// &lt;outDir&gt;/&lt;state&gt;.png (PrintWindow PW_RENDERFULLCONTENT — DrawToBitmap
/// renders only the unpainted background for themed WinForms controls) plus
/// &lt;outDir&gt;/&lt;state&gt;.a11y.txt (accessibility names, roles, tab order, control
/// types). Exits 0 on success. Never connects to a real control service.
/// </summary>
internal static class Selftest
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    /// <summary>Captures the real rendered window content (children included).</summary>
    private static Bitmap CaptureWindow(Form form)
    {
        var bmp = new Bitmap(form.Width, form.Height);
        using var g = Graphics.FromImage(bmp);
        var hdc = g.GetHdc();
        try
        {
            PrintWindow(form.Handle, hdc, 0x2); // PW_RENDERFULLCONTENT
        }
        finally
        {
            g.ReleaseHdc(hdc);
        }

        return bmp;
    }
    public static int Run(string[] args)
    {
        NativeDpi.SetPerMonitorV2();
        ApplicationConfiguration.Initialize();

        var state = "empty";
        string? snapshotFile = null;
        (int Width, int Height)? requestedSize = null;
        (int Width, int Height)? requestedClientSize = null;
        float? dpiScale = null;
        var positional = new List<string>();

        for (var i = 1; i < args.Length; i++)
        {
            if (args[i] == "--state" && i + 1 < args.Length)
            {
                state = args[++i];
                continue;
            }

            if (args[i] == "--snapshot" && i + 1 < args.Length)
            {
                snapshotFile = args[++i];
                continue;
            }

            if (args[i] == "--size")
            {
                if (i + 1 >= args.Length)
                {
                    return Fail("Invalid --size: expected <width>x<height> with positive integers.", args);
                }

                var sizeArg = args[++i];
                if (!TryParseSize(sizeArg, out var width, out var height))
                {
                    return Fail($"Invalid --size '{sizeArg}': expected <width>x<height> with positive integers.", args);
                }

                requestedSize = (width, height);
                continue;
            }

            if (args[i] == "--client-size")
            {
                if (i + 1 >= args.Length)
                {
                    return Fail("Invalid --client-size: expected <width>x<height> with positive integers.", args);
                }

                var sizeArg = args[++i];
                if (!TryParseSize(sizeArg, out var width, out var height))
                {
                    return Fail($"Invalid --client-size '{sizeArg}': expected <width>x<height> with positive integers.", args);
                }

                requestedClientSize = (width, height);
                continue;
            }

            if (args[i] == "--dpi-scale")
            {
                if (i + 1 >= args.Length)
                {
                    return Fail("Invalid --dpi-scale: expected a positive decimal factor (e.g. 1.5).", args);
                }

                var scaleArg = args[++i];
                if (!float.TryParse(
                        scaleArg,
                        NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite,
                        CultureInfo.InvariantCulture,
                        out var scale)
                    || !float.IsFinite(scale)
                    || scale <= 0f)
                {
                    return Fail($"Invalid --dpi-scale '{scaleArg}': expected a positive decimal factor (e.g. 1.5).", args);
                }

                dpiScale = scale;
                continue;
            }

            if (args[i] == "--transition-test")
            {
                // Handled after form creation
                continue;
            }
            if (args[i].StartsWith("--", StringComparison.Ordinal))
            {
                return Fail($"Unknown option: {args[i]}", args);
            }

            positional.Add(args[i]);
        }

        if (positional.Count != 1)
        {
            return Fail(
                "Usage: GoRouterDesktop --selftest <outDir> [--state empty|configured|degraded|stopped|error|confirm|firstrun|longalias|switched|attached|portconflict] [--size <width>x<height>] [--dpi-scale <factor>] [--snapshot <json-file>]",
                args);
        }

        var outDir = positional[0];
        var outputName = state;

        ShellSnapshot snapshot;
        if (snapshotFile is not null)
        {
            outputName = "custom";
            try
            {
                snapshot = JsonSerializer.Deserialize<ShellSnapshot>(File.ReadAllText(snapshotFile), JsonDefaults.Options) ?? ShellSnapshot.Empty;
            }
            catch (Exception ex)
            {
                return Fail($"Could not parse --snapshot file: {ex.Message}", args);
            }
        }
        else
        {
            snapshot = SyntheticSnapshot(state);
        }

        Directory.CreateDirectory(outDir);
        var pngPath = Path.Combine(outDir, outputName + ".png");
        var a11yPath = Path.Combine(outDir, outputName + ".a11y.txt");

        Form form = state switch
        {
            "confirm" => new ConfirmDialog("Remove account", "Remove account 'demo' and its stored credential? The lane selection will be cleared.", "Remove account"),
            "firstrun" => new FirstRunFlow(new StubChannel(snapshot, state), snapshot),
            _ => new ControlCenterForm(new StubChannel(snapshot, state)),
        };

        if (requestedSize is { } size)
        {
            // Outer form size, applied after construction and before capture:
            // the PrintWindow bitmap is exactly width x height. The form's own
            // minimum (control center: 800x560) still applies.
            form.Size = new Size(size.Width, size.Height);
        }

        if (dpiScale is { } dpiFactor)
        {
            // Test-only high-DPI evidence: Scale() multiplies the final
            // binary's fixed shell metrics so the PNG shows deterministic
            // DPI-rescaled layout from the same binary. Offline only — the
            // product keeps PerMonitorV2 system scaling and never calls
            // Scale() itself.
            form.Scale(new SizeF(dpiFactor, dpiFactor));
        }

        try
        {
            form.Show();
            Pump();
            form.Refresh();
            Pump();

            // Client-area size is applied after Show: the responsive reflow is
            // Resize/Shown-driven and a pre-Show size assignment does not reach
            // the layout pass, so resizing the visible form is the deterministic
            // path (identical to the in-process transition test).
            if (requestedClientSize is { } clientSize)
            {
                form.ClientSize = new Size(clientSize.Width, clientSize.Height);
                Pump();
            }

            // Settle: async snapshot application must finish before capture, and
            // the rendered state badge must match the requested state — a
            // capture race fails loudly instead of producing stale evidence.
            if (form is ControlCenterForm ccfForm)
            {
                for (var i = 0; i < 20 && !ccfForm.RenderedStateMatches(snapshot); i++)
                {
                    Application.DoEvents();
                    Thread.Sleep(50);
                }

                if (!ccfForm.RenderedStateMatches(snapshot))
                {
                    return Fail(
                        $"selftest render mismatch: badge '{ccfForm.StateBadgeText}' vs expected '{RouterStateText(snapshot)}'",
                        args);
                }

                if (state is "switched" or "routeconfirm")
                {
                    // Offline evidence: render the exact post-success wording
                    // via the test-only helper — no channel call, no runtime
                    // state mutation, no provider traffic.
                    ccfForm.SetSelftestRouteConfirmation("go", snapshot.Routes.Go.Alias ?? "alpha");
                    form.Refresh();
                    Pump();
                }
            }

            if (args.Contains("--transition-test") && form is ControlCenterForm ccf)
            {
                return RunTransitionTest(outDir, ccf);
            }

            using var bitmap = CaptureWindow(form);
            bitmap.Save(pngPath, ImageFormat.Png);

            var sb = new StringBuilder();
            DumpAccessibility(form, sb, 0);
            File.WriteAllText(a11yPath, sb.ToString(), new UTF8Encoding(false));

            Console.WriteLine($"selftest {outputName}: wrote {pngPath}");
            Console.WriteLine($"selftest {outputName}: wrote {a11yPath}");
            return 0;
        }
        catch (Exception ex)
        {
            return Fail($"selftest failed: {ex.Message}", args);
        }
        finally
        {
            form.Dispose();
            Pump();
        }
    }

    private static string RouterStateText(ShellSnapshot snapshot)
    {
        var state = snapshot.Router.State switch
        {
            "running" => "Running",
            "degraded" => "Degraded",
            "starting" => "Starting",
            "stopped" => "Stopped",
            "port_conflict" => "Port conflict",
            "failed" => "Failed",
            _ => snapshot.Router.State,
        };
        var mode = snapshot.Router.Mode switch
        {
            "attached" => "attached",
            "managed" => "managed",
            _ => "",
        };
        return mode.Length > 0 ? $"{state} ({mode})" : state;
    }

    private static void Pump()
    {
        Application.DoEvents();
        Thread.Sleep(60);
        Application.DoEvents();
    }

    private static int Fail(string message, string[] args)
    {
        Console.Error.WriteLine(message);
        Console.Error.WriteLine("Usage: GoRouterDesktop --selftest <outDir> [--state empty|configured|degraded|stopped|error|confirm|firstrun|longalias|switched|attached|portconflict] [--size <width>x<height>] [--dpi-scale <factor>] [--snapshot <json-file>]");
        return 1;
    }

    /// <summary>Parses "&lt;width&gt;x&lt;height&gt;" with positive integer parts.</summary>
    private static bool TryParseSize(string value, out int width, out int height)
    {
        width = 0;
        height = 0;
        var parts = value.Split('x');
        if (parts.Length != 2)
        {
            return false;
        }

        return int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out width)
            && int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out height)
            && width > 0
            && height > 0;
    }

    private static ShellSnapshot SyntheticSnapshot(string state)
    {
        var now = DateTime.UtcNow.ToString("o");
        var alpha = new SnapshotAccount
        {
            Id = "acct_alpha",
            Alias = "alpha",
            SecretPresent = true,
            UsedBy = new[] { "go" },
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };
        var beta = new SnapshotAccount
        {
            Id = "acct_beta",
            Alias = "beta",
            SecretPresent = true,
            UsedBy = new[] { "zen" },
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };

        // Demo-only truncation evidence: aliases are syntactically valid
        // ([A-Za-z0-9._-]{1,64}, exactly 64 chars) but long enough that the
        // lane ComboBoxes and the Accounts list must clip them.
        var longGo = new SnapshotAccount
        {
            Id = "acct_longalias_go",
            Alias = "go-lane.production-accounts.very-long-alias-for-truncation-check",
            SecretPresent = true,
            UsedBy = new[] { "go" },
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };
        var longZen = new SnapshotAccount
        {
            Id = "acct_longalias_zen",
            Alias = "zen-lane.production-account.very-long-alias-for-truncation-check",
            SecretPresent = true,
            UsedBy = new[] { "zen" },
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
        };

        return state switch
        {
            "empty" => Make(
                routerState: "stopped", routerMode: "none", pid: 0,
                accounts: Array.Empty<SnapshotAccount>()),

            "configured" => Make(
                routerState: "running", routerMode: "managed", pid: 4242,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),

            "degraded" => Make(
                routerState: "degraded", routerMode: "managed", pid: 4242,
                accounts: new[] { alpha, beta }, goRoute: true, journalDegraded: true),

            "stopped" => Make(
                routerState: "stopped", routerMode: "none", pid: 0,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),

            "error" => Make(
                routerState: "failed", routerMode: "none", pid: 0,
                accounts: new[] { alpha }, goRoute: true, corrupt: true, secretStore: "unavailable"),

            "firstrun" => Make(
                routerState: "stopped", routerMode: "none", pid: 0,
                accounts: Array.Empty<SnapshotAccount>(), firstRun: true),

            "longalias" => Make(
                routerState: "running", routerMode: "managed", pid: 4242,
                accounts: new[] { longGo, longZen }, goRoute: true, zenRoute: true),

            // Demo-only post-switch evidence: same configured accounts/routes
            // as "configured"; the selftest driver then renders the exact
            // post-success confirmation wording through the test-only helper.
            "switched" or "routeconfirm" => Make(
                routerState: "running", routerMode: "managed", pid: 4242,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),

            // Demo-only attached evidence: the router runs under an external
            // process, so Start/Stop are not offered (not stoppable/manageable).
            "attached" => Make(
                routerState: "running", routerMode: "attached", pid: 9876,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),

            // Demo-only port-conflict evidence: the router cannot bind, so
            // Start/Stop are not offered (router.start is a silent no-op there).
            "portconflict" => Make(
                routerState: "port_conflict", routerMode: "managed", pid: 0,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),

            _ => Make(
                routerState: "running", routerMode: "managed", pid: 4242,
                accounts: new[] { alpha, beta }, goRoute: true, zenRoute: true),
        };
    }

    private static ShellSnapshot Make(
        string routerState,
        string routerMode,
        int pid,
        SnapshotAccount[] accounts,
        bool goRoute = false,
        bool zenRoute = false,
        bool firstRun = false,
        bool corrupt = false,
        string secretStore = "ok",
        bool journalDegraded = false)
    {
        var now = DateTime.UtcNow.ToString("o");
        return new ShellSnapshot
        {
            ServiceVersion = "1.5.0",
            Initialized = true,
            FirstRun = firstRun,
            StateCorrupt = corrupt,
            SecretStore = secretStore,
            Settings = new SnapshotSettings { Port = 8787, JournalRetentionDays = 30, JournalMaxRecords = 100000 },
            Routes = new SnapshotRoutes
            {
                Go = new SnapshotRoute
                {
                    AccountId = goRoute ? accounts.FirstOrDefault(a => a.UsedBy.Contains("go", StringComparer.OrdinalIgnoreCase))?.Id : null,
                    Alias = goRoute ? accounts.FirstOrDefault(a => a.UsedBy.Contains("go", StringComparer.OrdinalIgnoreCase))?.Alias : null,
                },
                Zen = new SnapshotRoute
                {
                    AccountId = zenRoute ? accounts.FirstOrDefault(a => a.UsedBy.Contains("zen", StringComparer.OrdinalIgnoreCase))?.Id : null,
                    Alias = zenRoute ? accounts.FirstOrDefault(a => a.UsedBy.Contains("zen", StringComparer.OrdinalIgnoreCase))?.Alias : null,
                },
            },
            Accounts = accounts,
            Router = new SnapshotRouter
            {
                State = routerState,
                Mode = routerMode,
                Pid = pid,
                Port = 8787,
                RestartCount = routerState == "degraded" ? 3 : 0,
            },
            Journal = new SnapshotJournal
            {
                SchemaVersion = 1,
                Records = journalDegraded ? 0 : 5,
                OldestRecordAtUtc = now,
                NewestRecordAtUtc = now,
                Degraded = journalDegraded,
                LastError = journalDegraded ? "SQLITE_BUSY: database is locked" : null,
                RetentionDays = 30,
                MaxRecords = 100000,
            },
            Desktop = new SnapshotDesktop { StartAtLogin = false, MinimizeToTray = true },
            StateDir = @"C:\Users\demo\AppData\Local\GoRouter",
            LocalCredentialConfigured = true,
        };
    }

    private static void DumpAccessibility(Control control, StringBuilder sb, int depth)
    {
        var pad = new string(' ', depth * 2);
        var text = control.Text.Replace("\r", " ").Replace("\n", " ");
        if (text.Length > 80)
        {
            text = text.Substring(0, 80) + "…";
        }

        sb.AppendLine(
            $"{pad}{control.GetType().Name} | Name='{control.Name}' AccName='{control.AccessibleName}' " +
            $"AccDesc='{control.AccessibleDescription}' Role={control.AccessibleRole} Tab={control.TabIndex} Text='{text}'");

        if (control is ListView listView)
        {
            var columns = string.Join(" | ", listView.Columns.Cast<ColumnHeader>().Select(c => c.Text));
            sb.AppendLine($"{pad}  Columns: {columns}");
        }

        foreach (Control child in control.Controls)
        {
            DumpAccessibility(child, sb, depth + 1);
        }
    }

    private static int RunTransitionTest(string outDir, ControlCenterForm ccfForm)
    {
        var results = new List<string>();
        var failures = new List<string>();

        void Check(bool condition, string message)
        {
            if (!condition)
                failures.Add(message);
            results.Add(condition ? "  PASS: " + message : "  FAIL: " + message);
        }

        void Log(string msg) => results.Add("  " + msg);

        var form = ccfForm.FindForm() ?? throw new InvalidOperationException("Form not found");

        // Wide/narrow/wide/narrow/wide alternation plus the exact 899/900/901
        // boundary — all in client pixels (the width the reflow reads).
        var sequence = new[] { 920, 880, 920, 880, 920, 899, 900, 901, 920 };

        results.Add("=== TRANSITION TEST ===");
        results.Add("");

        for (var step = 0; step < sequence.Length; step++)
        {
            var clientWidth = sequence[step];
            var expectNarrow = clientWidth < 900;
            var mode = expectNarrow ? "narrow" : "wide";

            results.Add($"--- Step {step + 1}: client={clientWidth}px expect={mode} ---");

            form.ClientSize = new Size(clientWidth, 660);
            Application.DoEvents();
            Pump();

            // Status band: present, visible, non-collapsed, and the mode must
            // actually have switched (band.Height 72 narrow / 52 wide).
            var band = FindAllControls(ccfForm, "Status bar").FirstOrDefault();
            Check(band != null, "Status bar found");
            if (band != null)
            {
                Check(band.Visible, "Status bar visible");
                Check(band.Height > 0, $"Status bar height={band.Height} (non-zero)");
                Check(band.Height == (expectNarrow ? 72 : 52), $"Status bar height={band.Height} matches {mode} mode");
            }

            // Required identity/status/lifecycle controls: exactly one each,
            // parented, visible, with accessible text.
            var required = new[]
            {
                "GoRouter Desktop",
                "Router state indicator",
                "Router state",
                "Router port",
                "Desktop version",
                "Stop router",
                "Start router",
            };
            foreach (var name in required)
            {
                var all = FindAllControls(ccfForm, name);
                Check(all.Count == 1, $"{name} present exactly once ({all.Count})");
                var ctrl = all.FirstOrDefault();
                if (ctrl != null)
                {
                    Check(ctrl.Parent != null, $"{name} has parent");
                    Check(ctrl.Visible, $"{name} visible");
                    Check(!string.IsNullOrEmpty(ctrl.AccessibleName), $"{name} has accessible name");
                    Log($"  {name}: Parent={ctrl.Parent?.GetType().Name} Bounds={ctrl.Bounds} TabIndex={ctrl.TabIndex}");
                }
            }

            // No duplicates by identity text anywhere in the tree.
            var identityLabels = FindAllControls(ccfForm, "GoRouter Desktop");
            Check(identityLabels.Count == 1, $"identity label count={identityLabels.Count}");

            // No orphans: every reachable non-root control has a parent, and
            // every required control lives inside this form's tree.
            var unparented = 0;
            void Walk(Control c)
            {
                if (c != ccfForm && c.Parent == null) unparented++;
                foreach (Control child in c.Controls) Walk(child);
            }
            Walk(ccfForm);
            Check(unparented == 0, $"unparented controls={unparented}");
            foreach (var name in required)
            {
                var ctrl = FindAllControls(ccfForm, name).FirstOrDefault();
                if (ctrl != null)
                    Check(ctrl.FindForm() == form, $"{name} inside form tree");
            }

            // No overlap among the status controls (screen-space pairwise check;
            // Bounds are parent-relative so RectangleToScreen is required).
            var statusControls = required
                .Select(n => FindAllControls(ccfForm, n).FirstOrDefault())
                .Where(c => c != null)
                .ToList();
            var screenRects = statusControls
                .Select(c => c!.RectangleToScreen(c.ClientRectangle))
                .ToList();
            var overlaps = 0;
            for (var a = 0; a < screenRects.Count; a++)
            {
                for (var b = a + 1; b < screenRects.Count; b++)
                {
                    if (screenRects[a].IntersectsWith(screenRects[b]))
                        overlaps++;
                }
            }
            Check(overlaps == 0, $"overlapping status controls={overlaps}");

            // No clipping: port label fully inside the band (screen space).
            if (band != null)
            {
                var port = FindAllControls(ccfForm, "Router port").FirstOrDefault();
                if (port != null)
                {
                    var portRect = port.RectangleToScreen(port.ClientRectangle);
                    var bandRect = band.RectangleToScreen(band.ClientRectangle);
                    Check(portRect.Width > 0 && portRect.Height > 0, "port label has non-zero size");
                    Check(portRect.Left >= bandRect.Left && portRect.Right <= bandRect.Right + 1
                        && portRect.Top >= bandRect.Top && portRect.Bottom <= bandRect.Bottom + 1,
                        $"port label inside band (port={portRect} band={bandRect})");
                }
            }

            Log("");
        }

        // Keyboard accessibility: declared focus order for focusable controls.
        results.Add("--- Keyboard Accessibility ---");
        var focusable = FindAllControls(ccfForm, null)
            .Where(c => c.TabStop && c.Visible && c.Enabled)
            .OrderBy(c => c.TabIndex)
            .ToList();
        foreach (var c in focusable)
            results.Add($"  TabIndex={c.TabIndex} {c.AccessibleName ?? c.GetType().Name}");
        var startBtn = FindAllControls(ccfForm, "Start router").FirstOrDefault();
        var stopBtn = FindAllControls(ccfForm, "Stop router").FirstOrDefault();
        if (startBtn != null && stopBtn != null)
        {
            Check(startBtn.TabStop && stopBtn.TabStop, "Start/Stop buttons are TabStop");
            Check(startBtn.TabIndex < stopBtn.TabIndex, $"Start (Tab={startBtn.TabIndex}) precedes Stop (Tab={stopBtn.TabIndex})");
        }
        var identityCtrl = FindAllControls(ccfForm, "GoRouter Desktop").FirstOrDefault();
        var portCtrl = FindAllControls(ccfForm, "Router port").FirstOrDefault();
        Check(identityCtrl != null && !string.IsNullOrEmpty(identityCtrl.AccessibleName), "identity accessible name present");
        Check(portCtrl != null && !string.IsNullOrEmpty(portCtrl.AccessibleName), "port accessible name present");

        results.Add("");
        if (failures.Count == 0)
            results.Add("=== ALL CHECKS PASSED ===");
        else
        {
            results.Add($"=== {failures.Count} FAILURES ===");
            foreach (var f in failures)
                results.Add("  FAILURE: " + f);
        }

        var summaryFile = Path.Combine(outDir, "transition-summary.txt");
        File.WriteAllText(summaryFile, string.Join("\n", results));
        Console.WriteLine(string.Join("\n", results));
        return failures.Count == 0 ? 0 : 1;
    }

    private static List<Control> FindAllControls(Control root, string? accessibleName)
    {
        var result = new List<Control>();
        if (accessibleName is null || root.AccessibleName == accessibleName)
            result.Add(root);
        foreach (Control child in root.Controls)
            result.AddRange(FindAllControls(child, accessibleName));
        return result;
    }

    /// <summary>Offline channel for selftest rendering; no pipe, no tokens.</summary>
#pragma warning disable CS0067 // events satisfy the interface; never raised by the stub
    private sealed class StubChannel : IControlChannel
    {
        private readonly ShellSnapshot _snapshot;
        private readonly string _state;

        public StubChannel(ShellSnapshot snapshot, string state)
        {
            _snapshot = snapshot;
            _state = state;
        }

        public ShellSnapshot? Snapshot => _snapshot;
        public ClientState State => ClientState.Connected;
        public string? LastError => null;

        public event Action<ShellSnapshot>? SnapshotReceived;
        public event Action<ClientState>? StateChanged;

        public Task<ControlResponse> CallAsync(string op, object? parameters = null, int timeoutMs = 60_000, CancellationToken ct = default)
        {
            var data = op switch
            {
                "localCred.once" => "{\"credential\":\"selftest-local-credential-not-a-real-secret\"}",
                "journal.recent" => JournalRecentData(),
                _ => "{}",
            };
            var response = ControlResponse.FromJson(
                JsonDocument.Parse("{\"id\":1,\"ok\":true,\"data\":" + data + "}").RootElement);
            return Task.FromResult(response);
        }

        /// <summary>
        /// Deterministic offline journal.recent payload for visual evidence.
        /// Rows appear ONLY for the explicit populated evidence states; the
        /// empty/first-run/error states render the designed empty note, and
        /// the degraded state renders the degraded banner. Row timestamps are
        /// anchored to the synthetic snapshot's own journal timestamp (no
        /// second UtcNow clock), and every field is demo-only safe data.
        /// </summary>
        private string JournalRecentData()
        {
            if (_snapshot.Journal.Degraded)
            {
                return "{\"rows\":[],\"degraded\":true,\"error\":\"SQLITE_BUSY: database is locked\"}";
            }

            var populated = _state is "configured" or "switched" or "routeconfirm" or "longalias" or "attached" or "portconflict";
            if (!populated || _snapshot.Accounts.Count == 0)
            {
                return "{\"rows\":[],\"degraded\":false,\"error\":null}";
            }

            // Anchor every row to the snapshot's synthetic journal timestamp
            // so the preview and the Journal statistics agree within the run.
            var newest = DateTimeOffset.TryParse(_snapshot.Journal.NewestRecordAtUtc, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var anchor)
                ? anchor
                : DateTimeOffset.UtcNow.AddMinutes(-18);
            var lanes = new[] { "go", "zen" };
            var accounts = _snapshot.Accounts;
            var rows = new List<string>(3);
            for (var i = 0; i < 3; i++)
            {
                var lane = lanes[i % 2];
                var account = accounts[i % accounts.Count];
                var method = i % 2 == 0 ? "completions" : "responses";
                var started = newest.AddMinutes(-(4 - i) * 4);
                rows.Add(
                    "{\"routerRequestId\":\"selftest-" + (1000 + i) + "\"" +
                    ",\"startedAtUtc\":\"" + started.ToString("o", System.Globalization.CultureInfo.InvariantCulture) + "\"" +
                    ",\"completedAtUtc\":\"" + started.AddMinutes(1).ToString("o", System.Globalization.CultureInfo.InvariantCulture) + "\"" +
                    ",\"durationMs\":" + (120 + i * 40) +
                    ",\"lane\":\"" + lane + "\"" +
                    ",\"selectedAccountAliasSnapshot\":\"" + account.Alias + "\"" +
                    ",\"method\":\"" + method + "\"" +
                    ",\"endpointFamily\":\"chat\"" +
                    ",\"terminalOutcome\":\"ok\"" +
                    ",\"httpStatus\":200" +
                    ",\"upstreamRequestIds\":[]" +
                    ",\"model\":null" +
                    ",\"clientCorrelationId\":null}");
            }

            return "{\"rows\":[" + string.Join(",", rows) + "],\"degraded\":false,\"error\":null}";
        }

        public void Dispose()
        {
        }
    }
}
