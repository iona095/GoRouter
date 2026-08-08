using System.Security.Principal;

namespace GoRouterDesktop;

/// <summary>
/// Path/identity resolution that mirrors src/paths.ts: GOROUTER_STATE_DIR
/// override, else %LOCALAPPDATA%\GoRouter, else ~/.gorouter. The current
/// user SID (dashes stripped, alphanumeric only) identifies the per-user
/// named pipe, the single-instance mutex and the activation event.
/// </summary>
public static class StateResolver
{
    public const string AdminSecretRef = "sec_desktop_admin";

    public static string ResolveStateDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable("GOROUTER_STATE_DIR");
        if (!string.IsNullOrWhiteSpace(overrideDir))
        {
            return overrideDir.Trim();
        }

        var localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (!string.IsNullOrWhiteSpace(localAppData))
        {
            return Path.Combine(localAppData.Trim(), "GoRouter");
        }

        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gorouter");
    }

    public static string UserSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? "unknown";
        return sid.Replace("-", "");
    }

    /// <summary>Full display pipe path (the client strips the server prefix).</summary>
    public static string PipeName(string sid) => @"\\.\pipe\gorouter-ctrl-" + sid;

    public static string AdminTokenPath(string stateDir) =>
        Path.Combine(stateDir, "secrets", AdminSecretRef + ".bin");

    public static string MutexName(string sid) => @"Local\GoRouterDesktop-" + sid;

    public static string SignalEventName(string sid) => @"Local\GoRouterDesktop-Signal-" + sid;
}
