/**
 * GoRouter W2 — Web Control presentation stylesheet source (C06 §10).
 *
 * Pure presentation. Served verbatim as the fixed `/assets/app.css` entry of the
 * frozen W1 asset map; the W1 CSP (`style-src 'self'`) is unchanged because the
 * page never injects a runtime style element and never uses an inline `style=`
 * attribute. Every dynamic presentation state is a class or attribute defined
 * here.
 *
 * Colour tokens are declared explicitly for light and dark so the C06 audit can
 * compute contrast ratios mechanically (see test/w2-contrast.test.ts).
 */
export const APP_CSS_SOURCE = `:root {
  color-scheme: light dark;
  --bg: #f1f3f6;
  --surface: #ffffff;
  --surface-2: #f5f7fa;
  --fg: #11161d;
  --fg-muted: #4c5663;
  --border: #747e8c;
  --border-strong: #5a6470;
  --accent-bg: #0a5aa8;
  --accent-bg-hover: #084a8c;
  --accent-fg: #ffffff;
  --danger-bg: #9c1f1b;
  --danger-bg-hover: #811714;
  --danger-fg: #ffffff;
  --ok-fg: #145c33;
  --warn-fg: #7a4d00;
  --info-fg: #0a4f8f;
  --focus: #0a5aa8;
  --disabled-fg: #565f6b;
  --disabled-bg: #e4e7eb;
  --backdrop: rgba(17, 22, 29, 0.45);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1318;
    --surface: #191f27;
    --surface-2: #212934;
    --fg: #eaeef3;
    --fg-muted: #b3bdc9;
    --border: #78838f;
    --border-strong: #99a3af;
    --accent-bg: #8cc0f5;
    --accent-bg-hover: #a7d0f8;
    --accent-fg: #08121d;
    --danger-bg: #f3958f;
    --danger-bg-hover: #f7b0ab;
    --danger-fg: #2a0907;
    --ok-fg: #74d6a0;
    --warn-fg: #e6b75f;
    --info-fg: #8cc0f5;
    --focus: #8cc0f5;
    --disabled-fg: #98a2ae;
    --disabled-bg: #262e39;
    --backdrop: rgba(0, 0, 0, 0.6);
  }
}

*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
}

body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.45;
  -webkit-text-size-adjust: 100%;
}

#app {
  max-width: 62rem;
  margin: 0 auto;
  padding: 0.75rem;
  min-width: 0;
}

h1, h2, h3 { margin: 0; line-height: 1.25; }
h1 { font-size: 1.15rem; }
h2 { font-size: 1rem; letter-spacing: 0.02em; text-transform: uppercase; color: var(--fg-muted); }
h3 { font-size: 1.05rem; }
p { margin: 0; }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---------- header ---------- */

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding: 0.6rem 0.75rem;
  margin-bottom: 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
}

.header-title { flex: 1 1 12rem; min-width: 0; }
.header-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.9rem;
  flex: 1 1 100%;
  min-width: 0;
}
.header-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.header-fact { font-size: 0.875rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.header-fact > strong { color: var(--fg); font-weight: 600; }

@media (min-width: 45rem) {
  .header-facts { flex: 1 1 auto; justify-content: flex-end; }
}

/* ---------- live regions / banners ---------- */

#regions:empty { display: none; }
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  margin-bottom: 0.6rem;
  border: 1px solid var(--border-strong);
  border-left-width: 5px;
  border-radius: 6px;
  background: var(--surface);
  min-width: 0;
}
.banner p { flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
.banner-label { font-weight: 700; }
.banner-alert { border-left-color: var(--danger-bg); }
.banner-alert .banner-label { color: var(--danger-bg); }
.banner-status { border-left-color: var(--ok-fg); }
.banner-status .banner-label { color: var(--ok-fg); }

/* ---------- sections / cards ---------- */

section { margin-bottom: 1rem; min-width: 0; }
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.lanes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.75rem;
}

.lane-card, .panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem;
  min-width: 0;
}
.lane-card { border-top: 4px solid var(--border-strong); }
.lane-card-go { border-top-color: var(--accent-bg); }
.lane-card-zen { border-top-color: var(--ok-fg); }

.lane-head { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.4rem; }
.lane-tag {
  font-weight: 700;
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0.05rem 0.35rem;
  color: var(--fg);
}
.lane-selected { font-size: 1.05rem; font-weight: 600; overflow-wrap: anywhere; margin-bottom: 0.15rem; }
.lane-meta { font-size: 0.875rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.lane-form { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.4rem; }
.lane-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }

/* ---------- accounts ---------- */

.account-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
.account-row {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.7rem 0.75rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: flex-start;
  min-width: 0;
}
.account-main { flex: 1 1 13rem; min-width: 0; }
.account-alias { font-weight: 600; font-size: 1.02rem; overflow-wrap: anywhere; }
.account-meta { font-size: 0.85rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.account-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-start; }
.account-actions-danger {
  flex-basis: 100%;
  border-top: 1px solid var(--border);
  margin-top: 0.35rem;
  padding-top: 0.55rem;
  flex-direction: column;
  align-items: flex-start;
}
@media (min-width: 45rem) {
  .account-actions-danger {
    flex-basis: auto;
    border-top: 0;
    border-left: 1px solid var(--border);
    margin-top: 0;
    padding-top: 0;
    padding-left: 1.25rem;
    margin-left: 0.5rem;
  }
}

.chip {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 600;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  margin: 0.15rem 0.3rem 0 0;
  color: var(--fg);
}
.chip-ok { color: var(--ok-fg); border-color: var(--ok-fg); }
.chip-warn { color: var(--warn-fg); border-color: var(--warn-fg); }
.chip-lane { color: var(--info-fg); border-color: var(--info-fg); }

/* ---------- blocking / terminal screens ---------- */

.notice { max-width: 44rem; }
.notice h2 { text-transform: none; letter-spacing: normal; font-size: 1.1rem; color: var(--fg); margin-bottom: 0.4rem; }
.notice p { margin-bottom: 0.5rem; overflow-wrap: anywhere; }
.notice-list { margin: 0 0 0.5rem 1.1rem; padding: 0; }

/* ---------- controls ---------- */

button, select, input {
  font: inherit;
  color: var(--fg);
  border-radius: 6px;
  min-height: 2.5rem;
  max-width: 100%;
}

button {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  padding: 0.35rem 0.8rem;
  cursor: pointer;
  transition: background-color 120ms ease-in-out;
}
button:hover:not(:disabled) { background: var(--bg); }
button.primary {
  background: var(--accent-bg);
  color: var(--accent-fg);
  border-color: var(--accent-bg);
  font-weight: 600;
}
button.primary:hover:not(:disabled) { background: var(--accent-bg-hover); border-color: var(--accent-bg-hover); }
button.danger {
  background: var(--danger-bg);
  color: var(--danger-fg);
  border-color: var(--danger-bg);
  font-weight: 600;
}
button.danger:hover:not(:disabled) { background: var(--danger-bg-hover); border-color: var(--danger-bg-hover); }
button.link {
  background: none;
  border-color: transparent;
  text-decoration: underline;
  padding: 0.2rem 0.4rem;
  min-height: 2rem;
}

button:disabled {
  background: var(--disabled-bg);
  color: var(--disabled-fg);
  border-color: var(--border);
  border-style: dashed;
  cursor: not-allowed;
}

select, input[type="text"], input[type="password"] {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  padding: 0.35rem 0.5rem;
  width: 100%;
}
select:disabled, input:disabled { background: var(--disabled-bg); color: var(--disabled-fg); border-style: dashed; }

:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

/* ---------- forms / dialog ---------- */

dialog {
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg);
  padding: 0;
  width: min(30rem, calc(100vw - 1.5rem));
  max-width: calc(100vw - 1.5rem);
  max-height: calc(100vh - 1.5rem);
  overflow: auto;
}
dialog::backdrop { background: var(--backdrop); }
.dialog-inner { padding: 0.9rem; display: flex; flex-direction: column; gap: 0.7rem; min-width: 0; }
.dialog-inner form { display: flex; flex-direction: column; gap: 0.7rem; min-width: 0; }
.dialog-title {
  font-size: 1.05rem;
  overflow-wrap: anywhere;
  text-transform: none;
  letter-spacing: normal;
  color: var(--fg);
}
.dialog-body { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.dialog-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }

.field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.field label { font-weight: 600; font-size: 0.9rem; }
.field-hint { font-size: 0.82rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.field-error { font-size: 0.85rem; font-weight: 600; color: var(--danger-bg); overflow-wrap: anywhere; }
.form-errors {
  border: 1px solid var(--danger-bg);
  border-left-width: 5px;
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.form-errors:empty, .field-error:empty { display: none; }
input[aria-invalid="true"] { border-color: var(--danger-bg); border-width: 2px; }

.pending-note { font-size: 0.85rem; color: var(--fg-muted); }
.pending-note:empty { display: none; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
`
