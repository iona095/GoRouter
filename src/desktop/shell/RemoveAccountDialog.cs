namespace GoRouterDesktop;

/// <summary>
/// Explicit remove confirmation. When the account is currently selected by a
/// lane, the dialog states exactly what happens: that lane selection is
/// cleared (no other account is chosen automatically), and the user must
/// acknowledge it before the Remove button is enabled.
/// </summary>
public sealed class RemoveAccountDialog : Form
{
    public bool Confirmed { get; private set; }

    public RemoveAccountDialog(string alias, IReadOnlyList<string> usedByLanes)
    {
        Text = "Remove account";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(470, 240);

        var lblTitle = new Label
        {
            Text = $"Remove account '{alias}'?",
            Font = new Font(Font, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(16, 16),
            AccessibleName = "Remove account confirmation title",
        };

        var lblConsequence = new Label
        {
            AutoSize = true,
            Location = new Point(16, 48),
            MaximumSize = new Size(430, 0),
            AccessibleName = "Removal consequence",
        };

        CheckBox? chkUnderstand = null;
        if (usedByLanes.Count > 0)
        {
            lblConsequence.Text =
                $"This account is currently selected for: {string.Join(", ", usedByLanes.Select(l => l.ToUpperInvariant()))}." +
                Environment.NewLine +
                "Removing it clears the lane selection. No other account is chosen automatically.";
            chkUnderstand = new CheckBox
            {
                Text = "I understand the lane selection will be cleared.",
                AutoSize = true,
                Location = new Point(16, 116),
                TabIndex = 0,
                AccessibleName = "Acknowledge that the lane selection will be cleared",
            };
        }
        else
        {
            lblConsequence.Text = "The account and its stored credential will be removed. Routes are not affected.";
        }

        var btnRemove = new Button
        {
            Text = "Remove account",
            Location = new Point(306, 184),
            Size = new Size(144, 30),
            TabIndex = 2,
            AccessibleName = "Confirm remove account",
        };
        var btnCancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(214, 184),
            Size = new Size(84, 30),
            TabIndex = 3,
            AccessibleName = "Cancel remove account",
        };

        if (chkUnderstand is not null)
        {
            btnRemove.Enabled = false;
            chkUnderstand.CheckedChanged += (_, _) => btnRemove.Enabled = chkUnderstand.Checked;
        }

        btnRemove.Click += (_, _) =>
        {
            Confirmed = true;
            DialogResult = DialogResult.OK;
            Close();
        };

        AcceptButton = btnRemove;
        CancelButton = btnCancel;

        Controls.Add(lblTitle);
        Controls.Add(lblConsequence);
        if (chkUnderstand is not null)
        {
            Controls.Add(chkUnderstand);
        }

        Controls.Add(btnRemove);
        Controls.Add(btnCancel);
    }
}
