using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace GoRouterDesktop;

internal static class GeometryDiagnostics
{
    internal static List<Control> FindAll(Control root, string name)
    {
        var list = new List<Control>();
        if (root.AccessibleName == name) list.Add(root);
        foreach (Control c in root.Controls) list.AddRange(FindAll(c, name));
        return list;
    }

    internal static List<Control> WalkAll(Control root)
    {
        var list = new List<Control>();
        list.Add(root);
        foreach (Control c in root.Controls) list.AddRange(WalkAll(c));
        return list;
    }

    internal static Rectangle ScreenClient(Control c)
    {
        try
        {
            if (!c.IsHandleCreated) return Rectangle.Empty;
            return c.RectangleToScreen(c.ClientRectangle);
        }
        catch { return Rectangle.Empty; }
    }

    internal static Rectangle EffectiveRect(Control c)
    {
        try
        {
            if (!c.Visible) return Rectangle.Empty;
            for (var p = c.Parent; p != null; p = p.Parent)
            {
                if (!p.Visible) return Rectangle.Empty;
            }
            var r = ScreenClient(c);
            if (r.IsEmpty) return r;
            for (var p = c.Parent; p != null; p = p.Parent)
            {
                if (!p.IsHandleCreated) continue;
                Rectangle pr;
                try { pr = p.RectangleToScreen(p.ClientRectangle); }
                catch { continue; }
                if (pr.IsEmpty) continue;
                r = Rectangle.Intersect(r, pr);
                if (r.IsEmpty) break;
            }
            return r;
        }
        catch { return Rectangle.Empty; }
    }

    internal static string Describe(Control c)
    {
        Rectangle scr = ScreenClient(c);
        Rectangle eff = EffectiveRect(c);
        string pname = string.Empty;
        string paname = string.Empty;
        if (c.Parent != null)
        {
            pname = c.Parent.GetType().Name;
            paname = c.Parent.AccessibleName ?? string.Empty;
        }
        int dpi = 0;
        try { dpi = c.DeviceDpi; } catch { dpi = 0; }
        string disp = string.Empty;
        string scrl = string.Empty;
        string pref = string.Empty;
        try { pref = c.PreferredSize.ToString(); } catch { pref = string.Empty; }
        if (c is ScrollableControl scc)
        {
            try { disp = scc.DisplayRectangle.ToString(); } catch { disp = string.Empty; }
            try { scrl = string.Concat(scc.AutoScrollPosition.ToString(), scc.AutoScrollMinSize.ToString()); } catch { scrl = string.Empty; }
        }
        return string.Concat(c.GetType().Name, " Acc=", c.AccessibleName, " Par=", pname, " Bounds=", c.Bounds.ToString(), " Cli=", c.ClientRectangle.ToString(), " Scr=", scr.ToString(), " Eff=", eff.ToString(), " Dpi=", dpi.ToString(), " PAcc=", paname, " Disp=", disp, " Sc=", scrl, " Pref=", pref);
    }

    internal static void CheckPhase(ControlCenterForm ccf, string label, string outDir, List<string> results, List<string> failures)
    {
        Form form = ccf;
        int dpiNow = 0;
        try { dpiNow = form.DeviceDpi; } catch { dpiNow = 0; }
        results.Add(string.Concat(label, form.Size.ToString(), form.ClientSize.ToString(), dpiNow.ToString()));
        StringBuilder sb = new StringBuilder();
        sb.AppendLine(label);
        string[] targets = new string[] {
            "GoRouter Desktop",
            "Router state",
            "Desktop version",
            "Stop router",
            "Start router",
            "Toggle color theme",
            "Routing",
            "Accounts",
            "Journal",
            "System",
            "Total Requests",
            "Success Rate",
            "Avg. Latency",
            "GO lane card",
            "ZEN lane card",
            "GO account selection",
            "ZEN account selection",
            "Recent activity",
            "View all recent activity in the Journal tab",
            "Recent requests",
            "Footer product identity",
            "Desktop release and local endpoint",
            "Copy local endpoint",
            "Navigation and statistics toolbar",
            "Primary navigation",
            "Header metrics",
            "Header metrics wrapped",
            "Control center sections",
            "Routing and recent activity",
            "Lane cards",
            "Status bar",
            "Status banner"
        };
        foreach (string t in targets)
        {
            List<Control> found = FindAll(ccf, t);
            if (found.Count == 0) { sb.AppendLine(t); }
            foreach (Control c in found) { sb.AppendLine(Describe(c)); }
        }
        File.WriteAllText(Path.Combine(outDir, string.Concat(label, ".txt")), sb.ToString());
        void Check(bool cond, string msg)
        {
            string tag = string.Concat(label, msg);
            if (cond) { results.Add(tag); }
            else { failures.Add(tag); results.Add(tag); }
        }
        void Log(string msg) { results.Add(string.Concat(label, msg)); }
        List<Control> gStatus = FindAll(ccf, "Status bar");
        Check(gStatus.Count == 1, "status bar exactly once");
        List<Control> gBanner = FindAll(ccf, "Status banner");
        Check(gBanner.Count == 1, "banner exactly once");
        List<Control> gToolbar = FindAll(ccf, "Navigation and statistics toolbar");
        Check(gToolbar.Count == 1, "toolbar exactly once");
        List<Control> gTabs = FindAll(ccf, "Control center sections");
        Check(gTabs.Count == 1, "tabs exactly once");
        List<Control> gFootId = FindAll(ccf, "Footer product identity");
        Check(gFootId.Count == 1, "footer identity exactly once");
        Rectangle formScr = ScreenClient(form);
        Log(string.Concat("formScr=", formScr.ToString()));
        if (gStatus.Count == 1)
        {
            Rectangle e = EffectiveRect(gStatus[0]);
            Check(e.Height > 0, "status usable height");
        }
        if (gToolbar.Count == 1)
        {
            Rectangle e = EffectiveRect(gToolbar[0]);
            Check(e.Width > 200, "toolbar usable width");
            Check(e.Height >= 70, "toolbar usable height");
        }
        if (gStatus.Count == 1)
        {
            if (gToolbar.Count == 1)
            {
                Rectangle a = ScreenClient(gStatus[0]);
                Rectangle b = ScreenClient(gToolbar[0]);
                Check(a.Y <= b.Y, "status above toolbar");
            }
        }
        if (gToolbar.Count == 1)
        {
            if (gTabs.Count == 1)
            {
                Rectangle a = ScreenClient(gToolbar[0]);
                Rectangle b = ScreenClient(gTabs[0]);
                Check(b.Y >= a.Bottom - 8, string.Concat("tabs overlap toolbar tabs=", b.ToString(), " toolbar=", a.ToString()));
                Check(b.Y <= a.Bottom + 12, string.Concat("tabs gap toolbar tabs=", b.ToString(), " toolbar=", a.ToString()));
            }
        }
        string[] navNames = new string[] { "Routing", "Accounts", "Journal", "System" };
        List<Control> navs = new List<Control>();
        foreach (string n in navNames)
        {
            List<Control> f = FindAll(ccf, n);
            List<Control> items = new List<Control>();
            foreach (Control c in f) { if (c is HeaderNavItem) { items.Add(c); } }
            Check(items.Count == 1, string.Concat(n, " nav exactly once"));
            if (items.Count == 1) { navs.Add(items[0]); }
        }
        foreach (Control c in navs)
        {
            Rectangle e = EffectiveRect(c);
            Check(e.Width >= 80, string.Concat(c.AccessibleName, " nav usable width eff=", e.ToString()));
            Check(e.Height >= 30, string.Concat(c.AccessibleName, " nav usable height eff=", e.ToString()));
        }
        int navOver = 0;
        string navFirst = string.Empty;
        for (int a = 0; a < navs.Count; a++)
        {
            for (int b = a + 1; b < navs.Count; b++)
            {
                Rectangle ra = ScreenClient(navs[a]);
                Rectangle rb = ScreenClient(navs[b]);
                if (ra.IsEmpty || rb.IsEmpty) { continue; }
                if (ra.IntersectsWith(rb)) { navOver = navOver + 1; navFirst = string.Concat(navs[a].AccessibleName, ra.ToString(), navs[b].AccessibleName, rb.ToString()); }
            }
        }
        Check(navOver == 0, string.Concat("nav sibling overlaps=", navOver.ToString(), navFirst));
        string[] metNames = new string[] { "Total Requests", "Success Rate", "Avg. Latency" };
        List<Control> mets = new List<Control>();
        foreach (string n in metNames)
        {
            List<Control> f = FindAll(ccf, n);
            List<Control> cards = new List<Control>();
            foreach (Control c in f) { if (c is HeaderMetricCard) { cards.Add(c); } }
            Check(cards.Count == 1, string.Concat(n, " card exactly once"));
            if (cards.Count == 1) { mets.Add(cards[0]); }
        }
        foreach (Control c in mets)
        {
            Rectangle e = EffectiveRect(c);
            Check(e.Width >= 100, string.Concat(c.AccessibleName, " metric usable width eff=", e.ToString()));
            Check(e.Height >= 40, string.Concat(c.AccessibleName, " metric usable height eff=", e.ToString()));
        }
        int metOver = 0;
        string metFirst = string.Empty;
        for (int a = 0; a < mets.Count; a++)
        {
            for (int b = a + 1; b < mets.Count; b++)
            {
                Rectangle ra = ScreenClient(mets[a]);
                Rectangle rb = ScreenClient(mets[b]);
                if (ra.IsEmpty || rb.IsEmpty) { continue; }
                if (ra.IntersectsWith(rb)) { metOver = metOver + 1; metFirst = string.Concat(mets[a].AccessibleName, ra.ToString(), mets[b].AccessibleName, rb.ToString()); }
            }
        }
        Check(metOver == 0, string.Concat("metric sibling overlaps=", metOver.ToString(), metFirst));
        foreach (Control c in navs)
        {
            if (c is not HeaderNavItem nav) { continue; }
            int avail = nav.Width - 73;
            if (avail <= 0) { continue; }
            if (nav.IsDisposed || !nav.IsHandleCreated) { continue; }
            try
            {
                using var gg = nav.CreateGraphics();
                float size = nav.Font.Size;
                bool fits = false;
                while (size >= 12f)
                {
                    Font trial = size == nav.Font.Size ? nav.Font : new Font(nav.Font.FontFamily, size, nav.Font.Style, GraphicsUnit.Point);
                    int need = 0;
                    try { need = TextRenderer.MeasureText(gg, nav.Text, trial, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Width; }
                    catch { need = 0; }
                    if (size != nav.Font.Size) { trial.Dispose(); }
                    if (need <= avail + 2) { fits = true; break; }
                    size -= 1f;
                }
                Check(fits, string.Concat(nav.AccessibleName, " label readable"));
            }
            catch { Log(string.Concat(nav.AccessibleName, " measure skipped")); }
        }
        foreach (Control card in mets)
        {
            int avail = card.Width - 50 - 8;
            if (avail <= 0) { continue; }
            foreach (Control k in card.Controls)
            {
                bool isValue = false;
                if (k.AccessibleName != null)
                {
                    if (k.AccessibleName.EndsWith(" value")) { isValue = true; }
                }
                Font baseF = isValue ? HeaderFonts.MetricValue : HeaderFonts.MetricLabel;
                float floor = isValue ? 9f : 7.5f;
                if (k.IsDisposed || !k.IsHandleCreated) { continue; }
                try
                {
                    using var gg = k.CreateGraphics();
                    float size = baseF.Size;
                    bool fits = false;
                    while (size >= floor)
                    {
                        Font trial = size == baseF.Size ? baseF : new Font(baseF.FontFamily, size, baseF.Style, GraphicsUnit.Point);
                        int need = 0;
                        try { need = TextRenderer.MeasureText(gg, k.Text, trial, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix).Width; }
                        catch { need = 0; }
                        if (size != baseF.Size) { trial.Dispose(); }
                        if (need <= avail + 2) { fits = true; break; }
                        size -= 1f;
                    }
                    Check(fits, string.Concat(k.AccessibleName, " readable"));
                }
                catch { Log(string.Concat(k.AccessibleName, " measure skipped")); }
            }
        }
        List<Control> wrapL = FindAll(ccf, "Header metrics wrapped");
        bool wrapped = false;
        if (wrapL.Count == 1) { wrapped = wrapL[0].Visible; }
        Log(string.Concat("wrapped=", wrapped.ToString()));
        if (wrapped)
        {
            if (navs.Count == 4)
            {
                if (mets.Count == 3)
                {
                    Control np = navs[0];
                    Control mp = mets[0];
                    if (np.Parent != null)
                    {
                        if (mp.Parent != null)
                        {
                            Rectangle navB = ScreenClient(np.Parent);
                            Rectangle metB = ScreenClient(mp.Parent);
                            Check(metB.Y >= navB.Bottom - 2, "wrapped metrics below nav");
                        }
                    }
                }
            }
            if (gToolbar.Count == 1) { Check(gToolbar[0].Height >= 140, "wrapped toolbar contains both rows"); }
        }
        bool lanesScrollable = false;
        List<Control> gridL = FindAll(ccf, "Routing and recent activity");
        if (gridL.Count == 1)
        {
            if (gridL[0] is ScrollableControl gsc)
            {
                if (gsc.AutoScroll)
                {
                    try { lanesScrollable = gsc.DisplayRectangle.Height > gsc.ClientSize.Height + 4; } catch { lanesScrollable = false; }
                }
            }
        }
        Log(string.Concat("lanesScrollable=", lanesScrollable.ToString()));
        List<Control> goL = FindAll(ccf, "GO lane card");
        List<Control> zenL = FindAll(ccf, "ZEN lane card");
        Check(goL.Count == 1, "GO card exactly once");
        Check(zenL.Count == 1, "ZEN card exactly once");
        if (goL.Count == 1)
        {
            Rectangle e = EffectiveRect(goL[0]);
            Check(e.Width >= 200, "GO usable width");
            if (lanesScrollable) { Log("GO below fold scrollable"); }
            else { Check(e.Height >= 80, "GO usable height"); }
        }
        if (zenL.Count == 1)
        {
            Rectangle e = EffectiveRect(zenL[0]);
            Check(e.Width >= 200, "ZEN usable width");
            if (lanesScrollable) { Log("ZEN below fold scrollable"); }
            else { Check(e.Height >= 80, "ZEN usable height"); }
        }
        if (goL.Count == 1)
        {
            if (zenL.Count == 1)
            {
                Rectangle a = ScreenClient(goL[0]);
                Rectangle b = ScreenClient(zenL[0]);
                Check(a.IntersectsWith(b) == false, "GO ZEN no overlap");
            }
        }
        string[] laneKids = new string[] { "GO lane title", "GO account selection", "ZEN lane title", "ZEN account selection" };
        foreach (string n in laneKids)
        {
            List<Control> f = FindAll(ccf, n);
            Check(f.Count >= 1, string.Concat(n, " present"));
            if (f.Count >= 1)
            {
                Rectangle e = EffectiveRect(f[0]);
                Check(e.Width > 0, string.Concat(n, " eff width eff=", e.ToString()));
                if (lanesScrollable) { Log(string.Concat(n, " scrollable height=", e.Height.ToString())); }
                else { Check(e.Height > 0, string.Concat(n, " eff height eff=", e.ToString())); }
            }
        }
        List<Control> lanesHost = FindAll(ccf, "Lane cards");
        List<Control> recentH = FindAll(ccf, "Recent activity");
        if (lanesHost.Count == 1)
        {
            if (recentH.Count >= 1)
            {
                Rectangle a = ScreenClient(lanesHost[0]);
                Rectangle b = ScreenClient(recentH[0]);
                Check(b.Y >= a.Bottom - 2, "recent after lanes");
            }
        }
        List<Control> footEnd = FindAll(ccf, "Desktop release and local endpoint");
        List<Control> footCopy = FindAll(ccf, "Copy local endpoint");
        Check(footEnd.Count == 1, "footer endpoint exactly once");
        Check(footCopy.Count == 1, "footer copy exactly once");
        if (footEnd.Count == 1)
        {
            Rectangle e = EffectiveRect(footEnd[0]);
            Check(e.Width > 0, "footer endpoint usable");
        }
        if (footCopy.Count == 1)
        {
            Rectangle e = EffectiveRect(footCopy[0]);
            Check(e.Width > 0, string.Concat("footer copy usable eff=", e.ToString(), " scr=", ScreenClient(footCopy[0]).ToString()));
        }
        bool hs = false;
        bool vs = false;
        try { hs = form.HorizontalScroll.Visible; } catch { hs = false; }
        try { vs = form.VerticalScroll.Visible; } catch { vs = false; }
        Log(string.Concat("hscroll=", hs.ToString(), " vscroll=", vs.ToString()));
        Check(hs == false, "no horizontal page scroll");
        int rightOver = 0;
        string rightFirst = string.Empty;
        List<Control> essential = new List<Control>();
        essential.AddRange(navs);
        essential.AddRange(mets);
        if (goL.Count == 1) { essential.Add(goL[0]); }
        if (zenL.Count == 1) { essential.Add(zenL[0]); }
        if (footEnd.Count == 1) { essential.Add(footEnd[0]); }
        if (footCopy.Count == 1) { essential.Add(footCopy[0]); }
        foreach (Control c in essential)
        {
            Rectangle e = EffectiveRect(c);
            if (e.IsEmpty) { continue; }
            if (e.Right > formScr.Right + 1) { rightOver = rightOver + 1; rightFirst = string.Concat(c.AccessibleName, e.ToString(), formScr.ToString()); }
        }
        Check(rightOver == 0, string.Concat("horizontal overflow count=", rightOver.ToString(), rightFirst));
        if (gFootId.Count == 1)
        {
            Rectangle e = EffectiveRect(gFootId[0]);
            Check(e.Bottom <= formScr.Bottom + 1, "footer fits vertically");
        }
    }
}