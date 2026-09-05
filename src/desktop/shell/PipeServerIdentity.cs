using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace GoRouterDesktop;

/// <summary>
/// F-01: the control-pipe name is derivable public information, not a
/// capability — whoever answers on it must prove it is the legitimate
/// control service BEFORE the shell sends the admin token. Verification:
/// the server-side process image must be the expected control binary AND
/// its owner SID must be the current user.
/// SCOPE GUARD: this covers ONLY the F-01/F-08 shell boundary.
/// </summary>
internal static class PipeServerIdentity
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenUser = 1;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr hPipe, out uint serverProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, uint tokenInformationLength, out uint returnLength);

    // Unicode (W) entry point: the SID string is read with PtrToStringUni.
    // Ansi binding here would return ANSI bytes misread as UTF-16 (mojibake).
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr strSid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_USER
    {
        public SID_AND_ATTRIBUTES User;
    }

    /// <summary>Verifies the connected pipe's server. False = untrusted: caller must not send the token.</summary>
    public static bool Verify(SafePipeHandle clientHandle, out string reason)
    {
        reason = "";
        bool addRef = false;
        try { clientHandle.DangerousAddRef(ref addRef); }
        catch { reason = "pipe handle unavailable"; return false; }
        if (!addRef) { reason = "pipe handle closed"; return false; }
        try
        {
            if (!GetNamedPipeServerProcessId(clientHandle.DangerousGetHandle(), out uint pid) || pid == 0)
            { reason = "GetNamedPipeServerProcessId failed"; return false; }
            IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero) { reason = "cannot open server process"; return false; }
            try
            {
                var sb = new StringBuilder(1024);
                int len = sb.Capacity;
                if (!QueryFullProcessImageName(proc, 0, sb, ref len))
                { reason = "cannot query server image"; return false; }
                string image = sb.ToString(0, len);
                if (!IsExpectedServerImage(image)) { reason = $"unexpected server image '{image}'"; return false; }
                if (!IsCurrentUser(proc, out string ownerWhy)) { reason = ownerWhy; return false; }
                return true;
            }
            finally { CloseHandle(proc); }
        }
        finally { if (addRef) clientHandle.DangerousRelease(); }
    }

    private static bool IsExpectedServerImage(string image)
    {
        // Explicit test/ops override (exact full-path match).
        var expectedOverride = Environment.GetEnvironmentVariable("GOROUTER_DESKTOP_EXPECTED_SERVER_IMAGE");
        if (!string.IsNullOrWhiteSpace(expectedOverride))
            return string.Equals(image, expectedOverride.Trim(), StringComparison.OrdinalIgnoreCase);
        // Dev mode spawns bun.exe from install locations that vary by host:
        // constrain the file name and rely on the owner-SID check below.
        if (Environment.GetEnvironmentVariable("GOROUTER_DESKTOP_DEV") == "1")
            return string.Equals(Path.GetFileName(image), "bun.exe", StringComparison.OrdinalIgnoreCase);
        // Packaged: the shell spawns <BaseDirectory>\gorouter-control.exe itself.
        var expected = Path.Combine(AppContext.BaseDirectory, "gorouter-control.exe");
        return string.Equals(image, expected, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsCurrentUser(IntPtr proc, out string reason)
    {
        reason = "";
        if (!OpenProcessToken(proc, TOKEN_QUERY, out IntPtr token) || token == IntPtr.Zero)
        { reason = "cannot open server process token"; return false; }
        try
        {
            GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out uint needed);
            if (needed == 0 || needed > 4096) { reason = "cannot size server token user"; return false; }
            IntPtr buf = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!GetTokenInformation(token, TokenUser, buf, needed, out _))
                { reason = "cannot read server token user"; return false; }
                var user = Marshal.PtrToStructure<TOKEN_USER>(buf);
                if (!ConvertSidToStringSid(user.User.Sid, out IntPtr sidPtr) || sidPtr == IntPtr.Zero)
                { reason = "cannot read server owner SID"; return false; }
                try
                {
                    string? sid = Marshal.PtrToStringUni(sidPtr);
                    if (string.IsNullOrEmpty(sid)) { reason = "cannot read server owner SID"; return false; }
                    if (!string.Equals(sid.Replace("-", ""), StateResolver.UserSid(), StringComparison.OrdinalIgnoreCase))
                    { reason = "server owner is a different user"; return false; }
                    return true;
                }
                finally { LocalFree(sidPtr); }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { CloseHandle(token); }
    }
}
