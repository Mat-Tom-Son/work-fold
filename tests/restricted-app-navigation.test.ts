import assert from "node:assert/strict";
import test from "node:test";

import { resolveRestrictedAppOpenRequest } from "../web-local/src/lib/restricted-app-navigation.js";

const spaces = [
  { id: "ws-current", name: "Current", spaceRoot: "C:\\Current", location: { kind: "local" as const, storage: "linked" as const }, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
  { id: "ws-owner", name: "Owner", spaceRoot: "C:\\Owner", location: { kind: "local" as const, storage: "linked" as const }, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
];

test("notification open requests target the exact owning Space even when another Space is active", () => {
  const target = resolveRestrictedAppOpenRequest({
    spaceId: "ws-owner",
    appId: "connected-inbox",
    featureInstallationId: "feature-installation_original",
    digest: "a".repeat(64),
    permissionId: "new-mail",
  }, spaces);
  assert.equal(target?.space.id, "ws-owner");
  assert.equal(target?.mode, "app:restricted:ws-owner:connected-inbox:feature-installation_original");
  assert.notEqual(target?.space.id, "ws-current");
});

test("notification open requests do not invent a removed owning Space", () => {
  assert.equal(resolveRestrictedAppOpenRequest({
    spaceId: "ws-removed",
    appId: "connected-inbox",
    featureInstallationId: "feature-installation_original",
    digest: "a".repeat(64),
    permissionId: "new-mail",
  }, spaces), null);
});

test("notification navigation distinguishes same-revision installations and refuses unpinned requests", () => {
  const request = { spaceId: "ws-owner", appId: "connected-inbox", digest: "a".repeat(64), permissionId: "new-mail", featureInstallationId: "feature-installation_original" };
  const original = resolveRestrictedAppOpenRequest(request, spaces);
  const sibling = resolveRestrictedAppOpenRequest({ ...request, featureInstallationId: "feature-installation_sibling" }, spaces);
  assert.notEqual(original?.mode, sibling?.mode);
  assert.equal(resolveRestrictedAppOpenRequest({ ...request, featureInstallationId: "" }, spaces), null);
});
