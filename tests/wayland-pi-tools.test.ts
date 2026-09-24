import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import extension from "@injaneity/pi-computer-use/extensions/computer-use.ts";
import { currentPlatformBackend } from "@injaneity/pi-computer-use/src/platform/index.ts";
import { ResourceScheduler } from "@injaneity/pi-computer-use/src/runtime.ts";
import type { SharedScreenAction, SharedScreenBackend, SharedScreenObservation } from "@injaneity/pi-computer-use/src/shared-screen.ts";

test("native Pi tools use a genuine shared-screen target without an accessible window", async () => {
  const scheduler = new ResourceScheduler(), target = randomUUID();
  const sent: SharedScreenAction[][] = [];
  let calls = 0;
  const observe = (): SharedScreenObservation => ({ targetId: target, observationId: randomUUID(), kind: "shared_screen",
    frame: { width: 100, height: 80, capturedAtMs: Date.now(), sha256: "a".repeat(64) },
    inputAvailable: true, image: { mimeType: "image/png", data: "fixture" } });
  const backend: SharedScreenBackend = {
    list: async () => [{ id: target, title: "Shared screen", kind: "shared_screen" }],
    observe: async () => { calls++; return observe(); },
    act: async (_target, _observation, actions) => { sent.push(actions); return { ...observe(), inputSent: true, actionCount: actions.length }; },
  };
  const original = currentPlatformBackend.ensureReady;
  currentPlatformBackend.ensureReady = async () => { throw new Error("Fixture has no accessibility bus"); };
  function session() {
    const tools = new Map<string, any>(), events = new Map<string, any>();
    extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
      on: (name: string, fn: any) => events.set(name, fn) } as any,
    { scheduler, sharedScreens: backend, setupOnStart: false, restoreObservations: false, browserTools: false,
      requireExplicitRoot: true, enableCdp: false, interactiveSetup: false });
    return { call: (name: string, args: any) => tools.get(name).execute(randomUUID(), args, undefined, undefined, { cwd: "/tmp", hasUI: false }),
      close: () => events.get("session_shutdown")() };
  }
  const a = session(), b = session();
  try {
    assert.equal(calls, 0, "factory/catalog loading is inert");
    const found = await a.call("find_roots", {});
    const root = found.details.windows[0];
    assert.equal(root.kind, "shared_screen"); assert.equal("pid" in root, false); assert.equal("windowId" in root, false);
    await assert.rejects(a.call("observe_ui", { root: root.windowRef, mode: "semantic" }), /visual-only/);
    const observed = await a.call("observe_ui", { root: root.windowRef, mode: "visual" });
    assert.equal(observed.content[1].type, "image");
    const stateId = observed.details.stateId;
    await assert.rejects(b.call("act_ui", { stateId, actions: [{ action: "click", x: 20, y: 20 }] }), /state is unavailable/);
    await assert.rejects(a.call("act_ui", { stateId, actions: [{ action: "click", x: 20, y: 20 }, { action: "press", ref: "@e1" }] }), /accessibility refs/);
    assert.equal(sent.length, 0, "a later invalid action cannot admit an earlier click");
    const acted = await a.call("act_ui", { stateId, actions: [{ action: "click", x: 20, y: 20, clickCount: 2 },
      { action: "typeText", text: "hello" }, { action: "scroll", scrollY: 120 }] });
    assert.deepEqual(sent[0], [{ action: "click", x: 20, y: 20, count: 2, button: undefined },
      { action: "typeText", text: "hello" }, { action: "scroll", x: 20, y: 20, scrollX: 0, scrollY: 120 }]);
    await assert.rejects(a.call("act_ui", { stateId, actions: [{ action: "click", x: 20, y: 20 }] }), /stale/);
    assert.notEqual(acted.details.stateId, stateId);
    await assert.rejects(a.call("search_ui", { stateId: acted.details.stateId, text: "hello" }), /no semantic UI tree/);
    await a.close();
    await assert.rejects(a.call("observe_ui", { root: root.windowRef }), /abort/i);
    assert.equal((await b.call("find_roots", { kind: "shared_screen" })).details.windows.length, 1);
  } finally { currentPlatformBackend.ensureReady = original; await a.close(); await b.close(); await scheduler.close(); }
});
