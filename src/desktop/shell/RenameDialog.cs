using System.Text.RegularExpressions;

namespace GoRouterDesktop;

/// <summary>Renames an account. Identity (id) is preserved across renames.</summary>
public sealed partial class RenameDialog : Form
{
    private static readonly Regex AliasRegex = GeneratedAliasRegex();

    private readonly TextBox _txtNewAlias;
    private readonly Label _lblError = new()
    {
        ForeColor = Color.Firebrick,
        AutoSize = true,
        AccessibleName = "Rename validation error",
    };

    public string? NewAlias { get; private set; }

    public RenameDialog(string currentAlias)
    {
        Text = "Rename account";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 170);

        var lbl = new Label
        {
            Text = "New alias",
            AutoSize = true,
            Location = new Point(16, 22),
            AccessibleName = "New alias label",
        };
        _txtNewAlias = new TextBox
        {
            Text = currentAlias,
            Location = new Point(140, 18),
            Size = new Size(300, 23),
            TabIndex = 0,
            AccessibleName = "New account alias",
        };

        _lblError.Location = new Point(16, 54);

        var btnOk = new Button
        {
            Text = "Rename",
            Location = new Point(356, 120),
            Size = new Size(84, 30),
            TabIndex = 1,
            AccessibleName = "Rename account",
        };
        var btnCancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(264, 120),
            Size = new Size(84, 30),
            TabIndex = 2,
            AccessibleName = "Cancel rename",
        };

        AcceptButton = btnOk;
        CancelButton = btnCancel;
        btnOk.Click += OnOkClicked;

        Controls.AddRange(new Control[] { lbl, _txtNewAlias, _lblError, btnOk, btnCancel });
    }

    private void OnOkClicked(object? sender, EventArgs e)
    {
        var alias = _txtNewAlias.Text.Trim();
        if (alias.Length == 0)
        {
            _lblError.Text = "Enter a new alias.";
            return;
        }

        if (!AliasRegex.IsMatch(alias))
        {
            _lblError.Text = "Alias must match [A-Za-z0-9._-]{1,64}.";
            return;
        }

        NewAlias = alias;
        DialogResult = DialogResult.OK;
        Close();
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$")]
    private static partial Regex GeneratedAliasRegex();
}
