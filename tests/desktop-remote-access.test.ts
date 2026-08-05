import assert from "node:assert/strict";
import { test } from "node:test";

import { RemoteAccessClient } from "../desktop/src/remote-access.js";
import type { WorkFoldRemoteFacade, WorkFoldRemotePrincipal } from "../src/local/remote-management.js";

function clientFor(
  facade: WorkFoldRemoteFacade,
  events: string[],
): RemoteAccessClient {
  return new RemoteAccessClient({
    settingsStore: {
      async removeRemoteBrowserGrant(grantId: string) { events.push(`remove:${grantId}`); },
      async clearRemoteBrowserGrants() { events.push("remove:all"); },
    } as never,
    facade,
    promptPairing: async () => false,
  });
}

test("remote revocation stops every tracked management and Space task before purging uploads", async () => {
  const events: string[] = [];
  const operations: Array<{ operation: string; input: unknown }> = [];
  const facade: WorkFoldRemoteFacade = {
    async execute(operation, input) {
      operations.push({ operation, input });
      if (operation === "management.stop") return { stopped: { managementAborted: true, children: [] } };
      if (operation === "spaces.stop") return { stopped: true };
      throw new Error(`Unexpected operation: ${operation}`);
    },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };

  for (let index = 0; index < 70; index += 1) {
    client.rememberActiveTask("grant-1", "management.send", { taskId: `management-${index}` }, principal);
  }
  client.rememberActiveTask(
    "grant-1",
    "spaces.send",
    { taskId: "space-task", space: { id: "space-1" } },
    principal,
  );

  await client.revokeLocalGrant("grant-1");

  assert.equal(operations.filter((entry) => entry.operation === "management.stop").length, 70, "tracking never silently evicts an older live task");
  assert.deepEqual(
    operations.find((entry) => entry.operation === "spaces.stop")?.input,
    { taskId: "space-task", spaceId: "space-1" },
  );
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});

test("remote revocation still purges staged uploads when stopping a task fails", async () => {
  const events: string[] = [];
  const facade: WorkFoldRemoteFacade = {
    async execute() { throw new Error("stop failed"); },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  client.rememberActiveTask(
    "grant-1",
    "spaces.send",
    { taskId: "space-task", space: { id: "space-1" } },
    { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" },
  );

  await assert.rejects(() => client.revokeLocalGrant("grant-1"), /stop failed/);
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});
