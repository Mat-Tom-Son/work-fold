import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { newDb } from "pg-mem";
import WebSocket from "ws";

import { BridgeDatabase, canonicalizeJson } from "./database.mjs";
import { shouldSubmitComposerKey } from "./public/composer.js";
import { renderMarkdown } from "./public/markdown.js";
import { normalizeChatTitle, replaceHtmlIfChanged } from "./public/rendering.js";
import { parseViewerLocation, viewerPageAad, viewerSlugFromHost } from "./public/viewer/viewer.js";
import {
  composeViewerAppDocument,
  parseViewerAppLocation,
  viewerAppAad,
  viewerAppCallFingerprint,
  viewerAppCallRoute,
} from "./public/viewer/viewer-app.js";
import { createPasswordCheckQueue, startBridgeServer } from "./server.mjs";

test("serves the web client and healthy no-store API responses", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await health.json(), { ok: true, service: "work-fold-bridge", status: "ready" });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /<title>work-fold<\/title>/);

  const composerModule = await fetch(`${baseUrl}/composer.js`);
  assert.equal(composerModule.status, 200);
  assert.match(composerModule.headers.get("content-type"), /^text\/javascript/);
  assert.equal(composerModule.headers.get("cache-control"), "no-cache");

  const markdownModule = await fetch(`${baseUrl}/markdown.js`);
  assert.equal(markdownModule.status, 200);
  assert.match(markdownModule.headers.get("content-type"), /^text\/javascript/);
  assert.match(await markdownModule.text(), /export function renderMarkdown/);

  const renderingModule = await fetch(`${baseUrl}/rendering.js`);
  assert.equal(renderingModule.status, 200);
  assert.match(renderingModule.headers.get("content-type"), /^text\/javascript/);
  assert.match(await renderingModule.text(), /export function replaceHtmlIfChanged/);

  const landingModule = await fetch(`${baseUrl}/landing.js`);
  assert.equal(landingModule.status, 200);
  assert.match(landingModule.headers.get("content-type"), /^text\/javascript/);
  const landingSource = await landingModule.text();
  assert.match(landingSource, /export function renderLanding/);
  assert.match(landingSource, /href="\/download\/macos"/);
  assert.match(landingSource, /href="https:\/\/github\.com\/Mat-Tom-Son\/work-fold"/);

  const landingStyles = await fetch(`${baseUrl}/landing.css`);
  assert.equal(landingStyles.status, 200);
  assert.match(landingStyles.headers.get("content-type"), /^text\/css/);

  const applicationScript = await fetch(`${baseUrl}/app.js`);
  const applicationSource = await applicationScript.text();
  assert.match(applicationSource, /import \{ renderLanding \} from "\.\/landing\.js"/);
  assert.match(applicationSource, /id="new-chat"/);
  assert.match(applicationSource, /<h1 id="conversation-title"><\/h1>/);
  assert.match(applicationSource, /id="rename-chat"/);
  assert.match(applicationSource, /id="rename-chat-input" maxlength="80"/);
  assert.match(applicationSource, /id="chats"/);
  assert.match(applicationSource, /id="workspace-pane"/);
  assert.match(applicationSource, /id="file-input"/);
  assert.match(applicationSource, /newConversation: true/);
  assert.match(applicationSource, /management\.chats/);
  assert.match(applicationSource, /management\.rename/);
  // The request trail accounts for the Space-free Library disposition; it
  // renders without the Space-name guard the placed/registered lines need.
  assert.match(applicationSource, /to the Library<\/strong>|<\/strong> to the Library/);
  assert.match(applicationSource, /disposition\.status === "library"/);
  assert.match(applicationSource, /management\.stop/);
  assert.match(applicationSource, /reconcileMessageRows/);
  assert.match(applicationSource, /replaceHtmlIfChanged/);
  assert.doesNotMatch(applicationSource, /spaces\.(?:chats|transcript|send|stop)/);
  assert.doesNotMatch(applicationSource, /Chat with Space|id="scope-name"|id="management-home"/);
  assert.match(applicationSource, /id="account-settings"[\s\S]*?id="account-menu"[\s\S]*?>Sign out</);
  // The four-context single-column shell: Home carries decisions, the tail,
  // the glance, and recent chats above its composer; the saved-chat list is
  // the Chats context; Chat is one transcript with a back affordance; Files
  // is the read-only tree as its own context.
  assert.match(applicationSource, /id="context-home"[\s\S]*?id="fold-home"[\s\S]*?id="recent-chats"[\s\S]*?id="home-composer-slot"/);
  assert.match(applicationSource, /id="context-chats"[\s\S]*?<ul id="chats"[\s\S]*?id="context-chat"[\s\S]*?id="back-to-chats"[\s\S]*?id="messages"[\s\S]*?id="chat-composer-slot"/);
  assert.match(applicationSource, /id="context-files"[\s\S]*?class="context-title" tabindex="-1">Files<[\s\S]*?id="workspace-pane"[\s\S]*?id="space-picker"[\s\S]*?id="file-tree"/);
  // Phone tabs and the desktop icon rail carry the same three destinations.
  assert.match(applicationSource, /class="tab-bar"[\s\S]*?data-nav-context="home"[\s\S]*?<span>Home<\/span>[\s\S]*?data-nav-context="chats"[\s\S]*?<span>Chats<\/span>[\s\S]*?data-nav-context="files"[\s\S]*?<span>Files<\/span>/);
  assert.match(applicationSource, /class="icon-rail"[\s\S]*?data-nav-context="home"[\s\S]*?data-nav-context="chats"[\s\S]*?data-nav-context="files"[\s\S]*?id="rail-new-chat"/);
  assert.match(applicationSource, /Working in \$\{spaceName\}/);
  assert.match(applicationSource, /Couldn’t finish in \$\{spaceName\}/);
  assert.doesNotMatch(applicationSource, /previous chat is still saved on your desktop/);

  const applicationStyles = await (await fetch(`${baseUrl}/app.css`)).text();
  assert.match(applicationStyles, /\.message\.message-enter\s*\{\s*animation:/);
  assert.match(applicationStyles, /\.conversation-title-view\[hidden\]\s*\{\s*display:\s*none/);
  for (const structuralDivider of [
    /\.icon-rail\s*\{[^}]*border-right:\s*1px/,
    /\.conversation-bar\s*\{[^}]*border-bottom:\s*1px/,
    /\.message\s*\{[^}]*border-bottom:\s*1px/,
    /\.composer-wrap\s*\{[^}]*border-top:\s*1px/,
    /\.workspace-pane\s*\{[^}]*border-left:\s*1px/,
  ]) assert.doesNotMatch(applicationStyles, structuralDivider);
  // One breakpoint by construction: the icon rail arrives at 860px; the old
  // mid-width layouts are gone.
  assert.match(applicationStyles, /@media \(min-width: 860px\)/);
  for (const retiredBreakpoint of ["max-width: 980px", "max-width: 680px"]) {
    assert.equal(applicationStyles.includes(retiredBreakpoint), false);
  }
  assert.match(applicationStyles, /\.tab-bar\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom/);
  // "Needs you" left this list deliberately: the fold's decision cards
  // (docs/fold-consecrations.md, remote client) reintroduced the heading as
  // the shared card contract's vocabulary, pinned in copy.test.mjs.
  for (const removedCopy of [
    "Management conversation",
    "Above all Spaces",
    "Desktop connected",
    "Encrypted to your desktop",
    "Private alpha",
    "Hosted client trusted",
    " · Web",
  ]) {
    assert.doesNotMatch(applicationSource, new RegExp(removedCopy));
  }

  const appIcon = await fetch(`${baseUrl}/brand-mark.png`);
  assert.equal(appIcon.status, 200);
  assert.match(appIcon.headers.get("content-type"), /^image\/png/);

  // Installable: the page links the manifest and Apple icon metadata, the
  // manifest is served with a manifest content type and the fold's name, and
  // every icon it names resolves as a PNG.
  const pageMarkup = await (await fetch(baseUrl)).text();
  assert.match(pageMarkup, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(pageMarkup, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
  assert.match(pageMarkup, /viewport-fit=cover/);
  assert.match(pageMarkup, /apple-mobile-web-app-capable/);
  assert.match(pageMarkup, /apple-mobile-web-app-status-bar-style/);
  assert.match(pageMarkup, /name="theme-color" media="\(prefers-color-scheme: light\)" content="#f2f4ef"/);
  assert.match(pageMarkup, /name="theme-color" media="\(prefers-color-scheme: dark\)" content="#0f1622"/);
  assert.match(pageMarkup, /property="og:image" content="https:\/\/www\.work-fold\.com\/og-image\.png"/);

  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /^application\/manifest\+json/);
  const manifestBody = await manifest.json();
  assert.equal(manifestBody.name, "Your fold");
  assert.equal(manifestBody.short_name, "Your fold");
  assert.equal(manifestBody.display, "standalone");
  assert.equal(manifestBody.start_url, "/");
  assert.deepEqual(
    manifestBody.icons.map((icon) => icon.src),
    ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"],
  );
  for (const iconPath of ["/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/favicon-32.png", "/brand-mark.png", "/brand-lockup-black.png", "/brand-lockup-white.png", "/og-image.png"]) {
    const icon = await fetch(`${baseUrl}${iconPath}`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /^image\/png/);
  }

  const legacyFavicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(legacyFavicon.status, 200);
  assert.equal(legacyFavicon.headers.get("content-type"), "image/vnd.microsoft.icon");

  // Brand webfonts are self-hosted next to the client that declares them.
  const font = await fetch(`${baseUrl}/fonts/inter-latin-wght-normal.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");

  const rejected = await fetch(baseUrl, { method: "POST" });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");
});

test("fixture previews render canned state and stay inert against the real API", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;

  const fixtures = await fetch(`${baseUrl}/fixtures.js`);
  assert.equal(fixtures.status, 200);
  assert.match(fixtures.headers.get("content-type"), /^text\/javascript/);
  const fixturesSource = await fixtures.text();
  assert.match(fixturesSource, /export function buildFixture/);
  // Canned state only: the fixture module never talks to anything and never
  // stubs an operation that could be confused with real state.
  assert.doesNotMatch(fixturesSource, /fetch\(|EventSource|indexedDB|crypto\.subtle|api\(|remote\(/);

  const applicationSource = await (await fetch(`${baseUrl}/app.js`)).text();
  // ?fixture accepts exactly the three preview screens.
  assert.match(applicationSource, /requested === "home" \|\| requested === "chat" \|\| requested === "files"/);
  // The guard: fixture mode never attaches auth or calls fetch. api() and
  // remote() refuse before touching identity or the network, the event
  // stream and refresh loop never start, and no seen marker is posted from
  // a preview.
  assert.match(applicationSource, /async function api\(path[\s\S]{0,120}?if \(fixtureName\) throw new Error\("Fixture preview is inert/);
  assert.match(applicationSource, /async function remote\(operation[\s\S]{0,120}?if \(fixtureName\) throw new Error\("Fixture preview is inert/);
  assert.match(applicationSource, /function openEvents\(\) \{\s*\n\s*if \(fixtureName\) return;/);
  assert.match(applicationSource, /function scheduleRefresh\(\) \{\s*\n\s*if \(fixtureName\) return;/);
  assert.match(applicationSource, /function acknowledgeGlance\(\) \{\s*\n\s*if \(fixtureName\) return;/);
  // The preview is labeled for what it is.
  assert.match(applicationSource, />Fixture preview<\/div>/);
});

test("the client stays inside the relay's operation budget and backs off on 429", async () => {
  const applicationSource = await readFile(new URL("./public/app.js", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  // The per-session operation budget and the client's discipline move
  // together: a 429 arms a cooldown that pauses background refresh, resume
  // bursts, and recovery re-POSTs, while the fold-home digest rides a slower
  // multiple of the chat lane's tick.
  assert.match(serverSource, /enforceRateLimit\(state\.rateLimits, `operation:\$\{session\.id\}`, 60, 60_000\);/);
  assert.match(applicationSource, /if \(response\.status === 429\) state\.rateLimitedUntil = Date\.now\(\) \+ 15_000;/);
  assert.match(applicationSource, /if \(Date\.now\(\) < state\.rateLimitedUntil\) return scheduleRefresh\(\);/);
  assert.match(applicationSource, /state\.refreshTick % \(active \? 3 : 2\) === 0/);
  assert.match(applicationSource, /Date\.now\(\) < pending\.nextRecoveryAt \|\| Date\.now\(\) < state\.rateLimitedUntil/);
  assert.match(applicationSource, /Date\.now\(\) - state\.lastResumeAt < 10_000/);
  // The status-poll fallback backs off after its first fast checks, further
  // while the event stream is healthy.
  assert.match(applicationSource, /attempt < 5 \? 1_000 : streamHealthy \? 3_000 : 2_000/);
});

test("the live watch is capability-gated, single, and falls back to polling", async () => {
  const applicationSource = await readFile(new URL("./public/app.js", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  // The relay allowlists the operation name content-blind, like every other
  // management operation; progress rides the existing operation.event lane.
  assert.match(serverSource, /"management\.watch",/);
  // The client starts a watch only when the desktop's summary advertises the
  // capability — an older desktop is never asked — keeps at most one watch,
  // ignores ticks from a superseded watch, refreshes immediately on settle,
  // and one failed watch quietly returns the page to polling.
  assert.match(applicationSource, /if \(state\.summary\?\.capabilities\?\.watch !== true\) return;/);
  assert.match(applicationSource, /if \(state\.watchToken\) return;/);
  assert.match(applicationSource, /event\.operationId !== state\.watchOperationId\) return;/);
  assert.match(applicationSource, /state\.watchUnsupported = true;/);
  assert.match(applicationSource, /result && result\.settled === true/);
  // The watch's status-poll fallback idles at ten seconds; completion arrives
  // over the event stream.
  assert.match(applicationSource, /fallbackIntervalMs: 10_000,/);
});

test("composer sends with Enter on hardware keyboards and writes a newline on touch", () => {
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "a", shiftKey: false, isComposing: false }), false);
  // Touch keyboards have no Shift+Enter: the return key inserts the newline
  // and the visible send button sends.
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }, { coarsePointer: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }, { coarsePointer: false }), true);
});

test("stable rendering skips identical DOM replacements and Chat titles share desktop normalization", () => {
  let writes = 0;
  let markup = "";
  const element = {};
  Object.defineProperty(element, "innerHTML", {
    get: () => markup,
    set: (value) => {
      writes += 1;
      markup = value;
    },
  });

  assert.equal(replaceHtmlIfChanged(element, "<p>Ready</p>"), true);
  assert.equal(replaceHtmlIfChanged(element, "<p>Ready</p>"), false);
  assert.equal(replaceHtmlIfChanged(element, "<p>Updated</p>"), true);
  assert.equal(writes, 2);
  assert.equal(normalizeChatTitle("  Planning\n\t notes  "), "Planning notes");
  assert.equal(normalizeChatTitle("x".repeat(100)).length, 80);
});

test("chat Markdown renders common structures without accepting active HTML or unsafe links", () => {
  const rendered = renderMarkdown(`## Files

| Name | Folder |
| --- | --- |
| **Test Workspace** | \`~/Documents/Test\` |

[Safe](https://example.com/path) [Unsafe](javascript:alert(1))

<script>alert("no")</script>`);
  assert.match(rendered, /<h2>Files<\/h2>/);
  assert.match(rendered, /<table>/);
  assert.match(rendered, /<strong>Test Workspace<\/strong>/);
  assert.match(rendered, /<code>~\/Documents\/Test<\/code>/);
  assert.match(rendered, /href="https:\/\/example\.com\/path" target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(rendered, /href="javascript:/);
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;/);
});

test("the landing download redirects to the latest signed macOS GitHub asset", async (context) => {
  const downloadUrl = "https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/download/v9.8.7/work-fold-9.8.7-mac-arm64.dmg";
  const service = await testService(context, {
    releaseFetcher: async () => new Response(JSON.stringify({
      assets: [{ name: "work-fold-9.8.7-mac-arm64.dmg", browser_download_url: downloadUrl }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const response = await fetch(`http://127.0.0.1:${service.port}/download/macos`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), downloadUrl);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the landing download falls back to GitHub's current releases page when its API is unavailable", async (context) => {
  const service = await testService(context, {
    releaseFetcher: async () => new Response("rate limited", { status: 429 }),
  });
  const response = await fetch(`http://127.0.0.1:${service.port}/download/macos`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest",
  );
});

test("keeps address enrollment server-controlled and browser login origin-bound", async (context) => {
  const closedService = await testService(context, { publicEnrollment: false });
  const closedBaseUrl = `http://127.0.0.1:${closedService.port}`;
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const deviceKeys = deviceKeyPairs();
  const enrollment = {
    slug: "secure-test",
    password: "passw0rd",
    deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
    deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
  };

  const closed = await jsonRequest(`${closedBaseUrl}/api/device/enroll`, { method: "POST", body: enrollment });
  assert.equal(closed.response.status, 503);

  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: enrollment,
  });
  assert.equal(enrolled.response.status, 201);
  assert.equal(enrolled.body.account.slug, "secure-test");
  assert.equal(typeof enrolled.body.deviceToken, "string");

  const noOrigin = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    body: { slug: "secure-test", password: enrollment.password },
  });
  assert.equal(noOrigin.response.status, 403);

  const wrongOrigin = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: "https://attacker.example" },
    body: { slug: "secure-test", password: enrollment.password },
  });
  assert.equal(wrongOrigin.response.status, 403);
});

test("rejects malformed login slugs before verification and keeps IP buckets bounded without evicting protection", async (context) => {
  let passwordChecks = 0;
  const service = await testService(context, {
    trustProxy: true,
    loginProtection: { attemptsPerIp: 2, maximumIpBuckets: 3 },
    passwordVerifierFactory: (database) => async (...arguments_) => {
      passwordChecks += 1;
      return database.authenticatePassword(...arguments_);
    },
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;

  const malformed = async (ip) => loginRequest(baseUrl, {
    ip,
    slug: "not_a_valid_slug",
    password: "irrelevant",
  });
  assert.equal((await malformed("198.51.100.1")).response.status, 401);
  assert.equal((await malformed("198.51.100.2")).response.status, 401);
  assert.equal((await malformed("198.51.100.3")).response.status, 401);
  assert.equal((await malformed("198.51.100.4")).response.status, 429, "new IP buckets fail closed at the configured bound");
  assert.equal((await malformed("198.51.100.1")).response.status, 401);
  assert.equal((await malformed("198.51.100.1")).response.status, 429, "the original IP budget was not evicted");
  assert.equal(passwordChecks, 0, "malformed slugs never reach the password verifier");
});

test("fair bounded password admission lets a known login pass an unknown-slug backlog", async (context) => {
  let markUnknownStarted;
  const unknownStarted = new Promise((resolve) => { markUnknownStarted = resolve; });
  let releaseUnknown;
  const unknownGate = new Promise((resolve) => { releaseUnknown = resolve; });
  const checkedSlugs = [];
  const service = await testService(context, {
    trustProxy: true,
    loginProtection: {
      attemptsPerIp: 10,
      maximumConcurrentChecks: 2,
      maximumConcurrentChecksPerIp: 1,
      maximumQueuedChecks: 2,
      maximumQueuedChecksPerIp: 1,
    },
    passwordVerifierFactory: (database) => async (slug, password) => {
      checkedSlugs.push(slug);
      if (slug.startsWith("missing-")) {
        markUnknownStarted();
        await unknownGate;
      }
      return database.authenticatePassword(slug, password);
    },
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const password = "a long private test password";
  await enrollTestAccount(baseUrl, { slug: "known-login", password });

  const firstUnknown = loginRequest(baseUrl, {
    ip: "198.51.100.10",
    slug: "missing-one",
    password,
  });
  await unknownStarted;
  const secondUnknown = loginRequest(baseUrl, {
    ip: "198.51.100.10",
    slug: "missing-two",
    password,
  });

  const known = await loginRequest(baseUrl, {
    ip: "198.51.100.20",
    slug: "known-login",
    password,
  });
  assert.equal(known.response.status, 200, "a different IP receives the other verifier slot");
  assert.ok(checkedSlugs.includes("known-login"));

  releaseUnknown();
  assert.equal((await firstUnknown).response.status, 401);
  assert.equal((await secondUnknown).response.status, 401);
});

test("password admission rejects work beyond its per-IP queue bound", async () => {
  const queue = createPasswordCheckQueue({
    maximumConcurrentChecks: 1,
    maximumConcurrentChecksPerIp: 1,
    maximumQueuedChecks: 2,
    maximumQueuedChecksPerIp: 1,
  });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  const first = queue.run("198.51.100.10", async () => {
    order.push("first");
    markStarted();
    await gate;
  });
  await started;
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 0, maximumActive: 1, maximumQueued: 2 });
  const second = queue.run("198.51.100.10", async () => { order.push("second"); });
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 1, maximumActive: 1, maximumQueued: 2 });
  await assert.rejects(
    queue.run("198.51.100.10", async () => { order.push("overflow"); }),
    (error) => error?.status === 429,
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, maximumActive: 1, maximumQueued: 2 });
});

test("session CSRF issuance stays stable across tabs and the first tab remains authorized", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const password = "a stable multi-tab csrf password";
  await enrollTestAccount(baseUrl, { slug: "csrf-tabs-test", password });
  const loggedIn = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: baseUrl },
    body: { slug: "csrf-tabs-test", password },
  });
  const cookie = cookieFrom(loggedIn.response);
  const firstTab = await jsonRequest(`${baseUrl}/api/auth/session?slug=csrf-tabs-test`, { headers: { cookie } });
  const secondTab = await jsonRequest(`${baseUrl}/api/auth/session?slug=csrf-tabs-test`, { headers: { cookie } });
  assert.equal(firstTab.body.csrfToken, secondTab.body.csrfToken);

  const signedOut = await jsonRequest(`${baseUrl}/api/auth/session?slug=csrf-tabs-test`, {
    method: "DELETE",
    headers: { origin: baseUrl, cookie, "x-work-fold-csrf": firstTab.body.csrfToken },
  });
  assert.equal(signedOut.response.status, 200);
  assert.equal(signedOut.body.signedOut, true, "a later tab read does not invalidate the first tab's token");
});

test("bridge metrics count only aggregate HTTP and device activity", async (context) => {
  const reports = [];
  const service = await testService(context, {
    metrics: {
      sink: (record) => reports.push(record),
      reportIntervalMs: 60_000,
      eventLoopLagWarningMs: 10,
    },
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  assert.equal(reports[0]?.type, "work-fold.bridge.metrics.v1");
  assert.equal(reports[0]?.reason, "startup");
  assert.equal(reports[0]?.publicEnrollment, true);

  await fetch(`${baseUrl}/health`);
  const enrolled = await enrollTestAccount(baseUrl, {
    slug: "aggregate-metrics-test",
    password: "an aggregate metrics test password",
  });
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.deviceToken}` },
  });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");
  socket.send(JSON.stringify({ type: "device.heartbeat" }));
  await messages.next("device.heartbeat");

  const snapshot = service.metrics.snapshot();
  assert.ok(snapshot.http.requestsTotal >= 2);
  assert.equal(snapshot.deviceWebSocket.framesTotal, 1);
  assert.equal(snapshot.connections.devicesCurrent, 1);
  assert.equal(snapshot.publicEnrollment, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /aggregate-metrics-test|Bearer|deviceToken|slug|requestId/);

  const warning = service.metrics.report({ reason: "manual", eventLoopLagMs: 25 });
  assert.equal(warning.severity, "warning");
  assert.ok(warning.warnings.includes("event_loop_lag"));
  const absentEndpoint = await fetch(`${baseUrl}/api/metrics`);
  assert.equal(absentEndpoint.status, 404, "metrics stay in the process log and are not a public endpoint");
});

test("distributed password failures cannot lock a correct account login", async (context) => {
  const checkedSlugs = [];
  const service = await testService(context, {
    trustProxy: true,
    loginProtection: { attemptsPerIp: 2, maximumIpBuckets: 64 },
    passwordVerifierFactory: (database) => async (slug, password) => {
      checkedSlugs.push(slug);
      if (password === "definitely-wrong") return null;
      return database.authenticatePassword(slug, password);
    },
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const password = "another private test password";
  await enrollTestAccount(baseUrl, { slug: "failure-pressure", password });

  let knownFailureBody;
  for (let index = 1; index <= 21; index += 1) {
    const failed = await loginRequest(baseUrl, {
      ip: `198.51.100.${index}`,
      slug: "failure-pressure",
      password: "definitely-wrong",
    });
    assert.equal(failed.response.status, 401);
    knownFailureBody ??= failed.body;
  }
  const unknownFailure = await loginRequest(baseUrl, {
    ip: "198.51.100.30",
    slug: "well-formed-unknown",
    password: "definitely-wrong",
  });
  assert.equal(unknownFailure.response.status, 401);
  assert.deepEqual(unknownFailure.body, knownFailureBody, "known and unknown credential failures remain indistinguishable");
  assert.ok(checkedSlugs.includes("well-formed-unknown"), "well-formed unknown slugs still take the verifier path");

  const correct = await loginRequest(baseUrl, {
    ip: "198.51.100.40",
    slug: "failure-pressure",
    password,
  });
  assert.equal(correct.response.status, 200);
});

test("device protocol errors are finite while unknown frames remain forward-compatible", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const enrolled = await enrollTestAccount(baseUrl, {
    slug: "device-protocol-test",
    password: "a private device protocol password",
  });
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.deviceToken}` },
  });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  socket.send(JSON.stringify({ type: "device.future-notification.v2", payload: { future: true } }));
  socket.send(JSON.stringify({ type: "device.heartbeat" }));
  await messages.next("device.heartbeat");
  assert.equal(messages.takeNow("protocol.error"), null, "unknown future frames are ignored without starting an error exchange");

  socket.send("{");
  assert.match((await messages.next("protocol.error")).error, /must be JSON/);
  socket.send(JSON.stringify({ type: "operation.event", envelope: null }));
  assert.match((await messages.next("protocol.error")).error, /envelope is invalid/);
  const closedForBudget = socketClosed(socket);
  socket.send(JSON.stringify([]));
  const budgetClose = await closedForBudget;
  assert.equal(budgetClose.code, 1002);
  assert.equal(messages.takeNow("protocol.error"), null, "the over-budget frame closes instead of producing an unbounded reply");

  const terminalSocket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.deviceToken}` },
  });
  context.after(() => terminalSocket.close());
  const terminalMessages = messageQueue(terminalSocket);
  await terminalMessages.next("device.ready");
  const terminalClose = socketClosed(terminalSocket);
  terminalSocket.send(JSON.stringify({ type: "protocol.error", error: "desktop rejected a bridge frame" }));
  assert.equal((await terminalClose).code, 1002);
  assert.equal(terminalMessages.takeNow("protocol.error"), null, "an inbound protocol error is terminal and is never answered in kind");
});

test("a displaced device cannot decide a pairing and the current device can decline it", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const origin = baseUrl;
  const password = "a private displacement test password";
  const deviceKeys = deviceKeyPairs();
  const browserKeys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug: "device-displacement-test",
      password,
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  const oldSocket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.body.deviceToken}` },
  });
  context.after(() => oldSocket.close());
  const oldMessages = messageQueue(oldSocket);
  await oldMessages.next("device.ready");

  const loggedIn = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin },
    body: { slug: "device-displacement-test", password },
  });
  const cookie = cookieFrom(loggedIn.response);
  const pairing = await jsonRequest(`${baseUrl}/api/pairings?slug=device-displacement-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": loggedIn.body.csrfToken },
    body: {
      pairingId: randomUUID(),
      browserId: "browser-displacement-test",
      label: "Displacement test browser",
      signingPublicJwk: browserKeys.signing.publicJwk,
      encryptionPublicJwk: browserKeys.encryption.publicJwk,
    },
  });
  await oldMessages.next("pairing.request");

  const originalAccountById = service.database.accountById.bind(service.database);
  let markStaleReadStarted;
  const staleReadStarted = new Promise((resolve) => { markStaleReadStarted = resolve; });
  let releaseStaleRead;
  const staleReadGate = new Promise((resolve) => { releaseStaleRead = resolve; });
  let blockFirstRead = true;
  service.database.accountById = async (...arguments_) => {
    const account = await originalAccountById(...arguments_);
    if (blockFirstRead) {
      blockFirstRead = false;
      markStaleReadStarted();
      await staleReadGate;
    }
    return account;
  };

  oldSocket.send(JSON.stringify({ type: "pairing.decision", pairingId: pairing.body.pairing.id, approved: false }));
  await staleReadStarted;
  const currentSocket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.body.deviceToken}` },
  });
  context.after(() => currentSocket.close());
  const currentMessages = messageQueue(currentSocket);
  await currentMessages.next("device.ready");
  releaseStaleRead();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stillPending = await jsonRequest(`${baseUrl}/api/pairings/${pairing.body.pairing.id}?slug=device-displacement-test`, {
    headers: { cookie },
  });
  assert.equal(stillPending.body.pairing.status, "pending", "the displaced socket's in-flight decision is fenced before mutation");

  currentSocket.send(JSON.stringify({ type: "pairing.decision", pairingId: pairing.body.pairing.id, approved: false }));
  const declined = await currentMessages.next("pairing.settled");
  assert.equal(declined.status, "declined");
  const pairingResult = await jsonRequest(`${baseUrl}/api/pairings/${pairing.body.pairing.id}?slug=device-displacement-test`, {
    headers: { cookie },
  });
  assert.equal(pairingResult.body.pairing.status, "declined");
});

test("browser sessions, grants, operations, and device revocation stay account-scoped", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const origin = baseUrl;
  const accountA = await pairedAccountFixture(context, baseUrl, {
    slug: "isolation-alpha",
    password: "an isolation password for alpha",
    browserId: "browser-isolation-alpha",
  });
  const accountB = await pairedAccountFixture(context, baseUrl, {
    slug: "isolation-bravo",
    password: "an isolation password for bravo",
    browserId: "browser-isolation-bravo",
  });

  const crossSession = await jsonRequest(`${baseUrl}/api/auth/session?slug=${accountB.slug}`, {
    headers: { cookie: accountA.cookie },
  });
  assert.equal(crossSession.response.status, 401, "A's cookie cannot read B's session");

  const crossPairing = await jsonRequest(
    `${baseUrl}/api/pairings/${accountB.pairing.id}?slug=${accountB.slug}`,
    { headers: { cookie: accountA.cookie } },
  );
  assert.equal(crossPairing.response.status, 401, "A's cookie cannot poll B's pairing");

  const crossEvents = await jsonRequest(`${baseUrl}/api/events?slug=${accountB.slug}`, {
    headers: { cookie: accountA.cookie },
  });
  assert.equal(crossEvents.response.status, 401, "A's cookie cannot open B's event stream");

  const operationBEnvelope = browserOperationEnvelope(accountB);
  const crossOperationPost = await jsonRequest(`${baseUrl}/api/operations?slug=${accountB.slug}`, {
    method: "POST",
    headers: { origin, cookie: accountA.cookie, "x-work-fold-csrf": accountA.csrfToken },
    body: { envelope: operationBEnvelope },
  });
  assert.equal(crossOperationPost.response.status, 401, "A's session cannot submit B's signed operation");

  const acceptedB = await jsonRequest(`${baseUrl}/api/operations?slug=${accountB.slug}`, {
    method: "POST",
    headers: { origin, cookie: accountB.cookie, "x-work-fold-csrf": accountB.csrfToken },
    body: { envelope: operationBEnvelope },
  });
  assert.equal(acceptedB.response.status, 202);
  const deliveredB = await accountB.messages.next("operation.request");
  assert.equal(deliveredB.operation.id, acceptedB.body.operation.id);

  const crossOperationGet = await jsonRequest(
    `${baseUrl}/api/operations/${deliveredB.operation.id}?slug=${accountB.slug}`,
    { headers: { cookie: accountA.cookie } },
  );
  assert.equal(crossOperationGet.response.status, 401, "A's cookie cannot read B's operation through B's account");
  const crossGrantOperationGet = await jsonRequest(
    `${baseUrl}/api/operations/${deliveredB.operation.id}?slug=${accountA.slug}`,
    { headers: { cookie: accountA.cookie } },
  );
  assert.equal(crossGrantOperationGet.response.status, 404, "A's own session cannot resolve B's operation id");

  const crossBindTarget = await jsonRequest(`${baseUrl}/api/auth/bind?slug=${accountB.slug}`, {
    method: "POST",
    headers: { origin, cookie: accountA.cookie, "x-work-fold-csrf": accountA.csrfToken },
    body: { browserId: accountB.browserId, signature: "invalid" },
  });
  assert.equal(crossBindTarget.response.status, 401, "A's cookie cannot reach B's bind authority");

  const freshALogin = await loginRequest(baseUrl, { slug: accountA.slug, password: accountA.password });
  const freshACookie = cookieFrom(freshALogin.response);
  const crossAccountProof = canonicalizeJson({
    type: "work-fold.browser-bind.v1",
    accountId: accountA.account.id,
    browserId: accountB.browserId,
    challenge: freshALogin.body.challenge,
  });
  const crossAccountBind = await jsonRequest(`${baseUrl}/api/auth/bind?slug=${accountA.slug}`, {
    method: "POST",
    headers: { origin, cookie: freshACookie, "x-work-fold-csrf": freshALogin.body.csrfToken },
    body: {
      browserId: accountB.browserId,
      signature: signText(accountB.browserKeys.signing.privateKey, crossAccountProof),
    },
  });
  assert.equal(crossAccountBind.response.status, 403);
  assert.equal(crossAccountBind.body.code, "pairing_required", "B's grant cannot bind an unpaired A session");

  const crossRevoke = await jsonRequest(`${baseUrl}/api/device/grants/${accountA.certificate.grantId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accountB.deviceToken}` },
  });
  assert.equal(crossRevoke.response.status, 200);
  assert.equal(crossRevoke.body.revoked, false, "device B cannot revoke account A's grant id");

  const survivingSession = await jsonRequest(`${baseUrl}/api/auth/session?slug=${accountA.slug}`, {
    headers: { cookie: accountA.cookie },
  });
  assert.equal(survivingSession.response.status, 200);
  assert.equal(survivingSession.body.paired, true);
  assert.equal(survivingSession.body.grant.id, accountA.certificate.grantId);

  const eventAbort = new AbortController();
  context.after(() => eventAbort.abort());
  const eventResponse = await fetch(`${baseUrl}/api/events?slug=${accountA.slug}`, {
    headers: { cookie: accountA.cookie },
    signal: eventAbort.signal,
  });
  assert.equal(eventResponse.status, 200, "A's grant remains authorized after B's failed revoke");
  const accountAEvents = sseQueue(eventResponse.body);
  await accountAEvents.next("ready");

  const operationAEnvelope = browserOperationEnvelope(accountA);
  const acceptedA = await jsonRequest(`${baseUrl}/api/operations?slug=${accountA.slug}`, {
    method: "POST",
    headers: { origin, cookie: accountA.cookie, "x-work-fold-csrf": survivingSession.body.csrfToken },
    body: { envelope: operationAEnvelope },
  });
  assert.equal(acceptedA.response.status, 202, "A's surviving grant can still submit operations");
  const deliveredA = await accountA.messages.next("operation.request");
  assert.equal(deliveredA.operation.id, acceptedA.body.operation.id);

  const responseHeader = {
    type: "work-fold.remote-response.v1",
    accountId: accountA.account.id,
    deviceId: accountA.account.id,
    grantId: accountA.certificate.grantId,
    operationId: deliveredA.operation.id,
    requestId: operationAEnvelope.header.requestId,
    generation: accountA.account.grantGeneration,
    sequence: 1,
    ok: true,
    eventKind: "operation.event",
    createdAt: new Date().toISOString(),
  };
  const staleResponse = signedEnvelope({
    ...responseHeader,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  }, accountA.deviceKeys.signing.privateKey);
  accountA.socket.send(JSON.stringify({ type: "operation.event", envelope: staleResponse }));
  assert.match((await accountA.messages.next("protocol.error")).error, /timestamp is stale/);

  const wrongAccountResponse = signedEnvelope({
    ...responseHeader,
    accountId: accountB.account.id,
    deviceId: accountB.account.id,
  }, accountB.deviceKeys.signing.privateKey);
  accountA.socket.send(JSON.stringify({ type: "operation.event", envelope: wrongAccountResponse }));
  assert.match((await accountA.messages.next("protocol.error")).error, /envelope is invalid/);
  accountA.socket.send(JSON.stringify({ type: "device.heartbeat" }));
  await accountA.messages.next("device.heartbeat");

  const untouchedA = await jsonRequest(
    `${baseUrl}/api/operations/${deliveredA.operation.id}?slug=${accountA.slug}`,
    { headers: { cookie: accountA.cookie } },
  );
  assert.equal(untouchedA.body.operation.state, "delivered");
  assert.deepEqual(untouchedA.body.events, []);
  assert.equal(accountAEvents.takeNow("remote"), null, "rejected cross-account responses never reach A's browser");

  const survivingB = await jsonRequest(
    `${baseUrl}/api/operations/${deliveredB.operation.id}?slug=${accountB.slug}`,
    { headers: { cookie: accountB.cookie } },
  );
  assert.equal(survivingB.response.status, 200, "B's own session still resolves B's operation");
});

test("pairs a non-exportable browser identity and relays only signed opaque envelopes", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const origin = baseUrl;
  const deviceKeys = deviceKeyPairs();
  const browserKeys = deviceKeyPairs();
  const password = "a long private test password";

  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug: "alice-test",
      password,
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  assert.equal(enrolled.response.status, 201);
  const account = enrolled.body.account;

  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.body.deviceToken}` },
  });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  const loggedIn = await jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin },
    body: { slug: "alice-test", password },
  });
  assert.equal(loggedIn.response.status, 200);
  const cookie = cookieFrom(loggedIn.response);

  const paired = await jsonRequest(`${baseUrl}/api/pairings?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": loggedIn.body.csrfToken },
    body: {
      pairingId: randomUUID(),
      browserId: "browser-test-1",
      label: "Test browser",
      signingPublicJwk: browserKeys.signing.publicJwk,
      encryptionPublicJwk: browserKeys.encryption.publicJwk,
    },
  });
  assert.equal(paired.response.status, 202);
  assert.match(paired.body.pairing.code, /^\d{6}$/);

  const requested = await messages.next("pairing.request");
  assert.equal(requested.pairing.id, paired.body.pairing.id);
  const certificate = {
    type: "work-fold.browser-grant.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: randomUUID(),
    pairingId: paired.body.pairing.id,
    pairingCode: paired.body.pairing.code,
    browserId: "browser-test-1",
    browserSigningPublicJwk: browserKeys.signing.publicJwk,
    browserEncryptionPublicJwk: browserKeys.encryption.publicJwk,
    generation: account.grantGeneration,
    approvedAt: new Date().toISOString(),
  };
  socket.send(JSON.stringify({
    type: "pairing.decision",
    pairingId: paired.body.pairing.id,
    approved: true,
    certificate,
    signature: signText(deviceKeys.signing.privateKey, canonicalizeJson(certificate)),
  }));
  const settled = await messages.next("pairing.settled");
  assert.equal(settled.status, "approved");

  const pairingResult = await jsonRequest(`${baseUrl}/api/pairings/${paired.body.pairing.id}?slug=alice-test`, {
    headers: { cookie },
  });
  assert.equal(pairingResult.body.pairing.status, "approved");
  assert.equal(pairingResult.body.pairing.approvalCertificate.grantId, certificate.grantId);

  const session = await jsonRequest(`${baseUrl}/api/auth/session?slug=alice-test`, { headers: { cookie } });
  assert.equal(session.body.paired, true);
  assert.equal(session.body.grant.id, certificate.grantId);
  const eventAbort = new AbortController();
  context.after(() => eventAbort.abort());
  const eventResponse = await fetch(`${baseUrl}/api/events?slug=alice-test`, {
    headers: { cookie },
    signal: eventAbort.signal,
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type"), /^text\/event-stream/);
  const browserEvents = sseQueue(eventResponse.body);
  await browserEvents.next("ready");

  const requestHeader = {
    type: "work-fold.remote-request.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: certificate.grantId,
    generation: account.grantGeneration,
    requestId: randomUUID(),
    operation: "spaces.list",
    createdAt: new Date().toISOString(),
  };
  const requestEnvelope = {
    header: requestHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(48).toString("base64url"),
    signature: "",
  };
  requestEnvelope.signature = signText(browserKeys.signing.privateKey, envelopeText(requestEnvelope));
  const rejectedEnvelopes = [
    {
      expectedStatus: 400,
      envelope: signedEnvelope({
        ...requestHeader,
        requestId: randomUUID(),
        createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }, browserKeys.signing.privateKey),
    },
    {
      expectedStatus: 403,
      envelope: signedEnvelope({ ...requestHeader, requestId: randomUUID() }, deviceKeys.signing.privateKey),
    },
    {
      expectedStatus: 400,
      envelope: signedEnvelope({ ...requestHeader, requestId: randomUUID(), grantId: randomUUID() }, browserKeys.signing.privateKey),
    },
    {
      expectedStatus: 400,
      envelope: signedEnvelope({ ...requestHeader, requestId: randomUUID(), generation: requestHeader.generation + 1 }, browserKeys.signing.privateKey),
    },
  ];
  for (const rejected of rejectedEnvelopes) {
    const result = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
      method: "POST",
      headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
      body: { envelope: rejected.envelope },
    });
    assert.equal(result.response.status, rejected.expectedStatus);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messages.takeNow("operation.request"), null, "invalid browser envelopes never reach the desktop");
  assert.equal(browserEvents.takeNow("remote"), null, "invalid browser envelopes never broadcast an event");

  const accepted = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
    body: { envelope: requestEnvelope },
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.operation.state, "delivered");

  const delivered = await messages.next("operation.request");
  assert.deepEqual(delivered.envelope, requestEnvelope);
  assert.equal(delivered.operation.operation, "spaces.list");

  const duplicate = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
    body: { envelope: requestEnvelope },
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.operation.id, delivered.operation.id);
  assert.equal(duplicate.body.operation.state, "delivered");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.takeNow("operation.request"), null, "a concurrent duplicate must not reach the desktop twice");

  const progressHeader = {
    type: "work-fold.remote-response.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: certificate.grantId,
    operationId: delivered.operation.id,
    requestId: requestHeader.requestId,
    generation: account.grantGeneration,
    sequence: 1,
    ok: true,
    eventKind: "operation.event",
    createdAt: new Date().toISOString(),
  };
  const progressEnvelope = {
    header: progressHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(220 * 1024).toString("base64url"),
    signature: "",
  };
  progressEnvelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(progressEnvelope));
  const badDesktopEnvelope = {
    ...progressEnvelope,
    ciphertext: randomBytes(48).toString("base64url"),
    signature: "",
  };
  badDesktopEnvelope.signature = signText(browserKeys.signing.privateKey, envelopeText(badDesktopEnvelope));
  socket.send(JSON.stringify({ type: "operation.event", envelope: badDesktopEnvelope }));
  assert.match((await messages.next("protocol.error")).error, /signature is invalid/);
  const afterBadSignature = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
  assert.equal(afterBadSignature.body.operation.state, "delivered");
  assert.deepEqual(afterBadSignature.body.events, []);
  assert.equal(browserEvents.takeNow("remote"), null, "a bad desktop signature is not broadcast");

  socket.send(JSON.stringify({ type: "operation.event", envelope: progressEnvelope }));
  const largeBrowserEvent = await browserEvents.next(
    "remote",
    (event) => event.data.operationId === delivered.operation.id && event.data.envelope?.header?.sequence === 1,
  );
  assert.ok(largeBrowserEvent.data.envelope.ciphertext.length > 200 * 1024, "the event crosses Node's ordinary write high-water mark");
  await waitFor(async () => {
    const result = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
    return result.body.operation?.state === "running" ? result : null;
  });

  socket.send(JSON.stringify({ type: "operation.event", envelope: progressEnvelope }));
  assert.match((await messages.next("protocol.error")).error, /sequence must increase/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterReplay = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
  assert.equal(afterReplay.body.events.length, 1);
  assert.equal(
    browserEvents.takeNow("remote", (event) => event.data.operationId === delivered.operation.id && event.data.envelope?.header?.sequence === 1),
    null,
    "a replayed response sequence is not broadcast",
  );

  const followUpHeader = { ...progressHeader, sequence: 2, createdAt: new Date().toISOString() };
  const followUpEnvelope = {
    header: followUpHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(48).toString("base64url"),
    signature: "",
  };
  followUpEnvelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(followUpEnvelope));
  socket.send(JSON.stringify({ type: "operation.event", envelope: followUpEnvelope }));
  const followUpBrowserEvent = await browserEvents.next(
    "remote",
    (event) => event.data.operationId === delivered.operation.id && event.data.envelope?.header?.sequence === 2,
  );
  assert.deepEqual(followUpBrowserEvent.data.envelope, followUpEnvelope, "the SSE stream remains usable after the large buffered event");

  socket.close();
  const lost = await waitFor(async () => {
    const result = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
    return result.body.operation?.state === "lost" ? result : null;
  });
  assert.equal(lost.body.events.at(-1).envelope.header.eventKind, "operation.event", "progress remains cached while exact-id recovery is required");
  const resumedSocket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.body.deviceToken}` },
  });
  context.after(() => resumedSocket.close());
  const resumedMessages = messageQueue(resumedSocket);
  await resumedMessages.next("device.ready");
  const recovered = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
    body: { envelope: requestEnvelope, recover: true },
  });
  assert.equal(recovered.response.status, 202);
  assert.equal(recovered.body.operation.id, delivered.operation.id);
  assert.equal(recovered.body.operation.requestId, requestHeader.requestId);
  const redelivered = await resumedMessages.next("operation.request");
  assert.equal(redelivered.operation.id, delivered.operation.id);
  assert.deepEqual(redelivered.envelope, requestEnvelope);

  const responseHeader = {
    type: "work-fold.remote-response.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: certificate.grantId,
    operationId: delivered.operation.id,
    requestId: requestHeader.requestId,
    generation: account.grantGeneration,
    sequence: 3,
    ok: true,
    eventKind: "operation.complete",
    createdAt: new Date().toISOString(),
  };
  const responseEnvelope = {
    header: responseHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(64).toString("base64url"),
    signature: "",
  };
  responseEnvelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(responseEnvelope));
  resumedSocket.send(JSON.stringify({ type: "operation.complete", envelope: responseEnvelope }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const protocolError = resumedMessages.takeNow("protocol.error");
  assert.equal(protocolError, null, protocolError?.error);

  await waitFor(async () => {
    const result = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
    return result.body.operation?.state === "done" ? result : null;
  });
  const completed = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
  assert.equal(completed.body.events.length, 3);
  assert.deepEqual(completed.body.events[0].envelope, progressEnvelope);
  assert.deepEqual(completed.body.events[1].envelope, followUpEnvelope);
  assert.deepEqual(completed.body.events[2].envelope, responseEnvelope);

  const uploadHeader = {
    ...requestHeader,
    requestId: randomUUID(),
    operation: "management.send",
    createdAt: new Date().toISOString(),
  };
  const uploadEnvelope = {
    header: uploadHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: "A".repeat(13 * 1024 * 1024),
    signature: "",
  };
  uploadEnvelope.signature = signText(browserKeys.signing.privateKey, envelopeText(uploadEnvelope));
  const acceptedUpload = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
    body: { envelope: uploadEnvelope },
  });
  assert.equal(acceptedUpload.response.status, 202, "the outer encrypted envelope must accommodate the documented 8 MB decoded upload batch");
  const deliveredUpload = await resumedMessages.next("operation.request");
  assert.equal(deliveredUpload.operation.requestId, uploadHeader.requestId);
  assert.equal(deliveredUpload.envelope.ciphertext.length, uploadEnvelope.ciphertext.length);

  const mismatchedDesktopHeaders = [
    {
      ...responseHeader,
      operationId: deliveredUpload.operation.id,
      requestId: uploadHeader.requestId,
      grantId: randomUUID(),
      sequence: 1,
      eventKind: "operation.event",
      createdAt: new Date().toISOString(),
    },
    {
      ...responseHeader,
      operationId: deliveredUpload.operation.id,
      requestId: uploadHeader.requestId,
      generation: responseHeader.generation + 1,
      sequence: 1,
      eventKind: "operation.event",
      createdAt: new Date().toISOString(),
    },
  ];
  for (const header of mismatchedDesktopHeaders) {
    const envelope = signedEnvelope(header, deviceKeys.signing.privateKey);
    resumedSocket.send(JSON.stringify({ type: "operation.event", envelope }));
    assert.match((await resumedMessages.next("protocol.error")).error, /does not match an accepted operation/);
  }
  const untouchedUpload = await jsonRequest(`${baseUrl}/api/operations/${deliveredUpload.operation.id}?slug=alice-test`, { headers: { cookie } });
  assert.equal(untouchedUpload.body.operation.state, "delivered");
  assert.deepEqual(untouchedUpload.body.events, []);
  assert.equal(
    browserEvents.takeNow("remote", (event) => event.data.operationId === deliveredUpload.operation.id),
    null,
    "wrong desktop grant/generation responses are not broadcast",
  );

  const directSpaceHeader = {
    ...requestHeader,
    requestId: randomUUID(),
    operation: "spaces.send",
    createdAt: new Date().toISOString(),
  };
  const directSpaceEnvelope = {
    header: directSpaceHeader,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(64).toString("base64url"),
    signature: "",
  };
  directSpaceEnvelope.signature = signText(browserKeys.signing.privateKey, envelopeText(directSpaceEnvelope));
  const rejectedDirectSpace = await jsonRequest(`${baseUrl}/api/operations?slug=alice-test`, {
    method: "POST",
    headers: { origin, cookie, "x-work-fold-csrf": session.body.csrfToken },
    body: { envelope: directSpaceEnvelope },
  });
  assert.equal(rejectedDirectSpace.response.status, 400, "the bridge rejects direct Space Chat operations");
});

test("a reserved pages-* host serves viewer routes or nothing, never the management surface", async (context) => {
  const service = await testService(context, { trustProxy: true });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const viewerHost = { "x-forwarded-host": "pages-someone.work-fold.test" };

  const page = await fetch(baseUrl, { headers: viewerHost });
  assert.equal(page.status, 404);
  assert.match(page.headers.get("content-type"), /^text\/plain/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(page.headers.get("x-robots-tag"), /noindex/);
  assert.equal(await page.text(), "Nothing is published here.\n");

  const shell = await fetch(`${baseUrl}/p/some-publication`, { headers: viewerHost });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type"), /^text\/html/);
  assert.match(shell.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
  assert.equal(shell.headers.get("set-cookie"), null, "the viewer origin never sets a cookie");
  assert.match(await shell.text(), /viewer\.js/);
  const shellModule = await fetch(`${baseUrl}/viewer.js`, { headers: viewerHost });
  assert.equal(shellModule.status, 200);
  assert.match(await shellModule.text(), /Nothing is published here\./);

  const shellOnManagement = await fetch(`${baseUrl}/viewer/index.html`);
  assert.equal(shellOnManagement.status, 404, "the management origin never serves viewer content");
  const spaFallback = await fetch(`${baseUrl}/p/some-publication`);
  assert.equal(spaFallback.status, 200);
  assert.match(await spaFallback.text(), /<title>work-fold<\/title>/, "the management origin keeps its own client on /p/ paths");

  const clientBundle = await fetch(`${baseUrl}/app.js`, { headers: viewerHost });
  assert.equal(clientBundle.status, 404);
  assert.equal(await clientBundle.text(), "Nothing is published here.\n", "the management client bundle is never served on a viewer host");

  const managementApi = await fetch(`${baseUrl}/api/public/context`, { headers: viewerHost });
  assert.equal(managementApi.status, 404);
  assert.equal(await managementApi.text(), "Nothing is published here.\n", "management API surfaces do not exist on a viewer host");

  const health = await fetch(`${baseUrl}/health`, { headers: viewerHost });
  assert.equal(health.status, 404, "a viewer host serves viewer routes or nothing");

  const robots = await fetch(`${baseUrl}/robots.txt`, { headers: viewerHost });
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \//);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { ...viewerHost, origin: "https://pages-someone.work-fold.test", "content-type": "application/json" },
    body: JSON.stringify({ slug: "someone", password: "irrelevant password" }),
  });
  assert.equal(login.status, 405, "sign-in does not exist on the viewer origin");
  assert.equal(login.headers.get("set-cookie"), null);

  const exactPages = await fetch(baseUrl, { headers: { "x-forwarded-host": "pages.work-fold.test" } });
  assert.equal(exactPages.status, 404, "the bare pages label is reserved together with the prefix");

  const unreserved = await fetch(baseUrl, { headers: { "x-forwarded-host": "pagesmith.work-fold.test" } });
  assert.equal(unreserved.status, 200, "only the exact pages label and the pages- prefix are diverted");
  assert.match(unreserved.headers.get("content-type"), /^text\/html/);

  const keys = deviceKeyPairs();
  const enrollReserved = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug: "pages-someone",
      password: "a viewer namespace password",
      deviceSigningPublicJwk: keys.signing.publicJwk,
      deviceEncryptionPublicJwk: keys.encryption.publicJwk,
    },
  });
  assert.equal(enrollReserved.response.status, 400);
  assert.equal(enrollReserved.body.code, "invalid_slug", "enrollment can no longer take a viewer-namespace address");

  const upgradeStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${service.port}/api/device/connect`, {
      headers: { authorization: "Bearer an-irrelevant-token", "x-forwarded-host": "pages-someone.work-fold.test" },
    });
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the viewer-host upgrade rejection.")), 5_000);
    socket.on("unexpected-response", (_request, upgradeResponse) => {
      clearTimeout(timer);
      socket.terminate();
      resolve(upgradeResponse.statusCode);
    });
    socket.on("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("The device lane must not open on a viewer host."));
    });
    socket.on("error", () => undefined);
  });
  assert.equal(upgradeStatus, 404, "the device lane does not exist on a viewer host");
});

test("viewer operations stay outside the management allowlist and publication slots stay device-authenticated", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const origin = baseUrl;
  const fixture = await pairedAccountFixture(context, baseUrl, {
    slug: "publisher-test",
    password: "a publication slot password",
    browserId: "browser-publisher-test",
  });

  for (const operation of ["viewer.fetch", "publications.sync", "management.future-unknown"]) {
    const envelope = signedEnvelope({
      type: "work-fold.remote-request.v1",
      accountId: fixture.account.id,
      deviceId: fixture.account.id,
      grantId: fixture.certificate.grantId,
      generation: fixture.account.grantGeneration,
      requestId: randomUUID(),
      operation,
      createdAt: new Date().toISOString(),
    }, fixture.browserKeys.signing.privateKey);
    const rejected = await jsonRequest(`${baseUrl}/api/operations?slug=publisher-test`, {
      method: "POST",
      headers: { origin, cookie: fixture.cookie, "x-work-fold-csrf": fixture.csrfToken },
      body: { envelope },
    });
    assert.equal(rejected.response.status, 400, `${operation} is rejected by the management allowlist`);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.messages.takeNow("operation.request"), null, "no rejected operation name reaches the desktop");

  const unauthenticated = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "PUT",
    body: { operationId: "operation-unauthorized", kind: "page" },
  });
  assert.equal(unauthenticated.response.status, 401, "publication sync requires the device bearer token");

  const authorization = { authorization: `Bearer ${fixture.deviceToken}` };
  const createBody = { operationId: "operation-http-1", kind: "page", snapshotEnabled: true };
  const created = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "PUT",
    headers: authorization,
    body: createBody,
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(Object.keys(created.body.publication).sort(), [
    "byteBudgetPerDay", "createdAt", "expiresAt", "id", "kind", "operationId",
    "serveRatePerMinute", "servedBytes", "snapshotEnabled", "state", "updatedAt",
  ], "the slot response is content-free: identifiers, budgets, counters, and state only");

  const replayed = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "PUT",
    headers: authorization,
    body: createBody,
  });
  assert.equal(replayed.response.status, 200, "a replayed operation id is idempotent");
  assert.equal(replayed.body.publication.operationId, "operation-http-1");

  const contentBearing = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-http-2", kind: "page", title: "Quarterly report" },
  });
  assert.equal(contentBearing.response.status, 400, "content-bearing fields are rejected, never stored");

  const snapshot = await jsonRequest(`${baseUrl}/api/device/publications/publication-http/snapshot`, {
    method: "PUT",
    headers: authorization,
    body: {
      ciphertext: "A".repeat(2048),
      iv: randomBytes(12).toString("base64url"),
      contentDigest: "sha256:http-snapshot",
      capturedAt: new Date().toISOString(),
    },
  });
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.stored, true);
  assert.equal(snapshot.body.snapshot.ciphertext, undefined, "snapshot acknowledgements never echo ciphertext");
  assert.equal(snapshot.body.snapshot.byteSize, 2048);

  const snapshotRemoved = await jsonRequest(`${baseUrl}/api/device/publications/publication-http/snapshot`, {
    method: "DELETE",
    headers: authorization,
  });
  assert.equal(snapshotRemoved.body.removed, true);

  const removed = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "DELETE",
    headers: authorization,
  });
  assert.equal(removed.body.removed, true);
  const removedAgain = await jsonRequest(`${baseUrl}/api/device/publications/publication-http`, {
    method: "DELETE",
    headers: authorization,
  });
  assert.equal(removedAgain.body.removed, false, "revocation is idempotent");
});

test("the fold's decision and glance operations pass the management allowlist content-blind", async (context) => {
  const service = await testService(context);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const fixture = await pairedAccountFixture(context, baseUrl, {
    slug: "fold-wave-test",
    password: "a fold wave password",
    browserId: "browser-fold-wave",
  });

  // The remote wave lands allowlist-first (docs/fold-integration.md,
  // reconciliation 7): the bridge accepts the operation names and relays the
  // signed ciphertext untouched. Cards and digests stay end-to-end encrypted
  // between the desktop and the approved browser; staged acts never live here.
  for (const operation of ["decisions.list", "decisions.decide", "management.glance", "management.glanceSeen"]) {
    const envelope = signedEnvelope({
      type: "work-fold.remote-request.v1",
      accountId: fixture.account.id,
      deviceId: fixture.account.id,
      grantId: fixture.certificate.grantId,
      generation: fixture.account.grantGeneration,
      requestId: randomUUID(),
      operation,
      createdAt: new Date().toISOString(),
    }, fixture.browserKeys.signing.privateKey);
    const accepted = await jsonRequest(`${baseUrl}/api/operations?slug=fold-wave-test`, {
      method: "POST",
      headers: { origin: baseUrl, cookie: fixture.cookie, "x-work-fold-csrf": fixture.csrfToken },
      body: { envelope },
    });
    assert.equal(accepted.response.status, 202, `${operation} passes the management allowlist`);
    const delivered = await fixture.messages.next("operation.request");
    assert.equal(delivered.operation.operation, operation);
    assert.deepEqual(delivered.envelope, envelope, "the bridge relays the envelope untouched — it stays content-blind");
  }

  // No decision or glance spelling opens a side door for unpaired viewers:
  // the names stay management operations behind the approved-browser session.
  const unauthenticated = await jsonRequest(`${baseUrl}/api/operations?slug=fold-wave-test`, {
    method: "POST",
    headers: { origin: baseUrl },
    body: { envelope: browserOperationEnvelope(fixture) },
  });
  assert.equal(unauthenticated.response.status, 401);
});

test("the viewer plane serves live pages, charges budgets, keeps snapshots, and honors revocation", async (context) => {
  const service = await testService(context, { trustProxy: true });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const slug = "sharer-test";
  const deviceKeys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug,
      password: "a viewer serving password",
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  assert.equal(enrolled.response.status, 201);
  const account = enrolled.body.account;
  const authorization = { authorization: `Bearer ${enrolled.body.deviceToken}` };
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/device/connect`, { headers: authorization });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  const publicationId = "publication-viewer-live";
  const created = await jsonRequest(`${baseUrl}/api/device/publications/${publicationId}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-viewer-live-1", kind: "page", snapshotEnabled: true },
  });
  assert.equal(created.response.status, 201);

  const viewerHost = { "x-forwarded-host": `pages-${slug}.work-fold.test` };
  const pageKey = randomBytes(32);
  const payload = { v: 1, title: "Weekly report", mediaType: "text/html", body: "<h1>Ready</h1>" };
  const serving = fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  const fetchFrame = await messages.next("viewer.fetch");
  assert.equal(fetchFrame.publicationId, publicationId);
  const envelope = viewerPageEnvelope(deviceKeys, {
    accountId: account.id,
    publicationId,
    fetchId: fetchFrame.fetchId,
    payload,
    key: pageKey,
  });
  socket.send(JSON.stringify({ type: "viewer.page", fetchId: fetchFrame.fetchId, publicationId, envelope }));

  const live = await serving;
  assert.equal(live.status, 200);
  assert.match(live.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(live.headers.get("set-cookie"), null);
  const liveBody = await live.json();
  assert.equal(liveBody.state, "live");
  assert.equal(liveBody.envelope.header.type, "work-fold.viewer-page.v1");
  assert.deepEqual(
    decryptViewerCiphertext(pageKey, publicationId, liveBody.envelope.header.contentDigest,
      liveBody.envelope.header.servedAt, liveBody.envelope.iv, liveBody.envelope.ciphertext),
    payload,
    "a viewer holding only the link key can decrypt exactly what the desktop served",
  );

  const charged = await waitFor(async () => {
    const slot = await service.database.publicationForViewer(account.id, publicationId);
    return slot && slot.servedBytes > 0 ? slot : null;
  });
  assert.equal(charged.servedBytes, liveBody.envelope.ciphertext.length, "served bytes are charged to the slot's day window");
  const snapshot = await waitFor(() => service.database.publicationSnapshot(account.id, publicationId));
  assert.equal(snapshot.contentDigest, liveBody.envelope.header.contentDigest, "the live serve refreshed the opted-in snapshot in the same exchange");

  socket.close();
  const asOfBody = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
    const body = await response.json();
    return body.state === "as-of" ? body : null;
  });
  assert.equal(asOfBody.page.publicationId, publicationId);
  assert.deepEqual(
    decryptViewerCiphertext(pageKey, publicationId, asOfBody.page.contentDigest,
      asOfBody.page.capturedAt, asOfBody.page.iv, asOfBody.page.ciphertext),
    payload,
    "the offline snapshot serves the same ciphertext under an as-of state, never as live",
  );

  const narrowed = await jsonRequest(`${baseUrl}/api/device/publications/${publicationId}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-viewer-live-2", kind: "page", snapshotEnabled: true, byteBudgetPerDay: 1 },
  });
  assert.equal(narrowed.response.status, 200);
  const resting = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  assert.equal(resting.status, 200);
  assert.deepEqual(await resting.json(), { state: "resting" }, "an exhausted byte budget is a typed resting state");

  // The publisher's side of resting: with a desktop connected, the bridge
  // sends one content-free viewer.resting notice per publication per minute,
  // so the glance can name what the viewer's vague page cannot.
  const noticeSocket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/device/connect`, { headers: authorization });
  context.after(() => noticeSocket.close());
  const noticeMessages = messageQueue(noticeSocket);
  await noticeMessages.next("device.ready");
  const restingAgain = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  assert.deepEqual(await restingAgain.json(), { state: "resting" });
  const notice = await noticeMessages.next("viewer.resting");
  assert.equal(notice.publicationId, publicationId);
  assert.equal(notice.reason, "byte-budget");
  await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  noticeSocket.send(JSON.stringify({ type: "device.heartbeat" }));
  await noticeMessages.next("device.heartbeat");
  assert.equal(noticeMessages.takeNow("viewer.resting"), null, "the notice is rate-limited to one per publication per minute");

  const removed = await jsonRequest(`${baseUrl}/api/device/publications/${publicationId}`, {
    method: "DELETE",
    headers: authorization,
  });
  assert.equal(removed.body.removed, true);
  const gone = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { state: "nothing-here" }, "a revoked slot is indistinguishable from one that never existed");
});

test("the viewer plane answers honestly when the desktop is asleep, refuses, stalls, or exceeds its serve rate", async (context) => {
  const service = await testService(context, { trustProxy: true, viewerFetchTimeoutMs: 250 });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const slug = "napper-test";
  const deviceKeys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug,
      password: "a sleepy desktop password",
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  const account = enrolled.body.account;
  const authorization = { authorization: `Bearer ${enrolled.body.deviceToken}` };
  const publicationId = "publication-viewer-asleep";
  await jsonRequest(`${baseUrl}/api/device/publications/${publicationId}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-viewer-asleep-1", kind: "page" },
  });
  const viewerHost = { "x-forwarded-host": `pages-${slug}.work-fold.test` };

  const asleep = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  assert.equal(asleep.status, 200);
  assert.deepEqual(await asleep.json(), { state: "asleep" }, "no desktop connection and no snapshot is honestly asleep");

  const unknown = await fetch(`${baseUrl}/api/viewer/pages/publication-never-existed`, { headers: viewerHost });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { state: "nothing-here" });
  const ghostAccount = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, {
    headers: { "x-forwarded-host": "pages-ghost-address.work-fold.test" },
  });
  assert.equal(ghostAccount.status, 404);
  assert.deepEqual(await ghostAccount.json(), { state: "nothing-here" }, "a viewer host without an account is the same nothing-here");

  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/device/connect`, { headers: authorization });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  const refusedServing = fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  const refusalFrame = await messages.next("viewer.fetch");
  socket.send(JSON.stringify({ type: "viewer.page", fetchId: refusalFrame.fetchId, publicationId, state: "not-available" }));
  const refused = await refusedServing;
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), { state: "not-available" }, "the desktop's typed refusal reaches the viewer with no detail");

  const forgedServing = fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  const forgedFrame = await messages.next("viewer.fetch");
  const forgedKeys = deviceKeyPairs();
  const forged = viewerPageEnvelope(forgedKeys, {
    accountId: account.id,
    publicationId,
    fetchId: forgedFrame.fetchId,
    payload: { v: 1, title: "forged", mediaType: "text/html", body: "<p>no</p>" },
    key: randomBytes(32),
  });
  socket.send(JSON.stringify({ type: "viewer.page", fetchId: forgedFrame.fetchId, publicationId, envelope: forged }));
  await messages.next("protocol.error");
  const timedOut = await forgedServing;
  assert.deepEqual(await timedOut.json(), { state: "asleep" }, "an unverifiable envelope is never relayed; the stalled fetch settles honestly");

  const stalledServing = fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  await messages.next("viewer.fetch");
  const stalled = await stalledServing;
  assert.deepEqual(await stalled.json(), { state: "asleep" }, "a silent desktop settles as asleep after the fetch timeout");

  const throttled = await jsonRequest(`${baseUrl}/api/device/publications/${publicationId}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-viewer-asleep-2", kind: "page", serveRatePerMinute: 1 },
  });
  assert.equal(throttled.response.status, 200);
  const overRate = await fetch(`${baseUrl}/api/viewer/pages/${publicationId}`, { headers: viewerHost });
  assert.equal(overRate.status, 429);
  assert.deepEqual(await overRate.json(), { state: "resting" }, "the slot's serve-rate budget rests the page before any dispatch");
});

test("the viewer app plane serves the sandboxed shell, relays typed calls, separates kinds, and sleeps honestly", async (context) => {
  const service = await testService(context, { trustProxy: true, viewerFetchTimeoutMs: 250 });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const slug = "app-sharer-test";
  const deviceKeys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug,
      password: "an app serving password",
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  assert.equal(enrolled.response.status, 201);
  const account = enrolled.body.account;
  const authorization = { authorization: `Bearer ${enrolled.body.deviceToken}` };
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/device/connect`, { headers: authorization });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  const appSlot = "publication-app-live";
  const pageSlot = "publication-page-beside";
  const createdApp = await jsonRequest(`${baseUrl}/api/device/publications/${appSlot}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-app-live-1", kind: "app" },
  });
  assert.equal(createdApp.response.status, 201);
  const createdPage = await jsonRequest(`${baseUrl}/api/device/publications/${pageSlot}`, {
    method: "PUT",
    headers: authorization,
    body: { operationId: "operation-app-live-2", kind: "page" },
  });
  assert.equal(createdPage.response.status, 201);

  const viewerHost = { "x-forwarded-host": `pages-${slug}.work-fold.test` };
  // The app shell document carries its own CSP: the sandboxed opaque-origin
  // blob: iframe inherits it, so the reviewed app's inline/blob code may run
  // while the page shell keeps the strict inert policy.
  const shell = await fetch(`${baseUrl}/a/${appSlot}`, { headers: viewerHost });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-security-policy"), /script-src 'self' 'unsafe-inline' blob:/);
  assert.equal(shell.headers.get("set-cookie"), null, "the app shell never sets a cookie");
  assert.match(await shell.text(), /viewer-app\.js/);
  const pagesShell = await fetch(`${baseUrl}/p/${appSlot}`, { headers: viewerHost });
  assert.doesNotMatch(pagesShell.headers.get("content-security-policy"), /unsafe-inline/,
    "the page shell keeps its strict policy");
  const shellModule = await fetch(`${baseUrl}/viewer-app.js`, { headers: viewerHost });
  assert.equal(shellModule.status, 200);
  assert.match(await shellModule.text(), /workFoldViewerApp/);

  // Kind separation both ways, without waking the desktop: the page route on
  // an app slot and the app route on a page slot both answer nothing-here.
  const pageRouteOnApp = await fetch(`${baseUrl}/api/viewer/pages/${appSlot}`, { headers: viewerHost });
  assert.equal(pageRouteOnApp.status, 404);
  assert.deepEqual(await pageRouteOnApp.json(), { state: "nothing-here" });
  const appRouteOnPage = await fetch(`${baseUrl}/api/viewer/apps/${pageSlot}/entry`, { headers: viewerHost });
  assert.equal(appRouteOnPage.status, 404);
  assert.deepEqual(await appRouteOnPage.json(), { state: "nothing-here" });

  // A live entry fetch: the device frame carries the typed call, the desktop
  // answers with a signed work-fold.viewer-app.v1 envelope, and the link-key
  // holder decrypts the exact payload under the call-bound AAD.
  const appKey = randomBytes(32);
  const entryCall = { kind: "entry" };
  const serving = fetch(`${baseUrl}/api/viewer/apps/${appSlot}/entry`, { headers: viewerHost });
  const fetchFrame = await messages.next("viewer.app.fetch");
  assert.equal(fetchFrame.publicationId, appSlot);
  assert.deepEqual(fetchFrame.call, entryCall, "the bridge relays the typed call it composed from the route");
  const payload = { v: 1, ok: true, result: { kind: "entry", mediaType: "text/html", bytes: Buffer.from("<!doctype html><p>app</p>").toString("base64url") } };
  const envelope = viewerAppEnvelope(deviceKeys, {
    accountId: account.id,
    publicationId: appSlot,
    fetchId: fetchFrame.fetchId,
    call: entryCall,
    payload,
    key: appKey,
  });
  socket.send(JSON.stringify({ type: "viewer.app.result", fetchId: fetchFrame.fetchId, publicationId: appSlot, envelope }));
  const live = await serving;
  assert.equal(live.status, 200);
  const liveBody = await live.json();
  assert.equal(liveBody.state, "live");
  assert.equal(liveBody.envelope.header.type, "work-fold.viewer-app.v1");
  assert.deepEqual(
    decryptViewerAppCiphertext(appKey, appSlot, entryCall, liveBody.envelope),
    payload,
    "a viewer holding only the link key can decrypt exactly what the desktop served for exactly this call",
  );
  const charged = await waitFor(async () => {
    const slot = await service.database.publicationForViewer(account.id, appSlot);
    return slot && slot.servedBytes > 0 ? slot : null;
  });
  assert.equal(charged.servedBytes, liveBody.envelope.ciphertext.length, "app traffic charges the same per-slot byte budgets");

  // A data read composes the typed call from the query.
  const dataServing = fetch(`${baseUrl}/api/viewer/apps/${appSlot}/data/get?key=notes/today`, { headers: viewerHost });
  const dataFrame = await messages.next("viewer.app.fetch");
  assert.deepEqual(dataFrame.call, { kind: "data.get", key: "notes/today" });
  const denial = { v: 1, ok: false, code: "viewer-scope", message: "This key is outside the app's viewer-readable collections." };
  const denialCall = { kind: "data.get", key: "notes/today" };
  socket.send(JSON.stringify({
    type: "viewer.app.result",
    fetchId: dataFrame.fetchId,
    publicationId: appSlot,
    envelope: viewerAppEnvelope(deviceKeys, {
      accountId: account.id,
      publicationId: appSlot,
      fetchId: dataFrame.fetchId,
      call: denialCall,
      payload: denial,
      key: appKey,
    }),
  }));
  const denialBody = await (await dataServing).json();
  assert.equal(denialBody.state, "live");
  assert.deepEqual(
    decryptViewerAppCiphertext(appKey, appSlot, denialCall, denialBody.envelope),
    denial,
    "typed viewer-scope refusals ride the same encrypted lane; the bridge never sees them",
  );

  // Asleep, never as-of: apps have no snapshot lane.
  socket.close();
  const asleep = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/viewer/apps/${appSlot}/entry`, { headers: viewerHost });
    const body = await response.json();
    return body.state === "asleep" ? body : null;
  });
  assert.deepEqual(asleep, { state: "asleep" }, "an offline desktop is an honestly asleep app");
});

test("the viewer app shell module composes canonical calls, routes, and the sandboxed document", () => {
  assert.deepEqual(parseViewerAppLocation("/a/publication-1", "#" + "k".repeat(43)), {
    publicationId: "publication-1",
    key: "k".repeat(43),
  });
  assert.deepEqual(parseViewerAppLocation("/p/publication-1", "#" + "k".repeat(43)), { publicationId: null, key: "k".repeat(43) });
  assert.equal(
    viewerAppCallFingerprint({ path: "x.js", kind: "asset" }),
    "{\"kind\":\"asset\",\"path\":\"x.js\"}",
    "fingerprints sort object keys so both ends derive identical bytes",
  );
  assert.equal(
    viewerAppAad("publication-1", "{\"kind\":\"entry\"}", "sha256:abc", "2026-08-10T10:00:00.000Z"),
    JSON.stringify(["work-fold.viewer-app.v1", "publication-1", "{\"kind\":\"entry\"}", "sha256:abc", "2026-08-10T10:00:00.000Z"]),
    "the shell and the desktop bind the same additional authenticated data",
  );
  assert.equal(viewerAppCallRoute("p1", { kind: "entry" }), "/api/viewer/apps/p1/entry");
  assert.equal(viewerAppCallRoute("p1", { kind: "asset", path: "img/logo.png" }), "/api/viewer/apps/p1/asset?path=img%2Flogo.png");
  assert.equal(viewerAppCallRoute("p1", { kind: "data.keys", prefix: "notes/" }), "/api/viewer/apps/p1/data/keys?prefix=notes%2F");
  assert.equal(viewerAppCallRoute("p1", { kind: "data.get", key: "notes/a" }), "/api/viewer/apps/p1/data/get?key=notes%2Fa");
  assert.equal(viewerAppCallRoute("p1", { kind: "connections.list" }), null, "the shell offers no route outside the closed viewer vocabulary");
  const composed = composeViewerAppDocument("<!doctype html><html><body>app</body></html>");
  assert.match(composed, /^<!doctype html><script>/, "the bootstrap runs first while standards mode is preserved");
  assert.match(composed, /workFoldViewerApp/);
});

test("the viewer shell module parses links, derives slugs, and binds the documented AAD", () => {
  assert.deepEqual(parseViewerLocation("/p/publication-1", "#" + "k".repeat(43)), {
    publicationId: "publication-1",
    key: "k".repeat(43),
  });
  assert.deepEqual(parseViewerLocation("/p/../etc", "#short"), { publicationId: null, key: null });
  assert.equal(viewerSlugFromHost("pages-sharer-test.work-fold.test"), "sharer-test");
  assert.equal(viewerSlugFromHost("sharer-test.work-fold.test"), null);
  assert.equal(
    viewerPageAad("publication-1", "sha256:abc", "2026-08-10T10:00:00.000Z"),
    JSON.stringify(["work-fold.viewer-page.v1", "publication-1", "sha256:abc", "2026-08-10T10:00:00.000Z"]),
    "the shell and the desktop bind the same additional authenticated data",
  );
});

function viewerPageEnvelope(deviceKeys, { accountId, publicationId, fetchId, payload, key }) {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const contentDigest = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
  const servedAt = new Date().toISOString();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["work-fold.viewer-page.v1", publicationId, contentDigest, servedAt]), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  const header = { type: "work-fold.viewer-page.v1", accountId, deviceId: accountId, publicationId, fetchId, contentDigest, servedAt };
  const envelope = { header, iv: iv.toString("base64url"), ciphertext, signature: "" };
  envelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(envelope));
  return envelope;
}

function viewerAppEnvelope(deviceKeys, { accountId, publicationId, fetchId, call, payload, key }) {
  const fingerprint = viewerAppCallFingerprint(call);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const contentDigest = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
  const callDigest = `sha256:${createHash("sha256").update(fingerprint, "utf8").digest("hex")}`;
  const servedAt = new Date().toISOString();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(viewerAppAad(publicationId, fingerprint, contentDigest, servedAt), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  const header = { type: "work-fold.viewer-app.v1", accountId, deviceId: accountId, publicationId, fetchId, callDigest, contentDigest, servedAt };
  const envelope = { header, iv: iv.toString("base64url"), ciphertext, signature: "" };
  envelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(envelope));
  return envelope;
}

function decryptViewerAppCiphertext(key, publicationId, call, envelope) {
  const fingerprint = viewerAppCallFingerprint(call);
  const bytes = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(viewerAppAad(publicationId, fingerprint, envelope.header.contentDigest, envelope.header.servedAt), "utf8"));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

function decryptViewerCiphertext(key, publicationId, contentDigest, timestamp, iv, ciphertext) {
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify(["work-fold.viewer-page.v1", publicationId, contentDigest, timestamp]), "utf8"));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

async function pairedAccountFixture(context, baseUrl, { slug, password, browserId }) {
  const deviceKeys = deviceKeyPairs();
  const browserKeys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug,
      password,
      deviceSigningPublicJwk: deviceKeys.signing.publicJwk,
      deviceEncryptionPublicJwk: deviceKeys.encryption.publicJwk,
    },
  });
  assert.equal(enrolled.response.status, 201);
  const account = enrolled.body.account;
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/device/connect`, {
    headers: { authorization: `Bearer ${enrolled.body.deviceToken}` },
  });
  context.after(() => socket.close());
  const messages = messageQueue(socket);
  await messages.next("device.ready");

  const loggedIn = await loginRequest(baseUrl, { slug, password });
  assert.equal(loggedIn.response.status, 200);
  const cookie = cookieFrom(loggedIn.response);
  const pairing = await jsonRequest(`${baseUrl}/api/pairings?slug=${slug}`, {
    method: "POST",
    headers: { origin: baseUrl, cookie, "x-work-fold-csrf": loggedIn.body.csrfToken },
    body: {
      pairingId: randomUUID(),
      browserId,
      label: `${slug} browser`,
      signingPublicJwk: browserKeys.signing.publicJwk,
      encryptionPublicJwk: browserKeys.encryption.publicJwk,
    },
  });
  assert.equal(pairing.response.status, 202);
  const request = await messages.next("pairing.request");
  assert.equal(request.pairing.id, pairing.body.pairing.id);
  const certificate = {
    type: "work-fold.browser-grant.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: randomUUID(),
    pairingId: pairing.body.pairing.id,
    pairingCode: pairing.body.pairing.code,
    browserId,
    browserSigningPublicJwk: browserKeys.signing.publicJwk,
    browserEncryptionPublicJwk: browserKeys.encryption.publicJwk,
    generation: account.grantGeneration,
    approvedAt: new Date().toISOString(),
  };
  socket.send(JSON.stringify({
    type: "pairing.decision",
    pairingId: pairing.body.pairing.id,
    approved: true,
    certificate,
    signature: signText(deviceKeys.signing.privateKey, canonicalizeJson(certificate)),
  }));
  assert.equal((await messages.next("pairing.settled")).status, "approved");
  const session = await jsonRequest(`${baseUrl}/api/auth/session?slug=${slug}`, { headers: { cookie } });
  assert.equal(session.response.status, 200);
  assert.equal(session.body.grant.id, certificate.grantId);
  return {
    slug,
    password,
    browserId,
    account,
    deviceToken: enrolled.body.deviceToken,
    deviceKeys,
    browserKeys,
    socket,
    messages,
    cookie,
    csrfToken: session.body.csrfToken,
    pairing: pairing.body.pairing,
    certificate,
  };
}

function browserOperationEnvelope(fixture) {
  return signedEnvelope({
    type: "work-fold.remote-request.v1",
    accountId: fixture.account.id,
    deviceId: fixture.account.id,
    grantId: fixture.certificate.grantId,
    generation: fixture.account.grantGeneration,
    requestId: randomUUID(),
    operation: "spaces.list",
    createdAt: new Date().toISOString(),
  }, fixture.browserKeys.signing.privateKey);
}

async function testService(context, options = {}) {
  const { passwordVerifierFactory, ...serverOptions } = options;
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const database = new BridgeDatabase({ pool });
  const service = await startBridgeServer({
    host: "127.0.0.1",
    port: 0,
    baseDomain: "work-fold.test",
    publicEnrollment: true,
    metrics: false,
    database,
    ...serverOptions,
    ...(passwordVerifierFactory ? { passwordVerifier: passwordVerifierFactory(database) } : {}),
  });
  context.after(async () => {
    await service.close();
    await pool.end();
  });
  return { ...service, database };
}

async function enrollTestAccount(baseUrl, { slug, password }) {
  const keys = deviceKeyPairs();
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: {
      slug,
      password,
      deviceSigningPublicJwk: keys.signing.publicJwk,
      deviceEncryptionPublicJwk: keys.encryption.publicJwk,
    },
  });
  assert.equal(enrolled.response.status, 201);
  return enrolled.body;
}

function loginRequest(baseUrl, { ip, slug, password }) {
  return jsonRequest(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: baseUrl, ...(ip ? { "x-real-ip": ip } : {}) },
    body: { slug, password },
  });
}

function deviceKeyPairs() {
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encryption = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    signing: { privateKey: signing.privateKey, publicJwk: { ...signing.publicKey.export({ format: "jwk" }), use: "sig" } },
    encryption: { privateKey: encryption.privateKey, publicJwk: { ...encryption.publicKey.export({ format: "jwk" }), use: "enc" } },
  };
}

function signText(privateKey, text) {
  return sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function envelopeText(envelope) {
  return `${canonicalizeJson(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
}

function signedEnvelope(header, privateKey) {
  const envelope = {
    header,
    iv: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(48).toString("base64url"),
    signature: "",
  };
  envelope.signature = signText(privateKey, envelopeText(envelope));
  return envelope;
}

async function jsonRequest(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function cookieFrom(response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

function messageQueue(socket) {
  const queued = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.type === value.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
    else queued.push(value);
  });
  return {
    next(type) {
      const index = queued.findIndex((value) => value.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}.`)), 5_000);
        waiters.push({ type, resolve: (value) => { clearTimeout(timer); resolve(value); } });
      });
    },
    takeNow(type) {
      const index = queued.findIndex((value) => value.type === type);
      return index >= 0 ? queued.splice(index, 1)[0] : null;
    },
  };
}

function socketClosed(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sseQueue(body) {
  assert.ok(body, "SSE response body is required");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queued = [];
  const waiters = [];
  let buffer = "";
  let failure = null;

  const matches = (record, event, predicate) => record.event === event && (!predicate || predicate(record));
  const dispatch = (record) => {
    const index = waiters.findIndex((waiter) => matches(record, waiter.event, waiter.predicate));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(record);
    else queued.push(record);
  };
  const parse = (block) => {
    if (!block || block.startsWith(":")) return;
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trimStart();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const text = data.join("\n");
    dispatch({ event, data: JSON.parse(text) });
  };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed before the expected event.");
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          parse(block);
        }
      }
    } catch (error) {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  })();

  return {
    next(event, predicate) {
      const index = queued.findIndex((record) => matches(record, event, predicate));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for SSE ${event}.`)), 5_000);
        waiters.push({
          event,
          predicate,
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    },
    takeNow(event, predicate) {
      const index = queued.findIndex((record) => matches(record, event, predicate));
      return index >= 0 ? queued.splice(index, 1)[0] : null;
    },
  };
}

async function waitFor(operation) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for bridge state.");
}
