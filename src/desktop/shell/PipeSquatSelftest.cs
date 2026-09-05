using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace GoRouterDesktop;

/// <summary>
/// F-01 regression host. SCOPE GUARD: this covers ONLY the shell control
/// boundary needed by F-01/F-08. It must not grow into a general xUnit
/// migration of the desktop shell during R2.
/// Usage: GoRouterDesktop.exe --selftest pipe-squat --pipe "gorouter-ctrl-test"
/// Spins a rogue pipe server on the given name, connects a ControlClient,
/// and asserts the client refuses at AuthFailed AND zero token bytes reach
/// the rogue server. Exit 0 on pass, 1 on fail.
/// </summary>
internal static class PipeSquatSelftest
{
    public static async Task<int> Run(string[] args)
    {
        string? pipeArg = null;
        string token = "squat-probe-token";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--pipe" && i + 1 < args.Length) pipeArg = args[++i];
            if (args[i] == "--token" && i + 1 < args.Length) token = args[++i];
        }

        if (string.IsNullOrWhiteSpace(pipeArg))
        {
            Console.Error.WriteLine("pipe-squat: missing --pipe <name>");
            return 1;
        }

        // NamedPipeServerStream takes the bare name (no \\.\\pipe\\ prefix).
        var name = pipeArg.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase)
            ? pipeArg.Substring(@"\\.\pipe\".Length)
            : pipeArg;
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        long bytesReceived = 0;
        var serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync();
            var buf = new byte[4096];
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try
            {
                int n;
                while ((n = await server.ReadAsync(buf, cts.Token)) > 0) bytesReceived += n;
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
        });
        using var client = new ControlClient(pipeArg, () => token);
        bool connected = await client.TryConnectOnceAsync(5000);
        // Let the rogue server observe any late bytes, then check.
        bool serverDone = await Task.WhenAny(serverTask, Task.Delay(TimeSpan.FromSeconds(18))) == serverTask;
        Console.WriteLine($"pipe-squat: connected={connected} state={client.State} bytesReceived={bytesReceived} serverDone={serverDone} lastError={client.LastError}");
        if (!connected && client.State == ClientState.AuthFailed && bytesReceived == 0 && serverDone)
        {
            Console.WriteLine("pipe-squat: PASS");
            return 0;
        }

        Console.Error.WriteLine("pipe-squat: FAIL");
        return 1;
    }
}

/// <summary>
/// F-08 regression host. Same SCOPE GUARD as above: shell-boundary only.
/// Usage: GoRouterDesktop.exe --selftest dispatch-test --pipe "name"
/// A compliant in-process server (EXPECTED_SERVER_IMAGE must admit it)
/// completes hello, pushes a snapshot event, then echoes calls by id. The
/// client attaches one throwing + one recording subscriber per event.
/// Pass iff: events marshal through the captured SynchronizationContext,
/// every recording subscriber still runs, failures are counted, and the
/// transport survives for a subsequent CallAsync.
/// </summary>
internal static class DispatchSelftest
{
    private sealed class RecordingContext : SynchronizationContext
    {
        public int Posts;
        public override void Post(SendOrPostCallback d, object? state)
        {
            Posts++;
            d(state);
        }
    }

    public static async Task<int> Run(string[] args)
    {
        string? pipeArg = null;
        for (int i = 0; i < args.Length; i++)
            if (args[i] == "--pipe" && i + 1 < args.Length) pipeArg = args[++i];
        if (string.IsNullOrWhiteSpace(pipeArg))
        {
            Console.Error.WriteLine("dispatch-test: missing --pipe <name>");
            return 1;
        }

        var name = pipeArg.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase)
            ? pipeArg.Substring(@"\\.\pipe\".Length)
            : pipeArg;
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        var serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(cts.Token);
            using var reader = new StreamReader(server, Encoding.UTF8, false, 4096, leaveOpen: true);
            using var writer = new StreamWriter(server, Encoding.UTF8, 4096, leaveOpen: true) { AutoFlush = true };
            // hello (id 1) -> ok
            var hello = await reader.ReadLineAsync(cts.Token);
            if (hello is null) return;
            await writer.WriteLineAsync("{\"id\":1,\"ok\":true}");
            // push a snapshot event
            await writer.WriteLineAsync("{\"event\":\"snapshot\",\"data\":{}}");
            // echo subsequent calls by id
            while (!cts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(cts.Token);
                if (line is null) break;
                long id = 0;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    if (doc.RootElement.TryGetProperty("id", out var p)) id = p.GetInt64();
                }
                catch (JsonException) { }
                if (id > 0) await writer.WriteLineAsync("{\"id\":" + id + ",\"ok\":true}");
            }
        }, cts.Token);
        var previous = SynchronizationContext.Current;
        var ctx = new RecordingContext();
        SynchronizationContext.SetSynchronizationContext(ctx);
        bool snapshotSeen = false;
        ClientState? lastState = null;
        try
        {
            using var client = new ControlClient(pipeArg, () => "dispatch-probe-token");
            client.SnapshotReceived += _ => throw new InvalidOperationException("boom-snapshot");
            client.SnapshotReceived += s => { if (s is not null) snapshotSeen = true; };
            client.StateChanged += _ => throw new InvalidOperationException("boom-state");
            client.StateChanged += s => lastState = s;
            bool connected = await client.TryConnectOnceAsync(5000);
            var t0 = DateTime.UtcNow;
            while (!snapshotSeen && DateTime.UtcNow - t0 < TimeSpan.FromSeconds(5))
                await Task.Delay(50);
            ControlResponse? echo = null;
            try { echo = await client.CallAsync("account.list", null, 5000); }
            catch (Exception ex) { Console.WriteLine($"dispatch-test: trailing call threw {ex.GetType().Name}"); }
            Console.WriteLine($"dispatch-test: connected={connected} state={client.State} posts={ctx.Posts} snapshotSeen={snapshotSeen} lastState={lastState} subscriberErrors={client.SubscriberErrors} echoOk={echo?.Ok}");
            if (connected && client.State == ClientState.Connected && ctx.Posts > 0 && snapshotSeen
                && lastState == ClientState.Connected && client.SubscriberErrors >= 2 && echo?.Ok == true)
            {
                Console.WriteLine("dispatch-test: PASS");
                return 0;
            }
            Console.Error.WriteLine("dispatch-test: FAIL");
            return 1;
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
            await Task.WhenAny(serverTask, Task.Delay(2000));
        }
    }
}
