using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace GoRouterDesktop;

/// <summary>
/// Shared visual language for the GoRouter Desktop shell (V1.5.1 visual
/// fidelity refresh): palette, typography scale and rounded-rectangle
/// drawing helpers. Presentation-only; no control semantics live here.
/// </summary>
internal static class VisualTheme
{
    // ------------------------------------------------------------------
    // Palette (target-derived: soft cool gray page, white surfaces,
    // restrained green/blue accents)
    // ------------------------------------------------------------------
    internal static readonly Color WindowBack = Color.FromArgb(0xF5, 0xF6, 0xF8);
    internal static readonly Color SurfaceWhite = Color.FromArgb(0xFF, 0xFF, 0xFF);
    internal static readonly Color CardBorder = Color.FromArgb(0xE5, 0xE7, 0xEB);
    internal static readonly Color FieldBorder = Color.FromArgb(0xD1, 0xD5, 0xDB);
    internal static readonly Color PrimaryText = Color.FromArgb(0x11, 0x18, 0x27);
    internal static readonly Color SecondaryText = Color.FromArgb(0x6B, 0x72, 0x80);
    internal static readonly Color MutedText = Color.FromArgb(0x9C, 0xA3, 0xAF);
    internal static readonly Color AccentGo = Color.FromArgb(0x16, 0xA3, 0x4A);
    internal static readonly Color AccentZen = Color.FromArgb(0x25, 0x63, 0xEB);
    internal static readonly Color Healthy = Color.FromArgb(0x22, 0xC5, 0x5E);
    internal static readonly Color Warning = Color.FromArgb(0xF5, 0x9E, 0x0B);
    internal static readonly Color Danger = Color.FromArgb(0xDC, 0x26, 0x26);
    internal static readonly Color ConfirmationBack = Color.FromArgb(0xEC, 0xFD, 0xF5);
    internal static readonly Color ConfirmationBorder = Color.FromArgb(0xD1, 0xFA, 0xE5);
    internal static readonly Color ErrorBoxBack = Color.FromArgb(0xFE, 0xF2, 0xF2);
    internal static readonly Color ErrorBoxBorder = Color.FromArgb(0xFE, 0xCA, 0xCA);
    internal static readonly Color ErrorBoxText = Color.FromArgb(0xB9, 0x1C, 0x1C);
    internal static readonly Color AmberBannerBack = Color.FromArgb(0xFF, 0xFB, 0xEB);
    internal static readonly Color AmberBannerBorder = Color.FromArgb(0xFD, 0xE6, 0x8A);
    internal static readonly Color AmberBannerText = Color.FromArgb(0x92, 0x40, 0x0E);
    // Visual slice 6a: every literal color site tokenized (light values
    // identical; dark twins land with the Mode switch in 6b).
    internal static readonly Color HoverBack = Color.FromArgb(0xF0, 0xF2, 0xF5);
    internal static readonly Color SelectedRowBack = Color.FromArgb(0xE8, 0xEF, 0xFB);
    internal static readonly Color MarkerGoBack = Color.FromArgb(0xE7, 0xF4, 0xEA);
    internal static readonly Color MarkerGoText = Color.FromArgb(0x16, 0x7A, 0x3A);
    internal static readonly Color MarkerZenBack = Color.FromArgb(0xE8, 0xEF, 0xFB);
    internal static readonly Color MarkerZenText = Color.FromArgb(0x1D, 0x4E, 0xD8);
    internal static readonly Color ChipAttachedBack = Color.FromArgb(0xF1, 0xF2, 0xF4);
    internal static readonly Color IdleDot = Color.FromArgb(0x61, 0x61, 0x61);
    internal static readonly Color FeedbackOkText = Color.FromArgb(0x1B, 0x5E, 0x20);
    internal static readonly Color ErrorText = Color.FromArgb(0xB7, 0x1C, 0x1C);
    internal static readonly Color WarnText = Color.FromArgb(0x8A, 0x53, 0x00);
    // Structural white (tray glyph ring): taskbar-owned background, not theme paint.
    internal static readonly Color TrayRing = Color.White;
    internal static readonly Color RowAltBack = Color.FromArgb(0xF9, 0xFA, 0xFB);
    internal static readonly Color Separator = Color.FromArgb(0xE5, 0xE7, 0xEB);

    // ------------------------------------------------------------------
    // Typography (Segoe UI, native; no bundled fonts)
    // ------------------------------------------------------------------
    internal static Font AppTitleFont { get; } = new Font("Segoe UI", 15.75f, FontStyle.Bold);
    internal static Font LaneTitleFont { get; } = new Font("Segoe UI", 12f, FontStyle.Bold);
    internal static Font FieldLabelFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Bold);
    internal static Font BodyFont { get; } = new Font("Segoe UI", 9.75f, FontStyle.Regular);
    internal static Font SmallFont { get; } = new Font("Segoe UI", 8.75f, FontStyle.Regular);
    internal static Font FooterFont { get; } = new Font("Segoe UI", 9f, FontStyle.Regular);
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
}
