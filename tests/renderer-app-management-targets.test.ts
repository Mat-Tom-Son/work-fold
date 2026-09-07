import assert from "node:assert/strict";
import test from "node:test";

import * as apps from "../web-local/src/lib/restricted-apps.js";
import type { RestrictedAppInstalled } from "../web-local/src/types.js";

test("every desktop app management helper retains its exact installation and revision", async (context) => {
  const app = { spaceId: "source", manifest: { id: "quotes" }, digest: "a".repeat(64),
    featureInstallationId: "feature-installation_preview" } as RestrictedAppInstalled;
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    workFoldDesktop: { api: { baseUrl: "http://localhost:9999", getSessionHeaders: async () => ({ "x-work-fold-session": "test-session" }) } },
  } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(String(input));
    const target = options?.body ? JSON.parse(String(options.body)) : Object.fromEntries(url.searchParams);
    assert.equal(target.featureInstallationId, app.featureInstallationId, `${options?.method} ${url.pathname}`);
    assert.equal(target.expectedDigest, app.digest);
    assert.equal((options?.headers as Record<string, string>)["x-work-fold-session"], "test-session");
    assert.ok(url.pathname.startsWith("/api/spaces/source/restricted-apps/quotes"));
    requests.push(`${options?.method} ${url.pathname}`);
    return new Response(JSON.stringify({ app, context: {}, connections: [], usage: {}, runs: [], backup: {}, recovery: null, removed: true, connection: {} }));
  });
  await apps.getRestrictedAppBuildContext(app);
  await apps.listRestrictedAppConnections(app);
  await apps.setRestrictedAppNetworkGrant(app, "api", true);
  await apps.setRestrictedAppNetworkGrant(app, "api", false);
  await apps.setRestrictedAppFileGrant(app, "quotes", true, "quotes");
  await apps.setRestrictedAppFileGrant(app, "quotes", false);
  await apps.setRestrictedAppCheckGrant(app, "review", { checkId: "selected", declarationDigest: "b".repeat(64) });
  await apps.setRestrictedAppCheckGrant(app, "review", null);
  await apps.setRestrictedAppNotificationGrant(app, "ready", true);
  await apps.setRestrictedAppNotificationGrant(app, "ready", false);
  await apps.setRestrictedAppAutomationEnabled(app, "refresh", true);
  await apps.setRestrictedAppAutomationEnabled(app, "refresh", false);
  await apps.runRestrictedAppAutomationNow(app, "refresh");
  await apps.listRestrictedAppAutomationRuns(app, "refresh");
  await apps.getRestrictedAppStorageUsage(app);
  await apps.clearRestrictedAppStorage(app);
  await apps.exportRestrictedAppData(app);
  await apps.getRestrictedAppDataRecovery(app);
  await apps.restoreRestrictedAppData(app, 3, { backup: {} });
  await apps.restoreRestrictedAppData(app, 4, { recoveryId: "undo" });
  await apps.setRestrictedAppConnection(app, "api", { kind: "bearer", token: "synthetic" });
  await apps.connectRestrictedAppOAuth(app, "api");
  await apps.deleteRestrictedAppConnection(app, "api");
  await apps.removeRestrictedApp(app);
  assert.equal(requests.length, 24);
});
