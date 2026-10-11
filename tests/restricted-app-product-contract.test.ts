import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const [capabilities, apps, chat, workFolderApp, workFolderChrome, viewport, styles, professionalShell, professionalSurfaces, desktopHost, desktopMain, desktopPreload, tooltipOverlay, restrictedAppPreload] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/panes/RestrictedAppsSection.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/App.tsx"),
  read("web-local/src/components/panes/workFolderChrome.tsx"),
  read("web-local/src/components/panes/RestrictedAppViewport.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/styles.css"),
  read("web-local/src/styles.css"),
  read("desktop/src/restricted-app-host.ts"),
  read("desktop/src/main.ts"),
  read("desktop/src/preload.cts"),
  read("desktop/src/rail-tooltip-overlay.ts"),
  read("desktop/src/restricted-app-preload.cts"),
]);

test("Apps product hierarchy starts with the agent; Settings → Apps has no manual add path", () => {
  // A local preview arrives from a Worker's proposal in its Chat or from
  // `work-fold apps install-preview`. Settings → Apps lists and manages apps;
  // the retired "section" presentation (its own heading, an App Studio button,
  // and an "Advanced Local Preview" path-entry dialog) is gone, along with the
  // routes only it called.
  assert.doesNotMatch(apps, /Apps in This work-folder|Advanced Local Preview|Add Local Preview|presentation-\$\{|presentation\?: "section"/);
  assert.doesNotMatch(apps, /inspectRestrictedApp|installRestrictedApp|RestrictedAppReviewDialog|RestrictedAppSourceDialog/);
  // Building an app is a plain ask in a Chat; there is no button for it (2026-09-25).
  assert.doesNotMatch(apps, /Build with worker|onBuildApp/);
  assert.doesNotMatch(capabilities, /Sandboxed app extension|onAddRestrictedApp/);
  assert.doesNotMatch(apps, />Add app</);
  assert.doesNotMatch(apps, /\bwebsite\b/i, "the word website never appears in app copy");
});

test("app details show each destination's OAuth request in full", () => {
  assert.match(apps, /<OAuthDeclarationDetails auth=\{oauth\} \/>/);
  assert.match(apps, /<dt>Issuer<\/dt>/);
  assert.match(apps, /<dt>Scopes<\/dt>/);
  assert.match(apps, /<dt>Discovery<\/dt>/);
  assert.match(apps, /<dt>Authorize at<\/dt>/);
  assert.match(apps, /<dt>Exchange at<\/dt>/);
  assert.match(apps, /<dt>Extra parameters<\/dt>/);
});

test("Skills & Extensions owns access, connection, and lifecycle management without credential-erasure jargon", () => {
  const access = apps.indexOf("Access & Connections");
  const runtime = apps.indexOf("Package & Runtime");
  const lifecycle = apps.indexOf("Lifecycle");
  assert.ok(access >= 0 && runtime > access && lifecycle > runtime);
  assert.match(apps, /Allow access/);
  assert.match(apps, /Revoke access/);
  assert.match(apps, /Replace connection/);
  assert.match(apps, /Disconnect/);
  assert.match(apps, /work-folder files/);
  assert.match(apps, /Automations/);
  assert.match(apps, /Local app data/);
  assert.match(apps, /App access overview/);
  assert.match(apps, /onEnabledChange=\{\(enabled\) => void changeAppAutomation\(automation, enabled\)\}/);
  assert.match(apps, /"Whole work-folder"/);
  assert.match(apps, /Limit to folder/);
  // Removing a preview takes its data with it, and F20 makes that recoverable:
  // the confirm and the toast both say so rather than implying finality.
  assert.match(apps, /moves app data to Recently Deleted\./);
  assert.match(apps, /preview removed\. Its data is in Recently Deleted\./);
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

test("notification clicks target their exact work-folder and stopped native views remount", () => {
  assert.match(workFolderApp, /desktop\.onOpenRequest/);
  assert.match(workFolderApp, /resolveRestrictedAppOpenRequest\(request, workFolders\)/);
  assert.match(workFolderApp, /onSwitchWorkFolder\(target\.workFolder\)/);
  assert.match(workFolderApp, /setActiveMode\(target\.mode\)/);
  assert.match(viewport, /event\.state === "stopped"/);
  assert.match(viewport, /mountIdRef\.current = crypto\.randomUUID\(\)/);
  assert.match(viewport, /setGeneration\(\(value\) => value \+ 1\)/);
  assert.match(viewport, /disposed \|\| mountId !== mountIdRef\.current/);
});

test("the work-folder menu occludes native restricted-app views from the first animation frame", () => {
  assert.match(workFolderChrome, /data-native-view-occluder="true"/);
  assert.match(viewport, /const explicitOccluder = candidate\.dataset\.nativeViewOccluder === "true"/);
  assert.match(viewport, /\(!explicitOccluder && Number\(style\.opacity\) === 0\)/);
  assert.match(viewport, /style\.display === "none" \|\| style\.visibility === "hidden"/);
});

test("rail controls omit hover tooltips without blanking restricted app views", () => {
  assert.doesNotMatch(viewport, /railTooltipOcclusionLeadMs|railTooltipTarget|data-rail-tooltip/);
  assert.doesNotMatch(workFolderChrome, /useNativeRailTooltips|data-rail-tooltip/);
  assert.match(workFolderChrome, /aria-label=\{item\.ariaLabel\}/);
});

test("contributed app canvases share built-in spacing and native rounded corners", () => {
  assert.match(professionalSurfaces, /\.work-folder-mode-pane > \.restricted-app-view\s*\{[^}]*height:\s*auto;[^}]*margin:\s*12px;/s);
  assert.match(viewport, /resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)/);
  assert.match(viewport, /style=\{\{ borderRadius: cornerRadius \}\}/);
  assert.match(viewport, /rail\.right \+ restrictedAppRailGuard/);
  assert.match(viewport, /borderLeftWidth/);
  assert.match(desktopHost, /view\.setBorderRadius\(resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)\)/);
});

test("owning Chat shows the added-app receipt with a retry for failures and opens the installed interactive app", () => {
  assert.match(chat, /restricted_app_proposal/);
  assert.match(chat, /restricted_app_proposal_settled/);
  assert.match(chat, /data\.proposal\?\.workFolderId === workFolder\.id/);
  assert.match(chat, /data\.proposal\.conversationId === conversationId/);
  assert.match(chat, /settled\.status === "installed" \|\| settled\.status === "failed"/);
  assert.match(chat, /function RestrictedAppAddedNotice/);
  assert.match(chat, /Added \{title\} to this work-folder\./);
  assert.match(chat, /Still needs you:/);
  assert.match(chat, />Open App</);
  assert.match(chat, />Try Again</);
  assert.doesNotMatch(chat, /installDisabled=\{running\}|closeLabel="Decline"|RestrictedAppReviewDialog/);
  assert.match(chat, /installRestrictedAppProposal\(workFolder\.id, proposal\.conversationId, proposal\.id\)/);
  assert.match(workFolderApp, /restrictedAppsState\.upsertApp\(app\)/);
  assert.match(workFolderApp, /setActiveMode\(restrictedAppRailMode\(targetWorkFolder\.id, app\.manifest\.id, app\.featureInstallationId\)\)/);
  assert.match(workFolderApp, /<RestrictedAppViewport[^>]+app=\{activeRestrictedApp\} placement="navigator"/);
  assert.match(workFolderApp, /tabs\.openRestrictedAppSurfaceTab/);
  assert.doesNotMatch(workFolderApp, /surface\.execution === "restricted-app"/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("the worker bridge can request agent work while it holds an operation lease, within the raised envelope", () => {
  assert.match(desktopHost, /Worker requests need an active app view or a running worker operation\./);
  assert.doesNotMatch(desktopHost, /Worker requests require an active app view\./);
  // The envelope carries the JSON-escaping allowance over the published 4 MiB
  // input bound, so the service — not the transport — reports a limit hit.
  assert.match(desktopHost, /const maxAssistantEnvelopeBytes = restrictedAppAssistantEnvelopeBytes;/);
  assert.match(desktopHost, /jsonEnvelope\(value, maxAssistantEnvelopeBytes, "Worker request"\)/);
  assert.match(restrictedAppPreload, /\{ operation: "request", request \}, maximumAssistantEnvelopeBytes/);
  assert.match(restrictedAppPreload, /nestedPositiveInteger\(limits, "assistant", "inputBytes", 4 \* 1024 \* 1024\) \* 6/);
  assert.match(desktopMain, /listChecks,/);
});

test("bounded inference reaches app views and workers over its own channel, and viewers never see it", async () => {
  const [smoke, piClient, viewer] = await Promise.all([
    read("scripts/restricted-app-electron-smoke.mjs"),
    read("src/local/agent/pi-client.ts"),
    read("src/local/agent/restricted-app-viewer.ts"),
  ]);
  // One channel, registered and removed with the others, admitted through the
  // same owned-power rule as an Worker request.
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

  // Disclosure is after the fact, so Settings → Apps is the reader: the journaled
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
  assert.match(viewer, /Worker actions are mutations executed with the person's runtime; they are not viewer-reachable\./);
  assert.doesNotMatch(viewer, /assistant\.infer|INFER_/);
  assert.match(piClient, /assistant\.infer\(\{ instructions, input, outputSchema\?, maxOutputBytes\? \}\)/);
  assert.match(piClient, /from an app view or from the app's worker module/);
  assert.match(piClient, /INFER_BUSY/);
  assert.match(piClient, /assistantActions \(up to 8|The optional top-level assistantActions array/);
  assert.match(piClient, /permissions\.checks declares Check-result slots/);
});

test("host-bridge wait time never counts against the worker invocation deadline", async () => {
  const inference = await read("src/shared/restricted-app-inference.ts");
  // The invocation deadline is a ten-minute hang guard, not a compute budget,
  // and inference has no fixed wall-clock budget at all. If the deadline
  // counted host-lane wait time, a worker awaiting a long `assistant.infer`
  // would have its renderer forcefully crashed and the action would fail with
  // APP_TIMEOUT — so the clock stops while a host call is in flight.
  assert.doesNotMatch(inference, /timeoutMs:/);
  assert.match(desktopHost, /const defaultInvocationTimeoutMs = 10 \* 60_000;/);
  assert.doesNotMatch(desktopHost, /120 s budget|five-second invocation/, "no stale deadline wording survives");
  // A second action or automation queues for the worker's one operation slot instead of being refused.
  assert.doesNotMatch(desktopHost, /already handling (an action|work)/);
  assert.match(desktopHost, /async #claimWorker\(/);
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
