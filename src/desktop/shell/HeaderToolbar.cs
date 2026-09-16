using System.ComponentModel;
using System.Drawing.Drawing2D;

namespace GoRouterDesktop;

/// <summary>
/// Header icon kinds for the toolbar navigation (vector-drawn, no assets).
/// </summary>
internal enum HeaderNavIcon
{
    Routing,
    Accounts,
    Journal,
    System,
}

/// <summary>
/// Header metric icon kinds (vector-drawn, no assets).
/// </summary>
internal enum HeaderMetricIcon
{
    Requests,
    Success,
    Latency,
}

/// <summary>
/// Header-scoped color targets for the navigation/statistics toolbar,
/// estimated from the Vision reference (1439px). Kept local so global page
/// tokens stay untouched.
/// </summary>
internal static class HeaderColors
{
    internal static Color ToolbarTop => VisualTheme.Mode == ThemeMode.Dark ? C(0x0A1522) : C(0xFFFFFF);
    internal static Color ToolbarBottom => VisualTheme.Mode == ThemeMode.Dark ? C(0x070F19) : C(0xF1F4F9);
    internal static Color ToolbarBorder => VisualTheme.Mode == ThemeMode.Dark ? C(0x263C56) : C(0xD7E0EC);
    internal static Color NavText => VisualTheme.Mode == ThemeMode.Dark ? C(0x9EB7DA) : C(0x5B6B82);
    internal static Color NavActiveText => VisualTheme.Mode == ThemeMode.Dark ? C(0xEDF3FF) : C(0x111827);
    internal static Color Separator => VisualTheme.Mode == ThemeMode.Dark ? C(0x1D344C) : C(0xD7E0EC);
    internal static Color ActiveBlue => C(0x199DFF);
    internal static Color MetricBorder => VisualTheme.Mode == ThemeMode.Dark ? C(0x1C3550) : C(0xD7E0EC);
    internal static Color MetricTop => VisualTheme.Mode == ThemeMode.Dark ? C(0x091522) : C(0xFFFFFF);
    internal static Color MetricBottom => VisualTheme.Mode == ThemeMode.Dark ? C(0x07101A) : C(0xEEF2F7);
    internal static Color MetricLabel => VisualTheme.Mode == ThemeMode.Dark ? C(0x9EB7DA) : C(0x5B6B82);
    internal static Color MetricValue => VisualTheme.Mode == ThemeMode.Dark ? C(0xEDF3FF) : C(0x111827);

    private static Color C(uint rgb) => Color.FromArgb((int)(0xFF000000 | rgb));
}

/// <summary>
/// One navigation item in the header toolbar: 28px vector icon + label, no
/// borders, short trailing separator (except the last item), blue underline
/// + radial wash when active. Full-height clickable region with keyboard
/// support (Enter/Space activates, arrows move). Icons are drawn, so screen
/// readers only announce the label.
/// </summary>
internal sealed class HeaderNavItem : Control, IThemeAware
{
    private bool _active;
    private bool _hover;

    internal HeaderNavItem(string text, HeaderNavIcon icon, int width)
    {
        Text = text;
        Icon = icon;
        DoubleBuffered = true;
        SetStyle(ControlStyles.SupportsTransparentBackColor, true);
        TabStop = true;
        Size = new Size(width, 66);
        // Reference floor only: labels that cannot fit shrink their font
        // (see FitLabelFont) instead of trimming, and the metrics group
        // wraps to a second row instead of overlapping.
        MinimumSize = new Size(width, 0);
        Font = HeaderFonts.NavInactive;
        ForeColor = HeaderColors.NavText;
        BackColor = Color.Transparent;
        AccessibleRole = AccessibleRole.PushButton;
        AccessibleName = text;
        AccessibleDescription = "Show the " + text + " tab.";
        Cursor = Cursors.Hand;
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal HeaderNavIcon Icon { get; }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool Active
    {
        get => _active;
        set
        {
            if (_active != value)
            {
                _active = value;
                Font = value ? HeaderFonts.NavActive : HeaderFonts.NavInactive;
                ForeColor = value ? HeaderColors.NavActiveText : HeaderColors.NavText;
                Invalidate();
            }
        }
    }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal bool ShowSeparator { get; set; } = true;

    internal event EventHandler? Activated;

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        _hover = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        _hover = false;
        Invalidate();
    }

    protected override void OnClick(EventArgs e)
    {
        base.OnClick(e);
        Focus();
        Activated?.Invoke(this, EventArgs.Empty);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            Activated?.Invoke(this, EventArgs.Empty);
            return;
        }
        if (e.KeyCode == Keys.Right || e.KeyCode == Keys.Left)
        {
            e.Handled = true;
            Parent?.SelectNextControl(this, e.KeyCode == Keys.Right, tabStopOnly: true, nested: false, wrap: true);
            return;
        }
        base.OnKeyDown(e);
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var w = Width;
        var h = Height;

        if (_active)
        {
            // Subtle blue wash, strongest near the lower center.
            var washBounds = new Rectangle(0, 0, w, h);
            using (var washPath = new GraphicsPath())
            {
                washPath.AddEllipse(new Rectangle(w / 2 - w, h - h / 2 - 8, w * 2, h));
                using var wash = new PathGradientBrush(washPath);
                wash.CenterPoint = new PointF(w * 0.48f, h);
                wash.CenterColor = Color.FromArgb(59, 0, 112, 255);
                wash.SurroundColors = new[] { Color.FromArgb(0, 0, 112, 255) };
                g.FillRectangle(wash, washBounds);
            }
        }
        else if (_hover)
        {
            using var hover = new SolidBrush(Color.FromArgb(14, 25, 157, 255));
            g.FillRectangle(hover, new Rectangle(0, 0, w, h));
        }

        // Icon: 28px box, 20px left padding, vertically centered. (The
        // reference estimates 24px; 20px holds a single row at the default
        // window width while staying within estimate tolerance.)
        var iconBox = new Rectangle(20, (h - 28) / 2, 28, 28);
        var iconColor = _active ? HeaderColors.ActiveBlue : _hover ? HeaderColors.NavActiveText : HeaderColors.NavText;
        HeaderIconPainter.DrawNav(g, Icon, iconBox, iconColor, _active);

        // Label: 17px gap after the icon. GDI text (not DrawString): it is
        // measured with the same device context it draws on, then shrunk
        // to fit, so labels stay single-line on any machine/DPI/font
        // instead of trimming or wrapping and breaking the 78px bar.
        var textBounds = new Rectangle(iconBox.Right + 17, 0, w - (iconBox.Right + 17) - 8, h);
        // Paint never mutates layout (a paint-time grow/reflow cycle hung
        // teardown intermittently): widths come from construction estimates
        // and shrink-to-fit below only ever picks a smaller font.
        var labelFont = FitLabelFont(g, Text, Font, textBounds.Width);
        try
        {
            TextRenderer.DrawText(
                g,
                Text,
                labelFont,
                textBounds,
                ForeColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
        finally
        {
            if (!ReferenceEquals(labelFont, Font))
            {
                labelFont.Dispose();
            }
        }

        if (_active)
        {
            // Illuminated underline: 4px bar near the inner bottom edge with
            // a restrained outer glow.
            var bar = new Rectangle(3, h - 9, w - 12, 4);
            using (var glowPath = VisualTheme.RoundedRect(new Rectangle(bar.X - 2, bar.Y - 2, bar.Width + 4, bar.Height + 4), 4))
            using (var glow = new SolidBrush(Color.FromArgb(46, 0, 119, 255)))
            {
                g.FillPath(glow, glowPath);
            }
            using (var barPath = VisualTheme.RoundedRect(bar, 2))
            using (var fill = new SolidBrush(HeaderColors.ActiveBlue))
            {
                g.FillPath(fill, barPath);
            }
        }

        if (ShowSeparator)
        {
            using var sep = new Pen(HeaderColors.Separator, 1f);
            var x = w - 1;
            g.DrawLine(sep, x, (h - 32) / 2f, x, (h + 32) / 2f);
        }

        if (Focused)
        {
            using var focus = new Pen(HeaderColors.ActiveBlue, 2f);
            g.DrawPath(focus, VisualTheme.RoundedRect(new Rectangle(2, 2, w - 4, h - 4), 6));
        }
    }

    public void RefreshTheme()
    {
        Font = _active ? HeaderFonts.NavActive : HeaderFonts.NavInactive;
        ForeColor = _active ? HeaderColors.NavActiveText : HeaderColors.NavText;
        Invalidate();
    }

    /// <summary>
    /// Returns <paramref name="baseFont"/> when the text fits, else a
    /// smaller same-family style clone (never below 12px) that does. The
    /// caller disposes the result unless it is <paramref name="baseFont"/>.
    /// </summary>
    private static Font FitLabelFont(Graphics g, string text, Font baseFont, int availWidth)
    {
        // Descend to a 12px floor and keep the smallest tried clone: when
        // nothing fits, a small whole label beats a large truncated one.
        Font? smallest = null;
        var size = baseFont.Size;
        while (size >= 9f)
        {
            var trial = new Font(baseFont.FontFamily, size, baseFont.Style, GraphicsUnit.Point);
            var need = TextRenderer.MeasureText(g, text, trial, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Width;
            if (need <= availWidth)
            {
                if (smallest is not null)
                {
                    smallest.Dispose();
                }
                if (size == baseFont.Size) { trial.Dispose(); return baseFont; }
                return trial;
            }
            smallest?.Dispose();
            smallest = trial;
            size -= 1f;
        }
        return smallest ?? baseFont;
    }
}

/// <summary>
/// A panel with a transparent background for layering inside the gradient
/// toolbar surface. Plain Panel rejects transparent colors.
/// </summary>
internal sealed class TransparentPanel : Panel
{
    internal TransparentPanel()
    {
        SetStyle(ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }
}

/// <summary>
/// Header-scoped fonts. Sizes are px-equivalent logical units matching the
/// reference (nav 20px, metric label 14px, metric value 20px).
/// </summary>
internal static class HeaderFonts
{
    private static Font Make(float px, FontStyle style)
    {
        // NB: new Font with an unknown family does NOT throw — it silently
        // substitutes Microsoft Sans Serif. Resolve against installed
        // families explicitly (Segoe UI Variable is Win11-only).
        return new Font(HeaderFontFamily.Resolve(), px * 72f / 96f, style);
    }

    internal static Font NavInactive { get; } = Make(20f, FontStyle.Regular);
    internal static Font NavActive { get; } = Make(20f, FontStyle.Bold);
    internal static Font MetricLabel { get; } = Make(14f, FontStyle.Regular);
    internal static Font MetricValue { get; } = Make(20f, FontStyle.Bold);
}

/// <summary>
/// Installed-family resolution shared by header fonts: Segoe UI Variable
/// where present, Segoe UI otherwise, generic sans as a last resort.
/// </summary>
internal static class HeaderFontFamily
{
    private static readonly Lazy<string> _resolved = new(ResolveCore, true);

    internal static string Resolve() => _resolved.Value;

    private static string ResolveCore()
    {
        try
        {
            var installed = new HashSet<string>(
                FontFamily.Families.Select(f => f.Name),
                StringComparer.OrdinalIgnoreCase);
            if (installed.Contains("Segoe UI Variable"))
            {
                return "Segoe UI Variable";
            }
            if (installed.Contains("Segoe UI"))
            {
                return "Segoe UI";
            }
        }
        catch
        {
            // Fall through to the generic family below.
        }
        return FontFamily.GenericSansSerif.Name;
    }
}

/// <summary>
/// Vector icon painting for header navigation and metric cards. All shapes
/// are Graphics primitives with round caps/joins: no assets, no emoji.
/// </summary>
internal static class HeaderIconPainter
{
    internal static void DrawNav(Graphics g, HeaderNavIcon icon, Rectangle box, Color color, bool glow)
    {
        var mode = g.SmoothingMode;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        try
        {
            using var pen = new Pen(color, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
            switch (icon)
            {
                case HeaderNavIcon.Routing:
                    DrawNetwork(g, box, color, glow);
                    break;
                case HeaderNavIcon.Accounts:
                    // Outlined person: head + shoulders.
                    g.DrawEllipse(pen, box.X + 9.5f, box.Y + 4, 9, 9);
                    using (var shoulders = new GraphicsPath())
                    {
                        shoulders.AddBezier(
                            new PointF(box.X + 4, box.Y + 25),
                            new PointF(box.X + 4, box.Y + 18),
                            new PointF(box.X + 9, box.Y + 17),
                            new PointF(box.X + 14, box.Y + 17));
                        shoulders.AddBezier(
                            new PointF(box.X + 14, box.Y + 17),
                            new PointF(box.X + 19, box.Y + 17),
                            new PointF(box.X + 24, box.Y + 18),
                            new PointF(box.X + 24, box.Y + 25));
                        g.DrawPath(pen, shoulders);
                    }
                    break;
                case HeaderNavIcon.Journal:
                    // Outlined document with folded corner + text lines.
                    using (var doc = new GraphicsPath())
                    {
                        doc.AddLines(new[]
                        {
                            new PointF(box.X + 7, box.Y + 3),
                            new PointF(box.X + 17, box.Y + 3),
                            new PointF(box.X + 21, box.Y + 7),
                            new PointF(box.X + 21, box.Y + 25),
                            new PointF(box.X + 7, box.Y + 25),
                        });
                        doc.CloseFigure();
                        g.DrawPath(pen, doc);
                    }
                    g.DrawLine(pen, box.X + 17, box.Y + 3, box.X + 17, box.Y + 7);
                    g.DrawLine(pen, box.X + 17, box.Y + 7, box.X + 21, box.Y + 7);
                    using (var thin = new Pen(color, 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    {
                        g.DrawLine(thin, box.X + 10, box.Y + 12, box.X + 18, box.Y + 12);
                        g.DrawLine(thin, box.X + 10, box.Y + 16, box.X + 18, box.Y + 16);
                        g.DrawLine(thin, box.X + 10, box.Y + 20, box.X + 16, box.Y + 20);
                    }
                    break;
                case HeaderNavIcon.System:
                    DrawGear(g, box, pen);
                    break;
            }
        }
        finally
        {
            g.SmoothingMode = mode;
        }
    }

    private static void DrawNetwork(Graphics g, Rectangle box, Color color, bool glow)
    {
        if (glow)
        {
            using var halo = new Pen(Color.FromArgb(70, 0, 132, 255), 4.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            DrawNetworkLines(g, box, halo);
        }
        using var pen = new Pen(color, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        DrawNetworkLines(g, box, pen);
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, box.X + 10.5f, box.Y + 2.5f, 7, 7);
        g.FillEllipse(brush, box.X + 2.5f, box.Y + 18.5f, 7, 7);
        g.FillEllipse(brush, box.X + 18.5f, box.Y + 18.5f, 7, 7);
    }

    private static void DrawNetworkLines(Graphics g, Rectangle box, Pen pen)
    {
        var top = new PointF(box.X + 14, box.Y + 9);
        var left = new PointF(box.X + 6, box.Y + 19);
        var right = new PointF(box.X + 22, box.Y + 19);
        g.DrawLine(pen, top, left);
        g.DrawLine(pen, top, right);
        g.DrawLine(pen, left, right);
    }

    private static void DrawGear(Graphics g, Rectangle box, Pen pen)
    {
        var cx = box.X + 14f;
        var cy = box.Y + 14f;
        // Teeth: 8 short radial spokes.
        for (var i = 0; i < 8; i++)
        {
            var a = i * MathF.PI / 4f;
            g.DrawLine(pen,
                cx + MathF.Cos(a) * 7f, cy + MathF.Sin(a) * 7f,
                cx + MathF.Cos(a) * 10.5f, cy + MathF.Sin(a) * 10.5f);
        }
        g.DrawEllipse(pen, cx - 6.5f, cy - 6.5f, 13, 13);
        g.DrawEllipse(pen, cx - 2.5f, cy - 2.5f, 5, 5);
    }

    internal static void DrawMetric(Graphics g, HeaderMetricIcon icon, Rectangle box, bool dark)
    {
        var mode = g.SmoothingMode;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        try
        {
            switch (icon)
            {
                case HeaderMetricIcon.Requests:
                    DrawBars(g, box);
                    break;
                case HeaderMetricIcon.Success:
                    DrawRing(g, box);
                    break;
                case HeaderMetricIcon.Latency:
                    DrawBolt(g, box);
                    break;
            }
        }
        finally
        {
            g.SmoothingMode = mode;
        }
    }

    private static void DrawBars(Graphics g, Rectangle box)
    {
        // Three bottom-aligned bars: short, tallest, intermediate.
        var base_ = box.Bottom - 2;
        var widths = new[] { 7f, 7f, 7f };
        var heights = new[] { 13f, 26f, 19f };
        var totalW = widths[0] + widths[1] + widths[2] + 8f;
        var x = box.X + (box.Width - totalW) / 2f;
        for (var i = 0; i < 3; i++)
        {
            var rect = new RectangleF(x, base_ - heights[i], widths[i], heights[i]);
            var top = i == 1 ? Color.FromArgb(0x10, 0xCC, 0xEE) : Color.FromArgb(0x07, 0x9B, 0xD5);
            var bottom = i == 1 ? Color.FromArgb(0x07, 0x9B, 0xD5) : Color.FromArgb(0x05, 0x6E, 0x9C);
            using var brush = new LinearGradientBrush(rect, top, bottom, LinearGradientMode.Vertical);
            using var path = VisualTheme.RoundedRect(Rectangle.Round(rect), 2);
            g.FillPath(brush, path);
            x += widths[i] + 4f;
        }
    }

    private static void DrawRing(Graphics g, Rectangle box)
    {
        // Thick teal ring with a small blue segment near the upper left.
        var d = Math.Min(box.Width, box.Height) - 2;
        var rect = new RectangleF(box.X + (box.Width - d) / 2f, box.Y + (box.Height - d) / 2f, d, d);
        using var teal = new Pen(Color.FromArgb(0x26, 0xD2, 0xC3), 5.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawArc(teal, rect, -30f, 270f);
        using var green = new Pen(Color.FromArgb(0x50, 0xE9, 0xAE), 5.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawArc(green, rect, 150f, 120f);
        using var blue = new Pen(Color.FromArgb(0x38, 0x7A, 0xC1), 5.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawArc(blue, rect, 195f, 45f);
    }

    private static void DrawBolt(Graphics g, Rectangle box)
    {
        // Filled slanted lightning bolt, purple gradient.
        var w = 24f;
        var h = 32f;
        var x = box.X + (box.Width - w) / 2f;
        var y = box.Y + (box.Height - h) / 2f;
        var pts = new[]
        {
            new PointF(x + 15, y),
            new PointF(x + 5, y + 18),
            new PointF(x + 11, y + 18),
            new PointF(x + 8, y + 32),
            new PointF(x + 19, y + 13),
            new PointF(x + 12.5f, y + 13),
        };
        using var brush = new LinearGradientBrush(new RectangleF(x, y, w, h),
            Color.FromArgb(0xB4, 0x75, 0xFF), Color.FromArgb(0x92, 0x50, 0xED), LinearGradientMode.Vertical);
        g.FillPolygon(brush, pts);
    }
}

/// <summary>
/// One metric card inside the header toolbar: icon left, label-over-value
/// stack right. Values are set from the same data pipeline as before; this
/// control only presents them. Empty data renders as an em-dash.
/// </summary>
internal sealed class HeaderMetricCard : Panel, IThemeAware
{
    private readonly Label _label;
    private readonly Label _value;
    private readonly HeaderMetricIcon _icon;

    internal HeaderMetricCard(string label, HeaderMetricIcon icon, int width, string windowNote)
    {
        _icon = icon;
        DoubleBuffered = true;
        Size = new Size(width, 62);
        MinimumSize = new Size(width, 62);
        MaximumSize = new Size(width, 62);
        BackColor = HeaderColors.MetricTop;
        _label = new Label
        {
            Text = label,
            AutoSize = true,
            Font = HeaderFonts.MetricLabel,
            ForeColor = HeaderColors.MetricLabel,
            BackColor = Color.Transparent,
            Location = new Point(50, 9),
            AccessibleName = label,
        };
        _value = new Label
        {
            Text = "—",
            AutoSize = true,
            Font = HeaderFonts.MetricValue,
            ForeColor = HeaderColors.MetricValue,
            BackColor = Color.Transparent,
            Location = new Point(50, 28),
            AccessibleName = label + " value",
            AccessibleDescription = windowNote,
        };
        Controls.Add(_label);
        Controls.Add(_value);
        AccessibleName = label;
        AccessibleDescription = windowNote;
    }

    internal void SetValue(string value)
    {
        if (_value.Text != value)
        {
            _value.Text = value;
            FitFonts();
        }
    }

    private Font? _labelClone;
    private Font? _valueClone;



    private bool _fitting;
    internal void FitFonts()
    {
        if (_fitting || IsDisposed || Disposing || !IsHandleCreated || _label is null || _value is null) { return; }
        _fitting = true;
        try
        {
            using var g = CreateGraphics();
            const TextFormatFlags flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
            var labelSize = TextRenderer.MeasureText(g, _label.Text, HeaderFonts.MetricLabel, new Size(int.MaxValue, int.MaxValue), flags);
            var valueSize = TextRenderer.MeasureText(g, _value.Text, HeaderFonts.MetricValue, new Size(int.MaxValue, int.MaxValue), flags);
            // Size the surface for its actual text; do not hide overflow by reducing fonts.
            int width = Math.Max(155, 50 + Math.Max(labelSize.Width, valueSize.Width) + 12);
            int height = Math.Max(62, labelSize.Height + valueSize.Height + 18);
            MaximumSize = Size.Empty;
            MinimumSize = new Size(width, height);
            Size = MinimumSize;
            _label.Font = HeaderFonts.MetricLabel;
            _value.Font = HeaderFonts.MetricValue;
            int top = (height - labelSize.Height - valueSize.Height - 2) / 2;
            _label.Location = new Point(50, top);
            _value.Location = new Point(50, top + labelSize.Height + 2);
        }
        finally { _fitting = false; }
    }
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        FitFonts();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        FitFonts();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (_labelClone != null) { _labelClone.Dispose(); _labelClone = null; }
            if (_valueClone != null) { _valueClone.Dispose(); _valueClone = null; }
        }
        base.Dispose(disposing);
    }


    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var back = new LinearGradientBrush(bounds, HeaderColors.MetricTop, HeaderColors.MetricBottom, LinearGradientMode.Vertical))
        using (var path = VisualTheme.RoundedRect(bounds, 9))
        {
            g.FillPath(back, path);
        }
        VisualTheme.DrawRounded(g, bounds, 9, HeaderColors.MetricBorder, 1f);
        // Icon vertically centered against the two-line stack.
        var iconBox = new Rectangle(12, (Height - 30) / 2, 30, 30);
        HeaderIconPainter.DrawMetric(g, _icon, _icon == HeaderMetricIcon.Success ? iconBox : new Rectangle(15, (Height - 30) / 2, 24, 30), VisualTheme.Mode == ThemeMode.Dark);
    }

    public void RefreshTheme()
    {
        BackColor = HeaderColors.MetricTop;
        _label.ForeColor = HeaderColors.MetricLabel;
        _value.ForeColor = HeaderColors.MetricValue;
        Invalidate(true);
    }
}

/// <summary>
/// The shared navigation/statistics toolbar: one rounded bar with four
/// borderless navigation items left, three metric cards right, and a
/// flexible empty area between them. Below ~1195px inner width the metric
/// group wraps to a second row inside the same bar instead of clipping.
/// </summary>
internal sealed class HeaderToolbar : CardPanel
{
    internal const int BarHeight = 78;
    private const int Pad = 6;
    private const int NavWidth = 666;
    private const int MetricsWidth = 499;
    private const int Gap = 8;
    private const int CardHeight = 62;

    private readonly Panel _navHost;
    private readonly Panel _metricsHost;
    private readonly Panel _wrapHost;
    private readonly HeaderNavItem[] _items;
    private bool _layingOut;
    private int[] _fullWidths = new int[0];
    private int[] _fullMinWidths = new int[0];

    internal HeaderToolbar(HeaderNavItem[] items, HeaderMetricCard[] cards, string windowNote)
    {
        _items = items;
        Dock = DockStyle.Fill;
        CornerRadius = 12;
        BorderColor = HeaderColors.ToolbarBorder;
        GlowAccent = Color.Transparent;
        BackColor = HeaderColors.ToolbarTop;
        AutoSize = false;
        Height = BarHeight;
        MinimumSize = new Size(0, BarHeight);
        AccessibleName = "Navigation and statistics toolbar";

        _navHost = new TransparentPanel
        {
            AccessibleName = "Primary navigation",
        };
        var x = 0;
        foreach (var item in _items)
        {
            item.Location = new Point(x, 0);
            item.Height = BarHeight - Pad * 2;
            _navHost.Controls.Add(item);
            x += item.Width;
        }
        _navHost.Size = new Size(x, BarHeight - Pad * 2);

        _metricsHost = new TransparentPanel
        {
            Size = new Size(MetricsWidth, CardHeight),
            AccessibleName = "Header metrics",
            AccessibleDescription = windowNote,
        };
        var cx = 0;
        foreach (var card in cards)
        {
            card.Location = new Point(cx, 0);
            _metricsHost.Controls.Add(card);
            card.SizeChanged += (_, _) => PerformToolbarLayout();
            cx += card.Width + Gap;
        }

        _wrapHost = new TransparentPanel
        {
            Visible = false,
            AccessibleName = "Header metrics wrapped",
        };

        Controls.Add(_navHost);
        Controls.Add(_metricsHost);
        Controls.Add(_wrapHost);

        var tip = new ToolTip();
        foreach (var card in cards)
        {
            tip.SetToolTip(card, windowNote);
        }
    }

    private bool _grownToFit;

    /// <summary>
    /// One-shot fit pass using the live device context: grows items whose
    /// labels measure wider than construction estimates (per-run DPI
    /// scaling, fallback fonts), then reflows once. Runs outside paint
    /// (Shown / DPI change), so unlike paint-time growth it cannot feed a
    /// paint/layout cycle. Idempotent until the next DPI change.
    /// </summary>
    internal void GrowToFitOnce()
    {
        if (_grownToFit || IsDisposed || Disposing || !IsHandleCreated || _navHost is null)
        {
            return;
        }
        _grownToFit = true;
        try
        {
            using var g = CreateGraphics();
            foreach (Control child in _navHost.Controls)
            {
                if (child is not HeaderNavItem item)
                {
                    continue;
                }
                var avail = item.Width - 73;
                if (avail <= 0)
                {
                    continue;
                }
                var need = TextRenderer.MeasureText(g, item.Text, HeaderFonts.NavActive, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Width;
                if (need > avail)
                {
                    item.Width = Math.Min(item.MinimumSize.Width + 80, item.Width + (need - avail) + 16);
                }
            }
            _fullWidths = new int[_items.Length];
            _fullMinWidths = new int[_items.Length];
            for (int i = 0; i < _items.Length; i++) { _fullWidths[i] = _items[i].Width; _fullMinWidths[i] = _items[i].MinimumSize.Width; }
            PerformReflow();
        }
        catch
        {
            // Cosmetic only.
        }
    }

    /// <summary>Reposition nav items sequentially and refresh wrapping.</summary>
    internal void PerformReflow()
    {
        if (_navHost is null)
        {
            return;
        }
        var x = 0;
        foreach (Control child in _navHost.Controls)
        {
            child.Location = new Point(x, 0);
            x += child.Width;
        }
        _navHost.Width = x;
        PerformToolbarLayout();
        Invalidate(true);
    }

    internal void SetActive(int index)
    {
        for (var i = 0; i < _items.Length; i++)
        {
            _items[i].Active = i == index;
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        PerformToolbarLayout();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        PerformToolbarLayout();
    }

    protected override void OnDpiChangedAfterParent(EventArgs e)
    {
        base.OnDpiChangedAfterParent(e);
        // Per-monitor move: re-run the fit pass for the new DPI, then
        // re-evaluate wrapping.
        _grownToFit = false;
        GrowToFitOnce();
    }

    private void PerformToolbarLayout()
    {
        if (_layingOut || _navHost is null || _metricsHost is null || _wrapHost is null)
        {
            return;
        }
        _layingOut = true;
        try
        {
            int metricsWidth = 0;
            int cardHeight = CardHeight;
            foreach (Control child in _metricsHost.Controls)
            {
                if (child is HeaderMetricCard card) { card.FitFonts(); }
                child.Location = new Point(metricsWidth, 0);
                metricsWidth += child.Width + Gap;
                cardHeight = Math.Max(cardHeight, child.Height);
            }
            metricsWidth = Math.Max(0, metricsWidth - Gap);
            _metricsHost.Size = new Size(metricsWidth, cardHeight);
            var inner = Math.Max(0, ClientSize.Width - Pad * 2);
            if (_fullWidths.Length == _items.Length)
            {
                if (inner > 0)
                {
                    int fullTotal = 0;
                    foreach (int w in _fullWidths) { fullTotal += w; }
                    if (fullTotal <= inner)
                    {
                        int rx = 0;
                        for (int i = 0; i < _items.Length; i++)
                        {
                            _items[i].Location = new Point(rx, 0);
                            _items[i].MinimumSize = new Size(_fullMinWidths[i], 0);
                            _items[i].Width = _fullWidths[i];
                            rx += _fullWidths[i];
                        }
                        _navHost.Width = rx;
                    }
                    else
                    {
                        double f = (double)inner / (double)fullTotal;
                        int sx = 0;
                        for (int i = 0; i < _items.Length; i++)
                        {
                            int w = Math.Max(120, (int)Math.Floor(_fullWidths[i] * f));
                            if (i == _items.Length - 1) { w = Math.Max(120, inner - sx); }
                            _items[i].Location = new Point(sx, 0);
                            _items[i].MinimumSize = new Size(w, 0);
                            _items[i].Width = w;
                            sx += w;
                        }
                        _navHost.Width = sx;
                    }
                }
            }
            int barHeight = Math.Max(BarHeight, cardHeight + Pad * 2);
            var single = inner >= NavTotalWidth() + Gap + metricsWidth;
            if (single)
            {
                if (_metricsHost.Parent != this)
                {
                    _wrapHost.Controls.Remove(_metricsHost);
                    Controls.Add(_metricsHost);
                }
                _wrapHost.Visible = false;
                if (Height != barHeight)
                {
                    Height = barHeight;
                    MinimumSize = new Size(0, barHeight);
                }
                _navHost.Location = new Point(Pad, Pad);
                _navHost.Size = new Size(Math.Min(NavTotalWidth(), inner), BarHeight - Pad * 2);
                _metricsHost.Location = new Point(ClientSize.Width - Pad - metricsWidth, (barHeight - cardHeight) / 2);
                foreach (var item in _items)
                {
                    item.Height = BarHeight - Pad * 2;
                }
            }
            else
            {
                if (_metricsHost.Parent != _wrapHost)
                {
                    Controls.Remove(_metricsHost);
                    _wrapHost.Controls.Add(_metricsHost);
                }
                _wrapHost.Visible = true;
                var wrappedHeight = BarHeight + Gap + cardHeight + Pad;
                if (Height != wrappedHeight)
                {
                    Height = wrappedHeight;
                    MinimumSize = new Size(0, wrappedHeight);
                }
                _navHost.Location = new Point(Pad, Pad);
                _navHost.Size = new Size(Math.Min(NavTotalWidth(), inner), BarHeight - Pad * 2);
                _wrapHost.Location = new Point(Pad, BarHeight + Gap - 2);
                _wrapHost.Size = new Size(inner, cardHeight);
                _metricsHost.Location = new Point(Math.Max(0, inner - metricsWidth), 0);
                foreach (var item in _items)
                {
                    item.Height = BarHeight - Pad * 2;
                }
            }
        }
        finally
        {
            _layingOut = false;
        }
    }

    private int NavTotalWidth()
    {
        var total = 0;
        foreach (var item in _items)
        {
            total += item.Width;
        }
        return total;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Subtle vertical navy surface instead of the flat card fill.
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(2, 2, Width - 4, Height - 4);
        using var brush = new LinearGradientBrush(bounds, HeaderColors.ToolbarTop, HeaderColors.ToolbarBottom, LinearGradientMode.Vertical);
        using var path = VisualTheme.RoundedRect(bounds, CornerRadius);
        g.FillPath(brush, path);
    }

    public override void RefreshTheme()
    {
        BorderColor = HeaderColors.ToolbarBorder;
        BackColor = HeaderColors.ToolbarTop;
        base.RefreshTheme();
    }
}
