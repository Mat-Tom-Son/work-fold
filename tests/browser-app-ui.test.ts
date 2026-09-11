import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBrowserAppView } from "../services/bridge/public/browser-app.js";

const app = { spaceId: "space-one", appId: "quote-board", featureInstallationId: "install-one", digest: "revision-one", authorityDigest: "authority-one", title: "Quote board", version: "1.0.0", spaceName: "Quotes", webView: true };
const served = (result: unknown) => ({ state: "served", result: { ok: true, result } });
const entry = served({ kind: "entry", bytes: Buffer.from("<!doctype html><h1>Quote board</h1>").toString("base64url") });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function documentFixture() {
  const dom = new JSDOM('<!doctype html><button id="opener">Open app</button>', { url: "http://localhost/", pretendToBeVisual: true });
  const previous = { document: globalThis.document, window: globalThis.window };
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  return { dom, close() { dom.window.close(); for (const key of ["document", "window"] as const) { if (previous[key] === undefined) delete (globalThis as any)[key]; else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] }); } } };
}

test("private app frame messages are source-bound, read-only, bounded and invalidated on close", async () => {
  const f = documentFixture();
  const waiting: Array<(result: unknown) => void> = [];
  let reads = 0;
  const controller = createBrowserAppView({ online: () => true, read: async (_app: unknown, call: any) => {
    reads++;
    return call.kind === "entry" ? entry : new Promise((resolve) => waiting.push(resolve));
  } });
  try {
    document.getElementById("opener")!.focus();
    await controller.open(app);
    const frame = document.querySelector("iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.style.visibility, "hidden", "app controls stay inert until its document is ready");
    const messages: any[] = [];
    frame.contentWindow!.postMessage = (value: any) => { messages.push(value); };
    const send = (data: unknown, source = frame.contentWindow) => window.dispatchEvent(new f.dom.window.MessageEvent("message", { data, source: source as any }));
    send({ type: "work-fold.browser-app.ready" }, window);
    assert.equal(messages.length, 0, "a sibling frame cannot obtain the app document");
    send({ type: "work-fold.browser-app.ready" });
    const channel = messages[0].channel;
    send({ type: "work-fold.browser-app.loaded", channel });
    assert.equal(frame.style.visibility, "visible");
    send({ type: "work-fold.browser-app.call", channel: "foreign", callId: 1, call: { kind: "data.keys" } });
    assert.equal(reads, 1);
    send({ type: "work-fold.browser-app.call", channel, callId: 2, call: { kind: "data.set", key: "quotes/north", value: 0 } });
    assert.equal(messages.at(-1).code, "APP_DENIED");
    const cyclic: any = { kind: "data.keys" }; cyclic.self = cyclic;
    send({ type: "work-fold.browser-app.call", channel, callId: 3, call: cyclic });
    assert.equal(messages.at(-1).code, "APP_DENIED");
    for (let id = 4; id <= 8; id++) send({ type: "work-fold.browser-app.call", channel, callId: id, call: { kind: "data.keys" } });
    assert.equal(waiting.length, 4);
    assert.equal(messages.at(-1).code, "APP_BUSY");
    const count = messages.length;
    document.querySelector<HTMLButtonElement>("[data-close]")!.click();
    waiting.forEach((resolve) => resolve(served({ kind: "data.keys", keys: ["quotes/north"] })));
    await flush();
    assert.equal(messages.length, count, "late reads cannot reach a closed app");
    assert.equal(document.querySelectorAll("iframe").length, 0);
    assert.equal(document.activeElement?.id, "opener");
  } finally { controller.destroy(); f.close(); }
});

test("offline and updated app views require an explicit fresh open and preserve installation identity", async (t) => {
  const f = documentFixture();
  const healthChecks: Array<() => void> = [];
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => { healthChecks.push(callback); return {}; }) as any);
  let connected = true;
  let current: any = app;
  const seen: any[] = [];
  const controller = createBrowserAppView({ online: () => connected, resolve: async () => current, read: async (scope: any) => { seen.push(scope); return entry; } });
  try {
    await controller.open({ ...app, sourceDigest: app.digest });
    assert.doesNotMatch(document.querySelector("header p")!.textContent!, /Updated since this task/);
    connected = false; controller.connectionChanged(false);
    assert.equal(document.querySelectorAll("iframe").length, 0);
    assert.match(document.body.textContent!, /Desktop offline/);
    connected = true; controller.connectionChanged(true);
    assert.equal(seen.length, 1, "reconnect does not replay reads");
    current = { ...app, digest: "revision-two", authorityDigest: "authority-two", version: "2.0.0" };
    document.querySelector<HTMLButtonElement>("[data-refresh]")!.click();
    await flush();
    assert.equal(seen.at(-1).digest, "revision-two");
    assert.match(document.querySelector("header p")!.textContent!, /2.0.0/);
    assert.match(document.querySelector("header p")!.textContent!, /Updated since this task/);
    current = { ...current, authorityDigest: "revoked-authority" };
    healthChecks.at(-1)!();
    await flush();
    assert.equal(document.querySelectorAll("iframe").length, 0, "the current view closes when its authority changes");
    assert.match(document.body.textContent!, /This app changed/);
    current = { ...app, featureInstallationId: "replacement" };
    await controller.open(app);
    assert.equal(document.querySelectorAll("iframe").length, 0);
    assert.match(document.body.textContent!, /no longer installed/);
    current = { ...app, webView: false };
    await controller.open(app);
    assert.match(document.body.textContent!, /no web view yet/);
  } finally { controller.destroy(); f.close(); }
});

test("apps can request, poll and stop actions; a request runs on acceptance and the trusted parent shows its status", async () => {
  const f = documentFixture();
  const calls: Array<{ operation: string; input: any }> = [];
  const records: any[] = [];
  const controller = createBrowserAppView({ online: () => true, read: async () => entry,
    actions: async (scope: any, operation: string, input: any) => {
      assert.equal(scope.featureInstallationId, app.featureInstallationId);
      calls.push({ operation, input });
      if (operation === "request") {
        const action = { id: "receipt-one", requestId: input.request.requestId, title: "Save quote", status: "running", startedAt: "2026-09-11T12:00:00.000Z" };
        records.push(action); return { action };
      }
      if (operation === "list") return { actions: records.map(({ result, ...record }) => structuredClone(record)) };
      if (operation === "cancel") { records[0].status = "cancelled"; return { action: structuredClone(records[0]) }; }
      return { action: structuredClone(records[0]) };
    },
  });
  try {
    await controller.open({ ...app, actions: true }); await flush();
    const frame = document.querySelector("iframe")!; const messages: any[] = [];
    frame.contentWindow!.postMessage = (message: any) => { messages.push(message); };
    const send = (data: unknown, source = frame.contentWindow) => window.dispatchEvent(new f.dom.window.MessageEvent("message", { data, source: source as any }));
    send({ type: "work-fold.browser-app.ready" }); const channel = messages[0].channel;
    assert.equal(messages[0].actions, true);
    send({ type: "work-fold.browser-app.loaded", channel });
    for (const kind of ["actions.approve", "actions.review", "actions.invoke"]) {
      send({ type: "work-fold.browser-app.call", channel, callId: 1, call: { kind, requestId: "request-one", reviewDigest: "invented" } });
      assert.equal(messages.at(-1).code, "APP_DENIED", "only request, get, list and cancel exist for an app frame");
    }
    assert.deepEqual(calls.map((call) => call.operation), ["list"]);
    send({ type: "work-fold.browser-app.call", channel, callId: 2, call: { kind: "actions.request", request: { requestId: "request-one", action: "save", input: {} } } });
    await flush(); await flush();
    assert.equal(calls.filter((call) => call.operation === "request").length, 1);
    assert.equal(messages.at(-1).result.status, "running", "the request runs as soon as it is accepted");
    assert.equal(Object.hasOwn(messages.at(-1).result, "reviewDigest"), false);
    const region = document.querySelector(".browser-app-actions")!;
    assert.equal(region.closest("iframe"), null);
    const labels = () => [...region.querySelectorAll("button")].map((button) => button.textContent);
    const click = (name: string) => {
      const button = [...region.querySelectorAll("button")].find((item) => item.textContent === name); assert.ok(button, `expected a ${name} control`); button.click();
    };
    assert.equal(labels().includes("Run"), false, "nothing waits for a person to run it");
    assert.equal(labels().includes("Open"), false);
    click("View"); await flush();
    assert.match(region.textContent!, /Running/);
    assert.equal(document.activeElement?.tagName, "H3");
    assert.ok(labels().includes("Stop"));
    assert.equal(region.querySelector("pre"), null, "the parent never renders app input");
    records[0].status = "succeeded"; records[0].result = { saved: true, note: "<img src=x onerror=alert(1)>" };
    click("Back"); await flush(); click("View"); await flush();
    assert.match(region.textContent!, /Done/); assert.match(region.querySelector("pre")!.textContent!, /"saved": true/);
    assert.equal(region.querySelectorAll("img").length, 0, "app output stays escaped inside the trusted parent");
    assert.equal(labels().includes("Stop"), false);
    send({ type: "work-fold.browser-app.call", channel, callId: 3, call: { kind: "actions.get", requestId: "request-one" } });
    await flush(); assert.deepEqual(messages.at(-1).result.result, records[0].result);
    const before = calls.length;
    send({ type: "work-fold.browser-app.call", channel, callId: 4, call: { kind: "actions.cancel", requestId: "request-one" } }, window);
    await flush(); assert.equal(calls.length, before, "another frame cannot cancel this app's request");
    assert.equal(calls.some((call) => ["review", "approve"].includes(call.operation)), false);
  } finally { controller.destroy(); f.close(); }
});

test("a late result cannot revive a disconnected view and reconnect never replays a request", async () => {
  const f = documentFixture(); let connected = true; let runs = 0; let resolveRun!: () => void;
  const record: any = { id: "receipt-one", requestId: "request-one", title: "Save quote", status: "running", startedAt: "2026-09-11T12:00:00.000Z" };
  const controller = createBrowserAppView({ online: () => connected, read: async () => entry,
    actions: async (_scope: any, operation: string) => {
      if (operation === "list") return { actions: [structuredClone(record)] };
      if (operation === "get") return { action: structuredClone(record) };
      if (operation === "request") {
        runs++;
        await new Promise<void>((resolve) => { resolveRun = resolve; }); return { action: structuredClone(record) };
      }
      throw new Error("Unexpected operation");
    },
  });
  try {
    await controller.open({ ...app, actions: true }); await flush();
    const frame = document.querySelector("iframe")!; const messages: any[] = [];
    frame.contentWindow!.postMessage = (message: any) => { messages.push(message); };
    const send = (data: unknown) => window.dispatchEvent(new f.dom.window.MessageEvent("message", { data, source: frame.contentWindow as any }));
    send({ type: "work-fold.browser-app.ready" }); const channel = messages[0].channel;
    send({ type: "work-fold.browser-app.loaded", channel });
    send({ type: "work-fold.browser-app.call", channel, callId: 1, call: { kind: "actions.request", request: { requestId: "request-one", action: "save", input: {} } } });
    await flush(); assert.equal(runs, 1);
    connected = false; controller.connectionChanged(false); resolveRun(); await flush(); await flush();
    assert.equal(document.querySelectorAll("iframe").length, 0);
    assert.equal(document.querySelector(".browser-app-actions")!.textContent, "");
    connected = true; controller.connectionChanged(true); await flush(); assert.equal(runs, 1);
    document.querySelector<HTMLButtonElement>("[data-refresh]")!.click(); await flush(); await flush();
    assert.match(document.querySelector(".browser-app-actions")!.textContent!, /Running/);
    assert.equal(runs, 1, "reopening only reads the accepted action's status");
  } finally { controller.destroy(); f.close(); }
});
