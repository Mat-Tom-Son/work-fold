# Apps and the fold: implementation plan

Status: in progress; this document tracks the agreed implementation goal. It
does not claim that pending capabilities are available in a released build.

The intended journey is a Space app that helps with real work, can ask its
Space Assistant to do a bounded task, shows the resulting files and Checks,
and remains useful from an approved phone browser while the desktop is online.
Keep the visible controls short and put setup detail behind the existing Apps
management surface.

## Work slices

- [x] Change this app: start from exact installed bytes, retain source/build
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

The user has now authorized merging the completed work onto `main`, syncing
GitHub, and publishing a new desktop release after verification. Follow the
shared signed/notarized Mac lane, including successful CI on the exact main
commit and source tag. Verify the offered update and leave installation to the
user's update button. Railway deployment remains separate. Record exact
verification and remaining work here as each slice lands.

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

## Progress: exact app working copies

The development branch now connects **Change this app** on the Apps card to an
exact installed-package copy, History, durable machine-local provenance, and an
unsent source-Space Chat draft. Proposals from that copy pin their source preview
predecessor, including an absent preview, so competing edits cannot silently
replace each other's reviewed work. Focused tests cover retries/restart,
interruption, changed copies, corrupt receipts, symlinks, History failure,
release-backed source/target separation, API reservations, and competing edits.
See [Changing an installed app](app-changes.md) for the implemented contract.

The first checklist item remains open: preview placement for a Release
installed in its own source Space still needs completion. Original-Chat and
exact-target update navigation are now implemented as described below. The remaining context, Assistant, fold result, and
approved-browser work retains its full scope above.

Verification for this slice: `npm run check`, `npm test` (1,107 passed, one
Windows-only skip), and `npm run desktop:prepare`, including both real Electron
probes, pass. Logs: `/tmp/workfold-app-change-check.log`,
`/tmp/workfold-app-change-tests-final.log`, and
`/tmp/workfold-app-change-desktop.log`.

Live testing in the isolated `/tmp/workfold-apps-goal-qa` desktop profile found
and fixed a double-encoded renderer request; the actual renderer helper now has
request-shape/session-header coverage. Clicking Change this app then created an
exact version-1.0.2 copy and an unsent Chat draft; History displayed its restore
point. Editing that synthetic copy and submitting it through the canonical CLI
proposal lane produced a needs-you review. Desktop approval installed version
1.0.3, refreshed the visible app, and preserved its saved quote. Restart retained
the edited app and quote. A final button test created a copy of 1.0.3, with a
shorter draft and the typing position visible. The test app is quit; production
application data and the Applications installation were not changed. A real
Assistant turn and the combined multi-Space/browser acceptance journey remain
for the later integrated slices.

## Progress: build and update navigation

App details now shows **Open build Chat** when the source Chat is still
identifiable, with its source path under Package & runtime. **Review updates**
opens App Studio on the exact installed target, including when reached from a
changed source preview. Provenance carries that target through subsequent
working copies and CLI reviews; a removed installation cannot redirect the
link to another one. Both controls navigate only. App Studio preserves later
manual target selections when its data refreshes.

Verification: `npm run check`, `npm test` (1,109 passed; one Windows-only skip),
and `npm run desktop:prepare` pass. Added tests exercise retained Chat/target
context across multiple edits and restart, stale target removal, the local API,
and real DOM navigation with two potential installations. Logs:
`/tmp/workfold-app-navigation-check.log`,
`/tmp/workfold-app-navigation-tests.log`, and
`/tmp/workfold-app-navigation-desktop.log`.

Live desktop QA used the existing isolated source Space and a second synthetic
App Updates QA Space with its own installed Release. Open build Chat reached
the source fixture Chat with an empty composer. Review updates switched to the
source App Studio and selected App Updates QA, with no pending activation review
created. The first empty fixture Chat was correctly unavailable because the
normal Chat listing removes transcripts containing only a title; adding a
clearly labeled synthetic message completed the navigation fixture. No actual
Assistant turn ran in this test. The QA app is quit and production state remains
untouched. Source-Space preview placement and the broader acceptance journey
remain open.

## Progress: native installation isolation

The native host now keys worker reuse, pending launches, authority generations,
storage hints and notification ownership by exact Feature Installation. The
service scopes stop operations to that installation. Removing and re-adding
authority fences pending launches, and duplicate installation identities fail
before replacing the authority table. Aggregate notification volume remains
bounded across installations of the same app.

Verification: `npm run check`, `npm test` (1,110 passed; one Windows-only skip),
and `npm run desktop:prepare` pass. The real Electron probe runs two installations
with identical Space, manifest and digest: separate worker tokens and data,
independent stop/revocation, pending-launch invalidation and no sibling storage
hints. Notification tests check separate category handles and exact click
ownership. Logs: `/tmp/workfold-app-instance-check.log`,
`/tmp/workfold-app-instance-tests.log`, and
`/tmp/workfold-app-instance-desktop.log`.

This is runtime groundwork. Source-Space preview/release coexistence remains
disabled until renderer and management selectors carry the same exact identity.

## Progress: installation-bound navigation

Renderer catalogs, app details, rail selection, native mounts, notification
navigation and contributed tabs now retain the exact Feature Installation.
An update/removal in the catalog preserves sibling installations. Reinstalling
identical bytes cannot inherit an old app tab; old stored tabs without an
installation identity are discarded. A native mount resolves its exact current
Space, app, installation and digest before loading. Reusing a mount id for a
different installation destroys the predecessor view instead of reusing it.

Automated verification includes same-revision sibling tabs, remove/reinstall,
cross-Space descriptor refusal, DOM catalog updates/removal, and exact
notification targets. The real Electron probe replaces a view using the same
mount id, verifies the sibling's data and tab command, then stops the original
installation and confirms that the sibling view survives. The full suite passes
(1,113 passed; one Windows-only skip), as does `npm run check`. Logs:
`/tmp/workfold-app-navigation-identity-check.log`,
`/tmp/workfold-app-navigation-identity-tests.log`, and
`/tmp/workfold-app-navigation-identity-smoke.log`.

Management mutation selectors and the source-Space placement rule are still
pending. Coexistence remains disabled until those controls use exact identities.

`npm run desktop:prepare` also passes in full; its log is
`/tmp/workfold-app-navigation-identity-desktop.log`. The initial added native-view
assertion needed to retain the WebContents reference before Electron destroyed
the view; the corrected probe and complete preparation both pass.

Live QA in the isolated desktop profile opened the source preview from the
rail with the saved North quote visible and 43 B in Details. Switching to the
App Updates QA Apps tab switched Spaces; its installed Release opened from its
own rail with no saved quote and 0 B in Details. The preview had Remove preview
and Open App Studio; the installed Feature had Review updates. The QA app is
quit, with no production profile changes. This verifies the current cross-Space
journey; same-Space coexistence still awaits the mutation/placement work above.

## Progress: exact management targets

Desktop app controls now pass their exact installation through the renderer API
into grants, connections, automation controls, data reads/recovery, build context,
working-copy creation and removal. CLI `--app` accepts a unique manifest id or
exact Feature Installation id, and CLI/staged adapters preserve the resolved pin
through domain execution. Name-only ambiguity refuses with exact choices. OAuth
and manual automation rechecks retain the original resolved incarnation through
awaited work. Assistant tools use installation-specific names, with preview
labels, and complete-name hashing avoids collisions when long names truncate.

Verification: `npm run check`, `npm test` (1,114 passed; one Windows-only skip),
and `npm run desktop:prepare` pass. API tests remove/reinstall identical code and
exercise stale build/data/connection reads, grants/revocations, OAuth, invocation,
automation enable/disable/run, restore/clear and removal; replacement state stays
unchanged. A current pin still grants and reads successfully. Renderer tests
exercise all 22 management helper requests, and CLI/staged and Pi-tool tests
verify identity propagation. Logs: `/tmp/workfold-app-management-identity-check.log`,
`/tmp/workfold-app-management-identity-tests.log`, and
`/tmp/workfold-app-management-identity-desktop.log`.

The source-Space placement rules still need changing and integrated coexistence
tests before the first checklist item can close. The broader context, delegation,
fold/web, integration and release work remains active.

## Progress: source-Space preview and release coexistence

A Project’s Development preview and installed Release can now share its source
Space. Registry v6 preserves their separate Feature Installation identities,
data and authority; current work-fold v5 upgrades through the canonical writer,
while older unsupported formats stay untouched. A different Project cannot
reuse the same Feature id in that Space. Only a collocated preview receives the
short “Preview” rail suffix. Staged data clearing now carries the exact pin too.

Verification: `npm run check`, `npm test` (1,117 passed; one Windows-only skip),
and `npm run desktop:prepare` pass. Tests cover same-Space install, guarded change,
preview update, reviewed release update, restart, separate data, exact removal,
recreation, v5 upgrade and ambiguous CLI data-clearing refusal. Logs:
`/tmp/workfold-app-coexist-check.log`, `/tmp/workfold-app-coexist-tests.log`, and
`/tmp/workfold-app-coexist-desktop.log`.

Live QA installed the existing synthetic Release beside its preview in App
Recovery QA using App Studio. The preview retained its North quote; the Release
started empty. Change this app on that Release created an exact working copy
and unsent draft. A harness edit and CLI proposal, approved in Needs you, updated
only the preview to 1.0.4. Preparing/publishing the local fixture Release and
reviewing/activating its update changed the installed source-Space app while
preserving separate data. The second Space kept its original 1.0.3 app and empty
data. The walkthrough caught an obsolete remove-preview instruction, which was
removed. The isolated app is quit. This completes the Change this app slice;
real Assistant execution and the remaining full-goal work are still pending.
