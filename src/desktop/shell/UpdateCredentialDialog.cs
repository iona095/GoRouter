namespace GoRouterDesktop;

/// <summary>
/// Replaces the stored credential for an existing account. The alias is fixed;
/// only a new masked secret is entered. Never shown again after storage; the
/// masked textbox is cleared when the dialog closes.
/// </summary>
public sealed class UpdateCredentialDialog : Form
{
    private readonly TextBox _txtSecret = new();
    private readonly Label _lblError = new()
    {
        ForeColor = Color.Firebrick,
        AutoSize = true,
        AccessibleName = "Update credential validation error",
    };

    public string? Secret { get; private set; }

    public UpdateCredentialDialog(string alias)
    {
        Text = "Update credential";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 200);

        var lblAlias = new Label
        {
            Text = "Account",
            AutoSize = true,
            Location = new Point(16, 22),
            AccessibleName = "Account label",
        };
        var txtAlias = new TextBox
        {
            Text = alias,
            ReadOnly = true,
            Location = new Point(140, 18),
            Size = new Size(300, 23),
            TabIndex = 0,
            AccessibleName = "Account alias (read only)",
        };

        var lblSecret = new Label
        {
            Text = "New secret",
            AutoSize = true,
            Location = new Point(16, 60),
            AccessibleName = "New secret label",
        };
        _txtSecret.Location = new Point(140, 56);
        _txtSecret.Size = new Size(300, 23);
        _txtSecret.TabIndex = 1;
        _txtSecret.PasswordChar = '●';
        _txtSecret.AccessibleName = "New provider secret — never shown again";

        _lblError.Location = new Point(16, 92);

        var btnOk = new Button
        {
            Text = "Update",
            Location = new Point(356, 152),
            Size = new Size(84, 30),
            TabIndex = 2,
            AccessibleName = "Update credential",
        };
        var btnCancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(264, 152),
            Size = new Size(84, 30),
            TabIndex = 3,
            AccessibleName = "Cancel update credential",
        };

        AcceptButton = btnOk;
        CancelButton = btnCancel;
        btnOk.Click += OnOkClicked;

        Controls.AddRange(new Control[] { lblAlias, txtAlias, lblSecret, _txtSecret, _lblError, btnOk, btnCancel });
    }

    private void OnOkClicked(object? sender, EventArgs e)
    {
        if (_txtSecret.Text.Length == 0)
        {
            _lblError.Text = "Enter the new provider secret.";
            return;
        }

        Secret = _txtSecret.Text;
        DialogResult = DialogResult.OK;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _txtSecret.Clear();
        base.OnFormClosing(e);
    }
}
