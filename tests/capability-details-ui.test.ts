import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createElement } from "react";
import { includedToolDefinitions } from "../src/shared/included-tools.js";
import { applicationAppearanceVariables, defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import { createDomHarness } from "./support/dom.js";

// Only Vite's graphics/CSS imports are replaced. Components, focus management,
// setup requests and responses all run normally.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:capability-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:capability-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(css|svg)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
    return next(url, context);
  },
});
const { CapabilitiesPane, CapabilityDetailsDialog } = await import("../web-local/src/components/panes/CapabilitiesPane.js");
const { IncludedChromeSetup } = await import("../web-local/src/components/panes/IncludedChromeSetup.js");
assets.deregister();
type Item = Parameters<typeof CapabilityDetailsDialog>[0]["item"];
function included(id: string): Item {
  const tool = includedToolDefinitions.find((entry) => entry.id === id)!;
  return { id, kind: "extension", name: tool.title, description: tool.description, included: tool,
    path: `/Applications/work-fold.app/Contents/Resources/app.asar/node_modules/${tool.package}/resources/included-tools/extension-entry/index.ts`,
    scope: "global", origin: "top-level", source: tool.package, enabled: true, loaded: true, status: "loaded", diagnostics: [],
    tools: ["chrome_tabs", "chrome_navigate", "chrome_read_page", "chrome_click", "chrome_type", "chrome_screenshot", "chrome_network_requests", "chrome_console_messages", "chrome_evaluate"], commands: [], flags: [] };
}

test("installed details keep metadata collapsed while setup, failures and controls remain actionable", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ status: { id: "chrome", state: "setup_required", chrome: { state: "connecting", checkedAt: "2026-09-12T16:00:00.000Z", hasSelection: false } } });
    }
    return Response.json({ tools: [{ id: "chrome", state: "unknown", detail: "An obsolete explanation must not appear." }] });
  }) as typeof fetch;
  let toggles = 0;
  await dom.render(createElement(CapabilityDetailsDialog, { item: included("chrome"), spaceId: "workshop", busy: false, onClose() {}, onToggle() { toggles++; } }));
  await dom.waitFor(() => dom.container.textContent!.includes("Not checked"));
  const technical = dom.container.querySelector("details")!;
  assert.equal(technical.open, false);
  assert.match(technical.textContent!, /chrome_screenshot/);
  assert.match(technical.textContent!, /app\.asar/);
  assert.doesNotMatch(dom.container.textContent!, /None registered|Flags|Commands|Executable capability|obsolete explanation/);
  const button = (name: string) => [...dom.container.querySelectorAll("button")].find((item) => item.textContent === name)!;
  await dom.act(() => button("Connect Chrome").click());
  assert.deepEqual(writes, [{ spaceId: "workshop", id: "chrome", action: "connect-chrome" }]);
  assert.match(dom.container.textContent!, /Connecting/);
  assert.doesNotMatch(dom.container.textContent!, /Load unpacked|Developer mode|Copy folder path/);
  await dom.act(() => technical.querySelector("summary")!.click());
  assert.equal(technical.open, true);
  await dom.act(() => button("Turn off").click());
  assert.equal(toggles, 1);
  await dom.render(createElement(CapabilityDetailsDialog, { item: { ...included("chrome"), diagnostics: [{ type: "error", message: "Companion version mismatch" }] }, spaceId: "workshop", busy: false, onClose() {} }));
  assert.match(dom.container.querySelector('.professional-diagnostics[role="status"]')!.textContent!, /Companion version mismatch/);
});

test("ready included tools need no repeated setup copy and MCP keeps connection actions visible", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const operations: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("mcp-setup")) {
      const body = JSON.parse(String(init?.body)); operations.push(body.operation);
      return Response.json({ sessionId: "owned-session", servers: [{ name: "Calendar", scope: "global", transport: "http", endpoint: "https://example.invalid/mcp", auth: "none", credential: "not_checked", revision: "one" }], ...(body.operation === "check" ? { probe: { state: "ready", detail: "A redundant success explanation." } } : {}) });
    }
    return Response.json({ tools: includedToolDefinitions.map((tool) => ({ id: tool.id, state: "ready", detail: "A redundant success explanation.", ...(tool.id === "chrome" ? { chrome: { state: "connected", checkedAt: "2026-09-12T16:00:00.000Z", hasSelection: true } } : {}) })) });
  }) as typeof fetch;
  for (const id of ["chrome", "computer", "documents", "web"]) {
    await dom.render(createElement(CapabilityDetailsDialog, { key: id, item: included(id), spaceId: "workshop", busy: false, onClose() {} }));
    await dom.waitFor(() => dom.container.textContent!.includes(id === "chrome" ? "Connected" : "Ready"));
    assert.doesNotMatch(dom.container.textContent!, /redundant success explanation|Set up Chrome|Set up permissions/);
  }
  await dom.render(createElement(CapabilityDetailsDialog, { key: "mcp", item: included("mcp"), spaceId: "workshop", busy: false, onClose() {} }));
  await dom.waitFor(() => dom.container.textContent!.includes("No sign-in required"));
  const server = dom.container.querySelector(".included-mcp-list li")!;
  assert.equal(server.querySelector("details")!.open, false);
  assert.equal([...server.querySelectorAll("button")].some((button) => button.textContent === "Sign in"), false);
  const check = [...server.querySelectorAll("button")].find((button) => button.textContent === "Check")!;
  assert.equal(check.closest("details"), null);
  await dom.act(() => check.click());
  assert.match(dom.container.textContent!, /Connected/);
  assert.doesNotMatch(dom.container.textContent!, /redundant success explanation/);
  await dom.render(null);
  assert.deepEqual(operations, ["open", "check", "close"]);
});

test("Installed separates cold readiness from native loading and keeps a newer setup result through late summary reads", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const summaryReads: Array<(value: Response) => void> = [];
  const writes: unknown[] = [];
  let failingCheck = false;
  const tools = [included("chrome"), included("computer"), { ...included("documents"), enabled: false, status: "disabled" as const }];
  const catalog = {
    diagnostics: [], packages: [], skills: [], tools: [],
    extensions: tools.map((item) => ({ ...item, included: undefined, source: { scope: "user", origin: "top-level", source: "builtin" } })),
    resources: tools.map((item) => ({ kind: "extensions", path: item.path, enabled: item.enabled, included: item.included, metadata: { scope: "user", origin: "top-level", source: "builtin" } })),
  };
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (failingCheck) return Response.json({ error: "Companion probe failed" }, { status: 503 });
      return Response.json({ status: { id: "chrome", state: "ready", checkedAt: "2026-09-12T15:01:00.000Z", detail: "Authenticated companion responded.", chrome: { state: "connected", checkedAt: "2026-09-12T15:01:00.000Z", hasSelection: true } } });
    }
    if (String(input).includes("included-tools")) return failingCheck
      ? Response.json({ tools: [{ id: "chrome", state: "unknown", checkedAt: "2026-09-12T15:03:00.000Z", detail: "No current evidence" }] })
      : new Promise<Response>((resolve) => summaryReads.push(resolve));
    return Response.json(catalog);
  }) as typeof fetch;
  const props: Parameters<typeof CapabilitiesPane>[0] = {
    space: { id: "first", name: "Workshop" } as never, status: { configured: true } as never,
    view: "installed", onOpenSettings() {}, onError(message) { assert.fail(message ?? "Unexpected catalog error"); }, onViewChange() {},
  };
  await dom.render(createElement(CapabilitiesPane, props));
  const card = (name: string) => [...dom.container.querySelectorAll<HTMLElement>(".capabilities-resource-card")].find((item) => item.querySelector("strong")?.textContent === name)!;
  await dom.waitFor(() => Boolean(card("Chrome")));
  assert.match(card("Chrome").textContent!, /Not checked/);
  assert.match(card("Computer control").textContent!, /Not checked/);
  assert.match(card("Documents").textContent!, /Turned off/);
  assert.doesNotMatch(card("Chrome").textContent!, /Loaded|Ready/);
  assert.doesNotMatch(dom.container.querySelector(".capabilities-health")!.textContent!, /Everything loaded/);
  assert.deepEqual(writes, [], "catalog inspection must not check, launch, or configure an included tool");

  await dom.act(() => card("Chrome").querySelector("button")!.click());
  await dom.waitFor(() => summaryReads.length === 2);
  assert.doesNotMatch(dom.container.querySelector(".capability-details-dialog .modal-title")!.textContent!, /Loaded/);
  assert.match(dom.container.querySelector(".capability-technical-details")!.textContent!, /ExtensionLoadedEnabledYes/);
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>(".included-tool-setup button")].find((button) => button.textContent === "Check")!;
  await dom.act(() => { check.click(); check.click(); });
  await dom.waitFor(() => card("Chrome").textContent!.includes("Connected"));
  assert.deepEqual(writes, [{ spaceId: "first", id: "chrome", action: "check" }]);
  await dom.act(() => {
    for (const complete of summaryReads) complete(Response.json({ tools: [{ id: "chrome", state: "unknown", checkedAt: "2026-09-12T15:02:00.000Z", detail: "A snapshot taken while the earlier-started explicit probe was running" }] }));
  });
  await dom.settle();
  assert.match(card("Chrome").textContent!, /Connected/);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Connected");
  failingCheck = true;
  await dom.act(() => check.click());
  await dom.waitFor(() => dom.container.textContent!.includes("Companion probe failed"));
  await dom.settle();
  assert.match(card("Chrome").textContent!, /Not checked/);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Not checked");
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>(".capability-dialog-footer button")].find((button) => button.textContent === "Done")!.click());
  assert.match(card("Chrome").textContent!, /Not checked/, "closing details must not restore the last successful badge");
});

test("late readiness responses cannot cross Spaces or survive a closed setup owner", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let completeOld: ((value: Response) => void) | undefined;
  let completeCheck: ((value: Response) => void) | undefined;
  const delivered: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") return new Promise<Response>((resolve) => { completeCheck = resolve; });
    if (String(input).includes("spaceId=first")) return new Promise<Response>((resolve) => { completeOld = resolve; });
    return Response.json({ tools: [{ id: "chrome", state: "setup_required", checkedAt: "2026-09-12T15:02:00.000Z", chrome: { state: "not_connected", checkedAt: "2026-09-12T15:02:00.000Z", hasSelection: false } }] });
  }) as typeof fetch;
  const props = { item: included("chrome"), busy: false, onClose() {}, onReadinessChange: (status: { state: string } | null) => { if (status) delivered.push(status.state); } };
  await dom.render(createElement(CapabilityDetailsDialog, { ...props, spaceId: "first" }));
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Check")!.click());
  await dom.render(createElement(CapabilityDetailsDialog, { ...props, spaceId: "second" }));
  await dom.waitFor(() => delivered.length === 1);
  await dom.act(() => {
    completeOld!(Response.json({ tools: [{ id: "chrome", state: "ready", checkedAt: "2026-09-12T15:03:00.000Z" }] }));
    completeCheck!(Response.json({ status: { id: "chrome", state: "ready", checkedAt: "2026-09-12T15:03:00.000Z" } }));
  });
  await dom.settle();
  assert.deepEqual(delivered, ["setup_required"]);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Not connected");
});

test("Chrome Store setup observes the authenticated handshake and a refused disconnect preserves the selected connection", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const posts: Record<string, unknown>[] = [];
  let connectionState = "not_connected";
  let refuseWithSummary = false;
  const snapshot = () => ({ id: "chrome", state: "ready", checkedAt: "2026-09-12T16:00:00.000Z", chrome: {
    state: connectionState, checkedAt: "2026-09-12T16:00:00.000Z", hasSelection: connectionState === "connected" || connectionState === "busy",
  } });
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body);
      if (body.action === "disconnect-chrome" && refuseWithSummary) { connectionState = "busy"; return Response.json({ status: snapshot() }); }
      if (body.action === "disconnect-chrome") return Response.json({ error: "Chrome is in use. Stop its work first.", code: "CHROME_BUSY" }, { status: 409 });
      connectionState = "not_connected";
      return Response.json({ status: snapshot() });
    }
    return Response.json({ tools: [snapshot()] });
  }) as typeof fetch;
  const button = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
  await dom.render(createElement(IncludedChromeSetup, { spaceId: "first", enabled: true }));
  await dom.waitFor(() => dom.container.textContent!.includes("Not connected"));
  assert.deepEqual(posts, [], "opening setup reads status without registration or launch");
  await dom.act(() => { button("Connect Chrome").click(); button("Connect Chrome")?.click(); });
  await dom.waitFor(() => dom.container.textContent!.includes("In Chrome, choose Connect."));
  assert.ok(button("Cancel"), "a successful Store opening starts observation even before a profile is selected");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.action, "connect-chrome");
  assert.notEqual(dom.container.querySelector('[role="status"]')!.textContent, "Connected", "issuing a native lease does not establish browser readiness");
  connectionState = "connected";
  await dom.act(() => window.dispatchEvent(new Event("focus")));
  await dom.waitFor(() => dom.container.querySelector('[role="status"]')!.textContent === "Connected");
  assert.equal(posts.length, 1, "returning from Chrome observes the handshake without another Check action");
  assert.ok(button("Disconnect")); assert.ok(button("Change profile"));
  await dom.act(() => button("Disconnect").click());
  await dom.waitFor(() => Boolean(dom.container.querySelector('[role="alert"]')));
  await dom.waitFor(() => dom.container.querySelector('[role="status"]')!.textContent === "Connected");
  assert.match(dom.container.querySelector('[role="alert"]')!.textContent!, /Chrome is in use/);
  assert.deepEqual(posts.map(({ action }) => action), ["connect-chrome", "disconnect-chrome"]);
  refuseWithSummary = true;
  await dom.act(() => button("Disconnect").click());
  await dom.waitFor(() => dom.container.querySelector('[role="status"]')!.textContent === "Chrome is in use");
  assert.ok(button("Disconnect")); assert.ok(button("Change profile"), "a busy refusal does not clear the selected profile");
  assert.match(dom.container.textContent!, /Stop Chrome work/);
  assert.doesNotMatch(dom.container.textContent!, /Developer mode|Load unpacked|Copy folder path|token/i);
});

test("missing Store identity has no invented install link and closing setup never disconnects an accepted connection", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let state = "store_unavailable";
  let completeConnect: ((value: Response) => void) | undefined;
  const posts: string[] = [];
  const delivered: string[] = [];
  const snapshot = () => ({ id: "chrome", state: "unknown", checkedAt: "2026-09-12T16:00:00.000Z", chrome: { state, checkedAt: "2026-09-12T16:00:00.000Z", hasSelection: state === "connected" } });
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)).action);
      return new Promise<Response>((resolve) => { completeConnect = resolve; });
    }
    return Response.json({ tools: [snapshot()] });
  }) as typeof fetch;
  const props = { enabled: true, onStatusChange: (status: { chrome?: { state: string } } | null) => { if (status?.chrome) delivered.push(status.chrome.state); } };
  await dom.render(createElement(IncludedChromeSetup, { ...props, spaceId: "first" }));
  await dom.waitFor(() => dom.container.textContent!.includes("Chrome extension unavailable"));
  assert.equal(dom.container.querySelectorAll("a").length, 0);
  assert.equal([...dom.container.querySelectorAll("button")].some((button) => button.textContent === "Connect Chrome"), false);
  state = "not_connected";
  await dom.act(() => window.dispatchEvent(new Event("focus")));
  await dom.waitFor(() => dom.container.textContent!.includes("Connect Chrome"));
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Connect Chrome")!.click());
  await dom.render(null);
  const before = delivered.length;
  state = "connected";
  await dom.act(() => completeConnect!(Response.json({ status: snapshot() })));
  assert.equal(delivered.length, before, "a closed observer cannot publish a late result");
  assert.deepEqual(posts, ["connect-chrome"], "closing setup must never issue Disconnect or undo accepted enrollment");
  await dom.render(createElement(IncludedChromeSetup, { ...props, spaceId: "second" }));
  await dom.waitFor(() => dom.container.querySelector('[role="status"]')!.textContent === "Connected");
  assert.deepEqual(posts, ["connect-chrome"], "the connection survives a Space switch without another enrollment");
});

test("real detail CSS keeps long paths above tool lists and preserves scrolling at narrow and short sizes", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("A Chromium binary is needed for actual layout verification."); return; }
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-capability-css-"));
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup(createElement(CapabilityDetailsDialog, { item: included("chrome"), spaceId: "workshop", busy: false, onClose() {}, onToggle() {} })).replace('<details class="capability-technical-details"', '<details open class="capability-technical-details"');
    const css = (await Promise.all(["brand.css", "styles.css", "professional-foundation.css", "professional-shell.css", "professional-surfaces.css", "professional-customization.css", "application-appearance.css", "components/panes/included-tool-setup.css"].map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const variables = applicationAppearanceVariables({ ...defaultApplicationAppearance, textSize: "large" }, "dark");
    const payload = JSON.stringify({ markup, css, variables }).replace(/</g, "\\u003c");
    const html = `<!doctype html><pre id="result">pending</pre><script>
      const p=${payload}, results=[];
      for (const [width,height] of [[360,640],[800,400],[1200,900]]) {
        const f=document.createElement('iframe'); f.style.cssText='width:'+width+'px;height:'+height+'px'; document.body.append(f);
        const d=f.contentDocument; d.open(); d.write('<!doctype html><html data-theme="dark"><head><style>'+p.css+'</style></head><body><div class="app-shell" data-theme="dark">'+p.markup+'</div></body></html>');d.close();
        for (const [key,value] of Object.entries(p.variables)) d.documentElement.style.setProperty(key,value);
        const rect=s=>{const n=d.querySelector(s),r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,client:n.clientHeight,scroll:n.scrollHeight}};
        const b=d.querySelector('.capability-dialog-body'); b.scrollTop=b.scrollHeight;
        results.push({width,height,body:rect('.capability-dialog-body'),facts:rect('.capability-review-facts'),tools:rect('.capability-string-list'),header:rect('.modal-title'),close:rect('.modal-title button'),footer:rect('.capability-dialog-footer'),dialog:rect('.capability-dialog'),scrollTop:b.scrollTop,pageWidth:d.documentElement.scrollWidth}); f.remove();
      }
      document.getElementById('result').textContent=JSON.stringify(results);
    </script>`;
    const path = join(scratch, "fixture.html"); await writeFile(path, html);
    const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 2_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.length, 3);
    for (const item of results) {
      assert.ok(item.facts.bottom <= item.tools.top, "long path must end before Tools begins");
      assert.ok(item.dialog.top >= 0 && item.dialog.bottom <= item.height, "dialog stays inside the viewport");
      assert.ok(item.pageWidth <= item.width, "no horizontal overflow");
      assert.ok(item.footer.top >= item.body.bottom - 1, "actions do not overlap scrolling body");
      assert.ok(item.close.right > item.width / 2, "close control stays beside the title at narrow widths");
      if (item.width <= 800) assert.ok(item.scrollTop > 0, "all expanded metadata remains reachable by scrolling");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
