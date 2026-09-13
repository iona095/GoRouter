# GoRouter Web Control — product and interaction guide (W2)

Web Control is the local browser surface for **account and route management**.
It is a presentation layer over the W1 browser API; it adds no browser
authority. Opening, session and bootstrap behaviour are unchanged and are
described in [web-control.md](web-control.md).

W2 is deliberately not a general administration console. Router start/stop,
settings, model/catalog refresh, account probing, quota management, credential
display and forced removal do not exist in the browser — not as controls, not
as disabled controls, and not as requests.

## The page

### Header

- the product name;
- **Session** — plain-language connection state;
- **Router** — read-only status (`state (mode)`), never a control;
- **Refresh** — re-reads authoritative state;
- **Log out** — ends the browser session.

### Routing

Two lane cards, **GO** and **ZEN**, side by side where the window allows and
stacked when it does not. Each card shows:

- the selected account alias, or `Not selected`;
- the route state in words, never by colour alone;
- the stored-credential state of the selected account;
- a selector of accounts that are valid route targets;
- `Set route`, and `Clear route` only while that lane has a selection.

The lanes are independent. Changing one selector never touches the other and
never implies fallback or rotation. Changing a selector never mutates anything:
a route changes only when you click `Set route` or `Clear route`.

### Accounts

One row per account, in case-insensitive alias order, showing only
browser-safe metadata: alias, `Credential: Stored` / `Credential: Missing`,
lane use, and a locally formatted last-updated time. Actions are
`Replace credential`, `Rename` and `Remove`. Removal is separated from the
other actions and is always non-forcing.

Secret references, secret tails, raw credentials, admin or local credentials,
internal identifiers and file paths are never rendered.

### Empty state

With no accounts, the page explains that an account with a stored credential is
required before a lane can be selected, and offers a single `Add account`
action. No empty tables and no raw JSON are shown.

## Reviewed state and concurrency

Web Control holds **one reviewed snapshot**. Every mutation is submitted with
the generation and version numbers from that exact snapshot, so a change made
elsewhere is rejected rather than silently overwriting your review.

- Opening a form freezes the reviewed generation (and, for account forms, the
  account id and version) at that moment.
- A refresh or a conflict closes an open form. Reopen it against the refreshed
  values; the form never silently adopts newer numbers.
- On a conflict nothing is retried. The page refreshes once, tells you what
  changed, and waits for you to resubmit.

## Refreshing

Web Control refreshes on explicit `Refresh`, after a successful mutation, and
once after a conflict. There is no background polling, no socket, no worker and
no offline queue: the browser only talks to GoRouter when you act.

If a change succeeds but the follow-up refresh fails, the page says exactly
that — the change was saved, the display is stale — and disables further
changes until a `Refresh` succeeds. A known-successful change is never
described as uncertain.

## One change at a time

At most one mutation is in flight per tab. While one is pending, every other
action, `Refresh`, `Log out`, and the pending form's own cancel and Escape are
disabled until the request settles. Double-clicking a submit button sends one
request. Nothing is queued.

## When the result is unknown

If a mutation's response is lost, Web Control says the result is unknown,
discards any typed credential, retries nothing, and waits for you to
`Refresh` and review before allowing another change. A credential replacement
is never replayed.

## Credentials

An API key is typed once into a masked field, sent once, and discarded. There is
no reveal control and no way to read a stored credential back. The field is
cleared on submit, cancel, close, error, conflict, session loss and when the
page is navigated away from. Nothing is written to browser storage, a URL, a
cookie, a data attribute or a log.

## Blocking states

Some authoritative states make changes unsafe. Each has its own screen and its
own explanation, never a generic failure message. Only `Refresh` and `Log out`
remain available:

| State | Screen |
|---|---|
| first run / not initialised | finish setup in the desktop app |
| stored state corrupt | read-only until repaired from the desktop app |
| unsupported state or desktop schema | read-only until GoRouter is updated |
| credential store unavailable | read-only until the store is healthy |

A stopped router is **not** a blocking state: accounts and routes can still be
managed while the router is stopped.

## Session end and logout

If the session expires, or the page's CSRF capability is rejected, Web Control
discards its own state and asks you to reopen Web Control from the desktop app.
It never tries to mint a new capability over HTTP.

Logout reports what actually happened. A confirmed logout says `Logged out`. If
the logout response is lost, the page cannot know whether the server session
ended, so it says so and asks you to close the tab and reopen Web Control
rather than claiming a revocation it cannot confirm.

## Accessibility and layout

- semantic landmarks and headings; every control has an unambiguous name;
- every action is reachable and operable from the keyboard, with a visible
  focus indicator;
- dialogs take focus, contain it, restore it on close, and cannot be dismissed
  by the application while their request is unresolved;
- status, conflict and session messages are announced through live regions;
- state is always conveyed by text, never by colour alone;
- light and dark palettes are defined as explicit tokens and meet WCAG AA
  contrast for text and 3:1 for control boundaries and status graphics;
- usable at 360 CSS px with no horizontal page scrolling, and at 200% zoom with
  no clipped or overlapping controls;
- the only transition is decorative and is disabled under
  `prefers-reduced-motion`.

## Assets

The page is served from two fixed same-origin files beneath the W1 scope:
`assets/app.js` and `assets/app.css`. There are no remote assets, fonts, icons
or analytics, no service worker, no browser persistence and no published source
maps. The W1 content security policy is unchanged.
