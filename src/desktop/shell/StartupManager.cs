using Microsoft.Win32;

namespace GoRouterDesktop;

/// <summary>
/// Per-user start-at-login management: HKCU\Software\Microsoft\Windows\
/// CurrentVersion\Run value "GoRouterDesktop" = quoted shell exe path.
/// The shell owns the OS entry; the service records the desired state in
/// desktop.json (snapshot.desktop.startAtLogin) and the shell reconciles
/// the two on connect.
/// </summary>
public static class StartupManager
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "GoRouterDesktop";

    public static string? Read()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(ValueName) as string;
    }

    public static bool IsEnabled() => Read() is not null;

    public static void Write()
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exePath))
        {
            throw new InvalidOperationException("Cannot resolve the desktop executable path.");
        }

        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
        key.SetValue(ValueName, "\"" + exePath + "\"");
    }

    public static void Delete()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    /// <summary>Makes the OS Run entry match the desired state.</summary>
    public static void Reconcile(bool desired)
    {
        if (desired)
        {
            Write();
        }
        else
        {
            Delete();
        }
    }
}
