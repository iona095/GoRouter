using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GoRouterDesktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // GR-009: DPI comes solely from ApplicationHighDpiMode (csproj) via
        // ApplicationConfiguration.Initialize() below — no manifest or
        // P/Invoke duplicates (WFO0003).
        if (args.Length > 0 && args[0] == "--selftest")
        {
            return Selftest.Run(args);
        }

        ApplicationConfiguration.Initialize();

        var sid = StateResolver.UserSid();
        using var mutex = new Mutex(true, StateResolver.MutexName(sid), out var createdNew);
        if (!createdNew)
        {
            // Second instance: ask the running shell to show its control center, then exit.
            SignalFirstInstance(sid);
            return 0;
        }

        var stateDir = StateResolver.ResolveStateDir();
        using var app = new DesktopApp(stateDir, sid);
        Application.Run(app.MainForm);
        return 0;
    }

    private static void SignalFirstInstance(string sid)
    {
        try
        {
            using var signal = EventWaitHandle.OpenExisting(StateResolver.SignalEventName(sid));
            signal.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            // The first instance may have just exited; nothing to signal.
        }
    }
}

/// <summary>
/// Shell wiring: spawn/attach the control service, wait for the admin token,
/// connect with backoff, reconcile start-at-login, drive onboarding, and
/// translate tray/UI events into control-channel operations. The shell never
/// writes secrets; the only file it touches is the admin-token blob (read,
/// or explicit delete on user-confirmed credential reset).
/// </summary>
internal sealed class DesktopApp : IDisposable
{
    public ControlCenterForm MainForm { get; }

    private readonly ControlClient _client;
    private readonly TrayIcon _tray;
    private readonly string _stateDir;
    private readonly string _adminTokenPath;
    private readonly EventWaitHandle? _signalEvent;

    private Process? _serviceProcess;
    private CancellationTokenSource? _startCts;
    private bool _firstRunHandled;
    private bool _reconciledStartup;
    private bool _exiting;
    private bool _disposed;

    public DesktopApp(string stateDir, string sid)
    {
        _stateDir = stateDir;
        _adminTokenPath = StateResolver.AdminTokenPath(stateDir);

        _client = new ControlClient(StateResolver.PipeName(sid), ReadToken);
        MainForm = new ControlCenterForm(_client);
        _tray = new TrayIcon();

        _client.StateChanged += MainForm.SetClientState;
        _client.SnapshotReceived += OnSnapshot;
        MainForm.RetryRequested += OnRetryRequested;
        MainForm.ResetCredentialRequested += OnResetCredentialRequested;
        MainForm.OnboardingRequested += ShowOnboarding;
        MainForm.StartAtLoginChanged += OnStartAtLoginChanged;
        MainForm.MinimizeToTrayChanged += OnMinimizeToTrayChanged;

        _tray.OpenControlCenterRequested += MainForm.ShowFromTray;
        _tray.StartRouterRequested += OnTrayStartRouter;
        _tray.StopRouterRequested += OnTrayStopRouter;
        _tray.LaneSelectRequested += OnTrayLaneSelect;
        _tray.StartAtLoginToggled += OnStartAtLoginChanged;
        _tray.ExitRequested += OnExitRequested;

        _tray.UpdateSnapshot(_client.Snapshot ?? ShellSnapshot.Empty);

        _signalEvent = new EventWaitHandle(false, EventResetMode.AutoReset, StateResolver.SignalEventName(sid));
        var watcher = new Thread(SignalWatcherLoop)
        {
            IsBackground = true,
            Name = "GoRouterDesktop single-instance watcher",
        };
        watcher.Start();

        MainForm.Load += async (_, _) => await StartAsync();
    }

    // ------------------------------------------------------------------
    // Control service lifecycle
    // ------------------------------------------------------------------

    private string? ReadToken()
    {
        var result = Dpapi.TryReadAdminToken(_adminTokenPath);
        if (result.Status == AdminTokenStatus.Ok)
        {
            return result.Token;
        }

        if (result.Status == AdminTokenStatus.Corrupt)
        {
            _client.FailAuth("The desktop control credential is corrupted (DPAPI unprotect failed). Use Reset desktop control credential to recreate it.");
        }

        return null;
    }

    private async Task StartAsync()
    {
        if (_exiting || _disposed)
        {
            return;
        }

        _startCts?.Cancel();
        _startCts = new CancellationTokenSource();
        var ct = _startCts.Token;

        _client.StartFresh();

        // 1) Attach if a service is already running.
        if (await _client.TryConnectOnceAsync(300).ConfigureAwait(false))
        {
            return;
        }

        // 2) Spawn the control service (dev: bun src/desktop/control-service.ts; packaged: exe dir).
        EnsureServiceSpawned();

        // 3) Wait for the admin token blob the service creates at startup (max 30s).
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (!ct.IsCancellationRequested && DateTime.UtcNow < deadline)
        {
            var token = Dpapi.TryReadAdminToken(_adminTokenPath);
            if (token.Status == AdminTokenStatus.Ok)
            {
                break;
            }

            if (token.Status == AdminTokenStatus.Corrupt)
            {
                _client.FailAuth("The desktop control credential is corrupted (DPAPI unprotect failed). Use Reset desktop control credential to recreate it.");
                return;
            }

            try
            {
                await Task.Delay(500, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }

        // 4) Connect with 1s/2s/4s backoff; the client reports Unavailable on final failure.
        await _client.ConnectAsync(ct).ConfigureAwait(false);
    }

    private void EnsureServiceSpawned()
    {
        if (_serviceProcess is { HasExited: false })
        {
            return;
        }

        _serviceProcess = null;
        var dev = Environment.GetEnvironmentVariable("GOROUTER_DESKTOP_DEV") == "1";

        try
        {
            ProcessStartInfo psi;
            if (dev)
            {
                var repoRoot = FindRepoRoot(AppContext.BaseDirectory) ?? FindRepoRoot(Environment.CurrentDirectory);
                if (repoRoot is null)
                {
                    _client.FailStartup("Dev mode: could not locate the repository root (package.json). Run scripts/desktop-dev.ps1 from the repository.");
                    return;
                }

                var bun = ResolveBunExecutable();
                if (bun is null)
                {
                    _client.FailStartup("Dev mode: could not find a bun executable. Install Bun or add bun.exe to PATH.");
                    return;
                }

                psi = new ProcessStartInfo(bun, Path.Combine("src", "desktop", "control-service.ts"))
                {
                    WorkingDirectory = repoRoot,
                };
            }
            else
            {
                psi = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "gorouter-control.exe"));
            }

            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.Environment["GOROUTER_STATE_DIR"] = _stateDir;
            _serviceProcess = Process.Start(psi);
        }
        catch (Exception ex)
        {
            _client.FailStartup("Could not start the control service: " + ex.Message);
        }
    }

    /// <summary>
    /// Dev mode spawns `bun src/desktop/control-service.ts`. CreateProcess needs
    /// a real executable, but on some hosts bun is only reachable through npm
    /// shims (bun.cmd/bun.ps1); resolve bun.exe from PATH first, then the
    /// standard install locations.
    /// </summary>
    private static string? ResolveBunExecutable()
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), "bun.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // malformed PATH entry; keep scanning
            }
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Path.Combine(home, ".bun", "bin", "bun.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "node_modules", "bun", "bin", "bun.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    /// <summary>Walks up from startDir (max 6 levels) looking for package.json (repo root).</summary>
    private static string? FindRepoRoot(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        for (var i = 0; i <= 6 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    private void OnSnapshot(ShellSnapshot snapshot)
    {
        _tray.UpdateSnapshot(snapshot);
        MainForm.ApplySnapshot(snapshot);

        if (!_reconciledStartup)
        {
            _reconciledStartup = true;
            try
            {
                StartupManager.Reconcile(snapshot.Desktop.StartAtLogin);
            }
            catch
            {
                // Registry unavailable: the tray checkbox still mirrors the snapshot.
            }
        }

        if (!_firstRunHandled)
        {
            _firstRunHandled = true;
            if (snapshot.FirstRun)
            {
                MainForm.BeginInvoke(ShowOnboarding);
            }
            else
            {
                MainForm.SetOnboardingPending(false);
            }
        }
    }

    private void ShowOnboarding()
    {
        if (_exiting)
        {
            return;
        }

        var snapshot = _client.Snapshot;
        if (snapshot is null || !snapshot.FirstRun)
        {
            MainForm.SetOnboardingPending(false);
            return;
        }

        using var flow = new FirstRunFlow(_client, snapshot);
        var result = flow.ShowDialog(MainForm);
        MainForm.SetOnboardingPending(result != DialogResult.OK);
    }

    private void OnRetryRequested()
    {
        _ = StartAsync();
    }

    private async void OnResetCredentialRequested()
    {
        using var confirm = new ConfirmDialog(
            "Reset desktop control credential",
            "This deletes the stored desktop control credential and restarts the control connection so a fresh one is created. " +
            "Accounts, routes and the request journal are not affected. A managed router is restarted automatically and resumes routing " +
            "within a few seconds; an externally started router (attached mode) keeps serving. Continue?",
            "Reset credential");
        if (confirm.ShowDialog(MainForm) != DialogResult.OK)
        {
            return;
        }

        try
        {
            // 1) Stop the control service gracefully over the authenticated
            // channel when possible. NOTE (Windows): a managed router child is
            // terminated with the service (Bun job object KILL_ON_JOB_CLOSE);
            // the fresh service respawns it, so routing resumes automatically.
            // An attached external router is untouched.
            if (_client.State == ClientState.Connected)
            {
                try
                {
                    await _client.CallAsync("app.exit", new { stopRouter = false }, 4_000);
                }
                catch
                {
                    // fall through to process-level stop below
                }
            }

            _client.StartFresh();

            // 2) Process-level backstop for a service we spawned.
            if (_serviceProcess is { HasExited: false })
            {
                try
                {
                    _serviceProcess.Kill(entireProcessTree: true);
                }
                catch
                {
                    // process already gone
                }

                _serviceProcess = null;
            }

            // 3) Delete the token so the fresh service creates a new one.
            File.Delete(_adminTokenPath);
        }
        catch (Exception ex)
        {
            MainForm.SetBannerError("Could not reset the control credential: " + ex.Message);
            return;
        }

        await StartAsync();
    }

    private async void OnStartAtLoginChanged(bool enabled)
    {
        // Service flag first: the HKCU Run entry is written only after the
        // service acknowledges the desired state, so the OS entry and
        // snapshot.desktop.startAtLogin cannot diverge (PS-06).
        ControlResponse? response;
        try
        {
            response = await _client.CallAsync("desktop.set", new { startAtLogin = enabled });
        }
        catch (Exception ex)
        {
            MainForm.SetSystemFeedback("Start at login could not be saved: " + ex.Message, isError: true);
            return;
        }

        if (!response.Ok)
        {
            MainForm.SetSystemFeedback("Start at login: " + (response.ErrorMessage ?? "not saved by the service"), isError: true);
            return;
        }

        try
        {
            StartupManager.Reconcile(enabled);
            MainForm.SetSystemFeedback(enabled ? "Start at login enabled." : "Start at login disabled.", isError: false);
        }
        catch (Exception ex)
        {
            _tray.ShowBalloon($"Could not update the Windows start-at-login entry: {ex.Message}", isError: true);
            MainForm.SetSystemFeedback("Start at login: " + ex.Message, isError: true);
        }
    }

    private async void OnMinimizeToTrayChanged(bool enabled)
    {
        try
        {
            var response = await _client.CallAsync("desktop.set", new { minimizeToTray = enabled });
            if (response.Ok)
            {
                MainForm.SetSystemFeedback(enabled ? "Minimize to tray enabled." : "Minimize to tray disabled.", isError: false);
            }
            else
            {
                MainForm.SetSystemFeedback("Minimize to tray: " + (response.ErrorMessage ?? "not saved by the service"), isError: true);
            }
        }
        catch (Exception ex)
        {
            MainForm.SetSystemFeedback("Minimize to tray could not be saved: " + ex.Message, isError: true);
        }
    }

    private async void OnTrayStartRouter()
    {
        var response = await CallAsyncSafe("router.start");
        _tray.ShowBalloon(response.Ok ? "Router start requested." : (response.ErrorMessage ?? "Router start failed."), !response.Ok);
    }

    private async void OnTrayStopRouter()
    {
        var response = await CallAsyncSafe("router.stop");
        if (response.Ok)
        {
            _tray.ShowBalloon("Router stop requested.", isError: false);
        }
        else
        {
            _tray.ShowBalloon(response.ErrorMessage ?? "Router stop failed.", isError: true);
        }
    }

    private async void OnTrayLaneSelect(string lane, string? accountId)
    {
        var alias = accountId is null
            ? null
            : _client.Snapshot?.Accounts.FirstOrDefault(a => a.Id == accountId)?.Alias ?? accountId;

        var response = await CallAsyncSafe(
            accountId is null ? "route.clear" : "route.set",
            accountId is null ? new { lane } : new { lane, accountId });

        if (response.Ok)
        {
            _tray.ShowBalloon(
                accountId is null
                    ? $"{lane.ToUpperInvariant()} lane cleared. In-flight requests keep their original route."
                    : $"{lane.ToUpperInvariant()} now uses {alias}. New requests only.",
                isError: false);
        }
        else
        {
            _tray.ShowBalloon($"{lane.ToUpperInvariant()} switch failed: {response.ErrorMessage}", isError: true);
        }
    }

    private async Task<ControlResponse> CallAsyncSafe(string op, object? parameters = null, int timeoutMs = 30_000)
    {
        try
        {
            return await _client.CallAsync(op, parameters, timeoutMs);
        }
        catch (Exception ex)
        {
            return ControlResponse.Error("internal", ex.Message);
        }
    }

    private async void OnExitRequested()
    {
        if (_exiting)
        {
            return;
        }

        _exiting = true;
        MainForm.SetExiting();
        _tray.Dispose();
        try
        {
            await _client.CallAsync("app.exit", new { stopRouter = true }, 3000);
        }
        catch
        {
            // Best effort: the service keeps running if the shell crashes; it is
            // not killed here — only the managed router child is asked to stop.
        }

        Application.Exit();
    }

    private void SignalWatcherLoop()
    {
        while (!_disposed)
        {
            try
            {
                if (_signalEvent!.WaitOne(1000))
                {
                    MainForm.BeginInvoke(MainForm.ShowFromTray);
                }
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch
            {
                // transient; keep watching
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _startCts?.Cancel();
        _startCts?.Dispose();
        _signalEvent?.Dispose();
        _client.Dispose();
        _tray.Dispose();
        MainForm.Dispose();
    }
}
