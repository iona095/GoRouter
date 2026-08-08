using System.Drawing.Imaging;
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

            if (args[i].StartsWith("--", StringComparison.Ordinal))
            {
                return Fail($"Unknown option: {args[i]}", args);
            }

            positional.Add(args[i]);
        }

        if (positional.Count != 1)
        {
            return Fail(
                "Usage: GoRouterDesktop --selftest <outDir> [--state empty|configured|degraded|stopped|error|confirm|firstrun] [--snapshot <json-file>]",
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
            "firstrun" => new FirstRunFlow(new StubChannel(snapshot), snapshot),
            _ => new ControlCenterForm(new StubChannel(snapshot)),
        };

        try
        {
            form.Show();
            Pump();
            form.Refresh();
            Pump();

            // Settle: async snapshot application must finish before capture, and
            // the rendered state badge must match the requested state — a
            // capture race fails loudly instead of producing stale evidence.
            if (form is ControlCenterForm ccf)
            {
                for (var i = 0; i < 20 && !ccf.RenderedStateMatches(snapshot); i++)
                {
                    Application.DoEvents();
                    Thread.Sleep(50);
                }

                if (!ccf.RenderedStateMatches(snapshot))
                {
                    return Fail(
                        $"selftest render mismatch: badge '{ccf.StateBadgeText}' vs expected '{RouterStateText(snapshot)}'",
                        args);
                }
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
        Console.Error.WriteLine("Usage: GoRouterDesktop --selftest <outDir> [--state empty|configured|degraded|stopped|error|confirm|firstrun] [--snapshot <json-file>]");
        return 1;
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
                Go = new SnapshotRoute { AccountId = goRoute ? "acct_alpha" : null, Alias = goRoute ? "alpha" : null },
                Zen = new SnapshotRoute { AccountId = zenRoute ? "acct_beta" : null, Alias = zenRoute ? "beta" : null },
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

    /// <summary>Offline channel for selftest rendering; no pipe, no tokens.</summary>
#pragma warning disable CS0067 // events satisfy the interface; never raised by the stub
    private sealed class StubChannel : IControlChannel
    {
        private readonly ShellSnapshot _snapshot;

        public StubChannel(ShellSnapshot snapshot) => _snapshot = snapshot;

        public ShellSnapshot? Snapshot => _snapshot;
        public ClientState State => ClientState.Connected;
        public string? LastError => null;

        public event Action<ShellSnapshot>? SnapshotReceived;
        public event Action<ClientState>? StateChanged;

        public Task<ControlResponse> CallAsync(string op, object? parameters = null, int timeoutMs = 60_000, CancellationToken ct = default)
        {
            var data = op == "localCred.once"
                ? "{\"credential\":\"selftest-local-credential-not-a-real-secret\"}"
                : "{}";
            var response = ControlResponse.FromJson(
                JsonDocument.Parse("{\"id\":1,\"ok\":true,\"data\":" + data + "}").RootElement);
            return Task.FromResult(response);
        }

        public void Dispose()
        {
        }
    }
}
