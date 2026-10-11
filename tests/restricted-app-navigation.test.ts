import assert from "node:assert/strict";
import test from "node:test";

import { resolveRestrictedAppOpenRequest, restrictedAppRailLabel } from "../web-local/src/lib/restricted-app-navigation.js";

const workFolders = [
  { id: "ws-current", name: "Current", workFolderRoot: "C:\\Current", location: { kind: "local" as const, storage: "linked" as const }, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
  { id: "ws-owner", name: "Owner", workFolderRoot: "C:\\Owner", location: { kind: "local" as const, storage: "linked" as const }, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
];

test("notification open requests target the exact owning work-folder even when another work-folder is active", () => {
  const target = resolveRestrictedAppOpenRequest({
    workFolderId: "ws-owner",
    appId: "connected-inbox",
    featureInstallationId: "feature-installation_original",
    digest: "a".repeat(64),
    permissionId: "new-mail",
  }, workFolders);
  assert.equal(target?.workFolder.id, "ws-owner");
  assert.equal(target?.mode, "app:restricted:ws-owner:connected-inbox:feature-installation_original");
  assert.notEqual(target?.workFolder.id, "ws-current");
});

test("a notification click opens the app's left pane at the destination the app named, and says so", () => {
  const request = {
    workFolderId: "ws-owner",
    appId: "connected-inbox",
    featureInstallationId: "feature-installation_original",
    digest: "a".repeat(64),
    permissionId: "new-mail",
  };
  const home = resolveRestrictedAppOpenRequest(request, workFolders);
  assert.deepEqual(home?.target, {
    mode: "app:restricted:ws-owner:connected-inbox:feature-installation_original",
    route: "/",
    openedFrom: { kind: "notification", permissionId: "new-mail" },
  }, "with no destination named, the click opens the app's home");
  const routed = resolveRestrictedAppOpenRequest({ ...request, route: "/threads/42?x=1", state: { threadId: "42" } }, workFolders);
  assert.deepEqual(routed?.target, {
    mode: home?.mode,
    route: "/threads/42?x=1",
    state: { threadId: "42" },
    openedFrom: { kind: "notification", permissionId: "new-mail" },
  });
  // A destination that no longer parses still opens the app, at its home.
  assert.deepEqual(resolveRestrictedAppOpenRequest({ ...request, route: "//elsewhere.example/x", state: { a: 1 } }, workFolders)?.target, home?.target);
  assert.equal(resolveRestrictedAppOpenRequest({ ...request, permissionId: "Not a category" }, workFolders), null);
});

test("notification open requests do not invent a removed owning work-folder", () => {
  assert.equal(resolveRestrictedAppOpenRequest({
    workFolderId: "ws-removed",
    appId: "connected-inbox",
    featureInstallationId: "feature-installation_original",
    digest: "a".repeat(64),
    permissionId: "new-mail",
  }, workFolders), null);
});

test("notification navigation distinguishes same-revision installations and refuses unpinned requests", () => {
  const request = { workFolderId: "ws-owner", appId: "connected-inbox", digest: "a".repeat(64), permissionId: "new-mail", featureInstallationId: "feature-installation_original" };
  const original = resolveRestrictedAppOpenRequest(request, workFolders);
  const sibling = resolveRestrictedAppOpenRequest({ ...request, featureInstallationId: "feature-installation_sibling" }, workFolders);
  assert.notEqual(original?.mode, sibling?.mode);
  assert.equal(resolveRestrictedAppOpenRequest({ ...request, featureInstallationId: "" }, workFolders), null);
});

test("only a co-located preview needs a rail label qualifier", () => {
  const preview = { manifest: { id: "quotes", title: "Quotes" }, runtimeInstanceKind: "development", featureInstallationId: "feature-installation_preview" } as any;
  const release = { ...preview, runtimeInstanceKind: "app", featureInstallationId: "feature-installation_release" };
  assert.equal(restrictedAppRailLabel(preview, [preview]), "Quotes");
  assert.equal(restrictedAppRailLabel(preview, [preview, release]), "Quotes · Preview");
  assert.equal(restrictedAppRailLabel(release, [preview, release]), "Quotes");
});
