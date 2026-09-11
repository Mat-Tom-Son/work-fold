import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { restrictedAppTaskAuthorityDigest } from "../src/local/agent/restricted-app-tasks.js";
import type { RestrictedAppAssistantTask, RestrictedAppTaskDetail } from "../src/shared/restricted-app-tasks.js";

import type {
  RestrictedAppConnectionBinding,
  RestrictedAppConnectionFeatureScope,
  RestrictedAppConnectionInstanceScope,
  RestrictedAppConnectionStore,
  RestrictedAppCredential,
} from "../src/local/agent/restricted-app-connections.js";
import {
  RestrictedAppService,
  type RestrictedAppInstalled,
  type RestrictedAppRuntimeDescriptor,
  type RestrictedAppRuntimeHost,
} from "../src/local/agent/restricted-app-service.js";
import { RoutedRestrictedAppProposalHost } from "../src/local/agent/restricted-app-proposals.js";
import type { EffectivePrincipal } from "../src/local/agent/app-platform-contract.js";
import type { RestrictedAppOAuthPkceClient } from "../src/local/agent/restricted-app-oauth.js";
import { FileRestrictedAppStorage, type RestrictedAppDataBackup, type RestrictedAppDataRecovery } from "../src/local/agent/restricted-app-storage.js";
import { startLocalApi } from "../src/local/server.js";
import { listSpaceCheckpoints } from "../src/local/history.js";
import type { RestrictedAppChangeDraft } from "../web-local/src/lib/restricted-apps.js";

test("restricted app API keeps review, install, grants, connections, invocation, and removal separate", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-api-"));
  let nextAssistantBlock: { entered(): void; released: Promise<void> } | null = null;
  const blockNextAssistantRuntime = () => {
    let entered!: () => void;
    let release!: () => void;
    const control = {
      entered: new Promise<void>((resolvePromise) => { entered = resolvePromise; }),
      release: () => release(),
    };
    nextAssistantBlock = {
      entered,
      released: new Promise<void>((resolvePromise) => { release = resolvePromise; }),
    };
    return control;
  };
  const runtime = new RuntimeHost();
  const connections = new Connections();
  const storage = new FileRestrictedAppStorage(join(sandbox, "state", "restricted-apps", "data"));
  const oauth = new FakeOAuth();
  const service = await RestrictedAppService.create({
    rootPath: join(sandbox, "state", "restricted-apps"),
    runtimeHost: runtime,
    connections,
    storage,
    oauth: oauth as unknown as RestrictedAppOAuthPkceClient,
  });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
    restrictedAppService: service,
    piRuntimeProvider: {
      async resolveRuntime() {
        const block = nextAssistantBlock;
        nextAssistantBlock = null;
        if (block) {
          block.entered();
          await block.released;
          throw new Error("simulated completed Assistant turn");
        }
        return {};
      },
    },
  });
  try {
    const created = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", {
      method: "POST",
      body: { name: "Restricted apps" },
    });
    const space = created.space;
    const sourcePath = "tools/mail-app";
    await writePackage(join(space.spaceRoot, ...sourcePath.split("/")));
    await mkdir(join(space.spaceRoot, "reports"), { recursive: true });

    const invalid = await fetch(`${api.origin}/api/spaces/${space.id}/restricted-apps/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePath: join(space.spaceRoot, "tools", "mail-app") }),
    });
    assert.equal(invalid.status, 400);

    const inspected = await request<{ review: { digest: string; manifest: { id: string } } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/inspect`,
      { method: "POST", body: { sourcePath } },
    );
    assert.equal(inspected.review.manifest.id, "mail-app");

    const installed = await request<{ app: RestrictedAppInstalled }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps`,
      { method: "POST", body: { sourcePath, expectedDigest: inspected.review.digest } },
    );
    assert.equal(installed.app.digest, inspected.review.digest);
    assert.deepEqual(installed.app.networkGrants, ["mail-api"], "an added app reaches its declared destination");
    assert.deepEqual(installed.app.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], "a directory permission binds to the whole Space");
    assert.deepEqual(installed.app.notificationGrants, ["new-mail"]);
    assert.equal(installed.app.automations[0]?.id, "refresh-mail");
    assert.equal(installed.app.automations[0]?.enabled, true, "every declared automation is on");
    assert.ok(installed.app.automations[0]?.nextRunAt, "an enabled automation has a next run");

    const changeInput = { requestId: randomUUID(), expectedDigest: installed.app.digest };
    const changeUrl = `/api/spaces/${space.id}/restricted-apps/mail-app/change`;
    const changed = await request<{ change: RestrictedAppChangeDraft }>(api.origin, changeUrl, { method: "POST", body: changeInput });
    assert.equal(changed.change.sourceSpaceId, space.id);
    assert.equal(changed.change.baseDigest, installed.app.digest);
    const buildContext = await request<{ context: { sourceSpaceId: string; sourcePath: string; buildConversationId: string | null; updateTargetRuntimeInstanceId: string | null } }>(api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/build-context?expectedDigest=${installed.app.digest}`);
    assert.deepEqual(buildContext.context, { sourceSpaceId: space.id, sourcePath: changed.change.sourcePath,
      buildConversationId: null, updateTargetRuntimeInstanceId: null });
    assert.equal(await readFile(join(space.spaceRoot, changed.change.sourcePath, "index.html"), "utf8"), await readFile(join(space.spaceRoot, sourcePath, "index.html"), "utf8"));
    const checkpoints = await listSpaceCheckpoints(space.spaceRoot);
    assert.equal(checkpoints.filter((item) => item.reason === "app-change").length, 1);
    assert.deepEqual(await request(api.origin, changeUrl, { method: "POST", body: changeInput }), changed);
    assert.equal((await listSpaceCheckpoints(space.spaceRoot)).length, checkpoints.length);
    const wrongRevision = await fetch(`${api.origin}${changeUrl}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...changeInput, expectedDigest: "a".repeat(64) }) });
    assert.equal(wrongRevision.status, 409);

    await storage.set({
      ownerClass: "instance",
      tenantId: installed.app.tenantId,
      runtimeInstanceId: installed.app.runtimeInstanceId,
      featureInstallationId: installed.app.featureInstallationId,
      dataNamespaceId: installed.app.dataNamespaceId,
    }, "view", { folder: "inbox" });

    const granted = await request<{ app: { networkGrants: string[] } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/network/mail-api`,
      { method: "PUT", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(granted.app.networkGrants, ["mail-api"]);

    const fileGranted = await request<{ app: { fileGrants: Array<{ declarationId: string; root: string; access: string }> } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/files/exports`,
      { method: "PUT", body: { expectedDigest: inspected.review.digest, root: "reports" } },
    );
    assert.deepEqual(fileGranted.app.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }], "granting again with a folder narrows the whole-Space default");

    const notificationsGranted = await request<{ app: { notificationGrants: string[] } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/notifications/new-mail`,
      { method: "PUT", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(notificationsGranted.app.notificationGrants, ["new-mail"]);
    const notificationsRevoked = await request<{ app: { notificationGrants: string[] } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/notifications/new-mail`,
      { method: "DELETE", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(notificationsRevoked.app.notificationGrants, []);

    const automation = await request<{ app: { automations: Array<{ id: string; enabled: boolean; nextRunAt?: string }> } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail`,
      { method: "PUT", body: { expectedDigest: inspected.review.digest } },
    );
    assert.equal(automation.app.automations[0]?.enabled, true);
    assert.ok(automation.app.automations[0]?.nextRunAt);
    const automationControl = runtime.blockNextAutomation();
    const automationRunRequest = request<{
      app: { automations: Array<{ id: string; enabled: boolean; lastRunAt?: string; lastError?: string }> };
      run: {
        runId: string;
        automationId: string;
        reason: string;
        scheduledAt: string;
        startedAt: string;
        finishedAt: string;
        outcome: string;
        error?: string;
      };
    }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail/run`,
      { method: "POST", body: { expectedDigest: inspected.review.digest } },
    );
    try {
      await automationControl.started;
      const blockedMutation = await fetch(
        `${api.origin}/api/spaces/${space.id}/restricted-apps/mail-app/permissions/network/mail-api`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedDigest: inspected.review.digest }),
        },
      );
      assert.equal(blockedMutation.status, 409, "a manual automation run must reserve the Space capability-mutation lane");
      const blockedClear = await fetch(
        `${api.origin}/api/spaces/${space.id}/restricted-apps/mail-app/storage`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedDigest: inspected.review.digest }),
        },
      );
      assert.equal(blockedClear.status, 409, "storage clear must join the Space capability-mutation lane");
      assert.equal((await request<{ usage: { keyCount: number } }>(
        api.origin,
        `/api/spaces/${space.id}/restricted-apps/mail-app/storage?expectedDigest=${inspected.review.digest}`,
      )).usage.keyCount, 1, "read-only storage usage remains available during a capability mutation");
    } finally {
      automationControl.release();
    }
    const automationRun = await automationRunRequest;
    assert.equal(automationRun.app.automations[0]?.id, "refresh-mail");
    assert.equal(automationRun.app.automations[0]?.enabled, true);
    assert.ok(automationRun.app.automations[0]?.lastRunAt);
    assert.equal(automationRun.app.automations[0]?.lastError, undefined);
    assert.equal(automationRun.run.automationId, "refresh-mail");
    assert.equal(automationRun.run.reason, "manual");
    assert.equal(automationRun.run.outcome, "success");
    assert.equal(automationRun.run.error, undefined);
    assert.ok(automationRun.run.runId);
    assert.match(automationRun.run.scheduledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(automationRun.run.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(automationRun.run.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(runtime.automationRuns.length, 1);
    assert.equal(runtime.automationRuns[0]?.event.runId, automationRun.run.runId);
    assert.equal(runtime.automationRuns[0]?.event.automationId, "refresh-mail");
    assert.equal(runtime.automationRuns[0]?.event.handler, "refresh-mail");
    assert.equal(runtime.automationRuns[0]?.event.reason, "manual");
    assert.equal(runtime.automationRuns[0]?.event.scheduledAt, automationRun.run.scheduledAt);
    assert.deepEqual(runtime.automationRuns[0]?.app.networkGrants, ["mail-api"]);
    assert.deepEqual(runtime.automationRuns[0]?.app.fileGrants.map((grant) => grant.declarationId), ["exports"]);
    assert.deepEqual(runtime.automationRuns[0]?.app.notificationGrants, []);

    const automationRuns = await request<{ runs: Array<typeof automationRun.run> }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail/runs?expectedDigest=${inspected.review.digest}`,
    );
    assert.deepEqual(automationRuns.runs, [automationRun.run]);

    const usage = await request<{ usage: { keyCount: number } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/storage?expectedDigest=${inspected.review.digest}`,
    );
    assert.equal(usage.usage.keyCount, 1);
    const dataUrl = `/api/spaces/${space.id}/restricted-apps/mail-app/storage`;
    const exported = await request<{ backup: RestrictedAppDataBackup }>(api.origin, `${dataUrl}/export?expectedDigest=${inspected.review.digest}`);
    assert.equal(exported.backup.data.entries[0]?.key, "view");
    assert.equal("connections" in exported.backup, false);
    const controlAbort = new AbortController();
    const controlResponse = await fetch(`${api.origin}/api/management/control-events`, { signal: controlAbort.signal });
    assert.equal(controlResponse.status, 200);
    const controlReader = controlResponse.body!.getReader();
    assert.equal(new TextDecoder().decode((await controlReader.read()).value), 'data: {"type":"reset"}\n\n');

    const conversation = await request<{ conversation: { id: string } }>(
      api.origin,
      `/api/spaces/${space.id}/conversations`,
      { method: "POST" },
    );
    const assistantControl = blockNextAssistantRuntime();
    const activeTurn = await fetch(
      `${api.origin}/api/spaces/${space.id}/conversations/${conversation.conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hold storage authority for this test." }),
      },
    );
    assert.equal(activeTurn.status, 202, await activeTurn.text());
    await assistantControl.entered;
    try {
      const blockedClear = await fetch(
        `${api.origin}/api/spaces/${space.id}/restricted-apps/mail-app/storage`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedDigest: inspected.review.digest }),
        },
      );
      assert.equal(blockedClear.status, 409, "active Assistant work must prevent storage authority changes");
      const blockedRestore = await fetch(`${api.origin}${dataUrl}/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDigest: inspected.review.digest, expectedRevision: 1, backup: exported.backup }),
      });
      assert.equal(blockedRestore.status, 409, "restore shares the capability-mutation reservation");
      const blockedChange = await fetch(`${api.origin}${changeUrl}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...changeInput, requestId: randomUUID() }) });
      assert.equal(blockedChange.status, 409, "app source preparation reserves the owning Space against Assistant work");
      assert.equal((await request<{ usage: { keyCount: number } }>(
        api.origin,
        `/api/spaces/${space.id}/restricted-apps/mail-app/storage?expectedDigest=${inspected.review.digest}`,
      )).usage.keyCount, 1);
    } finally {
      assistantControl.release();
    }
    await waitFor(async () => (await api.kernel.getTasks({ kind: "system" })).tasks.length === 0);

    const cleared = await request<{ usage: { keyCount: number } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/storage`,
      { method: "DELETE", body: { expectedDigest: inspected.review.digest } },
    );
    assert.equal(cleared.usage.keyCount, 0);
    const controlUpdate = new TextDecoder().decode((await controlReader.read()).value);
    assert.match(controlUpdate, /data: \{"type":"apps"\}/);
    assert.equal(controlUpdate.includes("inbox"), false, "control hints never contain app data");
    controlAbort.abort();
    const recovery = await request<{ recovery: RestrictedAppDataRecovery }>(api.origin, `${dataUrl}/recovery?expectedDigest=${inspected.review.digest}`);
    assert.equal(recovery.recovery.available, true);
    const beforeRestore = (await service.list(space.id))[0]!;
    const restored = await request<{ usage: { revision: number; keyCount: number } }>(api.origin, `${dataUrl}/restore`, {
      method: "POST", body: { expectedDigest: inspected.review.digest, expectedRevision: 2, backup: exported.backup },
    });
    assert.equal(restored.usage.keyCount, 1);
    assert.equal(restored.usage.revision, 3, "restore advances the current revision instead of replaying the backup revision");
    const afterRestore = (await service.list(space.id))[0]!;
    assert.deepEqual(afterRestore.networkGrants, beforeRestore.networkGrants);
    assert.deepEqual(afterRestore.fileGrants, beforeRestore.fileGrants);
    assert.deepEqual(afterRestore.automations, beforeRestore.automations);
    assert.notEqual(afterRestore.authority.dataGeneration, beforeRestore.authority.dataGeneration);
    const staleRestore = await fetch(`${api.origin}${dataUrl}/restore`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedDigest: inspected.review.digest, expectedRevision: 2, backup: exported.backup }),
    });
    assert.equal(staleRestore.status, 409);
    const corruptRestore = await fetch(`${api.origin}${dataUrl}/restore`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedDigest: inspected.review.digest, expectedRevision: 3, backup: { ...exported.backup, sha256: "0".repeat(64) } }),
    });
    assert.equal(corruptRestore.status, 422);
    assert.deepEqual((await service.list(space.id))[0]!.authority, afterRestore.authority, "invalid or stale restores do not change authority");

    const oauthStatus = await request<{ connection: { destinationId: string; owner: string; kind: string; configured: boolean; diagnostics: Array<{ code: string; issuer: string; message: string }> } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/connections/mail-api/oauth`,
      { method: "POST", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(oauthStatus.connection, {
      destinationId: "mail-api",
      owner: "instance",
      kind: "oauth2-pkce",
      configured: true,
      diagnostics: [{
        code: "METADATA_PKCE_UNDECLARED",
        issuer: "https://identity.example.com",
        message: "The provider does not advertise PKCE S256.",
      }],
    });
    assert.equal(oauth.connectCount, 1);
    assert.equal(oauth.configuration?.issuer, "https://identity.example.com");

    await request(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/connections/mail-api`,
      {
        method: "PUT",
        body: {
          expectedDigest: inspected.review.digest,
          credential: { kind: "api-key", value: "secret" },
        },
      },
    );
    const statuses = await request<{ connections: Array<{ destinationId: string; owner: string; kind: string; configured: boolean }> }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/connections?expectedDigest=${inspected.review.digest}`,
    );
    assert.deepEqual(statuses.connections, [{ destinationId: "mail-api", owner: "instance", kind: "api-key", configured: true }]);

    const invoked = await request<{ result: unknown }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/invoke`,
      { method: "POST", body: { expectedDigest: inspected.review.digest, action: "search", input: { query: "invoice" } } },
    );
    assert.deepEqual(invoked.result, { count: 3 });
    assert.deepEqual(runtime.invocations[0]?.app.networkGrants, ["mail-api"]);

    const revoked = await request<{ app: { networkGrants: string[] } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/network/mail-api`,
      { method: "DELETE", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(revoked.app.networkGrants, []);

    const filesRevoked = await request<{ app: { fileGrants: unknown[] } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/permissions/files/exports`,
      { method: "DELETE", body: { expectedDigest: inspected.review.digest } },
    );
    assert.deepEqual(filesRevoked.app.fileGrants, []);

    const removed = await request<{ removed: boolean }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app`,
      { method: "DELETE", body: { expectedDigest: inspected.review.digest } },
    );
    assert.equal(removed.removed, true);
    assert.deepEqual((await request<{ apps: unknown[] }>(api.origin, `/api/spaces/${space.id}/restricted-apps`)).apps, []);

    // Identical code is not the same installation. Exercise each management
    // route with the old card's identity after remove/reinstall.
    const reinstalled = await request<{ app: RestrictedAppInstalled }>(api.origin, `/api/spaces/${space.id}/restricted-apps`, {
      method: "POST", body: { sourcePath, expectedDigest: inspected.review.digest },
    });
    assert.notEqual(reinstalled.app.featureInstallationId, installed.app.featureInstallationId);
    const itemUrl = `/api/spaces/${space.id}/restricted-apps/mail-app`;
    const stale = { expectedDigest: inspected.review.digest, featureInstallationId: installed.app.featureInstallationId };
    const oldQuery = new URLSearchParams(stale);
    const staleReads = ["build-context", "connections", "automations/refresh-mail/runs", "storage", "storage/export", "storage/recovery", "assistant-tasks"];
    for (const route of staleReads) {
      const response = await fetch(`${api.origin}${itemUrl}/${route}?${oldQuery}`);
      assert.equal(response.status, 503, `stale ${route} must not read the replacement`);
    }
    const staleWrites: Array<[string, string, object]> = [
      ["change", "POST", { requestId: randomUUID() }],
      ["invoke", "POST", { action: "search", input: { query: "invoice" } }],
      ["permissions/network/mail-api", "PUT", {}], ["permissions/network/mail-api", "DELETE", {}],
      ["permissions/files/exports", "PUT", { root: "reports" }], ["permissions/files/exports", "DELETE", {}],
      ["permissions/notifications/new-mail", "PUT", {}], ["permissions/notifications/new-mail", "DELETE", {}],
      ["automations/refresh-mail", "PUT", {}], ["automations/refresh-mail", "DELETE", {}],
      ["automations/refresh-mail/run", "POST", {}], ["storage", "DELETE", {}],
      ["storage/restore", "POST", { expectedRevision: 0, backup: exported.backup }],
      ["connections/mail-api", "PUT", { credential: { kind: "api-key", value: "synthetic" } }],
      ["connections/mail-api", "DELETE", {}], ["connections/mail-api/oauth", "POST", {}],
      [`assistant-tasks/${randomUUID()}/cancel`, "POST", {}],
    ];
    const callsBeforeStaleRequests = runtime.invocations.length;
    for (const [route, method, extra] of staleWrites) {
      const response = await fetch(`${api.origin}${itemUrl}/${route}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...stale, ...extra }),
      });
      assert.equal(response.status, 503, `stale ${method} ${route} must not affect the replacement`);
    }
    assert.deepEqual(await request(api.origin, itemUrl, { method: "DELETE", body: stale }), { removed: false });
    assert.deepEqual(await service.list(space.id), [reinstalled.app]);
    assert.equal(runtime.invocations.length, callsBeforeStaleRequests);
    const current = { ...stale, featureInstallationId: reinstalled.app.featureInstallationId };
    const currentGrant = await request<{ app: RestrictedAppInstalled }>(api.origin, `${itemUrl}/permissions/network/mail-api`, { method: "PUT", body: current });
    assert.deepEqual(currentGrant.app.networkGrants, ["mail-api"]);
    const currentUsage = await request<{ usage: { usageBytes: number } }>(api.origin, `${itemUrl}/storage?${new URLSearchParams(current)}`);
    assert.equal(currentUsage.usage.usageBytes, 0);
    const malformed = await fetch(`${api.origin}${itemUrl}/storage`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...current, featureInstallationId: null }) });
    assert.equal(malformed.status, 400, "a malformed pin must not fall back to name-only selection");

    const release = await service.prepareLocalAppRelease({ spaceId: space.id, displayVersion: "coexist-1" });
    await service.publishLocalAppRelease({ spaceId: space.id, releaseDigest: release.releaseDigest });
    const install = await service.prepareLocalAppInstall({ sourceSpaceId: space.id, targetSpaceId: space.id, releaseDigest: release.releaseDigest });
    const released = (await service.activateLocalAppInstall(install.operationId)).apps[0]!;
    const dataOwner = (app: RestrictedAppInstalled) => ({ ownerClass: "instance" as const, tenantId: app.tenantId,
      runtimeInstanceId: app.runtimeInstanceId, featureInstallationId: app.featureInstallationId, dataNamespaceId: app.dataNamespaceId });
    await storage.set(dataOwner(reinstalled.app), "preview", "keep this");
    await storage.set(dataOwner(released), "release", "clear this");
    await assert.rejects(api.actFacade.appsStorageClear({ space: space.id, app: "mail-app" }), /More than one installation/);
    const storageCleared = await api.actFacade.appsStorageClear({ space: space.id, app: released.featureInstallationId });
    assert.equal(storageCleared.appId, "mail-app");
    assert.ok(storageCleared.clearedBytes > 0, "the receipt states the byte count cleared");
    assert.equal(storageCleared.remainingBytes, 0);
    assert.equal((await storage.usage(dataOwner(released))).keyCount, 0);
    assert.equal(await storage.get(dataOwner(reinstalled.app), "preview"), "keep this", "a clear affects only its pinned sibling");
    const previewGrant = await request<{ app: RestrictedAppInstalled }>(api.origin, `${itemUrl}/permissions/network/mail-api`, { method: "DELETE", body: current });
    assert.deepEqual(previewGrant.app.networkGrants, []);
    assert.equal(previewGrant.app.featureInstallationId, reinstalled.app.featureInstallationId);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("machine-wide automation ledgers feed the glance and the restore fence, and a files grant binds to the whole Space", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-ledgers-"));
  const runtime = new RuntimeHost();
  const service = await RestrictedAppService.create({
    rootPath: join(sandbox, "state", "restricted-apps"),
    runtimeHost: runtime,
  });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
    restrictedAppService: service,
  });
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(
      api.origin,
      "/api/spaces",
      { method: "POST", body: { name: "Ledger apps" } },
    );
    await writePackage(join(space.spaceRoot, "tools", "mail-app"));
    await mkdir(join(space.spaceRoot, "reports"), { recursive: true });
    const inspected = await request<{ review: { digest: string } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/inspect`,
      { method: "POST", body: { sourcePath: "tools/mail-app" } },
    );
    const installed = await request<{ app: RestrictedAppInstalled }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps`,
      { method: "POST", body: { sourcePath: "tools/mail-app", expectedDigest: inspected.review.digest } },
    );
    await request(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail`,
      { method: "PUT", body: { expectedDigest: inspected.review.digest } },
    );

    // The install already granted the directory permission over the whole
    // Space (docs/receipts-not-gates.md, F21); the person's narrowing control
    // takes it away first.
    assert.deepEqual(installed.app.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }]);
    const revoked = await api.actFacade.appsRevoke({
      space: space.id,
      app: installed.app.featureInstallationId,
      digest: installed.app.digest,
      kind: "files",
      declaration: "exports",
    });
    assert.equal(revoked.revoked, true);
    assert.deepEqual((await service.list(space.id))[0]?.fileGrants, []);

    // Phase A: an active accepted run with no file grants is visible in the
    // machine-wide ledger and the glance, but never blocks a restore.
    assert.deepEqual(await service.listActiveAutomationRuns(), []);
    const firstControl = runtime.blockNextAutomation();
    const firstRun = request<{ run: { runId: string; outcome: string } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail/run`,
      { method: "POST", body: { expectedDigest: inspected.review.digest } },
    );
    await firstControl.started;
    const activeWithoutGrant = await service.listActiveAutomationRuns();
    assert.equal(activeWithoutGrant.length, 1);
    assert.equal(activeWithoutGrant[0]!.spaceId, space.id);
    assert.equal(activeWithoutGrant[0]!.appId, "mail-app");
    assert.equal(activeWithoutGrant[0]!.automationId, "refresh-mail");
    assert.equal(activeWithoutGrant[0]!.reason, "manual");
    assert.deepEqual(activeWithoutGrant[0]!.fileGrantIds, [], "no grant means the run provably holds none");
    const runningGlance = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal(
      runningGlance.running.some((item) => item.kind === "automation-run"),
      true,
      "an accepted automation run reaches the glance's running digest",
    );
    assert.deepEqual(
      await api.kernel.listExperimentalHistoryRestoreBlockers(space.id),
      [],
      "a run holding no file grant never blocks a restore",
    );
    firstControl.release();
    assert.equal((await firstRun).run.outcome, "success");
    assert.deepEqual(await service.listActiveAutomationRuns(), []);

    // Phase B: granting the files permission again runs at once and binds to
    // the whole Space, exactly as the install default did; the receipt names the root.
    const granted = await api.actFacade.appsGrant({
      space: space.id,
      app: installed.app.featureInstallationId,
      digest: installed.app.digest,
      kind: "files",
      declaration: "exports",
    });
    assert.equal(granted.granted, true);
    assert.equal(granted.root, ".");
    const grantedApps = await service.list(space.id);
    assert.deepEqual(
      grantedApps[0]?.fileGrants,
      [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }],
      "the grant covers the whole Space folder",
    );

    // Phase C: the same run now holds the grant, so the machine-wide join
    // reports it and the whole-Space restore fence blocks this Space only.
    const secondControl = runtime.blockNextAutomation();
    const secondRun = request<{ run: { outcome: string } }>(
      api.origin,
      `/api/spaces/${space.id}/restricted-apps/mail-app/automations/refresh-mail/run`,
      { method: "POST", body: { expectedDigest: inspected.review.digest } },
    );
    await secondControl.started;
    const activeWithGrant = await service.listActiveAutomationRuns();
    assert.deepEqual(activeWithGrant[0]?.fileGrantIds, ["exports"]);
    const blockers = await api.kernel.listExperimentalHistoryRestoreBlockers(space.id);
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /app automation refresh-mail of mail-app/);
    assert.match(blockers[0]!, /file grant into this Space/);
    assert.deepEqual(
      await api.kernel.listExperimentalHistoryRestoreBlockers("ws-elsewhere-0000000"),
      [],
      "the fence blocks only the Space the grant reaches into",
    );
    secondControl.release();
    assert.equal((await secondRun).run.outcome, "success");
    assert.deepEqual(await api.kernel.listExperimentalHistoryRestoreBlockers(space.id), []);

    // Settled receipts reach the machine-wide history ledger and the glance's
    // what-changed digest with their Space and app identity intact.
    const history = await service.listAutomationRunHistory();
    assert.equal(history.length, 2);
    for (const receipt of history) {
      assert.equal(receipt.spaceId, space.id);
      assert.equal(receipt.appId, "mail-app");
      assert.equal(receipt.automationId, "refresh-mail");
      assert.equal(receipt.outcome, "success");
      assert.match(receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    const settledGlance = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal(
      settledGlance.changes.some((item) => item.kind === "automation-run-settled"),
      true,
      "settled automation receipts reach the glance's what-changed digest",
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("restricted app proposals are host-inspected, owning-Chat bound, persisted, and digest-pinned", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-proposal-api-"));
  const stateRoot = join(sandbox, "state", "restricted-apps");
  const service = await RestrictedAppService.create({ rootPath: stateRoot });
  const proposals = await RoutedRestrictedAppProposalHost.create({ service, registryPath: join(stateRoot, "proposals.json") });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
    restrictedAppService: service,
    restrictedAppProposalHost: proposals,
  });
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", { method: "POST", body: { name: "Proposed apps" } });
    const first = await request<{ conversation: { id: string } }>(api.origin, `/api/spaces/${space.id}/conversations`, { method: "POST" });
    const second = await request<{ conversation: { id: string } }>(api.origin, `/api/spaces/${space.id}/conversations`, { method: "POST" });
    await writePackage(join(space.spaceRoot, "tools", "mail-app"));

    const settledEvents: string[] = [];
    proposals.on("settled", ({ proposal }) => settledEvents.push(proposal.status));
    const result = await proposals.propose({
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      conversationId: first.conversation.id,
      sourcePath: "tools/mail-app",
    });
    assert.equal(result.status, "installed", "a proposal installs the local preview in the same call");
    assert.deepEqual(result.needs, { connections: ["mail-api"], files: [], checks: [] });
    assert.deepEqual(settledEvents, ["installed"]);
    const proposalId = result.proposal!.id;
    assert.equal((await service.list(space.id))[0]?.digest, result.proposal!.review.digest);

    const owned = await request<{ proposals: Array<{ id: string; sourcePath: string; spaceRoot?: string; status: string; needs?: { connections: string[] }; error?: string }> }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals`,
    );
    assert.deepEqual(owned.proposals.map(({ id, sourcePath, status }) => ({ id, sourcePath, status })), [{ id: proposalId, sourcePath: "tools/mail-app", status: "installed" }]);
    assert.deepEqual(owned.proposals[0]!.needs?.connections, ["mail-api"], "the renderer receipt names what still needs the person");
    assert.equal("spaceRoot" in owned.proposals[0]!, false, "machine paths stay outside renderer proposal payloads");
    assert.deepEqual((await request<{ proposals: unknown[] }>(api.origin, `/api/spaces/${space.id}/conversations/${second.conversation.id}/restricted-app-proposals`)).proposals, []);

    const wrongChat = await fetch(`${api.origin}/api/spaces/${space.id}/conversations/${second.conversation.id}/restricted-app-proposals/${proposalId}/install`, { method: "POST" });
    assert.equal(wrongChat.status, 404);

    const installed = await request<{ app: { digest: string; networkGrants: string[] }; proposal: { status: string } }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals/${proposalId}/install`,
      { method: "POST" },
    );
    assert.equal(installed.app.digest, result.proposal!.review.digest, "the install route is an idempotent retry");
    assert.deepEqual(installed.app.networkGrants, ["mail-api"]);
    assert.equal(installed.proposal.status, "installed");
    assert.equal((await service.list(space.id)).length, 1);

    const again = await proposals.propose({ spaceId: space.id, spaceRoot: space.spaceRoot, conversationId: first.conversation.id, sourcePath: "tools/mail-app" });
    assert.equal(again.proposal!.id, proposalId, "the same source and revision reuse the installed receipt");
    const dismissed = await request<{ dismissed: boolean }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals/${proposalId}`,
      { method: "DELETE" },
    );
    assert.equal(dismissed.dismissed, false, "an installed receipt is not dismissable");
    assert.equal((await proposals.get(proposalId))?.status, "installed");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function request<T = unknown>(
  origin: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    ...(options.body !== undefined ? {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body),
    } : {}),
  });
  const value = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, value.error);
  return value;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for restricted app API state.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "mail-app",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify({
      version: 2,
      id: "mail-app",
      title: "Mail",
      runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
      ui: { icon: "mail" },
      tools: [{
        name: "search",
        description: "Search mail",
        action: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1, maxLength: 100 } },
          required: ["query"],
          additionalProperties: false,
        },
        resultSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 0 } },
          required: ["count"],
          additionalProperties: false,
        },
      }],
      automations: [{
        id: "refresh-mail",
        title: "Refresh mail",
        handler: "refresh-mail",
        trigger: { kind: "interval", intervalMinutes: 30 },
        permissions: {
          network: ["mail-api"],
          files: ["exports"],
          notifications: ["new-mail"],
        },
        catchUp: "latest",
        overlap: "skip",
      }],
      permissions: {
        files: [{ id: "exports", target: "directory", access: "read-write" }],
        notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
        network: [{
          id: "mail-api",
          target: { kind: "public-https", origin: "https://mail.example.com" },
          methods: ["GET"],
          auth: [
            { kind: "api-key", header: "x-api-key" },
            { kind: "oauth2-pkce", issuer: "https://identity.example.com", clientId: "work-fold-mail", scopes: ["mail.read"] },
          ],
        }],
      },
    }), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8"),
    writeFile(join(root, "app.js"), "export {};\n", "utf8"),
    writeFile(join(root, "worker.js"), "export async function handleAction() { return { count: 3 }; }\nexport async function handleAutomation() {}\n", "utf8"),
  ]);
}

class RuntimeHost implements RestrictedAppRuntimeHost {
  readonly invocations: Array<{ app: RestrictedAppRuntimeDescriptor; action: string; input: unknown }> = [];
  readonly automationRuns: Array<{
    app: RestrictedAppRuntimeDescriptor;
    event: {
      runId: string;
      automationId: string;
      handler: string;
      reason: "scheduled" | "manual" | "resume";
      scheduledAt: string;
      effectivePrincipal: EffectivePrincipal;
    };
  }> = [];
  #automationBlock?: { started: () => void; release: Promise<void> };
  async invoke(app: RestrictedAppRuntimeDescriptor, action: string, input: unknown): Promise<unknown> {
    this.invocations.push({ app: structuredClone(app), action, input: structuredClone(input) });
    return { count: 3 };
  }
  async runAutomation(app: RestrictedAppRuntimeDescriptor, event: {
    runId: string;
    automationId: string;
    handler: string;
    reason: "scheduled" | "manual" | "resume";
    scheduledAt: string;
    effectivePrincipal: EffectivePrincipal;
  }): Promise<void> {
    this.automationRuns.push({ app: structuredClone(app), event: structuredClone(event) });
    const block = this.#automationBlock;
    this.#automationBlock = undefined;
    block?.started();
    if (block) await block.release;
  }
  blockNextAutomation(): { started: Promise<void>; release(): void } {
    let started!: () => void;
    let release!: () => void;
    const result = {
      started: new Promise<void>((resolvePromise) => { started = resolvePromise; }),
      release: () => release(),
    };
    this.#automationBlock = {
      started,
      release: new Promise<void>((resolvePromise) => { release = resolvePromise; }),
    };
    return result;
  }
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeOAuth {
  connectCount = 0;
  configuration?: { issuer: string; clientId: string; scopes: string[] };
  async connect(_binding: unknown, configuration: { issuer: string; clientId: string; scopes: string[] }): Promise<{
    kind: "oauth2-pkce";
    configured: true;
    scopes: string[];
    expiresAt: string;
    diagnostics: Array<{ code: "METADATA_PKCE_UNDECLARED"; issuer: string; message: string }>;
  }> {
    this.connectCount += 1;
    this.configuration = structuredClone(configuration);
    return {
      kind: "oauth2-pkce",
      configured: true,
      scopes: [...configuration.scopes],
      expiresAt: "2026-07-13T13:00:00.000Z",
      diagnostics: [{
        code: "METADATA_PKCE_UNDECLARED",
        issuer: configuration.issuer,
        message: "The provider does not advertise PKCE S256.",
      }],
    };
  }
  async disconnect(): Promise<boolean> { return false; }
}

class Connections implements RestrictedAppConnectionStore {
  readonly records = new Map<string, RestrictedAppCredential>();
  async get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined> {
    return structuredClone(this.records.get(key(binding)));
  }
  async set(binding: RestrictedAppConnectionBinding, credential: RestrictedAppCredential): Promise<void> {
    this.records.set(key(binding), structuredClone(credential));
  }
  async delete(binding: RestrictedAppConnectionBinding): Promise<boolean> {
    return this.records.delete(key(binding));
  }
  async deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void> {
    for (const item of [...this.records.keys()]) {
      const record = JSON.parse(item) as string[];
      if (record[0] === scope.tenantId && record[1] === scope.runtimeInstanceId
        && record[2] === scope.featureId && record[3] === scope.featureInstallationId
        && record[4] === scope.featureRevisionDigest) this.records.delete(item);
    }
  }
  async deleteRuntimeInstance(scope: RestrictedAppConnectionInstanceScope): Promise<void> {
    for (const item of [...this.records.keys()]) {
      const record = JSON.parse(item) as string[];
      if (record[0] === scope.tenantId && record[1] === scope.runtimeInstanceId) this.records.delete(item);
    }
  }
  async carryForward(from: RestrictedAppConnectionFeatureScope, to: RestrictedAppConnectionFeatureScope, keep: readonly { declarationId: string; declarationDigest: string }[]): Promise<string[]> {
    const kept: string[] = [];
    for (const item of [...this.records.keys()]) {
      const record = JSON.parse(item) as string[];
      if (!(record[0] === from.tenantId && record[1] === from.runtimeInstanceId && record[2] === from.featureId
        && record[3] === from.featureInstallationId && record[4] === from.featureRevisionDigest)) continue;
      if (!keep.some((entry) => entry.declarationId === record[5] && entry.declarationDigest === record[6])) continue;
      const credential = this.records.get(item)!;
      this.records.delete(item);
      this.records.set(JSON.stringify([to.tenantId, to.runtimeInstanceId, to.featureId, to.featureInstallationId, to.featureRevisionDigest, ...record.slice(5)]), credential);
      kept.push(record[5]!);
    }
    return kept.sort();
  }
}

function key(binding: RestrictedAppConnectionBinding): string {
  return JSON.stringify([
    binding.tenantId,
    binding.runtimeInstanceId,
    binding.featureId,
    binding.featureInstallationId,
    binding.featureRevisionDigest,
    binding.declarationId,
    binding.declarationDigest,
    binding.targetIdentity,
    binding.owner.kind,
    binding.owner.kind === "instance" ? binding.owner.runtimeInstanceId : binding.owner.principalId,
  ]);
}

test("app requests use reviewed native Pi turns, History, exact task cancellation and durable response replay", { timeout: 45_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-assistant-api-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const bodies: string[] = [];
  let hold = false;
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      if (hold) { res.write(": waiting\n\n"); entered(); return; }
      const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `completion-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "app-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (!/"role":"tool"/.test(body)) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "write_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "comparison.md", content: "# Comparison\nNorth: $42\n" }) } }] });
        chunk({}, "tool_calls");
      } else { chunk({ role: "assistant", content: "Saved comparison.md. North costs $42." }); chunk({}, "stop"); }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as AddressInfo).port;
  await writeFile(join(agentDir, "extensions", "app-provider.ts"), `export default function(pi) { pi.registerProvider("app-provider", { api: "openai-completions", baseUrl: "http://127.0.0.1:${providerPort}/v1", apiKey: "synthetic", models: [{ id: "app-model", name: "App Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] }); }`);
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "app-provider", defaultModel: "app-model", defaultThinkingLevel: "off" });
  const options = { port: 0, stateBase: join(sandbox, "state"), spaceBase: join(sandbox, "spaces"), loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir, settingsManager }; } } };
  let api = await startLocalApi(options);
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", { method: "POST", body: { name: "Quotes" } });
    await writePackage(join(space.spaceRoot, "app"));
    const manifestPath = join(space.spaceRoot, "app", "agent-app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assistantActions = [{ id: "compare", title: "Compare quotes", instructions: "Compare the quote and write comparison.md.", inputSchema: {
      type: "object", properties: { quote: { type: "string", maxLength: 1_000 } }, required: ["quote"], additionalProperties: false } }];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const base = `/api/spaces/${space.id}/restricted-apps`;
    const { review: packageReview } = await request<{ review: { digest: string } }>(api.origin, `${base}/inspect`, { method: "POST", body: { sourcePath: "app" } });
    const { app } = await request<{ app: RestrictedAppInstalled }>(api.origin, base, { method: "POST", body: { sourcePath: "app", expectedDigest: packageReview.digest } });
    const pin = { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest };
    const scope = { spaceId: app.spaceId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority) };
    const taskBase = `${base}/mail-app/assistant-tasks`;
    const query = new URLSearchParams(pin);
    const input = { actionId: "compare", input: { quote: "North $42" }, requestId: randomUUID(), requestedAt: new Date().toISOString() };
    const started = await api.appAssistantTasks.request(scope, input);
    assert.equal(started.status, "running", "a request starts its Chat in the same call");
    assert.ok(started.startedAt);
    assert.equal("approvedAt" in started, false);
    const { detail } = await request<{ detail: RestrictedAppTaskDetail }>(api.origin, `${taskBase}/${input.requestId}?${query}`);
    assert.equal(detail.conversationId, `chat-app-${started.id}`);
    assert.equal(detail.instructions, "Compare the quote and write comparison.md.");
    const approve = await fetch(`${api.origin}${taskBase}/${input.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pin) });
    assert.ok(!approve.ok, "there is no approval route");
    for (const body of [{ ...pin, featureInstallationId: undefined }, { ...pin, content: "hidden" }]) {
      const denied = await fetch(`${api.origin}${taskBase}/${input.requestId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(!denied.ok);
    }
    async function waitForTask(requestId: string, status: string) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const task = await api.appAssistantTasks.get(scope, requestId);
        if (task.status === status) return task;
        if (["failed", "interrupted"].includes(task.status)) assert.fail(`Unexpected task state: ${task.status}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`Task did not become ${status}`);
    }
    const done = await waitForTask(input.requestId, "succeeded");
    assert.equal(done.id, started.id);
    assert.match(done.result!.text, /Saved comparison.md/);
    assert.equal(await readFile(join(space.spaceRoot, "comparison.md"), "utf8"), "# Comparison\nNorth: $42\n");
    const journal = (await readFile(join(sandbox, "state", "turns", "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completedTurn = journal.filter((record) => record.conversationId === `chat-app-${started.id}` && record.status === "succeeded").at(-1);
    assert.deepEqual(completedTurn.fileChanges.files.map((file: { path: string }) => file.path), ["comparison.md"], "the actual Pi write has durable History-derived navigation evidence");
    assert.ok(bodies.some((body) => body.includes("App request: Compare quotes")), "ordinary Pi sees the app's request");
    assert.ok((await listSpaceCheckpoints(space.spaceRoot)).length > 0, "the ordinary turn captures History");
    const listed = (await request<{ tasks: RestrictedAppAssistantTask[] }>(api.origin, `${taskBase}?${query}`)).tasks[0]!;
    assert.equal(listed.result, undefined, "list replies remain compact");
    assert.equal(listed.startedAt, started.startedAt);
    const calls = bodies.length;
    await api.close();
    api = await startLocalApi(options);
    assert.equal((await api.appAssistantTasks.request(scope, input)).status, "succeeded", "a replayed envelope returns the settled record");
    assert.equal(bodies.length, calls, "restart/replay does not make another provider request");
    hold = true;
    const next = await api.appAssistantTasks.request(scope, { ...input, requestId: randomUUID(), requestedAt: new Date().toISOString() });
    assert.equal(next.status, "running");
    await providerEntered;
    const removal = await fetch(`${api.origin}${base}/mail-app`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(pin) });
    assert.equal(removal.status, 409, "capability mutation cannot overtake an accepted Space turn");
    const stopping = await request<{ task: RestrictedAppAssistantTask }>(api.origin, `${taskBase}/${next.requestId}/cancel`, { method: "POST", body: pin });
    assert.equal(stopping.task.cancellationRequested, true);
    assert.equal((await waitForTask(next.requestId, "cancelled")).result, undefined);
    assert.equal((await api.appAssistantTasks.get(scope, input.requestId)).status, "succeeded");
  } finally {
    await api.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("app inference runs on the Space's configured model with no Chat and leaves receipts", { timeout: 45_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-inference-api-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const bodies: string[] = [];
  let toolArguments = JSON.stringify({ total: 42 });
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `completion-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "app-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (body.includes("submit_result")) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "result_1", type: "function", function: { name: "submit_result", arguments: toolArguments } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "North is cheapest." });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as AddressInfo).port;
  await writeFile(join(agentDir, "extensions", "app-provider.ts"), `export default function(pi) { pi.registerProvider("app-provider", { api: "openai-completions", baseUrl: "http://127.0.0.1:${providerPort}/v1", apiKey: "synthetic", models: [{ id: "app-model", name: "App Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] }); }`);
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "app-provider", defaultModel: "app-model", defaultThinkingLevel: "off" });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "spaces"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir, settingsManager }; } },
  });
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", { method: "POST", body: { name: "Quotes" } });
    await writePackage(join(space.spaceRoot, "app"));
    const base = `/api/spaces/${space.id}/restricted-apps`;
    const { review } = await request<{ review: { digest: string } }>(api.origin, `${base}/inspect`, { method: "POST", body: { sourcePath: "app" } });
    const { app } = await request<{ app: RestrictedAppInstalled }>(api.origin, base, { method: "POST", body: { sourcePath: "app", expectedDigest: review.digest } });
    const scope = { spaceId: app.spaceId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId,
      digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority) };

    const text = await api.appInference.infer(scope, "view", { instructions: "Name the cheapest quote.", input: "North $42, South $58" });
    assert.deepEqual(Object.keys(text).sort(), ["model", "text", "truncated", "usage"]);
    assert.equal((text as { text: string }).text, "North is cheapest.");
    assert.deepEqual((text as { model: { provider: string; id: string } }).model, { provider: "app-provider", id: "app-model" });
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]!.includes("North $42, South $58"), "the app's input is the only user message");
    assert.ok(!bodies[0]!.includes("App request:"), "bounded inference never carries a Chat prompt");
    assert.ok(!bodies[0]!.includes("\"tools\""), "no tools reach the model without a schema");
    assert.equal((await listSpaceCheckpoints(space.spaceRoot)).length, 0, "a bounded call is not a turn and captures no History");
    assert.deepEqual(await request<{ conversations: unknown[] }>(api.origin, `/api/spaces/${space.id}/conversations`).then((value) => value.conversations), [], "no Chat is created");

    const outputSchema = { type: "object", properties: { total: { type: "integer", minimum: 0 } }, required: ["total"], additionalProperties: false };
    const json = await api.appInference.infer(scope, "worker", { instructions: "Total the quotes.", input: "North $42", outputSchema });
    assert.deepEqual((json as { json: unknown }).json, { total: 42 });
    assert.ok(bodies[1]!.includes("submit_result"), "a schema rides as the one result tool");

    // A model that answers outside the requested shape is refused, not passed through.
    toolArguments = JSON.stringify({ total: 42, extra: true });
    const mismatch = await api.appInference.infer(scope, "view", { instructions: "Total the quotes.", input: "North $42", outputSchema })
      .then(() => null, (error: unknown) => error as { code?: string });
    assert.equal(mismatch?.code, "INFER_OUTPUT_INVALID");

    const receipts = (await request<{ receipts: Array<Record<string, unknown>> }>(
      api.origin,
      `${base}/mail-app/inference-receipts?${new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest })}`,
    )).receipts;
    assert.equal(receipts.length, 6, "an accepted and a terminal line for each of the three calls");
    assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["error", "accepted", "ok", "accepted", "ok", "accepted"]);
    const settled = receipts.find((receipt) => receipt.outcome === "ok")!;
    assert.deepEqual(settled.model, { provider: "app-provider", id: "app-model" });
    assert.equal(typeof (settled.usage as { inputTokens: number }).inputTokens, "number");
    assert.equal(receipts.every((receipt) => JSON.stringify(receipt).includes("North $42") === false), true, "receipts record sizes, never app content");

    const stale = await fetch(`${api.origin}${base}/mail-app/inference-receipts?featureInstallationId=${app.featureInstallationId}`);
    assert.equal(stale.ok, false, "receipt reads name an exact installation and revision");
  } finally {
    await api.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("desktop Check selection composes the canonical Check service with exact app controls", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-selected-check-api-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), spaceBase: join(sandbox, "spaces"), loadEnv: false });
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", { method: "POST", body: { name: "Check access" } });
    const base = `/api/spaces/${space.id}`;
    await writePackage(join(space.spaceRoot, "app"));
    const manifestPath = join(space.spaceRoot, "app", "agent-app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.permissions.checks = [{ id: "review", title: "Handoff review" }];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { review } = await request<{ review: { digest: string } }>(api.origin, `${base}/restricted-apps/inspect`, { method: "POST", body: { sourcePath: "app" } });
    const { app } = await request<{ app: RestrictedAppInstalled }>(api.origin, `${base}/restricted-apps`, { method: "POST", body: { sourcePath: "app", expectedDigest: review.digest } });
    const check = await request<{ declaration: { id: string }; digest: string }>(api.origin, `${base}/checks/configure`, { method: "POST", body: { proposal: {
      kind: "work-fold.check-proposal", version: 1, name: "Handoff", createdBy: "human", createdAt: "2026-09-06T00:00:00.000Z",
      check: { title: "Handoff exists", severity: "error", trigger: "manual", sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } }, targets: [{ kind: "file", role: "primary", path: "handoff.txt" }] },
    } } });
    const path = `${base}/restricted-apps/mail-app/permissions/checks/review`;
    const body = { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, checkId: check.declaration.id, declarationDigest: check.digest };
    const allowed = await request<{ app: RestrictedAppInstalled }>(api.origin, path, { method: "PUT", body });
    assert.equal(allowed.app.checkGrants?.[0]?.checkId, check.declaration.id);
    const { overview } = await request<{ overview: { status: { enabled: number; running: number }; findings: unknown[] } }>(api.origin, `${base}/checks/overview`, { method: "POST", body: {} });
    assert.equal(overview.status.enabled, 0, "selecting results does not enable the Check");
    assert.equal(overview.status.running, 0);
    assert.deepEqual(overview.findings, []);
    for (const invalid of [{ ...body, featureInstallationId: undefined }, { ...body, declarationDigest: "0".repeat(64) }, { ...body, checkId: "foreign" }]) {
      const response = await fetch(`${api.origin}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid) });
      assert.equal(response.ok, false);
    }
    const revoked = await request<{ app: RestrictedAppInstalled }>(api.origin, path, { method: "DELETE", body });
    assert.deepEqual(revoked.app.checkGrants ?? [], []);
  } finally { await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
