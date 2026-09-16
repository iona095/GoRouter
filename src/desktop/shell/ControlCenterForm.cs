using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace GoRouterDesktop;

/// <summary>
/// The control center: a top status bar (GoRouter Desktop identity, live
/// router state badge with a shape-reinforcing dot, port, Desktop release
/// version, Start/Stop), a home Routing tab with two equal lane cards (GO/ZEN
/// immediate account switching with exact route-change feedback) and a
/// Recent activity preview fed by the same journal.recent response as the
/// Journal tab, then the Accounts, Journal and System tabs, and a footer
/// with the Desktop release identity, router state and local endpoint port.
/// Navigation between the dashboard and the full journal view is explicit:
/// "View all" enters the journal and the journal header's ← Back (or Escape)
/// returns to the dashboard through one deterministic transition
/// (<see cref="NavigateTo"/>) that never closes the window, restarts
/// anything or issues control calls. Every control has an accessible name
/// and explicit tab order; the close button hides to tray
/// (non-destructive — tray Exit is the only exit); minimize hides to tray
/// when minimizeToTray is enabled.
/// </summary>
public sealed class ControlCenterForm : Form
{
    private readonly IControlChannel _channel;

    private static readonly Color PageBackColor = VisualTheme.WindowBack;

    private ShellSnapshot _snapshot = ShellSnapshot.Empty;
    private ClientState _clientState = ClientState.Starting;
    private bool _updating;
    private bool _exiting;
    private bool _journalRefreshing;

    // status bar
    private Label _lblIdentity = null!;
    private StatusDot _statusDot = null!;
    private Label _lblStateBadge = null!;
    private Label _lblVersion = null!;
    private Label _lblRouteSummary = null!;
    private Button _btnStartRouter = null!;
    private Button _btnStopRouter = null!;
    private ActionButton _btnTheme = null!;

    // footer (local endpoint only; router state lives in the header badge)
    private Panel _footer = null!;
    private Label _lblFooter = null!;

    // banner (startup / unavailable / auth-failed / onboarding pending)
    private Panel _banner = null!;
    private Label _lblBannerText = null!;
    private bool _onboardingPending;
    private bool _localCredentialWarning;
    private string? _compatibilityWarning;
    // Malformed-snapshot fail-safe: set on ProtocolError, cleared on the next
    // authoritative SnapshotReceived. While set the banner stays visible so
    // Empty/default is never silently presented as current truth.
    private string? _protocolWarning;
    private Button _btnRetry = null!;
    private Button _btnResetCredential = null!;
    private Button _btnResumeOnboarding = null!;

    // tabs
    private VisionTabControl _tabs = null!;
    private TabPage _tabJournal = null!;

    // routing tab
    private ComboBox _cmbGo = null!;
    private Label _lblGoFeedback = null!;
    private Label _lblGoError = null!;
    private Label _lblGoMode = null!;
    private ComboBox _cmbZen = null!;
    private Label _lblZenFeedback = null!;
    private Label _lblZenError = null!;
    private Label _lblZenMode = null!;
    private LaneStatusBox _goStatusBox = null!;
    private LaneStatusBox _zenStatusBox = null!;
    private bool _routeBusyGo;
    private bool _routeBusyZen;
    private TabPage _tabHome = null!;
    private TableLayoutPanel _routingGrid = null!;
    private TabPage _tabAccounts = null!;
    private TabPage _tabSystem = null!;
    private HeaderToolbar _toolbar = null!;
    private HeaderNavItem[] _navItems = System.Array.Empty<HeaderNavItem>();
    private HeaderMetricCard _metricTotal = null!;
    private HeaderMetricCard _metricSuccess = null!;
    private HeaderMetricCard _metricLatency = null!;
    private MetricBlock _goReq = null!;
    private MetricBlock _goRate = null!;
    private MetricBlock _goLatency = null!;
    private MetricBlock _zenReq = null!;
    private MetricBlock _zenRate = null!;
    private MetricBlock _zenLatency = null!;
    private ListView _lvActivity = null!;
    private Label _lblActivityDegraded = null!;
    private Control _lblActivityEmpty = null!;
    private Button _btnActivityViewAll = null!;

    // accounts tab
    private ListView _lvAccounts = null!;
    private Label _lblAccountsStatus = null!;
    private Button _btnAddAccount = null!;
    private Button _btnUpdateCredential = null!;
    private Button _btnRenameAccount = null!;
    private Button _btnRemoveAccount = null!;
    private Button _btnTestAccount = null!;

    // journal tab
    private ListView _lvJournal = null!;
    private Label _lblJournalStats = null!;
    private Label _lblJournalDegraded = null!;
    private Control _lblJournalEmpty = null!;
    private Button _btnJournalRefresh = null!;
    private Button _btnJournalBack = null!;

    // navigation (View All / Back): last selected tab drives the journal
    // refresh gate so Back is pure navigation with zero control calls
    private TabPage? _lastSelectedTab;

    // system tab
    private Label _lblStateDirValue = null!;
    private Label _lblSecretStoreValue = null!;
    private Label _lblJournalInfoValue = null!;
    private Label _lblRouterInfoValue = null!;
    private CheckBox _chkStartAtLogin = null!;
    private CheckBox _chkMinimizeToTray = null!;
    private TextBox _txtPort = null!;
    private Button _btnApplyPort = null!;
    private Label _lblPortError = null!;
    private TextBox _txtRetentionDays = null!;
    private TextBox _txtMaxRecords = null!;
    private Button _btnApplyRetention = null!;
    private Label _lblRetentionError = null!;
    private Label _lblDiagnosticsFeedback = null!;

    private readonly List<Control> _mutationControls = new();

    public event Action? RetryRequested;
    public event Action? ResetCredentialRequested;
    public event Action? OnboardingRequested;
    public event Action<bool>? StartAtLoginChanged;
    public event Action<bool>? MinimizeToTrayChanged;

    public ControlCenterForm(IControlChannel channel)
    {
        _channel = channel;
        _channel.StateChanged += OnChannelStateChanged;
        _channel.SnapshotReceived += OnChannelSnapshot;
        _channel.ProtocolError += OnChannelProtocolError;

        // Framework DPI scaling (completes the PerMonitorV2 process mode):
        // without this, layout stays in 96dpi-logical units while GDI text
        // renders at the monitor DPI, so every label overflows its rect.
        // Set before BuildLayout so all bounds and fonts scale together.
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        BuildLayout();
        ApplySnapshot(_channel.Snapshot ?? ShellSnapshot.Empty);
        SetClientState(_channel.State);
    }

    /// <summary>
    /// Top-level views reachable through the View All / Back navigation flow.
    /// The visible view is always a pure function of <see cref="CurrentView"/>;
    /// every transition funnels through <see cref="NavigateTo"/>, so the UI
    /// can never drift into a view state that an accidental sequence of
    /// Control.Add/Remove operations produced.
    /// </summary>
    internal enum ViewTarget
    {
        /// <summary>Home dashboard with the GO/ZEN account-selection cards.</summary>
        Dashboard,

        /// <summary>Full journal view (Journal tab).</summary>
        Journal,
    }

    /// <summary>
    /// The single authoritative navigation transition (View All, Back,
    /// Escape). Navigation is selection-only: the TabPages remain direct
    /// children of the TabControl and are never added, removed or reparented,
    /// so repeated cycles are idempotent and no duplicate/orphan controls can
    /// accumulate. Back performs no control-channel calls, restarts nothing,
    /// closes nothing and rewrites no state — GO/ZEN selections, router state
    /// and journal data are simply left where they are.
    /// </summary>
    private void NavigateTo(ViewTarget target)
    {
        _tabs.SelectedTab = target == ViewTarget.Journal ? _tabJournal : _tabHome;
    }

    /// <summary>Current navigation state (journal when the Journal tab is active, else dashboard).</summary>
    internal ViewTarget CurrentView => _tabs.SelectedTab == _tabJournal ? ViewTarget.Journal : ViewTarget.Dashboard;

    /// <summary>
    /// Operator-facing release identity: <see cref="Application.ProductVersion"/>
    /// may carry SemVer 2 build metadata (e.g. "1.5.1+42546abc") that records
    /// the exact build; the chrome shows only the concise release (everything
    /// before '+') while the assembly metadata itself stays untouched.
    /// </summary>
    private static string PresentationVersion
    {
        get
        {
            var product = Application.ProductVersion;
            if (string.IsNullOrEmpty(product))
            {
                return string.Empty;
            }

            var plus = product.IndexOf('+');
            return plus < 0 ? product : product.Substring(0, plus);
        }
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    private void BuildLayout()
    {
        Text = "GoRouter Desktop";
        ClientSize = new Size(1320, 880);
        MinimumSize = new Size(800, 560);
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        KeyPreview = true;

        // Explicit root grid: status bar (AutoSize), banner (AutoSize),
        // tabs (Percent), footer (AutoSize). Sibling Dock composition with a
        // hidden banner left the owner-drawn TabControl strip and page
        // headers vulnerable to overlay/mis-measurement; explicit rows make
        // the top-level geometry deterministic at every width/DPI.
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
            BackColor = VisualTheme.WindowBack,
            AccessibleName = "Control center layout",
        };
        while (root.ColumnStyles.Count < root.ColumnCount) { root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f)); }
        root.ColumnStyles[0].SizeType = SizeType.Percent;
        root.ColumnStyles[0].Width = 100f;
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 0 status bar
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 1 banner
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 2 nav/stats toolbar
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f)); // 3 tabs
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // 4 footer

        root.Controls.Add(BuildStatusBar(), 0, 0);
        root.Controls.Add(BuildBanner(), 0, 1);
        _tabs = new VisionTabControl
        {
            Dock = DockStyle.Fill,
            AccessibleName = "Control center sections",
            // Tab headers live in the shared toolbar above: the native strip
            // is collapsed to a 1px sliver so all page semantics (selection,
            // visibility, keyboard) stay on the TabControl itself.
            SizeMode = TabSizeMode.Fixed,
            ItemSize = new Size(0, 1),
            Padding = new Point(0, 0),
            BackColor = VisualTheme.WindowBack,
            // Tuck the collapsed 1px native strip under the toolbar so no
            // bright seam shows between the toolbar and the tab pages.
            Margin = new Padding(0, -2, 0, 0),
        };
        _tabHome = BuildRoutingTab();
        _tabs.TabPages.Add(_tabHome);
        _tabAccounts = BuildAccountsTab();
        _tabs.TabPages.Add(_tabAccounts);
        _tabJournal = BuildJournalTab();
        _tabs.TabPages.Add(_tabJournal);
        _tabSystem = BuildSystemTab();
        _tabs.TabPages.Add(_tabSystem);
        _toolbar = BuildHeaderToolbar();
        root.Controls.Add(_toolbar, 0, 2);
        _toolbar.Resize += (_, _) => BeginSyncToolbarRow(root);
        SyncToolbarRow(root);
        root.RowStyles[4].SizeType = SizeType.Absolute;
        root.RowStyles[4].Height = 48;
        // All pages share the soft-cool-gray application background; the tab
        // strip itself is painted flat by OnTabsDrawItem.
        foreach (TabPage page in _tabs.TabPages)
        {
            page.BackColor = VisualTheme.WindowBack;
        }
        _tabs.SelectedIndexChanged += (_, _) =>
        {
            // The home tab shows the same journal.recent preview as the full
            // Journal tab, so both refresh through the same single-flight
            // path — EXCEPT when the home tab is re-entered from the journal
            // via Back: Back is pure navigation and must not issue any
            // control-channel call. The preview is already fresh there,
            // because it renders from the same payload as the journal view
            // the user just left.
            var nowJournal = _tabs.SelectedTab == _tabJournal;
            var fromJournal = ReferenceEquals(_lastSelectedTab, _tabJournal);
            _lastSelectedTab = _tabs.SelectedTab;
            var selected = _tabs.SelectedTab;
            _toolbar?.SetActive(selected is null ? 0 : Math.Max(0, _tabs.TabPages.IndexOf(selected)));
            if (nowJournal || (_tabs.SelectedTab == _tabHome && !fromJournal))
            {
                _ = RefreshJournalAsync();
            }
        };
        Controls.Add(root);
        root.Controls.Add(_tabs, 0, 3);
        root.Controls.Add(BuildFooter(), 0, 4);
        Shown += (_, _) => SyncFlatSurfacesTheme();
        // Fit pass once the live device context exists (see HeaderToolbar:
        // construction estimates cannot know the run's DPI scaling).
        Shown += (_, _) => _toolbar?.GrowToFitOnce();
    }

    /// <summary>
    /// The shared navigation/statistics toolbar: four borderless nav items
    /// driving the hidden-header TabControl plus three live metric cards fed
    /// by the same data pipeline as before (no second fetching mechanism).
    /// </summary>
    private void BeginSyncToolbarRow(TableLayoutPanel root)
    {
        try
        {
            if (_toolbar == null || _toolbar.IsDisposed || !_toolbar.IsHandleCreated) { SyncToolbarRow(root); return; }
            _toolbar.BeginInvoke(new Action(() => SyncToolbarRow(root)));
        }
        catch { }
    }

    private void SyncToolbarRow(TableLayoutPanel root)
    {
        try
        {
            if (_toolbar == null || _toolbar.IsDisposed) { return; }
            if (root == null || root.IsDisposed) { return; }
            TableLayoutPanelCellPosition pos = root.GetPositionFromControl(_toolbar);
            if (pos.Row < 0 || pos.Row >= root.RowStyles.Count) { return; }
            root.RowStyles[pos.Row].SizeType = SizeType.Absolute;
            if (root.RowStyles[pos.Row].Height != _toolbar.Height)
            {
                root.RowStyles[pos.Row].Height = _toolbar.Height;
            }
        }
        catch { }
    }

    private HeaderToolbar BuildHeaderToolbar()
    {
        const string windowNote = "Recent window (up to 200 requests): the total is the retained journal count; success rate and latency derive from recent requests.";
        _metricTotal = new HeaderMetricCard("Total Requests", HeaderMetricIcon.Requests, 165, windowNote);
        _metricSuccess = new HeaderMetricCard("Success Rate", HeaderMetricIcon.Success, 163, windowNote);
        _metricLatency = new HeaderMetricCard("Avg. Latency", HeaderMetricIcon.Latency, 155, windowNote);
        // Widths start from the reference estimates; each item then grows
        // to its live measured label width (the brief allows tuning to the
        // actual font), so labels never trim or wrap on any machine/DPI.
        var navSpecs = new (string Text, HeaderNavIcon Icon, int MinWidth, int Tab)[]
        {
            ("Routing", HeaderNavIcon.Routing, 184, 5),
            ("Accounts", HeaderNavIcon.Accounts, 186, 6),
            ("Journal", HeaderNavIcon.Journal, 188, 7),
            ("System", HeaderNavIcon.System, 176, 8),
        };
        _navItems = new HeaderNavItem[navSpecs.Length];
        for (var ni = 0; ni < navSpecs.Length; ni++)
        {
            var spec = navSpecs[ni];
            var item = new HeaderNavItem(spec.Text, spec.Icon, spec.MinWidth) { TabIndex = spec.Tab };
            // +12px safety: TextRenderer.MeasureText under-reports bold
            // overhang, and a trimmed nav label breaks the header.
            var need = 20 + 28 + 17 + MeasureNavLabel(spec.Text) + 14 + 12;
            if (need > item.Width)
            {
                item.Width = need;
                item.MinimumSize = new Size(need, 0);
                item.MaximumSize = new Size(need, int.MaxValue);
            }
            _navItems[ni] = item;
        }
        var pages = new TabPage[] { _tabHome, _tabAccounts, _tabJournal, _tabSystem };
        for (var i = 0; i < _navItems.Length; i++)
        {
            var page = pages[i];
            _navItems[i].ShowSeparator = i < _navItems.Length - 1;
            _navItems[i].Activated += (_, _) =>
            {
                // Same semantics as clicking a native tab header: selection
                // flows through SelectedIndexChanged (journal refresh paths
                // and Back-is-pure-navigation rules all live there).
                _tabs.SelectedTab = page;
            };
        }
        var toolbar = new HeaderToolbar(_navItems, new[] { _metricTotal, _metricSuccess, _metricLatency }, windowNote)
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(VisualTheme.PagePadding, 6, VisualTheme.PagePadding, 6),
        };
        var initial = _tabs.SelectedTab;
        toolbar.SetActive(initial is null ? 0 : Math.Max(0, _tabs.TabPages.IndexOf(initial)));
        return toolbar;
    }

    /// <summary>
    /// Nav label width in the form's (DPI-scaled) layout units. Both sides
    /// share the framework scaling now, so no manual conversion applies.
    /// </summary>
    private static int MeasureNavLabel(string text)
    {
        return TextRenderer.MeasureText(
            text, HeaderFonts.NavActive,
            new Size(int.MaxValue, int.MaxValue),
            TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Width;
    }

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hWnd, string? pszSubAppName, string? pszSubIdList);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(HandleRef hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    /// <summary>
    /// Width to reserve for the classic vertical scrollbar when the rows
    /// need one. Computed from measured header/row heights (never from the
    /// WS_VSCROLL bit, which lags row changes by a paint cycle and caused a
    /// horizontal scrollbar to pop over content right after loads).
    /// </summary>
    private static int VScrollAllowance(ListView lv)
    {
        try
        {
            if (!lv.IsHandleCreated || lv.Items.Count == 0 || lv.ClientSize.Height <= 0)
            {
                return 0;
            }
            var rowH = lv.GetItemRect(0).Height;
            if (rowH <= 0)
            {
                return 0;
            }
            const int LVM_GETHEADER = 0x101F;
            var headerH = 30;
            var header = SendMessage(new HandleRef(lv, lv.Handle), LVM_GETHEADER, IntPtr.Zero, IntPtr.Zero);
            if (header != IntPtr.Zero && GetWindowRect(header, out var rc))
            {
                headerH = Math.Max(10, rc.Bottom - rc.Top);
            }
            return headerH + rowH * lv.Items.Count > lv.ClientSize.Height
                ? SystemInformation.VerticalScrollBarWidth
                : 0;
        }
        catch
        {
            // Cosmetic only; fall through to no reservation.
        }
        return 0;
    }

    /// <summary>
    /// Vision UX dark strip fix: the OS visual-style theme paints the
    /// TabControl strip and ListView header filler white regardless of
    /// BackColor. In dark mode the theme is removed from those flat surfaces
    /// so the navy tokens show; in light mode the OS theme stays (it already
    /// matches). Cosmetic only — control semantics are untouched. Handle
    /// recreation (e.g. DPI moves) re-syncs through Shown/theme-apply paths.
    /// </summary>
    private void SyncFlatSurfacesTheme()
    {
        try
        {
            var flat = VisualTheme.Mode == ThemeMode.Dark;
            foreach (var surface in new Control[] { _tabs, _lvActivity, _lvJournal, _lvAccounts })
            {
                if (surface is null || !surface.IsHandleCreated)
                {
                    continue;
                }
                _ = SetWindowTheme(surface.Handle, flat ? "" : "Explorer", flat ? "" : null);
                surface.Invalidate(true);
            }
        }
        catch
        {
            // Theming is cosmetic; a failure must never break the shell.
        }
    }

    private Control BuildStatusBar()
    {
        // White application band with a 1px bottom hairline: the top-level
        // chrome carries the identity, live router state and lifecycle
        // actions as one coherent surface.
        //
        // Two-row layout at narrow widths: row 0 = identity + state badge,
        // row 1 = port + version.  At wide widths the original single-row
        // arrangement is restored (52px height, all items in one row).
        var band = new Panel
        {
            Dock = DockStyle.Top,
            Height = 76,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Status bar",
        };
        var separator = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 1,
            BackColor = VisualTheme.CardBorder,
            AccessibleName = "Status bar separator",
        };

        // Stable 6-column grid: identity, dot, badge, version, spacer,
        // right (the port lives in the footer endpoint). The route summary
        // lives on its own strip below (visual slice 1) so the band never
        // overflows at any width.
        var bar = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 6,
            RowCount = 1,
            Padding = new Padding(14, 8, 14, 8),
            BackColor = VisualTheme.SurfaceWhite,
        };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 0 identity
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 1 dot
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 2 badge
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 3 version
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f)); // 4 spacer
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 5 right

        _lblIdentity = new Label
        {
            AutoSize = true,
            Font = VisualTheme.AppTitleFont,
            Text = "GoRouter Desktop",
            ForeColor = VisualTheme.PrimaryText,
            AccessibleName = "GoRouter Desktop",
        };
        _statusDot = new StatusDot
        {
            Margin = new Padding(16, 5, 0, 0),
            AccessibleName = "Router state indicator",
        };
        _lblStateBadge = new Label
        {
            AutoSize = true,
            Font = VisualTheme.StatusFont,
            Text = "Starting…",
            ForeColor = VisualTheme.SecondaryText,
            AccessibleName = "Router state",
        };
        // (Port label retired in 6b: the band overflowed with the theme
        // toggle aboard, and the footer endpoint already carries the port.)
        _lblVersion = new Label
        {
            AutoSize = true,
            Font = VisualTheme.MonoFont,
            Margin = new Padding(14, 1, 0, 0),
            Padding = new Padding(8, 2, 8, 2),
            BackColor = VisualTheme.SurfaceRaised,
            Text = "",
            ForeColor = VisualTheme.SecondaryText,
            AccessibleName = "Desktop version",
        };
        _lblRouteSummary = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            Font = VisualTheme.BodyFont,
            Text = "",
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = VisualTheme.SecondaryText,
            AccessibleName = "Route summary",
            // own strip below the bar: full width available, no crowding

        };

        var right = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Router controls",
        };
        // Outlined action buttons: Stop is danger-red, Start neutral-blue.
        // Short labels (the AccessibleNames carry the full verbs) so the
        // band never overflows: state context sits right beside them in the
        // badge. Enablement stays truthful (UpdateLifecycleButtons).
        _btnStopRouter = ActionButton.DangerSolid("Stop");
        _btnStopRouter.Margin = new Padding(8, 0, 0, 0);
        _btnStopRouter.TabIndex = 4;
        _btnStopRouter.AccessibleName = "Stop router";
        _btnStartRouter = ActionButton.Neutral("Start");
        _btnStartRouter.Margin = new Padding(8, 0, 0, 0);
        _btnStartRouter.TabIndex = 3;
        _btnStartRouter.AccessibleName = "Start router";
        right.Controls.Add(_btnStopRouter);
        right.Controls.Add(_btnStartRouter);

        // Visual slice 6b: manual theme toggle, left of Start in the
        // RightToLeft flow. Text names the TARGET (Dark while light is
        // active). Glyph-free by design (no font-fallback risk).
        _btnTheme = new ActionButton { Text = "Dark" };
        _btnTheme.Margin = new Padding(8, 0, 0, 0);
        _btnTheme.TabIndex = 2;
        _btnTheme.AccessibleName = "Toggle color theme";
        right.Controls.Add(_btnTheme);

        _btnStartRouter.Click += OnStartRouterClicked;
        _btnStopRouter.Click += OnStopRouterClicked;
        _btnTheme.Click += OnThemeToggleClicked;

        // Wide layout: all controls in one row at separate cells.
        bar.Controls.Add(_lblIdentity, 0, 0);
        bar.Controls.Add(_statusDot, 1, 0);
        bar.Controls.Add(_lblStateBadge, 2, 0);
        bar.Controls.Add(_lblVersion, 3, 0);
        bar.Controls.Add(right, 5, 0);

        // Route-summary strip (visual slice 1): full-width second row of the
        // band answering "where is traffic going". Fixed height like the bar
        // (explicit geometry, no mid-layout mutation), aligned to the bar's
        // 14px left padding.
        var summaryStrip = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 24,
            Padding = new Padding(14, 0, 14, 4),
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Route summary strip",
        };
        summaryStrip.Controls.Add(_lblRouteSummary);

        // Bottom stack: separator owns the bottom pixel, the strip sits
        // above it, the bar fills the rest on top.
        band.Controls.Add(bar);
        band.Controls.Add(summaryStrip);
        band.Controls.Add(separator); // docked last so it owns the top strip

        // Responsive two-row layout at narrow widths.
        // All controls remain direct children of bar at all times;
        // only cell positions change via SetRow/SetColumn/SetRowSpan.
        // Reflow is driven by the form Resize event — never from bar.Layout —
        // so the grid is never mutated mid-layout. A width guard makes the
        // transition idempotent: the same width always yields the same mode.
        int _lastReflowClientWidth = -1;
        void ApplyResponsiveReflow()
        {
            var form = FindForm();
            if (form == null) return;
            var clientWidth = form.ClientSize.Width;
            if (clientWidth == _lastReflowClientWidth) return;
            _lastReflowClientWidth = clientWidth;
            bool narrow = clientWidth < 1050;
            if (narrow && bar.RowCount == 1)
            {
                // Narrow: two rows.
                // Row 0: identity, dot, badge
                // Row 1: version, right buttons (spanning rows)
                // +24 for the route-summary strip below the bar.
                band.Height = 96;
                bar.RowCount = 2;
                bar.RowStyles.Clear();
                bar.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                bar.RowStyles.Add(new RowStyle(SizeType.AutoSize));

                bar.SetRow(_lblIdentity, 0); bar.SetColumn(_lblIdentity, 0);
                bar.SetRow(_statusDot, 0);   bar.SetColumn(_statusDot, 1);
                bar.SetRow(_lblStateBadge, 0); bar.SetColumn(_lblStateBadge, 2);
                bar.SetRow(_lblVersion, 1);  bar.SetColumn(_lblVersion, 3);
                bar.SetRow(right, 0);
                bar.SetColumn(right, 5);
                bar.SetRowSpan(right, 2);
            }
            else if (!narrow && bar.RowCount == 2)
            {
                // Wide: single row (+24 summary strip).
                band.Height = 76;
                bar.RowCount = 1;
                bar.RowStyles.Clear();
                bar.RowStyles.Add(new RowStyle(SizeType.AutoSize));

                bar.SetRow(_lblIdentity, 0); bar.SetColumn(_lblIdentity, 0);
                bar.SetRow(_statusDot, 0);   bar.SetColumn(_statusDot, 1);
                bar.SetRow(_lblStateBadge, 0); bar.SetColumn(_lblStateBadge, 2);
                bar.SetRow(_lblVersion, 0);  bar.SetColumn(_lblVersion, 3);
                bar.SetRow(right, 0);
                bar.SetColumn(right, 5);
                bar.SetRowSpan(right, 1);
            }
        }
        Resize += (s, e) => ApplyResponsiveReflow();
        Shown += (s, e) => ApplyResponsiveReflow();

        return band;
    }
    private Control BuildBanner()
    {
        _banner = new Panel
        {
            Dock = DockStyle.Top,
            Height = 40,
            BackColor = VisualTheme.AmberBannerBack,
            Visible = false,
            AccessibleName = "Status banner",
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
            Padding = new Padding(10, 4, 10, 4),
            BackColor = Color.Transparent,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        _lblBannerText = new Label
        {
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = VisualTheme.AmberBannerText,
            AccessibleName = "Status banner message",
        };
        _btnRetry = new Button
        {
            Text = "Retry",
            AutoSize = true,
            Margin = new Padding(8, 0, 0, 0),
            TabIndex = 0,
            AccessibleName = "Retry connecting to control service",
        };
        _btnResetCredential = new Button
        {
            Text = "Reset desktop control credential",
            AutoSize = true,
            Margin = new Padding(8, 0, 0, 0),
            TabIndex = 1,
            AccessibleName = "Reset desktop control credential",
        };
        _btnResumeOnboarding = new Button
        {
            Text = "Resume onboarding",
            AutoSize = true,
            Margin = new Padding(8, 0, 0, 0),
            TabIndex = 2,
            AccessibleName = "Resume first-run onboarding",
        };

        _btnRetry.Click += (_, _) => RetryRequested?.Invoke();
        _btnResetCredential.Click += (_, _) => ResetCredentialRequested?.Invoke();
        _btnResumeOnboarding.Click += (_, _) => OnboardingRequested?.Invoke();

        layout.Controls.Add(_lblBannerText, 0, 0);
        layout.Controls.Add(_btnRetry, 1, 0);
        layout.Controls.Add(_btnResetCredential, 2, 0);
        layout.Controls.Add(_btnResumeOnboarding, 3, 0);
        _banner.Controls.Add(layout);
        return _banner;
    }

    private TabPage BuildRoutingTab()
    {
        _tabHome = new TabPage("Routing")
        {
            BackColor = PageBackColor,
            AccessibleName = "Routing and recent activity",
            AutoScroll = true,
        };

        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = new Padding(VisualTheme.PagePadding, 14, VisualTheme.PagePadding, 14),
            BackColor = PageBackColor,
            AccessibleName = "Lane selection and recent activity",
            MinimumSize = new Size(0, 450),
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        // Lane cards expand to fill the available main area (GO/ZEN stay
        // balanced); the activity card below reserves room for its header
        // and five native ListView rows. With the transparent image slot,
        // rows are ~29px: the 228px bound covers card padding, header, list
        // header, five rows, and bottom slack without starving the lane
        // cards above. (The rare degraded banner consumes some of that
        // bottom slack.) The summary metrics now live in the shared header
        // toolbar, so this page is lanes + activity only.
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 228f));

        var lanes = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 14),
            BackColor = PageBackColor,
            AccessibleName = "Lane cards",
            MinimumSize = new Size(0, 180),
        };
        lanes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
        lanes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));

        lanes.Controls.Add(BuildLaneCard(
            "GO", "go/v1",
            VisualTheme.AccentGo,
            VisualTheme.MarkerGoBack, VisualTheme.MarkerGoText,
            new Padding(0, 0, 10, 0), 0,
            out _cmbGo, out _lblGoFeedback, out _lblGoError, out _goStatusBox), 0, 0);
        lanes.Controls.Add(BuildLaneCard(
            "ZEN", "zen/v1",
            VisualTheme.AccentZen,
            VisualTheme.MarkerZenBack, VisualTheme.MarkerZenText,
            new Padding(10, 0, 0, 0), 1,
            out _cmbZen, out _lblZenFeedback, out _lblZenError, out _zenStatusBox), 1, 0);

        _cmbGo.SelectionChangeCommitted += (_, _) => OnLaneSelectionCommitted("go", _cmbGo, _lblGoFeedback, _lblGoError, () => _routeBusyGo, v => _routeBusyGo = v);
        _cmbZen.SelectionChangeCommitted += (_, _) => OnLaneSelectionCommitted("zen", _cmbZen, _lblZenFeedback, _lblZenError, () => _routeBusyZen, v => _routeBusyZen = v);

        grid.Controls.Add(lanes, 0, 0);
        grid.Controls.Add(BuildRecentActivity(), 0, 1);
        _routingGrid = grid;
        _tabHome.Controls.Add(grid);
        _tabHome.Resize += (_, _) => BeginUpdateRoutingScroll();
        UpdateRoutingScroll();
        return _tabHome;
    }

    private Control BuildLaneCard(
        string title,
        string marker,
        Color accent,
        Color markerBackColor,
        Color markerForeColor,
        Padding margin,
        int tabIndex,
        out ComboBox cmb,
        out Label feedback,
        out Label error,
        out LaneStatusBox statusBox)
    {
        var isGo = string.Equals(title, "GO", StringComparison.Ordinal);
        var card = new LaneCard(title, marker, accent)
        {
            Dock = DockStyle.Fill,
            Margin = margin,
            MinimumSize = new Size(0, 250),
            Padding = new Padding(20, 18, 20, 16),
            AccessibleName = $"{title} lane card",
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 8,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = $"{title} lane controls",
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // 0 header
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // 1 caption
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // 2 selector
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // 3 hint
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // 4 real lane metrics
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f)); // 5 spacer
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 1f));  // 6 separator
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 66f)); // 7 status box (title + detail)

        // Header row: bold lane title + textual lane-surface marker badge,
        // and a right-aligned truthful mode chip (Managed / Attached) that
        // mirrors the target's badge treatment.
        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = $"{title} lane header",
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var titleFlow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight,
            BackColor = VisualTheme.SurfaceWhite,
        };
        titleFlow.Controls.Add(new LaneIcon(isGo)
        {
            Margin = new Padding(0, 0, 10, 0),
        });
        titleFlow.Controls.Add(new Label
        {
            Text = title,
            AutoSize = true,
            Font = VisualTheme.LaneTitleFont,
            ForeColor = VisualTheme.PrimaryText,
            BackColor = VisualTheme.SurfaceWhite,
            Margin = new Padding(0, 4, 0, 0),
            AccessibleName = $"{title} lane title",
        });
        titleFlow.Controls.Add(new Label
        {
            Text = marker,
            AutoSize = true,
            Margin = new Padding(10, 3, 0, 0),
            Padding = new Padding(7, 1, 7, 1),
            BackColor = markerBackColor,
            ForeColor = markerForeColor,
            Font = VisualTheme.SmallFont,
            AccessibleName = $"{title} lane marker",
        });

        var modeChip = new Label
        {
            AutoSize = true,
            Padding = new Padding(9, 1, 9, 1),
            Font = VisualTheme.SmallFont,
            TextAlign = ContentAlignment.MiddleLeft,
            Visible = false,
        };
        if (string.Equals(title, "ZEN", StringComparison.Ordinal))
        {
            _lblZenMode = modeChip;
        }
        else
        {
            _lblGoMode = modeChip;
        }

        header.Controls.Add(titleFlow, 0, 0);
        header.Controls.Add(modeChip, 2, 0);

        var caption = new Label
        {
            Text = "Account serving this lane",
            AutoSize = true,
            Font = VisualTheme.FieldLabelFont,
            Margin = new Padding(0, 4, 0, 4),
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = $"{title} lane hint",
        };

        // Persistent explanation, readable at rest: switching is not
        // retroactive. The status box below repeats the exact outcome wording
        // ("new requests use ...; in-flight requests keep their original
        // route") once a switch has happened.
        var switchingHint = new Label
        {
            Text = "Switching affects new requests only.",
            AutoSize = true,
            Font = VisualTheme.CaptionFont,
            Margin = new Padding(0, 6, 0, 4),
            MaximumSize = new Size(360, 0),
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = $"{title} lane switching hint",
        };

        cmb = new StyledSelector
        {
            Dock = DockStyle.Fill,
            Height = 34,
            Margin = new Padding(0, 4, 0, 2),
            TabIndex = tabIndex,
            AccessibleName = $"{title} account selection",
        };

        // The status box hosts the existing feedback/error labels (field
        // names and text semantics preserved); the box paints the green
        // confirmation / red error / neutral resting surface around them.
        statusBox = new LaneStatusBox
        {
            Dock = DockStyle.Fill,
            // 6px top breathing room: with the lane spacer collapsed the
            // mint box would otherwise kiss the separator above it.
            Margin = new Padding(0, 6, 0, 0),
            AccessibleName = $"{title} route confirmation",
        };
        feedback = statusBox.FeedbackLabel;
        feedback.AccessibleName = $"{title} lane feedback";
        error = statusBox.ErrorLabel;
        error.AccessibleName = $"{title} lane error";

        var separator = new Panel
        {
            Dock = DockStyle.Fill,
            Height = 1,
            BackColor = VisualTheme.Separator,
            Margin = new Padding(0, 4, 0, 4),
        };

        // Real lane metrics: truthful local derivation from the loaded
        // journal.recent window (no backend change); em-dashes until data.
        var metrics = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0, 8, 0, 2),
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = $"{title} lane metrics",
        };
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33f));
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33f));
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34f));
        var blockReq = new MetricBlock("Requests (1h)", compact: true);
        var blockRate = new MetricBlock("Success Rate", compact: true);
        var blockLatency = new MetricBlock("Avg. Latency", compact: true);
        if (isGo)
        {
            _goReq = blockReq;
            _goRate = blockRate;
            _goLatency = blockLatency;
        }
        else
        {
            _zenReq = blockReq;
            _zenRate = blockRate;
            _zenLatency = blockLatency;
        }
        metrics.Controls.Add(blockReq, 0, 0);
        metrics.Controls.Add(blockRate, 1, 0);
        metrics.Controls.Add(blockLatency, 2, 0);

        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(caption, 0, 1);
        layout.Controls.Add(cmb, 0, 2);
        layout.Controls.Add(switchingHint, 0, 3);
        layout.Controls.Add(metrics, 0, 4);
        layout.Controls.Add(separator, 0, 6);
        layout.Controls.Add(statusBox, 0, 7);
        card.Controls.Add(layout);
        return card;
    }

    private Control BuildRecentActivity()
    {
        var card = new CardPanel
        {
            Dock = DockStyle.Fill,
            MinimumSize = new Size(0, 120),
            Padding = new Padding(16, 10, 16, 10),
            AccessibleName = "Recent activity",
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Recent activity view",
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // header follows actual font height
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));      // degraded banner (collapses when hidden)
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f)); // rows

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Recent activity header",
            AutoSize = true,
            MinimumSize = new Size(0, 34),
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        header.Controls.Add(new Label
        {
            Text = "Recent activity",
            AutoSize = true,
            Font = VisualTheme.SectionTitleFont,
            ForeColor = VisualTheme.PrimaryText,
            BackColor = VisualTheme.SurfaceWhite,
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Recent activity title",
        }, 0, 0);
        header.Controls.Add(new Label
        {
            Dock = DockStyle.Fill,
            Text = "Latest requests (up to 5).",
            Font = VisualTheme.CaptionFont,
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            Margin = new Padding(12, 0, 0, 0),
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Recent activity caption",
        }, 1, 0);

        _btnActivityViewAll = new Button
        {
            Text = "View all",
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 0 },
            ForeColor = VisualTheme.AccentBlue,
            BackColor = VisualTheme.SurfaceWhite,
            Font = VisualTheme.BodyFont,
            Cursor = Cursors.Hand,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(12, 0, 0, 0),
            TabIndex = 3,
            AccessibleName = "View all recent activity in the Journal tab",
        };
        _btnActivityViewAll.Click += (_, _) => NavigateTo(ViewTarget.Journal);
        header.Controls.Add(_btnActivityViewAll, 2, 0);

        _lblActivityDegraded = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            Font = VisualTheme.SmallFont,
            ForeColor = VisualTheme.AmberBannerText,
            BackColor = VisualTheme.AmberBannerBack,
            Padding = new Padding(8, 3, 8, 3),
            Margin = new Padding(0, 3, 0, 3),
            Visible = false,
            AccessibleName = "Recent activity degraded banner",
        };

        var listHost = new Panel
        {
            Dock = DockStyle.Fill,
            MinimumSize = new Size(0, 40),
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Recent activity rows",
        };
        _lvActivity = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            MultiSelect = false,
            HideSelection = false,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            BorderStyle = BorderStyle.None,
            TabIndex = 2,
            AccessibleName = "Recent activity rows",
        };
        _lvActivity.Columns.Add("Time", 180);
        _lvActivity.Columns.Add("Lane", 60);
        _lvActivity.Columns.Add("Account", 120);
        _lvActivity.Columns.Add("Family / Method", 200);
        // Outcome fits long live names (e.g. upstream_error) untruncated.
        _lvActivity.Columns.Add("Outcome", 124);
        _lvActivity.Columns.Add("Status", 70);
        _lvActivity.Columns.Add("Latency", 110);
        StyleDetailsListView(_lvActivity, alternateRows: true, outcomeColumn: 4, statusColumn: 5, laneColumn: 1);
        _lvActivity.Resize += (_, _) => FitActivityColumns();
        listHost.Controls.Add(_lvActivity);

        // Designed empty state: illustration + note covers the (empty) list.
        _lblActivityEmpty = MakeEmptyState(
            "No requests yet — recent activity will appear here once the router serves traffic.",
            "Empty recent activity note");
        listHost.Controls.Add(_lblActivityEmpty);

        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(_lblActivityDegraded, 0, 1);
        layout.Controls.Add(listHost, 0, 2);
        card.Controls.Add(layout);
        return card;
    }

    /// <summary>
    /// Visual slice 4: illustrated empty state — a large muted glyph over the
    /// one-line copy, vertically centered. Same Dock/Visible contract as the
    /// label it replaces.
    /// </summary>
    private static Control MakeEmptyState(string copy, string accessibleName)
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = accessibleName,
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            BackColor = VisualTheme.SurfaceWhite,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
        var glyph = new Label
        {
            Text = "○",
            AutoSize = true,
            Anchor = AnchorStyles.None,
            Font = VisualTheme.EmptyGlyphFont,
            ForeColor = VisualTheme.MutedText,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Empty state illustration",
        };
        var label = new Label
        {
            Text = copy,
            AutoSize = true,
            Anchor = AnchorStyles.None,
            MaximumSize = new Size(460, 0),
            Font = VisualTheme.BodyFont,
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            TextAlign = ContentAlignment.MiddleCenter,
            AccessibleName = accessibleName + " text",
        };
        layout.Controls.Add(glyph, 0, 1);
        layout.Controls.Add(label, 0, 2);
        panel.Controls.Add(layout);
        return panel;
    }

    /// <summary>
    /// Modern details-list styling: no gridlines, white/alternate row
    /// tinting, small fonts, painted column headers. Accessibility is
    /// unaffected — it is still a standard ListView.
    /// </summary>
    private static void StyleDetailsListView(ListView lv, bool alternateRows, int outcomeColumn = -1, int statusColumn = -1, int laneColumn = -1)
    {
        lv.BackColor = VisualTheme.SurfaceWhite;
        lv.ForeColor = VisualTheme.PrimaryText;
        lv.GridLines = false;
        lv.Font = VisualTheme.TableFont;
        // WinForms derives Details row height from the native font metrics,
        // which can leave owner-drawn glyphs clipped at the current DPI. A
        // transparent small-image slot reserves a taller native row without
        // changing the visible table or its accessibility tree.
        var rowHeight = TextRenderer.MeasureText("Ag", VisualTheme.TableFont).Height + 8;
        var rowImages = new ImageList
        {
            ImageSize = new Size(1, rowHeight),
            ColorDepth = ColorDepth.Depth32Bit,
        };
        rowImages.Images.Add(new Bitmap(1, rowHeight));
        lv.SmallImageList = rowImages;
        if (!alternateRows)
        {
            return;
        }

        lv.OwnerDraw = true;
        lv.DrawColumnHeader += (_, e) =>
        {
            using var back = new SolidBrush(VisualTheme.SurfaceWhite);
            e.Graphics.FillRectangle(back, e.Bounds);
            using var line = new Pen(VisualTheme.CardBorder);
            e.Graphics.DrawLine(line, e.Bounds.Right, e.Bounds.Y, e.Bounds.Right, e.Bounds.Bottom);
            TextRenderer.DrawText(
                e.Graphics,
                lv.Columns[e.ColumnIndex].Text,
                VisualTheme.TableFont,
                e.Bounds,
                VisualTheme.SecondaryText,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        };
        lv.DrawSubItem += (_, e) =>
        {
            var selected = (e.ItemState & ListViewItemStates.Selected) != 0;
            var back = selected
                ? VisualTheme.SelectedRowBack
                : e.ItemIndex % 2 == 1 ? VisualTheme.RowAltBack : VisualTheme.SurfaceWhite;
            using var brush = new SolidBrush(back);
            e.Graphics.FillRectangle(brush, e.Bounds);
            // Vision UX cells: lane renders as a small GO (green/teal) or ZEN
            // (purple/violet) chip; outcome/status stay colored text (selected
            // rows keep readability — all state colors contrast on both row
            // backgrounds). Outcome names are never remapped.
            if (e.ColumnIndex == laneColumn)
            {
                var isGo = string.Equals(e.SubItem?.Text, "GO", StringComparison.OrdinalIgnoreCase);
                var accent = isGo ? VisualTheme.AccentGo : VisualTheme.AccentZen;
                var tint = isGo ? VisualTheme.GoSurface : VisualTheme.ZenSurface;
                var chip = new Rectangle(e.Bounds.X + 2, e.Bounds.Y + 3, e.Bounds.Width - 4, e.Bounds.Height - 6);
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                VisualTheme.FillRounded(e.Graphics, chip, 6, tint);
                TextRenderer.DrawText(
                    e.Graphics,
                    e.SubItem?.Text ?? string.Empty,
                    VisualTheme.TableFont,
                    chip,
                    accent,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                return;
            }
            var fore = VisualTheme.PrimaryText;
            if (e.ColumnIndex == outcomeColumn)
            {
                fore = VisualTheme.OutcomeColor(e.SubItem?.Text);
            }
            else if (e.ColumnIndex == statusColumn)
            {
                fore = VisualTheme.StatusColor(e.SubItem?.Text);
            }
            TextRenderer.DrawText(
                e.Graphics,
                e.SubItem?.Text ?? string.Empty,
                VisualTheme.TableFont,
                e.Bounds,
                fore,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        };
    }

    /// <summary>
    /// Fill-column fits: the absorbent column takes leftover width (bounded
    /// below) so tables span the card with no unthemed header filler in dark
    /// mode and no clipped timestamps. No-ops before layout (width 0).
    /// </summary>
    private void FitActivityColumns()
    {
        var total = _lvActivity.ClientSize.Width;
        if (total <= 0 || _lvActivity.Columns.Count < 7)
        {
            return;
        }
        const int fixedOthers = 180 + 60 + 120 + 124 + 70 + 110;
        _lvActivity.Columns[3].Width = Math.Max(140, total - fixedOthers - VScrollAllowance(_lvActivity) - 4);
    }

    private void FitJournalColumns()
    {
        var total = _lvJournal.ClientSize.Width;
        if (total <= 0 || _lvJournal.Columns.Count < 9)
        {
            return;
        }
        const int fixedOthers = 180 + 60 + 120 + 150 + 110 + 118 + 70 + 90;
        _lvJournal.Columns[8].Width = Math.Max(180, total - fixedOthers - VScrollAllowance(_lvJournal) - 4);
    }

    private void FitAccountsColumns()
    {
        var total = _lvAccounts.ClientSize.Width;
        if (total <= 0 || _lvAccounts.Columns.Count < 4)
        {
            return;
        }
        const int fixedOthers = 140 + 220 + 70;
        _lvAccounts.Columns[3].Width = Math.Max(120, total - fixedOthers - VScrollAllowance(_lvAccounts) - 4);
    }

    private Control BuildFooter()
    {
        _footer = new Panel
        {
            Dock = DockStyle.Fill,
            Height = 34,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = "Footer status",
        };
        var separator = new Panel
        {
            Dock = DockStyle.Top,
            Height = 1,
            BackColor = VisualTheme.CardBorder,
            AccessibleName = "Footer separator",
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Padding = new Padding(14, 0, 14, 0),
            BackColor = VisualTheme.SurfaceWhite,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        // Vision UX slim footer: product identity left, local endpoint +
        // copy right. State display lives in exactly one place (the header
        // badge); the endpoint text itself is unchanged (actual port).
        var identity = new Label
        {
            AutoSize = true,
            Font = VisualTheme.SmallFont,
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            Text = "GoRouter Desktop  ·  Local routing control center",
            TextAlign = ContentAlignment.MiddleLeft,
            Anchor = AnchorStyles.Left,
            AccessibleName = "Footer product identity",
        };
        _lblFooter = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            Font = VisualTheme.MonoFont,
            ForeColor = VisualTheme.AccentBlue,
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Desktop release and local endpoint",
        };
        var copy = new Button
        {
            Text = "Copy",
            AutoSize = false,
            Size = new Size(64, 24),
            FlatStyle = FlatStyle.Flat,
            MinimumSize = new Size(64, 24),
            Margin = new Padding(8, 4, 0, 4),
            TabIndex = 60,
            AccessibleName = "Copy local endpoint",
        };
        copy.FlatAppearance.BorderSize = 1;
        copy.FlatAppearance.BorderColor = VisualTheme.CardBorder;
        copy.BackColor = VisualTheme.SurfaceWhite;
        copy.ForeColor = VisualTheme.SecondaryText;
        copy.Font = VisualTheme.SmallFont;
        copy.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText(_lblFooter.Text);
            }
            catch
            {
                // Clipboard unavailable (RDP/lockdown): endpoint text stays
                // selectable-readable; no error surface for a convenience.
            }
        };

        layout.Controls.Add(identity, 0, 0);
        layout.Controls.Add(_lblFooter, 1, 0);
        layout.Controls.Add(copy, 2, 0);
        _footer.Controls.Add(layout);
        _footer.Controls.Add(separator); // docked last so it owns the top strip
        return _footer;
    }


    private void BeginUpdateRoutingScroll()
    {
        try
        {
            if (_tabHome == null || _tabHome.IsDisposed || !_tabHome.IsHandleCreated) { UpdateRoutingScroll(); return; }
            _tabHome.BeginInvoke(new Action(() => UpdateRoutingScroll()));
        }
        catch { }
    }

    private void UpdateRoutingScroll()
    {
        if (_tabHome == null || _routingGrid == null) { return; }
        if (_tabHome.IsDisposed || _routingGrid.IsDisposed) { return; }
        if (!_tabHome.IsHandleCreated) { return; }
        try
        {
            int need = _routingGrid.PreferredSize.Height;
            bool overflow = need > _tabHome.ClientSize.Height;
            if (overflow && _routingGrid.Dock != DockStyle.Top)
            {
                _routingGrid.Dock = DockStyle.Top;
                _routingGrid.AutoSize = true;
                _routingGrid.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            }
            else if (!overflow && _routingGrid.Dock != DockStyle.Fill)
            {
                _routingGrid.AutoSize = false;
                _routingGrid.Dock = DockStyle.Fill;
            }
        }
        catch { }
    }

    private TabPage BuildAccountsTab()
    {
        var page = new TabPage("Accounts") { AccessibleName = "Accounts" };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 2,
            Padding = new Padding(10),
            AccessibleName = "Account management",
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        _lvAccounts = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            MultiSelect = false,
            HideSelection = false,
            GridLines = false,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            BorderStyle = BorderStyle.None,
            TabIndex = 0,
            AccessibleName = "Accounts list",
        };
        _lvAccounts.Columns.Add("Alias", 140);
        _lvAccounts.Columns.Add("ID", 220);
        _lvAccounts.Columns.Add("Secret", 70);
        _lvAccounts.Columns.Add("Used by", 120);
        // Vision UX flat table: shared owner-drawn header/rows, no grid
        // chrome; the last column absorbs leftover width so no unthemed
        // header filler shows in dark mode.
        StyleDetailsListView(_lvAccounts, alternateRows: true);
        _lvAccounts.Resize += (_, _) => FitAccountsColumns();

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(8, 0, 0, 0),
            AccessibleName = "Account actions",
        };
        MakeAccountButton("Add…", 1, out _btnAddAccount, OnAddAccountClicked);
        MakeAccountButton("Update credential…", 2, out _btnUpdateCredential, OnUpdateCredentialClicked);
        MakeAccountButton("Rename…", 3, out _btnRenameAccount, OnRenameClicked);
        MakeAccountButton("Remove…", 4, out _btnRemoveAccount, OnRemoveClicked);
        MakeAccountButton("Test…", 5, out _btnTestAccount, OnTestClicked);
        buttons.Controls.AddRange(new Control[] { _btnAddAccount, _btnUpdateCredential, _btnRenameAccount, _btnRemoveAccount, _btnTestAccount });

        _lblAccountsStatus = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            AccessibleName = "Account operation feedback",
        };

        layout.Controls.Add(_lvAccounts, 0, 0);
        layout.Controls.Add(buttons, 1, 0);
        layout.Controls.Add(_lblAccountsStatus, 0, 1);
        layout.SetColumnSpan(_lblAccountsStatus, 2);
        page.Controls.Add(layout);
        return page;
    }

    private static void MakeAccountButton(string text, int tabIndex, out Button button, EventHandler onClick)
    {
        button = new Button
        {
            Text = text,
            AutoSize = true,
            Margin = new Padding(0, 2, 0, 2),
            TabIndex = tabIndex,
            AccessibleName = text.TrimEnd('…', '.'),
        };
        button.Click += onClick;
    }

    private TabPage BuildJournalTab()
    {
        var page = new TabPage("Journal") { AccessibleName = "Request journal" };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(10),
            AccessibleName = "Journal view",
        };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var header = new TableLayoutPanel
        {
            // Independent vertical constraint: the header sizes itself to its
            // content (AutoSize) instead of Dock.Fill inside an AutoSize row —
            // the AutoSize+Dock.Fill combination is a circular sizing
            // dependency that collapses the row at narrow widths / high DPI
            // and clips the Back/Refresh buttons under the list view.
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 1,
            AccessibleName = "Journal header",
        };
        // Preferred header arrangement: [ ← Back ] [ stats ] [ Refresh ].
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 0 Back
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f)); // 1 stats
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); // 2 Refresh
        header.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _lblJournalStats = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Journal statistics",
        };
        _btnJournalBack = new Button
        {
            Text = "← Back",
            AutoSize = true,
            Margin = new Padding(0, 0, 10, 0),
            TabIndex = 0,
            AccessibleName = "Back to account selection",
        };
        _btnJournalBack.Click += (_, _) => NavigateTo(ViewTarget.Dashboard);
        _btnJournalRefresh = new Button
        {
            Text = "Refresh",
            AutoSize = true,
            TabIndex = 1,
            AccessibleName = "Refresh journal",
        };
        // Visual slice 8: the explicit Refresh click carries a busy
        // affordance (tab-selection refreshes reuse the quiet path below).
        _btnJournalRefresh.Click += (_, _) => _ = RefreshJournalWithBusyAsync();
        header.Controls.Add(_btnJournalBack, 0, 0);
        header.Controls.Add(_lblJournalStats, 1, 0);
        header.Controls.Add(_btnJournalRefresh, 2, 0);

        _lblJournalDegraded = new Label
        {
            AutoSize = true,
            ForeColor = VisualTheme.AmberBannerText,
            BackColor = VisualTheme.AmberBannerBack,
            Dock = DockStyle.Fill,
            Padding = new Padding(4),
            Visible = false,
            AccessibleName = "Journal degraded banner",
        };

        _lvJournal = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            MultiSelect = false,
            HideSelection = false,
            GridLines = false,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            BorderStyle = BorderStyle.None,
            TabIndex = 1,
            AccessibleName = "Recent requests",
        };
        _lvJournal.Columns.Add("Time", 180);
        _lvJournal.Columns.Add("Lane", 60);
        _lvJournal.Columns.Add("Account", 120);
        _lvJournal.Columns.Add("Family", 150);
        _lvJournal.Columns.Add("Method", 110);
        _lvJournal.Columns.Add("Outcome", 118);
        _lvJournal.Columns.Add("Status", 70);
        _lvJournal.Columns.Add("Duration ms", 90);
        _lvJournal.Columns.Add("Request ID", 210);
        // Vision UX flat table: lane chips plus outcome/status coloring via
        // the shared renderer; Request ID absorbs leftover width so no
        // unthemed header filler shows in dark mode.
        StyleDetailsListView(_lvJournal, alternateRows: true, outcomeColumn: 5, statusColumn: 6, laneColumn: 1);
        _lvJournal.Resize += (_, _) => FitJournalColumns();

        _lblJournalEmpty = MakeEmptyState(
            "No requests recorded yet — send traffic to the local endpoint and it will appear here.",
            "Empty journal note");

        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(_lblJournalDegraded, 0, 1);
        layout.Controls.Add(_lvJournal, 0, 2);
        layout.Controls.Add(_lblJournalEmpty, 0, 3);
        page.Controls.Add(layout);
        return page;
    }

    private TabPage BuildSystemTab()
    {
        var page = new TabPage("System") { AccessibleName = "System and settings" };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Padding = new Padding(10),
            AccessibleName = "System information and settings",
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60f));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40f));

        var left = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            AccessibleName = "System and settings controls",
        };
        left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        left.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        // --- system group ---
        // AutoSize group + Top-docked layout (slice 7): GroupBox does not
        // derive its preferred size from a Dock=Fill child, so the group
        // frame collapsed to ~2 rows and clipped the rest. Content-sized
        // in both directions, the frame always wraps its rows.
        var sysGroup = new GroupBox
        {
            Text = "System",
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(10),
            AccessibleName = "System information",
        };
        var sysLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 4,
            AccessibleName = "System information values",
        };
        sysLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        sysLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        // Explicit content-sized rows (slice 7): value labels fill in late
        // from the snapshot tick, and implicit rows measured them at empty
        // height, clipping Journal/Router rows out of the group frame.
        for (var i = 0; i < 4; i++)
        {
            sysLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        sysLayout.Controls.Add(MakeFieldLabel("State directory", "State directory label"), 0, 0);
        _lblStateDirValue = new Label
        {
            AutoSize = true,
            Font = VisualTheme.MonoFont,
            AccessibleName = "State directory",
        };
        sysLayout.Controls.Add(_lblStateDirValue, 1, 0);

        sysLayout.Controls.Add(MakeFieldLabel("Secret store", "Secret store label"), 0, 1);
        _lblSecretStoreValue = new Label
        {
            AutoSize = true,
            AccessibleName = "Secret store status",
        };
        sysLayout.Controls.Add(_lblSecretStoreValue, 1, 1);

        sysLayout.Controls.Add(MakeFieldLabel("Journal", "Journal label"), 0, 2);
        _lblJournalInfoValue = new Label
        {
            AutoSize = true,
            AccessibleName = "Journal statistics",
        };
        sysLayout.Controls.Add(_lblJournalInfoValue, 1, 2);

        sysLayout.Controls.Add(MakeFieldLabel("Router", "Router label"), 0, 3);
        _lblRouterInfoValue = new Label
        {
            AutoSize = true,
            AccessibleName = "Router mode and process",
        };
        sysLayout.Controls.Add(_lblRouterInfoValue, 1, 3);

        sysGroup.Controls.Add(sysLayout);

        // --- settings group ---
        // Same content-sized pattern as the System group (slice 7).
        var settingsGroup = new GroupBox
        {
            Text = "Settings",
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(10),
            AccessibleName = "Desktop settings",
        };
        var settingsLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 3,
            RowCount = 8,
            AccessibleName = "Desktop settings controls",
        };
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        // Explicit content-sized rows: every settings row measures itself,
        // so late snapshot text can never clip a row (slice 7).
        for (var i = 0; i < 8; i++)
        {
            settingsLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        _chkStartAtLogin = new CheckBox
        {
            Text = "Start GoRouter Desktop at Windows login",
            AutoSize = true,
            TabIndex = 0,
            AccessibleName = "Start at Windows login",
        };
        settingsLayout.Controls.Add(_chkStartAtLogin, 0, 0);
        settingsLayout.SetColumnSpan(_chkStartAtLogin, 3);

        _chkMinimizeToTray = new CheckBox
        {
            Text = "Minimize to tray instead of the taskbar",
            AutoSize = true,
            TabIndex = 1,
            AccessibleName = "Minimize to tray",
        };
        settingsLayout.Controls.Add(_chkMinimizeToTray, 0, 1);
        settingsLayout.SetColumnSpan(_chkMinimizeToTray, 3);

        settingsLayout.Controls.Add(MakeFieldLabel("Router port", "Router port label"), 0, 2);
        _txtPort = new TextBox
        {
            Width = 90,
            TabIndex = 2,
            AccessibleName = "Router port",
        };
        settingsLayout.Controls.Add(_txtPort, 1, 2);
        _btnApplyPort = new Button
        {
            Text = "Apply port",
            AutoSize = true,
            TabIndex = 3,
            AccessibleName = "Apply router port",
        };
        _btnApplyPort.Click += OnApplyPortClicked;
        settingsLayout.Controls.Add(_btnApplyPort, 2, 2);

        var lblPortNote = new Label
        {
            Text = "Applies to the next router start.",
            AutoSize = true,
            ForeColor = VisualTheme.IdleDot,
            AccessibleName = "Port change note",
        };
        settingsLayout.Controls.Add(lblPortNote, 0, 3);
        settingsLayout.SetColumnSpan(lblPortNote, 3);

        _lblPortError = new Label
        {
            AutoSize = true,
            ForeColor = VisualTheme.ErrorText,
            AccessibleName = "Port validation error",
        };
        settingsLayout.Controls.Add(_lblPortError, 0, 4);
        settingsLayout.SetColumnSpan(_lblPortError, 3);

        settingsLayout.Controls.Add(MakeFieldLabel("Journal retention (days)", "Journal retention label"), 0, 5);
        _txtRetentionDays = new TextBox
        {
            Width = 90,
            TabIndex = 4,
            AccessibleName = "Journal retention days",
        };
        settingsLayout.Controls.Add(_txtRetentionDays, 1, 5);

        settingsLayout.Controls.Add(MakeFieldLabel("Journal max records", "Journal max records label"), 0, 6);
        _txtMaxRecords = new TextBox
        {
            Width = 90,
            TabIndex = 5,
            AccessibleName = "Journal max records",
        };
        settingsLayout.Controls.Add(_txtMaxRecords, 1, 6);
        _btnApplyRetention = new Button
        {
            Text = "Apply",
            AutoSize = true,
            TabIndex = 6,
            AccessibleName = "Apply journal retention and max records",
        };
        _btnApplyRetention.Click += OnApplyRetentionClicked;
        settingsLayout.Controls.Add(_btnApplyRetention, 2, 6);

        _lblRetentionError = new Label
        {
            AutoSize = true,
            ForeColor = VisualTheme.ErrorText,
            AccessibleName = "Journal settings validation error",
        };
        settingsLayout.Controls.Add(_lblRetentionError, 0, 7);
        settingsLayout.SetColumnSpan(_lblRetentionError, 3);

        // Visual slice 7: this parent link was missing, so the whole
        // Settings group rendered as an empty frame.
        settingsGroup.Controls.Add(settingsLayout);

        left.Controls.Add(sysGroup, 0, 0);
        left.Controls.Add(settingsGroup, 0, 1);

        // --- diagnostics group ---
        var right = new GroupBox
        {
            Text = "Diagnostics",
            Dock = DockStyle.Fill,
            Padding = new Padding(10),
            AccessibleName = "Redacted diagnostics",
        };
        var diagLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            AccessibleName = "Diagnostics controls",
        };
        diagLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        diagLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        diagLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var diagNote = new Label
        {
            Text = "Copies redacted runtime facts to the clipboard. Credentials, tokens and secrets are never included.",
            AutoSize = true,
            MaximumSize = new Size(320, 0),
            AccessibleName = "Diagnostics note",
        };
        var btnCopy = new Button
        {
            Text = "Copy redacted diagnostics",
            AutoSize = true,
            TabIndex = 7,
            AccessibleName = "Copy redacted diagnostics",
        };
        btnCopy.Click += OnCopyDiagnosticsClicked;
        _lblDiagnosticsFeedback = new Label
        {
            AutoSize = true,
            AccessibleName = "Diagnostics feedback",
        };

        diagLayout.Controls.Add(diagNote, 0, 0);
        diagLayout.Controls.Add(btnCopy, 0, 1);
        diagLayout.Controls.Add(_lblDiagnosticsFeedback, 0, 2);
        right.Controls.Add(diagLayout);

        layout.Controls.Add(left, 0, 0);
        layout.Controls.Add(right, 1, 0);
        page.Controls.Add(layout);
        return page;
    }

    private static Label MakeFieldLabel(string text, string accessibleName) => new()
    {
        Text = text,
        AutoSize = true,
        Margin = new Padding(0, 4, 10, 4),
        AccessibleName = accessibleName,
    };

    // ------------------------------------------------------------------
    // Channel wiring
    // ------------------------------------------------------------------

    private void OnChannelStateChanged(ClientState state)
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action<ClientState>(SetClientState), state);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        SetClientState(state);
    }

    private void OnChannelSnapshot(ShellSnapshot snapshot)
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action<ShellSnapshot>(ApplySnapshot), snapshot);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        // A fresh authoritative snapshot retires the protocol warning:
        // the next failure re-arms it. Clearing here (not in ApplySnapshot)
        // keeps direct ApplySnapshot test injection honest.
        _protocolWarning = null;
        ApplySnapshot(snapshot);
    }

    internal string? ProtocolWarning => _protocolWarning;

    internal bool IsProtocolBannerVisible => _banner.Visible && _protocolWarning is not null;

    private void OnChannelProtocolError(string message)
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action<string>(OnChannelProtocolError), message);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        // Sanitized diagnostic only (channel never forwards raw frames).
        _protocolWarning = string.IsNullOrWhiteSpace(message)
            ? "Control snapshot rejected (protocol error) — waiting for authoritative state."
            : UiText.Truncate(message, 240);
        RefreshBanner();
    }

    /// <summary>Test-only direct protocol-error injection (no channel).</summary>
    internal void SetProtocolWarningForTest(string message)
    {
        _protocolWarning = UiText.Truncate(message, 240);
        RefreshBanner();
    }

    internal void ClearProtocolWarningForTest()
    {
        _protocolWarning = null;
        RefreshBanner();
    }

    public void SetClientState(ClientState state)
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action<ClientState>(SetClientState), state);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        _clientState = state;
        var connected = state == ClientState.Connected;

        _banner.Visible = state is not ClientState.Connected;
        switch (state)
        {
            case ClientState.Starting:
                _banner.BackColor = VisualTheme.AmberBannerBack;
                _lblBannerText.ForeColor = VisualTheme.AmberBannerText;
                _lblBannerText.Text = "Starting control service…";
                _btnRetry.Visible = false;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.Reconnecting:
                _banner.BackColor = VisualTheme.AmberBannerBack;
                _lblBannerText.ForeColor = VisualTheme.AmberBannerText;
                _lblBannerText.Text = "Reconnecting to control service…";
                _btnRetry.Visible = false;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.Unavailable:
                _banner.BackColor = VisualTheme.ErrorBoxBack;
                _lblBannerText.ForeColor = VisualTheme.ErrorBoxText;
                _lblBannerText.Text = _channel.LastError ?? "Control service unavailable.";
                _btnRetry.Visible = true;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.AuthFailed:
                _banner.BackColor = VisualTheme.ErrorBoxBack;
                _lblBannerText.ForeColor = VisualTheme.ErrorBoxText;
                _lblBannerText.Text = _channel.LastError ?? "Control service authentication failed.";
                _btnRetry.Visible = true;
                _btnResetCredential.Visible = true;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.Connected:
                break;
        }

        foreach (var control in _mutationControls)
        {
            control.Enabled = connected;
        }

        if (connected)
        {
            // Re-apply the honest state-based affordances after the blanket
            // enable above: e.g. Start/Stop must not light up merely because
            // the channel connected.
            UpdateLifecycleButtons();
        }
        else
        {
            // The activity preview cannot be refreshed without a connection:
            // show the designed non-degraded empty state while the banner
            // above carries the connectivity error. Journal rows are not
            // "missing" merely because the service is starting.
            RenderRecentActivity(Array.Empty<JournalRow>(), false, null);
        }
    }

    /// <summary>Rendered state badge text (used by the selftest settle-check).</summary>
    internal string StateBadgeText => _lblStateBadge.Text;

    /// <summary>Deterministic rendering hooks for the snapshot-contract selftest (no secrets).</summary>
    internal int AccountRowCountForTest => _lvAccounts.Items.Count;
    internal IReadOnlyList<string> AccountAliasesForTest => _lvAccounts.Items.Cast<ListViewItem>().Select(i => i.Text).ToList();
    internal IReadOnlyList<string> GoOptionAliasesForTest => _cmbGo.Items.Cast<AccountOption>().Select(o => o.Alias).ToList();
    internal IReadOnlyList<string> ZenOptionAliasesForTest => _cmbZen.Items.Cast<AccountOption>().Select(o => o.Alias).ToList();
    internal string? GoSelectedAliasForTest => (_cmbGo.SelectedItem as AccountOption)?.Alias;
    internal string? ZenSelectedAliasForTest => (_cmbZen.SelectedItem as AccountOption)?.Alias;
    internal string RouterInfoForTest => _lblRouterInfoValue.Text;
    internal string RetentionTextboxForTest => _txtRetentionDays.Text;
    internal string JournalInfoForTest => _lblJournalInfoValue.Text;

    /// <summary>
    /// Test-only helper for offline visual selftest evidence: assigns the
    /// existing post-success lane confirmation wording to the GO/ZEN feedback
    /// label so a captured PNG/a11y dump proves the exact copy. It never calls
    /// the channel and never mutates runtime state; product code paths never
    /// invoke it.
    /// </summary>
    internal void SetSelftestRouteConfirmation(string lane, string alias)
    {
        var message = alias is null ? "Lane cleared; new requests are not routed. In-flight requests keep their original route." : "New route; in-flight same.";
        if (string.Equals(lane, "zen", StringComparison.OrdinalIgnoreCase))
        {
            _lblZenFeedback.Text = message;
        }
        else
        {
            _lblGoFeedback.Text = message;
        }

        UpdateLaneStatusBoxes(_snapshot.Routes.Go, _snapshot.Routes.Zen);
    }

    /// <summary>True when the rendered badge matches the injected snapshot's router state.</summary>
    internal bool RenderedStateMatches(ShellSnapshot snapshot)
    {
        var state = snapshot.Router.State switch
        {
            "running" => "Running",
            "degraded" => "Degraded",
            "starting" => "Starting",
            "stopped" => "Stopped",
            "port_conflict" => "Port conflict",
            "failed" => "Failed",
            _ => snapshot.Router.State,
        };
        var mode = snapshot.Router.Mode switch
        {
            "attached" => "attached",
            "managed" => "managed",
            _ => "",
        };
        var expected = mode.Length > 0 ? $"{state} ({mode})" : state;
        return string.Equals(StateBadgeText, expected, StringComparison.Ordinal);
    }

    public void SetBannerError(string message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<string>(SetBannerError), message);
            return;
        }

        _banner.Visible = true;
        _banner.BackColor = VisualTheme.ErrorBoxBack;
        _lblBannerText.ForeColor = VisualTheme.ErrorBoxText;
        _lblBannerText.Text = UiText.Truncate(message);
        _btnRetry.Visible = true;
        _btnResetCredential.Visible = true;
        _btnResumeOnboarding.Visible = false;
    }

    public void SetOnboardingPending(bool pending)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<bool>(SetOnboardingPending), pending);
            return;
        }

        _onboardingPending = pending;
        RefreshBanner();
    }

    /// <summary>
    /// INV-07: an adopted state whose local router credential is missing must
    /// surface the failure instead of silently rotating it at service start.
    /// Informational banner; the CLI `setup` is the documented repair path.
    /// </summary>
    public void SetLocalCredentialWarning(bool missing)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<bool>(SetLocalCredentialWarning), missing);
            return;
        }

        _localCredentialWarning = missing;
        RefreshBanner();
    }

    private void RefreshBanner()
    {
        // R3-004: an unsupported schema outranks every other snapshot banner —
        // setup/config are refused at the gate, so the operator must see the
        // compatibility state instead of misleading defaults.
        if (_compatibilityWarning is not null)
        {
            _banner.Visible = true;
            _banner.BackColor = VisualTheme.ErrorBoxBack;
            _lblBannerText.ForeColor = VisualTheme.ErrorBoxText;
            _lblBannerText.Text = UiText.Truncate(_compatibilityWarning, 240);
            _btnRetry.Visible = false;
            _btnResetCredential.Visible = false;
            _btnResumeOnboarding.Visible = false;
        }
        else if (_protocolWarning is not null)
        {
            _banner.Visible = true;
            _banner.BackColor = VisualTheme.ErrorBoxBack;
            _lblBannerText.ForeColor = VisualTheme.ErrorBoxText;
            _lblBannerText.Text = UiText.Truncate(_protocolWarning, 240);
            _btnRetry.Visible = true;
            _btnResetCredential.Visible = false;
            _btnResumeOnboarding.Visible = false;
        }
        else if (_localCredentialWarning)
        {
            _banner.Visible = true;
            _banner.BackColor = VisualTheme.AmberBannerBack;
            _lblBannerText.ForeColor = VisualTheme.AmberBannerText;
            _lblBannerText.Text = "Local router credential unavailable — run `gorouter setup` in a terminal to repair.";
            _btnRetry.Visible = false;
            _btnResetCredential.Visible = false;
            _btnResumeOnboarding.Visible = false;
        }
        else if (_onboardingPending)
        {
            _banner.Visible = true;
            _banner.BackColor = VisualTheme.AmberBannerBack;
            _lblBannerText.ForeColor = VisualTheme.AmberBannerText;
            _lblBannerText.Text = "First-run onboarding is not finished yet.";
            _btnRetry.Visible = false;
            _btnResetCredential.Visible = false;
            _btnResumeOnboarding.Visible = true;
        }
        else if (_clientState is ClientState.Connected or ClientState.Starting or ClientState.Reconnecting)
        {
            _banner.Visible = false;
        }
    }

    public void SetSystemFeedback(string message, bool isError)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<string, bool>(SetSystemFeedback), message, isError);
            return;
        }

        _lblDiagnosticsFeedback.ForeColor = isError ? VisualTheme.ErrorText : VisualTheme.FeedbackOkText;
        _lblDiagnosticsFeedback.Text = UiText.Truncate(message);
    }

    // ------------------------------------------------------------------
    // Snapshot rendering
    // ------------------------------------------------------------------

    public void ApplySnapshot(ShellSnapshot snapshot)
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action<ShellSnapshot>(ApplySnapshot), snapshot);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        _snapshot = snapshot;
        _updating = true;
        try
        {
            // Theme first: every control below paints from the active Mode.
            SyncThemeFromSnapshot(snapshot);
            UiText.SetIfChanged(_lblStateBadge, UiText.Truncate(RouterBadgeText(snapshot.Router), 64));
            _lblStateBadge.ForeColor = RouterColor(snapshot.Router.State);
            _statusDot.FillColor = RouterColor(snapshot.Router.State);
            _statusDot.Invalidate();
            // Visual slice 1: route summary in the header band — health +
            // routing answered in the first glance. Cleared lanes show —.
            UiText.SetIfChanged(_lblRouteSummary, UiText.Truncate(
                $"Go \u2192 {(string.IsNullOrEmpty(snapshot.Routes.Go.Alias) ? "\u2014" : snapshot.Routes.Go.Alias)} · Zen \u2192 {(string.IsNullOrEmpty(snapshot.Routes.Zen.Alias) ? "\u2014" : snapshot.Routes.Zen.Alias)}", 44));
            _lblVersion.Text = string.IsNullOrEmpty(PresentationVersion) ? "" : $"v{PresentationVersion}";
            UiText.SetIfChanged(_lblFooter, $"Local: http://127.0.0.1:{snapshot.Settings.Port}");
            _metricTotal.SetValue(snapshot.Journal.Records.ToString("N0"));
            UpdateLifecycleButtons();

            _localCredentialWarning = snapshot.Initialized && !snapshot.LocalCredentialConfigured;
            // R3-004: promote storage compatibility state to the operator.
            _compatibilityWarning = null;
            if (snapshot.StateUnsupportedVersion is not null)
            {
                _compatibilityWarning = $"Incompatible state schema v{snapshot.StateUnsupportedVersion} (this app supports v1) — showing defaults; restore a supported state.json.";
            }
            else if (snapshot.DesktopUnsupportedVersion is not null)
            {
                _compatibilityWarning = $"Incompatible desktop settings schema v{snapshot.DesktopUnsupportedVersion} (this app supports v1) — restore or delete desktop.json.";
            }
            RefreshBanner();

            FillLaneCombo(_cmbGo, snapshot.Routes.Go, _lblGoFeedback, _lblGoError);
            FillLaneCombo(_cmbZen, snapshot.Routes.Zen, _lblZenFeedback, _lblZenError);
            UpdateLaneStatusBoxes(snapshot.Routes.Go, snapshot.Routes.Zen);
            UpdateLaneModeChip(_lblGoMode, snapshot.Router.Mode);
            UpdateLaneModeChip(_lblZenMode, snapshot.Router.Mode);

            _lvAccounts.BeginUpdate();
            _lvAccounts.Items.Clear();
            foreach (var account in snapshot.Accounts)
            {
                var item = new ListViewItem(account.Alias) { Tag = account.Alias };
                item.SubItems.Add(account.Id);
                item.SubItems.Add(account.SecretPresent ? "•" : "—");
                item.SubItems.Add(string.Join(", ", account.UsedBy.Select(l => l.ToUpperInvariant())));
                _lvAccounts.Items.Add(item);
            }

            _lvAccounts.EndUpdate();
            // Row count changes scrollbar visibility with no Resize event.
            FitAccountsColumns();

            _lblStateDirValue.Text = string.IsNullOrEmpty(snapshot.StateDir) ? "—" : snapshot.StateDir;
            _lblSecretStoreValue.Text = snapshot.SecretStore == "ok"
                ? "ok"
                : "unavailable — restart the desktop app or check the state directory";
            UiText.SetIfChanged(_lblJournalInfoValue, $"{snapshot.Journal.Records} records · retention {snapshot.Journal.RetentionDays.ToString(CultureInfo.InvariantCulture)}d · max {snapshot.Journal.MaxRecords}");
            UiText.SetIfChanged(_lblRouterInfoValue, UiText.Truncate($"{snapshot.Router.State} · {snapshot.Router.Mode} · pid {(snapshot.Router.Pid.HasValue && snapshot.Router.Pid.Value > 0 ? snapshot.Router.Pid.Value.ToString(CultureInfo.InvariantCulture) : "—")} · restarts {snapshot.Router.RestartCount}", 128));

            _txtPort.Text = snapshot.Settings.Port.ToString(CultureInfo.InvariantCulture);
            _txtRetentionDays.Text = snapshot.Settings.JournalRetentionDays.ToString(CultureInfo.InvariantCulture);
            _txtMaxRecords.Text = snapshot.Settings.JournalMaxRecords.ToString(CultureInfo.InvariantCulture);
            _chkStartAtLogin.Checked = snapshot.Desktop.StartAtLogin;
            _chkMinimizeToTray.Checked = snapshot.Desktop.MinimizeToTray;
        }
        finally
        {
            _updating = false;
        }
    }

    /// <summary>
    /// Honest lifecycle affordances: Start is offered only where router.start
    /// can have an effect (stopped/failed and not attached to an external
    /// router process); Stop only for a stoppable managed state (running,
    /// starting, degraded) — never for port_conflict, where the router is not
    /// running under our control. Operations themselves are unchanged.
    /// </summary>
    private void UpdateLifecycleButtons()
    {
        var managed = !string.Equals(_snapshot.Router.Mode, "attached", StringComparison.Ordinal);
        _btnStartRouter.Enabled = managed && _snapshot.Router.State is "stopped" or "failed";
        _btnStopRouter.Enabled = managed && _snapshot.Router.State is "running" or "starting" or "degraded";
    }

    private void FillLaneCombo(ComboBox cmb, SnapshotRoute route, Label feedback, Label error)
    {
        var previous = (cmb.SelectedItem as AccountOption)?.Id;
        var options = ShellSnapshot.LaneOptions(_snapshot, route, out var selectedIndex);

        cmb.Items.Clear();
        foreach (var option in options)
        {
            cmb.Items.Add(option);
        }

        // Safe long-alias handling: the closed box truncates natively, and the
        // drop-down is widened (bounded) so full aliases stay readable.
        var longest = options.Count > 0 ? options.Max(o => TextRenderer.MeasureText(o.Alias, cmb.Font).Width) : 0;
        cmb.DropDownWidth = Math.Max(240, Math.Min(longest + 28, 420));

        if (selectedIndex >= 0 && selectedIndex < cmb.Items.Count)
        {
            cmb.SelectedIndex = selectedIndex;
        }

        if (previous != route.AccountId)
        {
            // The selection changed (our own action or externally via CLI):
            // stale UI feedback no longer applies to the current selection.
            feedback.Text = "";
            error.Text = "";
            var box = ReferenceEquals(cmb, _cmbGo) ? _goStatusBox : _zenStatusBox;
            UpdateLaneStatusBox(box, feedback, error, route);
        }
    }

    /// <summary>
    /// Reflect the existing feedback/error labels into each lane's rounded
    /// status surface: green confirmation box, red error box, or a neutral
    /// resting box with the truthful current-route text. Pure presentation;
    /// the labels remain the text carriers and the selftest a11y dump still
    /// shows them.
    /// </summary>
    private void UpdateLaneStatusBoxes(SnapshotRoute goRoute, SnapshotRoute zenRoute)
    {
        UpdateLaneStatusBox(_goStatusBox, _lblGoFeedback, _lblGoError, goRoute);
        UpdateLaneStatusBox(_zenStatusBox, _lblZenFeedback, _lblZenError, zenRoute);
    }

    private static void UpdateLaneStatusBox(LaneStatusBox box, Label feedback, Label error, SnapshotRoute route)
    {
        if (error.Text.Length > 0)
        {
            box.SetError(error.Text);
        }
        else if (!string.IsNullOrEmpty(route.Alias))
        {
            box.SetRouted(route.Alias, feedback.Text.Length > 0 ? feedback.Text : "New requests use this account.");
        }
        else
        {
            box.SetCleared(feedback.Text.Length > 0 ? feedback.Text : "New requests are not routed.");
        }
    }

    /// <summary>
    /// Truncate a long alias for use in the status surface so the
    /// two-line resting message fits within the card without clipping.
    /// </summary>
    private static string SafeAliasText(string alias)
    {
        return alias.Length > 20 ? alias.Substring(0, 17) + "…" : alias;
    }

    /// <summary>Truthful mode chip in each lane header (Managed / Attached).</summary>
    private static void UpdateLaneModeChip(Label chip, string mode)
    {
        if (string.Equals(mode, "managed", StringComparison.Ordinal))
        {
            chip.Text = "Managed";
            chip.BackColor = VisualTheme.MarkerGoBack;
            chip.ForeColor = VisualTheme.MarkerGoText;
            chip.Visible = true;
        }
        else if (string.Equals(mode, "attached", StringComparison.Ordinal))
        {
            chip.Text = "Attached";
            chip.BackColor = VisualTheme.ChipAttachedBack;
            chip.ForeColor = VisualTheme.SecondaryText;
            chip.Visible = true;
        }
        else
        {
            chip.Visible = false;
        }
    }

    private static string RouterBadgeText(SnapshotRouter router)
    {
        var state = router.State switch
        {
            "running" => "Running",
            "degraded" => "Degraded",
            "starting" => "Starting",
            "stopped" => "Stopped",
            "port_conflict" => "Port conflict",
            "failed" => "Failed",
            _ => router.State,
        };
        var mode = router.Mode switch
        {
            "attached" => "attached",
            "managed" => "managed",
            _ => "",
        };
        return mode.Length > 0 ? $"{state} ({mode})" : state;
    }

    private static Color RouterColor(string state) => VisualTheme.StateColor(state);

    // ------------------------------------------------------------------
    // Lane switching
    // ------------------------------------------------------------------

    private async void OnLaneSelectionCommitted(
        string lane,
        ComboBox cmb,
        Label feedback,
        Label error,
        Func<bool> isBusy,
        Action<bool> setBusy)
    {
        if (_updating || isBusy())
        {
            return;
        }

        var option = cmb.SelectedItem as AccountOption;
        var accountId = option?.Id;
        var currentId = lane == "go" ? _snapshot.Routes.Go.AccountId : _snapshot.Routes.Zen.AccountId;
        if (accountId == currentId)
        {
            return;
        }

        setBusy(true);
        var keepFocus = cmb.Focused;
        cmb.Enabled = false;
        feedback.Text = "";
        error.Text = "";
        feedback.Text = accountId is null ? "Clearing lane…" : "Switching…";
        try
        {
            // W0: commit the REVIEWED snapshot values (generation + lane version +
            // target version). A concurrent writer surfaces as conflict; the UI
            // reverts to the authoritative snapshot and never auto-retries.
            var watchedRoute = lane == "go" ? _snapshot.Routes.Go : _snapshot.Routes.Zen;
            var watchedGeneration = _snapshot.StateGeneration;
            var watchedTargetVersion = _snapshot.Accounts.FirstOrDefault(a => a.Id == accountId)?.Version ?? 1;
            var response = accountId is null
                ? await _channel.CallAsync("route.clear", new { lane, expectedStateGeneration = watchedGeneration, expectedRouteVersion = watchedRoute.Version })
                : await _channel.CallAsync("route.set", new { lane, accountId, expectedStateGeneration = watchedGeneration, expectedRouteVersion = watchedRoute.Version, expectedTargetAccountVersion = watchedTargetVersion });

            if (response.Ok)
            {
                error.Text = "";
                feedback.Text = accountId is null
                    ? "Lane cleared; new requests are not routed. In-flight requests keep their original route."
                    : "New route; in-flight same.";
            }
            else
            {
                feedback.Text = "";
                // Revert the combo to the authoritative route: the control must
                // never keep displaying a selection that did not commit (PS-07).
                var route = lane == "go" ? _snapshot.Routes.Go : _snapshot.Routes.Zen;
                FillLaneCombo(cmb, route, feedback, error);
                error.Text = UiText.Truncate(response.ErrorMessage ?? "Route change failed.");
            }

            UpdateLaneStatusBoxes(_snapshot.Routes.Go, _snapshot.Routes.Zen);
        }
        catch (Exception ex)
        {
            feedback.Text = "";
            var route = lane == "go" ? _snapshot.Routes.Go : _snapshot.Routes.Zen;
            FillLaneCombo(cmb, route, feedback, error);
            error.Text = UiText.Truncate(ex.Message);
            UpdateLaneStatusBoxes(_snapshot.Routes.Go, _snapshot.Routes.Zen);
        }
        finally
        {
            setBusy(false);
            if (!_updating)
            {
                cmb.Enabled = _clientState == ClientState.Connected;
                // Keep keyboard focus on the lane selector after the change,
                // but only when it still had focus before the operation.
                if (keepFocus && cmb.Enabled)
                {
                    cmb.Focus();
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Router control
    // ------------------------------------------------------------------

    private async void OnStartRouterClicked(object? sender, EventArgs e)
    {
        await RunRouterOpAsync("router.start", "Router start requested.", "Router start failed");
    }

    private async void OnStopRouterClicked(object? sender, EventArgs e)
    {
        await RunRouterOpAsync("router.stop", "Router stop requested.", "Router stop failed");
    }

    /// <summary>Test-only: select a tab by name for selftest evidence.</summary>
    internal void SelectTabForSelftest(string name)
    {
        foreach (TabPage page in _tabs.TabPages)
        {
            if (string.Equals(page.Text, name, StringComparison.OrdinalIgnoreCase))
            {
                _tabs.SelectedTab = page;
                return;
            }
        }
    }

    // ------------------------------------------------------------------
    // Color theme (visual slice 6b): manual Light/Dark, persisted via
    // desktop.set, applied instantly to every open surface. The snapshot
    // tick re-syncs from the persisted value (startup included).
    // ------------------------------------------------------------------
    private async void OnThemeToggleClicked(object? sender, EventArgs e)
    {
        var next = VisualTheme.Mode == ThemeMode.Dark ? ThemeMode.Light : ThemeMode.Dark;
        ApplyThemeMode(next);
        try
        {
            await _channel.CallAsync("desktop.set", new { theme = next == ThemeMode.Dark ? "dark" : "light" }, 10_000);
        }
        catch
        {
            // Persistence failed: the visual toggle stands; the next snapshot
            // tick re-syncs the button from the persisted value.
        }
    }

    private void ApplyThemeMode(ThemeMode mode)
    {
        VisualTheme.Mode = mode;
        SyncFlatSurfacesTheme();
        // This form first: the first snapshot can arrive before Show (empty
        // OpenForms), and stored control colors must still re-resolve.
        VisualTheme.ApplyTheme(this);
        foreach (Form form in Application.OpenForms)
        {
            if (!ReferenceEquals(form, this))
            {
                VisualTheme.ApplyTheme(form);
            }
        }
        _btnTheme.Text = mode == ThemeMode.Dark ? "Light" : "Dark";
    }

    private void SyncThemeFromSnapshot(ShellSnapshot snapshot)
    {
        var wantDark = string.Equals(snapshot.Desktop.Theme, "dark", StringComparison.OrdinalIgnoreCase);
        var isDark = VisualTheme.Mode == ThemeMode.Dark;
        if (wantDark != isDark)
        {
            ApplyThemeMode(wantDark ? ThemeMode.Dark : ThemeMode.Light);
        }
    }

    private async Task RunRouterOpAsync(string op, string successText, string failurePrefix)
    {
        _btnStartRouter.Enabled = false;
        _btnStopRouter.Enabled = false;
        try
        {
            var response = await _channel.CallAsync(op, null, 30_000);
            SetSystemFeedback(response.Ok ? successText : $"{failurePrefix}: {response.ErrorMessage}", !response.Ok);
        }
        catch (Exception ex)
        {
            SetSystemFeedback($"{failurePrefix}: {ex.Message}", isError: true);
        }
        finally
        {
            ApplySnapshot(_snapshot);
        }
    }

    // ------------------------------------------------------------------
    // Account management
    // ------------------------------------------------------------------

    private string? SelectedAccountAlias()
    {
        if (_lvAccounts.SelectedItems.Count == 0)
        {
            return null;
        }

        return _lvAccounts.SelectedItems[0].Tag as string;
    }

    private void SetAccountsFeedback(string message, bool isError)
    {
        _lblAccountsStatus.ForeColor = isError ? VisualTheme.ErrorText : VisualTheme.FeedbackOkText;
        _lblAccountsStatus.Text = UiText.Truncate(message);
    }

    private async void OnAddAccountClicked(object? sender, EventArgs e)
    {
        using var dialog = new AddAccountDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK || dialog.Alias is null || dialog.Secret is null)
        {
            return;
        }

        SetAccountsFeedback("Adding account…", isError: false);
        try
        {
            var response = await _channel.CallAsync("account.add", new { alias = dialog.Alias, secret = dialog.Secret, expectedStateGeneration = _snapshot.StateGeneration }, 15_000);
            if (response.Ok)
            {
                SetAccountsFeedback($"Account '{dialog.Alias}' added.", isError: false);
            }
            else
            {
                SetAccountsFeedback(response.ErrorMessage ?? "Add account failed.", isError: true);
            }
        }
        catch (Exception ex)
        {
            SetAccountsFeedback("Add account failed: " + ex.Message, isError: true);
        }
    }

    private async void OnUpdateCredentialClicked(object? sender, EventArgs e)
    {
        var alias = SelectedAccountAlias();
        if (alias is null)
        {
            SetAccountsFeedback("Select an account first.", isError: true);
            return;
        }

        using var dialog = new UpdateCredentialDialog(alias);
        if (dialog.ShowDialog(this) != DialogResult.OK || dialog.Secret is null)
        {
            return;
        }

        SetAccountsFeedback("Updating credential…", isError: false);
        try
        {
            // W0: UI alias selection resolves against the reviewed snapshot, but
            // the commit carries the immutable ID + versions (never the alias).
            var watchedUpdate = _snapshot.Accounts.FirstOrDefault(a => a.Alias == alias);
            if (watchedUpdate is null)
            {
                SetAccountsFeedback($"Account '{alias}' is no longer present; refresh and retry.", isError: true);
                return;
            }
            var response = await _channel.CallAsync("account.update", new { accountId = watchedUpdate.Id, secret = dialog.Secret, expectedStateGeneration = _snapshot.StateGeneration, expectedAccountVersion = watchedUpdate.Version }, 15_000);
            if (response.Ok)
            {
                SetAccountsFeedback($"Credential for '{alias}' updated.", isError: false);
            }
            else
            {
                SetAccountsFeedback(response.ErrorMessage ?? "Update failed.", isError: true);
            }
        }
        catch (Exception ex)
        {
            SetAccountsFeedback("Update failed: " + ex.Message, isError: true);
        }
    }

    private async void OnRenameClicked(object? sender, EventArgs e)
    {
        var alias = SelectedAccountAlias();
        if (alias is null)
        {
            SetAccountsFeedback("Select an account first.", isError: true);
            return;
        }

        using var dialog = new RenameDialog(alias);
        if (dialog.ShowDialog(this) != DialogResult.OK || dialog.NewAlias is null)
        {
            return;
        }

        SetAccountsFeedback("Renaming…", isError: false);
        try
        {
            var watchedRename = _snapshot.Accounts.FirstOrDefault(a => a.Alias == alias);
            if (watchedRename is null)
            {
                SetAccountsFeedback($"Account '{alias}' is no longer present; refresh and retry.", isError: true);
                return;
            }
            var response = await _channel.CallAsync("account.rename", new { accountId = watchedRename.Id, newAlias = dialog.NewAlias, expectedStateGeneration = _snapshot.StateGeneration, expectedAccountVersion = watchedRename.Version }, 15_000);
            if (response.Ok)
            {
                SetAccountsFeedback($"Account renamed to '{dialog.NewAlias}'.", isError: false);
            }
            else
            {
                SetAccountsFeedback(response.ErrorMessage ?? "Rename failed.", isError: true);
            }
        }
        catch (Exception ex)
        {
            SetAccountsFeedback("Rename failed: " + ex.Message, isError: true);
        }
    }

    private async void OnRemoveClicked(object? sender, EventArgs e)
    {
        var alias = SelectedAccountAlias();
        if (alias is null)
        {
            SetAccountsFeedback("Select an account first.", isError: true);
            return;
        }

        var account = _snapshot.Accounts.FirstOrDefault(a => a.Alias == alias);
        using var dialog = new RemoveAccountDialog(alias, account?.UsedBy ?? Array.Empty<string>());
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        SetAccountsFeedback("Removing account…", isError: false);
        try
        {
            // F-26: force only when the dialog presented and confirmed the
            // lane-clearing consequence. Otherwise fail closed on the server:
            // an account concurrently routed after the snapshot must refuse,
            // not silently clear the lane.
            var routed = (account?.UsedBy.Count ?? 0) > 0;
            if (account is null)
            {
                SetAccountsFeedback($"Account '{alias}' is no longer present; refresh and retry.", isError: true);
                return;
            }
            var response = await _channel.CallAsync("account.remove", new { accountId = account.Id, force = routed, expectedStateGeneration = _snapshot.StateGeneration, expectedAccountVersion = account.Version }, 15_000);
            if (response.Ok)
            {
                var cleared = response.TryDataAs<RemoveResult>(out var result) ? result?.ClearedLanes ?? Array.Empty<ClearedLane>() : Array.Empty<ClearedLane>();
                var credentialNote = result?.SecretDeleted == false ? " Stored credential was already gone." : "";
                SetAccountsFeedback(
                    cleared.Count > 0
                        ? $"Account '{alias}' removed. Lane selection cleared ({string.Join(", ", cleared.Select(l => l.Lane.ToUpperInvariant()))}).{credentialNote}"
                        : $"Account '{alias}' removed.{credentialNote}",
                    isError: false);
            }
            else
            {
                SetAccountsFeedback(response.ErrorMessage ?? "Remove failed.", isError: true);
            }
        }
        catch (Exception ex)
        {
            SetAccountsFeedback("Remove failed: " + ex.Message, isError: true);
        }
    }

    private async void OnTestClicked(object? sender, EventArgs e)
    {
        var alias = SelectedAccountAlias();
        if (alias is null)
        {
            SetAccountsFeedback("Select an account first.", isError: true);
            return;
        }

        using var progress = new TestProgressDialog(alias);
        progress.Show(this);
        try
        {
            var response = await _channel.CallAsync("account.test", new { alias, lane = (string?)null }, 90_000);
            if (!progress.IsDisposed)
            {
                progress.Close();
            }

            if (response.Ok && response.TryDataAs<List<ProbeResultInfo>>(out var results) && results is { Count: > 0 })
            {
                var lines = results.Select(r =>
                    $"{r.Lane.ToUpperInvariant()}: {r.Verdict} · HTTP {(r.HttpStatus?.ToString() ?? "—")} · {r.Model}" +
                    (string.IsNullOrEmpty(r.WorkspaceHint) ? "" : $" · {r.WorkspaceHint}"));
                SetAccountsFeedback(string.Join(Environment.NewLine, lines), isError: false);
            }
            else
            {
                SetAccountsFeedback(response.ErrorMessage ?? "Test failed.", isError: true);
            }
        }
        catch (Exception ex)
        {
            if (!progress.IsDisposed)
            {
                progress.Close();
            }

            SetAccountsFeedback("Test failed: " + ex.Message, isError: true);
        }
    }

    // ------------------------------------------------------------------
    // Journal
    // ------------------------------------------------------------------

    // Visual slice 8: user-clicked refresh shows a busy button while the
    // call runs and pulses the stats line on success. Tab-selection and
    // tick-driven refreshes keep the quiet path (no button flash, no pulse).
    private async Task RefreshJournalWithBusyAsync()
    {
        if (_journalRefreshing || _clientState != ClientState.Connected)
        {
            return;
        }

        var originalText = _btnJournalRefresh.Text;
        _btnJournalRefresh.Enabled = false;
        _btnJournalRefresh.Text = "Refreshing…";
        try
        {
            if (await RefreshJournalAsync())
            {
                PulseLabelOnce(_lblJournalStats);
            }
        }
        finally
        {
            if (!IsDisposed && !Disposing)
            {
                _btnJournalRefresh.Enabled = true;
                _btnJournalRefresh.Text = originalText;
            }
        }
    }

    /// <summary>Brief success pulse: stats line flashes healthy, then rests.
    /// One-shot UI timer, guarded against close/dispose mid-pulse.</summary>
    private void PulseLabelOnce(Label label)
    {
        if (IsDisposed || Disposing || label.IsDisposed)
        {
            return;
        }

        var rest = label.ForeColor;
        label.ForeColor = VisualTheme.Healthy;
        var timer = new System.Windows.Forms.Timer { Interval = 650 };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            timer.Dispose();
            if (!IsDisposed && !Disposing && !label.IsDisposed)
            {
                // Re-resolve: a theme toggle inside the pulse window must
                // not restore a stale color.
                label.ForeColor = VisualTheme.Map(rest);
            }
        };
        timer.Start();
    }

    private async Task<bool> RefreshJournalAsync()
    {
        if (_journalRefreshing || _clientState != ClientState.Connected)
        {
            return false;
        }

        _journalRefreshing = true;
        try
        {
            var response = await _channel.CallAsync("journal.recent", new { limit = 200 }, 15_000);
            if (response.Ok && response.TryDataAs<RecentJournalData>(out var data) && data is not null)
            {
                _lvJournal.BeginUpdate();
                _lvJournal.Items.Clear();
                foreach (var row in data.Rows)
                {
                    _lvJournal.Items.Add(MakeJournalItem(row));
                }

                _lvJournal.EndUpdate();
                // Row count changes scrollbar visibility with no Resize event.
                FitJournalColumns();

                var degraded = data.Degraded || _snapshot.Journal.Degraded;
                _lblJournalDegraded.Visible = degraded;
                _lblJournalDegraded.Text = degraded
                    ? UiText.Truncate("Journal degraded: " + (data.Error ?? _snapshot.Journal.LastError ?? "read failure") + " — recent requests may be incomplete.")
                    : "";
                _lblJournalEmpty.Visible = data.Rows.Count == 0 && !degraded;

                // The home preview renders from the same response payload.
                RenderRecentActivity(data.Rows, degraded, degraded ? UiText.Truncate(data.Error ?? _snapshot.Journal.LastError) : null);
                // Pulse only on clean success: degraded shows its own banner.
                return !degraded;
            }
            else
            {
                _lblJournalDegraded.Visible = true;
                _lblJournalDegraded.Text = UiText.Truncate("Journal unavailable: " + (response.ErrorMessage ?? "unknown error"));
                _lblJournalEmpty.Visible = false;
                RenderRecentActivity(Array.Empty<JournalRow>(), true, UiText.Truncate(response.ErrorMessage ?? "read failure"));
                return false;
            }
        }
        catch (Exception ex)
        {
            _lblJournalDegraded.Visible = true;
            _lblJournalDegraded.Text = UiText.Truncate("Journal unavailable: " + ex.Message);
            _lblJournalEmpty.Visible = false;
            RenderRecentActivity(Array.Empty<JournalRow>(), true, UiText.Truncate(ex.Message));
            return false;
        }
        finally
        {
            _journalRefreshing = false;
            UpdateJournalStats();
        }
    }

    private void UpdateJournalStats()
    {
        var journal = _snapshot.Journal;
        var oldest = string.IsNullOrEmpty(journal.OldestRecordAtUtc) ? "—" : FormatTime(journal.OldestRecordAtUtc);
        var newest = string.IsNullOrEmpty(journal.NewestRecordAtUtc) ? "—" : FormatTime(journal.NewestRecordAtUtc);
        UiText.SetIfChanged(_lblJournalStats, $"records {journal.Records} · oldest {oldest} · newest {newest} · retention {journal.RetentionDays.ToString(CultureInfo.InvariantCulture)} days · max {journal.MaxRecords}");
    }

    private static ListViewItem MakeJournalItem(JournalRow row)
    {
        var item = new ListViewItem(FormatTime(row.StartedAtUtc));
        item.SubItems.Add(row.Lane.ToUpperInvariant());
        item.SubItems.Add(row.SelectedAccountAliasSnapshot ?? "—");
        item.SubItems.Add(row.EndpointFamily ?? "—");
        item.SubItems.Add(row.Method);
        item.SubItems.Add(row.TerminalOutcome);
        item.SubItems.Add(row.HttpStatus?.ToString() ?? "—");
        item.SubItems.Add(row.DurationMs.HasValue ? row.DurationMs.Value.ToString(CultureInfo.InvariantCulture) + " ms" : "—");
        item.SubItems.Add(row.RouterRequestId);
        // Visual slice 4: the journal grid is not owner-drawn, so outcome /
        // status color rides per-subitem fore colors (index 5/6 above).
        item.UseItemStyleForSubItems = false;
        item.SubItems[5].ForeColor = VisualTheme.OutcomeColor(row.TerminalOutcome);
        item.SubItems[6].ForeColor = VisualTheme.StatusColor(row.HttpStatus?.ToString());
        return item;
    }

    /// <summary>
    /// Home-tab preview: at most 5 safe rows (time, lane, alias snapshot,
    /// family/method, outcome/status) — never bodies, prompts, headers,
    /// credentials, request ids or durations. The empty state is designed and
    /// the degraded state is explicit; the full Journal tab stays authoritative.
    /// </summary>
    // Slice C: fingerprint of the activity payload — the ~1s tick skips the
    // clear+rebuild while nothing changed (newest id/completion covers new
    // rows and in-flight completions; degraded text is part of the key).
    private string? _activityFingerprint;

    private void RenderRecentActivity(IReadOnlyList<JournalRow> rows, bool degraded, string? error)
    {
        // C2: every RENDERED row keys the fingerprint (id + outcome + status
        // + completion) — a late in-flight→done flip on any visible row must
        // re-render, not hide until an unrelated change.
        // Metrics derive from the full loaded window (up to 200 rows), so
        // the fingerprint covers every row — a change beyond the top 5 must
        // still refresh the success/latency blocks.
        var fingerprint = degraded
            ? "degraded:" + (error ?? "")
            : string.Join(";", rows.Select(r => r.RouterRequestId + "|" + r.TerminalOutcome + "|" + (r.HttpStatus?.ToString() ?? "-") + "|" + (r.CompletedAtUtc ?? "")));
        if (fingerprint == _activityFingerprint)
        {
            return;
        }

        _activityFingerprint = fingerprint;
        if (!degraded)
        {
            var stats = JournalStats.Compute(rows);
            _metricSuccess.SetValue(JournalStats.FormatRate(stats.SuccessRate));
            _metricLatency.SetValue(JournalStats.FormatLatency(stats.AvgLatencyMs));
            var go = JournalStats.ComputeForLane(rows, "go");
            _goReq.SetValue(go.WithinHour.ToString("N0"));
            _goRate.SetValue(JournalStats.FormatRate(go.SuccessRate));
            _goLatency.SetValue(JournalStats.FormatLatency(go.AvgLatencyMs));
            var zen = JournalStats.ComputeForLane(rows, "zen");
            _zenReq.SetValue(zen.WithinHour.ToString("N0"));
            _zenRate.SetValue(JournalStats.FormatRate(zen.SuccessRate));
            _zenLatency.SetValue(JournalStats.FormatLatency(zen.AvgLatencyMs));
        }
        _lvActivity.BeginUpdate();
        _lvActivity.Items.Clear();
        foreach (var row in rows.Take(5))
        {
            _lvActivity.Items.Add(MakeActivityItem(row));
        }

        _lvActivity.EndUpdate();
        // Row count changes scrollbar visibility with no Resize event.
        FitActivityColumns();

        var showList = rows.Count > 0 || degraded;
        _lvActivity.Visible = showList;
        _lblActivityEmpty.Visible = !showList;
        _lblActivityDegraded.Visible = degraded;
        UiText.SetIfChanged(_lblActivityDegraded, degraded
            ? $"Recent activity unavailable: {error ?? "journal degraded"} — recent requests may be missing."
            : "");
    }

    private static ListViewItem MakeActivityItem(JournalRow row)
    {
        var familyMethod = string.IsNullOrEmpty(row.EndpointFamily) && string.IsNullOrEmpty(row.Method)
            ? "—"
            : string.IsNullOrEmpty(row.EndpointFamily)
                ? row.Method
                : $"{row.EndpointFamily} / {row.Method}";
        var item = new ListViewItem(FormatTime(row.StartedAtUtc));
        item.SubItems.Add(row.Lane.ToUpperInvariant());
        item.SubItems.Add(row.SelectedAccountAliasSnapshot ?? "—");
        item.SubItems.Add(familyMethod);
        item.SubItems.Add(row.TerminalOutcome);
        item.SubItems.Add(row.HttpStatus?.ToString() ?? "—");
        // Latency column: DurationMs is already in the journal.recent model
        // (same source as the Journal tab's Duration ms column); in-flight
        // rows without a duration stay an em-dash, never a guess.
        item.SubItems.Add(row.DurationMs.HasValue && row.DurationMs.Value > 0 ? JournalStats.FormatLatency(row.DurationMs.Value) : "—");
        return item;
    }

    private static string FormatTime(string isoUtc)
    {
        if (DateTimeOffset.TryParse(isoUtc, out var dto))
        {
            return dto.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
        }

        return isoUtc;
    }

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------

    private async void OnApplyPortClicked(object? sender, EventArgs e)
    {
        var raw = _txtPort.Text.Trim();
        if (!int.TryParse(raw, out var port) || port < 1 || port > 65535)
        {
            _lblPortError.Text = "Port must be an integer 1..65535.";
            return;
        }

        _lblPortError.Text = "";
        _btnApplyPort.Enabled = false;
        var portText = _btnApplyPort.Text;
        _btnApplyPort.Text = "Applying…";
        try
        {
            var response = await _channel.CallAsync("config.set", new { key = "port", value = raw }, 15_000);
            if (response.Ok)
            {
                SetSystemFeedback("Port saved. It applies to the next router start.", isError: false);
            }
            else
            {
                _lblPortError.Text = UiText.Truncate(response.ErrorMessage ?? "Port change refused.");
            }
        }
        catch (Exception ex)
        {
            _lblPortError.Text = UiText.Truncate("Port change failed: " + ex.Message);
        }
        finally
        {
            _btnApplyPort.Enabled = true;
            _btnApplyPort.Text = portText;
        }
    }

    private async void OnApplyRetentionClicked(object? sender, EventArgs e)
    {
        // Wire: journalRetentionDays is a fractional-positive number (GR-007).
        // Accept invariant-culture doubles; domain validates (0, 3650].
        if (!double.TryParse(_txtRetentionDays.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var days) || !double.IsFinite(days) || days <= 0 || days > 3650)
        {
            _lblRetentionError.Text = "Retention days must be a positive number (up to 3650).";
            return;
        }

        if (!int.TryParse(_txtMaxRecords.Text.Trim(), out var maxRecords) || maxRecords <= 0)
        {
            _lblRetentionError.Text = "Max records must be a positive integer.";
            return;
        }

        _lblRetentionError.Text = "";
        _btnApplyRetention.Enabled = false;
        var retentionText = _btnApplyRetention.Text;
        _btnApplyRetention.Text = "Applying…";
        try
        {
            var response = await _channel.CallAsync("config.set", new { key = "journalRetentionDays", value = days.ToString(CultureInfo.InvariantCulture) }, 15_000);
            if (!response.Ok)
            {
                _lblRetentionError.Text = UiText.Truncate(response.ErrorMessage ?? "Retention change refused.");
                return;
            }

            response = await _channel.CallAsync("config.set", new { key = "journalMaxRecords", value = maxRecords.ToString() }, 15_000);
            if (!response.Ok)
            {
                _lblRetentionError.Text = UiText.Truncate(response.ErrorMessage ?? "Max records change refused.");
                return;
            }

            SetSystemFeedback("Journal settings saved.", isError: false);
        }
        catch (Exception ex)
        {
            _lblRetentionError.Text = UiText.Truncate("Journal settings failed: " + ex.Message);
        }
        finally
        {
            _btnApplyRetention.Enabled = true;
            _btnApplyRetention.Text = retentionText;
        }
    }

    private async void OnCopyDiagnosticsClicked(object? sender, EventArgs e)
    {
        try
        {
            Clipboard.SetText(BuildDiagnosticsText());
            _lblDiagnosticsFeedback.ForeColor = VisualTheme.FeedbackOkText;
            _lblDiagnosticsFeedback.Text = "Redacted diagnostics copied to the clipboard.";
        }
        catch (Exception ex)
        {
            _lblDiagnosticsFeedback.ForeColor = VisualTheme.ErrorText;
            _lblDiagnosticsFeedback.Text = UiText.Truncate("Copy failed: " + ex.Message);
        }

        await Task.CompletedTask;
    }

    /// <summary>Snapshot fields only — never secrets, tokens or credentials.</summary>
    public string BuildDiagnosticsText()
    {
        var snapshot = _snapshot;
        var sb = new StringBuilder();
        sb.AppendLine("GoRouter Desktop diagnostics (redacted)");
        sb.AppendLine($"serviceVersion: {snapshot.ServiceVersion}");
        sb.AppendLine($"stateDir: {snapshot.StateDir}");
        sb.AppendLine($"initialized: {snapshot.Initialized}");
        sb.AppendLine($"stateCorrupt: {snapshot.StateCorrupt}");
        sb.AppendLine($"stateUnsupportedVersion: {snapshot.StateUnsupportedVersion?.ToString() ?? "(none)"}");
        sb.AppendLine($"desktopUnsupportedVersion: {snapshot.DesktopUnsupportedVersion?.ToString() ?? "(none)"}");
        sb.AppendLine($"secretStore: {snapshot.SecretStore}");
        sb.AppendLine($"settings: port={snapshot.Settings.Port} journalRetentionDays={snapshot.Settings.JournalRetentionDays.ToString(CultureInfo.InvariantCulture)} journalMaxRecords={snapshot.Settings.JournalMaxRecords}");
        sb.AppendLine($"router: state={snapshot.Router.State} mode={snapshot.Router.Mode} pid={(snapshot.Router.Pid.HasValue ? snapshot.Router.Pid.Value.ToString(CultureInfo.InvariantCulture) : "(none)")} restartCount={snapshot.Router.RestartCount}");
        sb.AppendLine($"routes: go={DescribeRoute(snapshot.Routes.Go)} zen={DescribeRoute(snapshot.Routes.Zen)}");
        foreach (var account in snapshot.Accounts)
        {
            sb.AppendLine($"account: alias={account.Alias} id={account.Id} secretPresent={account.SecretPresent} usedBy={string.Join(",", account.UsedBy)}");
        }

        sb.AppendLine($"journal: records={snapshot.Journal.Records} degraded={snapshot.Journal.Degraded} lastError={snapshot.Journal.LastError ?? ""} retentionDays={snapshot.Journal.RetentionDays.ToString(CultureInfo.InvariantCulture)} maxRecords={snapshot.Journal.MaxRecords}");
        sb.AppendLine($"desktop: startAtLogin={snapshot.Desktop.StartAtLogin} minimizeToTray={snapshot.Desktop.MinimizeToTray}");
        sb.AppendLine($"localCredentialConfigured: {snapshot.LocalCredentialConfigured}");
        return sb.ToString();
    }

    private static string DescribeRoute(SnapshotRoute route) =>
        route.AccountId is null ? "(none)" : $"{route.Alias ?? "?"} ({route.AccountId})";

    // ------------------------------------------------------------------
    // Settings toggles
    // ------------------------------------------------------------------

    private void OnStartAtLoginCheckChanged(object? sender, EventArgs e)
    {
        if (_updating)
        {
            return;
        }

        StartAtLoginChanged?.Invoke(_chkStartAtLogin.Checked);
    }

    private void OnMinimizeToTrayCheckChanged(object? sender, EventArgs e)
    {
        if (_updating)
        {
            return;
        }

        MinimizeToTrayChanged?.Invoke(_chkMinimizeToTray.Checked);
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        _chkStartAtLogin.CheckedChanged += OnStartAtLoginCheckChanged;
        _chkMinimizeToTray.CheckedChanged += OnMinimizeToTrayCheckChanged;
        _mutationControls.AddRange(new Control[]
        {
            _btnStartRouter,
            _btnStopRouter,
            _cmbGo,
            _cmbZen,
            _lvAccounts,
            _btnAddAccount,
            _btnUpdateCredential,
            _btnRenameAccount,
            _btnRemoveAccount,
            _btnTestAccount,
            _btnJournalRefresh,
            _chkStartAtLogin,
            _chkMinimizeToTray,
            _txtPort,
            _btnApplyPort,
            _txtRetentionDays,
            _txtMaxRecords,
            _btnApplyRetention,
        });

        // The home tab shows the activity preview on initial display; the
        // connection guard inside RefreshJournalAsync makes this a no-op
        // until the control channel is connected.
        if (_tabs.SelectedTab == _tabHome)
        {
            _ = RefreshJournalAsync();
        }
    }

    /// <summary>
    /// Escape while the journal view is active returns to the dashboard. It is
    /// an additional keyboard shortcut — the visible ← Back button remains the
    /// primary navigation affordance — and it NEVER closes the window:
    /// close-to-tray semantics (and Back/Close separation) are unchanged.
    /// </summary>
    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Escape && _tabs.SelectedTab == _tabJournal)
        {
            NavigateTo(ViewTarget.Dashboard);
            e.Handled = true;
            e.SuppressKeyPress = true;
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_exiting)
        {
            // Close-to-tray: the window hides; tray Exit is the only exit.
            e.Cancel = true;
            Hide();
            return;
        }

        base.OnFormClosing(e);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState == FormWindowState.Minimized && _snapshot.Desktop.MinimizeToTray && !_exiting)
        {
            Hide();
        }
    }

    public void ShowFromTray()
    {
        if (IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(ShowFromTray);
            }
            catch (InvalidOperationException)
            {
                // form is closing
            }

            return;
        }

        Show();
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }

        Activate();
    }

    public void SetExiting()
    {
        _exiting = true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _channel.StateChanged -= OnChannelStateChanged;
            _channel.SnapshotReceived -= OnChannelSnapshot;
            _channel.ProtocolError -= OnChannelProtocolError;
        }

        base.Dispose(disposing);
    }

    /// <summary>
    /// Rounded status surface inside a lane card that hosts the existing
    /// feedback/error labels: a green confirmation box for successful route
    /// changes ("✓ New requests use ...; in-flight requests keep their
    /// original route."), a red box for failures. Purely presentational.
    /// </summary>
    private sealed class LaneStatusBox : Panel, IThemeAware
    {
        private readonly Label _glyph;
        private readonly TableLayoutPanel _layout;
        private Color _borderColor = VisualTheme.ConfirmationBorder;

        public LaneStatusBox()
        {
            Height = 66;
            AutoSize = false;
            DoubleBuffered = true;
            Visible = false;
            Margin = new Padding(0);
            BackColor = VisualTheme.ConfirmationBack;

            _glyph = new Label
            {
                AutoSize = true,
                Font = VisualTheme.BodyFont,
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = VisualTheme.ConfirmationBack,
                AccessibleName = "Status glyph",
            };

            // Visual slice 2: boarding-pass title line carrying the route
            // identity ("Routed to alpha"), with the transient/resting copy
            // as the detail line beneath it.
            TitleLabel = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(360, 0),
                Font = VisualTheme.StatusFont,
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = VisualTheme.ConfirmationBack,
                AccessibleName = "Route state title",
            };
            FeedbackLabel = new Label
            {
                AutoSize = false,
                AutoEllipsis = true,
                MaximumSize = new Size(360, 0),
                Font = VisualTheme.BodyFont,
                TextAlign = ContentAlignment.MiddleLeft,
                Dock = DockStyle.Fill,
                BackColor = VisualTheme.ConfirmationBack,
                AccessibleName = "Status text",
            };
            ErrorLabel = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(360, 0),
                Font = VisualTheme.BodyFont,
                TextAlign = ContentAlignment.MiddleLeft,
                Dock = DockStyle.Fill,
                Visible = false,
                BackColor = VisualTheme.ErrorBoxBack,
                AccessibleName = "Status error text",
            };

            _layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 2,
                Padding = new Padding(10, 4, 10, 4),
                BackColor = VisualTheme.ConfirmationBack,
            };
            _layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            _layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _layout.Controls.Add(_glyph, 0, 0);
            _layout.SetRowSpan(_glyph, 2);
            _layout.Controls.Add(TitleLabel, 1, 0);
            _layout.Controls.Add(FeedbackLabel, 1, 1);
            _layout.Controls.Add(ErrorLabel, 1, 1); // same cell; visibility toggles
            Controls.Add(_layout);
        }

        public Label TitleLabel { get; }

        public Label FeedbackLabel { get; }

        public Label ErrorLabel { get; }

        /// <summary>Routed state: the title carries the account identity.</summary>
        public void SetRouted(string alias, string detail)
        {
            SetState(VisualTheme.ConfirmationBack, VisualTheme.ConfirmationBorder, "●", VisualTheme.Healthy, VisualTheme.PrimaryText);
            TitleLabel.Text = UiText.Truncate($"Routed to {alias}", 96);
            TitleLabel.Visible = true;
            FeedbackLabel.Text = detail;
            FeedbackLabel.Visible = true;
            ErrorLabel.Visible = false;
            Visible = true;
        }

        /// <summary>Cleared state: no account serves the lane.</summary>
        public void SetCleared(string detail)
        {
            SetState(VisualTheme.RowAltBack, VisualTheme.CardBorder, "○", VisualTheme.SecondaryText, VisualTheme.SecondaryText);
            TitleLabel.Text = "Lane cleared";
            TitleLabel.Visible = true;
            FeedbackLabel.Text = detail;
            FeedbackLabel.Visible = true;
            ErrorLabel.Visible = false;
            Visible = true;
        }

        public void SetError(string text)
        {
            SetState(VisualTheme.ErrorBoxBack, VisualTheme.ErrorBoxBorder, "!", VisualTheme.ErrorBoxText, VisualTheme.ErrorBoxText);
            TitleLabel.Visible = false;
            ErrorLabel.Text = text;
            ErrorLabel.Visible = true;
            FeedbackLabel.Visible = false;
            Visible = true;
        }

        public void Clear()
        {
            Visible = false;
            TitleLabel.Visible = false;
            FeedbackLabel.Visible = false;
            ErrorLabel.Visible = false;
        }

        private void SetState(Color back, Color border, string glyph, Color glyphColor, Color textColor)
        {
            _layout.BackColor = back;
            BackColor = back;
            _borderColor = border;
            _glyph.Text = glyph;
            _glyph.ForeColor = glyphColor;
            _glyph.BackColor = back;
            FeedbackLabel.ForeColor = textColor;
            FeedbackLabel.BackColor = back;
            ErrorLabel.ForeColor = textColor;
            ErrorLabel.BackColor = back;
            Invalidate();
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent?.BackColor ?? VisualTheme.SurfaceWhite);
            var bounds = new Rectangle(1, 1, Width - 2, Height - 2);
            VisualTheme.FillRounded(e.Graphics, bounds, 6, BackColor);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var bounds = new Rectangle(1, 1, Width - 2, Height - 2);
            VisualTheme.DrawRounded(e.Graphics, bounds, 6, _borderColor, 1f);
        }

        public void RefreshTheme()
        {
            BackColor = VisualTheme.Map(BackColor);
            _borderColor = VisualTheme.Map(_borderColor);
            _layout.BackColor = VisualTheme.Map(_layout.BackColor);
            _glyph.BackColor = VisualTheme.Map(_glyph.BackColor);
            _glyph.ForeColor = VisualTheme.Map(_glyph.ForeColor);
            foreach (var label in new[] { TitleLabel, FeedbackLabel, ErrorLabel })
            {
                label.BackColor = VisualTheme.Map(label.BackColor);
                label.ForeColor = VisualTheme.Map(label.ForeColor);
            }
            Invalidate();
        }
    }

    /// <summary>
    /// Small filled circle that reinforces the router state badge. The text
    /// badge stays authoritative; the dot only adds shape + color emphasis,
    /// never color-only meaning.
    /// </summary>
    private sealed class StatusDot : Control, IThemeAware
    {
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public Color FillColor { get; set; } = VisualTheme.IdleDot;

        public StatusDot()
        {
            Size = new Size(12, 12);
            TabStop = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var brush = new SolidBrush(FillColor);
            using var pen = new Pen(VisualTheme.CardBorder, 1f);
            e.Graphics.FillEllipse(brush, 1, 1, Width - 3, Height - 3);
            e.Graphics.DrawEllipse(pen, 1, 1, Width - 3, Height - 3);
        }

        // The 1s tick re-derives FillColor from state; this only bridges the
        // sub-second gap between a toggle and the next tick.
        public void RefreshTheme()
        {
            FillColor = VisualTheme.Map(FillColor);
            Invalidate();
        }
    }
}
