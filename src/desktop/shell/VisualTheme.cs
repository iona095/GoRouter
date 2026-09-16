using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace GoRouterDesktop;

/// <summary>
/// Shared visual language for the GoRouter Desktop shell (Vision UX
/// control-center refresh): palette, typography scale and rounded-rectangle
/// drawing helpers. Presentation-only; no control semantics live here.
/// Dark mode follows the Vision UX navy system (Background0 #08111F et al);
/// light values are unchanged from the V1.5.1 refresh and remain usable.
/// </summary>
internal enum ThemeMode
{
    Light,
    Dark,
}

internal static class VisualTheme
{
    /// <summary>Visual slice 6b: active theme. Light is the default; dark is
    /// opt-in via the header toggle and persists in desktop settings.</summary>
    internal static ThemeMode Mode { get; set; } = ThemeMode.Light;

    private static bool Dark => Mode == ThemeMode.Dark;

    // ------------------------------------------------------------------
    // Palette: every token resolves per Mode. Light values are unchanged
    // from the V1.5.1 refresh; dark twins follow the Vision UX navy system:
    // Background0 #08111F, Background1 #0B1727, Surface #0F1D2F,
    // SurfaceRaised #132339, SurfaceHover #172A43, Border #263A52,
    // BorderMuted #1B2C40, TextPrimary #F3F7FC, TextSecondary #A9BAD0,
    // TextMuted #71849E, AccentBlue #2D8CFF, AccentCyan #27C9FF,
    // GoPrimary #34E39A, GoSecondary #10B981, GoSurface #0A3A31,
    // ZenPrimary #A463FF, ZenSecondary #7C4DFF, ZenSurface #24204A,
    // Success #35E79A, Warning #F5B942, Danger #FF5B70.
    // ------------------------------------------------------------------
    internal static Color WindowBack => Dark ? C(0x08111F) : C(0xF5F6F8);
    internal static Color SurfaceWhite => Dark ? C(0x0F1D2F) : C(0xFFFFFF);
    internal static Color CardBorder => Dark ? C(0x263A52) : C(0xE5E7EB);
    internal static Color FieldBorder => Dark ? C(0x2E4A66) : C(0xD1D5DB);
    internal static Color PrimaryText => Dark ? C(0xF3F7FC) : C(0x111827);
    internal static Color SecondaryText => Dark ? C(0xA9BAD0) : C(0x6B7280);
    internal static Color MutedText => Dark ? C(0x71849E) : C(0x9CA3AF);
    internal static Color AccentGo => Dark ? C(0x34E39A) : C(0x16A34A);
    // Light twin is a distinct violet (not AccentBlue's #2563EB): the theme
    // mapper keys dark twins by light value, so shared light values collide
    // and the last-registered pair wins (ZEN rendered blue).
    internal static Color AccentZen => Dark ? C(0xA463FF) : C(0x7C3AED);
    internal static Color Healthy => Dark ? C(0x35E79A) : C(0x22C55E);
    internal static Color Warning => Dark ? C(0xF5B942) : C(0xF59E0B);
    internal static Color Danger => Dark ? C(0xFF5B70) : C(0xDC2626);
    internal static Color ConfirmationBack => Dark ? C(0x0A3A31) : C(0xECFDF5);
    internal static Color ConfirmationBorder => Dark ? C(0x10B981) : C(0xD1FAE5);
    internal static Color ErrorBoxBack => Dark ? C(0x3A1620) : C(0xFEF2F2);
    internal static Color ErrorBoxBorder => Dark ? C(0x7F1D2D) : C(0xFECACA);
    internal static Color ErrorBoxText => Dark ? C(0xFF8FA3) : C(0xB91C1C);
    internal static Color AmberBannerBack => Dark ? C(0x2E2108) : C(0xFFFBEB);
    internal static Color AmberBannerBorder => Dark ? C(0x92400E) : C(0xFDE68A);
    internal static Color AmberBannerText => Dark ? C(0xFDE68A) : C(0x92400E);
    internal static Color HoverBack => Dark ? C(0x172A43) : C(0xF0F2F5);
    internal static Color SelectedRowBack => Dark ? C(0x132339) : C(0xE8EFFB);
    internal static Color MarkerGoBack => Dark ? C(0x0A3A31) : C(0xE7F4EA);
    internal static Color MarkerGoText => Dark ? C(0x34E39A) : C(0x167A3A);
    internal static Color MarkerZenBack => Dark ? C(0x24204A) : C(0xE8EFFB);
    internal static Color MarkerZenText => Dark ? C(0xA463FF) : C(0x1D4ED8);
    internal static Color ChipAttachedBack => Dark ? C(0x132339) : C(0xF1F2F4);
    internal static Color IdleDot => Dark ? C(0x71849E) : C(0x616161);
    internal static Color FeedbackOkText => Dark ? C(0x35E79A) : C(0x1B5E20);
    internal static Color ErrorText => Dark ? C(0xFF8FA3) : C(0xB71C1C);
    internal static Color WarnText => Dark ? C(0xF5B942) : C(0x8A5300);
    // Vision UX navy stages: page base (Background1), raised card surface,
    // hover surface, muted border, nav blue, cyan, lane secondaries/surfaces.
    internal static Color PageBase => Dark ? C(0x0B1727) : C(0xF5F6F8);
    internal static Color SurfaceRaised => Dark ? C(0x132339) : C(0xFFFFFF);
    internal static Color SurfaceHover => Dark ? C(0x172A43) : C(0xF0F2F5);
    internal static Color BorderMuted => Dark ? C(0x1B2C40) : C(0xE5E7EB);
    internal static Color AccentBlue => Dark ? C(0x2D8CFF) : C(0x2563EB);
    internal static Color AccentCyan => Dark ? C(0x27C9FF) : C(0x0284C7);
    internal static Color GoSecondary => Dark ? C(0x10B981) : C(0x15803D);
    internal static Color GoSurface => Dark ? C(0x0A3A31) : C(0xE7F4EA);
    internal static Color ZenSecondary => Dark ? C(0x7C4DFF) : C(0x6D28D9);
    internal static Color ZenSurface => Dark ? C(0x24204A) : C(0xEDE9FE);
    // Structural white (tray glyph ring): taskbar-owned background, not theme paint.
    internal static Color TrayRing => Color.White;
    internal static Color RowAltBack => Dark ? C(0x0D1B30) : C(0xF9FAFB);
    internal static Color Separator => Dark ? C(0x1B2C40) : C(0xE5E7EB);

    private static Color C(uint rgb)
    {
        return Color.FromArgb((int)(0xFF000000 | rgb));
    }

    // ------------------------------------------------------------------
    // Typography (native Windows; Segoe UI Variable preferred, Segoe UI
    // fallback — no bundled fonts). Vision UX hierarchy: app title 22–26
    // semibold/bold, lane 20–24, section 16–19 semibold, metric numbers
    // 20–24 bold, body 12–14px equivalent, table 11–13.
    // ------------------------------------------------------------------
    private static Font MakeFont(float size, FontStyle style)
    {
        // NB: new Font with an unknown family silently substitutes Microsoft
        // Sans Serif instead of throwing, so resolve against installed
        // families explicitly (Segoe UI Variable is Win11-only).
        string? family = null;
        try
        {
            var installed = new HashSet<string>(
                FontFamily.Families.Select(f => f.Name),
                StringComparer.OrdinalIgnoreCase);
            family = installed.Contains("Segoe UI Variable") ? "Segoe UI Variable"
                : installed.Contains("Segoe UI") ? "Segoe UI"
                : FontFamily.GenericSansSerif.Name;
        }
        catch
        {
            family = FontFamily.GenericSansSerif.Name;
        }
        return new Font(family, size, style);
    }

    internal static Font AppTitleFont { get; } = MakeFont(22f, FontStyle.Bold);
    internal static Font LaneTitleFont { get; } = MakeFont(20f, FontStyle.Bold);
    internal static Font SectionTitleFont { get; } = MakeFont(15f, FontStyle.Bold);
    internal static Font MetricValueFont { get; } = MakeFont(20f, FontStyle.Bold);
    internal static Font MetricCaptionFont { get; } = MakeFont(9f, FontStyle.Regular);
    internal static Font FieldLabelFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Bold);
    internal static Font BodyFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Regular);
    internal static Font SmallFont { get; } = new Font("Segoe UI", 8.75f, FontStyle.Regular);
    // Dense tabular data stays one step below the general small scale, so
    // five activity rows remain readable without crowding at narrow widths.
    internal static Font TableFont { get; } = new Font("Segoe UI", 9f, FontStyle.Regular);
    internal static Font TableHeaderFont { get; } = new Font("Segoe UI", 9f, FontStyle.Bold);
    internal static Font StatusFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Bold);
    // Visual slice 3 (5-role scale): Caption for footnotes/hints, Mono for
    // machine identifiers (ports, versions, paths, endpoints). Consolas ships
    // with Windows; no bundled fonts.
    internal static Font CaptionFont { get; } = new Font("Segoe UI", 8.5f, FontStyle.Regular);
    internal static Font MonoFont { get; } = new Font("Consolas", 9.5f, FontStyle.Regular);
    internal static Font EmptyGlyphFont { get; } = new Font("Segoe UI", 22f, FontStyle.Regular);

    /// <summary>Visual slice 4: outcome text color (ok = healthy, anything else = danger).</summary>
    internal static Color OutcomeColor(string? outcome)
    {
        return string.Equals(outcome, "ok", StringComparison.OrdinalIgnoreCase) ? Healthy : Danger;
    }

    /// <summary>Visual slice 4: HTTP status color (2xx healthy, 4xx warning, else danger; unstarted stays neutral).</summary>
    internal static Color StatusColor(string? status)
    {
        if (!string.IsNullOrEmpty(status) && char.IsDigit(status[0]))
        {
            return status[0] switch
            {
                '2' => Healthy,
                '4' => Warning,
                _ => Danger,
            };
        }

        return PrimaryText;
    }

    /// <summary>State color for truthful status rendering.</summary>
    internal static Color StateColor(string state)
    {
        return state switch
        {
            "running" => Healthy,
            "degraded" => Warning,
            "failed" => Danger,
            "port_conflict" => Warning,
            "stopped" => MutedText,
            _ => PrimaryText,
        };
    }

    // ------------------------------------------------------------------
    // Rounded-rectangle helpers
    // ------------------------------------------------------------------
    internal static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        if (radius <= 0)
        {
            path.AddRectangle(bounds);
            path.CloseFigure();
            return path;
        }

        var d = radius * 2;
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    internal static void FillRounded(Graphics g, Rectangle bounds, int radius, Color color)
    {
        using var path = RoundedRect(bounds, radius);
        using var brush = new SolidBrush(color);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.FillPath(brush, path);
    }

    internal static void DrawRounded(Graphics g, Rectangle bounds, int radius, Color color, float width = 1f)
    {
        using var path = RoundedRect(bounds, radius);
        using var pen = new Pen(color, width);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.DrawPath(pen, path);
    }

    /// <summary>
    /// Vision UX card frame: 1px border plus a subtle 2px outer glow in the
    /// accent color. Opaque-friendly: the glow is two low-alpha strokes drawn
    /// over the page background (no layered transparency, no animation).
    /// </summary>
    internal static void DrawGlowFrame(Graphics g, Rectangle bounds, int radius, Color border, Color accent)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var glow = Color.FromArgb(48, accent);
        var glowFaint = Color.FromArgb(20, accent);
        using (var outer = RoundedRect(new Rectangle(bounds.X - 2, bounds.Y - 2, bounds.Width + 4, bounds.Height + 4), radius + 2))
        using (var pen = new Pen(glowFaint, 2f))
        {
            g.DrawPath(pen, outer);
        }
        using (var mid = RoundedRect(new Rectangle(bounds.X - 1, bounds.Y - 1, bounds.Width + 2, bounds.Height + 2), radius + 1))
        using (var pen = new Pen(glow, 1.5f))
        {
            g.DrawPath(pen, mid);
        }
        DrawRounded(g, bounds, radius, border, 1f);
    }

    /// <summary>Vision UX grid: outer padding 20–24px, major gap 18–22px.</summary>
    internal const int PagePadding = 22;
    internal const int MajorGap = 20;
    internal const int MinorGap = 10;
    internal const int CardRadius = 16;
    internal const int ControlRadius = 10;

    // ------------------------------------------------------------------
    // Live theme application (visual slice 6b). Every control color traces
    // to a token (6a gate), so a toggle re-resolves each control's current
    // color toward the active Mode: light values become dark twins and vice
    // versa; already-correct and unknown colors pass through untouched.
    // ------------------------------------------------------------------
    // Keyed by ARGB int, not Color: .NET Core Color equality distinguishes
    // named/system colors from identical ARGB literals (Color.White !=
    // Color.FromArgb(255,255,255) as dictionary keys), while controls report
    // OS defaults (SystemColors.*) and our tokens are FromArgb-built.
    private static Dictionary<int, Color>? _lightToDark;
    private static Dictionary<int, Color>? _darkToLight;

    private static void EnsureMaps()
    {
        if (_lightToDark != null)
        {
            return;
        }
        var saved = Mode;
        try
        {
            var pairs = new Func<Color>[]
            {
                () => WindowBack, () => SurfaceWhite, () => CardBorder, () => FieldBorder,
                () => PrimaryText, () => SecondaryText, () => MutedText,
                () => AccentGo, () => AccentZen, () => Healthy, () => Warning, () => Danger,
                () => ConfirmationBack, () => ConfirmationBorder,
                () => ErrorBoxBack, () => ErrorBoxBorder, () => ErrorBoxText,
                () => AmberBannerBack, () => AmberBannerBorder, () => AmberBannerText,
                () => HoverBack, () => SelectedRowBack,
                () => MarkerGoBack, () => MarkerGoText, () => MarkerZenBack, () => MarkerZenText,
                () => ChipAttachedBack, () => IdleDot, () => FeedbackOkText,
                () => ErrorText, () => WarnText, () => RowAltBack, () => Separator,
                () => PageBase, () => SurfaceRaised, () => SurfaceHover, () => BorderMuted,
                () => AccentBlue, () => AccentCyan, () => GoSecondary, () => GoSurface,
                () => ZenSecondary, () => ZenSurface,
            };
            _lightToDark = new Dictionary<int, Color>();
            _darkToLight = new Dictionary<int, Color>();
            foreach (var token in pairs)
            {
                Mode = ThemeMode.Light;
                var light = token();
                Mode = ThemeMode.Dark;
                var dark = token();
                _lightToDark[light.ToArgb()] = dark;
                _darkToLight[dark.ToArgb()] = light;
            }
        }
        finally
        {
            Mode = saved;
        }
    }

    /// <summary>Re-resolve one color toward the active Mode.</summary>
    internal static Color Map(Color current)
    {
        EnsureMaps();
        var key = current.ToArgb();
        if (Mode == ThemeMode.Dark)
        {
            return _lightToDark!.TryGetValue(key, out var dark) ? dark : current;
        }
        return _darkToLight!.TryGetValue(key, out var light) ? light : current;
    }

    /// <summary>Recursively re-resolve an open surface toward the active Mode.</summary>
    internal static void ApplyTheme(Control root)
    {
        EnsureMaps();
        ApplyTo(root);
        root.Invalidate(true);
    }

    private static void ApplyTo(Control control)
    {
        if (control is IThemeAware aware)
        {
            aware.RefreshTheme();
        }
        else
        {
            control.BackColor = Map(control.BackColor);
            control.ForeColor = Map(control.ForeColor);
            // Any control still carrying an OS-default text color (labels
            // default to ControlText, edits to WindowText — neither is a
            // token): in dark mode only, normalize onto the primary token.
            // Plain Buttons are excluded — their faces stay OS light gray,
            // so dark text stays readable on them in both modes. Light
            // rendering is untouched; toggling back resolves via the pair.
            if (Dark
                && !(control is Button)
                && (control.ForeColor == SystemColors.ControlText
                    || control.ForeColor == SystemColors.WindowText))
            {
                control.ForeColor = PrimaryText;
            }
            if (control is ListView lv)
            {
                // Non-owner-drawn grids cache item styles at build time.
                foreach (ListViewItem item in lv.Items)
                {
                    foreach (ListViewItem.ListViewSubItem sub in item.SubItems)
                    {
                        sub.BackColor = Map(sub.BackColor);
                        sub.ForeColor = Map(sub.ForeColor);
                    }
                }
            }
        }
        foreach (Control child in control.Controls)
        {
            ApplyTo(child);
        }
    }
}

/// <summary>Custom controls whose color lives in private fields repaint via this hook.</summary>
internal interface IThemeAware
{
    void RefreshTheme();
}
