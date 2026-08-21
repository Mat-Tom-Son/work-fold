# work-fold 0.3.5

August 20, 2026

work-fold 0.3.5 makes remote work feel live and finishes two conversation
affordances the desktop was missing: a queued mid-turn send and an inline
file preview.

## Your fold on the web, live

- While a management turn runs, the desktop now streams its activity line to
  the approved browser as throttled, signed, encrypted `operation.event`
  ticks over the existing envelope lane — the same vocabulary the menu-bar
  fold shows. The reply arrives the moment the turn settles instead of on the
  next poll tick.
- The capability is advertised, never probed: the summary projection carries
  it, so an older installed desktop is simply never asked and the hosted
  client stays on its polling cadence until this update is installed.
- Every streamed tick is separately authority-checked before it leaves the
  desktop, sequences increase strictly under the relay's monotonic guard, and
  a watch always resolves inside the operation timeout. The bridge persists
  no content; it relays ciphertext.
- The hosted client keeps at most one watch, ignores ticks from a superseded
  watch, and quietly returns to polling if a watch ever fails.

## Remote client stays inside its budget

- The relay's per-session operation budget doubled while the client learned
  discipline: a slower active tick with the digest riding a fraction of it, a
  cooldown after any throttled response that pauses background refresh while
  explicit sends stay allowed, debounced resume bursts, and a status-poll
  fallback that backs off while the event stream is healthy.

## Desktop conversations

- Enter during a running turn queues one draft as a visible, cancellable
  bubble that sends when the turn settles; further Enters append to it, and
  Stop or its cancel returns it to the composer ahead of anything newer.
- The file tab now shows the file itself: bounded text renders inline with
  truncation disclosed, recognized image types render through the same-origin
  raw-file route, and binary or oversized content declines with its reason.
  The preview route honors the same Space path policy as every entry route.

## Safety and compatibility

- Streaming adds one allowlisted operation name; the envelope identity,
  signing, encryption, revocation, and never-list boundaries are unchanged.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates are disabled; dormant Windows build code remains
  available for a future deliberate reactivation.
- The macOS updater still publishes Apple-silicon (`arm64`) artifacts only.
- Live streaming covers the management conversation's own turn; handed-off
  child work in Spaces continues to update on the refresh cadence.

## Verification

- Node 24 dependency installation, TypeScript checks, full tests, and the
  high-severity dependency audit.
- The bridge suite, including the new allowlist, budget, and watch-discipline
  contract pins, plus a full encrypted-frame sequencing test on the desktop
  transport and facade capability tests.
- macOS Developer ID signing, hardened runtime, Apple notarization and
  stapling, Gatekeeper assessment, packaged-asset verification, updater
  metadata verification, release checksums, and remote digest audit.
