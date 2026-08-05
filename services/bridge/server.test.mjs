import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";
import WebSocket from "ws";

import { BridgeDatabase, canonicalizeJson } from "./database.mjs";
import { shouldSubmitComposerKey } from "./public/composer.js";
import { renderMarkdown } from "./public/markdown.js";
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

  const applicationScript = await fetch(`${baseUrl}/app.js`);
  const applicationSource = await applicationScript.text();
  assert.match(applicationSource, /class="landing-actions"/);
  assert.match(applicationSource, /href="\/download\/macos"/);
  assert.match(applicationSource, /href="https:\/\/github\.com\/Mat-Tom-Son\/work-fold"/);
  assert.match(applicationSource, /id="new-chat"/);
  assert.match(applicationSource, /id="chats"/);
  assert.match(applicationSource, /id="workspace-pane"/);
  assert.match(applicationSource, /id="file-input"/);
  assert.match(applicationSource, /newConversation: true/);
  assert.match(applicationSource, /management\.chats/);
  assert.match(applicationSource, /management\.stop/);
  assert.doesNotMatch(applicationSource, /spaces\.(?:chats|transcript|send|stop)/);
  assert.doesNotMatch(applicationSource, /Chat with Space|id="scope-name"|id="management-home"/);
  assert.match(applicationSource, /id="account-settings"[\s\S]*?id="account-menu"[\s\S]*?>Sign out</);
  assert.match(applicationSource, /id="workspace-pane"[\s\S]*?class="files-title">Files<[\s\S]*?id="toggle-files"/);
  assert.match(applicationSource, /Working in \$\{spaceName\}/);
  assert.match(applicationSource, /Couldn’t finish in \$\{spaceName\}/);
  assert.doesNotMatch(applicationSource, /previous chat is still saved on your desktop/);
  for (const removedCopy of [
    "Management conversation",
    "Above all Spaces",
    "Needs you",
    "Desktop connected",
    "Encrypted to your desktop",
    "Private alpha",
    "Hosted client trusted",
    " · Web",
  ]) {
    assert.doesNotMatch(applicationSource, new RegExp(removedCopy));
  }

  const appIcon = await fetch(`${baseUrl}/work-fold-icon.svg`);
  assert.equal(appIcon.status, 200);
  assert.match(appIcon.headers.get("content-type"), /^image\/svg\+xml/);
  assert.match(await appIcon.text(), /id="work-fold-mark"/);

  const rejected = await fetch(baseUrl, { method: "POST" });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");
});

test("composer sends with Enter and preserves Shift+Enter for a new line", () => {
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitComposerKey({ key: "a", shiftKey: false, isComposing: false }), false);
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
  const second = queue.run("198.51.100.10", async () => { order.push("second"); });
  await assert.rejects(
    queue.run("198.51.100.10", async () => { order.push("overflow"); }),
    (error) => error?.status === 429,
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
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
