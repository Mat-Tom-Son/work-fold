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
- [x] Space context: retain explicit file grants; add selected Check results
  and app-owned task progress through narrow, declared host capabilities.
- [x] Assistant actions: reviewed bounded intents, person-authorized dispatch
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

The fold-results slice now includes approved-browser file previews and direct
copied-file/review receipt links, plus private reviewed app views. App-result
links and links for Assistant-created deliverables beyond recorded file-copy
actions remain open; this does not close
the fold-results or web-app checklist items.

Assistant request implementation now uses the ordinary Space Chat path with
exact review pins, task progress, cancellation and restart reconciliation.
The native bridge and compact Apps review are implemented; live acceptance is
still pending. Automated coverage includes a real Pi tool loop against a
simulated provider that writes a deliverable, captures History, returns a
bounded result, deduplicates an approval after restart and stops a second task.
This simulated provider is not the required live model acceptance journey.

Live desktop QA has since verified inert submission, the exact review and Run
surface, honest setup failure, Open Chat, same-request retry and restart using
the `Assistant Requests QA` fixture in the existing isolated profile. No live
provider call succeeded: that profile has no provider connection (Settings →
Assistant showed OpenRouter disconnected). A successful real-model task and the
combined Purchasing/Delivery/web journey remain required before release.

The walkthrough found and fixed a retained-dialog navigation lock: opening an
Assistant task Chat hid its Apps tab without dismissing its modal. The callback
now closes the details dialog; a real DOM regression test keeps the inactive
Apps tab mounted and verifies that shell navigation regains focus and loses
background isolation. Live retesting confirmed the fix. The production app and
its provider settings were untouched.

Verification for this slice: `npm run check`, `npm test` (1,136 passed; one
Windows-only skip), and `npm run desktop:prepare` including both real Electron
probes passed. Logs: `/tmp/workfold-app-assistant-complete-check.log`,
`/tmp/workfold-app-assistant-complete-tests.log`, and
`/tmp/workfold-app-assistant-complete-desktop.log`. The separate live logs are
`/tmp/workfold-app-assistant-live.log` and
`/tmp/workfold-app-assistant-live-reopen.log`. The checked implementation slices
do not close the remaining full integration and release acceptance below.

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

## Progress: selected Check results and native errors

Apps can declare up to eight named Check-result choices. The Apps access dialog
maps each to one exact Check id/digest from the owning Space, with a short
confirmation describing the content shared. Default-off grants are installation
bound, advance grant authority, reset with changed app bytes, and participate
in reviewed exact-revision Release continuity. The runtime broker accepts only
a permission id from an active visible app view, derives identity from its
sender, and fences the response after awaited re-verification. Workers,
automations and shared viewers cannot read this surface.

The existing Check service now provides a selected projection that re-verifies
only that Check’s targets. It distinguishes blocked, never-run, running, stale,
error, clear and attention, with no findings in stale/unhealthy states. It never
runs a sensor, enables the Check or sends content to a model. Results exclude
other Checks, transcripts, raw run/provider records and correction authority.
They are bounded to 64 findings and 256 KiB with explicit truncation.

Native testing found that Electron stripped custom `Error.code` values across
the context bridge. The preload now transfers plain outcomes through captured
functions and reconstructs Errors in the app world, without installing a raw
transport API. Real Electron coverage verifies stable Check and network denial
codes, active UI reads, undeclared-slot refusal, inactive-view and worker denial.

Verification: `npm run check`, `npm test` (1,123 passed; one Windows-only skip)
and `npm run desktop:prepare` pass. Focused tests cover exact selections,
cross-Space/mismatched identity refusal, no model-on-read, changed reference
invalidations, update/reset/restart/revoke, API composition and authenticated
renderer pins. Logs: `/tmp/workfold-app-check-access-final-check.log`,
`/tmp/workfold-app-check-access-tests.log`,
`/tmp/workfold-app-check-access-final-desktop.log`.

Live QA installed the synthetic Check Results QA app in the existing isolated
profile. A desktop-selected file-presence Check showed denied access first,
blocked before enablement, never-run after explicit CLI enablement, attention
after a missing-file run, stale with findings removed after a harness file edit,
and clear only after an explicit rerun. Desktop revocation destroyed the old
view and later reads returned CHECK_DENIED. The picker named the chosen Check;
the walkthrough also prompted adding Check results to the compact access counts.
The test app is quit. No real model turn occurred in this deterministic fixture.
The context checklist remains open for app-owned task progress; bounded Assistant
delegation, fold/browser results, approved web actions, full integration and
release remain pending.

Final Check-access retest: restart preserved revocation and the live app returned
CHECK_DENIED. The access summary now includes Check results (0/1 in that test).
Same-selection grant retries revalidate the Check and preserve authority without
restarting the view; focused service/API tests pass. Final logs:
`/tmp/workfold-app-check-access-final-tests.log` (1,123 passed, one skip),
`/tmp/workfold-app-check-idempotence.log` (seven passed),
`/tmp/workfold-app-check-access-complete-check.log`, and
`/tmp/workfold-app-check-access-complete-desktop.log`.

## Progress: browser file previews and receipt links

Files now open a compact text/image dialog in approved browsers. Reads use an
explicit Space id and visible relative path, bounded bytes, no-follow identity
checks and post-read registration/visibility checks. Markdown remains inert;
HTML/SVG remain escaped text. Browser revocation fences late responses and their
replay-cache insertion. Shared viewers cannot reach the operation or preview
module. Disconnect clears the displayed bytes; reconnect requires Refresh.
See [file previews](fold-file-previews.md) for the complete read contract.

Copied-file receipts open their exact Space/path and staged decision receipts
open and focus the corresponding Needs you card. Concurrent decision refreshes
share their completion, so navigation cannot mistake an unfinished refresh for
a removed decision. Missing decisions and failed refreshes have distinct states.

Verification: `npm run check`, `npm test` (1,142 passed, one Windows-only skip),
the bridge's separate suite (48 passed), and `npm run desktop:prepare` including
both Electron probes passed. A final focused run passed 38 tests after adding
unsupported-desktop, wrong-file and failed-read UI cases and navigation fixtures.
Logs: `/tmp/workfold-file-previews-check.log`,
`/tmp/workfold-file-previews-tests.log`,
`/tmp/workfold-file-previews-bridge-tests.log`,
`/tmp/workfold-file-previews-desktop.log` and
`/tmp/workfold-file-previews-final-focus.log`.

Live browser QA used the real local bridge with inert fixture data. At 320×568,
long content scrolled inside a 304×552 dialog while Close and Refresh stayed
visible; Escape returned focus to the file button. At desktop width, the file
receipt opened the named preview and Review decision focused the exact card.
The browser reported no console warnings/errors. This verifies the actual UI,
not a paired real-desktop or real-model journey; those remain required. No
production application, provider state, bridge deployment or release changed.

## Progress: private reviewed app views

The browser's Spaces screen now lists installed apps and opens their reviewed
web entry privately, without creating a share link or requiring a Development
preview to publish a Release. The app receives only packaged-asset and selected
instance-data reads. Exact installation/revision/authority pins are rechecked
after queued mutations; browser revocation fences late transport completion.
Shared viewers keep their separate publication adapter and read-only vocabulary.
See [browser app views](fold-browser-apps.md) for the implementation contract.

The management page embeds a static intermediary and a separate app child,
both with opaque origins. The intermediary denies direct network traffic and
non-blob child navigation; the management page keeps its existing strict script
policy. The host waits for document readiness before revealing app controls,
clears frames on close/disconnection, refuses late results, checks current
authority while visible and requires Refresh after changes. Unsupported frame
loading produces a bounded failure state. Testing also fixed the Files tree's
inline depth style, which the management CSP correctly refused; it now uses a
host-applied CSS property after rendering.

Verification: `npm run check`, `npm test` (1,148 passed, one Windows-only skip),
the bridge suite (48 passed), and `npm run desktop:prepare` with both Electron
probes passed. Additional final tests cover queued data-authority changes and
the visible view's health refresh (four focused tests passed). Logs:
`/tmp/workfold-browser-app-complete-check.log`,
`/tmp/workfold-browser-app-complete-tests.log`,
`/tmp/workfold-browser-app-bridge-tests.log`,
`/tmp/workfold-browser-app-desktop.log` and
`/tmp/workfold-browser-app-final-focus.log`.

The live Chromium fixture read a quote through the actual frame broker, denied
parent/management DOM, cookie and browser-storage access, denied direct fetch,
and blocked an attempt to navigate out of the app. The reusable Playwright CLI
probe is `scripts/probes/browser-app.probe.js`; its successful output is in
`/tmp/workfold-browser-app-live-isolation.log`. A 320×568 walkthrough kept the
app inside a 304×552 dialog with no horizontal overflow and restored focus on
Escape; screenshot: `output/playwright/browser-app-phone.png`. The Codex in-app
browser could not load the nested blob document; computer use verified the
new honest fallback there, while the standalone Chromium journey passed.

This is live UI verification with inert fixture data, plus local-service and
encrypted-transport tests. A paired real desktop/browser session and the real
model multi-Space journey remain required. Browser actions, app result links
and broader Assistant deliverable navigation remain open. Nothing has been
deployed or publicly released, and the production app/profile is unchanged.

### Browser action foundation

The separate private browser-action service now stages declared worker inputs,
pins browser/grant and complete installed execution provenance, requires exact
review, journals acceptance before dispatch and returns the same receipt on
retry. It reconciles uncertain accepted work to Interrupted without replay.
Inputs/results, pending requests, active workers and journal capacity are
bounded. The closed encrypted adapter exposes request/get/list/review/approve/
cancel; it requires a live host-only grant fence. Native workers recheck that
fence at every broker effect boundary. Stop also fences approval races, and
revocation cancels only matching browser requests. Shared viewers remain
unchanged. The trusted browser review controls and private SDK are the next
integration step; this is not the completed browser-action feature.

Verification: `npm run check`, `npm test` (1,160 passed, one Windows-only skip),
the bridge suite (48 passed), and final `npm run desktop:prepare` passed. The
focused domain/API/transport run passed 52 tests; eleven final domain tests
also cover the machine-wide active-action limit. Logs:
`/tmp/workfold-browser-actions-check.log`,
`/tmp/workfold-browser-actions-full-tests.log`,
`/tmp/workfold-browser-actions-bridge-tests.log`,
`/tmp/workfold-browser-actions-desktop-final.log`,
`/tmp/workfold-browser-actions-focused.log` and
`/tmp/workfold-browser-actions-final-focus.log`.
The real Electron probe verifies revocation during a delayed network effect,
explicit abort, no subsequent storage write, sibling-installation isolation,
completed-action listener cleanup and ordinary worker recovery. No production
profile, publication, release version or deployment changed.
