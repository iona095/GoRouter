using System.Text.Json;
using System.Text.Json.Serialization;

namespace GoRouterDesktop;

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

/// <summary>Immutable model of the control-channel snapshot (protocol §snapshot).</summary>
public sealed class ShellSnapshot
{
    [JsonPropertyName("serviceVersion")]
    public string ServiceVersion { get; init; } = "";

    [JsonPropertyName("stateGeneration")]
    public string StateGeneration { get; init; } = "";

    [JsonPropertyName("initialized")]
    public bool Initialized { get; init; }

    [JsonPropertyName("firstRun")]
    public bool FirstRun { get; init; }

    [JsonPropertyName("stateCorrupt")]
    public bool StateCorrupt { get; init; }

    [JsonPropertyName("stateUnsupportedVersion")]
    public int? StateUnsupportedVersion { get; init; }

    [JsonPropertyName("desktopUnsupportedVersion")]
    public int? DesktopUnsupportedVersion { get; init; }

    [JsonPropertyName("secretStore")]
    public string SecretStore { get; init; } = "ok";

    [JsonPropertyName("settings")]
    public SnapshotSettings Settings { get; init; } = new();

    [JsonPropertyName("routes")]
    public SnapshotRoutes Routes { get; init; } = new();

    [JsonPropertyName("accounts")]
    public IReadOnlyList<SnapshotAccount> Accounts { get; init; } = Array.Empty<SnapshotAccount>();

    [JsonPropertyName("router")]
    public SnapshotRouter Router { get; init; } = new();

    [JsonPropertyName("journal")]
    public SnapshotJournal Journal { get; init; } = new();

    [JsonPropertyName("desktop")]
    public SnapshotDesktop Desktop { get; init; } = new();

    [JsonPropertyName("stateDir")]
    public string StateDir { get; init; } = "";

    [JsonPropertyName("localCredentialConfigured")]
    public bool LocalCredentialConfigured { get; init; }

    public static ShellSnapshot Empty { get; } = new();

    /// <summary>
    /// Builds the lane ComboBox option list: "(none)" first, then one entry
    /// per account, plus a non-routable "(missing account)" entry when the
    /// route references an account that no longer exists (dangling selection).
    /// </summary>
    public static List<AccountOption> LaneOptions(ShellSnapshot snapshot, SnapshotRoute route, out int selectedIndex)
    {
        var options = new List<AccountOption> { new(null, "(none)") };
        foreach (var account in snapshot.Accounts)
        {
            options.Add(new AccountOption(account.Id, account.Alias));
        }

        if (route.AccountId is not null && !snapshot.Accounts.Any(a => a.Id == route.AccountId))
        {
            options.Add(new AccountOption(route.AccountId, $"{route.Alias ?? "unknown"} (missing account)"));
        }

        selectedIndex = Math.Max(0, options.FindIndex(o => o.Id == route.AccountId));
        return options;
    }
}

public sealed class SnapshotSettings
{
    [JsonPropertyName("port")]
    public int Port { get; init; } = 8787;

    [JsonPropertyName("journalRetentionDays")]
    public int JournalRetentionDays { get; init; } = 30;

    [JsonPropertyName("journalMaxRecords")]
    public int JournalMaxRecords { get; init; } = 100_000;
}

public sealed class SnapshotRoutes
{
    [JsonPropertyName("go")]
    public SnapshotRoute Go { get; init; } = new();

    [JsonPropertyName("zen")]
    public SnapshotRoute Zen { get; init; } = new();
}

public sealed class SnapshotRoute
{
    [JsonPropertyName("accountId")]
    public string? AccountId { get; init; }

    [JsonPropertyName("alias")]
    public string? Alias { get; init; }

    [JsonPropertyName("version")]
    public long Version { get; init; }
}

public sealed class SnapshotAccount
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("alias")]
    public string Alias { get; init; } = "";

    [JsonPropertyName("secretPresent")]
    public bool SecretPresent { get; init; }

    [JsonPropertyName("usedBy")]
    public IReadOnlyList<string> UsedBy { get; init; } = Array.Empty<string>();

    [JsonPropertyName("createdAtUtc")]
    public string CreatedAtUtc { get; init; } = "";

    [JsonPropertyName("updatedAtUtc")]
    public string UpdatedAtUtc { get; init; } = "";

    [JsonPropertyName("version")]
    public long Version { get; init; }
}

public sealed class SnapshotRouter
{
    [JsonPropertyName("state")]
    public string State { get; init; } = "stopped";

    [JsonPropertyName("mode")]
    public string Mode { get; init; } = "none";

    [JsonPropertyName("pid")]
    public int Pid { get; init; }

    [JsonPropertyName("port")]
    public int Port { get; init; } = 8787;

    [JsonPropertyName("restartCount")]
    public int RestartCount { get; init; }
}

public sealed class SnapshotJournal
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("records")]
    public int Records { get; init; }

    [JsonPropertyName("oldestRecordAtUtc")]
    public string? OldestRecordAtUtc { get; init; }

    [JsonPropertyName("newestRecordAtUtc")]
    public string? NewestRecordAtUtc { get; init; }

    [JsonPropertyName("degraded")]
    public bool Degraded { get; init; }

    [JsonPropertyName("lastError")]
    public string? LastError { get; init; }

    [JsonPropertyName("retentionDays")]
    public int RetentionDays { get; init; } = 30;

    [JsonPropertyName("maxRecords")]
    public int MaxRecords { get; init; } = 100_000;
}

public sealed class SnapshotDesktop
{
    [JsonPropertyName("startAtLogin")]
    public bool StartAtLogin { get; init; }

    [JsonPropertyName("minimizeToTray")]
    public bool MinimizeToTray { get; init; }

    [JsonPropertyName("theme")]
    public string Theme { get; init; } = "light";

    [JsonPropertyName("firstRunDoneAtUtc")]
    public string? FirstRunDoneAtUtc { get; init; }
}

/// <summary>journal.recent row (safe fields only, per protocol).</summary>
public sealed class JournalRow
{
    [JsonPropertyName("routerRequestId")]
    public string RouterRequestId { get; init; } = "";

    [JsonPropertyName("startedAtUtc")]
    public string StartedAtUtc { get; init; } = "";

    [JsonPropertyName("completedAtUtc")]
    public string? CompletedAtUtc { get; init; }

    [JsonPropertyName("durationMs")]
    public int DurationMs { get; init; }

    [JsonPropertyName("lane")]
    public string Lane { get; init; } = "";

    [JsonPropertyName("selectedAccountAliasSnapshot")]
    public string? SelectedAccountAliasSnapshot { get; init; }

    [JsonPropertyName("method")]
    public string Method { get; init; } = "";

    [JsonPropertyName("endpointFamily")]
    public string? EndpointFamily { get; init; }

    [JsonPropertyName("terminalOutcome")]
    public string TerminalOutcome { get; init; } = "";

    [JsonPropertyName("httpStatus")]
    public int? HttpStatus { get; init; }

    [JsonPropertyName("upstreamRequestIds")]
    public IReadOnlyList<string> UpstreamRequestIds { get; init; } = Array.Empty<string>();

    [JsonPropertyName("model")]
    public string? Model { get; init; }

    [JsonPropertyName("clientCorrelationId")]
    public string? ClientCorrelationId { get; init; }
}

/// <summary>journal.recent response data (never blocks; degraded flag on failure).</summary>
public sealed class RecentJournalData
{
    [JsonPropertyName("rows")]
    public IReadOnlyList<JournalRow> Rows { get; init; } = Array.Empty<JournalRow>();

    [JsonPropertyName("degraded")]
    public bool Degraded { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }
}

/// <summary>Cleared lane with its committed version (W0 commit data).</summary>
public sealed class ClearedLane
{
    [JsonPropertyName("lane")]
    public string Lane { get; init; } = "";

    [JsonPropertyName("routeVersion")]
    public long RouteVersion { get; init; }
}

/// <summary>account.remove response data (W0 commit identity).</summary>
public sealed class RemoveResult
{
    [JsonPropertyName("removedAccountId")]
    public string RemovedAccountId { get; init; } = "";

    [JsonPropertyName("removedAccountVersion")]
    public long RemovedAccountVersion { get; init; }

    [JsonPropertyName("clearedLanes")]
    public IReadOnlyList<ClearedLane> ClearedLanes { get; init; } = Array.Empty<ClearedLane>();

    // F-26: null = unknown (older service); only an explicit false is reported.
    [JsonPropertyName("secretDeleted")]
    public bool? SecretDeleted { get; init; }
}

/// <summary>account.test response row (probe.ts ProbeResult).</summary>
public sealed class ProbeResultInfo
{
    [JsonPropertyName("lane")]
    public string Lane { get; init; } = "";

    [JsonPropertyName("model")]
    public string Model { get; init; } = "";

    [JsonPropertyName("verdict")]
    public string Verdict { get; init; } = "";

    [JsonPropertyName("httpStatus")]
    public int? HttpStatus { get; init; }

    [JsonPropertyName("errorType")]
    public string? ErrorType { get; init; }

    [JsonPropertyName("errorMessageBrief")]
    public string? ErrorMessageBrief { get; init; }

    [JsonPropertyName("workspaceHint")]
    public string? WorkspaceHint { get; init; }
}

/// <summary>localCred.once response data.</summary>
public sealed class LocalCredentialData
{
    [JsonPropertyName("credential")]
    public string? Credential { get; init; }
}

/// <summary>ComboBox entry for lane account selection ("(none)" has Id == null).</summary>
public sealed record AccountOption(string? Id, string Alias)
{
    public override string ToString() => Alias;
}
