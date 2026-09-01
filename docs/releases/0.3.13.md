# work-fold 0.3.13

September 1, 2026

work-fold 0.3.13 closes the remaining new-Chat naming and Assistant work-trail
persistence gaps, then hardens the transition between consecutive turns.

## Titles that stick

- The first successful turn makes exactly one isolated title request through
  that Chat's authenticated Pi model and provider transport.
- Reasoning models receive a supported non-off thinking level and enough output
  room to return the title instead of spending the budget before it.
- A failed or empty title response is recorded once and leaves **New Chat** in
  place. The first user message is never presented as a generated title, and a
  later turn never retries the request.

## Durable Assistant work

- Successful and interrupted Assistant messages save a bounded ordered trail
  of model-supplied Thinking and real tool calls in the portable Chat log.
- Reopening a tab or relaunching work-fold restores the settled trail with its
  safe tool target and terminal state. It does not show a ghost spinner or
  replay a completed command.
- Title and work-trail persistence are captured before shutdown cleanup can
  clear the live Pi client state.

## Clean consecutive turns

- Starting another message clears the prior streaming preview before the new
  turn becomes visible.
- The local event stream resets the accepted turn synchronously, preventing a
  reconnect from pairing the new running state with the previous reply.

## Safety and compatibility

- Work-trail text and counts are bounded during collection and again while the
  append-only transcript is parsed.
- Tool rows persist only their safe invocation summary, never raw command
  output or file bodies.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Verification

- Node 24 TypeScript checks, 47 focused title/activity/UI/store tests, and the
  complete 1,009-passing-test suite with one intentional skip.
- Desktop preparation, Electron preload and restricted-app sandbox smoke tests,
  and a high-severity dependency audit with zero vulnerabilities.
- Independent clean-agent review of the title and event-ordering race fixes.
- Developer ID signing, Apple notarization and stapling, Gatekeeper, updater
  metadata, checksums, public-asset verification, and green CI on both `main`
  and tag `v0.3.13`.
- Installed-app QA against OpenRouter: a fresh Chat generated one title,
  persisted completed Thinking and Bash entries across restart, completed a
  second turn without duplication, and reported 0.3.13 current through
  **Check for Updates…**.
