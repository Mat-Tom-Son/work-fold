# work-fold 0.2.4

August 5, 2026

work-fold 0.2.4 makes the connected Chat calmer and more useful. The interface
removes structural divider lines, adds a small inline rename workflow for saved
management Chats, and keeps idle refreshes from rebuilding unchanged messages
or replaying their entrance motion.

## Connected Chat polish

- Removed ornamental separators from the rail, conversation header, message
  stream, composer area, and Files pane while preserving clear spacing and
  focus states.
- Kept the conversation title as the page heading and added a compact edit
  action with save, cancel, Escape, empty-title, length, busy-state, and error
  handling.
- Saved titles update the durable management Chat record, so the new name is
  reflected in both the connected browser and the desktop app.

## Idle stability

- Reconciled transcript rows by message id and only updates changed fragments,
  preventing the scheduled refresh from replacing an unchanged transcript.
- Added stale-response guards around Chat-list, summary, transcript, and rename
  requests so slower earlier polls cannot overwrite a newer selection or title.
- Limited entrance motion to genuinely new messages and retained the reader's
  scroll position unless changed content arrives near the bottom.

## Remote operation contract

- Added the bounded `management.rename` operation across the hosted client,
  bridge allowlist, desktop relay, local management adapter, and durable Chat
  store.
- Title normalization rejects blank names and limits stored titles to 80
  characters without exposing a generic local API or direct Space-Chat lane.

## Mac distribution

The Apple silicon app and DMG are Developer ID-signed by Team `464JD5K8DC`,
notarized by Apple, stapled, and accepted by Gatekeeper. The separate Mac feed
contains the DMG, updater ZIP, both blockmaps, `latest-mac.yml`, checksums, and
the machine-readable and human-readable release manifests from one verified
build.

This is an explicit Mac-first release. Windows signing and publication remain
deferred; no unsigned Windows installer is presented as a public release.

## Qualification

- TypeScript checks, the complete automated suite, bridge integration tests,
  desktop preparation, and the high-severity dependency audit must pass before
  publication.
- Production artifacts must pass signing, hardened-runtime, Apple notarization,
  stapling, Gatekeeper, mounted-DMG, updater metadata, checksum,
  release-manifest, and remote digest verification gates before publication.
