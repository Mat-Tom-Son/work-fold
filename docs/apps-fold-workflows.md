# Apps and the fold: implementation plan

Status: in progress; this document tracks the agreed implementation goal. It
does not claim that pending capabilities are available in a released build.

The intended journey is a Space app that helps with real work, can ask its
Space Assistant to do a bounded task, shows the resulting files and Checks,
and remains useful from an approved phone browser while the desktop is online.
Keep the visible controls short and put setup detail behind the existing Apps
management surface.

## Work slices

- [ ] Change this app: start from exact installed bytes, retain source/build
  provenance, prepare a Chat draft, preview a proposed revision, and use the
  existing reviewed update path. A target Instance must not leak its data or
  Chat into the source Space.
- [x] App data: complete versioned export and explicit recovery, with integrity,
  namespace/revision checks, durable recovery evidence, and no authority restore.
- [ ] Space context: retain explicit file grants; add selected Check results
  and app-owned task progress through narrow, declared host capabilities.
- [ ] Assistant actions: reviewed bounded intents, person-authorized dispatch
  into the owning Space, deduplicated acceptance, visible progress/results,
  cancellation and generation checks. No generic fold or shell bridge.
- [ ] Fold results: bounded file/app previews and direct deliverable/review
  navigation from completed requests.
- [ ] Web apps: responsive desktop-served views, clear offline/revoked states,
  and separately authorized bounded actions in approved browsers. Shared viewer
  links remain read-only, with no management or runtime-action authority.
- [ ] Integration: concise UI, canonical docs and harness parity, automated
  adversarial coverage, real desktop/browser journey, clean commits and merge.

## Acceptance journey

Use synthetic quote files in a Purchasing Space and a separate Delivery Space.
Build a comparison app with deliberately limited file and Check access. Ask its
Assistant to compare the selected quotes, introduce and repair a Check failure,
and open the resulting comparison from the fold on a narrow browser viewport.
Confirm that unrelated files, Chats, Spaces and shared viewers cannot exercise
the app's powers. Retry an uncertain request and verify one accepted task;
revoke or update during work and verify stale effects stop. Export, change,
restore and reopen app data; reject corrupt, foreign and conflicting restores.
Change the app while preserving its data, review the update, and confirm changed
permissions reset. Disconnect/reconnect the desktop without inventing a success
or replaying a write.

Publication of a new desktop build and deployment of the Railway bridge remain
outside this implementation goal. Record exact verification and remaining work
here as each slice lands.

## Progress: app data and live controls

Implemented complete data export, same-revision/same-installation restore, one
durable Undo point for clear/restore, and source-Project-scoped retained-data
export. See [the data contract](app-data-recovery.md). Automated coverage includes
512-key snapshots, tampering, foreign identities, exact revision conflicts,
interrupted commits, restart, unchanged grants/jobs and API reservations.

Live QA uses `/tmp/workfold-apps-goal-qa`, a separate development profile with
one synthetic App Recovery QA Space. The normal Applications build is untouched.
The native app has exercised app-owned writes, JSON download, clear, Undo,
file-chooser restore and reopening the app with the restored quote visible.

The walkthrough also found and fixed three existing issues:

- CLI-created decisions and approved installs left the visible rail/catalog
  stale. A single authenticated, content-free control stream now invalidates
  decisions and app catalogs; hidden windows disconnect and reconnect re-reads.
- Confirmation dialogs used a separate keyboard trap from their parent modal.
  They now share the modal stack, keeping nested confirmation focus and
  accessibility intact and restoring the parent afterward.
- Removing nonexistent app connections encrypted an empty store, unnecessarily
  opening macOS Keychain during an app update. No-op cleanup now avoids encryption
  while still checking an explicit effect authorizer.

The live retest completed a reviewed update to fixture version 1.0.2 without a
Keychain request, refreshed the catalog immediately, and preserved the quote.
After restart the interrupted prior update retained its installed pointer and
data and finished pending cleanup. The fixed nested confirmation exposes only
its own controls, focuses Cancel for clearing, and Escape restores the parent
with data unchanged.

Verification: `npm run check`, `npm test` (1,102 passed; one Windows-only skip),
and `npm run desktop:prepare` including both real Electron probes passed.
Logs: `/tmp/workfold-apps-check.log`, `/tmp/workfold-apps-tests.log`,
`/tmp/workfold-apps-desktop.log`. The other work slices remain pending; no release
is published.
