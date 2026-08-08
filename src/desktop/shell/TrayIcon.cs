using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace GoRouterDesktop;

/// <summary>
/// System tray presence: runtime-generated state icon (color reinforces the
/// state — the menu text is the primary indicator), tooltip with the current
/// Go/Zen selections, direct lane switching without opening the control
/// center, start-at-login toggle, and the only intentional Exit path
/// (app.exit stopRouter:true).
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private readonly NotifyIcon _notify;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _miRouterState;
    private readonly ToolStripMenuItem _miStart;
    private readonly ToolStripMenuItem _miStop;
    private readonly ToolStripMenuItem _miOpen;
    private readonly ToolStripMenuItem _miGo;
    private readonly ToolStripMenuItem _miZen;
    private readonly ToolStripMenuItem _miStartAtLogin;
    private readonly ToolStripMenuItem _miExit;

    private ShellSnapshot _snapshot = ShellSnapshot.Empty;
    private bool _updating;
    private bool _disposed;
    private Icon? _icon;

    public event Action? OpenControlCenterRequested;
    public event Action? StartRouterRequested;
    public event Action? StopRouterRequested;

    /// <summary>lane, accountId (null → route.clear).</summary>
    public event Action<string, string?>? LaneSelectRequested;
    public event Action<bool>? StartAtLoginToggled;
    public event Action? ExitRequested;

    public TrayIcon()
    {
        _menu = new ContextMenuStrip();

        _miRouterState = new ToolStripMenuItem("Router: …") { Enabled = false, AccessibleName = "Router state" };
        _miStart = new ToolStripMenuItem("Start router") { AccessibleName = "Start router" };
        _miStop = new ToolStripMenuItem("Stop router") { AccessibleName = "Stop router" };
        _miOpen = new ToolStripMenuItem("Open control center") { AccessibleName = "Open control center" };
        _miGo = new ToolStripMenuItem("Go ▸") { AccessibleName = "Go lane account selection" };
        _miZen = new ToolStripMenuItem("Zen ▸") { AccessibleName = "Zen lane account selection" };
        _miStartAtLogin = new ToolStripMenuItem("Start at login") { AccessibleName = "Start at login" };
        _miExit = new ToolStripMenuItem("Exit") { AccessibleName = "Exit GoRouter Desktop" };

        _menu.Items.AddRange(new ToolStripItem[]
        {
            _miRouterState,
            new ToolStripSeparator(),
            _miStart,
            _miStop,
            new ToolStripSeparator(),
            _miOpen,
            new ToolStripSeparator(),
            _miGo,
            _miZen,
            new ToolStripSeparator(),
            _miStartAtLogin,
            new ToolStripSeparator(),
            _miExit,
        });

        _miStart.Click += (_, _) => StartRouterRequested?.Invoke();
        _miStop.Click += (_, _) => StopRouterRequested?.Invoke();
        _miOpen.Click += (_, _) => OpenControlCenterRequested?.Invoke();
        _miStartAtLogin.CheckOnClick = true;
        _miStartAtLogin.CheckedChanged += (_, _) =>
        {
            if (!_updating)
            {
                StartAtLoginToggled?.Invoke(_miStartAtLogin.Checked);
            }
        };
        _miExit.Click += (_, _) => ExitRequested?.Invoke();

        _notify = new NotifyIcon
        {
            ContextMenuStrip = _menu,
            Text = "GoRouter",
            Visible = true,
        };
        UpdateIcon("starting");
    }

    public void UpdateSnapshot(ShellSnapshot snapshot)
    {
        _snapshot = snapshot;
        if (_disposed)
        {
            return;
        }

        _updating = true;
        try
        {
            _miRouterState.Text = $"Router: {snapshot.Router.State} ({snapshot.Router.Mode})";
            _miStart.Enabled = snapshot.Router.State is not ("running" or "starting");
            _miStop.Enabled = snapshot.Router.State is "running" or "starting" or "degraded" or "port_conflict";
            _miStartAtLogin.Checked = snapshot.Desktop.StartAtLogin;
            RebuildLaneMenu(_miGo, "go", snapshot.Routes.Go);
            RebuildLaneMenu(_miZen, "zen", snapshot.Routes.Zen);
        }
        finally
        {
            _updating = false;
        }

        UpdateIcon(snapshot.Router.State);
        var go = snapshot.Routes.Go.Alias ?? "—";
        var zen = snapshot.Routes.Zen.Alias ?? "—";
        _notify.Text = $"GoRouter — GO: {go} · ZEN: {zen} · {snapshot.Router.State}";
    }

    public void ShowBalloon(string text, bool isError)
    {
        if (_disposed)
        {
            return;
        }

        _notify.BalloonTipTitle = "GoRouter";
        _notify.BalloonTipText = text;
        _notify.BalloonTipIcon = isError ? ToolTipIcon.Error : ToolTipIcon.Info;
        _notify.ShowBalloonTip(4000);
    }

    private void RebuildLaneMenu(ToolStripMenuItem parent, string lane, SnapshotRoute route)
    {
        parent.DropDownItems.Clear();

        var none = new ToolStripMenuItem("(none)") { Checked = route.AccountId is null };
        none.Click += (_, _) => LaneSelectRequested?.Invoke(lane, null);
        parent.DropDownItems.Add(none);
        parent.DropDownItems.Add(new ToolStripSeparator());

        if (_snapshot.Accounts.Count == 0)
        {
            parent.DropDownItems.Add(new ToolStripMenuItem("(no accounts yet)") { Enabled = false });
            return;
        }

        foreach (var account in _snapshot.Accounts)
        {
            var item = new ToolStripMenuItem(account.Alias) { Checked = account.Id == route.AccountId };
            var accountId = account.Id;
            item.Click += (_, _) => LaneSelectRequested?.Invoke(lane, accountId);
            parent.DropDownItems.Add(item);
        }

        if (route.AccountId is not null && _snapshot.Accounts.All(a => a.Id != route.AccountId))
        {
            parent.DropDownItems.Add(new ToolStripMenuItem($"{route.Alias ?? "unknown"} (missing account)") { Enabled = false });
        }
    }

    private void UpdateIcon(string routerState)
    {
        var color = routerState switch
        {
            "running" => Color.FromArgb(0x1B, 0x7A, 0x3D),
            "degraded" or "starting" => Color.FromArgb(0xC8, 0x7A, 0x00),
            "port_conflict" or "failed" => Color.FromArgb(0xC0, 0x2B, 0x1E),
            _ => Color.FromArgb(0x75, 0x75, 0x75),
        };

        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var fill = new SolidBrush(color);
            g.FillEllipse(fill, 3, 3, 26, 26);
            using var ring = new Pen(Color.White, 3f);
            g.DrawEllipse(ring, 7, 7, 18, 18);
        }

        var newIcon = Icon.FromHandle(bitmap.GetHicon());
        var old = _icon;
        _icon = newIcon;
        _notify.Icon = newIcon;
        if (old is not null)
        {
            DestroyIcon(old.Handle);
            old.Dispose();
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _notify.Visible = false;
        _notify.Dispose();
        _menu.Dispose();
        if (_icon is not null)
        {
            DestroyIcon(_icon.Handle);
            _icon.Dispose();
            _icon = null;
        }
    }
}
