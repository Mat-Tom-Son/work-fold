# work-fold 0.4.17

September 5, 2026

This release strengthens History recovery, adds folder-change Routings, and
turns Checks into a configurable review tool for prose and other text.

## Safer recovery

- History refuses destructive recovery when its safety point cannot cover the
  affected content, including oversized, unreadable, and protected files.
- Registered child Spaces are excluded from parent History. Old checkpoints
  cannot overwrite or remove a newly registered child Space.
- Ignore rules protect excluded descendants during recovery. Moving and
  relinking a Space preserves its local History and ignore settings.
- **Review restore** shows the files, removals, moves, exclusions, and conflicts
  before confirmation. Restores refresh Files, History, and Check freshness.
- Desktop and CLI restoration share running-work guards. App file writes,
  automation launches, routing transfers, and Space ownership changes cannot
  enter the protected recovery operation concurrently.

## Folder-change Routings and handoffs

Ask the fold to prepare a Routing that watches a folder in a registered Space.
Review its exact folder, extensions, timing, and steps before enabling it.
An ordered Routing can wait for a Chat, copy explicitly selected or newly
created files into another Space, run its Checks, and start the next Chat.

Folder observation uses bounded metadata polling, debounce, and cooldown.
It runs while work-fold is open and awake. Observers pause during Routing runs
and start a fresh baseline afterward, on startup, and after wake. Changes during
those pauses are not replayed; this also prevents Routing output from causing
unbounded feedback loops. Observer health is visible in Settings.

## Checks you can define

Open **Checks** from the command palette, then **New Check**. Choose required
files or a text review, write the review criteria, and designate the primary
files plus optional reference files. Enabling a Check saves its definition;
**Run Checks** makes the separate review request.

Text reviews use the fold's selected model with only the criteria and designated
UTF-8 text. They do not inherit the fold transcript or get editing tools. Every
finding must cite an exact, unique primary-file quote; changes to any input
invalidate the result. Suggestions are model judgments, not verified facts.
The initial bounds are 16 files, 128 KiB per file, 256 KiB total, 32 findings,
and a two-minute timeout. Normal provider charges apply.

## Verification and compatibility

Node 24 clean installation, both TypeScript checks, 1,069 passing desktop tests
(one Windows-only skip), all 48 bridge tests, and the dependency audit passed.
Desktop preparation passed the production build, Electron preload and
restricted-app sandbox probes, and preflight. An isolated interactive journey
created a Check, received an exact-quote finding from a real configured model,
previewed and applied a restore, and invalidated the now-stale finding.

The one-time Routing overlap regression now holds its synthetic Chat explicitly
and requires both the manual and preserved scheduled runs to succeed. This fixes
a fixture that could throw on a nonexistent lineage field and pass or fail based
on receipt timing.

The dependency audit includes patched fast-uri and xmldom build dependencies.
Coverage includes protected recovery, moved and nested Spaces, concurrent work,
watcher bursts/revocation/wake, model evidence admission, and the native model
transport. Bridge tests now run in CI alongside desktop tests. Existing bridge
decision cards already support these Routing details, so this release requires
no Railway deployment.

Existing deterministic Checks and Routing declarations remain readable. New
model reviews use Checks state version 2; folder triggers use Routing declaration
version 3. Installed-client updater testing follows publication.

This is an in-place work-fold update. Legacy Workspace state and release
history remain untouched.
