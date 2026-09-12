import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createJiti } from "jiti";
import { IncludedChromeConnectionService } from "../../../src/local/agent/included-chrome-connection.ts";

// Real Pi, app-owned connection service and frozen Store worker; only Chrome's
// native APIs are synthetic. Reuse one HTTP socket like a browser long poll.
const root = await mkdtemp(join(tmpdir(), "workfold-chrome-reconnect-"));
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
process.env.PI_CHROME_BRIDGE_PORT = String(port);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { AuthStorage, createAgentSession, createEventBus, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const chrome = await jiti.import<any>(new URL("../../../resources/included-tools/chrome/index.ts", import.meta.url).pathname);
const distribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.chrome_test", bootstrapVersion: 1, extensionVersion: "1.0.0", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const origin = `chrome-extension://${distribution.storeId}/`;
let observedPolls = 0;
let service: IncludedChromeConnectionService;
service = await IncludedChromeConnectionService.create({ stateRoot: root, distribution,
  registerNativeHost: async () => {}, openStore: async () => {},
  startTransport: host => chrome.startIncludedChromeConnection({ ...host,
    getChromeConnection: host.getChromeConnection, onChromeConnectionRevoked: host.onChromeConnectionRevoked,
    reportChromeConnectionObservation: (value: any) => { observedPolls++; host.reportChromeConnectionObservation(value); },
  }),
  probe: async () => { await chrome.probeIncludedChromeConnection(service); },
});
const cwd = join(root, "space"); await mkdir(cwd);
const eventBus = createEventBus();
eventBus.on("work-fold:extension-host:v1", (event: any) => { event.context = {
  version: 1, mode: "session", cwd, agentDir: process.env.PI_CODING_AGENT_DIR, stateRoot: root,
  getChromeConnection: service.getChromeConnection, onChromeConnectionRevoked: service.onChromeConnectionRevoked,
  reportChromeConnectionObservation: service.reportChromeConnectionObservation, beginChromeWork: service.beginChromeWork,
}; });
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, eventBus,
  noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  extensionFactories: [{ path: join(root, "chrome.ts"), factory: chrome.default }],
});
await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
const authStorage = AuthStorage.inMemory();
const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader, settingsManager, authStorage,
  modelRegistry: ModelRegistry.inMemory(authStorage), sessionManager: SessionManager.inMemory(), noTools: "builtin" });
await session.bindExtensions({ mode: "rpc" });
const sockets = new Agent({ keepAlive: true, maxSockets: 1 });
const intervals = new Set<ReturnType<typeof setInterval>>(), timeouts = new Set<ReturnType<typeof setTimeout>>();
const local: Record<string, unknown> = {}, sessionStorage: Record<string, unknown> = {}, listeners: Record<string, Function[]> = {};
let tabReads = 0, polls = 0, rejectedPolls = 0, pendingPolls = 0;
const event = (name: string) => ({ addListener(fn: Function) { (listeners[name] ??= []).push(fn); } });
const storage = (saved: Record<string, unknown>) => ({
  setAccessLevel: async () => {}, get: async (key: string) => structuredClone({ [key]: saved[key] }),
  set: async (value: object) => { Object.assign(saved, structuredClone(value)); },
});
const sandbox = {
  console, navigator: { userAgent: "Synthetic Chrome fixture" }, URL, URLSearchParams, Date, crypto: webcrypto, Uint8Array, Set, Map, Promise, AbortController,
  setTimeout(fn: (...args: any[]) => void, ms: number, ...args: any[]) { const timer = setTimeout(fn, ms, ...args); timeouts.add(timer); return timer; }, clearTimeout,
  setInterval(fn: () => void, ms: number) { const timer = setInterval(fn, ms); intervals.add(timer); return timer; }, clearInterval,
  WORK_FOLD_CHROME_CONFIG: distribution, importScripts: () => {},
  fetch: async (url: string, options: any = {}) => {
    const target = String(url).replace("http://127.0.0.1:17318", `http://127.0.0.1:${port}`);
    const headers = { ...options.headers, origin: origin.slice(0, -1) };
    const isPoll = target.includes("/next-v2");
    if (isPoll) { polls++; pendingPolls++; }
    return new Promise<Response>((resolve, reject) => {
      const incoming = request(target, { agent: sockets, method: options.method ?? "GET", headers, signal: options.signal }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === 403) rejectedPolls++;
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode }));
        });
      });
      incoming.on("error", reject); incoming.end(options.body);
    }).finally(() => { if (isPoll) pendingPolls--; });
  },
  chrome: {
    tabs: { query: async () => { tabReads++; return []; } }, storage: { local: storage(local), session: storage(sessionStorage) },
    runtime: { id: distribution.storeId, getManifest: () => ({ version: "1.0.0" }), getURL: (path: string) => origin + path,
      sendNativeMessage: async (_name: string, body: any) => service.bootstrap(origin, JSON.parse(JSON.stringify(body))),
      onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"),
    },
    alarms: { create: () => {}, onAlarm: event("alarm") }, action: { onClicked: event("click"), setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    debugger: { onDetach: event("detach") },
  },
};
const context = vm.createContext(sandbox);
vm.runInContext(await readFile(new URL("../../../resources/included-tools/chrome/store/bootstrap.js", import.meta.url), "utf8"), context);
vm.runInContext(await readFile(new URL("../../../node_modules/pi-chrome/extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8"), context);
async function send(action: string) {
  return new Promise<any>(resolve => listeners.message[0]({ type: "work-fold.connection", action }, { id: distribution.storeId, url: origin + "popup.html" }, resolve));
}
async function connected() {
  const deadline = Date.now() + 8_000;
  while (service.status().state !== "connected") {
    assert.ok(Date.now() < deadline, `Reconnection did not settle: ${JSON.stringify({ state: service.status().state, polls, rejectedPolls })}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function listTabs() {
  const tool = session.agent.state.tools.find(item => item.name === "chrome_tab"); assert.ok(tool);
  const result = await tool.execute("fixture", { action: "list" }); assert.deepEqual(result.details, { tabs: [] });
  // A retained Chat releases accepted-turn ownership, not its native session.
  await session.extensionRunner!.emit({ type: "agent_end", messages: [] });
}
try {
  await service.prepare(); assert.equal((await send("connect")).state, "connecting");
  await connected(); assert.equal((await service.check()).state, "connected"); await listTabs();
  assert.equal(tabReads, 1);
  // Wait for the worker's next idle poll to hold the socket during Disconnect.
  const oldConnection = (await service.getChromeConnection())!;
  for (let i = 0; !(pendingPolls === 1 && observedPolls === polls) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(pendingPolls === 1 && observedPolls === polls, "The old listener must hold an idle browser poll during Disconnect");
  assert.equal((await send("disconnect")).state, "not_connected");
  assert.equal((await send("connect")).state, "connecting");
  assert.notEqual((await service.getChromeConnection())!.connectionId, oldConnection.connectionId);
  await connected(); assert.equal((await service.check()).state, "connected"); await listTabs();
  assert.equal(tabReads, 2, "Exactly one native tool dispatch per turn, without replay");
  console.log("PASS Chrome reconnect: frozen Store worker, retained native Pi session, revoked keep-alive socket, fresh lease and no replay");
} finally {
  for (const timer of intervals) clearInterval(timer);
  for (const timer of timeouts) clearTimeout(timer);
  sockets.destroy(); await service.close(); session.dispose();
  await rm(root, { recursive: true, force: true });
}
