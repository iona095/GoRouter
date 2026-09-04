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

    private NamedPipeClientStream? _pipe;
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
            _connectCts?.Cancel();
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
                loopCts.Dispose();
                return false;
            }

            _pipe = pipe;
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
                    // later CallAsync writes. Close it; the read loop exits and
                    // ConnectAsync retries with backoff.
                    SetState(ClientState.Reconnecting, hello.ErrorMessage ?? "Control service rejected the connection.");
                    ClosePipe();
                }

                return false;
            }
        }
        catch
        {
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
            _connectCts?.Cancel();
            _connectCts = linked;
        }

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
            catch (OperationCanceledException)
            {
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

    private async Task ReadLoopAsync(NamedPipeClientStream pipe, StreamReader reader, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
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
            lock (_gate)
            {
                if (ReferenceEquals(_pipe, pipe))
                {
                    _pipe = null;
                }
            }

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

    private void ClosePipe()
    {
        NamedPipeClientStream? pipe;
        lock (_gate)
        {
            pipe = _pipe;
            _pipe = null;
        }

        pipe?.Dispose();
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
                LastError = error;
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
        lock (_gate)
        {
            _connectCts?.Cancel();
        }

        ClosePipe();
        FailAllPending();
        _writeLock.Dispose();
    }
}
