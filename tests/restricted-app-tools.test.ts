import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiConversationClient, createRestrictedAppTools, restrictedAppToolTitles, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { appendMessage, readConversation } from "../src/local/agent/chat-store.js";
import { parseAppPlatformArtifactDigest } from "../src/local/agent/app-platform-artifact.js";
import {
  parseAuthorityStamp,
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseProjectId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "../src/local/agent/app-platform-contract.js";
import type { RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";

const digest = "a".repeat(64);
const installed: RestrictedAppInstalled = {
  workFolderId: "work-folder-one",
  sourceWorkFolderId: "work-folder-one",
  projectId: parseProjectId("project_fixture"),
  tenantId: parseTenantId("tenant_fixture"),
  principalId: parsePrincipalId("principal_fixture"),
  runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_fixture"),
  runtimeInstanceKind: "development",
  releaseDigest: null,
  featureInstallationId: parseFeatureInstallationId("feature-installation_fixture"),
  dataNamespaceId: parseDataNamespaceId("data-namespace_fixture"),
  authority: parseAuthorityStamp({
    runtimeInstanceGeneration: "runtime-1",
    featureInstallationGeneration: "installation-1",
    grantGeneration: "grant-1",
    connectionGeneration: "connection-1",
    jobGeneration: "job-1",
    principalGeneration: "principal-1",
    dataGeneration: "data-1",
  }),
  packageName: "connected-inbox",
  version: "1.0.0",
  digest,
  artifactDigest: parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"b".repeat(64)}`),
  fileCount: 4,
  totalBytes: 1024,
  networkGrants: ["mail-api"],
  fileGrants: [],
  notificationGrants: [],
  automations: [],
  installedAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  manifest: {
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search messages in the connected inbox.",
      action: "search",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      resultSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
    }],
    automations: [],
    permissions: { network: [{ id: "mail-api", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "none" }] }], files: [], notifications: [] },
  },
};

test("installed app actions become namespaced Pi tools bound to work-folder, app, digest, and action", async () => {
  const calls: unknown[] = [];
  const tools = createRestrictedAppTools({
    workFolderId: "work-folder-one",
    apps: [installed],
    service: {
      async invoke(input) {
        calls.push(structuredClone(input));
        return { count: 3 };
      },
    },
  });
  assert.equal(tools.length, 1);
  assert.match(tools[0]!.name, /^app_[a-f0-9]{16}_inbox_search$/);
  assert.match(tools[0]!.description, /Connected inbox/);
  const result = await tools[0]!.execute("call-1", { query: "release" }, undefined, undefined, {} as never);
  assert.deepEqual(calls, [{ workFolderId: "work-folder-one", appId: "connected-inbox", featureInstallationId: installed.featureInstallationId, expectedDigest: digest, action: "search", input: { query: "release" } }]);
  assert.deepEqual(result.content, [{ type: "text", text: '{"count":3}' }]);
});

test("app tools distinguish sibling installations of identical bytes and remain deterministic", async () => {
  const other = structuredClone(installed);
  other.featureInstallationId = parseFeatureInstallationId("feature-installation_other");
  other.runtimeInstanceId = parseRuntimeInstanceId("runtime-instance_other");
  other.runtimeInstanceKind = "app";
  const tools = createRestrictedAppTools({ workFolderId: "work-folder-one", apps: [installed, other], service: { invoke: async () => ({ count: 0 }) } });
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 2);
  assert.ok(tools.every((tool) => tool.name.length <= 64));
  assert.match(tools[0]!.label, /preview/);
  assert.doesNotMatch(tools[1]!.label, /preview/);
  assert.deepEqual(createRestrictedAppTools({ workFolderId: "work-folder-one", apps: [installed, other], service: { invoke: async () => ({ count: 0 }) } }).map((tool) => tool.name), tools.map((tool) => tool.name));
  const longNames = structuredClone(installed);
  longNames.manifest.tools = ["a", "b"].map((suffix) => ({ ...installed.manifest.tools[0]!, name: "x".repeat(60) + suffix }));
  const longTools = createRestrictedAppTools({ workFolderId: "work-folder-one", apps: [longNames], service: { invoke: async () => ({ count: 0 }) } });
  assert.notEqual(longTools[0]!.name, longTools[1]!.name, "truncated display suffixes must not collide");
});

test("an app tool's steps carry the app and tool names instead of the registered hash", async (t) => {
  const other = structuredClone(installed);
  other.featureInstallationId = parseFeatureInstallationId("feature-installation_other");
  other.runtimeInstanceKind = "app";
  const tools = createRestrictedAppTools({ workFolderId: "work-folder-one", apps: [installed, other], service: { invoke: async () => ({ count: 0 }) } });
  const titles = restrictedAppToolTitles([installed, other]);
  assert.deepEqual([...titles.keys()], tools.map((tool) => tool.name), "every registered app tool has a title");
  assert.equal(titles.get(tools[0]!.name), "Connected inbox (preview): Inbox search");
  assert.equal(titles.get(tools[1]!.name), "Connected inbox: Inbox search");

  const root = await mkdtemp(join(tmpdir(), "work-fold-app-tool-steps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new PiConversationClient("app-tool-steps", root);
  // Set as the session does when it registers the app's tools.
  (client as unknown as { appToolTitles: Map<string, string> }).appToolTitles = titles;
  const events: PiChatEvent[] = [];
  client.on("event", (event) => events.push(event));
  const native = (event: unknown) => (client as unknown as { handleSessionEvent(event: unknown): void }).handleSessionEvent(event);
  const name = tools[1]!.name;
  native({ type: "tool_execution_start", toolCallId: "app-1", toolName: name, args: { query: "invoices" } });
  native({ type: "tool_execution_end", toolCallId: "app-1", toolName: name, isError: false, result: { content: [{ type: "text", text: "{}" }] } });
  native({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "notes.md" } });
  const tool = events.filter((event) => event.type === "tool");
  assert.deepEqual(tool.map((event) => event.message), ["Connected inbox: Inbox search running", "Connected inbox: Inbox search finished", "Read running"]);
  assert.deepEqual(tool.map((event) => event.toolTitle), ["Connected inbox: Inbox search", "Connected inbox: Inbox search", undefined]);
  assert.ok(tool.every((event) => !/App [0-9a-f]{16}/i.test(event.message ?? "")), "no step message shows the hash");
  assert.equal(client.getTurnLivePresentation()?.workTrail[0]?.toolTitle, "Connected inbox: Inbox search");

  const trail = client.getTurnWorkTrail();
  assert.equal(trail[0]?.toolName, name, "the registered name stays the identity");
  assert.equal(trail[0]?.toolTitle, "Connected inbox: Inbox search");
  assert.equal(trail[1]?.toolTitle, undefined, "built-in tools keep their own verbs");
  await appendMessage(root, "saved", { id: "reply", role: "assistant", createdAt: "2026-10-11T12:00:00.000Z", content: "Found it.", workTrail: trail });
  assert.equal((await readConversation(root, "saved"))[0]?.workTrail?.[0]?.toolTitle, "Connected inbox: Inbox search", "the saved work trail keeps it");
});
