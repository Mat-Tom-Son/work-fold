import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";
import WebSocket from "ws";

import { BridgeDatabase, canonicalizeJson } from "./database.mjs";
import { shouldSubmitComposerKey } from "./public/composer.js";
import { renderMarkdown } from "./public/markdown.js";
import { startBridgeServer } from "./server.mjs";

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
  assert.match(applicationSource, /spaces\.chats/);
  assert.match(applicationSource, /spaces\.send/);
  assert.match(applicationSource, /spaces\.stop/);
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

test("the landing download remains direct when GitHub's latest-release API is unavailable", async (context) => {
  const service = await testService(context, {
    releaseFetcher: async () => new Response("rate limited", { status: 429 }),
  });
  const response = await fetch(`http://127.0.0.1:${service.port}/download/macos`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/download/v0.1.4/work-fold-0.1.4-mac-arm64.dmg",
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
    ciphertext: randomBytes(32).toString("base64url"),
    signature: "",
  };
  progressEnvelope.signature = signText(deviceKeys.signing.privateKey, envelopeText(progressEnvelope));
  socket.send(JSON.stringify({ type: "operation.event", envelope: progressEnvelope }));
  await waitFor(async () => {
    const result = await jsonRequest(`${baseUrl}/api/operations/${delivered.operation.id}?slug=alice-test`, { headers: { cookie } });
    return result.body.operation?.state === "running" ? result : null;
  });

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
    sequence: 2,
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
  assert.equal(completed.body.events.length, 2);
  assert.deepEqual(completed.body.events[0].envelope, progressEnvelope);
  assert.deepEqual(completed.body.events[1].envelope, responseEnvelope);

  const uploadHeader = {
    ...requestHeader,
    requestId: randomUUID(),
    operation: "spaces.send",
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
});

async function testService(context, options = {}) {
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
    ...options,
  });
  context.after(async () => {
    await service.close();
    await pool.end();
  });
  return service;
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

async function waitFor(operation) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for bridge state.");
}
