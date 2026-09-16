using System.Globalization;
using System.Text.Json;

namespace GoRouterDesktop;

/// <summary>
/// Snapshot wire-contract regression host (requirements A-E, H, J):
/// real wire JSON through the actual C# deserialization / ControlClient path
/// plus native ControlCenterForm rendering. Synthetic aliases only
/// (acct1/acct2/Workspace_A); no provider traffic, no secrets, no raw-frame
/// logging. Invoked as: GoRouterDesktop --selftest snapshot-contract
/// </summary>
internal static class SnapshotContractSelftest
{
    public static int Run(string[] args)
    {
        var failures = new List<string>();
        void Check(bool cond, string name, string detail = "")
        {
            var line = (cond ? "PASS" : "FAIL") + " " + name + (detail.Length > 0 ? " -- " + detail : "");
            Console.WriteLine(line);
            if (!cond) failures.Add(name + (detail.Length > 0 ? ": " + detail : ""));
        }

        var stoppedJson = WireSnapshot(routerState: "stopped", routerMode: "none", pidJson: "null", retentionJson: "30");
        var attachedJson = WireSnapshot(routerState: "running", routerMode: "attached", pidJson: "null", retentionJson: "30");
        var fractionalJson = WireSnapshot(routerState: "stopped", routerMode: "none", pidJson: "null", retentionJson: "1.5");

        try
        {
            var snap = JsonSerializer.Deserialize<ShellSnapshot>(stoppedJson, JsonDefaults.Options);
            Check(snap is not null, "A.deserialize-not-null");
            Check(snap!.Accounts.Count == 3, "A.accounts-survive", "count=" + snap!.Accounts.Count);
            Check(snap!.Routes.Go.Alias == "Workspace_A", "A.go-alias", snap!.Routes.Go.Alias ?? "(null)");
            Check(snap!.Routes.Zen.Alias == "acct2", "A.zen-alias", snap!.Routes.Zen.Alias ?? "(null)");
            Check(snap!.Router.Pid is null, "A.pid-null");
            Check(snap!.Router.State == "stopped" && snap!.Router.Mode == "none", "A.router-state-mode");
        }
        catch (JsonException ex)
        {
            Check(false, "A.deserialize-not-null", "JsonException: " + ex.Message.Split('\n')[0]);
        }

        try
        {
            var snap = JsonSerializer.Deserialize<ShellSnapshot>(attachedJson, JsonDefaults.Options);
            Check(snap is not null, "B.deserialize-not-null");
            Check(snap!.Router.Pid is null, "B.pid-null");
            Check(snap!.Router.State == "running" && snap!.Router.Mode == "attached", "B.attached", snap!.Router.State + "/" + snap!.Router.Mode);
            Check(snap!.Accounts.Count == 3, "B.accounts-survive");
        }
        catch (JsonException ex)
        {
            Check(false, "B.deserialize-not-null", "JsonException: " + ex.Message.Split('\n')[0]);
        }

        try
        {
            var rowJson = "{\"routerRequestId\":\"r1\",\"startedAtUtc\":\"2026-01-01T00:00:00Z\",\"completedAtUtc\":null,\"durationMs\":null,\"lane\":\"go\",\"selectedAccountAliasSnapshot\":\"Workspace_A\",\"method\":\"POST\",\"endpointFamily\":\"chat\",\"terminalOutcome\":\"in_flight\",\"httpStatus\":null,\"upstreamRequestIds\":[],\"model\":null,\"clientCorrelationId\":null}";
            var row = JsonSerializer.Deserialize<JournalRow>(rowJson, JsonDefaults.Options);
            Check(row is not null, "C.row-not-null");
            Check(row!.DurationMs is null, "C.duration-null");
            Check(row!.HttpStatus is null && row!.CompletedAtUtc is null, "C.other-nullables");
        }
        catch (JsonException ex)
        {
            Check(false, "C.row-not-null", "JsonException: " + ex.Message.Split('\n')[0]);
        }

        try
        {
            var snap = JsonSerializer.Deserialize<ShellSnapshot>(fractionalJson, JsonDefaults.Options);
            Check(snap is not null, "D.deserialize-not-null");
            Check(Math.Abs(snap!.Settings.JournalRetentionDays - 1.5) < 0.0001, "D.settings-fractional", snap!.Settings.JournalRetentionDays.ToString(CultureInfo.InvariantCulture));
            Check(Math.Abs(snap!.Journal.RetentionDays - 1.5) < 0.0001, "D.journal-fractional", snap!.Journal.RetentionDays.ToString(CultureInfo.InvariantCulture));
        }
        catch (JsonException ex)
        {
            Check(false, "D.deserialize-not-null", "JsonException: " + ex.Message.Split('\n')[0]);
        }

        try
        {
            var withFuture = stoppedJson.Replace("\"localCredentialConfigured\":true", "\"localCredentialConfigured\":true,\"futureField\":12345");
            var snap = JsonSerializer.Deserialize<ShellSnapshot>(withFuture, JsonDefaults.Options);
            Check(snap is not null && snap!.Accounts.Count == 3, "FUTURE.unknown-ignored");
        }
        catch (JsonException ex)
        {
            Check(false, "FUTURE.unknown-ignored", "JsonException: " + ex.Message.Split('\n')[0]);
        }

        var client = new ControlClient("test-pipe-contract", () => "test-token");
        ShellSnapshot? received = null;
        string? protoErr = null;
        client.SnapshotReceived += s => received = s;
        client.ProtocolError += m => protoErr = m;

        received = null; protoErr = null;
        var before = client.ProtocolErrors;
        client.HandleLine("{\"event\":\"snapshot\",\"data\":" + stoppedJson + "}");
        Check(received is not null, "A.snapshot-received");
        Check(client.ProtocolErrors == before, "A.no-protocol-error");
        Check(received is not null && received!.Router.Pid is null, "A.handleline-pid-null");
        Check(received is not null && received!.Accounts.Count == 3, "A.handleline-accounts");
        Check(client.Snapshot is not null && client.Snapshot!.Routes.Go.Alias == "Workspace_A", "A.client-snapshot-go");

        received = null;
        before = client.ProtocolErrors;
        client.HandleLine("{\"event\":\"snapshot\",\"data\":" + attachedJson + "}");
        Check(received is not null && received!.Router.Mode == "attached" && received!.Router.Pid is null, "B.handleline-attached");

        received = null;
        client.HandleLine("{\"event\":\"snapshot\",\"data\":" + fractionalJson + "}");
        Check(received is not null && Math.Abs(received!.Settings.JournalRetentionDays - 1.5) < 0.0001, "D.handleline-fractional");

        received = null; protoErr = null;
        before = client.ProtocolErrors;
        var lastGood = client.Snapshot;
        var badPid = stoppedJson.Replace("\"pid\":null", "\"pid\":\"not-a-pid\"");
        client.HandleLine("{\"event\":\"snapshot\",\"data\":" + badPid + "}");
        Check(received is null, "E.no-false-snapshot");
        Check(client.ProtocolErrors == before + 1, "E.protocol-counted");
        Check(client.LastProtocolError is not null, "E.diagnostic-surfaced");
        Check(protoErr is not null, "E.event-fired");
        Check(ReferenceEquals(client.Snapshot, lastGood), "E.snapshot-preserved");
        Check(client.LastProtocolError is not null && !client.LastProtocolError.Contains("not-a-pid"), "E.no-raw-frame", client.LastProtocolError ?? "(null)");

        received = null; before = client.ProtocolErrors;
        client.HandleLine("{\"event\":\"snapshot\"}");
        Check(received is null && client.ProtocolErrors == before + 1, "E.missing-data-counted");

        bool envelopeThrew = false;
        try { client.HandleLine("{not json"); }
        catch (JsonException) { envelopeThrew = true; }
        Check(envelopeThrew, "E2.envelope-throws-JsonException");

        received = null;
        client.HandleLine("{\"event\":\"snapshot\",\"data\":" + stoppedJson + "}");
        Check(received is not null, "E.recovery");

        try
        {
            ApplicationConfiguration.Initialize();
        }
        catch (InvalidOperationException)
        {
        }
        var renderSnap = JsonSerializer.Deserialize<ShellSnapshot>(stoppedJson, JsonDefaults.Options)!;
        var testChannel = new ContractTestChannel(renderSnap);
        using (var form = new ControlCenterForm(testChannel))
        {
            // Show so banner Visible is meaningful (child Visible is gated by parent).
            form.Show();
            Application.DoEvents();
            var h = form.Handle;
            Application.DoEvents();
            Check(form.AccountRowCountForTest == 3, "J.account-rows", form.AccountRowCountForTest.ToString(CultureInfo.InvariantCulture));
            var aliases = form.AccountAliasesForTest;
            Check(aliases.Contains("acct1") && aliases.Contains("acct2") && aliases.Contains("Workspace_A"), "J.account-aliases", string.Join(",", aliases));
            var goOpts = form.GoOptionAliasesForTest;
            Check(goOpts.Contains("(none)") && goOpts.Contains("Workspace_A") && goOpts.Contains("acct1") && goOpts.Contains("acct2"), "J.go-options", string.Join(",", goOpts));
            var zenOpts = form.ZenOptionAliasesForTest;
            Check(zenOpts.Contains("(none)") && zenOpts.Contains("Workspace_A"), "J.zen-options", string.Join(",", zenOpts));
            Check(form.GoSelectedAliasForTest == "Workspace_A", "J.go-selected", form.GoSelectedAliasForTest ?? "(null)");
            Check(form.ZenSelectedAliasForTest == "acct2", "J.zen-selected", form.ZenSelectedAliasForTest ?? "(null)");
            Check(form.RouterInfoForTest.Contains("—"), "J.router-pid-dash", form.RouterInfoForTest);
            var fracSnap = JsonSerializer.Deserialize<ShellSnapshot>(fractionalJson, JsonDefaults.Options)!;
            form.ApplySnapshot(fracSnap);
            Application.DoEvents();
            Check(form.RetentionTextboxForTest == "1.5", "D.render-textbox", form.RetentionTextboxForTest);
            Check(form.JournalInfoForTest.Contains("1.5"), "D.render-journal", form.JournalInfoForTest);
            form.SetProtocolWarningForTest("Control snapshot rejected (protocol error) -- waiting for authoritative state.");
            Application.DoEvents();
            Check(form.IsProtocolBannerVisible, "E.banner-visible");
            Check(form.ProtocolWarning is not null, "E.warning-set");
            form.ClearProtocolWarningForTest();
            Application.DoEvents();
            Check(!form.IsProtocolBannerVisible, "E.banner-cleared");
        }
        client.Dispose();

        Console.WriteLine(failures.Count == 0 ? "CONTRACT SELFTEST: ALL PASS" : "CONTRACT SELFTEST: " + failures.Count + " FAILURES");
        foreach (var f in failures) Console.Error.WriteLine("FAIL: " + f);
        return failures.Count == 0 ? 0 : 1;
    }

    #pragma warning disable CS0067 // events satisfy the interface; never raised by the test stub
    private sealed class ContractTestChannel : IControlChannel
    {
        private readonly ShellSnapshot _snap;
        public ContractTestChannel(ShellSnapshot snap) { _snap = snap; }
        public ShellSnapshot? Snapshot => _snap;
        public ClientState State => ClientState.Connected;
        public string? LastError => null;
        public int ProtocolErrors => 0;
        public string? LastProtocolError => null;
        public event Action<ShellSnapshot>? SnapshotReceived;
        public event Action<ClientState>? StateChanged;
        public event Action<string>? ProtocolError;
        public Task<ControlResponse> CallAsync(string op, object? parameters = null, int timeoutMs = 60000, CancellationToken ct = default)
            => Task.FromResult(ControlResponse.Error("unsupported", "contract test channel"));
        public void Dispose() { }
    }

    private static string WireSnapshot(string routerState, string routerMode, string pidJson, string retentionJson)
    {
        return "{\"serviceVersion\":\"1.5.0\",\"stateGeneration\":\"11111111-1111-1111-1111-111111111111\",\"initialized\":true,\"firstRun\":false,\"stateCorrupt\":false,\"stateUnsupportedVersion\":null,\"desktopUnsupportedVersion\":null,\"secretStore\":\"ok\"," + "\"settings\":{\"port\":8787,\"journalRetentionDays\":" + retentionJson + ",\"journalMaxRecords\":100000}," + "\"routes\":{\"go\":{\"accountId\":\"id-go\",\"alias\":\"Workspace_A\",\"version\":2},\"zen\":{\"accountId\":\"id-zen\",\"alias\":\"acct2\",\"version\":1}}," + "\"accounts\":[{\"id\":\"id-go\",\"alias\":\"Workspace_A\",\"secretPresent\":true,\"usedBy\":[\"go\"],\"createdAtUtc\":\"2026-01-01T00:00:00Z\",\"updatedAtUtc\":\"2026-01-01T00:00:00Z\",\"version\":1}," + "{\"id\":\"id-zen\",\"alias\":\"acct2\",\"secretPresent\":true,\"usedBy\":[\"zen\"],\"createdAtUtc\":\"2026-01-01T00:00:00Z\",\"updatedAtUtc\":\"2026-01-01T00:00:00Z\",\"version\":1}," + "{\"id\":\"id-3\",\"alias\":\"acct1\",\"secretPresent\":true,\"usedBy\":[],\"createdAtUtc\":\"2026-01-01T00:00:00Z\",\"updatedAtUtc\":\"2026-01-01T00:00:00Z\",\"version\":1}]," + "\"router\":{\"state\":\"" + routerState + "\",\"mode\":\"" + routerMode + "\",\"pid\":" + pidJson + ",\"port\":8787,\"restartCount\":0}," + "\"journal\":{\"schemaVersion\":1,\"records\":1,\"oldestRecordAtUtc\":null,\"newestRecordAtUtc\":null,\"degraded\":false,\"lastError\":null,\"retentionDays\":" + retentionJson + ",\"maxRecords\":100000}," + "\"desktop\":{\"startAtLogin\":false,\"minimizeToTray\":true,\"theme\":\"light\",\"firstRunDoneAtUtc\":null}," + "\"stateDir\":\"C:/Temp/GoRouter\",\"localCredentialConfigured\":true}";
    }
}
