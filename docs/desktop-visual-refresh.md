# GoRouter Desktop visual refresh — spec

Skills: `to-spec` (contract first), `incremental-implementation` (thin slices).
No file paths or code snippets below by skill rule — module-level decisions only.

## Problem Statement

The desktop shell is truthful and functional but reads as an engineer-built
admin panel: state is echoed in three places at once (header badge, footer
dot, footer text) while the actual question — "is it working, where is
traffic going" — is not answered in the first glance. The activity preview
truncates timestamps and outcome text mid-word, the Journal tab shows raw
text where color chips belong, the System tab ships an empty Settings group,
and there is no dark theme. Operators keep the app open all day; it should
look deliberate, not default.

## Solution

A visual refresh of the existing shell, in thin slices: a status-at-a-glance
header band, boarding-pass lane cards with three explicit states, outcome
chips and relative times in lists, illustrated empty states, a state-carrying
tray glyph, a tightened type/spacing system, a manual dark-theme toggle
backed by a mirrored token contract, and a System tab with no dead space.
Zero behavior change: every control keeps its protocol, validation, and
truncation semantics; only presentation moves.

## User Stories

1. As an operator, I want the app window to tell me health + routing in one
glance, so that I never hunt across badge, footer, and tabs.
2. As an operator, I want each lane card to show its routed account big and
its state (routed / cleared / error) as one visual, so that lane status is
obvious without reading three stacked labels.
3. As an operator, I want recent activity with relative times and outcome
chips, so that I can scan health without parsing timestamps or UUIDs.
4. As an operator, I want outcome/status as color chips in the Journal tab,
so that errors visually pop in a dense table.
5. As a new user, I want empty states with an icon and one next action, so
that a fresh install tells me what to do instead of showing blank grids.
6. As an operator, I want the tray glyph itself to carry state color, so
that I see health without opening the menu.
7. As an operator, I want a dark theme toggle in the header, so that the
app matches my environment at night; my choice persists across restarts.
8. As an operator opening System, I want every group to have content, so
that the tab never looks unfinished.
9. As a user with accessibility needs, I want every visual state to keep its
accessible name and tab order, so that the refresh never regresses the
a11y evidence dumps.
10. As a maintainer, I want all color to flow through the shared theme
module, so that dark mode can never leak a hardcoded light color.
11. As a maintainer, I want the 1s snapshot tick to stay cheap, so that
visual polish never re-couples animation or layout to the hot path.
12. As an operator running a long probe, I want progress affordance on
long calls, so that a 90s account test does not look hung.

## Implementation Decisions

- Token-first: the shared theme module gains the full contract up front —
  a 5-role type scale, an 8px spacing grid, status-chip treatments, empty-
  state composition, and a complete mirrored dark token set — before any
  control is restyled. Controls consume tokens; no per-control color or
  font literals (grep-gated).
- Header band: one state dot + state word + one-line route summary +
lifecycle actions in a single band; the footer keeps only the local
endpoint text (state display lives in exactly one place).
- Lane cards: accent spine per lane from existing lane tokens; one account
  identity line; Set/Clear inline; routed / cleared / error as three
  explicit card states reusing the existing confirmation / neutral / error
  treatments (this collapses the stacked feedback/error/resting labels and
  shrinks the truncation surface by construction).
- Lists: activity preview drops the request-ID column, shows relative
  times with absolute tooltip/title, outcome chips; Journal tab gains
  outcome/status chips; truncation rules unchanged.
- Tray: runtime-composited status pip on the existing generated glyph
  (green / amber / gray), theme-aware.
- Dark toggle: header text button beside lifecycle actions (names the
  target: "Dark" while light is active; glyph-free, no font-fallback
  risk); manual Light/Dark persisted in desktop settings `theme`
  (default light = current look; absent/corrupt reads as light);
  instant apply to all open surfaces incl. dialogs; follow-system
  explicitly deferred. Owner-drawn tab strip paints from live tokens
  (no branches needed); the non-owner-drawn journal grid re-resolves
  cached subitem styles on toggle. Implemented in slice 6b:
  - `VisualTheme.Mode` + per-token dark twins; `Map`/`ApplyTheme` walker
    re-resolves stored control colors (ARGB-keyed: .NET Core named/system
    colors do NOT equal identical ARGB literals as dictionary keys, so
    the maps key on `ToArgb()`).
  - Custom controls implement `IThemeAware.RefreshTheme` (cards, lane
    status boxes, selectors, action buttons, status dots); stock labels
    with OS-default text normalize dark-only (plain Buttons excluded —
    their faces stay OS light gray).
  - Toggle persists via `desktop.set { theme }` and applies instantly;
    the snapshot tick re-syncs (startup included).
  - The band port label was retired (toggle crowded the row; the footer
    endpoint already carries the port).
  - OS-owned chrome stays native by design: window frame, ListView column
    headers, scrollbars, plain-button faces, tray/context menus.
  - Evidence: selftest `--theme light|dark` (flows into the synthetic
    snapshot) and `--tab <name>` (captures Journal etc.).
- System tab: the empty Settings group is removed or filled with the real
  live settings (port, retention, start-at-login) — decided in its slice;
  no placeholder groups ship.
- Micro-feedback last and never on the snapshot tick path (fade on
  refresh, press states, probe progress); dirty-check and fingerprint
  guards from the perf pass stay authoritative. Slice 8: busy buttons on explicit Refresh/Apply clicks (quiet path otherwise); 650ms stats-line pulse on clean user refresh; outline-tinted hovers; probe marquee already existed.
- Slice order: header + lane cards → type/spacing → empty states + chips →
  tray pip → dark toggle → System cleanup → micro-feedback.

## Testing Decisions

- A good test here is external behavior, not pixels: state-to-visual
  mapping (every router state renders its token, no fallback leak),
  theme completeness (every token resolves in both themes), and
  a11y-name preservation. No screenshot-diff assertions (brittle across
  DPI/fonts).
- Seams (highest available, existing preferred): the offscreen selftest
evidence driver (injected snapshots → PNG + accessibility dumps across
  named states) is the primary seam — new states render through it and
  reviewers inspect the PNGs; the a11y dumps assert names/roles/tab
  order programmatically. Theme-token unit coverage lives next to the
  theme module (every light token has a dark twin; no orphan tokens).
- Prior art: existing selftest states (empty / configured / degraded /
  stopped / error / longalias / portconflict), the resize-matrix and
  nav-test harnesses, and the behavior-seam test conventions of the
  audit loop.

## Out of Scope

- Follow-system-theme (manual toggle only).
- New functionality (no new ops, tabs, or settings keys beyond the theme
  preference; the Settings-group question resolves to remove-or-fill,
  never expand).
- Animations on the 1s tick path; any change to protocol, validation,
  truncation, journal, proxy, or sync behavior.
- Screenshot-diff testing.

## Further Notes

- Screenshots of the current state (all four tabs) drove the truncation
  and dead-space findings; re-capture after the header/cards slice for a
  side-by-side check.
- The dark toggle is the only slice that adds a persisted setting; its
  migration story is "absent = light", no file migration needed.
