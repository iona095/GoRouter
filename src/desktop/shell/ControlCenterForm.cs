using System.Text;

namespace GoRouterDesktop;

/// <summary>
/// The control center: top status bar (state badge + port + version +
/// Start/Stop), two lane panels (GO/ZEN immediate account switching with
/// exact route-change feedback), Accounts, Journal and System tabs. Every
/// control has an accessible name and explicit tab order; the close button
/// hides to tray (non-destructive — tray Exit is the only exit); minimize
/// hides to tray when minimizeToTray is enabled.
/// </summary>
public sealed class ControlCenterForm : Form
{
    private readonly IControlChannel _channel;

    private ShellSnapshot _snapshot = ShellSnapshot.Empty;
    private ClientState _clientState = ClientState.Starting;
    private bool _updating;
    private bool _exiting;
    private bool _journalRefreshing;

    // status bar
    private Label _lblStateBadge = null!;
    private Label _lblPort = null!;
    private Label _lblVersion = null!;
    private Button _btnStartRouter = null!;
    private Button _btnStopRouter = null!;

    // banner (startup / unavailable / auth-failed / onboarding pending)
    private Panel _banner = null!;
    private Label _lblBannerText = null!;
    private bool _onboardingPending;
    private bool _localCredentialWarning;
    private Button _btnRetry = null!;
    private Button _btnResetCredential = null!;
    private Button _btnResumeOnboarding = null!;

    // tabs
    private TabControl _tabs = null!;
    private TabPage _tabJournal = null!;

    // routing tab
    private ComboBox _cmbGo = null!;
    private Label _lblGoFeedback = null!;
    private Label _lblGoError = null!;
    private ComboBox _cmbZen = null!;
    private Label _lblZenFeedback = null!;
    private Label _lblZenError = null!;
    private bool _routeBusyGo;
    private bool _routeBusyZen;

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
    private Label _lblJournalEmpty = null!;
    private Button _btnJournalRefresh = null!;

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

        BuildLayout();
        ApplySnapshot(_channel.Snapshot ?? ShellSnapshot.Empty);
        SetClientState(_channel.State);
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    private void BuildLayout()
    {
        Text = "GoRouter Desktop";
        ClientSize = new Size(960, 660);
        MinimumSize = new Size(800, 560);
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        KeyPreview = true;

        Controls.Add(BuildStatusBar());
        Controls.Add(BuildBanner());
        _tabs = new TabControl { Dock = DockStyle.Fill, AccessibleName = "Control center sections" };
        _tabs.TabPages.Add(BuildRoutingTab());
        _tabs.TabPages.Add(BuildAccountsTab());
        _tabJournal = BuildJournalTab();
        _tabs.TabPages.Add(_tabJournal);
        _tabs.TabPages.Add(BuildSystemTab());
        _tabs.SelectedIndexChanged += (_, _) =>
        {
            if (_tabs.SelectedTab == _tabJournal)
            {
                _ = RefreshJournalAsync();
            }
        };
        Controls.Add(_tabs);
    }

    private Control BuildStatusBar()
    {
        var bar = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 44,
            ColumnCount = 2,
            RowCount = 1,
            Padding = new Padding(10, 6, 10, 6),
            AccessibleName = "Status bar",
        };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var left = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Padding = new Padding(0, 4, 0, 0),
            AccessibleName = "Router status summary",
        };
        _lblStateBadge = new Label
        {
            AutoSize = true,
            Font = new Font(Font, FontStyle.Bold),
            Text = "Starting…",
            AccessibleName = "Router state",
        };
        _lblPort = new Label
        {
            AutoSize = true,
            Margin = new Padding(14, 0, 0, 0),
            Text = "",
            AccessibleName = "Router port",
        };
        _lblVersion = new Label
        {
            AutoSize = true,
            Margin = new Padding(14, 0, 0, 0),
            Text = "",
            AccessibleName = "Desktop version",
        };
        left.Controls.AddRange(new Control[] { _lblStateBadge, _lblPort, _lblVersion });

        var right = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            AccessibleName = "Router controls",
        };
        _btnStopRouter = new Button
        {
            Text = "Stop router",
            AutoSize = true,
            Margin = new Padding(6, 0, 0, 0),
            TabIndex = 4,
            AccessibleName = "Stop router",
        };
        _btnStartRouter = new Button
        {
            Text = "Start router",
            AutoSize = true,
            Margin = new Padding(6, 0, 0, 0),
            TabIndex = 3,
            AccessibleName = "Start router",
        };
        right.Controls.Add(_btnStopRouter);
        right.Controls.Add(_btnStartRouter);

        _btnStartRouter.Click += OnStartRouterClicked;
        _btnStopRouter.Click += OnStopRouterClicked;

        bar.Controls.Add(left, 0, 0);
        bar.Controls.Add(right, 1, 0);
        return bar;
    }

    private Control BuildBanner()
    {
        _banner = new Panel
        {
            Dock = DockStyle.Top,
            Height = 40,
            BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0),
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
        var page = new TabPage("Routing") { AccessibleName = "Routing lanes" };
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            Padding = new Padding(10),
            AccessibleName = "Lane selection",
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));

        grid.Controls.Add(BuildLaneGroup("GO", "go", out _cmbGo, out _lblGoFeedback, out _lblGoError), 0, 0);
        grid.Controls.Add(BuildLaneGroup("ZEN", "zen", out _cmbZen, out _lblZenFeedback, out _lblZenError), 1, 0);

        _cmbGo.SelectionChangeCommitted += (_, _) => OnLaneSelectionCommitted("go", _cmbGo, _lblGoFeedback, _lblGoError, () => _routeBusyGo, v => _routeBusyGo = v);
        _cmbZen.SelectionChangeCommitted += (_, _) => OnLaneSelectionCommitted("zen", _cmbZen, _lblZenFeedback, _lblZenError, () => _routeBusyZen, v => _routeBusyZen = v);

        page.Controls.Add(grid);
        return page;
    }

    private GroupBox BuildLaneGroup(string title, string lane, out ComboBox cmb, out Label feedback, out Label error)
    {
        var box = new GroupBox
        {
            Text = title,
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            AccessibleName = $"{title} lane",
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            AccessibleName = $"{title} lane controls",
        };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var hint = new Label
        {
            Text = "Account serving this lane. Switching takes effect for new requests.",
            AutoSize = true,
            AccessibleName = $"{title} lane hint",
        };
        cmb = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Dock = DockStyle.Top,
            TabIndex = 0,
            AccessibleName = $"{title} account selection",
        };
        feedback = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(0x1B, 0x5E, 0x20),
            MaximumSize = new Size(420, 0),
            AccessibleName = $"{title} lane feedback",
        };
        error = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C),
            MaximumSize = new Size(420, 0),
            AccessibleName = $"{title} lane error",
        };

        layout.Controls.Add(hint, 0, 0);
        layout.Controls.Add(cmb, 0, 1);
        layout.Controls.Add(feedback, 0, 2);
        layout.Controls.Add(error, 0, 3);
        box.Controls.Add(layout);
        return box;
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
            GridLines = true,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            TabIndex = 0,
            AccessibleName = "Accounts list",
        };
        _lvAccounts.Columns.Add("Alias", 140);
        _lvAccounts.Columns.Add("ID", 220);
        _lvAccounts.Columns.Add("Secret", 70);
        _lvAccounts.Columns.Add("Used by", 100);

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
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            AccessibleName = "Journal header",
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _lblJournalStats = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Journal statistics",
        };
        _btnJournalRefresh = new Button
        {
            Text = "Refresh",
            AutoSize = true,
            TabIndex = 0,
            AccessibleName = "Refresh journal",
        };
        _btnJournalRefresh.Click += (_, _) => _ = RefreshJournalAsync();
        header.Controls.Add(_lblJournalStats, 0, 0);
        header.Controls.Add(_btnJournalRefresh, 1, 0);

        _lblJournalDegraded = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(0x8A, 0x53, 0x00),
            BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0),
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
            GridLines = true,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            TabIndex = 1,
            AccessibleName = "Recent requests",
        };
        _lvJournal.Columns.Add("Time", 130);
        _lvJournal.Columns.Add("Lane", 50);
        _lvJournal.Columns.Add("Account", 110);
        _lvJournal.Columns.Add("Family", 130);
        _lvJournal.Columns.Add("Method", 60);
        _lvJournal.Columns.Add("Outcome", 90);
        _lvJournal.Columns.Add("Status", 60);
        _lvJournal.Columns.Add("Duration ms", 80);
        _lvJournal.Columns.Add("Request ID", 210);

        _lblJournalEmpty = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            AccessibleName = "Empty journal note",
            Text = "No requests recorded yet.",
        };

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
        var sysGroup = new GroupBox
        {
            Text = "System",
            Dock = DockStyle.Fill,
            Padding = new Padding(10),
            AccessibleName = "System information",
        };
        var sysLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 4,
            AccessibleName = "System information values",
        };
        sysLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        sysLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

        sysLayout.Controls.Add(MakeFieldLabel("State directory", "State directory label"), 0, 0);
        _lblStateDirValue = new Label
        {
            AutoSize = true,
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
        var settingsGroup = new GroupBox
        {
            Text = "Settings",
            Dock = DockStyle.Fill,
            Padding = new Padding(10),
            AccessibleName = "Desktop settings",
        };
        var settingsLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 7,
            AccessibleName = "Desktop settings controls",
        };
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settingsLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

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
            ForeColor = Color.FromArgb(0x61, 0x61, 0x61),
            AccessibleName = "Port change note",
        };
        settingsLayout.Controls.Add(lblPortNote, 0, 3);
        settingsLayout.SetColumnSpan(lblPortNote, 3);

        _lblPortError = new Label
        {
            AutoSize = true,
            ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C),
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
            ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C),
            AccessibleName = "Journal settings validation error",
        };
        settingsLayout.Controls.Add(_lblRetentionError, 0, 7);
        settingsLayout.SetColumnSpan(_lblRetentionError, 3);

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

        ApplySnapshot(snapshot);
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
                _banner.BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0);
                _lblBannerText.Text = "Starting control service…";
                _btnRetry.Visible = false;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.Reconnecting:
                _banner.BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0);
                _lblBannerText.Text = "Reconnecting to control service…";
                _btnRetry.Visible = false;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.Unavailable:
                _banner.BackColor = Color.FromArgb(0xFF, 0xEB, 0xEE);
                _lblBannerText.Text = _channel.LastError ?? "Control service unavailable.";
                _btnRetry.Visible = true;
                _btnResetCredential.Visible = false;
                _btnResumeOnboarding.Visible = false;
                break;

            case ClientState.AuthFailed:
                _banner.BackColor = Color.FromArgb(0xFF, 0xEB, 0xEE);
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
    }

    /// <summary>Rendered state badge text (used by the selftest settle-check).</summary>
    internal string StateBadgeText => _lblStateBadge.Text;

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
        _banner.BackColor = Color.FromArgb(0xFF, 0xEB, 0xEE);
        _lblBannerText.Text = message;
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
        if (_localCredentialWarning)
        {
            _banner.Visible = true;
            _banner.BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0);
            _lblBannerText.Text = "Local router credential unavailable — run `gorouter setup` in a terminal to repair.";
            _btnRetry.Visible = false;
            _btnResetCredential.Visible = false;
            _btnResumeOnboarding.Visible = false;
        }
        else if (_onboardingPending)
        {
            _banner.Visible = true;
            _banner.BackColor = Color.FromArgb(0xFF, 0xF3, 0xE0);
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

        _lblDiagnosticsFeedback.ForeColor = isError ? Color.FromArgb(0xB7, 0x1C, 0x1C) : Color.FromArgb(0x1B, 0x5E, 0x20);
        _lblDiagnosticsFeedback.Text = message;
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
            _lblStateBadge.Text = RouterBadgeText(snapshot.Router);
            _lblStateBadge.ForeColor = RouterColor(snapshot.Router.State);
            _lblPort.Text = $"Port {snapshot.Settings.Port}";
            _lblVersion.Text = string.IsNullOrEmpty(snapshot.ServiceVersion) ? "" : $"v{snapshot.ServiceVersion}";
            _btnStartRouter.Enabled = snapshot.Router.State is not ("running" or "starting");
            _btnStopRouter.Enabled = snapshot.Router.State is "running" or "starting" or "degraded" or "port_conflict";

            _localCredentialWarning = snapshot.Initialized && !snapshot.LocalCredentialConfigured;
            RefreshBanner();

            FillLaneCombo(_cmbGo, snapshot.Routes.Go, _lblGoFeedback, _lblGoError);
            FillLaneCombo(_cmbZen, snapshot.Routes.Zen, _lblZenFeedback, _lblZenError);

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

            _lblStateDirValue.Text = string.IsNullOrEmpty(snapshot.StateDir) ? "—" : snapshot.StateDir;
            _lblSecretStoreValue.Text = snapshot.SecretStore == "ok"
                ? "ok"
                : "unavailable — restart the desktop app or check the state directory";
            _lblJournalInfoValue.Text = $"{snapshot.Journal.Records} records · retention {snapshot.Journal.RetentionDays}d · max {snapshot.Journal.MaxRecords}";
            _lblRouterInfoValue.Text = $"{snapshot.Router.State} · {snapshot.Router.Mode} · pid {(snapshot.Router.Pid > 0 ? snapshot.Router.Pid.ToString() : "—")} · restarts {snapshot.Router.RestartCount}";

            _txtPort.Text = snapshot.Settings.Port.ToString();
            _txtRetentionDays.Text = snapshot.Settings.JournalRetentionDays.ToString();
            _txtMaxRecords.Text = snapshot.Settings.JournalMaxRecords.ToString();
            _chkStartAtLogin.Checked = snapshot.Desktop.StartAtLogin;
            _chkMinimizeToTray.Checked = snapshot.Desktop.MinimizeToTray;
        }
        finally
        {
            _updating = false;
        }

        if (_tabs.SelectedTab == _tabJournal)
        {
            _ = RefreshJournalAsync();
        }
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

    private static Color RouterColor(string state) => state switch
    {
        "running" => Color.FromArgb(0x1B, 0x7A, 0x3D),
        "degraded" or "starting" => Color.FromArgb(0xC8, 0x7A, 0x00),
        "port_conflict" or "failed" => Color.FromArgb(0xC0, 0x2B, 0x1E),
        _ => Color.FromArgb(0x61, 0x61, 0x61),
    };

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
        cmb.Enabled = false;
        feedback.Text = "";
        error.Text = "";
        feedback.Text = accountId is null ? "Clearing lane…" : "Switching…";
        try
        {
            var response = accountId is null
                ? await _channel.CallAsync("route.clear", new { lane })
                : await _channel.CallAsync("route.set", new { lane, accountId });

            if (response.Ok)
            {
                var alias = accountId is null ? null : _snapshot.Accounts.FirstOrDefault(a => a.Id == accountId)?.Alias;
                error.Text = "";
                feedback.Text = accountId is null
                    ? "Lane cleared; new requests are not routed. In-flight requests keep their original route."
                    : $"New requests use {alias}; in-flight requests keep their original route.";
            }
            else
            {
                feedback.Text = "";
                // Revert the combo to the authoritative route: the control must
                // never keep displaying a selection that did not commit (PS-07).
                var route = lane == "go" ? _snapshot.Routes.Go : _snapshot.Routes.Zen;
                FillLaneCombo(cmb, route, feedback, error);
                error.Text = response.ErrorMessage ?? "Route change failed.";
            }
        }
        catch (Exception ex)
        {
            feedback.Text = "";
            var route = lane == "go" ? _snapshot.Routes.Go : _snapshot.Routes.Zen;
            FillLaneCombo(cmb, route, feedback, error);
            error.Text = ex.Message;
        }
        finally
        {
            setBusy(false);
            if (!_updating)
            {
                cmb.Enabled = _clientState == ClientState.Connected;
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
        _lblAccountsStatus.ForeColor = isError ? Color.FromArgb(0xB7, 0x1C, 0x1C) : Color.FromArgb(0x1B, 0x5E, 0x20);
        _lblAccountsStatus.Text = message;
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
            var response = await _channel.CallAsync("account.add", new { alias = dialog.Alias, secret = dialog.Secret }, 15_000);
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
            var response = await _channel.CallAsync("account.update", new { alias, secret = dialog.Secret }, 15_000);
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
            var response = await _channel.CallAsync("account.rename", new { alias, newAlias = dialog.NewAlias }, 15_000);
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
            var response = await _channel.CallAsync("account.remove", new { alias, force = true }, 15_000);
            if (response.Ok)
            {
                var cleared = response.TryDataAs<RemoveResult>(out var result) ? result?.ClearedLanes ?? Array.Empty<string>() : Array.Empty<string>();
                SetAccountsFeedback(
                    cleared.Count > 0
                        ? $"Account '{alias}' removed. Lane selection cleared ({string.Join(", ", cleared.Select(l => l.ToUpperInvariant()))})."
                        : $"Account '{alias}' removed.",
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

    private async Task RefreshJournalAsync()
    {
        if (_journalRefreshing || _clientState != ClientState.Connected)
        {
            return;
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

                var degraded = data.Degraded || _snapshot.Journal.Degraded;
                _lblJournalDegraded.Visible = degraded;
                _lblJournalDegraded.Text = degraded
                    ? "Journal degraded: " + (data.Error ?? _snapshot.Journal.LastError ?? "read failure") + " — recent requests may be incomplete."
                    : "";
                _lblJournalEmpty.Visible = data.Rows.Count == 0 && !degraded;
            }
            else
            {
                _lblJournalDegraded.Visible = true;
                _lblJournalDegraded.Text = "Journal unavailable: " + (response.ErrorMessage ?? "unknown error");
                _lblJournalEmpty.Visible = false;
            }
        }
        catch (Exception ex)
        {
            _lblJournalDegraded.Visible = true;
            _lblJournalDegraded.Text = "Journal unavailable: " + ex.Message;
            _lblJournalEmpty.Visible = false;
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
        _lblJournalStats.Text = $"records {journal.Records} · oldest {oldest} · newest {newest} · retention {journal.RetentionDays} days · max {journal.MaxRecords}";
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
        item.SubItems.Add(row.DurationMs + " ms");
        item.SubItems.Add(row.RouterRequestId);
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
        try
        {
            var response = await _channel.CallAsync("config.set", new { key = "port", value = raw }, 15_000);
            if (response.Ok)
            {
                SetSystemFeedback("Port saved. It applies to the next router start.", isError: false);
            }
            else
            {
                _lblPortError.Text = response.ErrorMessage ?? "Port change refused.";
            }
        }
        catch (Exception ex)
        {
            _lblPortError.Text = "Port change failed: " + ex.Message;
        }
    }

    private async void OnApplyRetentionClicked(object? sender, EventArgs e)
    {
        if (!int.TryParse(_txtRetentionDays.Text.Trim(), out var days) || days <= 0)
        {
            _lblRetentionError.Text = "Retention days must be a positive integer.";
            return;
        }

        if (!int.TryParse(_txtMaxRecords.Text.Trim(), out var maxRecords) || maxRecords <= 0)
        {
            _lblRetentionError.Text = "Max records must be a positive integer.";
            return;
        }

        _lblRetentionError.Text = "";
        try
        {
            var response = await _channel.CallAsync("config.set", new { key = "journalRetentionDays", value = days.ToString() }, 15_000);
            if (!response.Ok)
            {
                _lblRetentionError.Text = response.ErrorMessage ?? "Retention change refused.";
                return;
            }

            response = await _channel.CallAsync("config.set", new { key = "journalMaxRecords", value = maxRecords.ToString() }, 15_000);
            if (!response.Ok)
            {
                _lblRetentionError.Text = response.ErrorMessage ?? "Max records change refused.";
                return;
            }

            SetSystemFeedback("Journal settings saved.", isError: false);
        }
        catch (Exception ex)
        {
            _lblRetentionError.Text = "Journal settings failed: " + ex.Message;
        }
    }

    private async void OnCopyDiagnosticsClicked(object? sender, EventArgs e)
    {
        try
        {
            Clipboard.SetText(BuildDiagnosticsText());
            _lblDiagnosticsFeedback.ForeColor = Color.FromArgb(0x1B, 0x5E, 0x20);
            _lblDiagnosticsFeedback.Text = "Redacted diagnostics copied to the clipboard.";
        }
        catch (Exception ex)
        {
            _lblDiagnosticsFeedback.ForeColor = Color.FromArgb(0xB7, 0x1C, 0x1C);
            _lblDiagnosticsFeedback.Text = "Copy failed: " + ex.Message;
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
        sb.AppendLine($"secretStore: {snapshot.SecretStore}");
        sb.AppendLine($"settings: port={snapshot.Settings.Port} journalRetentionDays={snapshot.Settings.JournalRetentionDays} journalMaxRecords={snapshot.Settings.JournalMaxRecords}");
        sb.AppendLine($"router: state={snapshot.Router.State} mode={snapshot.Router.Mode} pid={snapshot.Router.Pid} restartCount={snapshot.Router.RestartCount}");
        sb.AppendLine($"routes: go={DescribeRoute(snapshot.Routes.Go)} zen={DescribeRoute(snapshot.Routes.Zen)}");
        foreach (var account in snapshot.Accounts)
        {
            sb.AppendLine($"account: alias={account.Alias} id={account.Id} secretPresent={account.SecretPresent} usedBy={string.Join(",", account.UsedBy)}");
        }

        sb.AppendLine($"journal: records={snapshot.Journal.Records} degraded={snapshot.Journal.Degraded} lastError={snapshot.Journal.LastError ?? ""} retentionDays={snapshot.Journal.RetentionDays} maxRecords={snapshot.Journal.MaxRecords}");
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
        }

        base.Dispose(disposing);
    }
}
