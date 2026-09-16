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
internal class CardPanel : Panel, IThemeAware
{
    private int _cornerRadius = VisualTheme.CardRadius;
    private Color _borderColor = VisualTheme.CardBorder;
    private Color _glowAccent = Color.Transparent;

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

    /// <summary>
    /// Vision UX outer glow accent. Transparent disables the glow (plain
    /// card); lane cards set their emerald/violet accent for the glowing
    /// control-center treatment.
    /// </summary>
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color GlowAccent
    {
        get => _glowAccent;
        set
        {
            _glowAccent = value;
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
        var bounds = new Rectangle(2, 2, Width - 4, Height - 4);
        if (_glowAccent != Color.Transparent && _glowAccent.A > 0)
        {
            VisualTheme.DrawGlowFrame(e.Graphics, bounds, CornerRadius, BorderColor, _glowAccent);
        }
        else
        {
            VisualTheme.DrawRounded(e.Graphics, bounds, CornerRadius, BorderColor, 1f);
        }
    }

    public virtual void RefreshTheme()
    {
        BorderColor = VisualTheme.Map(BorderColor);
        if (_glowAccent != Color.Transparent)
        {
            _glowAccent = VisualTheme.Map(_glowAccent);
        }
        BackColor = VisualTheme.Map(BackColor);
        Invalidate();
    }
}

/// <summary>
/// Lane card: CardPanel with the Vision UX glowing frame in the lane accent
/// (GO emerald, ZEN violet) plus a 3px rounded accent strip at the top.
/// Both cards are structurally identical for equal visual weight; content is
/// composed by the form through one shared builder.
/// </summary>
internal class LaneCard : CardPanel
{
    private Color _accent;

    internal LaneCard(string title, string marker, Color accent)
    {
        _accent = accent;
        GlowAccent = accent;
        Margin = new Padding(0);
    }

    internal Color AccentColor => _accent;

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        // 3px rounded accent strip along the top edge, inset to match the border.
        var strip = new Rectangle(4, 4, Width - 8, 3);
        VisualTheme.FillRounded(e.Graphics, strip, 2, _accent);
    }

    public override void RefreshTheme()
    {
        _accent = VisualTheme.Map(_accent);
        base.RefreshTheme();
        GlowAccent = _accent;
    }
}

/// <summary>
/// Owner-drawn flat account selector: white surface, 1px field border, item
/// hover highlight. Keyboard navigation, type-ahead, drop-down sizing and
/// accessibility behavior of ComboBox are unchanged.
/// </summary>
internal class StyledSelector : ComboBox, IThemeAware
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

    public void RefreshTheme()
    {
        BackColor = VisualTheme.Map(BackColor);
        ForeColor = VisualTheme.Map(ForeColor);
        BorderColor = VisualTheme.Map(BorderColor);
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
/// text, tinted hover fill, neutral press. Disabled state renders gray.
/// Danger() = red outline for destructive actions; Neutral() = blue
/// outline for regular actions.
/// </summary>
internal class ActionButton : Button, IThemeAware
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
        // Breathing room: generous side padding so labels never sit on
        // the border; content-sized width with a 32px height floor for an
        // easy pointer target.
        Padding = new Padding(14, 0, 14, 0);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(0, 32);
    }

    internal static ActionButton Danger(string text)
    {
        var button = new ActionButton { Text = text };
        button.SetOutline(VisualTheme.Danger, VisualTheme.ErrorBoxBack);
        return button;
    }

    /// <summary>
    /// Vision UX destructive primary: filled red Stop button (white text).
    /// Used for the header Stop action; the Start action stays a restrained
    /// outlined Neutral button.
    /// </summary>
    internal static ActionButton DangerSolid(string text)
    {
        var button = new ActionButton { Text = text };
        button.SetSolid(VisualTheme.Danger);
        return button;
    }

    internal static ActionButton Neutral(string text)
    {
        var button = new ActionButton { Text = text };
        button.SetOutline(VisualTheme.AccentZen, VisualTheme.SelectedRowBack);
        return button;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color BorderColor { get; private set; } = VisualTheme.CardBorder;

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal Color TextColor { get; private set; } = VisualTheme.PrimaryText;

    private bool _solid;

    // Visual slice 8: outlined buttons hover in their own tint; the press
    // fill stays neutral (MouseDownBackColor from the constructor). The
    // hover tint is a token, so RefreshTheme re-resolves it like the rest.
    private void SetOutline(Color color, Color? hover = null)
    {
        _solid = false;
        BorderColor = color;
        TextColor = color;
        FlatAppearance.BorderColor = color;
        ForeColor = color;
        BackColor = VisualTheme.SurfaceWhite;
        FlatAppearance.MouseOverBackColor = hover ?? VisualTheme.HoverBack;
    }

    private void SetSolid(Color color)
    {
        _solid = true;
        BorderColor = color;
        TextColor = Color.White;
        FlatAppearance.BorderColor = color;
        BackColor = color;
        ForeColor = Color.White;
        FlatAppearance.MouseOverBackColor = color;
        FlatAppearance.MouseDownBackColor = color;
        Font = new Font(Font, FontStyle.Bold);
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

    public void RefreshTheme()
    {
        if (_solid)
        {
            // Solid destructive buttons keep white text on the danger token.
            var danger = VisualTheme.Map(BorderColor);
            BorderColor = danger;
            TextColor = Color.White;
            FlatAppearance.BorderColor = danger;
            BackColor = danger;
            ForeColor = Color.White;
            FlatAppearance.MouseOverBackColor = danger;
            FlatAppearance.MouseDownBackColor = danger;
            Invalidate();
            return;
        }
        BackColor = VisualTheme.Map(BackColor);
        // Outlined buttons keep text == outline color (SetOutline contract);
        // plain buttons resolve text and border independently.
        if (ForeColor.ToArgb() == BorderColor.ToArgb())
        {
            SetOutline(VisualTheme.Map(BorderColor), VisualTheme.Map(FlatAppearance.MouseOverBackColor));
        }
        else
        {
            ForeColor = VisualTheme.Map(ForeColor);
            FlatAppearance.BorderColor = VisualTheme.Map(BorderColor);
            BorderColor = VisualTheme.Map(BorderColor);
        }
        FlatAppearance.MouseOverBackColor = VisualTheme.Map(FlatAppearance.MouseOverBackColor);
        FlatAppearance.MouseDownBackColor = VisualTheme.Map(FlatAppearance.MouseDownBackColor);
        Invalidate();
    }
}

/// <summary>
/// Vision UX status pill: dot + label in a rounded outline (Running pill,
/// Managed chips). Colors resolve live from <see cref="VisualTheme"/> tokens
/// at paint time so theme toggles only invalidate. Presentation-only.
/// </summary>
internal enum PillKind
{
    Success,
    Warning,
    Danger,
    Neutral,
    Info,
}

internal sealed class StatusPill : Control, IThemeAware
{
    private string _text = "";
    private PillKind _kind = PillKind.Neutral;

    internal StatusPill()
    {
        DoubleBuffered = true;
        AutoSize = true;
        Font = VisualTheme.SmallFont;
        AccessibleRole = AccessibleRole.StaticText;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal PillKind Kind
    {
        get => _kind;
        set
        {
            _kind = value;
            Invalidate();
        }
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal new string Text
    {
        get => _text;
        set
        {
            _text = value;
            AccessibleName = value;
            Invalidate();
        }
    }

    internal static Color KindColor(PillKind kind)
    {
        return kind switch
        {
            PillKind.Success => VisualTheme.Healthy,
            PillKind.Warning => VisualTheme.Warning,
            PillKind.Danger => VisualTheme.Danger,
            PillKind.Info => VisualTheme.AccentBlue,
            _ => VisualTheme.MutedText,
        };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var accent = KindColor(_kind);
        var g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        var bounds = new Rectangle(1, 1, Width - 2, Height - 2);
        using (var back = new SolidBrush(VisualTheme.SurfaceWhite))
        using (var path = VisualTheme.RoundedRect(bounds, Height / 2))
        {
            g.FillPath(back, path);
        }
        VisualTheme.DrawRounded(g, bounds, Height / 2, accent, 1f);
        var dotR = 4;
        var dotY = Height / 2;
        using (var dot = new SolidBrush(accent))
        {
            g.FillEllipse(dot, 10, dotY - dotR, dotR * 2, dotR * 2);
        }
        using (var brush = new SolidBrush(VisualTheme.PrimaryText))
        using (var format = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center })
        {
            var textBounds = new Rectangle(24, 0, Width - 30, Height);
            g.DrawString(_text, Font, brush, textBounds, format);
        }
    }

    public override Size GetPreferredSize(Size proposedSize)
    {
        using var g = CreateGraphics();
        var textSize = g.MeasureString(_text, Font);
        return new Size((int)textSize.Width + 40, Math.Max(24, (int)textSize.Height + 10));
    }

    public void RefreshTheme()
    {
        Font = VisualTheme.SmallFont;
        Invalidate();
    }
}

/// <summary>
/// Vision UX metric block: caption + bold value + optional hint. All colors
/// resolve live from tokens; the form feeds truthful values computed from
/// the already-loaded journal.recent window plus snapshot journal totals.
/// </summary>
internal sealed class MetricBlock : Panel, IThemeAware
{
    private readonly Label _caption;
    private readonly Label _value;
    private readonly bool _compact;

    internal MetricBlock(string caption, bool compact = false)
    {
        DoubleBuffered = true;
        BackColor = VisualTheme.SurfaceWhite;
        AutoSize = true;
        _compact = compact;
        _caption = new Label
        {
            Text = caption,
            AutoSize = true,
            Font = VisualTheme.MetricCaptionFont,
            ForeColor = VisualTheme.SecondaryText,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = caption,
        };
        _value = new Label
        {
            Text = "—",
            AutoSize = true,
            Font = compact ? VisualTheme.SectionTitleFont : VisualTheme.MetricValueFont,
            ForeColor = VisualTheme.PrimaryText,
            BackColor = VisualTheme.SurfaceWhite,
            AccessibleName = caption + " value",
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = VisualTheme.SurfaceWhite,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(_caption, 0, 0);
        layout.Controls.Add(_value, 0, 1);
        Controls.Add(layout);
    }

    internal void SetValue(string value)
    {
        if (_value.Text != value)
        {
            _value.Text = value;
        }
    }

    internal void SetCaption(string caption)
    {
        if (_caption.Text != caption)
        {
            _caption.Text = caption;
        }
    }

    public void RefreshTheme()
    {
        BackColor = VisualTheme.Map(BackColor);
        _caption.ForeColor = VisualTheme.Map(_caption.ForeColor);
        _caption.BackColor = VisualTheme.Map(_caption.BackColor);
        _value.ForeColor = VisualTheme.Map(_value.ForeColor);
        _value.BackColor = VisualTheme.Map(_value.BackColor);
        _caption.Font = VisualTheme.MetricCaptionFont;
        _value.Font = _compact ? VisualTheme.SectionTitleFont : VisualTheme.MetricValueFont;
        Invalidate();
    }
}

/// <summary>
/// <summary>
/// Vision UX tab strip: a TabControl whose background erases to the live
/// page token. The OS visual-style theme paints the strip behind the tab
/// buttons white regardless of BackColor; in dark mode the theme is removed
/// (see ControlCenterForm.SyncFlatSurfacesTheme) and this erase fill keeps
/// the filler area navy. Item painting stays in the form's owner-draw
/// handler; page switching and keyboard behavior are unchanged.
/// </summary>
internal sealed class VisionTabControl : TabControl
{
    internal VisionTabControl()
    {
        DrawMode = TabDrawMode.OwnerDrawFixed;
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_ERASEBKGND = 0x0014;
        if (m.Msg == WM_ERASEBKGND && VisualTheme.Mode == ThemeMode.Dark)
        {
            try
            {
                using var g = Graphics.FromHdc(m.WParam);
                using var brush = new SolidBrush(VisualTheme.WindowBack);
                g.FillRectangle(brush, ClientRectangle);
                m.Result = (IntPtr)1;
                return;
            }
            catch
            {
                // Cosmetic only; fall through to default painting.
            }
        }
        base.WndProc(ref m);
    }
}

/// Truthful metrics derived from already-loaded journal.recent rows plus the
/// snapshot journal total. No backend/protocol change: counts, success rate
/// (ok / completed) and average latency (completed rows with duration) come
/// from the current window (up to 200 rows); totals come from the snapshot.
/// Empty windows render as em-dashes, never fabricated values.
/// </summary>
internal static class JournalStats
{
    internal sealed record WindowStats(int Total, int Completed, int Ok, double SuccessRate, double AvgLatencyMs, int WithinHour);

    internal static WindowStats Compute(IReadOnlyList<JournalRow> rows, DateTimeOffset? now = null)
    {
        var reference = now ?? DateTimeOffset.UtcNow;
        var total = rows.Count;
        var completed = 0;
        var ok = 0;
        long latencySum = 0;
        var latencyCount = 0;
        var withinHour = 0;
        foreach (var row in rows)
        {
            // DurationMs is nullable on the wire (null for in-flight rows).
            var hasLatency = row.DurationMs.HasValue && row.DurationMs.Value > 0;
            var done = !string.IsNullOrEmpty(row.CompletedAtUtc) || hasLatency;
            if (done)
            {
                completed++;
                if (string.Equals(row.TerminalOutcome, "ok", StringComparison.OrdinalIgnoreCase))
                {
                    ok++;
                }
                if (hasLatency)
                {
                    latencySum += row.DurationMs!.Value;
                    latencyCount++;
                }
            }
            if (DateTimeOffset.TryParse(row.StartedAtUtc, out var started) && (reference - started).TotalHours < 1 && (reference - started).TotalHours >= 0)
            {
                withinHour++;
            }
        }
        var rate = completed > 0 ? (double)ok / completed * 100.0 : double.NaN;
        var avg = latencyCount > 0 ? (double)latencySum / latencyCount : double.NaN;
        return new WindowStats(total, completed, ok, rate, avg, withinHour);
    }

    internal static WindowStats ComputeForLane(IReadOnlyList<JournalRow> rows, string lane, DateTimeOffset? now = null)
    {
        var filtered = rows.Where(r => string.Equals(r.Lane, lane, StringComparison.OrdinalIgnoreCase)).ToList();
        return Compute(filtered, now);
    }

    internal static string FormatRate(double rate)
    {
        return double.IsNaN(rate) ? "—" : rate.ToString("0.0") + "%";
    }

    internal static string FormatLatency(double avgMs)
    {
        if (double.IsNaN(avgMs))
        {
            return "—";
        }
        return avgMs >= 1000 ? (avgMs / 1000.0).ToString("0.0") + " s" : ((int)Math.Round(avgMs)).ToString() + " ms";
    }
}

/// <summary>
/// Vision UX lane glyph: geometric GO cube (emerald) / ZEN layers (violet)
/// drawn with <see cref="Graphics"/> primitives inside a rounded lane-tint
/// container. No external assets, no emoji.
/// </summary>
internal sealed class LaneIcon : Control, IThemeAware
{
    private readonly bool _isGo;

    internal LaneIcon(bool isGo)
    {
        _isGo = isGo;
        DoubleBuffered = true;
        Size = new Size(40, 40);
        MinimumSize = new Size(40, 40);
        MaximumSize = new Size(40, 40);
        AccessibleRole = AccessibleRole.Graphic;
        AccessibleName = isGo ? "GO lane icon" : "ZEN lane icon";
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        var accent = _isGo ? VisualTheme.AccentGo : VisualTheme.AccentZen;
        var tint = _isGo ? VisualTheme.GoSurface : VisualTheme.ZenSurface;
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        VisualTheme.FillRounded(g, bounds, 10, tint);
        var cx = Width / 2f;
        var cy = Height / 2f;
        using var pen = new Pen(accent, 2f);
        using var brush = new SolidBrush(accent);
        if (_isGo)
        {
            // Cube: hexagon + inner Y.
            var r = 10f;
            var pts = new PointF[6];
            for (var i = 0; i < 6; i++)
            {
                var a = Math.PI / 6 + i * Math.PI / 3;
                pts[i] = new PointF(cx + (float)(Math.Cos(a) * r), cy + (float)(Math.Sin(a) * r));
            }
            g.DrawPolygon(pen, pts);
            g.DrawLine(pen, cx, cy, cx, cy + r * 0.87f);
            g.DrawLine(pen, cx, cy, cx - r * 0.87f, cy - r * 0.5f);
            g.DrawLine(pen, cx, cy, cx + r * 0.87f, cy - r * 0.5f);
            g.FillEllipse(brush, cx - 1.5f, cy - 1.5f, 3, 3);
        }
        else
        {
            // Layers: three stacked chevrons.
            for (var i = 0; i < 3; i++)
            {
                var y = cy - 7 + i * 6;
                var pts = new[] { new PointF(cx - 9, y), new PointF(cx, y + 4.5f), new PointF(cx + 9, y) };
                g.DrawLines(pen, pts);
            }
        }
    }

    public void RefreshTheme()
    {
        Invalidate();
    }
}
