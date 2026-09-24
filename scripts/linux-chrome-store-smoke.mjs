import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import puppeteer from "puppeteer-core";

// Real Store bytes, browser APIs, packaged Rust host and native Pi tools. The
// default managed-install lane replaces interactive Store enrollment. The
// optional UI lane instead exercises Add to Chrome in the disposable profile.
assert.equal(process.platform, "linux");
assert.equal(process.env.WORKFOLD_CONTAINER_CHROME_TEST, "1");
await readFile("/run/.containerenv").catch(() => readFile("/.dockerenv"));
assert.notEqual(process.getuid(), 0, "Chrome must run with its sandbox as a non-root test user");
const root = await mkdtemp(join(tmpdir(), "workfold-chrome-store-"));
// Modern Chrome permits test debugging only with a non-default data directory.
const browserRoot = join(root, "browser");
const distribution = JSON.parse(await readFile(new URL("../src/shared/chrome-distribution.json", import.meta.url), "utf8"));
const packageRoot = resolve(process.argv[2] ?? "out/linux/linux-unpacked");
const storeUi = process.env.WORKFOLD_CHROME_STORE_UI === "1";
const policyText = await readFile("/etc/opt/chrome/policies/managed/workfold-test.json", "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
if (storeUi) assert.equal(policyText, null, "Ordinary Store enrollment must not have a managed install policy");
else assert.deepEqual(JSON.parse(policyText).ExtensionInstallForcelist, [`${distribution.storeId};https://clients2.google.com/service/update2/crx`]);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.PI_CHROME_BRIDGE_PORT; // Published worker uses its documented port.
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const { IncludedChromeConnectionService } = await jiti.import(new URL("../src/local/agent/included-chrome-connection.ts", import.meta.url).pathname);
const { ChromeNativeHostRegistration } = await jiti.import(new URL("../desktop/src/chrome-native-host.ts", import.meta.url).pathname);
const chrome = await jiti.import(new URL("../resources/included-tools/chrome/index.ts", import.meta.url).pathname);
const { AuthStorage, createAgentSession, createEventBus, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const stateRoot = join(root, "state");
const registration = new ChromeNativeHostRegistration({ stateRoot, distribution, enabled: true,
  sourceDirectory: join(packageRoot, "resources/chrome-native-host"), chromeUserDataRoot: browserRoot,
  appPath: join(packageRoot, "work-fold-desktop") });
let service, browser, browserEndpoint, browserProcess;
const sessions = [];
const failures = [];
const web = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><title>work-fold isolated Chrome acceptance</title><body><h1>Browser acceptance fixture</h1><p id="marker">synthetic content only</p><input aria-label="Fixture text"><button onclick="document.querySelector('#marker').textContent='clicked'">Apply</button><p>${request.url === "/user-tab" ? "Ordinary user tab must survive" : "Worker-owned test tab"}</p></body></html>`);
});
await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${web.address().port}`;
async function createService() {
  service = await IncludedChromeConnectionService.create({ stateRoot, distribution,
    registerNativeHost: explicit => registration.register(explicit), openStore: async () => {},
    startTransport: host => chrome.startIncludedChromeConnection(host),
    probe: async () => { await chrome.probeIncludedChromeConnection(service); },
  });
}
async function connected() {
  const until = Date.now() + 30_000;
  while (service.status().state !== "connected") {
    assert.ok(Date.now() < until, `Chrome did not connect: ${service.status().state}`);
    await delay(100);
  }
  assert.equal((await service.check()).state, "connected");
}
async function launch() {
  browser = await puppeteer.launch({ executablePath: "/opt/google/chrome/chrome", headless: false, userDataDir: browserRoot, defaultViewport: null,
    env: { ...process.env, GTK_MODULES: "atk-bridge", NO_AT_BRIDGE: "0", ACCESSIBILITY_ENABLED: "1" },
    // Keep normal browser scheduling, extensions and rendering. Puppeteer's
    // broad automation defaults change the background behavior being tested.
    ignoreDefaultArgs: true,
    // Explicitly restore the fixture's tabs on browser restart. Normal Chrome
    // startup preferences are independent of work-fold's owned-tab cleanup.
    args: [`--user-data-dir=${browserRoot}`, "--restore-last-session", "--window-size=1440,1000", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--password-store=basic", "--force-renderer-accessibility",
      ...(process.env.WORKFOLD_CHROME_WAYLAND === "1" ? ["--ozone-platform=wayland"] : []), "about:blank"], timeout: 60_000 });
  assert.ok(!browser.process().spawnargs.includes("--no-sandbox"));
  assert.ok(browser.process().spawnargs.includes(`--user-data-dir=${browserRoot}`));
  browserEndpoint = browser.wsEndpoint(); browserProcess = browser.process();
  console.log(`Real browser: ${await browser.version()}`);
}
async function detachTestDebugger() { await browser.disconnect(); browser = undefined; }
async function attachTestDebugger() { browser = await puppeteer.connect({ browserWSEndpoint: browserEndpoint, defaultViewport: null }); }
async function closeBrowser() {
  if (!browser && browserProcess?.exitCode === null) await attachTestDebugger().catch(() => browserProcess.kill("SIGTERM"));
  await browser?.close(); browser = undefined;
  if (browserProcess?.exitCode === null) {
    const exited = once(browserProcess, "exit");
    if (!await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) {
      browserProcess.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) browserProcess.kill("SIGKILL");
      await exited;
    }
  }
}
async function popup() {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${distribution.storeId}/popup.html`);
  await page.waitForSelector("#status");
  return page;
}
async function makeSession(name) {
  const cwd = join(root, name); await mkdir(cwd);
  const eventBus = createEventBus();
  eventBus.on("work-fold:extension-host:v1", event => { event.context = { version: 1, mode: "session", cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR, stateRoot,
    getChromeConnection: () => service.getChromeConnection(),
    onChromeConnectionRevoked: listener => service.onChromeConnectionRevoked(listener),
    reportChromeConnectionObservation: value => service.reportChromeConnectionObservation(value),
    beginChromeWork: id => service.beginChromeWork(id),
  }; });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, eventBus,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [{ path: join(root, name + ".ts"), factory: chrome.default }] });
  await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const authStorage = AuthStorage.inMemory();
  const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader, settingsManager,
    authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), sessionManager: SessionManager.inMemory(), noTools: "builtin" });
  await session.bindExtensions({ mode: "rpc" }); sessions.push(session); return session;
}
async function call(session, name, args, signal) {
  const tool = session.agent.state.tools.find(item => item.name === name); assert.ok(tool);
  return tool.execute("linux-store-test", args, signal);
}
async function endTurn(session) { await session.extensionRunner.emit({ type: "agent_end", messages: [] }); }
async function dispose(session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose(); sessions.splice(sessions.indexOf(session), 1);
}
try {
  await createService(); await service.prepare(); await launch();
  if (storeUi) {
    const store = await browser.newPage();
    await store.goto(`https://chromewebstore.google.com/detail/${distribution.storeId}?hl=en`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await store.bringToFront();
    await store.waitForNetworkIdle({ idleTime: 1000, timeout: 20_000 });
    await store.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Add to Chrome' && !button.disabled), { polling: 100, timeout: 30_000 });
    await store.locator('::-p-aria(Add to Chrome)').setTimeout(15_000).click();
    console.log('Selected Add to Chrome in the actual Store page');
    const confirmation = await promisify(execFile)('python3', ['/work/scripts/linux-chrome-store-ui.py'], { timeout: 25_000 });
    console.log(confirmation.stdout.trim());
  }
  // A freshly installed MV3 worker may already be asleep. Wait for Chrome's
  // Store-installed manifest, then open its ordinary UI to wake it.
  const extensionRoot = join(browserRoot, "Default/Extensions", distribution.storeId);
  const installDeadline = Date.now() + 180_000;
  let installed;
  while (!installed) {
    const versions = await readdir(extensionRoot).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    if (versions.length === 1) installed = JSON.parse(await readFile(join(extensionRoot, versions[0], "manifest.json"), "utf8"));
    assert.ok(Date.now() < installDeadline, "Chrome did not install the published Store item");
    if (!installed) await delay(200);
  }
  assert.equal(installed.key, distribution.publicKey);
  assert.equal(installed.update_url, "https://clients2.google.com/service/update2/crx");
  const setup = await popup();
  await setup.bringToFront();
  await setup.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === "Connect"), { polling: 100 });
  // Chrome's UI command is exercised through the ordinary DOM button. Avoid
  // Puppeteer's IntersectionObserver wait: it never settles on some background
  // or headless compositor surfaces, independently of extension behavior.
  await setup.$eval("button.primary", button => button.click());
  await connected();
  const installedVersion = service.status().extensionVersion;
  assert.equal(installedVersion, distribution.extensionVersion, "Requalify changed published Store bytes before using this evidence");
  console.log(`PASS published Store ${distribution.storeId} ${installedVersion}: actual native messaging bootstrap and authenticated HTTP connection`);
  const userTab = await browser.newPage(); await userTab.goto(url + "/user-tab");
  if (process.env.WORKFOLD_DIAGNOSE_CHROME_CAPTURE === "1") {
    try {
      const visible = await userTab.screenshot({ timeout: 6_000 });
      console.error("Diagnostic ordinary-tab capture bytes:", visible.length);
    } catch (error) { console.error("Diagnostic ordinary-tab capture:", error.message); }
  }
  // Chrome's debugger API and the test runner must not compete for the same
  // targets. Detach Puppeteer while native Pi tools own browser work.
  await detachTestDebugger();
  const a = await makeSession("folder-a"), b = await makeSession("folder-b");
  const [navigationA, navigationB] = await Promise.all([
    call(a, "chrome_navigate", { url: url + "/worker-a" }), call(b, "chrome_navigate", { url: url + "/worker-b" }),
  ]);
  const tabA = String(navigationA.details.result.id), tabB = String(navigationB.details.result.id);
  assert.notEqual(tabA, tabB);
  const loaded = await call(a, "chrome_evaluate", { targetId: tabA, expression: "({url:document.URL,state:document.readyState,visibility:document.visibilityState})" });
  console.log("Real target before capture:", JSON.stringify(loaded.details));
  let snapshot;
  const captureStarted = Date.now();
  try { snapshot = await call(a, "chrome_screenshot", { targetId: tabA }); }
  catch (error) {
    console.error("Capture failed after milliseconds:", Date.now() - captureStarted);
    await attachTestDebugger();
    const target = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${distribution.storeId}/`));
    const worker = await target.worker();
    // Read-only diagnostics from the published worker after the command ended.
    console.error("Published worker target diagnostics:", await worker.evaluate(id => inputDebug({ targetId: id }), tabA));
    if (process.env.WORKFOLD_DIAGNOSE_CHROME_CAPTURE === "1") {
      const page = (await browser.pages()).find(page => page.url() === url + "/worker-a");
      const client = await page.createCDPSession();
      try {
        const metrics = await client.send("Page.getLayoutMetrics");
        console.error("Fixture viewport:", metrics.cssVisualViewport);
        const capture = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true,
          captureBeyondViewport: true }, { timeout: 6_000 });
        console.error("Diagnostic unclipped capture bytes:", Buffer.from(capture.data, "base64").length);
      } catch (diagnostic) {
        console.error("Diagnostic unclipped capture:", diagnostic.message);
        try {
          const metrics = await client.send("Page.getLayoutMetrics");
          await client.send("Emulation.setDeviceMetricsOverride", { width: metrics.cssLayoutViewport.clientWidth,
            height: metrics.cssLayoutViewport.clientHeight, deviceScaleFactor: 0, mobile: false });
          const capture = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true,
            captureBeyondViewport: true }, { timeout: 6_000 });
          console.error("Diagnostic background viewport-emulation capture bytes:", Buffer.from(capture.data, "base64").length);
        } catch (emulation) { console.error("Diagnostic background viewport-emulation capture:", emulation.message); }
        finally { await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {}); }
        try {
          await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
          const capture = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true,
            captureBeyondViewport: false }, { timeout: 6_000 });
          console.error("Diagnostic background focus-emulation capture bytes:", Buffer.from(capture.data, "base64").length);
        } catch (emulation) { console.error("Diagnostic background focus-emulation capture:", emulation.message); }
        finally { await client.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {}); }
        try {
          await client.send("Page.enable");
          const frame = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("No background screencast frame")), 6_000);
            client.once("Page.screencastFrame", value => { clearTimeout(timer); resolve(value); });
          });
          await client.send("Page.startScreencast", { format: "png", maxFramesInFlight: 1 });
          const value = await frame;
          console.error("Diagnostic background screencast bytes:", Buffer.from(value.data, "base64").length);
          await client.send("Page.screencastFrameAck", { sessionId: value.sessionId });
        } catch (screencast) { console.error("Diagnostic background screencast:", screencast.message); }
        finally { await client.send("Page.stopScreencast").catch(() => {}); }
      }
      finally { await client.detach(); }
    }
    await detachTestDebugger();
    failures.push(error);
  }
  if (snapshot) {
    const image = snapshot.content.find(item => item.type === "image");
    assert.ok(image && Buffer.from(image.data, "base64").length > 1000, "Real Chrome screenshot reaches the native Pi result");
    console.log("PASS real Chrome background screenshot reaches the native Pi image result");
  }
  // A separate explicit foreground request is part of the product contract;
  // it is never substituted silently for a failed background capture.
  const foreground = await call(a, "chrome_screenshot", { targetId: tabA, background: false });
  const foregroundImage = foreground.content.find(item => item.type === "image");
  assert.ok(foregroundImage && Buffer.from(foregroundImage.data, "base64").length > 1000);
  console.log("PASS real Chrome explicit foreground screenshot reaches the native Pi image result");
  const evaluated = await call(a, "chrome_evaluate", { targetId: tabA, expression: "document.querySelector('#marker').textContent" });
  assert.ok(JSON.stringify(evaluated).includes("synthetic content only"));
  assert.equal((await service.disconnect()).state, "busy", "Active accepted tool ownership prevents connection changes");
  await endTurn(a); await endTurn(b);
  await dispose(a);
  const surviving = await call(b, "chrome_tab", { action: "list" });
  assert.ok(JSON.stringify(surviving).includes(url + "/user-tab"), "Disposing Worker A preserves the ordinary tab");
  await call(b, "chrome_evaluate", { targetId: tabB, expression: "document.title" }); await endTurn(b);
  // Close and reopen real Chrome with the same profile; the native host resumes
  // its selected installation without exposing or reseeding stored proof.
  await closeBrowser();
  await launch(); await popup(); await connected(); await detachTestDebugger();
  await call(b, "chrome_tab", { action: "list" }); await endTurn(b);
  // Restart the actual connection owner while retaining the Pi session/browser.
  await service.close(); await createService(); await service.startIfEnabled();
  await connected(); await call(b, "chrome_tab", { action: "list" }); await endTurn(b);
  await dispose(b);
  await attachTestDebugger();
  assert.ok((await browser.pages()).some(page => page.url() === url + "/user-tab"), "Ordinary user tab survives browser/host restarts and Worker disposal");
  assert.equal((await service.disconnect()).state, "not_connected");
  console.log("PASS real Chrome: two Pi sessions, page evaluation, turn fence, owned-tab cleanup, browser restart, host restart, disconnect and user-tab preservation");
  if (failures.length) throw new AggregateError(failures, "Published Chrome companion has unresolved acceptance failures");
} catch (error) {
  if (process.env.DISPLAY) await promisify(execFile)('python3', ['-c', 'import os; from PIL import ImageGrab; ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save("/tmp/workfold-chrome-failure.png")'], { timeout: 5000 }).catch(() => {});
  console.error("Chrome acceptance failure:", error.message);
  console.error("Chrome host state:", service?.status().state);
  for (const page of await browser?.pages() ?? []) {
    if (page.url().startsWith('https://chromewebstore.google.com/')) console.error('Public Store page:', (await page.$eval('body', body => body.innerText).catch(() => 'Unavailable')).slice(0, 5000));
    if (page.url() === `chrome-extension://${distribution.storeId}/popup.html`) {
      console.error("Chrome setup UI:", await page.$eval("body", body => body.innerText).catch(() => "unavailable"));
    }
  }
  throw error;
} finally {
  for (const session of [...sessions]) { try { await dispose(session); } catch { session.dispose(); } }
  await closeBrowser(); await service?.close();
  web.closeAllConnections(); await new Promise(resolve => web.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
