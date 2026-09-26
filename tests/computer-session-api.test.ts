import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { startLocalApi } from "../src/local/server.js";
import { ComputerSessionService } from "../src/local/agent/computer-session.js";
import type { WaylandTransport } from "../src/local/agent/wayland-transport.js";
import { appendMessage } from "../src/local/agent/chat-store.js";

test("desktop setup preserves a live Chat client, permits Stop during work, and revokes cold owners on removal", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "workfold-screen-setup-"));
  const agentDir = join(root, "pi"), included = join(root, "included");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(included);
  await writeFile(join(agentDir, "extensions/hold.ts"), `export default function(pi) {
    pi.registerCommand("hold-desktop-test", { description: "Disposable turn", handler: async () => { await new Promise(resolve => setTimeout(resolve, 300)); } });
  }`);
  let launched = 0, closed = 0;
  const service = new ComputerSessionService({ launch: async () => {
    launched++; let ended = false; const listeners = new Set<() => void>();
    return { call: async () => ({ state: "active", targetId: randomUUID(), devicesGranted: 3 }),
      close: async () => { if (!ended) { ended = true; closed++; for (const listener of listeners) listener(); } },
      onClose: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    } as WaylandTransport;
  } });
  const api = await startLocalApi({ port: 0, loadEnv: false, stateBase: join(root, "state"), spaceBase: join(root, "spaces"),
    piRuntimeProvider: { resolveRuntime: async () => ({ agentDir, authStorage: AuthStorage.inMemory(),
      includedTools: { rootPath: included, stateRoot: join(root, "included-state"), computerSession: service } }) },
  });
  async function post(path: string, body: object) {
    const response = await fetch(api.origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  async function settled(taskId: string) {
    for (let i = 0; i < 200; i++) {
      if ((await api.actFacade.manageTurnStatus({ taskId })).task.state !== "running") return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Fixture turn did not settle");
  }
  try {
    const space = (await api.actFacade.createSpace({ name: "Desktop fixture" })).space;
    const setup = (body: object) => post("/api/agent/included-tools/setup", { spaceId: space.id, id: "computer", ...body });
    assert.equal((await setup({ action: "share-screen", scope: "space", conversationId: "missing" })).status, 400);
    assert.equal(launched, 0);
    const warm = await api.actFacade.manageSend({ content: "/hold-desktop-test", newConversation: true });
    await settled(warm.taskId);
    const shared = await setup({ action: "share-screen", scope: "management", conversationId: warm.conversationId });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(service.status().state, "active", "setup must not invalidate its just-granted Chat");
    assert.equal(closed, 0);
    const running = await api.actFacade.manageSend({ content: "/hold-desktop-test", conversationId: warm.conversationId });
    assert.equal((await setup({ action: "stop-sharing" })).status, 200, "Stop is available during accepted work");
    assert.equal(service.status().state, "idle"); await settled(running.taskId);
    const chat = (await post(`/api/spaces/${space.id}/conversations`, {})).body.conversation;
    await appendMessage(space.spaceRoot, chat.id, { id: randomUUID(), role: "user", content: "Retained Chat fixture", createdAt: new Date().toISOString() });
    const cold = await setup({ action: "share-screen", scope: "space", conversationId: chat.id });
    assert.equal(cold.status, 200, JSON.stringify({ chat, response: cold.body }));
    await api.actFacade.chatArchive({ space: space.id, conversationId: chat.id });
    assert.equal(service.status().state, "idle", "archive revokes a grant even before Pi initializes that Chat");
    assert.equal((await setup({ action: "share-screen", scope: "space", conversationId: chat.id })).status, 400);
    await api.actFacade.chatResume({ space: space.id, conversationId: chat.id });
    assert.equal((await setup({ action: "share-screen", scope: "space", conversationId: chat.id })).status, 200);
    const deleted = await fetch(`${api.origin}/api/spaces/${space.id}/conversations/${chat.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const deletion = await deleted.json() as { deleted: { conversationId: string; trash: { entryId: string } } };
    assert.equal(deletion.deleted.conversationId, chat.id);
    assert.ok(deletion.deleted.trash.entryId, "the Chat remains recoverable");
    assert.equal(service.status().state, "idle", "deleting a cold Chat revokes its setup grant before moving the transcript");
    assert.equal((await setup({ action: "share-screen", scope: "space", conversationId: chat.id })).status, 400);
    await api.actFacade.trashRestore({ entry: deletion.deleted.trash.entryId });
    assert.equal(service.status().state, "idle", "restoring a deleted Chat never restores screen-sharing permission");
    const second = (await post(`/api/spaces/${space.id}/conversations`, {})).body.conversation;
    await appendMessage(space.spaceRoot, second.id, { id: randomUUID(), role: "user", content: "Retained Chat fixture", createdAt: new Date().toISOString() });
    assert.equal((await setup({ action: "share-screen", scope: "space", conversationId: second.id })).status, 200);
    await api.actFacade.spacesUnregister({ space: space.id });
    assert.equal(service.status().state, "idle", "Folder removal revokes a cold Chat's grant");
    assert.equal(launched, closed);
  } finally { await api.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
