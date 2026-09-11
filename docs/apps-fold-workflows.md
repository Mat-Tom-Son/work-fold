# Apps and the fold: implementation plan

Status: complete and published in 0.4.23, with the production bridge deployed.
The repository is consolidated onto main. Historical progress entries preserve
what was pending at each stage; the final acceptance and publication records
supersede those earlier pending statements.

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
- [x] Fold results: bounded file/app previews and direct deliverable/review
  navigation from completed requests.
- [x] Web apps: responsive desktop-served views, clear offline/revoked states,
  and bounded actions from paired browsers that run on acceptance (the earlier
  review step was retired by [Receipts, not gates](receipts-not-gates.md)).
  Shared viewer links remain read-only, with no management or runtime-action
  authority.
- [x] Integration: concise UI, canonical docs and harness parity, automated
  adversarial coverage, real desktop/browser journey, clean commits and merge.

## Acceptance journey

The fold-results slice now includes bounded file previews, copied-file and
History-observed child-file links, exact installed-app links, and pending review
navigation. App links disclose a newer revision of the same installation and
refuse removed/reinstalled substitutes. These links follow the current bounded
request trail, not a new persistent request archive. The completed feature
slices still need the combined paired acceptance below.

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

### Browser review controls and private action SDK

The browser-action UI is now connected. An app with declared worker actions
gets a separate frozen request/status/cancel SDK. Review and Run remain in the
trusted parent outside the frame; forged approval messages are rejected.
Compact controls show exact inputs, running/stopped/failed outcomes and bounded
results. Reopening recovers receipts, and an uncertain response never triggers
automatic replay. The app title, Space and version remain visible above the
view, with only a short review reminder below it.

Live Chromium testing caught an opaque-context incompatibility: the child can
lack `crypto.randomUUID`. The SDK now supplies `createRequest` using
`getRandomValues`, preserving a stable UUID and input copy for retry. The
reusable `scripts/probes/browser-app-actions.probe.js` passed exact review,
forged-approval denial, one outcome on repeated submission, recovered receipts,
320×568 layout containment and focus restoration. The read-isolation probe
still passed all parent/storage/network/navigation denials. The phone screenshot
is `output/playwright/browser-app-actions-phone.png`. This is a real browser
running inert fixture actions, not paired desktop execution or a live model.

Final checks passed: `npm run check`, `npm test` (1,164 passed, one Windows-only
skip), the bridge suite (48 passed), and `npm run desktop:prepare` with both
Electron probes. Logs are `/tmp/workfold-browser-actions-ui-final-check.log`,
`/tmp/workfold-browser-actions-ui-final-tests.log`,
`/tmp/workfold-browser-actions-ui-bridge-tests.log`,
`/tmp/workfold-browser-actions-ui-final-desktop.log`,
`/tmp/workfold-browser-actions-live.log` and
`/tmp/workfold-browser-actions-read-isolation.log`.
Domain coverage also verifies that obsolete app authority cannot hold the new
revision's pending-request budget; grant revocation updates pending receipts
together and settles matching active work. The temporary browser and QA bridge
are closed. Deliverable/app links, paired live acceptance, final integration and
the authorized merge/release remain open.

## Progress: observed deliverables and installed-app results

Terminal Space turns now retain bounded metadata for changes between their
full pre/post History checkpoints. The current fold request rechecks file
visibility before presenting links; another browser's aggregate summary has
no paths or app references. App installation links derive from executed review
evidence or completed activation and keep the exact installation identity.
Testing found and repaired missing preview-install lineage in the request trail.

Verification passed: `npm run check`, `npm test` (1,169 passed, one Windows-only
skip), the bridge suite (48 passed), and `npm run desktop:prepare` with both
Electron probes. Logs: `/tmp/workfold-result-links-final-check.log`,
`/tmp/workfold-result-links-complete-tests.log`,
`/tmp/workfold-result-links-bridge-tests.log`, and
`/tmp/workfold-result-links-desktop.log`. The full run also exposed a flaky
palette assertion: a random temporary folder could legitimately fuzzy-match
Checks. The assertion now verifies the intended first result.

The actual Chromium fixture probe `scripts/probes/fold-result-links.probe.js`
passed cross-Space deliverable navigation, exact app-result opening, disclosure
of its updated revision, nested-frame quote reads, consumed-review removal,
390×844 containment and focus restoration. Both screenshots were visually
inspected: `output/playwright/fold-deliverable-link-phone.png` and
`output/playwright/fold-app-result-link-phone.png`. This is inert fixture UI
acceptance; paired desktop execution and a successful real-model journey remain
required. No release, production profile, installation or deployment changed.

## Progress: paired desktop/browser acceptance and recovery

A Developer ID-signed, notarized and Gatekeeper-verified app-only candidate from
`c1270c2` (still package version 0.4.22, not a new publication) now exists at
`out/mac-rc/mac-arm64/work-fold.app`. Signing evidence is in
`/tmp/workfold-apps-integration-rc.log`. The Applications installation is unchanged.
The candidate briefly opened the normal profile during computer-use selection;
the paired walkthrough then used the explicit `/tmp/workfold-apps-goal-qa`
profile and a loopback pg-mem bridge with synthetic data only.

The actual browser and desktop matched their pairing code. Browser Needs you
approved the synthetic Quote board QA preview through the encrypted lane.
A browser request remained pending until trusted Review/Run, then the native
worker stored exactly one ten-unit, $420 order. Retrying the same request
returned the same succeeded receipt and left sequence 1 unchanged. The native
rail app read that same value. Normal desktop quit cleared the browser frame;
restart required Refresh and recovered both the completed receipt and sequence
1 without replay. The 390×844 screenshot
`output/playwright/paired-native-order-phone.png` was visually inspected.

This walkthrough found and repaired missing loopback account selection on API
and event requests, an invalid desktop loopback Open address URL, and a 401
session-reboot loop. The client now clears the expired session before recovery
and returns to sign-in when the session probe is unauthorized. Background
refresh and dispatch recovery pause while the desktop is known offline;
already-accepted receipt reads remain available through the relay's bounded
cache. Reconnection removes the specific stale offline banner.

Live probes: `/tmp/workfold-paired-session-recovery.log` shows one pairing
failure, one session probe and a return to sign-in; and
`/tmp/workfold-paired-offline-final.log` shows no new or recovered dispatches
in a twelve-second offline window, with no remaining app frame. The fixture
is `/tmp/workfold-integrated-quote-board`, digest
`be12776463493a907febd3034b6613965e1adaa704b4c8892fe309fbdc8fcfb3`.
The paired action receipt is `f499efa0-0a32-4681-bab7-6f3b6f8115a9` and its
request is `61ad052c-fe80-44f6-b135-15b6bbce0b82`. The counter is app-owned data,
not a real order. Reusable probes live under `scripts/probes/paired-*` and
`scripts/probes/browser-session-recovery.probe.js`.

The isolated profile's connected-model list is empty. Successful real-model
acceptance is now using the signed candidate's normal profile and existing
OpenRouter connection, through native product APIs; no credentials were copied
or extracted. A fresh fold request is setting up Purchasing QA and Delivery QA
for the remaining app-requested comparison, Check and cross-Space handoff.
No public build, updater installation or Railway deployment has occurred.

Verification for the recovery changes: `npm run check`, `npm test` (1,171
passed, one Windows-only skip), bridge tests (48 passed), and
`npm run desktop:prepare` with both Electron probes passed. Logs:
`/tmp/workfold-paired-recovery-check.log`,
`/tmp/workfold-paired-recovery-complete-tests.log`,
`/tmp/workfold-paired-recovery-bridge-tests.log`, and
`/tmp/workfold-paired-recovery-desktop.log`. `npm audit --audit-level=high`
reported zero vulnerabilities. Shared harness parity remains intact: root
CLAUDE.md imports AGENTS.md and its release Skill is the tracked symlink.

## Progress: live model result and Space-menu refresh

The normal-profile fold created Purchasing QA (`space-b8ef1281f2cf23f2`) and
Delivery QA (`space-62c210407b6b3754`) using ordinary CLI operations. Its existing
Unrestricted setting executed the exact test-app installation immediately;
the setting was preserved, and the isolated profile separately proved Reviewed
installation. The app-requested comparison still required its explicit native
Review/Run action. Open Chat dismissed the details dialog correctly. The real
Space model wrote only `comparison.md`, selected North at $420/four days, and
returned its successful reply through the app bridge. Retrying returned the
same task. Durable evidence contains one accepted turn
`turn-dadbbf58-c0a1-4ae0-bdd5-8f34b7a8ccf3` and checkpoints
`cp-20260907074830-764fd162` / `cp-20260907074839-3e22d1ea`; the file digest is
`b9528c39671eb8b24f787adcddd8ca9bf15557e6a004624e9364bb81889993c9`.

The walkthrough also caught a stale desktop Space menu after fold-created
Spaces. The canonical create/register/rename/removal paths now emit the
existing content-free control stream's `spaces` hint. The shell refreshes
bootstrap on that hint and reconnect reset, preserving an existing selection.
Tests cover act creation, rename, registration, removal with original folder
bytes preserved, and the shared visible-window subscriber. `npm run check`,
`npm test` (1,172 passed, one Windows-only skip), and `npm run desktop:prepare`
with both Electron probes passed. Logs: `/tmp/workfold-space-refresh-check.log`,
`/tmp/workfold-space-refresh-tests.log`, and
`/tmp/workfold-space-refresh-desktop.log`. The updated candidate still needs
live menu verification; the existing signed candidate predates this fix.
The real fold is now exercising a model Check failure/repair and a bounded
Delivery QA handoff in task `turn-3f2b8e48-e3cf-417c-9941-2879393e0cbd`.


## Progress: real-model Check and cross-Space handoff

The actual fold request `turn-3f2b8e48-e3cf-417c-9941-2879393e0cbd`
completed with three attributed Space child tasks. Purchasing QA deliberately
changed North's table entry to nine days, then repaired it through its own
Assistant. Check `check-d142c216-1739-4753-a0df-d0d838558cc0`, declaration
digest `8a77fd8ce8944eb49533d63c7dd0877852c4fc726c24a94332fd929f9c9dfb94`,
recorded baseline clear, a malformed-provider failure, detected discrepancies,
and repaired current-clear. The stored records were independently inspected:
`check-run-35725a8c-9502-4f72-a866-951adf22708c` failed on a missing title;
`check-run-d6bd1857-d1c6-4536-889b-1ea5578149e8` admitted three quotations;
`check-run-b04efd35-719b-4a01-8c71-ff84237196cc` succeeded with no findings.
The quote reference retained the same digest throughout. No automatic provider
retry occurred; the fold explicitly requested the retry.

The model also made an unnecessary synthetic-label complaint despite quoting
an already synthetic heading. This is evidence of fallible model judgment,
not three independently correct findings. The review guidance now checks
semantic satisfaction, rejects invented stricter wording requirements, and
asks the model to cross-check its claim against its own quote. The changed
sensor digest requires explicit re-enablement; no existing authority is silently
carried forward. Missing-title coverage verifies failure without partial admission.

The fold copied the repaired `comparison.md` through `files add` into Delivery
QA, then its Assistant wrote `delivery-plan.md`: North, ten units, $420, four
days within the five-day deadline, explicitly synthetic with no order placed.
The management request's child-file links name both actual History-observed
outputs. Native UI separately selected only `quotes.md` and Delivery readiness
for the app. The app read the exact 321-byte file and returned current-clear,
no findings, through its Check bridge. Grant changes intentionally replace app
authority; old task receipts remain in ordinary Chat/history and do not become
readable through the new app authority.

Type checks and the complete suite passed after the guidance change (1,173
passed, one Windows-only skip): `/tmp/workfold-review-precision-check.log` and
`/tmp/workfold-review-precision-tests.log`. Updated signed-candidate menu and
model checks are the remaining live verification before release preparation.


## Final integration acceptance

The updated signed/notarized candidate passed a live external rename while the
Space menu remained open, and immediately displayed the restored name too.
Type checks, clean npm installation, 1,173 passing tests (one Windows-only skip),
and all 48 bridge tests passed. The final bridge rerun caught and corrected an
old source assertion that omitted the intentional offline refresh guard. Logs:
`/tmp/workfold-release-final-check.log`, `/tmp/workfold-release-final-tests.log`,
`/tmp/workfold-release-final-bridge-tests.log`, and
`/tmp/workfold-final-integration-rc.log`. Audit reported zero vulnerabilities.

The final real-model request `turn-96c75e32-d958-4167-8a55-75366893403d`
verified old sensor authority was blocked, explicitly re-enabled the named QA
Check, and obtained baseline clear. Its two defect-review attempts failed on
missing model titles (`check-run-ccb95201-0167-4b57-8d33-b882cfed664e` and
`check-run-b8c1c330-3b0e-4f33-b282-9bde4e89c998`). No findings were admitted;
the app displayed Check error. The host schema and native provider adapter
retain the required title field. These are observed provider-format failures,
not proof of improved detection precision. The document was restored to its
exact initial digest `37bef76fd9e490581797e589b728154f5c4cb685aea733cbf254277cc841cde2`,
and final run `check-run-8e762016-6713-4e90-912e-fbf58cb5717f` was current-clear,
also verified from the app's selected-Check bridge. No automatic retry or model
setting change was introduced. Model findings and availability remain fallible.

The actual Delivery QA comparison and plan were then explicitly copied into the
isolated paired profile through `files add`, with a restore point. The approved
390×844 browser opened the real comparison, showing its full table and selected
North recommendation. Screenshot `output/playwright/paired-real-comparison-phone.png`
was visually inspected. This proves actual encrypted desktop file preview;
request-to-file link behavior is separately covered by the native request's
observed-file records and the inert browser link probe. We did not pair the
normal profile or copy its credentials into the test profile.

All implementation slices and their automated/native/browser acceptance are
complete. The existing Applications bundle is unchanged. Both candidate runs
were quit; normal-profile Purchasing QA and Delivery QA remain as synthetic
examples. The Check is clear, no routing/schedule or real order was created,
and existing non-QA Spaces and root authority were preserved.


## Publication and handoff

Release `v0.4.23` published September 7 at 08:28 UTC from
`da0bb6cd5b3eceeb6957f75cdd46b2c7103b73f8`, after exact main/tag CI, Developer ID
signing, hardened-runtime verification, app and DMG notarization/stapling,
Gatekeeper acceptance, strict artifact verification and eight matching remote
asset digests. Distribution timings: preparation 29 seconds, app packaging and
notarization 4m 11s, DMG finalization 2m 11s, strict verification 5 seconds.
The saved release status was compatible with no remaining stages before the
post-publication documentation commit. Logs: `/tmp/workfold-0423-distribution.log`,
`/tmp/workfold-0423-publication.log`, `/tmp/workfold-0423-release-status.json`.

Railway deployment `73e8aa12-5467-404e-ad8c-6170a2323a85` is successful; public
health and exact browser-source bytes were verified. The local paired browser
and loopback bridge were closed. All feature branches were verified merged and
removed, leaving main locally and on the active source remote. The installed
`/Applications/work-fold.app` remains 0.4.22 and its protected newer-data startup
flow visibly offers 0.4.23 with **Download and Install**. That final installation
click belongs to the user. See [the release record](releases/README.md).
