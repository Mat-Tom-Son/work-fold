import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
import { FileRestrictedAppStorage } from "../src/local/agent/restricted-app-storage.js";
import { startLocalApi } from "../src/local/server.js";

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
    assert.deepEqual(installed.app.networkGrants, []);
    assert.deepEqual(installed.app.fileGrants, []);
    assert.deepEqual(installed.app.notificationGrants, []);
    assert.deepEqual(installed.app.automations, [{ id: "refresh-mail", enabled: false }]);

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
    assert.deepEqual(fileGranted.app.fileGrants, [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }]);

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
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("machine-wide automation ledgers feed the glance and the restore fence, and a decided file grant binds to the person-chosen root", async () => {
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

    // Phase B: the app.grant.files decision binds to the person-chosen root
    // supplied at decide time; without one the approval refuses before
    // anything is consumed, and a malformed root refuses at the route.
    const staged = await api.stagedActs.stage({
      kind: "app.grant.files",
      parameters: { spaceId: space.id, appInstanceId: installed.app.featureInstallationId, declarationId: "exports" },
      pins: {
        appInstanceId: installed.app.featureInstallationId,
        declarationId: "exports",
        releaseDigest: installed.app.digest,
      },
      provenance: { stagedVia: "act-cli", requestId: "req-grant-files" },
    });
    const withoutRoot = await fetch(`${api.origin}/api/management/decisions/${staged.act.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", surface: "main-window" }),
    });
    assert.equal(withoutRoot.status, 409);
    assert.equal(((await withoutRoot.json()) as { code?: string }).code, "NOT_ELIGIBLE");
    for (const badRoot of ["../escape", ".work-fold/inner", "reports\\nested", "", "a//b"]) {
      const refused = await fetch(`${api.origin}/api/management/decisions/${staged.act.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", surface: "main-window", fileGrantRoot: badRoot }),
      });
      assert.equal(refused.status, 400, `root ${JSON.stringify(badRoot)} must be refused`);
    }
    const rootOnDenial = await fetch(`${api.origin}/api/management/decisions/${staged.act.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "denied", surface: "main-window", fileGrantRoot: "reports" }),
    });
    assert.equal(rootOnDenial.status, 400, "a chosen folder accompanies only an approval");
    const approved = await fetch(`${api.origin}/api/management/decisions/${staged.act.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", surface: "main-window", fileGrantRoot: "reports" }),
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const approvedCard = (await approved.json()) as { decision: { state: string; execution?: { outcome?: string } } };
    assert.equal(approvedCard.decision.state, "approved");
    assert.equal(approvedCard.decision.execution?.outcome, "executed");
    const grantedApps = await service.list(space.id);
    assert.deepEqual(
      grantedApps[0]?.fileGrants,
      [{ id: "exports", declarationId: "exports", root: "reports", access: "read-write" }],
      "the decided grant carries exactly the person-chosen root",
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

    const result = await proposals.propose({
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      conversationId: first.conversation.id,
      sourcePath: "tools/mail-app",
    });
    assert.equal(result.status, "pending");
    const proposalId = result.proposal!.id;

    const owned = await request<{ proposals: Array<{ id: string; sourcePath: string; spaceRoot?: string; status: string }> }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals`,
    );
    assert.deepEqual(owned.proposals.map(({ id, sourcePath, status }) => ({ id, sourcePath, status })), [{ id: proposalId, sourcePath: "tools/mail-app", status: "pending" }]);
    assert.equal("spaceRoot" in owned.proposals[0]!, false, "machine paths stay outside renderer proposal payloads");
    assert.deepEqual((await request<{ proposals: unknown[] }>(api.origin, `/api/spaces/${space.id}/conversations/${second.conversation.id}/restricted-app-proposals`)).proposals, []);

    const wrongChat = await fetch(`${api.origin}/api/spaces/${space.id}/conversations/${second.conversation.id}/restricted-app-proposals/${proposalId}/install`, { method: "POST" });
    assert.equal(wrongChat.status, 404);

    const installed = await request<{ app: { digest: string; networkGrants: string[] }; proposal: { status: string } }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals/${proposalId}/install`,
      { method: "POST" },
    );
    assert.equal(installed.app.digest, result.proposal!.review.digest);
    assert.deepEqual(installed.app.networkGrants, []);
    assert.equal(installed.proposal.status, "installed");

    const dismissedResult = await proposals.propose({ spaceId: space.id, spaceRoot: space.spaceRoot, conversationId: first.conversation.id, sourcePath: "tools/mail-app" });
    const dismissed = await request<{ dismissed: boolean }>(
      api.origin,
      `/api/spaces/${space.id}/conversations/${first.conversation.id}/restricted-app-proposals/${dismissedResult.proposal!.id}`,
      { method: "DELETE" },
    );
    assert.equal(dismissed.dismissed, true);
    assert.equal((await proposals.get(dismissedResult.proposal!.id))?.status, "dismissed");
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
