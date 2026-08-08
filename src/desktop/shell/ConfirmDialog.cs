namespace GoRouterDesktop;

/// <summary>Generic destructive-confirmation dialog (OK/Cancel).</summary>
public sealed class ConfirmDialog : Form
{
    public ConfirmDialog(string title, string message, string confirmText = "OK")
    {
        Text = title;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 170);

        var lbl = new Label
        {
            Text = message,
            AutoSize = true,
            Location = new Point(16, 16),
            MaximumSize = new Size(424, 0),
            AccessibleName = title + " message",
        };

        var btnOk = new Button
        {
            Text = confirmText,
            DialogResult = DialogResult.OK,
            Location = new Point(268, 116),
            Size = new Size(110, 30),
            TabIndex = 0,
            AccessibleName = confirmText,
        };
        var btnCancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(388, 116),
            Size = new Size(56, 30),
            TabIndex = 1,
            AccessibleName = "Cancel",
        };

        AcceptButton = btnOk;
        CancelButton = btnCancel;

        Controls.Add(lbl);
        Controls.Add(btnOk);
        Controls.Add(btnCancel);
    }
}
