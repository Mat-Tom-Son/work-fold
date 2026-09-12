import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";
import { ModelContextWindow, parseModelContextDiagnosticRequest } from "../desktop/src/model-context-window.js";
import { workFoldCliInstanceData, workFoldInspectContextFromArgv, workFoldSecondInstanceIntent } from "../desktop/src/work-fold-cli-host.js";

const url = "work-fold-desktop://app/index.html?dev-context";

class TestWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  shown = 0;
  focused = 0;
  reloads = 0;
  loaded: string[] = [];
  popup: (() => { action: string }) | undefined;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { processId: 1, routingId: 2, url },
    setWindowOpenHandler: (handler: () => { action: string }) => { this.popup = handler; },
    reload: () => { this.reloads++; },
  });
  setMenuBarVisibility() {}
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isFocused() { return this.focused > 0; }
  restore() { this.minimized = false; }
  show() { this.shown++; }
  focus() { this.focused++; }
  async loadURL(value: string) { this.loaded.push(value); }
  destroy() { this.destroyed = true; this.emit("closed"); }
  close() { this.destroy(); }
  event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame } as unknown as IpcMainInvokeEvent; }
}

test("explicit inspector launch survives cold and running-app dispatch while CLI stays headless", () => {
  const argv = ["work-fold", "--work-fold-inspect-context"];
  assert.equal(workFoldInspectContextFromArgv(argv), true);
  const data = workFoldCliInstanceData(null, workFoldInspectContextFromArgv(argv));
  assert.deepEqual(data, { kind: "work-fold-inspect-context" });
  assert.deepEqual(workFoldSecondInstanceIntent(argv, {}), { kind: "inspect-context" });
  assert.deepEqual(workFoldSecondInstanceIntent([], data), { kind: "inspect-context" });
  assert.deepEqual(workFoldSecondInstanceIntent(["--work-fold-inspect-context=true"], {}), { kind: "gui" });
  assert.equal(workFoldSecondInstanceIntent([...argv, "--work-fold-cli-request"], data).kind, "cli-invalid");
  const requestId = "38fc6538-9776-4833-871b-2d00e33502f7";
  assert.deepEqual(workFoldSecondInstanceIntent(argv, workFoldCliInstanceData(requestId, true)), { kind: "cli", requestId });
});

test("inspector is lazy, isolated, reusable and never changes recording by opening or closing", async () => {
  const windows: TestWindow[] = [];
  const requests: unknown[] = [];
  let createdOptions: BrowserWindowConstructorOptions | undefined;
  const inspector = new ModelContextWindow({ url, preload: "/trusted/model-context-preload.cjs",
    createWindow: (options) => { createdOptions = options; const window = new TestWindow(); windows.push(window); return window as unknown as BrowserWindow; },
    request: async (request) => { requests.push(request); return { enabled: request.body && "enabled" in request.body ? request.body.enabled : false, records: [] }; },
  });
  assert.equal(windows.length, 0);
  await Promise.all([inspector.open(), inspector.open()]);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].loaded, [url]);
  assert.deepEqual(createdOptions?.webPreferences, { preload: "/trusted/model-context-preload.cjs", contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false });
  assert.deepEqual(requests, []);
  assert.deepEqual(await inspector.request(windows[0].event(), { path: "/api/model-context" }), { enabled: false, records: [] });
  assert.deepEqual(await inspector.request(windows[0].event(), { path: "/api/model-context", body: { enabled: true } }), { enabled: true, records: [] });
  windows[0].minimized = true;
  await inspector.open();
  assert.equal(windows[0].minimized, false);
  assert.equal(windows[0].focused, 2);
  inspector.closeFrom(windows[0].event());
  assert.equal(windows[0].destroyed, true);
  await inspector.open();
  assert.equal(windows.length, 2);
  inspector.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.deepEqual(requests, [
    { path: "/api/model-context", method: "GET" },
    { path: "/api/model-context", method: "POST", body: { enabled: true } },
  ]);
});

test("inspector rejects foreign renderers, child frames, navigation and broader operations", async () => {
  const window = new TestWindow();
  let requests = 0;
  const inspector = new ModelContextWindow({ url, preload: "/trusted/preload.cjs",
    createWindow: () => window as unknown as BrowserWindow,
    request: async () => { requests++; return {}; },
  });
  await inspector.open();
  const event = window.event();
  assert.throws(() => inspector.assertSender(new TestWindow().event()), /own trusted main frame/);
  assert.throws(() => inspector.assertSender({ ...event, senderFrame: { ...event.senderFrame, routingId: 999 } } as IpcMainInvokeEvent), /own trusted main frame/);
  assert.throws(() => inspector.assertSender({ ...event, senderFrame: { ...event.senderFrame, url: "work-fold-desktop://app/index.html" } } as IpcMainInvokeEvent), /own trusted main frame/);
  assert.deepEqual(window.popup?.(), { action: "deny" });
  let prevented = false;
  window.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.com");
  assert.equal(prevented, true);
  await assert.rejects(inspector.request(event, { path: "/api/spaces", body: { enabled: true } }), /Invalid diagnostic path/);
  assert.equal(requests, 0);
  inspector.closeFrom(event);
  assert.throws(() => inspector.assertSender(event), /own trusted main frame/);
});

test("diagnostic request broker accepts only scoped reads and explicit recording controls", () => {
  assert.deepEqual(parseModelContextDiagnosticRequest({ path: "/api/model-context/record_1-abc?spaceId=one&conversationId=two" }), {
    path: "/api/model-context/record_1-abc?spaceId=one&conversationId=two", method: "GET",
  });
  for (const input of [
    { path: "https://example.com/api/model-context" }, { path: "/api/model-context/../spaces" },
    { path: "/api/model-context/%2e%2e" }, { path: "/api/model-context?spaceId=x&spaceId=y" },
    { path: "/api/model-context?conversationId=y" }, { path: "/api/model-context?url=https://example.com" },
    { path: "/api/model-context", headers: {} }, { path: "/api/model-context", method: "DELETE" },
    { path: "/api/model-context/record", body: { clear: true } },
    { path: "/api/model-context", body: { enabled: true, clear: true } },
    { path: "/api/model-context", body: { enabled: "true" } }, { path: "/api/model-context", body: { clear: false } },
  ]) assert.throws(() => parseModelContextDiagnosticRequest(input), /Invalid diagnostic/);
  assert.deepEqual(parseModelContextDiagnosticRequest({ path: "/api/model-context", body: { clear: true } }), { path: "/api/model-context", method: "POST", body: { clear: true } });
});

test("focused inspector owns close and refresh menu commands and shortcuts", async () => {
  const window = new TestWindow();
  const inspector = new ModelContextWindow({ url, preload: "/trusted/preload.cjs",
    createWindow: () => window as unknown as BrowserWindow, request: async () => { throw new Error("No capture request expected."); },
  });
  await inspector.open();
  assert.equal(inspector.handleMenuCommand("reload-space-state"), true);
  assert.equal(window.reloads, 1);
  assert.equal(inspector.handleMenuCommand("open-settings"), false);
  let prevented = false;
  window.webContents.emit("before-input-event", { preventDefault() { prevented = true; } }, { type: "keyDown", key: "r", meta: true });
  assert.equal(prevented, true);
  assert.equal(window.reloads, 2);
  window.focused = 0;
  assert.equal(inspector.handleMenuCommand("close-tab"), false);
  assert.equal(window.destroyed, false);
  window.focus();
  window.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "w", meta: true });
  assert.equal(window.destroyed, true);
});

test("desktop wires both launch paths and excludes the inspector from general IPC", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /initialInspectContext = interactiveRequested && workFoldInspectContextFromArgv\(process.argv\)/);
  assert.match(main, /if \(initialInspectContext\) await openModelContextWindow\(\)/);
  assert.match(main, /intent.kind === "inspect-context"[\s\S]*?startInteractiveApp\(\).then\(openModelContextWindow\)[\s\S]*?return;/);
  assert.match(main, /function assertTrustedRenderer[\s\S]*?modelContextWindow\?\.owns\(event.sender\)[\s\S]*?throw/);
  const preload = await readFile(new URL("../desktop/src/model-context-preload.cts", import.meta.url), "utf8");
  assert.deepEqual([...preload.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]), ['"electron"']);
  assert.doesNotMatch(preload, /workFoldDesktop|session-headers|apiSessionToken|enabled: true/);
});
