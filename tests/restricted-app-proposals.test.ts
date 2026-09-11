import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRestrictedAppProposalTool } from "../src/local/agent/pi-client.js";
import {
  RoutedRestrictedAppProposalHost,
  type RestrictedAppProposalHost,
  type RestrictedAppProposalResult,
} from "../src/local/agent/restricted-app-proposals.js";
import { RestrictedAppService, type RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";

const spaceId = "ws-proposal11111111";

test("propose_space_app exposes only a Space-relative path and reports what was added and what still needs a person", async () => {
  const calls: unknown[] = [];
  const host: RestrictedAppProposalHost = {
    async propose(input): Promise<RestrictedAppProposalResult> {
      calls.push(input);
      const proposal = proposalFixture(input);
      return { status: "installed", proposal, app: proposal.installedApp, needs: proposal.needs };
    },
  };
  const tool = createRestrictedAppProposalTool({
    spaceId,
    spaceRoot: "C:\\Space",
    conversationId: "chat-1",
    host,
  });

  assert.equal(tool.name, "propose_space_app");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(Object.keys((tool.parameters as any).properties), ["sourcePath"]);
  assert.equal((tool.parameters as any).additionalProperties, false);
  const guidance = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidance, /cornerRadius is an optional whole number from 0 through 24/);
  assert.match(guidance, /agent-app\.json version 2/);
  assert.match(guidance, /workFoldRestrictedApp/);
  assert.match(guidance, /handleAutomation/);
  assert.match(guidance, /oauth2-pkce/);
  assert.match(guidance, /assistantActions/);
  assert.match(guidance, /assistant\.request/);
  assert.match(guidance, /assistant\.infer/);
  assert.match(guidance, /permissions\.checks/);
  assert.match(guidance, /64 KiB/);
  assert.match(guidance, /256 KiB/);
  assert.match(guidance, /on when added|Installed apps come up with every declared destination/i);
  assert.doesNotMatch(guidance, /human review|remain separate human actions/);
  assert.doesNotMatch(tool.description, /human review|for review|review proposal/i);

  const result = await tool.execute("call-1", { sourcePath: " apps/mail " }, undefined, undefined, {} as any);
  assert.deepEqual(calls, [{ spaceId, spaceRoot: "C:\\Space", conversationId: "chat-1", sourcePath: "apps/mail" }]);
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /added Proposal mail as this Space's local preview/);
  assert.match(text, /On now: 1 destination, 1 folder permission over the whole Space, 0 notifications, 1 automation/);
  assert.match(text, /Still needs you: connect mail-api in Apps → Proposal mail → Access & connections/);
  assert.match(text, /available from the next turn/);
  assert.doesNotMatch(text, /human review|no code was executed/i);
});

test("propose_space_app reports a failed install plainly and a cancelled one as nothing added", async () => {
  const failed = createRestrictedAppProposalTool({ spaceId, spaceRoot: "/space", conversationId: "chat-1", host: {
    async propose(input) { return { status: "failed", proposal: { ...proposalFixture(input), status: "failed", error: "A different package already owns this app id." } }; },
  } });
  const failedText = (await failed.execute("call-2", { sourcePath: "apps/mail" }, undefined, undefined, {} as any)).content.find((item) => item.type === "text")?.text ?? "";
  assert.match(failedText, /could not add Proposal mail: A different package already owns this app id\./);
  assert.match(failedText, /Fix the package and propose again/);
  const cancelled = createRestrictedAppProposalTool({ spaceId, spaceRoot: "/space", conversationId: "chat-1", host: {
    async propose() { return { status: "cancelled" }; },
  } });
  const cancelledText = (await cancelled.execute("call-3", { sourcePath: "apps/mail" }, undefined, undefined, {} as any)).content.find((item) => item.type === "text")?.text ?? "";
  assert.match(cancelledText, /cancelled\. Nothing was added\./);
});

test("proposal receipts persist, remain Chat-bound, and install the exact revision immediately with every declared power on", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-proposals-"));
  const spaceRoot = join(sandbox, "space");
  const stateRoot = join(sandbox, "state", "restricted-apps");
  const registryPath = join(stateRoot, "proposals.json");
  try {
    await writePackage(join(spaceRoot, "apps", "mail"));
    const service = await RestrictedAppService.create({ rootPath: stateRoot });
    const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath });
    const emitted: string[] = [];
    const settled: string[] = [];
    host.on("request", (proposal) => emitted.push(proposal.id));
    host.on("settled", ({ proposal }) => settled.push(`${proposal.id}:${proposal.status}`));

    const result = await host.propose({ spaceId, spaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(result.status, "installed");
    assert.ok(result.proposal);
    assert.ok(result.app);
    assert.deepEqual(emitted, [result.proposal.id]);
    assert.deepEqual(settled, [`${result.proposal.id}:installed`]);
    assert.equal(result.proposal.status, "installed");
    assert.deepEqual(result.needs, { connections: ["mail-api"], files: ["notes"], checks: [] }, "a secret and a file choice still need the person");
    assert.deepEqual(result.proposal.needs, result.needs, "the receipt records the needs");
    const [installed] = await service.list(spaceId);
    assert.equal(installed?.digest, result.proposal.review.digest, "the proposal installs the preview in the same call");
    assert.deepEqual(installed?.networkGrants, ["mail-api"]);
    assert.deepEqual(installed?.fileGrants, [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }]);
    assert.equal(installed?.automations[0]?.enabled, true);
    assert.equal((await host.list({ spaceId, conversationId: "chat-1" })).length, 1);
    assert.equal((await host.list({ spaceId, conversationId: "chat-2" })).length, 0);

    const reopened = await RoutedRestrictedAppProposalHost.create({ service, registryPath });
    assert.equal((await reopened.get(result.proposal.id))?.status, "installed");
    assert.equal((await reopened.install(result.proposal.id))?.digest, installed?.digest, "install stays idempotent");
    const again = await reopened.propose({ spaceId, spaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(again.status, "installed");
    assert.equal(again.proposal?.id, result.proposal.id, "the same source and revision reuse the installed receipt");
    assert.equal((await service.list(spaceId)).length, 1);
    assert.equal(await reopened.dismiss(result.proposal.id), false, "an installed receipt is not dismissable");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a changed source installs its new revision; a failing install records failed with a plain error and can be dismissed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-proposal-change-"));
  const spaceRoot = join(sandbox, "space");
  const sourceRoot = join(spaceRoot, "apps", "mail");
  const stateRoot = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({ rootPath: stateRoot });
    const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath: join(stateRoot, "proposals.json") });
    const first = await host.propose({ spaceId, spaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(first.status, "installed");
    await writeFile(join(sourceRoot, "app.js"), "export async function handleAction() { return { count: 2 }; }\n", "utf8");
    const second = await host.propose({ spaceId, spaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(second.status, "installed");
    assert.notEqual(second.proposal?.id, first.proposal?.id);
    assert.notEqual(second.app?.digest, first.app?.digest);
    assert.equal((await service.list(spaceId))[0]?.digest, second.app?.digest, "the new revision replaces the preview");

    await writePackage(join(spaceRoot, "apps", "takeover"), { packageName: "another-package" });
    const failed = await host.propose({ spaceId, spaceRoot, conversationId: "chat-1", sourcePath: "apps/takeover" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.proposal?.status, "failed");
    assert.match(failed.proposal?.error ?? "", /different package already owns/i);
    assert.equal((await service.list(spaceId))[0]?.digest, second.app?.digest, "a failed proposal changes nothing");
    await assert.rejects(host.install(failed.proposal!.id), /different package already owns/i, "retrying a failed receipt reports the same cause");
    assert.equal(await host.dismiss(failed.proposal!.id), true);
    assert.equal((await host.get(failed.proposal!.id))?.status, "dismissed");
    assert.equal(await host.install(failed.proposal!.id), null);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the host defers the install to the supplied installer and records a thrown installer as failed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-proposal-installer-"));
  const spaceRoot = join(sandbox, "space");
  const stateRoot = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(join(spaceRoot, "apps", "mail"));
    const service = await RestrictedAppService.create({ rootPath: stateRoot });
    const contexts: unknown[] = [];
    let mode: "install" | "throw" = "throw";
    const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath: join(stateRoot, "proposals.json"),
      installNow: async (id, context) => {
        contexts.push(context);
        if (mode === "throw") throw new Error("Other work in this Space did not finish in time.");
        return host.install(id);
      } });
    const first = await host.propose({ spaceId, spaceRoot, conversationId: "chat-9", sourcePath: "apps/mail" });
    assert.deepEqual(contexts, [{ spaceId, conversationId: "chat-9" }]);
    assert.equal(first.status, "failed");
    assert.equal(first.proposal?.status, "pending", "an installer that never reached the service leaves the receipt pending for a retry");
    assert.deepEqual(await service.list(spaceId), []);
    mode = "install";
    const retried = await host.propose({ spaceId, spaceRoot, conversationId: "chat-9", sourcePath: "apps/mail" });
    assert.equal(retried.status, "installed");
    assert.equal(retried.proposal?.id, first.proposal?.id);
    assert.equal((await service.list(spaceId)).length, 1);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writePackage(root: string, options: { packageName?: string } = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: options.packageName ?? "proposal-mail",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify({
      version: 2,
      id: "proposal-mail",
      title: "Proposal mail",
      runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
      ui: { icon: "mail" },
      tools: [],
      automations: [{
        id: "refresh", title: "Refresh", handler: "refresh", trigger: { kind: "interval", intervalMinutes: 30 },
        permissions: { network: ["mail-api"], files: [], notifications: [] }, catchUp: "none", overlap: "skip",
      }],
      permissions: {
        network: [{ id: "mail-api", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "api-key", header: "x-api-key" }] }],
        files: [{ id: "exports", target: "directory", access: "read-write" }, { id: "notes", target: "file", access: "read" }],
      },
    }), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8"),
    writeFile(join(root, "app.js"), "export {};\n", "utf8"),
    writeFile(join(root, "worker.js"), "export async function handleAutomation() {}\n", "utf8"),
  ]);
}

function proposalFixture(input: { spaceId: string; spaceRoot: string; conversationId: string; sourcePath: string }) {
  const now = "2026-07-13T12:00:00.000Z";
  const manifest = {
    version: 2 as const,
    id: "proposal-mail",
    title: "Proposal mail",
    runtime: { kind: "sandboxed-web" as const, entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [],
    automations: [{ id: "refresh", title: "Refresh", handler: "refresh", trigger: { kind: "interval" as const, intervalMinutes: 30 },
      permissions: { network: ["mail-api"], files: [], notifications: [] }, catchUp: "none" as const, overlap: "skip" as const }],
    permissions: {
      network: [{ id: "mail-api", target: { kind: "public-https" as const, origin: "https://mail.example.com" }, methods: ["GET" as const], auth: [{ kind: "api-key" as const, header: "x-api-key" }] }],
      files: [{ id: "exports", target: "directory" as const, access: "read-write" as const }],
      notifications: [],
    },
  };
  const review = { packageName: "proposal-mail", version: "0.1.0", digest: "a".repeat(64), artifactDigest: `work-fold.artifact.v1:sha256:${"a".repeat(64)}`, manifest, fileCount: 4, totalBytes: 100 };
  const installedApp = {
    ...review,
    spaceId: input.spaceId, sourceSpaceId: input.spaceId, projectId: "project_1", tenantId: "tenant_1", principalId: "principal_1",
    runtimeInstanceId: "runtime-instance_1", runtimeInstanceKind: "development", releaseDigest: null,
    featureInstallationId: "feature-installation_1", dataNamespaceId: "data-namespace_1",
    authority: {} as never,
    networkGrants: ["mail-api"], fileGrants: [{ id: "exports", declarationId: "exports", root: ".", access: "read-write" }], notificationGrants: [],
    automations: [{ id: "refresh", enabled: true }], installedAt: now, updatedAt: now,
  } as unknown as RestrictedAppInstalled;
  return {
    ...input,
    id: "proposal-1",
    status: "installed" as const,
    createdAt: now,
    updatedAt: now,
    review,
    installedApp,
    needs: { connections: ["mail-api"], files: [], checks: [] },
  };
}
