using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace GoRouterDesktop;

public enum AdminTokenStatus
{
    Ok,
    Missing,
    Corrupt,
}

public sealed record AdminTokenReadResult(AdminTokenStatus Status, string? Token);

/// <summary>
/// DPAPI interop — read-only. The control service writes the admin token as a
/// DPAPI blob via src/secret-store.ts (PowerShell CryptProtectData writer, blob
/// persisted as base64 text); this side only ever unprotects. Raw blob bytes
/// are accepted as a fallback. The unprotect result is the plaintext admin
/// token, sent in every control-channel request; it is never logged.
/// </summary>
public static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn,
        IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        uint dwFlags,
        out DATA_BLOB pDataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr hMem);

    public static string Unprotect(byte[] blob)
    {
        var inBlob = new DATA_BLOB();
        try
        {
            inBlob.pbData = Marshal.AllocHGlobal(blob.Length);
            inBlob.cbData = blob.Length;
            Marshal.Copy(blob, 0, inBlob.pbData, blob.Length);

            if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out var outBlob))
            {
                throw new CryptographicException(
                    $"DPAPI unprotect failed: Win32 error {Marshal.GetLastWin32Error()}.");
            }

            try
            {
                var result = new byte[outBlob.cbData];
                if (outBlob.cbData > 0)
                {
                    Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                }

                return Encoding.UTF8.GetString(result);
            }
            finally
            {
                if (outBlob.pbData != IntPtr.Zero)
                {
                    LocalFree(outBlob.pbData);
                }
            }
        }
        finally
        {
            if (inBlob.pbData != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(inBlob.pbData);
            }
        }
    }

    public static AdminTokenReadResult TryReadAdminToken(string path)
    {
        if (!File.Exists(path))
        {
            return new AdminTokenReadResult(AdminTokenStatus.Missing, null);
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch
        {
            return new AdminTokenReadResult(AdminTokenStatus.Corrupt, null);
        }

        if (bytes.Length == 0)
        {
            return new AdminTokenReadResult(AdminTokenStatus.Corrupt, null);
        }

        try
        {
            return new AdminTokenReadResult(AdminTokenStatus.Ok, Unprotect(TryGetRawBlob(bytes)));
        }
        catch
        {
            return new AdminTokenReadResult(AdminTokenStatus.Corrupt, null);
        }
    }

    private static byte[] TryGetRawBlob(byte[] bytes)
    {
        // The TS secret store persists the base64 text of the DPAPI blob.
        // DPAPI blobs always start with 0x01 0x00 0x00 0x00, so a leading
        // text payload means base64; anything else is treated as raw bytes.
        if (bytes.Length >= 4 && bytes[0] == 0x01 && bytes[1] == 0x00 && bytes[2] == 0x00 && bytes[3] == 0x00)
        {
            return bytes;
        }

        var text = Encoding.UTF8.GetString(bytes).Trim();
        try
        {
            return Convert.FromBase64String(text);
        }
        catch (FormatException)
        {
            return bytes;
        }
    }
}
