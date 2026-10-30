import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createElement } from "react";

import { ChromeNativeHostRegistration } from "../desktop/src/chrome-native-host.js";
import { includedComputerStatus } from "../resources/included-tools/readiness.js";
import { IncludedChromeConnectionService, type ChromeDistribution } from "../src/local/agent/included-chrome-connection.js";
import type { ChromeBootstrapRequest } from "../src/shared/chrome-connection.js";
import type { IncludedToolStatus } from "../src/shared/included-tools.js";
import { includedToolReadiness } from "../web-local/src/lib/included-tool-readiness.js";
import { createDomHarness } from "./support/dom.js";

const assets = registerHooks({
  load(url, context, next) {
    if (/\.(png|svg|css)$/.test(url)) return { format: "module", source: /\.css$/.test(url) ? "export {};" : `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { IncludedComputerSetup } = await import("../web-local/src/components/panes/IncludedComputerSetup.js");
const { OnboardingFlow } = await import("../web-local/src/components/onboarding/OnboardingFlow.js");
assets.deregister();

const distribution: ChromeDistribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.chrome_test", bootstrapVersion: 1, extensionVersion: "1.0.0", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const origin = `chrome-extension://${distribution.storeId}/`;
const connectRequest = (): ChromeBootstrapRequest => ({ version: 1, action: "connect", requestId: randomUUID(), clientId: randomUUID(), clientProof: randomBytes(32).toString("hex"), extensionVersion: "1.0.0", bridge: distribution.bridge });

async function chromeService(t: TestContext, overrides: Partial<Parameters<typeof IncludedChromeConnectionService.create>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-chrome-first-"));
  const registrations: Array<[boolean, boolean | undefined]> = [];
  let opened = 0;
  const service = await IncludedChromeConnectionService.create({
    stateRoot: join(root, "state"), distribution,
    registerNativeHost: async (explicit, ifAbsent) => { registrations.push([explicit, ifAbsent]); },
    openStore: async () => { opened++; },
    startTransport: async () => ({ close() {} }),
    probe: async () => {},
    ...overrides,
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, registrations, opened: () => opened };
}

test("Computer Control can always be set up, and its status tells macOS's answer apart from capture", () => {
  assert.equal(includedToolReadiness({ id: "computer", state: "unknown", detail: "", checkedAt: "" }).setup, true);
  assert.equal(includedToolReadiness({ id: "documents", state: "unknown", detail: "", checkedAt: "" }).setup, false);
  const allowedNotCapturing = includedComputerStatus({ status: "setup_required", accessibility: true, screenRecording: false, screenRecordingPreflight: true });
  assert.equal(allowedNotCapturing.facts?.screenRecordingAllowed, true);
  assert.equal(allowedNotCapturing.facts?.screenRecording, false, "allowed is not yet capturable until the helper restarts");
  assert.equal(includedComputerStatus({ status: "unavailable", supportedOS: false, reason: "This included helper requires macOS 14 or later." }).facts?.supportedOS, false);
});

test("Chrome works when the extension is added first: launch registers quietly and Connect in the extension is accepted", async (t) => {
  const { root, service, registrations, opened } = await chromeService(t);
  assert.equal(service.environment().extensionSeen, false);
  await service.startIfEnabled();
  assert.deepEqual(registrations, [[false, true]], "launch registers only when Chrome has no work-fold registration");
  await access(join(root, "state", "chrome", "native-host", "launch.json"));
  assert.equal(service.status().state, "not_connected");

  const answer = await service.bootstrap(origin, connectRequest());
  assert.equal(answer.state, "lease_ready", "Connect chosen in the extension needs no earlier Connect Chrome in work-fold");
  assert.equal(service.status().hasSelection, true);
  assert.equal(service.environment().extensionSeen, true);
  assert.equal(opened(), 0, "nothing opened the Web Store");
  const saved = JSON.parse(await readFile(join(root, "state", "chrome", "native-host", "connection.json"), "utf8"));
  assert.equal(saved.enabled, true);

  // A quiet launch registration that fails reports nothing and starts nothing.
  const quiet = await chromeService(t, { registerNativeHost: async () => { throw new Error("Chrome Store setup is available in the installed work-fold app."); } });
  await quiet.service.startIfEnabled();
  assert.equal(quiet.service.status().problem, undefined);
  await assert.rejects(access(join(quiet.root, "state", "chrome", "native-host", "launch.json")), { code: "ENOENT" });
  // A resume without a selection still connects nothing.
  const resume = await quiet.service.bootstrap(origin, { ...connectRequest(), action: "resume" });
  assert.equal(resume.state === "status" && resume.status.state, "not_connected");
});

test("launch registration claims only an absent registration, and only when Chrome is set up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-chrome-if-absent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "app-resources"), chromeUserDataRoot = join(root, "chrome");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "work-fold-chrome-host"), "synthetic binary");
  await writeFile(join(sourceDirectory, "source.json"), JSON.stringify({ schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName, bootstrapVersion: 1 }));
  const options = { sourceDirectory, stateRoot: join(root, "state"), chromeUserDataRoot, distribution, enabled: true, verifySignature: false, platform: "darwin" as const };
  const manifestPath = join(chromeUserDataRoot, "NativeMessagingHosts", `${distribution.nativeHostName}.json`);

  await new ChromeNativeHostRegistration(options).register(false, true);
  await assert.rejects(access(manifestPath), { code: "ENOENT" }, "no Chrome profile folder, nothing written");

  await mkdir(chromeUserDataRoot);
  await new ChromeNativeHostRegistration(options).register(false, true);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")).allowed_origins, [origin]);

  const other = { name: distribution.nativeHostName, description: "Another installation", path: "/Applications/Other work-fold.app/host", type: "stdio", allowed_origins: [origin] };
  await writeFile(manifestPath, JSON.stringify(other));
  await new ChromeNativeHostRegistration({ ...options, stateRoot: join(root, "second-state") }).register(false, true);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), other, "another installation's registration stays as it is");
});

/** Fetch stub for the setup routes; `computer` answers each setup action. */
function stubSetup(t: TestContext, computer: (action: string) => IncludedToolStatus, tools: () => IncludedToolStatus[]) {
  const posts: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return Response.json({ status: computer(String(body.action)) });
    }
    assert.doesNotMatch(String(input), /workFolderId/, "first run reads the tools without a work-folder");
    return Response.json({ tools: tools() });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return posts;
}

test("Allow asks macOS, watches for the person's OK, and restarts the helper once Screen Recording is allowed", { timeout: 20_000 }, async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let phase: "asked" | "allowed" | "ready" = "asked";
  const status = (): IncludedToolStatus => ({
    id: "computer", detail: "", checkedAt: "",
    state: phase === "ready" ? "ready" : "setup_required",
    facts: { accessibility: phase !== "asked", screenRecording: phase === "ready", screenRecordingAllowed: phase !== "asked" },
  });
  const posts = stubSetup(t, (action) => {
    if (action === "recheck") phase = "ready";
    return status();
  }, () => [{ id: "computer", state: "unknown", detail: "", checkedAt: "" }]);
  await dom.render(createElement(IncludedComputerSetup, { enabled: true }));
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  await dom.waitFor(() => Boolean(button("Allow Computer Control")));
  assert.match(document.body.textContent!, /turn on work-fold Computer/);

  await dom.act(() => button("Allow Computer Control")!.click());
  await dom.waitFor(() => /Watching for your OK/.test(document.body.textContent!));
  assert.deepEqual(posts[0], { id: "computer", action: "request-permissions" });
  assert.deepEqual([...document.querySelectorAll(".setup-checklist li")].map((item) => item.textContent), [
    "Accessibility lets it click and typeOpen Settings", "Screen Recording lets it see the screenOpen Settings",
  ]);

  phase = "allowed";
  await dom.waitFor(() => document.querySelector('[role="status"]')?.textContent === "Ready", 8_000);
  assert.deepEqual(posts.map((item) => item.action), ["request-permissions", "check", "recheck"], "allowed but not capturing restarts the helper once");
  assert.match(document.body.textContent!, /Your Worker can see the screen/);
});

test("a failed status read clears once the next read succeeds", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let failing = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => failing
    ? Response.json({ error: "The local service restarted." }, { status: 503 })
    : Response.json({ tools: [{ id: "computer", state: "setup_required", detail: "", checkedAt: "" }] })) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  await dom.render(createElement(IncludedComputerSetup, { enabled: true }));
  await dom.waitFor(() => Boolean(document.querySelector(".included-tool-error")));
  failing = false;
  await dom.act(() => { window.dispatchEvent(new Event("focus")); });
  await dom.waitFor(() => !document.querySelector(".included-tool-error"));
});

test("first run offers Chrome and Computer Control when the app includes them", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  stubSetup(t, () => ({ id: "computer", state: "setup_required", detail: "", checkedAt: "" }), () => [
    { id: "chrome", state: "setup_required", detail: "", checkedAt: "", chrome: { state: "not_connected", checkedAt: "", hasSelection: false }, chromeSetup: { browserInstalled: true, extensionSeen: false } },
    { id: "computer", state: "unknown", detail: "", checkedAt: "" },
  ]);
  await dom.render(createElement(OnboardingFlow, { agentConfigured: true, onAiConnected: () => {}, onCreateWorkFolder: () => {}, onOpenFolder: () => {} }));
  const button = (text: RegExp) => [...document.querySelectorAll("button")].find((item) => text.test(item.textContent ?? ""));
  await dom.act(() => button(/^Get started$/)!.click());
  await dom.waitFor(() => document.querySelector("h1")?.textContent === "Let your Worker use your Mac");
  assert.match(document.body.textContent!, /Step 2 of 3/);
  await dom.act(() => button(/^Chrome/)!.click());
  await dom.waitFor(() => /Add the work-fold extension/.test(document.body.textContent!));
  await dom.act(() => button(/^Computer Control/)!.click());
  await dom.waitFor(() => Boolean(button(/^Allow Computer Control$/)));
  await dom.act(() => button(/^Continue$/)!.click());
  assert.equal(document.querySelector("h1")?.textContent, "Pick a folder to start with");
});
