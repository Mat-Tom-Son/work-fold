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
import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";

const workspaceId = "ws-proposal11111111";

test("propose_space_app exposes only a Space-relative path and returns the host-authored pending receipt", async () => {
  const calls: unknown[] = [];
  const host: RestrictedAppProposalHost = {
    async propose(input): Promise<RestrictedAppProposalResult> {
      calls.push(input);
      return {
        status: "pending",
        proposal: proposalFixture(input),
      };
    },
  };
  const tool = createRestrictedAppProposalTool({
    workspaceId,
    workspaceRoot: "C:\\Space",
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
  assert.match(guidance, /workspaceRestrictedApp/);
  assert.match(guidance, /handleAutomation/);
  assert.match(guidance, /oauth2-pkce/);

  const result = await tool.execute("call-1", { sourcePath: " apps/mail " }, undefined, undefined, {} as any);
  assert.deepEqual(calls, [{ workspaceId, workspaceRoot: "C:\\Space", conversationId: "chat-1", sourcePath: "apps/mail" }]);
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /human review/i);
  assert.match(text, /no code was executed or installed/i);
  assert.match(text, /no network, file, or notification access, credential, or automation was enabled/i);
});

test("proposal receipts persist, remain Chat-bound, and install only the exact reviewed revision with grants off", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-app-proposals-"));
  const workspaceRoot = join(sandbox, "space");
  const stateRoot = join(sandbox, "state", "restricted-apps");
  const registryPath = join(stateRoot, "proposals.json");
  try {
    await writePackage(join(workspaceRoot, "apps", "mail"));
    const service = await RestrictedAppService.create({ rootPath: stateRoot });
    const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath });
    const emitted: string[] = [];
    host.on("request", (proposal) => emitted.push(proposal.id));

    const result = await host.propose({ workspaceId, workspaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(result.status, "pending");
    assert.ok(result.proposal);
    assert.deepEqual(emitted, [result.proposal.id]);
    assert.deepEqual(await service.list(workspaceId), [], "proposal inspection must not install the app");
    assert.equal((await host.list({ workspaceId, conversationId: "chat-1" })).length, 1);
    assert.equal((await host.list({ workspaceId, conversationId: "chat-2" })).length, 0);

    const reopened = await RoutedRestrictedAppProposalHost.create({ service, registryPath });
    assert.equal((await reopened.get(result.proposal.id))?.review.digest, result.proposal.review.digest);
    const installed = await reopened.install(result.proposal.id);
    assert.ok(installed);
    assert.equal(installed.digest, result.proposal.review.digest);
    assert.deepEqual(installed.networkGrants, []);
    assert.equal((await reopened.get(result.proposal.id))?.status, "installed");
    assert.equal((await reopened.install(result.proposal.id))?.digest, installed.digest, "install decision is idempotent");
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("proposal installation fails closed after source changes and dismissal cannot install", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-app-proposal-change-"));
  const workspaceRoot = join(sandbox, "space");
  const sourceRoot = join(workspaceRoot, "apps", "mail");
  const stateRoot = join(sandbox, "state", "restricted-apps");
  try {
    await writePackage(sourceRoot);
    const service = await RestrictedAppService.create({ rootPath: stateRoot });
    const host = await RoutedRestrictedAppProposalHost.create({ service, registryPath: join(stateRoot, "proposals.json") });
    const changed = await host.propose({ workspaceId, workspaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    await writeFile(join(sourceRoot, "app.js"), "export async function handleAction() { return { count: 2 }; }\n", "utf8");
    await assert.rejects(host.install(changed.proposal!.id), /changed after review/i);
    assert.equal((await host.get(changed.proposal!.id))?.status, "revision-changed");
    assert.deepEqual(await service.list(workspaceId), []);

    const dismissed = await host.propose({ workspaceId, workspaceRoot, conversationId: "chat-1", sourcePath: "apps/mail" });
    assert.equal(await host.dismiss(dismissed.proposal!.id), true);
    assert.equal((await host.get(dismissed.proposal!.id))?.status, "dismissed");
    assert.equal(await host.install(dismissed.proposal!.id), null);
    await service.close();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "proposal-mail",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify({
      version: 2,
      id: "proposal-mail",
      title: "Proposal mail",
      runtime: { kind: "sandboxed-web", entry: "index.html" },
      ui: { icon: "mail" },
      tools: [],
      automations: [],
      permissions: { network: [] },
    }), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8"),
    writeFile(join(root, "app.js"), "export {};\n", "utf8"),
  ]);
}

function proposalFixture(input: { workspaceId: string; workspaceRoot: string; conversationId: string; sourcePath: string }) {
  const now = "2026-07-13T12:00:00.000Z";
  return {
    ...input,
    id: "proposal-1",
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
    review: {
      packageName: "proposal-mail",
      version: "0.1.0",
      digest: "a".repeat(64),
      manifest: {
        version: 2 as const,
        id: "proposal-mail",
        title: "Proposal mail",
        runtime: { kind: "sandboxed-web" as const, entry: "index.html" },
        ui: { icon: "mail" },
        tools: [],
        automations: [],
        permissions: { network: [] },
      },
      fileCount: 4,
      totalBytes: 100,
    },
  };
}
