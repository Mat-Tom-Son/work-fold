import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const [capabilities, apps, chat, workspaceApp, workspaceChrome, viewport, styles, professionalSurfaces, desktopHost] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/panes/RestrictedAppsSection.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/App.tsx"),
  read("web-local/src/components/panes/workspaceChrome.tsx"),
  read("web-local/src/components/panes/RestrictedAppViewport.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/professional-surfaces.css"),
  read("desktop/src/restricted-app-host.ts"),
]);

test("Apps product hierarchy starts with the Assistant and keeps local preview loading advanced", () => {
  assert.match(apps, /Apps in this Space/);
  assert.match(apps, /Build with Assistant/);
  assert.match(apps, /<details className="restricted-app-advanced"><summary>Advanced local preview/);
  assert.match(apps, /Add local preview…/);
  assert.doesNotMatch(capabilities, /Sandboxed app extension|onAddRestrictedApp/);
  assert.doesNotMatch(apps, />Add app</);
});

test("review prioritizes requested access and visible contribution over collapsed package mechanics", () => {
  const access = apps.indexOf("Requested access");
  const contribution = apps.indexOf("What it adds");
  assert.ok(access >= 0 && contribution > access);
  assert.match(apps, /<ReviewDeclarations review=\{review\} \/>[\s\S]*?<details className="restricted-app-package-details"><summary>Package details/);
  assert.match(apps, /Add preview, then review access/);
  assert.match(apps, /Adding the preview grants no network destinations, Space files, notifications, or scheduled execution/);
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
  assert.match(apps, /App writes create History checkpoints/);
  assert.match(apps, /Automations/);
  assert.match(apps, /Local app data/);
  assert.match(apps, /<h3 id="restricted-app-notifications-title">Notifications<\/h3>/);
  assert.doesNotMatch(apps, /Windows notifications|Windows notification settings/);
  assert.match(apps, /Workspace · \{app\.manifest\.title\} — \{permission\.title\}/);
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
  assert.match(workspaceApp, /desktop\.onOpenRequest/);
  assert.match(workspaceApp, /resolveRestrictedAppOpenRequest\(request, workspaces\)/);
  assert.match(workspaceApp, /onSwitchWorkspace\(target\.workspace\)/);
  assert.match(workspaceApp, /setActiveMode\(target\.mode\)/);
  assert.match(viewport, /event\.state === "stopped"/);
  assert.match(viewport, /mountIdRef\.current = crypto\.randomUUID\(\)/);
  assert.match(viewport, /setGeneration\(\(value\) => value \+ 1\)/);
  assert.match(viewport, /disposed \|\| mountId !== mountIdRef\.current/);
});

test("the Space menu occludes native restricted-app views from the first animation frame", () => {
  assert.match(workspaceChrome, /data-native-view-occluder="true"/);
  assert.match(viewport, /const explicitOccluder = candidate\.dataset\.nativeViewOccluder === "true"/);
  assert.match(viewport, /\(!explicitOccluder && Number\(style\.opacity\) === 0\)/);
  assert.match(viewport, /style\.display === "none" \|\| style\.visibility === "hidden"/);
});

test("contributed app canvases share built-in spacing and native rounded corners", () => {
  assert.match(professionalSurfaces, /\.workspace-mode-pane > \.restricted-app-view\s*\{[^}]*height:\s*auto;[^}]*margin:\s*12px;/s);
  assert.match(viewport, /resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)/);
  assert.match(viewport, /style=\{\{ borderRadius: cornerRadius \}\}/);
  assert.match(viewport, /rail\.right \+ restrictedAppRailGuard/);
  assert.match(viewport, /borderLeftWidth/);
  assert.match(desktopHost, /view\.setBorderRadius\(resolveRestrictedAppCornerRadius\(app\.manifest\.ui\.cornerRadius\)\)/);
});

test("owning Chat renders digest review, defers install while running, and opens the installed interactive app", () => {
  assert.match(chat, /restricted_app_proposal/);
  assert.match(chat, /restricted_app_proposal_settled/);
  assert.match(chat, /data\.proposal\.workspaceId === workspace\.id/);
  assert.match(chat, /data\.proposal\.conversationId === conversationId/);
  assert.match(chat, /installDisabled=\{running\}/);
  assert.match(chat, /closeLabel="Decline"/);
  assert.match(chat, /installRestrictedAppProposal\(workspace\.id, proposal\.conversationId, proposal\.id\)/);
  assert.match(workspaceApp, /restrictedAppsState\.upsertApp\(app\)/);
  assert.match(workspaceApp, /setActiveMode\(restrictedAppRailMode\(targetWorkspace\.id, app\.manifest\.id\)\)/);
  assert.match(workspaceApp, /<RestrictedAppViewport app=\{activeRestrictedApp\} placement="navigator"/);
  assert.match(workspaceApp, /tabs\.openRestrictedAppSurfaceTab/);
  assert.doesNotMatch(workspaceApp, /surface\.execution === "restricted-app"/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
