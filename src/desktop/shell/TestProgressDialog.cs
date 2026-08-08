namespace GoRouterDesktop;

/// <summary>
/// Indeterminate progress shown while account.test runs (up to ~45s live
/// probe). The dialog is non-modal (Show, not ShowDialog) so the control
/// center stays responsive; closing it only abandons the wait, the server
/// operation continues and its response is ignored.
/// </summary>
public sealed class TestProgressDialog : Form
{
    public TestProgressDialog(string accountAlias)
    {
        Text = "Testing account";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(440, 160);

        var lbl = new Label
        {
            Text = $"Testing account '{accountAlias}'…",
            AutoSize = true,
            Location = new Point(16, 18),
            AccessibleName = "Test progress message",
        };
        var lblHint = new Label
        {
            Text = "A live probe may take up to 45 seconds. You can continue using the control center.",
            AutoSize = true,
            Location = new Point(16, 46),
            AccessibleName = "Test progress hint",
        };
        var bar = new ProgressBar
        {
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 30,
            Location = new Point(16, 76),
            Size = new Size(408, 16),
            TabIndex = 0,
            AccessibleName = "Test in progress",
        };
        var btnClose = new Button
        {
            Text = "Close",
            DialogResult = DialogResult.Cancel,
            Location = new Point(340, 110),
            Size = new Size(84, 30),
            TabIndex = 1,
            AccessibleName = "Close test progress",
        };

        CancelButton = btnClose;
        btnClose.Click += (_, _) => Close();

        Controls.AddRange(new Control[] { lbl, lblHint, bar, btnClose });
    }
}
