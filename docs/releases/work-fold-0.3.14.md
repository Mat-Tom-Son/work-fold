# work-fold 0.3.14

September 1, 2026

work-fold 0.3.14 makes Routings usable from both sides of the product: a
minimal human control surface in Settings and one shared management contract
for the fold and every shell-capable agent harness.

## Routings in Settings

- **Settings → The fold → Routings** lists each routing, its schedule, current
  state, referenced Spaces, steps, and recent runs.
- The focused action set is **Run a copy now**, **Stop**, **Turn off**, **Ask to
  turn on**, and **Delete**. Enabling still follows the existing staged review
  or Unrestricted authority path.
- Exact admitted run ids drive the live state. Queued, active, and settled work
  cannot be confused by delayed refreshes or a fast switch between routings.
- Damaged state fails closed for new power while stop, disable, and deletion
  remain available where they safely narrow authority.

## One-time scheduled Space work

- Routing declarations now accept a version 2 `at` trigger with an
  explicit-offset timestamp and an explicit missed-run choice: `run` or
  `skip`.
- One-time work can be scheduled from 1 minute through 366 days ahead. A
  scheduled occurrence is durably claimed at most once; **Run a copy now** is
  independent and never consumes or shifts it.
- Sleep and wake preserve one eligible catch-up. If work-fold was quit at the
  scheduled time, launch applies the declared missed-run choice rather than
  pretending a background helper ran.
- Completed one-time routings remain visible with their receipts until they
  are deleted.

## The same surface for AI models

- `work-fold routings list|show|stage|run|stop|disable|delete|receipts` is the
  installed, authenticated management surface used by Pi, Codex, Claude Code,
  and other shell-capable harnesses.
- The fold's materialized management instructions and mirrored Skill teach the
  version 2 declaration, one-time reminders, deferred Space work, staged
  enablement, and the full management vocabulary.
- A model-authored version 2 proposal is covered end to end through the real
  CLI facade and the same staged authority path the desktop uses. Settings is
  a projection over that domain, not a separate scheduler or builder.

## Durability and compatibility

- Version 1 routing declarations and stores continue to load; the store moves
  to schema 2 on its next write without inventing an occurrence.
- Interval and one-time schedule claims persist before hop 1. Persistence
  failures close the accepted run with a terminal receipt and execute no hop.
- Suspend, disable, Space removal, restart recovery, receipt rotation, global
  concurrency, and per-routing non-overlap retain their existing fences.
- CLI JSON receipt ordering remains oldest to newest and globally bounded,
  while Settings reads one bounded per-routing projection so a busy routing
  cannot hide a quiet routing's latest result.

## Verification

- Node 24 TypeScript checks and the complete 1,040-test suite: 1,039 passed and
  one dormant Windows watcher test skipped intentionally.
- Clean lockfile install, a high-severity dependency audit with zero
  vulnerabilities, desktop preparation, Electron preload and restricted-app
  sandbox smokes, and desktop preflight.
- Independent clean-agent review of authority boundaries, journal durability,
  sleep/wake recovery, migration, CLI compatibility, and stale UI response
  handling.
- Developer ID signing, Apple notarization and stapling, Gatekeeper, updater
  metadata, checksums, public-asset verification, and installed-client update
  testing for tag `v0.3.14`.

This is an in-place work-fold update. It does not read, migrate, or modify
legacy Workspace application state or `.workspace/` metadata.
