using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace GoRouterDesktop;

/// <summary>
/// Shared visual language for the GoRouter Desktop shell (V1.5.1 visual
/// fidelity refresh): palette, typography scale and rounded-rectangle
/// drawing helpers. Presentation-only; no control semantics live here.
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
    // Palette: every token resolves per Mode (light values unchanged from
    // the V1.5.1 refresh; dark twins keep hue, gain lightness for contrast).
    // ------------------------------------------------------------------
    internal static Color WindowBack => Dark ? C(0x1E1F24) : C(0xF5F6F8);
    internal static Color SurfaceWhite => Dark ? C(0x26282F) : C(0xFFFFFF);
    internal static Color CardBorder => Dark ? C(0x3A3D46) : C(0xE5E7EB);
    internal static Color FieldBorder => Dark ? C(0x4A4E59) : C(0xD1D5DB);
    internal static Color PrimaryText => Dark ? C(0xE8EAF0) : C(0x111827);
    internal static Color SecondaryText => Dark ? C(0xA7ADBA) : C(0x6B7280);
    internal static Color MutedText => Dark ? C(0x6E7482) : C(0x9CA3AF);
    internal static Color AccentGo => Dark ? C(0x34D399) : C(0x16A34A);
    internal static Color AccentZen => Dark ? C(0x60A5FA) : C(0x2563EB);
    internal static Color Healthy => Dark ? C(0x4ADE80) : C(0x22C55E);
    internal static Color Warning => Dark ? C(0xFBBF24) : C(0xF59E0B);
    internal static Color Danger => Dark ? C(0xF87171) : C(0xDC2626);
    internal static Color ConfirmationBack => Dark ? C(0x0C2E22) : C(0xECFDF5);
    internal static Color ConfirmationBorder => Dark ? C(0x14532D) : C(0xD1FAE5);
    internal static Color ErrorBoxBack => Dark ? C(0x3A1414) : C(0xFEF2F2);
    internal static Color ErrorBoxBorder => Dark ? C(0x7F1D1D) : C(0xFECACA);
    internal static Color ErrorBoxText => Dark ? C(0xFCA5A5) : C(0xB91C1C);
    internal static Color AmberBannerBack => Dark ? C(0x2E2108) : C(0xFFFBEB);
    internal static Color AmberBannerBorder => Dark ? C(0x92400E) : C(0xFDE68A);
    internal static Color AmberBannerText => Dark ? C(0xFDE68A) : C(0x92400E);
    internal static Color HoverBack => Dark ? C(0x31343D) : C(0xF0F2F5);
    internal static Color SelectedRowBack => Dark ? C(0x27334D) : C(0xE8EFFB);
    internal static Color MarkerGoBack => Dark ? C(0x0C2E22) : C(0xE7F4EA);
    internal static Color MarkerGoText => Dark ? C(0x6EE7B7) : C(0x167A3A);
    internal static Color MarkerZenBack => Dark ? C(0x17233F) : C(0xE8EFFB);
    internal static Color MarkerZenText => Dark ? C(0x93C5FD) : C(0x1D4ED8);
    internal static Color ChipAttachedBack => Dark ? C(0x2E3138) : C(0xF1F2F4);
    internal static Color IdleDot => Dark ? C(0x9AA0AE) : C(0x616161);
    internal static Color FeedbackOkText => Dark ? C(0x86EFAC) : C(0x1B5E20);
    internal static Color ErrorText => Dark ? C(0xFCA5A5) : C(0xB71C1C);
    internal static Color WarnText => Dark ? C(0xFCD34D) : C(0x8A5300);
    // Structural white (tray glyph ring): taskbar-owned background, not theme paint.
    internal static Color TrayRing => Color.White;
    internal static Color RowAltBack => Dark ? C(0x202227) : C(0xF9FAFB);
    internal static Color Separator => Dark ? C(0x3A3D46) : C(0xE5E7EB);

    private static Color C(uint rgb)
    {
        return Color.FromArgb((int)(0xFF000000 | rgb));
    }

    // ------------------------------------------------------------------
    // Typography (Segoe UI, native; no bundled fonts)
    // ------------------------------------------------------------------
    internal static Font AppTitleFont { get; } = new Font("Segoe UI", 15.75f, FontStyle.Bold);
    internal static Font LaneTitleFont { get; } = new Font("Segoe UI", 12f, FontStyle.Bold);
    internal static Font FieldLabelFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Bold);
    internal static Font BodyFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Regular);
    internal static Font SmallFont { get; } = new Font("Segoe UI", 8.75f, FontStyle.Regular);
    // Dense tabular data stays one step below the general small scale, so
    // five activity rows remain readable without crowding at narrow widths.
    internal static Font TableFont { get; } = new Font("Segoe UI", 8.25f, FontStyle.Regular);
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
