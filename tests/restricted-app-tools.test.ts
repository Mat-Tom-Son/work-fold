import assert from "node:assert/strict";
import test from "node:test";

import { createRestrictedAppTools } from "../src/local/agent/pi-client.js";
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
  spaceId: "space-one",
  sourceSpaceId: "space-one",
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

test("installed app actions become namespaced Pi tools bound to Space, app, digest, and action", async () => {
  const calls: unknown[] = [];
  const tools = createRestrictedAppTools({
    spaceId: "space-one",
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
  assert.deepEqual(calls, [{ spaceId: "space-one", appId: "connected-inbox", featureInstallationId: installed.featureInstallationId, expectedDigest: digest, action: "search", input: { query: "release" } }]);
  assert.deepEqual(result.content, [{ type: "text", text: '{"count":3}' }]);
});

test("app tools distinguish sibling installations of identical bytes and remain deterministic", async () => {
  const other = structuredClone(installed);
  other.featureInstallationId = parseFeatureInstallationId("feature-installation_other");
  other.runtimeInstanceId = parseRuntimeInstanceId("runtime-instance_other");
  other.runtimeInstanceKind = "app";
  const tools = createRestrictedAppTools({ spaceId: "space-one", apps: [installed, other], service: { invoke: async () => ({ count: 0 }) } });
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 2);
  assert.ok(tools.every((tool) => tool.name.length <= 64));
  assert.match(tools[0]!.label, /preview/);
  assert.doesNotMatch(tools[1]!.label, /preview/);
  assert.deepEqual(createRestrictedAppTools({ spaceId: "space-one", apps: [installed, other], service: { invoke: async () => ({ count: 0 }) } }).map((tool) => tool.name), tools.map((tool) => tool.name));
  const longNames = structuredClone(installed);
  longNames.manifest.tools = ["a", "b"].map((suffix) => ({ ...installed.manifest.tools[0]!, name: "x".repeat(60) + suffix }));
  const longTools = createRestrictedAppTools({ spaceId: "space-one", apps: [longNames], service: { invoke: async () => ({ count: 0 }) } });
  assert.notEqual(longTools[0]!.name, longTools[1]!.name, "truncated display suffixes must not collide");
});
