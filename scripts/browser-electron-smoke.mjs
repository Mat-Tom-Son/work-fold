// The built-in browser's desktop host in real Electron (docs/built-in-browser.md).
// Every page is served from a loopback server; nothing here reaches the network
// or a person's browser profile (the session is an in-memory partition).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

import { BrowserStatusBubble } from "../dist/desktop/desktop/src/browser-status-bubble.js";
import { BuiltInBrowser } from "../dist/desktop/desktop/src/built-in-browser.js";

const pages = {
  "/": `<!doctype html><title>Smoke</title>
<h1>Hello smoke</h1>
<label>Name <input id="name"></label>
<label>City <input id="city"></label>
<label>Size <select id="size"><option value="one">One</option><option value="two">Two</option></select></label>
<button id="send" onclick="document.getElementById('out').textContent = 'sent:' + document.getElementById('name').value + ':' + document.getElementById('size').value + ':' + event.isTrusted">Send</button>
<p id="out">waiting</p>
<a id="other" href="/two" target="_blank">Other page</a>
<a id="file" href="/file.txt">The file</a>
<a id="slow-a" href="/slow.txt?a" download>Slow A</a> <a id="slow-b" href="/slow.txt?b" download>Slow B</a>
<div style="height: 2400px"></div><p>Bottom of the page</p>
<script>console.log("smoke console"); setTimeout(() => { const late = document.createElement("p"); late.textContent = "Arrived late"; document.body.append(late); }, 600);</script>`,
  "/two": "<!doctype html><title>Two</title><h1>Second page</h1>",
  // The first mouse move tells the server, which stops the click in progress before the button is pressed.
  "/stop-click": `<!doctype html><title>Stop</title><button id="count" onclick="window.clicks = (window.clicks || 0) + 1">Count</button>
<script>document.addEventListener("mousemove", () => { const request = new XMLHttpRequest(); request.open("GET", "/moved", false); request.send(); }, { once: true });</script>`,
};

/** The Stop a test arms; the page's first mouse move fires it. */
let stopOnMove = null;

const server = createServer((request, response) => {
  if (request.url === "/moved") {
    stopOnMove?.abort(new Error("Stopped by person"));
    response.writeHead(204);
    response.end();
    return;
  }
  // Two downloads with one name that are still arriving at the same time.
  if (request.url?.startsWith("/slow.txt")) {
    response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=\"same.txt\"" });
    response.write(request.url.endsWith("a") ? "AAAA" : "BBBB");
    setTimeout(() => response.end(), 600);
    return;
  }
  if (request.url === "/file.txt") {
    response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=\"smoke file.txt\"" });
    response.end("downloaded bytes");
    return;
  }
  const body = pages[request.url ?? "/"];
  response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  response.end(body ?? "<!doctype html><title>Missing</title>missing");
});

app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => {
  console.error("browser smoke timed out");
  app.exit(3);
}, 90_000);

app.whenReady().then(run).then(() => {
  clearTimeout(watchdog);
  console.log("built-in browser smoke passed");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const downloads = await mkdtemp(join(tmpdir(), "work-fold-browser-smoke-"));
  const events = [];
  let window = null;
  const browser = new BuiltInBrowser({
    window: () => window,
    send: (channel, payload) => events.push({ channel, payload }),
    openExternal: async () => undefined,
    downloadsPath: () => downloads,
    sitePermissionsPath: join(downloads, "site-permissions.json"),
    historyPath: join(downloads, "history.json"),
    userAgentProduct: "work-fold/9.9.9",
    partition: `browser-smoke-${randomUUID()}`,
  });
  const host = browser.toolHost;
  try {
    // Like Claude's browser: Chromium's agent with the app's own name, never Electron's.
    assert.doesNotMatch(browser.session.getUserAgent(), /Electron/);
    assert.match(browser.session.getUserAgent(), /\(KHTML, like Gecko\) work-fold\/9\.9\.9 Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/);

    // A Worker opens a page with no window at all: it loads, reads, and takes input.
    const tab = await host.open({ url: `${base}/`, owner: "chat-a" });
    assert.equal(tab.title, "Smoke");
    assert.equal(tab.viewing, false);
    const announced = events.find((event) => event.channel === "work-fold:browser:open-tab");
    assert.equal(announced?.payload.pageId, tab.tab);
    assert.equal(announced?.payload.show, false, "a Worker's tab opens behind the person's work");

    const structure = await host.read({ tab: tab.tab, mode: "structure" });
    assert.match(structure.text, /- heading "Hello smoke" \[level=1\]/);
    const ref = (pattern) => {
      const match = pattern.exec(structure.text);
      assert.ok(match, `the structure lists ${pattern}:\n${structure.text}`);
      return match[1];
    };
    const name = ref(/textbox "Name"[^\n]*\[ref=(e\d+)\]/);
    const size = ref(/combobox "Size"[^\n]*\[ref=(e\d+)\]/);
    const send = ref(/button "Send"[^\n]*\[ref=(e\d+)\]/);
    const other = ref(/link "Other page"[^\n]*\[ref=(e\d+)\]/);
    const file = ref(/link "The file"[^\n]*\[ref=(e\d+)\]/);
    assert.match(structure.text, /link "Other page" → http:\/\/127\.0\.0\.1:\d+\/two/);

    await host.type({ tab: tab.tab, ref: name, text: "Ada" });
    await host.type({ tab: tab.tab, ref: name, text: "Grace" });
    await host.type({ tab: tab.tab, ref: size, text: "Two" });
    // Stop wins before any input: an aborted click never reaches the page.
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(host.click({ tab: tab.tab, ref: send, signal: stopped.signal }));
    await assert.rejects(host.type({ tab: tab.tab, ref: name, text: "never", signal: stopped.signal }));
    assert.equal((await host.evaluate({ tab: tab.tab, script: "document.getElementById('out').textContent + '|' + document.getElementById('name').value" })).result, "waiting|Grace");

    // Stop that arrives while the pointer moves to the button presses nothing.
    const stopTab = await host.open({ url: `${base}/stop-click`, owner: "chat-a" });
    const count = /button "Count"[^\n]*\[ref=(e\d+)\]/.exec((await host.read({ tab: stopTab.tab, mode: "structure" })).text)?.[1];
    assert.ok(count);
    const duringMove = new AbortController();
    stopOnMove = duringMove;
    await assert.rejects(host.click({ tab: stopTab.tab, ref: count, signal: duringMove.signal }), /Stopped by person/);
    assert.equal(duringMove.signal.aborted, true, "Stop came during the click");
    assert.equal((await host.evaluate({ tab: stopTab.tab, script: "String(window.clicks || 0)" })).result, "0");
    stopOnMove = null;
    await host.close({ tab: stopTab.tab, owner: "chat-a" });

    // Two Chats typing into one page at once each reach their own field.
    const city = ref(/textbox "City"[^\n]*\[ref=(e\d+)\]/);
    await Promise.all([
      host.type({ tab: tab.tab, ref: name, text: "ALPHA" }),
      host.type({ tab: tab.tab, ref: city, text: "BETA" }),
    ]);
    assert.equal((await host.evaluate({ tab: tab.tab, script: "document.getElementById('name').value + '|' + document.getElementById('city').value" })).result, "ALPHA|BETA");
    await host.type({ tab: tab.tab, ref: name, text: "Grace" });

    const clicked = await host.click({ tab: tab.tab, ref: send });
    assert.equal(clicked.navigated, false);
    const text = await host.read({ tab: tab.tab, mode: "text" });
    assert.match(text.text, /sent:Grace:two:true/, "typing replaces a field, the list choice sticks, and the click is a trusted press");

    const found = await host.read({ tab: tab.tab, mode: "structure", find: "send" });
    assert.match(found.text, /^- button "Send"/m);
    assert.doesNotMatch(found.text, /heading/);

    await assert.rejects(host.click({ tab: tab.tab, ref: "e999999" }), /no longer on the page|not visible/);
    await assert.rejects(host.click({ tab: tab.tab }), /Give an element ref/);

    const waited = await host.wait({ tab: tab.tab, text: "arrived late", seconds: 5 });
    assert.equal(waited.found, true);

    const evaluated = await host.evaluate({ tab: tab.tab, script: "document.title + ':' + (1 + 1)" });
    assert.equal(evaluated.result, "Smoke:2");
    await assert.rejects(host.evaluate({ tab: tab.tab, script: "throw new Error('nope')" }), /The script failed: Error: nope/);

    const consoleRead = await host.console({ tab: tab.tab });
    assert.ok(consoleRead.entries.some((entry) => entry.includes("smoke console")), consoleRead.entries.join("\n"));

    const shot = await host.screenshot({ tab: tab.tab });
    assert.equal(shot.mimeType, "image/jpeg");
    assert.ok(shot.width >= 1000 && shot.height >= 600, `a viewport picture in page pixels, got ${shot.width}×${shot.height}`);
    const element = await host.screenshot({ tab: tab.tab, ref: send });
    assert.ok(element.width < 200 && element.height < 80, `one element, got ${element.width}×${element.height}`);
    const full = await host.screenshot({ tab: tab.tab, fullPage: true });
    assert.ok(full.height > shot.height, "the whole page is taller than the viewport");

    const scrolled = await host.scroll({ tab: tab.tab, direction: "down", amount: 1 });
    assert.equal(scrolled.navigated, false);
    assert.ok(Number((await host.evaluate({ tab: tab.tab, script: "scrollY" })).result) > 0, "scrolling moved the page");

    // A link that opens a new tab becomes a tab of its own.
    const openCount = events.filter((event) => event.channel === "work-fold:browser:open-tab").length;
    await host.click({ tab: tab.tab, ref: other });
    await until(() => events.filter((event) => event.channel === "work-fold:browser:open-tab").length > openCount, "the new tab is announced");
    const listed = await host.tabs();
    assert.equal(listed.length, 2);
    const second = listed.find((item) => item.tab !== tab.tab);
    await until(async () => (await host.tabs()).find((item) => item.tab === second.tab)?.title === "Two", "the new tab loads");

    // Downloads land in the downloads folder, never over an existing file.
    await host.click({ tab: tab.tab, ref: file });
    await until(() => events.some((event) => event.channel === "work-fold:browser:download"), "the download finishes");
    const download = events.find((event) => event.channel === "work-fold:browser:download").payload;
    assert.equal(download.state, "completed");
    assert.equal(download.path, join(downloads, "smoke file.txt"));
    assert.equal(await readFile(download.path, "utf8"), "downloaded bytes");
    assert.throws(() => browser.showDownload("/etc/hosts"), /not one this browser downloaded/);

    // Two downloads with the same name, arriving at once, keep both files.
    await host.evaluate({ tab: tab.tab, script: "document.getElementById('slow-a').click(); document.getElementById('slow-b').click(); true" });
    const same = () => events.filter((event) => event.channel === "work-fold:browser:download" && event.payload.filename === "same.txt");
    await until(() => same().length === 2, "both downloads finish");
    const samePaths = same().map((event) => event.payload.path).sort();
    assert.deepEqual(samePaths, [join(downloads, "same (1).txt"), join(downloads, "same.txt")]);
    assert.deepEqual((await Promise.all(samePaths.map((path) => readFile(path, "utf8")))).sort(), ["AAAA", "BBBB"]);

    // Navigation, back and forward, and a page that does not exist.
    const two = await host.navigate({ tab: tab.tab, to: `${base}/two` });
    assert.equal(two.title, "Two");
    assert.equal((await host.navigate({ tab: tab.tab, to: "back" })).title, "Smoke");
    assert.equal((await host.navigate({ tab: tab.tab, to: "forward" })).title, "Two");
    const pressed = await host.press({ tab: tab.tab, keys: "Tab Shift+Tab" });
    assert.equal(pressed.navigated, false);
    await assert.rejects(host.press({ tab: tab.tab, keys: "Hyper+Q" }), /not a modifier/);

    // The person's tabs: a restored tab loads when a Worker first uses it, and only a Worker's own tabs close.
    const restoredId = "restored1";
    browser.sync({ tabs: [{ pageId: restoredId, url: `${base}/two`, title: "Two" }, { pageId: tab.tab, url: `${base}/two`, title: "Two" }], viewingPageId: restoredId });
    const withRestored = await host.tabs();
    assert.equal(withRestored[0].tab, restoredId);
    assert.equal(withRestored[0].viewing, true);
    const restoredRead = await host.read({ tab: restoredId, mode: "text" });
    assert.match(restoredRead.text, /Second page/);
    await assert.rejects(host.close({ tab: restoredId }), /the person's/);
    await assert.rejects(host.read({ tab: "missing1", mode: "text" }), /There is no browser tab "missing1"/);

    // In a window: a page shows over its placeholder only while its tab is in front.
    window = new BrowserWindow({ show: true, x: -4000, y: -4000, width: 1200, height: 800, focusable: false, skipTaskbar: true });
    const placement = { pageId: restoredId, url: `${base}/two`, sequence: 1, bounds: { x: 100, y: 80, width: 700, height: 500 }, active: true, occluded: false };
    const mounted = browser.mount(placement);
    assert.equal(mounted?.title, "Two");
    assert.equal(window.contentView.children.length, 1, "the page joins the window");
    browser.layout({ ...placement, sequence: 2, occluded: true });
    assert.equal(window.contentView.children.length, 0, "an overlay hides the page");
    browser.layout({ ...placement, sequence: 1, occluded: false });
    assert.equal(window.contentView.children.length, 0, "an older layout never wins");
    browser.layout({ ...placement, sequence: 3, active: true });
    assert.equal(window.contentView.children.length, 1);
    // The address of a hovered link shows at the page's bottom-left, above the page.
    const bubble = new BrowserStatusBubble();
    bubble.show(window, placement.bounds, "example.com/a <b>link</b>");
    await until(() => window.contentView.children.length === 2 && window.contentView.children[1].getVisible(), "the link bubble joins the window");
    const bubbleView = window.contentView.children[1];
    assert.deepEqual(bubbleView.getBounds(), { x: 100, y: 556, width: 185, height: 24 });
    assert.equal(await bubbleView.webContents.executeJavaScript("document.getElementById('text').textContent"), "example.com/a <b>link</b>", "the address is text, never markup");
    bubble.show(window, placement.bounds, "example.com/a <b>link</b>", { x: 120, y: 570 });
    await until(() => bubbleView.getBounds().x === 615, "a pointer in the corner moves the bubble right");
    bubble.hideSoon();
    assert.equal(bubbleView.getVisible(), true, "moving between links keeps the bubble");
    bubble.show(window, placement.bounds, "example.com/next");
    await until(() => bubbleView.getBounds().x === 100, "the next link reuses the bubble");
    bubble.hideSoon();
    await until(() => !bubbleView.getVisible(), "the bubble leaves with the pointer");
    assert.equal(window.contentView.children.length, 2, "it stays in the window, ready for the next link");
    bubble.close();
    assert.equal(window.contentView.children.length, 1);
    browser.detachWindow(window);
    assert.equal(window.contentView.children.length, 0, "a closing window gives its pages back");
    assert.equal((await host.read({ tab: restoredId, mode: "text" })).text.includes("Second page"), true, "the page outlives its window");

    // A site asks; the question waits in its tab until the person answers, and the answer is remembered for that site.
    const asking = browser.navigate("perm01", `${base}/two`);
    assert.equal(asking.permissionRequest, null);
    await until(async () => (await host.tabs()).find((item) => item.tab === "perm01")?.title === "Two", "the asking page loads");
    const permission = (await host.evaluate({ tab: "perm01", script: "Notification.permission" })).result;
    assert.equal(permission, "denied", "nothing is granted before the person answers");
    const answer = host.evaluate({ tab: "perm01", script: "Notification.requestPermission()" });
    await until(() => browser.states().find((state) => state.pageId === "perm01")?.permissionRequest, "the question reaches the tab");
    const question = browser.states().find((state) => state.pageId === "perm01").permissionRequest;
    assert.deepEqual(question.kinds, ["notifications"]);
    assert.equal(question.origin, base);
    assert.match((await host.tabs()).find((item) => item.tab === "perm01").asking, /waiting for the person to let it show notifications/);
    browser.respondPermission("perm01", question.requestId, "allow");
    assert.equal((await answer).result, "granted");
    assert.equal((await host.evaluate({ tab: "perm01", script: "Notification.permission" })).result, "granted", "the site remembers the answer");
    assert.deepEqual(browser.states().find((state) => state.pageId === "perm01").sitePermissions, [{ kind: "notifications", decision: "allow" }]);
    const saved = JSON.parse(await readFile(join(downloads, "site-permissions.json"), "utf8"));
    assert.deepEqual(saved, { version: 1, sites: { [base]: { notifications: "allow" } } });
    browser.command("perm01", { type: "forget-permission", kind: "notifications" });
    await until(() => !browser.states().find((state) => state.pageId === "perm01").sitePermissions.length, "Ask again forgets the decision");
    const blocked = host.evaluate({ tab: "perm01", script: "Notification.requestPermission()" });
    await until(() => browser.states().find((state) => state.pageId === "perm01")?.permissionRequest, "the site asks again");
    browser.respondPermission("perm01", browser.states().find((state) => state.pageId === "perm01").permissionRequest.requestId, "block");
    assert.equal((await blocked).result, "denied");
    // Leaving the page drops a question nobody answered.
    // The script is still waiting when the page goes: the dropped question denies it, or the call ends with the page.
    const unanswered = host.evaluate({ tab: "perm01", script: "navigator.permissions.query({ name: 'midi' }).then(() => navigator.requestMIDIAccess()).then(() => 'granted', () => 'denied')" })
      .then((outcome) => outcome.result, () => "page left");
    await until(() => browser.states().find((state) => state.pageId === "perm01")?.permissionRequest, "a second kind of question arrives");
    await host.navigate({ tab: "perm01", to: `${base}/` });
    assert.equal(browser.states().find((state) => state.pageId === "perm01").permissionRequest, null);
    assert.ok(["denied", "page left"].includes(await unanswered));

    // Every page a tab reaches is remembered for the address bar and a new tab.
    const suggested = browser.suggest("smoke");
    assert.ok(suggested.some((entry) => entry.url === `${base}/` && entry.title === "Smoke" && entry.visits >= 2), JSON.stringify(suggested));
    assert.ok(browser.suggest("two").some((entry) => entry.url === `${base}/two`));
    assert.equal(browser.recentHistory()[0].url, `${base}/`, "the newest visit leads");
    await browser.clearHistory();
    assert.deepEqual(browser.recentHistory(), []);
    assert.deepEqual(JSON.parse(await readFile(join(downloads, "history.json"), "utf8")), { version: 1, entries: [] });

    // A page that opens a pop-up on its own is stopped; the person can open it or allow the site.
    const popupTab = await host.open({ url: `${base}/two`, owner: "chat-a" });
    const popupState = () => browser.states().find((state) => state.pageId === popupTab.tab);
    const tabCount = async () => (await host.tabs()).length;
    const beforePopup = await tabCount();
    assert.equal((await host.evaluate({ tab: popupTab.tab, script: `String(window.open("${base}/") === null)` })).result, "true");
    await until(() => popupState()?.blockedPopup, "the blocked pop-up reaches the tab");
    assert.equal(popupState().blockedPopup.url, `${base}/`);
    assert.equal(await tabCount(), beforePopup, "nothing opened");
    browser.command(popupTab.tab, { type: "open-blocked-popup" });
    assert.equal(popupState().blockedPopup, null);
    await until(async () => (await tabCount()) === beforePopup + 1, "Open it opens the pop-up as a tab");
    await host.evaluate({ tab: popupTab.tab, script: `window.open("${base}/"); true` });
    await until(() => popupState()?.blockedPopup, "a second pop-up is blocked too");
    browser.command(popupTab.tab, { type: "allow-popups" });
    await until(async () => (await tabCount()) === beforePopup + 2, "Always allow opens it");
    await until(() => popupState().sitePermissions.some((item) => item.kind === "popups" && item.decision === "allow"), "the site keeps the allowance");
    assert.equal((await host.evaluate({ tab: popupTab.tab, script: `String(window.open("${base}/") !== null)` })).result, "true", "an allowed site opens pop-ups");
    await until(async () => (await tabCount()) === beforePopup + 3, "the allowed pop-up opens");
    browser.command(popupTab.tab, { type: "forget-permission", kind: "popups" });
    await until(() => !popupState().sitePermissions.some((item) => item.kind === "popups"), "Ask again forgets the allowance");

    // One press opens one pop-up, as in Chrome.
    await host.evaluate({ tab: popupTab.tab, script: `document.body.insertAdjacentHTML("beforeend", '<button onclick="window.first = window.open(\\'/\\') !== null; window.second = window.open(\\'/\\') !== null">Two pop-ups</button>'); true` });
    const twoButton = /button "Two pop-ups"[^\n]*\[ref=(e\d+)\]/.exec((await host.read({ tab: popupTab.tab, mode: "structure" })).text)?.[1];
    assert.ok(twoButton);
    await host.click({ tab: popupTab.tab, ref: twoButton });
    assert.equal((await host.evaluate({ tab: popupTab.tab, script: "String(window.first) + ':' + String(window.second)" })).result, "true:false");
    await until(() => popupState()?.blockedPopup, "the second pop-up is blocked");
    browser.command(popupTab.tab, { type: "dismiss-blocked-popup" });

    // Mute and zoom show on the tab.
    browser.command(popupTab.tab, { type: "mute", muted: true });
    assert.equal(popupState().muted, true);
    browser.command(popupTab.tab, { type: "zoom-in" });
    assert.equal(popupState().zoomPercent, 110);
    browser.command(popupTab.tab, { type: "zoom-reset" });
    assert.equal(popupState().zoomPercent, 100);

    // A Worker's step marks the page with its Chat while it runs, and the mark fades after.
    await until(() => !popupState().worker, "the opening step's mark fades", 6_000);
    const waiting = host.wait({ tab: popupTab.tab, text: "never on this page", seconds: 1, owner: "chat-b" });
    await until(() => popupState().worker?.owner === "chat-b", "the page shows which Chat is using it");
    assert.equal((await waiting).found, false);
    assert.deepEqual(popupState().worker, { owner: "chat-b" }, "the mark lingers briefly");
    await until(() => !popupState().worker, "the mark fades", 6_000);
    await host.read({ tab: popupTab.tab, mode: "text" });
    assert.equal(popupState().worker, null, "a step with no Chat leaves no mark");

    // A blank tab gets its page from the first address typed.
    const typed = browser.navigate("typed01", `127.0.0.1:${server.address().port}/two`);
    assert.equal(typed.pageId, "typed01");
    await until(async () => (await host.tabs()).find((item) => item.tab === "typed01")?.title === "Two", "a bare host and port loads over http");

    // Only the Chat that opened a tab closes it.
    await assert.rejects(host.close({ tab: tab.tab, owner: "chat-b" }), /Another Chat opened that tab/);
    await assert.rejects(host.close({ tab: tab.tab }), /Another Chat opened that tab/);
    await host.close({ tab: tab.tab, owner: "chat-a" });
    assert.ok(events.some((event) => event.channel === "work-fold:browser:close-tab" && event.payload.pageId === tab.tab));
    assert.equal((await host.tabs()).some((item) => item.tab === tab.tab), false);

    const closeEvents = events.filter((event) => event.channel === "work-fold:browser:close-tab").length;
    browser.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(events.filter((event) => event.channel === "work-fold:browser:close-tab").length, closeEvents, "quitting closes pages without closing their tabs");
  } finally {
    browser.dispose();
    window?.destroy();
    server.close();
    await rm(downloads, { recursive: true, force: true });
    assert.equal(existsSync(downloads), false);
  }
}

async function until(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting: ${label}`);
}
