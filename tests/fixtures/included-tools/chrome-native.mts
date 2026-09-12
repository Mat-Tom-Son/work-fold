import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "workfold-chrome-native-"));
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
process.env.PI_CHROME_BRIDGE_PORT = String(port);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { AuthStorage, createAgentSession, createEventBus, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const chrome = await jiti.import<any>(new URL("../../../resources/included-tools/chrome/index.ts", import.meta.url).pathname);
const config = { companionPath: join(root, "companion") }, url = `http://127.0.0.1:${port}`;
const sessions: any[] = [];
let token: string;
async function next() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${url}/next-v2?protocol=2&version=0.15.51&name=native-fixture`, { headers: { "x-pi-chrome-companion": token }, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); return (await response.json() as any).command;
    } catch (error) { if (i === 99) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
}
async function reply(command: any, result: unknown) {
  const response = await fetch(url + "/result", { method: "POST", headers: { "content-type": "application/json", "x-pi-chrome-companion": token }, body: JSON.stringify({ id: command.id, bridgeEpoch: command.bridgeEpoch, ok: true, result }) });
  assert.equal(response.status, 200);
}
async function makeSession(name: string) {
  const cwd = join(root, name); await mkdir(cwd);
  const eventBus = createEventBus();
  eventBus.on("work-fold:extension-host:v1", (event: any) => { event.context = { version: 1, mode: "session", cwd, agentDir: process.env.PI_CODING_AGENT_DIR, stateRoot: root, companionPath: config.companionPath }; });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, eventBus, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [{ path: join(root, `${name}.ts`), factory: chrome.default }] });
  await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const authStorage = AuthStorage.inMemory();
  const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader, settingsManager, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), sessionManager: SessionManager.inMemory(), noTools: "builtin" });
  await session.bindExtensions({ mode: "rpc" }); sessions.push(session); return { session, cwd };
}
function call(session: any, name: string, args: any) { const tool = session.agent.state.tools.find((item: any) => item.name === name); assert.ok(tool); return tool.execute("fixture", args); }
async function stop(session: any) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose(); sessions.splice(sessions.indexOf(session), 1); }
try {
  assert.equal((await chrome.probeIncludedChrome(config)).state, "setup_required");
  const a = await makeSession("space-a"), b = await makeSession("space-b");
  await assert.rejects(stat(config.companionPath));
  await assert.rejects(call(a.session, "chrome_tab", { action: "list" }), /Set up the Chrome companion/);
  await assert.rejects(fetch(url + "/status"));
  await chrome.prepareIncludedChromeCompanion(config);
  token = JSON.parse(await readFile(join(config.companionPath, "host-config.json"), "utf8")).token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(join(config.companionPath, "host-config.json"))).mode & 0o777, 0o600);
  await chrome.prepareIncludedChromeCompanion(config);
  assert.equal(JSON.parse(await readFile(join(config.companionPath, "host-config.json"), "utf8")).token, token);
  // Setup checks must bootstrap their own connection before any successful
  // Chat tool use, then release it without leaving a resident listener.
  const bootstrap = chrome.probeIncludedChrome(config);
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const versionCommand = await next();
  assert.equal(versionCommand.action, "tab.version");
  await reply(versionCommand, { extensionVersion: "0.15.51", capabilities: { protocolVersion: 2, cancellation: true } });
  assert.equal((await bootstrap).state, "ready");
  await assert.rejects(fetch(url + "/status"));
  const list = call(a.session, "chrome_tab", { action: "list" }); let command = await next(); await reply(command, []); await list;
  for (const route of ["/status", "/next-v2?protocol=2&version=0.15.51", "/command-state-v2?id=made-up"]) assert.equal((await fetch(url + route)).status, 403);
  const { RestrictedAppNetworkBroker } = await import("../../../src/local/agent/restricted-app-connections.ts");
  const { parseRestrictedAppManifest } = await import("../../../src/local/agent/restricted-app-manifest.ts");
  const broker = new RestrictedAppNetworkBroker({ credentials: { get: async () => undefined } as any });
  const restricted = parseRestrictedAppManifest({ version: 2, id: "probe-app", title: "Probe", runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], automations: [], permissions: { network: [{ id: "chrome-loopback", target: { kind: "loopback-http", host: "127.0.0.1", port }, methods: ["GET", "POST"], auth: [{ kind: "none" }] }] } });
  const owner: any = { tenantId: "tenant_probe", runtimeInstanceId: "runtime-instance_probe", featureId: "probe-app", featureInstallationId: "feature-installation_probe", featureRevisionDigest: `work-fold.artifact.v1:sha256:${"a".repeat(64)}`, effectivePrincipalId: "principal_probe", connectionOwner: { kind: "instance", runtimeInstanceId: "runtime-instance_probe" }, networkGrants: ["chrome-loopback"] };
  for (const [method, path] of [["GET", "/next-v2?protocol=2&version=0.15.51"], ["GET", "/status"], ["POST", "/result"], ["POST", "/command-v2"]] as const) {
    const response = await broker.request(owner, restricted, { destinationId: "chrome-loopback", method, path, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "page.evaluate", params: { expression: "submit()" }, protocolVersion: 2, id: "made-up", ok: true }) } : {}) });
    assert.equal(response.status, 403); assert.ok(!response.body.includes(token));
  }
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
  const screenshot = call(b.session, "chrome_screenshot", { targetId: "42" }); command = await next();
  await reply(command, { dataUrl: `data:image/png;base64,${png}`, method: "cdp", tab: { id: "42", title: "Synthetic fixture", url: "https://fixture.test" } });
  const imageResult = await screenshot;
  assert.equal(imageResult.content.find((item: any) => item.type === "image")?.data, png);
  assert.equal(imageResult.details.capture.tab.id, "42");
  assert.deepEqual(await readdir(b.cwd), []);
  assert.ok(!JSON.stringify(imageResult).includes(token));
  const stoppingA = stop(a.session); command = await next(); await reply(command, {}); await stoppingA;
  const stillWorks = call(b.session, "chrome_tab", { action: "list" }); command = await next(); await reply(command, []); await stillWorks;
  const stoppingB = stop(b.session); command = await next(); await reply(command, {}); await stoppingB;
  await assert.rejects(fetch(url + "/status"));
  console.log("PASS native Chrome: lazy credential, persistent companion identity, authenticated transport and actual restricted-app broker refusal, native Pi image result, no Space capture files, two-session disposal");
} finally {
  for (const session of sessions) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); }
  await rm(root, { recursive: true, force: true });
}
