using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GoRouterDesktop;

public enum ClientState
{
    Starting,
    Connected,
    Reconnecting,
    Unavailable,
    AuthFailed,
}

public sealed class ControlResponse
{
    public long Id { get; init; }
    public bool Ok { get; init; }
    public JsonElement? Data { get; init; }
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }

    public static ControlResponse FromJson(JsonElement root)
    {
        var id = root.TryGetProperty("id", out var idProp) && idProp.TryGetInt64(out var idValue) ? idValue : 0;
        var ok = root.TryGetProperty("ok", out var okProp) && okProp.ValueKind == JsonValueKind.True;

        JsonElement? data = null;
        if (root.TryGetProperty("data", out var dataProp) &&
            (dataProp.ValueKind == JsonValueKind.Object || dataProp.ValueKind == JsonValueKind.Array))
        {
            // Clone: the parsed JsonDocument is disposed after FromJson returns,
            // and callers access Data asynchronously. Arrays (e.g. account.test
            // results) must be preserved as well.
            data = dataProp.Clone();
        }

        string? errorCode = null;
        string? errorMessage = null;
        if (root.TryGetProperty("error", out var errorProp) && errorProp.ValueKind == JsonValueKind.Object)
        {
            if (errorProp.TryGetProperty("code", out var codeProp) && codeProp.ValueKind == JsonValueKind.String)
            {
                errorCode = codeProp.GetString();
            }

            if (errorProp.TryGetProperty("message", out var messageProp) && messageProp.ValueKind == JsonValueKind.String)
            {
                errorMessage = messageProp.GetString();
            }
        }

        return new ControlResponse
        {
            Id = id,
            Ok = ok,
            Data = data,
            ErrorCode = errorCode,
            ErrorMessage = errorMessage,
        };
    }

    public static ControlResponse Error(string code, string message) =>
        new() { Ok = false, ErrorCode = code, ErrorMessage = message };

    public T? DataAs<T>() =>
        Data is { } element ? element.Deserialize<T>(JsonDefaults.Options) : default;

    public bool TryDataAs<T>(out T? value)
    {
        if (Data is { } element)
        {
            try
            {
                value = element.Deserialize<T>(JsonDefaults.Options);
                return true;
            }
            catch (JsonException)
            {
                // fall through to default
            }
        }

        value = default;
        return false;
    }
}

/// <summary>
/// Control-channel contract used by the shell UI; ControlClient is the real
/// implementation, Selftest supplies a stub with an injected snapshot.
/// </summary>
public interface IControlChannel : IDisposable
{
    ShellSnapshot? Snapshot { get; }
    ClientState State { get; }
    string? LastError { get; }
    event Action<ShellSnapshot>? SnapshotReceived;
    event Action<ClientState>? StateChanged;

    Task<ControlResponse> CallAsync(string op, object? parameters = null, int timeoutMs = 60_000, CancellationToken ct = default);
}

public sealed record RequestEnvelope(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("op")] string Op,
    [property: JsonPropertyName("params")] object? Parameters);

/// <summary>
/// Named-pipe client for the control channel (newline-delimited UTF-8 JSON,
/// protocol v15). Every request carries the admin token; responses are matched
/// by id; "snapshot" events are pushed to subscribers. Reconnects with 1s/2s/4s
/// backoff after an unexpected close, then reports Unavailable (the UI offers
/// Retry — this client never exits on its own). Request parameters are never
/// logged.
/// </summary>
public sealed class ControlClient : IControlChannel
{
    private static readonly TimeSpan[] Backoff = { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4) };

    private readonly string _pipeName;
    private readonly Func<string?> _tokenProvider;
    private readonly object _gate = new();
    private readonly Dictionary<int, TaskCompletionSource<ControlResponse>> _pending = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    // Maximum pipe frame length in UTF-16 chars (F-06): a chars-based memory
    // bound sized like the service-side 1 MiB byte cap (transport
    // MAX_LINE_BYTES) — identical for ASCII, divergent for multibyte, which is
    // fine because this side bounds memory, not wire bytes. An unbounded
    // ReadLineAsync lets a corrupt or hostile peer grow the line without limit.
    private const int MaxFrameChars = 1 << 20;

    private NamedPipeClientStream? _pipe;
    private StreamReader? _reader;
    private CancellationTokenSource? _loopCts;
    private CancellationTokenSource? _connectCts;
    private int _nextId;
    private bool _disposed;
    private ClientState _state = ClientState.Starting;

    public ShellSnapshot? Snapshot { get; private set; }
    public string? LastError { get; private set; }
    public ClientState State => _state;

    public event Action<ShellSnapshot>? SnapshotReceived;
    public event Action<ClientState>? StateChanged;

    public ControlClient(string pipeName, Func<string?> tokenProvider)
    {
        _pipeName = StripPipePrefix(pipeName);
        _tokenProvider = tokenProvider;
    }

    /// <summary>Resets the client for a fresh connect attempt (Retry path).</summary>
    public void StartFresh()
    {
        lock (_gate)
        {
            // Cancel-only: the superseded loop may still await on this CTS
            // (disposing under it throws ObjectDisposedException out of its
            // Task.Delay). The exiting loop disposes non-current CTSs itself.
            try { _connectCts?.Cancel(); } catch { /* already disposed */ }
            _connectCts = new CancellationTokenSource();
        }

        SetState(ClientState.Starting, null);
        ClosePipe();
    }

    /// <summary>Single immediate connect attempt (used as an attach probe).</summary>
    public async Task<bool> TryConnectOnceAsync(int timeoutMs)
    {
        if (_disposed || _state == ClientState.AuthFailed)
        {
            return false;
        }

        var token = _tokenProvider();
        if (token is null)
        {
            return false;
        }

        var pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await pipe.ConnectAsync(timeoutMs).ConfigureAwait(false);
        }
        catch
        {
            pipe.Dispose();
            return false;
        }

        var reader = new StreamReader(pipe, Encoding.UTF8, false, 1 << 20, leaveOpen: true);
        var loopCts = new CancellationTokenSource();
        lock (_gate)
        {
            if (_disposed)
            {
                pipe.Dispose();
                reader.Dispose();
                loopCts.Dispose();
                return false;
            }

            _pipe = pipe;
            _reader = reader;
            _loopCts = loopCts;
        }

        _ = Task.Run(() => ReadLoopAsync(pipe, reader, loopCts.Token));

        try
        {
            // hello must be the first message; the server replies and then pushes the initial snapshot event.
            var hello = await CallCoreAsync(pipe, "hello", new { app = "GoRouterDesktop", version = "1.5.0" }, TimeSpan.FromSeconds(5))
                .ConfigureAwait(false);
            if (!hello.Ok)
            {
                if (hello.ErrorCode == "auth")
                {
                    SetState(ClientState.AuthFailed, hello.ErrorMessage ?? "Authentication with the control service failed.");
                }
                else
                {
                    // Non-auth rejection (e.g. version mismatch): the pipe never
                    // completed authentication, so it must not stay usable for
                    // later CallAsync writes. Close it and return false without
                    // touching the state — the ConnectAsync loop owns the
                    // Reconnecting transition, and one-shot probes (Starting)
                    // must keep their terminal bool contract, not strand in
                    // Reconnecting with no owner retrying.
                    ClosePipe();
                }

                return false;
            }
        }
        catch
        {
            // Hello exchange failed (timeout, reset, framing): tear the
            // half-open connection down so no orphaned read loop keeps
            // dispatching events or racing _pending with the next attempt.
            ClosePipe();
            return false;
        }
        finally
        {
            if (_state == ClientState.AuthFailed)
            {
                ClosePipe();
            }
        }

        SetState(ClientState.Connected, null);
        return true;
    }

    /// <summary>
    /// Connect attempts with 1s/2s/4s backoff. On final failure the state is
    /// Unavailable (the UI shows a Retry button). Auth failures are terminal
    /// until the credential is reset.
    /// </summary>
    public async Task ConnectAsync(CancellationToken ct)
    {
        var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lock (_gate)
        {
            try { _connectCts?.Cancel(); } catch { /* already disposed */ }
            _connectCts = linked;
        }

        // The previous CTS is NOT disposed here: the superseded loop may
        // still be awaiting on its token (disposing under it throws
        // ObjectDisposedException out of Task.Delay). Each loop disposes its
        // own CTS on exit once it is no longer current (finally below).
        try
        {
            await ConnectLoopBodyAsync(linked).ConfigureAwait(false);
        }
        finally
        {
            // Always dispose: a superseded loop frees its CTS here, and a
            // loop that ran to completion frees the still-current one (safe:
            // every _connectCts.Cancel site tolerates ObjectDisposedException,
            // IsCancellationRequested reads are disposal-safe, and no live
            // loop awaits on an exited loop's token).
            try { linked.Dispose(); } catch { /* already disposed */ }
        }
    }

    private async Task ConnectLoopBodyAsync(CancellationTokenSource linked)
    {
        SetState(ClientState.Reconnecting, null);
        foreach (var delay in Backoff)
        {
            if (linked.IsCancellationRequested || _disposed || _state == ClientState.AuthFailed)
            {
                return;
            }

            try
            {
                await Task.Delay(delay, linked.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is OperationCanceledException || ex is ObjectDisposedException)
            {
                // Cancelled normally, or the CTS was disposed by Dispose()
                // while this loop awaited — either way this loop is done.
                return;
            }

            if (_state == ClientState.AuthFailed)
            {
                return;
            }

            if (await TryConnectOnceAsync(2000).ConfigureAwait(false))
            {
                return;
            }
        }

        if (!linked.IsCancellationRequested && !_disposed && _state != ClientState.AuthFailed)
        {
            SetState(ClientState.Unavailable, "Control service unavailable. Start the service and press Retry.");
        }
    }

    public async Task<ControlResponse> CallAsync(string op, object? parameters = null, int timeoutMs = 60_000, CancellationToken ct = default)
    {
        NamedPipeClientStream pipe;
        lock (_gate)
        {
            pipe = _pipe ?? throw new InvalidOperationException("Not connected to the control service.");
            if (_state == ClientState.AuthFailed)
            {
                throw new InvalidOperationException("Control service authentication failed.");
            }
        }

        return await CallCoreAsync(pipe, op, parameters, TimeSpan.FromMilliseconds(timeoutMs), ct).ConfigureAwait(false);
    }

    /// <summary>Marks the connection unusable with an actionable auth-style error.</summary>
    public void FailAuth(string message)
    {
        ClosePipe();
        SetState(ClientState.AuthFailed, message);
    }

    /// <summary>Marks the connection unusable with a startup error (Retry is offered).</summary>
    public void FailStartup(string message)
    {
        ClosePipe();
        SetState(ClientState.Unavailable, message);
    }

    private async Task<ControlResponse> CallCoreAsync(
        NamedPipeClientStream pipe,
        string op,
        object? parameters,
        TimeSpan timeout,
        CancellationToken ct = default)
    {
        var token = _tokenProvider() ?? throw new InvalidOperationException("Admin token unavailable.");

        int id;
        TaskCompletionSource<ControlResponse> tcs;
        lock (_gate)
        {
            id = ++_nextId;
            tcs = new TaskCompletionSource<ControlResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = tcs;
        }

        byte[] bytes;
        try
        {
            // Protocol framing: exactly one JSON object per line, "\n" only.
            var json = JsonSerializer.SerializeToUtf8Bytes(new RequestEnvelope(id, token, op, parameters), JsonDefaults.Options);
            bytes = new byte[json.Length + 1];
            Buffer.BlockCopy(json, 0, bytes, 0, json.Length);
            bytes[^1] = (byte)'\n';
        }
        catch
        {
            lock (_gate)
            {
                _pending.Remove(id);
            }

            throw;
        }

        try
        {
            await _writeLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                await pipe.WriteAsync(bytes, ct).ConfigureAwait(false);
                await pipe.FlushAsync(ct).ConfigureAwait(false);
            }
            finally
            {
                _writeLock.Release();
            }
        }
        catch
        {
            lock (_gate)
            {
                _pending.Remove(id);
            }

            throw;
        }

        try
        {
            return await tcs.Task.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            lock (_gate)
            {
                _pending.Remove(id);
            }

            throw new TimeoutException($"Control request '{op}' timed out.");
        }
    }

    private void HandleLine(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;

        if (root.TryGetProperty("event", out var eventProp) &&
            eventProp.ValueKind == JsonValueKind.String &&
            eventProp.GetString() == "snapshot")
        {
            if (root.TryGetProperty("data", out var dataProp) && dataProp.ValueKind == JsonValueKind.Object)
            {
                var snapshot = dataProp.Deserialize<ShellSnapshot>(JsonDefaults.Options);
                if (snapshot is not null)
                {
                    Snapshot = snapshot;
                    SnapshotReceived?.Invoke(snapshot);
                }
            }

            return;
        }

        if (root.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt64(out var idValue))
        {
            var response = ControlResponse.FromJson(root);
            TaskCompletionSource<ControlResponse>? tcs;
            lock (_gate)
            {
                _pending.TryGetValue((int)idValue, out tcs);
                _pending.Remove((int)idValue);
            }

            tcs?.TrySetResult(response);
        }
    }

    /// <summary>Reads one newline-terminated frame with a length cap.
    /// Returns null on end-of-stream (mirroring ReadLineAsync: a partial final
    /// line without a terminator is delivered first). Throws
    /// InvalidDataException when the frame exceeds <see cref="MaxFrameChars"/>.
    /// The cap is checked before every append, so it holds on the terminating
    /// chunk too — zero overshoot on any return path.
    /// </summary>
    private static async Task<string?> ReadBoundedLineAsync(StreamReader reader, CancellationToken ct)
    {
        var sb = new StringBuilder();
        var buf = new char[4096];
        for (;;)
        {
            int n = await reader.ReadAsync(buf.AsMemory(), ct).ConfigureAwait(false);
            if (n == 0)
            {
                return sb.Length == 0 ? null : sb.ToString();
            }

            int start = 0;
            for (int i = 0; i < n; i++)
            {
                if (buf[i] != '\n') continue;
                int segLen = i - start;
                if (sb.Length + segLen > MaxFrameChars)
                {
                    throw new InvalidDataException($"Control frame exceeded {MaxFrameChars} chars.");
                }
                sb.Append(buf, start, segLen);
                if (sb.Length > 0 && sb[sb.Length - 1] == '\r') sb.Length--;
                return sb.ToString();
            }

            if (sb.Length + n > MaxFrameChars)
            {
                throw new InvalidDataException($"Control frame exceeded {MaxFrameChars} chars.");
            }
            sb.Append(buf, 0, n);
        }
    }

    private async Task ReadLoopAsync(NamedPipeClientStream pipe, StreamReader reader, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await ReadBoundedLineAsync(reader, ct).ConfigureAwait(false);
                }
                catch (InvalidDataException ex)
                {
                    // Hostile/corrupt over-cap frame: drop the connection and
                    // reconnect explicitly. Reconnecting (not Connected) fires
                    // StateChanged so the UI learns the reason; the read-loop
                    // finally skips its own reconnect because ClosePipe
                    // cancelled this loop's token — the explicit ConnectAsync
                    // below is the single reconnect owner. The unread remainder
                    // is discarded with the pipe.
                    ClosePipe();
                    SetState(ClientState.Reconnecting, ex.Message);
                    _ = ConnectAsync(CancellationToken.None);
                    break;
                }

                if (line is null)
                {
                    break;
                }

                if (line.Length == 0)
                {
                    continue;
                }

                try
                {
                    HandleLine(line);
                }
                catch (JsonException)
                {
                    // Malformed server frame: ignore and keep reading.
                }
            }
        }
        catch (OperationCanceledException)
        {
            // intentional close
        }
        catch
        {
            // connection error → treated as an unexpected close below
        }
        finally
        {
            // Take ownership of this connection's reader/CTS only if no newer
            // connection replaced it (ClosePipe owns the replaced case).
            StreamReader? ownedReader = null;
            CancellationTokenSource? ownedCts = null;
            lock (_gate)
            {
                if (ReferenceEquals(_pipe, pipe))
                {
                    _pipe = null;
                    ownedReader = _reader;
                    ownedCts = _loopCts;
                    _reader = null;
                    _loopCts = null;
                }
            }

            ownedReader?.Dispose();
            try { ownedCts?.Cancel(); } catch { /* already disposed */ }
            ownedCts?.Dispose();
            // The pipe itself: Dispose is idempotent, so unconditionally
            // disposing the loop's own handle closes the natural-exit leak
            // (EOF/error/cancel paths that never passed through ClosePipe)
            // without double-dispose risk on paths that did.
            try { pipe.Dispose(); } catch { /* already torn down */ }

            FailAllPending();

            // Unexpected close while connected → reconnect with backoff (never auto-exit).
            if (!ct.IsCancellationRequested && !_disposed && _state == ClientState.Connected)
            {
                _ = ConnectAsync(CancellationToken.None);
            }
        }
    }

    private void FailAllPending()
    {
        List<TaskCompletionSource<ControlResponse>> pending;
        lock (_gate)
        {
            pending = _pending.Values.ToList();
            _pending.Clear();
        }

        foreach (var tcs in pending)
        {
            tcs.TrySetException(new IOException("Control service closed the connection."));
        }
    }

    /// <summary>Full teardown of the current connection: the pipe, its
    /// StreamReader, and the read loop's CancellationTokenSource (cancelling
    /// unblocks a pending ReadAsync so no orphaned loop survives). Each piece
    /// is nulled under the gate first, so concurrent ClosePipe calls and the
    /// read-loop finally dispose each object at most once per connection.
    /// </summary>
    private void ClosePipe()
    {
        NamedPipeClientStream? pipe;
        StreamReader? reader;
        CancellationTokenSource? loopCts;
        lock (_gate)
        {
            pipe = _pipe;
            reader = _reader;
            loopCts = _loopCts;
            _pipe = null;
            _reader = null;
            _loopCts = null;
        }

        try { loopCts?.Cancel(); } catch { /* already disposed */ }
        pipe?.Dispose();
        reader?.Dispose();
        loopCts?.Dispose();
    }

    private void SetState(ClientState state, string? error)
    {
        bool changed;
        lock (_gate)
        {
            changed = _state != state;
            _state = state;
            if (error is not null)
            {
                // LastError surfaces in the UI banner: cap it here so every
                // SetState caller (reconnect, auth, startup) is covered.
                LastError = UiText.Truncate(error);
            }
        }

        if (changed)
        {
            StateChanged?.Invoke(state);
        }
    }

    private static string StripPipePrefix(string pipeName)
    {
        const string prefix = @"\\.\pipe\";
        return pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? pipeName.Substring(prefix.Length)
            : pipeName;
    }

    public void Dispose()
    {
        _disposed = true;
        CancellationTokenSource? cts;
        lock (_gate)
        {
            cts = _connectCts;
            _connectCts = null;
        }
        // Cancel first so loops exit via OperationCanceledException; dispose
        // after (a loop still inside Task.Delay tolerates ObjectDisposed-
        // Exception via the widened catch and its finally skips non-current).
        try { cts?.Cancel(); } catch { /* already disposed */ }
        cts?.Dispose();

        ClosePipe();
        FailAllPending();
        _writeLock.Dispose();
    }
}
