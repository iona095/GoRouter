# GoRouter Web Control (W1 proving surface)

Web Control is a loopback-only browser surface for inspecting sanitized state
and performing narrow account/route mutations. W1 is a security/lifecycle stage,
not the final browser UX.

## Opening Web Control

- **Warm (service already running):** in the desktop app, tray menu
  "Open web control". The authenticated shell asks the control service
  (`web.open` over the protocol-v2 pipe); the service opens the OS default
  browser itself. The bootstrap URL is fragment-only and is never printed,
  logged, or persisted. If the running service predates W1, the shell reports
  "not supported" and never restarts or replaces the service.
- **Cold (nothing running):** `gorouter web-control`. A dedicated entrypoint
  proves W1 capability first (a pre-W1 binary fails closed before starting
  anything), then starts the control service in web-safe mode and opens the OS
  default browser. Packaged runs always use the OS default browser; no
  environment variable can substitute a browser executable or arguments.

## Cold web-safe behavior (special case)

A control service born through the cold Web Control path stays
**auto-start-suppressed for its process lifetime**: opening Web Control never
starts the router, probes accounts, refreshes models, or contacts providers.
Browser HTTP requests cannot clear the suppression. An explicit authenticated
native `router.start` (desktop/pipe) still works but is never invoked by the
browser. Normal (non-web) startup keeps the pre-existing auto-start policy.

## Session

The browser session is HttpOnly, SameSite=Strict, process-local, and expires
30 minutes after issue. Logging out (or stopping the service) invalidates it.
If a bootstrap exchange fails ambiguously, open Web Control again from the
desktop app — the browser never retries a bootstrap automatically.

STOP: W1 ends here. Router Start/Stop/Restart controls in the browser,
production Apply/migration, commits/releases, and live-provider validation are
not part of this surface.
