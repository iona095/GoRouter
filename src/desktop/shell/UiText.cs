namespace GoRouterDesktop;

/// <summary>
/// UI text hygiene (F-14): exception messages and other unbounded strings
/// must never land verbatim in labels, balloons, or status lines — a nested
/// AggregateException or socket dump can spill megabytes across the UI.
/// Truncate at the display funnels (feedback setters, balloon, client
/// LastError) and at direct label assignments.
/// </summary>
internal static class UiText
{
    /// <summary>Maximum characters of any message shown in the UI.</summary>
    internal const int MaxMessageLength = 256;

    internal static string Truncate(string? value, int maxLength = MaxMessageLength)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }
        if (maxLength < 1)
        {
            return string.Empty;
        }
        var flat = value.Replace("\r", " ").Replace("\n", " ");
        if (flat.Length <= maxLength)
        {
            return flat;
        }
        return flat.Substring(0, maxLength - 1) + "\u2026";
    }
}
