using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace GoRouterDesktop;

/// <summary>
/// White rounded card surface painted over the page background. Children are
/// ordinary controls with BackColor = SurfaceWhite so they sit on the card
/// without per-control borders.
/// </summary>
internal class CardPanel : Panel
{
    private int _cornerRadius = 10;
    private Color _borderColor = VisualTheme.CardBorder;

    internal CardPanel()
    {
        BackColor = VisualTheme.SurfaceWhite;
        Padding = new Padding(18);
        DoubleBuffered = true;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal int CornerRadius
    {
        get => _cornerRadius;
        set
        {
            _cornerRadius = Math.Max(0, value);
            Invalidate();
        }
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color BorderColor
    {
        get => _borderColor;
        set
        {
            _borderColor = value;
            Invalidate();
        }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Paint the page background, then the rounded white surface inset by
        // the border width so the 1px border is not clipped.
        e.Graphics.Clear(Parent?.BackColor ?? VisualTheme.WindowBack);
        var bounds = new Rectangle(1, 1, Width - 2, Height - 2);
        VisualTheme.FillRounded(e.Graphics, bounds, CornerRadius, VisualTheme.SurfaceWhite);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var bounds = new Rectangle(1, 1, Width - 2, Height - 2);
        VisualTheme.DrawRounded(e.Graphics, bounds, CornerRadius, BorderColor, 1f);
    }
}

/// <summary>
/// Lane card: CardPanel with a 3px rounded accent strip at the top. GO uses
/// the green accent, ZEN the blue accent; both cards are structurally
/// identical for equal visual weight. Content is composed by the form.
/// </summary>
internal class LaneCard : CardPanel
{
    private readonly Color _accent;

    internal LaneCard(string title, string marker, Color accent)
    {
        _accent = accent;
        Margin = new Padding(0);
    }

    internal Color AccentColor => _accent;

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        // 3px rounded accent strip along the top edge, inset to match the border.
        var strip = new Rectangle(2, 2, Width - 4, 3);
        VisualTheme.FillRounded(e.Graphics, strip, 2, _accent);
    }
}

/// <summary>
/// Owner-drawn flat account selector: white surface, 1px field border, item
/// hover highlight. Keyboard navigation, type-ahead, drop-down sizing and
/// accessibility behavior of ComboBox are unchanged.
/// </summary>
internal class StyledSelector : ComboBox
{
    private Color _borderColor = VisualTheme.FieldBorder;

    internal StyledSelector()
    {
        DropDownStyle = ComboBoxStyle.DropDownList;
        FlatStyle = FlatStyle.Flat;
        DrawMode = DrawMode.OwnerDrawFixed;
        ItemHeight = 24;
        BackColor = VisualTheme.SurfaceWhite;
        ForeColor = VisualTheme.PrimaryText;
        Font = VisualTheme.BodyFont;
        IntegralHeight = false;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color BorderColor
    {
        get => _borderColor;
        set
        {
            _borderColor = value;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        VisualTheme.DrawRounded(e.Graphics, bounds, 4, _borderColor, 1f);
    }

    protected override void OnDrawItem(DrawItemEventArgs e)
    {
        if (e.Index < 0)
        {
            return;
        }

        var hover = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        var back = hover ? VisualTheme.HoverBack : VisualTheme.SurfaceWhite;
        using (var brush = new SolidBrush(back))
        {
            e.Graphics.FillRectangle(brush, e.Bounds);
        }

        var text = GetItemText(Items[e.Index]);
        TextRenderer.DrawText(
            e.Graphics,
            text,
            Font,
            new Rectangle(e.Bounds.X + 6, e.Bounds.Y, e.Bounds.Width - 12, e.Bounds.Height),
            hover ? VisualTheme.PrimaryText : VisualTheme.PrimaryText,
            TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

        if (hover)
        {
            using var pen = new Pen(VisualTheme.CardBorder);
            e.Graphics.DrawRectangle(pen, e.Bounds.X, e.Bounds.Y, e.Bounds.Width - 1, e.Bounds.Height - 1);
        }
    }
}

/// <summary>
/// Flat outline action button: white surface, 1px colored border, colored
/// text, hover fill. Disabled state renders gray. Danger() = red outline for
/// destructive actions; Neutral() = blue outline for regular actions.
/// </summary>
internal class ActionButton : Button
{
    internal ActionButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 1;
        FlatAppearance.BorderColor = VisualTheme.CardBorder;
        FlatAppearance.MouseOverBackColor = VisualTheme.HoverBack;
        FlatAppearance.MouseDownBackColor = VisualTheme.CardBorder;
        BackColor = VisualTheme.SurfaceWhite;
        ForeColor = VisualTheme.PrimaryText;
        Font = VisualTheme.BodyFont;
        UseVisualStyleBackColor = false;
        Cursor = Cursors.Hand;
        Height = 30;
        MinimumSize = new Size(0, 30);
    }

    internal static ActionButton Danger(string text)
    {
        var button = new ActionButton { Text = text };
        button.SetOutline(VisualTheme.Danger);
        return button;
    }

    internal static ActionButton Neutral(string text)
    {
        var button = new ActionButton { Text = text };
        button.SetOutline(VisualTheme.AccentZen);
        return button;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color BorderColor { get; private set; } = VisualTheme.CardBorder;

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color TextColor { get; private set; } = VisualTheme.PrimaryText;

    private void SetOutline(Color color)
    {
        BorderColor = color;
        TextColor = color;
        FlatAppearance.BorderColor = color;
        ForeColor = color;
    }

    protected override void OnPaint(PaintEventArgs pevent)
    {
        base.OnPaint(pevent);
        if (!Enabled)
        {
            // Restrained gray for disabled outline buttons.
            using var pen = new Pen(VisualTheme.MutedText);
            pevent.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        }
    }
}
