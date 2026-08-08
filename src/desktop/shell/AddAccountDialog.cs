using System.Text.RegularExpressions;

namespace GoRouterDesktop;

/// <summary>
/// New-account entry: alias + masked provider secret. The secret is sent once
/// over the control channel, never shown again, and the masked textbox is
/// cleared when the dialog closes.
/// </summary>
public sealed partial class AddAccountDialog : Form
{
    private static readonly Regex AliasRegex = GeneratedAliasRegex();

    private readonly TextBox _txtAlias = new();
    private readonly TextBox _txtSecret = new();
    private readonly Label _lblError = new()
    {
        ForeColor = Color.Firebrick,
        AutoSize = true,
        AccessibleName = "Add account validation error",
    };

    public string? Alias { get; private set; }
    public string? Secret { get; private set; }

    public AddAccountDialog()
    {
        Text = "Add account";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 228);

        var lblAlias = new Label
        {
            Text = "Alias",
            AutoSize = true,
            Location = new Point(16, 22),
            AccessibleName = "Alias label",
        };
        _txtAlias.Location = new Point(140, 18);
        _txtAlias.Size = new Size(300, 23);
        _txtAlias.TabIndex = 0;
        _txtAlias.AccessibleName = "Account alias (letters, digits, dot, underscore, dash)";

        var lblSecret = new Label
        {
            Text = "Secret",
            AutoSize = true,
            Location = new Point(16, 60),
            AccessibleName = "Secret label",
        };
        _txtSecret.Location = new Point(140, 56);
        _txtSecret.Size = new Size(300, 23);
        _txtSecret.TabIndex = 1;
        _txtSecret.PasswordChar = '●';
        _txtSecret.AccessibleName = "Provider secret — never shown again";

        _lblError.Location = new Point(16, 92);

        var hint = new Label
        {
            Text = "The secret is sent once, stored encrypted, and never displayed again.",
            AutoSize = true,
            Location = new Point(16, 122),
            AccessibleName = "Secret storage note",
        };

        var btnOk = new Button
        {
            Text = "Add",
            DialogResult = DialogResult.None,
            Location = new Point(356, 180),
            Size = new Size(84, 30),
            TabIndex = 2,
            AccessibleName = "Add account",
        };
        var btnCancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(264, 180),
            Size = new Size(84, 30),
            TabIndex = 3,
            AccessibleName = "Cancel add account",
        };

        AcceptButton = btnOk;
        CancelButton = btnCancel;
        btnOk.Click += OnOkClicked;

        Controls.AddRange(new Control[] { lblAlias, _txtAlias, lblSecret, _txtSecret, _lblError, hint, btnOk, btnCancel });
    }

    private void OnOkClicked(object? sender, EventArgs e)
    {
        var alias = _txtAlias.Text.Trim();
        var secret = _txtSecret.Text;
        if (alias.Length == 0)
        {
            _lblError.Text = "Enter an alias.";
            return;
        }

        if (!AliasRegex.IsMatch(alias))
        {
            _lblError.Text = "Alias must match [A-Za-z0-9._-]{1,64}.";
            return;
        }

        if (secret.Length == 0)
        {
            _lblError.Text = "Enter the provider secret.";
            return;
        }

        Alias = alias;
        Secret = secret;
        DialogResult = DialogResult.OK;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // The masked value never survives the dialog.
        _txtSecret.Clear();
        base.OnFormClosing(e);
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$")]
    private static partial Regex GeneratedAliasRegex();
}
