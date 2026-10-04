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

test("desktop sharing starts without Chats, permits Stop during work, and survives idle Chat removal", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "workfold-screen-setup-"));
  const agentDir = join(root, "pi"), included = join(root, "included");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(included);
  await writeFile(join(agentDir, "extensions/hold.ts"), `export default function(pi) {
    pi.registerCommand("hold-desktop-test", { description: "Disposable turn", handler: async () => { await new Promise(resolve => setTimeout(resolve, 300)); } });
  }`);
  await mkdir(join(included, "computer"));
  await writeFile(join(included, "computer/index.ts"), `
    export async function probeIncludedComputer(_config, options) {
      return { platform: 'linux', sessionType: 'wayland', status: options.launch ? 'ready' : 'not_running', accessibility: options.launch, screenRecording: false };
    }
    export async function setupIncludedComputer() { throw new Error('Observation must not enter repair'); }
  `);
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
    assert.equal((await setup({ action: "share-screen" })).status, 200, "sharing works before any Chat exists");
    assert.equal(launched, 1);
    assert.equal(service.status().owner, undefined);
    await setup({ action: "stop-sharing" });
    const warm = await api.actFacade.manageSend({ content: "/hold-desktop-test", newConversation: true });
    await settled(warm.taskId);
    const shared = await setup({ action: "share-screen" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(service.status().state, "active", "setup must not invalidate its just-granted Chat");
    assert.equal(closed, 1);
    const running = await api.actFacade.manageSend({ content: "/hold-desktop-test", conversationId: warm.conversationId });
    for (const action of ["check", "start-check"]) {
      const checked = await setup({ action });
      assert.equal(checked.status, 200, JSON.stringify(checked.body));
      assert.equal(checked.body.status.computerSession.state, "active", "readiness checks retain the live portal grant");
      assert.equal(service.status().state, "active");
      assert.equal(closed, 1, "checking cannot dispose peer Chats or stop sharing");
    }
    assert.equal((await setup({ action: "stop-sharing" })).status, 200, "Stop is available during accepted work");
    assert.equal(service.status().state, "idle"); await settled(running.taskId);
    const chat = (await post(`/api/spaces/${space.id}/conversations`, {})).body.conversation;
    await appendMessage(space.spaceRoot, chat.id, { id: randomUUID(), role: "user", content: "Retained Chat fixture", createdAt: new Date().toISOString() });
    const cold = await setup({ action: "share-screen" });
    assert.equal(cold.status, 200, JSON.stringify({ chat, response: cold.body }));
    await api.actFacade.chatArchive({ space: space.id, conversationId: chat.id });
    assert.equal(service.status().state, "active", "archiving an idle Chat preserves app-wide sharing");
    await api.actFacade.chatResume({ space: space.id, conversationId: chat.id });
    const deleted = await fetch(`${api.origin}/api/spaces/${space.id}/conversations/${chat.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const deletion = await deleted.json() as { deleted: { conversationId: string; trash: { entryId: string } } };
    assert.equal(deletion.deleted.conversationId, chat.id);
    assert.ok(deletion.deleted.trash.entryId, "the Chat remains recoverable");
    assert.equal(service.status().state, "active", "deleting an idle Chat preserves sharing");
    await api.actFacade.trashRestore({ entry: deletion.deleted.trash.entryId });
    assert.equal(service.status().state, "active", "restoring a Chat does not change the grant");
    const second = (await post(`/api/spaces/${space.id}/conversations`, {})).body.conversation;
    await appendMessage(space.spaceRoot, second.id, { id: randomUUID(), role: "user", content: "Retained Chat fixture", createdAt: new Date().toISOString() });
    await api.actFacade.spacesUnregister({ space: space.id });
    assert.equal(service.status().state, "active", "removing an idle Folder preserves app-wide sharing");
    await service.stop();
    assert.equal(launched, closed);
  } finally { await api.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
