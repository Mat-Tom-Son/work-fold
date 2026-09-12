import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const [capabilities, apps, chat, spaceApp, spaceChrome, viewport, styles, professionalShell, professionalSurfaces, desktopHost, desktopMain, desktopPreload, tooltipOverlay, restrictedAppPreload] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/panes/RestrictedAppsSection.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/App.tsx"),
  read("web-local/src/components/panes/spaceChrome.tsx"),
  read("web-local/src/components/panes/RestrictedAppViewport.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/professional-shell.css"),
  read("web-local/src/professional-surfaces.css"),
  read("desktop/src/restricted-app-host.ts"),
  read("desktop/src/main.ts"),
  read("desktop/src/preload.cts"),
  read("desktop/src/rail-tooltip-overlay.ts"),
  read("desktop/src/restricted-app-preload.cts"),
]);

test("Apps product hierarchy starts with the Assistant and keeps local preview loading advanced", () => {
  assert.match(apps, /Apps in this Space/);
  assert.match(apps, /Build with Assistant/);
  assert.match(apps, /<details className="restricted-app-advanced"><summary>Advanced local preview/);
  assert.match(apps, /Add local preview…/);
  assert.doesNotMatch(capabilities, /Sandboxed app extension|onAddRestrictedApp/);
  assert.doesNotMatch(apps, />Add app</);
});

test("adding an app states what it adds and that every declared power is on, with narrowing in Apps", () => {
  const decision = apps.indexOf("Adds now");
  const contribution = apps.indexOf("Added now");
  const access = apps.indexOf("What this app can do");
  assert.ok(decision >= 0 && contribution > decision && access > contribution);
  assert.match(apps, /<ReviewDeclarations review=\{review\} \/>[\s\S]*?<details className="restricted-app-package-details"><summary>Package details/);
  assert.match(apps, /"Add app"/);
  assert.match(apps, /"Update app"/);
  assert.match(apps, /every declared destination, folder, notification, and automation on/);
  assert.match(apps, /Turn any of them off in Apps/);
  assert.match(apps, /Unchanged connections, automation settings, and run history carry over/);
  assert.match(apps, /restricted-app-authority-list/);
  assert.match(apps, /On when added/);
  assert.doesNotMatch(apps, /Off when added|access off|approve|Reviewed|Unrestricted|staged/);
  assert.match(apps, /Starts a Chat in this Space/);
  // The reviewed viewer declaration (docs/fold-publishing.md, rung 3) is part
  // of review copy and the install decision: the group shows the viewer entry
  // and the complete viewer-readable surface, states that exposure is its own
  // later decision, and keeps the viewer read-only. The copy says "at your
  // address", never "host your website".
  assert.match(apps, /title="At your address"/);
  // Outward exposure is not included by an install, so this one group never
  // reads green-affirmative: the badge agrees with the sentence below it.
  assert.match(apps, /title="At your address"[\s\S]*?state=\{review\.manifest\.viewer \? "not-yet" : "included"\}/);
  assert.match(apps, /\{state === "on" \? "On when added" : state === "included" \? "Included" : "Not shared yet"\}/);
  // A single-file permission is not on when added, and a Check slot binds only
  // when the Space has exactly one Check, so neither claims "On when added".
  assert.match(apps, /state=\{review\.manifest\.permissions\.files\.some\(\(item\) => item\.target === "directory"\) \? "on" : "included"\}/);
  assert.match(apps, /title="Check results"[\s\S]*?state="included"/);
  assert.match(apps, /Serve \{review\.manifest\.viewer\.entry\} to anyone holding this app's link/);
  assert.match(apps, /viewer-readable \$\{review\.manifest\.viewer\.readable\.length === 1 \? "collection" : "collections"\} declared/);
  assert.match(apps, /Viewer-readable collections: \$\{review\.manifest\.viewer\.readable\.join\(", "\)\}/);
  assert.match(apps, /Viewers can read none of this app's stored data\./);
  assert.match(apps, /Putting this app at your address is its own later decision; viewers never write, act, or reach connections\./);
  assert.doesNotMatch(apps, /\bwebsite\b/i, "the word website never appears in app review copy");
  assert.match(apps, /<OAuthDeclarationDetails auth=\{auth\}/);
  assert.match(apps, /<dt>Issuer<\/dt>/);
  assert.match(apps, /<dt>Scopes<\/dt>/);
  assert.match(apps, /<dt>Discovery<\/dt>/);
  assert.match(apps, /<dt>Authorize at<\/dt>/);
  assert.match(apps, /<dt>Exchange at<\/dt>/);
  assert.match(apps, /<dt>Extra parameters<\/dt>/);
});

test("Assistant tools owns access, connection, and lifecycle management without credential-erasure jargon", () => {
  const access = apps.indexOf("Access & connections");
  const runtime = apps.indexOf("Package & runtime");
  const lifecycle = apps.indexOf("Lifecycle");
  assert.ok(access >= 0 && runtime > access && lifecycle > runtime);
  assert.match(apps, /Allow access/);
  assert.match(apps, /Revoke access/);
  assert.match(apps, /Replace connection/);
  assert.match(apps, /Disconnect/);
  assert.match(apps, /Space files/);
  assert.match(apps, /Automations/);
  assert.match(apps, /Local app data/);
  assert.match(apps, /App access overview/);
  assert.match(apps, /onEnabledChange=\{\(enabled\) => void changeAutomation\(automation, enabled\)\}/);
  assert.match(apps, /"Whole Space"/);
  assert.match(apps, /Limit to folder/);
  // Removing a preview takes its data with it, and F20 makes that recoverable:
  // the confirm and the toast both say so rather than implying finality.
  assert.match(apps, /moves app data to Recently deleted\./);
  assert.match(apps, /preview removed\. Its data is in Recently deleted\./);
  // An editable path needs a control that applies it, for a file as for a folder.
  assert.match(apps, /grant && rootChanged \?/);
  assert.match(apps, /"Change file"/);
  assert.match(apps, /Earlier revision/);
  assert.match(apps, /<h3 id="restricted-app-notifications-title">Notifications<\/h3>/);
  assert.doesNotMatch(apps, /Windows notifications|Windows notification settings/);
  assert.match(apps, /work-fold · \{app\.manifest\.title\} — \{permission\.title\}/);
  assert.match(apps, /Allow notifications/);
  assert.match(apps, /Revoke notifications/);
  assert.doesNotMatch(apps, /Delete credential|Credential saved|Credential needed/);
  assert.match(apps, /Provider compatibility \{status\.diagnostics\.length === 1 \? "note" : "notes"\}/);
});

test("automation confirmations render above the capability dialog that requested them", () => {
  const confirmationLayer = Number(styles.match(/\.confirm-dialog-backdrop\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const capabilityLayer = Number(professionalSurfaces.match(/\.capability-dialog-backdrop\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  assert.ok(Number.isFinite(confirmationLayer) && Number.isFinite(capabilityLayer));
  assert.ok(confirmationLayer > capabilityLayer, `confirmation layer ${confirmationLayer} must exceed capability layer ${capabilityLayer}`);
});

test("notification clicks target their exact Space and stopped native views remount", () => {
  assert.match(spaceApp, /desktop\.onOpenRequest/);
  assert.match(spaceApp, /resolveRestrictedAppOpenRequest\(request, spaces\)/);
  assert.match(spaceApp, /onSwitchSpace\(target\.space\)/);
  assert.match(spaceApp, /setActiveMode\(target\.mode\)/);
  assert.match(viewport, /event\.state === "stopped"/);
  assert.match(viewport, /mountIdRef\.current = crypto\.randomUUID\(\)/);
  assert.match(viewport, /setGeneration\(\(value\) => value \+ 1\)/);
  assert.match(viewport, /disposed \|\| mountId !== mountIdRef\.current/);
});

test("the Space menu occludes native restricted-app views from the first animation frame", () => {
  assert.match(spaceChrome, /data-native-view-occluder="true"/);
  assert.match(viewport, /const explicitOccluder = candidate\.dataset\.nativeViewOccluder === "true"/);
  assert.match(viewport, /\(!explicitOccluder && Number\(style\.opacity\) === 0\)/);
  assert.match(viewport, /style\.display === "none" \|\| style\.visibility === "hidden"/);
});

test("rail tooltips use a topmost native overlay without blanking restricted app views", () => {
  assert.doesNotMatch(viewport, /railTooltipOcclusionLeadMs|railTooltipTarget|data-rail-tooltip/);
  assert.match(spaceChrome, /useNativeRailTooltips\(railRef\)/);
  assert.match(spaceChrome, /window\.workFoldDesktop\?\.window\.railTooltip/);
  assert.match(desktopPreload, /work-fold:window:rail-tooltip-show/);
  assert.match(desktopMain, /railTooltipOverlay\?\.show\(value\)/);
  assert.match(desktopMain, /host\.restrictedAppHost\.layoutUi[\s\S]*?railTooltipOverlay\?\.raise\(\)/);
  assert.match(tooltipOverlay, /contentView\.addChildView\(this\.#view\)/);
  assert.match(professionalShell, /:root\[data-desktop="true"\][\s\S]*?\[data-rail-tooltip\]::after[\s\S]*?content:\s*none/);
});

test("contributed app canvases share built-in spacing and native rounded corners", () => {
  assert.match(professionalSurfaces, /\.space-mode-pane > \.restricted-app-view\s*\{[^}]*height:\s*auto;[^}]*margin:\s*12px;/s);
  assert.match(viewport, /resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)/);
  assert.match(viewport, /style=\{\{ borderRadius: cornerRadius \}\}/);
  assert.match(viewport, /rail\.right \+ restrictedAppRailGuard/);
  assert.match(viewport, /borderLeftWidth/);
  assert.match(desktopHost, /view\.setBorderRadius\(resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)\)/);
});

test("owning Chat shows the added-app receipt with a retry for failures and opens the installed interactive app", () => {
  assert.match(chat, /restricted_app_proposal/);
  assert.match(chat, /restricted_app_proposal_settled/);
  assert.match(chat, /data\.proposal\?\.spaceId === space\.id/);
  assert.match(chat, /data\.proposal\.conversationId === conversationId/);
  assert.match(chat, /settled\.status === "installed" \|\| settled\.status === "failed"/);
  assert.match(chat, /function RestrictedAppAddedNotice/);
  assert.match(chat, /Added \{title\} to this Space\./);
  assert.match(chat, /Still needs you:/);
  assert.match(chat, />Open app</);
  assert.match(chat, />Try again</);
  assert.doesNotMatch(chat, /installDisabled=\{running\}|closeLabel="Decline"|RestrictedAppReviewDialog/);
  assert.match(chat, /installRestrictedAppProposal\(space\.id, proposal\.conversationId, proposal\.id\)/);
  assert.match(spaceApp, /restrictedAppsState\.upsertApp\(app\)/);
  assert.match(spaceApp, /setActiveMode\(restrictedAppRailMode\(targetSpace\.id, app\.manifest\.id, app\.featureInstallationId\)\)/);
  assert.match(spaceApp, /<RestrictedAppViewport[^>]+app=\{activeRestrictedApp\} placement="navigator"/);
  assert.match(spaceApp, /tabs\.openRestrictedAppSurfaceTab/);
  assert.doesNotMatch(spaceApp, /surface\.execution === "restricted-app"/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("the worker bridge can request Assistant work while it holds an operation lease, within the raised envelope", () => {
  assert.match(desktopHost, /Assistant requests need an active app view or a running worker operation\./);
  assert.doesNotMatch(desktopHost, /Assistant requests require an active app view\./);
  // The envelope carries the JSON-escaping allowance over the published 64 KiB
  // input bound, so the service — not the transport — reports a limit hit.
  assert.match(desktopHost, /const maxAssistantEnvelopeBytes = restrictedAppAssistantEnvelopeBytes;/);
  assert.match(desktopHost, /jsonEnvelope\(value, maxAssistantEnvelopeBytes, "Assistant request"\)/);
  assert.match(restrictedAppPreload, /\{ operation: "request", request \}, maximumAssistantEnvelopeBytes/);
  assert.match(restrictedAppPreload, /nestedPositiveInteger\(limits, "assistant", "inputBytes", 64 \* 1024\) \* 6/);
  assert.match(desktopMain, /listChecks,/);
});

test("bounded inference reaches app views and workers over its own channel, and viewers never see it", async () => {
  const [smoke, piClient, viewer] = await Promise.all([
    read("scripts/restricted-app-electron-smoke.mjs"),
    read("src/local/agent/pi-client.ts"),
    read("src/local/agent/restricted-app-viewer.ts"),
  ]);
  // One channel, registered and removed with the others, admitted through the
  // same owned-power rule as an Assistant request.
  assert.match(desktopHost, /const assistantInferChannel = "work-fold:restricted-app:assistant-infer";/);
  assert.match(desktopHost, /ipcMain\.handle\(assistantInferChannel/);
  assert.match(desktopHost, /ipcMain\.removeHandler\(assistantInferChannel\);/);
  assert.match(desktopHost, /Inference needs an active app view or a running worker operation\./);
  assert.match(desktopHost, /"window" in instance \? "worker" : "view"/);
  assert.match(restrictedAppPreload, /infer: \(request: unknown\) => invokeHost\(assistantInferChannel, \{ request \}, maximumInferEnvelopeBytes, "INFER_UNAVAILABLE"\)/);
  assert.match(desktopMain, /assistantInference: async \(\) => \(await ensureInteractiveLocalApi\(\)\)\.appInference,/);

  // The smoke exercises both surfaces and the refusal an inactive view meets,
  // and its worker answer deliberately outlasts the invocation deadline.
  assert.match(smoke, /assistantInference: async \(\) => \(\{/);
  assert.match(smoke, /workerInferText: "echo:worker"/);
  assert.match(smoke, /inferDenied: true/);
  assert.match(smoke, /if \(surface === "worker"\) await new Promise\(\(resolve\) => setTimeout\(resolve, 6_000\)\);/);

  // Disclosure is after the fact, so the Apps tab is the reader: the journaled
  // receipts reach a surface, with the effective model and its usage.
  const receipts = await read("web-local/src/components/panes/RestrictedAppInferenceReceipts.tsx");
  const client = await read("web-local/src/lib/restricted-apps.ts");
  assert.match(client, /inference-receipts\?\$\{query\}/);
  assert.match(apps, /<RestrictedAppInferenceReceipts key=\{`infer:\$\{app\.featureInstallationId\}:\$\{app\.digest\}`\} app=\{app\}/);
  assert.match(receipts, /listRestrictedAppInferenceReceipts/);
  for (const field of [/receipt\.at/, /receipt\.surface/, /receipt\.inputBytes/, /receipt\.outputBytes/, /receipt\.model/, /receipt\.usage/, /receipt\.errorCode/]) {
    assert.match(receipts, field, "every disclosed receipt field reaches the reader");
  }

  // Viewers and the app-builder guide keep the boundary the record draws.
  assert.match(viewer, /Assistant actions are mutations executed with the person's runtime; they are not viewer-reachable\./);
  assert.doesNotMatch(viewer, /assistant\.infer|INFER_/);
  assert.match(piClient, /assistant\.infer\(\{ instructions, input, outputSchema\?, maxOutputBytes\? \}\)/);
  assert.match(piClient, /from an app view or a worker/);
  assert.match(piClient, /INFER_BUSY/);
  assert.match(piClient, /assistantActions \(up to 8|The optional top-level assistantActions array/);
  assert.match(piClient, /permissions\.checks declares Check-result slots/);
});

test("host-bridge wait time never counts against the worker invocation deadline", async () => {
  const inference = await read("src/shared/restricted-app-inference.ts");
  // A real model call is essentially never under the five-second invocation
  // deadline, and the published inference budget is two minutes. If the
  // deadline counted host-lane wait time, a worker awaiting `assistant.infer`
  // would have its renderer forcefully crashed and the action would fail with
  // APP_TIMEOUT — so the clock stops while a host call is in flight.
  assert.match(inference, /timeoutMs: 120_000,/);
  assert.match(desktopHost, /const defaultInvocationTimeoutMs = 5_000;/);
  assert.match(desktopHost, /hostCalls: \{ inFlight: number; idleSince: number \};/);
  assert.match(desktopHost, /async #throughHostLane<T>\(/);

  // Each lane a worker may hold runs through the gate.
  assert.match(desktopHost, /const response = await this\.#throughHostLane\(instance, \(\) => this\.#network\.request\(\{/);
  assert.match(desktopHost, /const result = await this\.#throughHostLane\(instance, async \(\) => \{/);
  assert.match(desktopHost, /this\.#throughHostLane\(instance, \(\) => service\.infer\(/);

  // Both worker invocation deadlines read the gate; a worker that simply hangs
  // with no host call in flight is still crashed on time.
  const gated = [...desktopHost.matchAll(/this\.#invocationTimeoutMs,\n\s+\(\) => this\.#crash\(instance, "Restricted app (action|automation) timed out\."\),\n\s+instance\.hostCalls,/g)];
  assert.equal(gated.length, 2, "the action and automation deadlines both suspend for host lanes");
  assert.match(desktopHost, /if \(gate\) gate\.inFlight \+= 1;/);
  assert.match(desktopHost, /const idleFor = gate\.inFlight > 0 \? 0 : Date\.now\(\) - gate\.idleSince;/);
});
