import { createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

import {
  BridgeDatabase,
  BridgeDatabaseError,
  canonicalizeJson,
  normalizeSlug,
  verifyP1363,
} from "./database.mjs";

const defaultHost = "0.0.0.0";
const defaultPort = 3000;
const defaultDomain = "work-fold.com";
const maximumJsonBodyBytes = 96 * 1024;
// Remote uploads stay inside the signed application-encrypted envelope. The
// browser client caps decoded files at 8 MiB total; JSON/base64 and AEAD
// overhead need a little more room on the browser-to-bridge-to-device path.
const maximumEnvelopeBytes = 12 * 1024 * 1024;
const maximumOperationBodyBytes = 18 * 1024 * 1024;
const maximumDeviceMessageBytes = 14 * 1024 * 1024;
const maximumRoutineEnvelopeBytes = 2 * 1024 * 1024;
const maximumResponseEnvelopeBytes = 3 * 1024 * 1024;
const maximumOperationEventBytes = 32 * 1024 * 1024;
const maximumOperationEventRecords = 256;
const maximumSseClients = 128;
const maximumSseClientsPerGrant = 3;
const sessionCookieName = "__Host-work_fold_session";
const localSessionCookieName = "work_fold_session";
const macReleaseApiUrl = "https://api.github.com/repos/Mat-Tom-Son/work-fold-mac-releases/releases/latest";
const macReleaseFallbackDownloadUrl = "https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/download/v0.1.4/work-fold-0.1.4-mac-arm64.dmg";
const releaseDownloadCacheMs = 15 * 60 * 1_000;
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const allowedOperations = new Set([
  "management.summary",
  "management.chats",
  "management.transcript",
  "management.send",
  "management.request",
  "management.stop",
  "spaces.list",
  "spaces.tree",
]);

export async function startBridgeServer({
  host = process.env.HOST || defaultHost,
  port = parsePort(process.env.PORT),
  baseDomain = process.env.WORKFOLD_BRIDGE_DOMAIN || defaultDomain,
  database = new BridgeDatabase(),
  publicEnrollment = process.env.WORKFOLD_ALLOW_PUBLIC_ENROLLMENT === "1",
  trustProxy = process.env.WORKFOLD_TRUST_PROXY === "1",
  releaseFetcher = fetch,
} = {}) {
  const state = createState({ database, baseDomain: normalizeDomain(baseDomain), publicEnrollment, trustProxy, releaseFetcher });
  await database.initialize();
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(state, request, response);
    } catch (error) {
      writeApiError(response, error, state, request);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maximumDeviceMessageBytes });
  state.webSocketServer = webSocketServer;
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(state, request, socket, head).catch(() => socket.destroy());
  });
  const heartbeat = setInterval(() => heartbeatDevices(state), 15_000);
  heartbeat.unref();
  const cleanup = setInterval(() => {
    pruneTransientState(state);
    void database.cleanup().catch((error) => {
      console.warn(`work-fold bridge cleanup failed: ${publicErrorMessage(error)}`);
    });
  }, 60_000);
  cleanup.unref();

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen({ host, port }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    clearInterval(heartbeat);
    await closeServer(server);
    throw new Error("Bridge service did not bind a TCP address.");
  }
  return Object.freeze({
    host,
    port: address.port,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(cleanup);
      for (const client of state.sseClients.values()) for (const response of client) response.end();
      for (const connection of state.devices.values()) connection.socket.close(1001, "Bridge shutting down");
      await closeServer(server);
      webSocketServer.close();
      await database.close();
    },
  });
}

function createState({ database, baseDomain, publicEnrollment, trustProxy, releaseFetcher }) {
  return {
    database,
    baseDomain,
    publicEnrollment,
    trustProxy,
    releaseFetcher,
    latestMacDownload: null,
    webSocketServer: null,
    devices: new Map(),
    sseClients: new Map(),
    operationEvents: new Map(),
    operationEventBytes: 0,
    rateLimits: new Map(),
    activePasswordChecks: 0,
  };
}

async function handleRequest(state, request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";

  if (url.pathname === "/health") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
    return writeJson(response, 200, { ok: true, service: "work-fold-bridge", status: "ready" }, method, state, request);
  }

  if (url.pathname === "/download/macos") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD", state, request);
    const location = await latestMacDownload(state);
    response.writeHead(302, {
      location,
      "cache-control": "no-store",
      ...securityHeaders(state, request),
    });
    return response.end();
  }

  if (url.pathname === "/api/public/context" && method === "GET") {
    const requestedSlug = requestSlug(state, request, url);
    const personalSlug = requestedSlug && requestedSlug !== "www" ? requestedSlug : null;
    const account = personalSlug ? await state.database.accountBySlug(personalSlug) : null;
    const session = account ? await browserSession(state, request, account) : null;
    return writeJson(response, 200, {
      domain: state.baseDomain,
      slug: personalSlug,
      // Do not turn this unauthenticated endpoint into an address-enumeration
      // oracle. A syntactically personal host gets the same sign-in surface
      // whether or not an account currently exists.
      addressAvailable: Boolean(personalSlug),
      authenticated: Boolean(session),
      paired: Boolean(validPairedSession(session)),
      ...(session ? { desktopOnline: state.devices.has(account.id) } : {}),
    }, method, state, request);
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    assertSameOrigin(state, request);
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const slug = requestSlug(state, request, url, body.slug);
    if (!slug) throw httpError(404, "Open your personal work-fold address to sign in.");
    enforceRateLimit(state, `login:${clientIp(state, request)}:${slug}`, 8, 15 * 60_000);
    enforceRateLimit(state, `login-account:${slug}`, 20, 15 * 60_000);
    if (state.activePasswordChecks >= 3) throw httpError(429, "Too many sign-in attempts are being checked. Wait a moment and try again.");
    state.activePasswordChecks += 1;
    let account;
    try {
      account = await state.database.authenticatePassword(slug, body.password);
    } finally {
      state.activePasswordChecks -= 1;
    }
    if (!account) throw httpError(401, "The address or password is incorrect.");
    const session = await state.database.createSession(account);
    response.setHeader("set-cookie", sessionCookie(state, request, session.token));
    return writeJson(response, 200, {
      authenticated: true,
      paired: false,
      csrfToken: session.csrfToken,
      challenge: session.challenge,
      slug: account.slug,
      desktopOnline: state.devices.has(account.id),
      deviceSigningPublicJwk: account.deviceSigningPublicJwk,
      deviceEncryptionPublicJwk: account.deviceEncryptionPublicJwk,
      grantGeneration: account.grantGeneration,
    }, method, state, request);
  }

  if (url.pathname === "/api/auth/session" && method === "GET") {
    const account = await requestedAccount(state, request, url);
    const { token, session } = await requireBrowserSession(state, request, account);
    const csrfToken = await state.database.rotateSessionCsrf(token);
    if (!csrfToken) throw httpError(401, "Sign in to continue.");
    return writeJson(response, 200, { ...sessionView(state, account, session), csrfToken }, method, state, request);
  }

  if (url.pathname === "/api/auth/bind" && method === "POST") {
    assertSameOrigin(state, request);
    const account = await requestedAccount(state, request, url);
    const { token, session } = await requireBrowserSession(state, request, account);
    await state.database.assertCsrf(session, request.headers["x-work-fold-csrf"]);
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const grant = await state.database.bindSessionToBrowser(token, { browserId: body.browserId, signature: body.signature });
    const bound = await state.database.session(token);
    return writeJson(response, 200, {
      ...sessionView(state, account, bound),
      grant: publicGrant(grant),
    }, method, state, request);
  }

  if (url.pathname === "/api/auth/session" && method === "DELETE") {
    assertSameOrigin(state, request);
    const account = await requestedAccount(state, request, url);
    const { token, session } = await requireBrowserSession(state, request, account);
    await state.database.assertCsrf(session, request.headers["x-work-fold-csrf"]);
    await state.database.deleteSession(token);
    response.setHeader("set-cookie", clearSessionCookie(state, request));
    return writeJson(response, 200, { signedOut: true }, method, state, request);
  }

  if (url.pathname === "/api/pairings" && method === "POST") {
    assertSameOrigin(state, request);
    const account = await requestedAccount(state, request, url);
    const { token, session } = await requireBrowserSession(state, request, account);
    await state.database.assertCsrf(session, request.headers["x-work-fold-csrf"]);
    enforceRateLimit(state, `pairing:${session.accountId}`, 12, 15 * 60_000);
    enforceRateLimit(state, `pair:${account.id}:${clientIp(state, request)}`, 10, 60 * 60_000);
    const device = state.devices.get(account.id);
    if (!device) throw httpError(409, "Your work-fold desktop must be online to approve this browser.");
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const pairing = await state.database.createPairing(token, body);
    sendDevice(device.socket, { type: "pairing.request", pairing: devicePairingView(pairing) });
    return writeJson(response, 202, { pairing: browserPairingView(pairing) }, method, state, request);
  }

  const pairingMatch = url.pathname.match(/^\/api\/pairings\/([^/]+)$/);
  if (pairingMatch && method === "GET") {
    const account = await requestedAccount(state, request, url);
    const { token } = await requireBrowserSession(state, request, account);
    const pairing = await state.database.pairingForSession(token, pairingMatch[1]);
    if (!pairing) throw httpError(404, "That browser approval is no longer available.");
    return writeJson(response, 200, { pairing: browserPairingView(pairing) }, method, state, request);
  }

  if (url.pathname === "/api/events" && method === "GET") {
    const account = await requestedAccount(state, request, url);
    const { session } = await requireBrowserSession(state, request, account);
    if (!validPairedSession(session)) throw httpError(403, "Approve this browser from the work-fold desktop app.");
    return openEventStream(state, request, response, session.browserGrantId, account.id);
  }

  if (url.pathname === "/api/operations" && method === "POST") {
    assertSameOrigin(state, request);
    const account = await requestedAccount(state, request, url);
    const { session } = await requireBrowserSession(state, request, account);
    await state.database.assertCsrf(session, request.headers["x-work-fold-csrf"]);
    if (!validPairedSession(session)) throw httpError(403, "Approve this browser from the work-fold desktop app.");
    enforceRateLimit(state, `operation:${session.id}`, 30, 60_000);
    const device = state.devices.get(account.id);
    if (!device) throw httpError(409, "Your work-fold desktop is offline.");
    const body = await readJsonBody(request, maximumOperationBodyBytes);
    if (Object.keys(body).some((key) => key !== "envelope" && key !== "recover")
      || (body.recover !== undefined && typeof body.recover !== "boolean")) {
      throw httpError(400, "Remote operation request is invalid.");
    }
    const envelope = assertBrowserEnvelope(account, session, body.envelope);
    const recover = body.recover === true;
    const operation = await state.database.acceptOperation(session, envelope.header, { recover });
    if (operation.state === "accepted") {
      const claimed = await state.database.claimOperationDelivery(account.id, operation.id);
      if (!claimed) {
        const current = await state.database.operationForSession(session, operation.id);
        return writeJson(response, 200, { operation: current ?? operation }, method, state, request);
      }
      if (!sendDevice(device.socket, { type: "operation.request", operation: claimed, envelope })) {
        await state.database.setOperationState(account.id, operation.id, "lost");
        throw httpError(409, "Your work-fold desktop disconnected before it accepted the request.");
      }
      return writeJson(response, 202, { operation: claimed }, method, state, request);
    }
    return writeJson(response, 200, { operation }, method, state, request);
  }

  const operationMatch = url.pathname.match(/^\/api\/operations\/([^/]+)$/);
  if (operationMatch && method === "GET") {
    const account = await requestedAccount(state, request, url);
    const { session } = await requireBrowserSession(state, request, account);
    const operation = await state.database.operationForSession(session, operationMatch[1]);
    if (!operation) throw httpError(404, "That remote request is no longer available.");
    return writeJson(response, 200, {
      operation,
      desktopOnline: state.devices.has(account.id),
      events: state.operationEvents.get(operation.id)?.events ?? [],
    }, method, state, request);
  }

  if (url.pathname === "/api/device/enroll" && method === "POST") {
    requirePublicEnrollment(state);
    enforceRateLimit(state, "enroll:global", 250, 60 * 60_000);
    enforceRateLimit(state, `enroll:${clientIp(state, request)}`, 5, 60 * 60_000);
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const result = await state.database.enroll(body);
    return writeJson(response, 201, {
      account: publicAccount(result.account),
      deviceToken: result.deviceToken,
      url: `https://${result.account.slug}.${state.baseDomain}`,
    }, method, state, request);
  }

  if (url.pathname === "/api/device/account" && method === "GET") {
    const account = await requireDevice(state, request);
    return writeJson(response, 200, deviceAccountView(state, account), method, state, request);
  }

  if (url.pathname === "/api/device/account" && method === "PUT") {
    const account = await requireDevice(state, request);
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const updated = await state.database.updateAccount(account.id, body);
    return writeJson(response, 200, deviceAccountView(state, updated), method, state, request);
  }

  if (url.pathname === "/api/device/account" && method === "DELETE") {
    const account = await requireDevice(state, request);
    state.devices.get(account.id)?.socket.close(4001, "Remote access removed");
    const removed = await state.database.removeAccount(account.id);
    return writeJson(response, 200, { removed }, method, state, request);
  }

  if (url.pathname === "/api/device/grants" && method === "GET") {
    const account = await requireDevice(state, request);
    const grants = await state.database.listGrants(account.id);
    return writeJson(response, 200, { grants: grants.map(publicGrant) }, method, state, request);
  }

  if (url.pathname === "/api/device/grants/revoke-all" && method === "POST") {
    const account = await requireDevice(state, request);
    const grants = await state.database.listGrants(account.id);
    const revoked = await state.database.revokeAllGrants(account.id);
    for (const grant of grants) closeSseClients(state, grant.id);
    for (const [operationId, record] of state.operationEvents) {
      if (record.events.some((event) => event.envelope?.header?.accountId === account.id)) {
        state.operationEventBytes -= record.bytes;
        state.operationEvents.delete(operationId);
      }
    }
    return writeJson(response, 200, { revoked }, method, state, request);
  }

  const grantMatch = url.pathname.match(/^\/api\/device\/grants\/([^/]+)$/);
  if (grantMatch && method === "DELETE") {
    const account = await requireDevice(state, request);
    const revoked = await state.database.revokeGrant(account.id, grantMatch[1]);
    closeSseClients(state, grantMatch[1]);
    return writeJson(response, 200, { revoked }, method, state, request);
  }

  if (url.pathname.startsWith("/api/")) throw httpError(404, "Not found.");
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD", state, request);
  return servePublicFile(state, request, url.pathname, response, method);
}

async function handleUpgrade(state, request, socket, head) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/api/device/connect") return rejectUpgrade(socket, 404, "Not found");
  try {
    enforceRateLimit(state, `device-connect:${clientIp(state, request)}`, 30, 60_000);
  } catch {
    return rejectUpgrade(socket, 429, "Too Many Requests");
  }
  const account = await state.database.authenticateDevice(deviceToken(request));
  if (!account) return rejectUpgrade(socket, 401, "Unauthorized");
  state.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    const existing = state.devices.get(account.id);
    if (existing) existing.socket.close(4000, "A newer desktop connection replaced this one");
    const connection = {
      socket: webSocket,
      account,
      alive: true,
      connectedAt: new Date().toISOString(),
      messageQueue: Promise.resolve(),
    };
    state.devices.set(account.id, connection);
    void broadcastAccountPresence(state, account.id, true).catch(() => undefined);
    webSocket.on("pong", () => { connection.alive = true; });
    webSocket.on("message", (data) => {
      connection.messageQueue = connection.messageQueue.catch(() => undefined).then(() => handleDeviceMessage(state, connection, data)).catch((error) => {
        sendDevice(webSocket, { type: "protocol.error", error: publicErrorMessage(error) });
      });
    });
    webSocket.on("close", () => {
      if (state.devices.get(account.id)?.socket === webSocket) {
        state.devices.delete(account.id);
        void state.database.markActiveOperationsLost(account.id).catch(() => undefined);
        void broadcastAccountPresence(state, account.id, false).catch(() => undefined);
      }
    });
    webSocket.on("error", () => undefined);
    void state.database.pendingPairings(account.id).then((pairings) => {
      sendDevice(webSocket, {
        type: "device.ready",
        account: publicAccount(account),
        pendingPairings: pairings.map(devicePairingView),
      });
    }).catch(() => webSocket.close(1011, "Could not initialize device connection"));
  });
}

async function handleDeviceMessage(state, connection, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { throw new Error("Device messages must be JSON."); }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    throw new Error("Device message is invalid.");
  }
  if (message.type === "device.heartbeat") {
    connection.alive = true;
    return sendDevice(connection.socket, { type: "device.heartbeat", at: new Date().toISOString() });
  }
  if (message.type === "pairing.decision") {
    const currentAccount = await state.database.accountById(connection.account.id);
    if (!currentAccount) throw new Error("Remote access is no longer registered.");
    connection.account = currentAccount;
    const decision = await state.database.decidePairing(currentAccount, message);
    sendDevice(connection.socket, { type: "pairing.settled", pairingId: message.pairingId, ...decision });
    return;
  }
  if (message.type === "operation.event" || message.type === "operation.complete") {
    const envelope = assertDeviceEnvelope(connection.account, message.envelope);
    if (envelope.header.eventKind !== message.type) throw new Error("Signed response kind does not match its message.");
    const operation = await state.database.operationForDevice(connection.account.id, envelope.header.operationId);
    if (!operation || operation.browserGrantId !== envelope.header.grantId
      || operation.requestId !== envelope.header.requestId || operation.generation !== envelope.header.generation) {
      throw new Error("Response envelope does not match an accepted operation.");
    }
    const events = state.operationEvents.get(operation.id)?.events ?? [];
    const previousSequence = events.at(-1)?.envelope?.header?.sequence ?? 0;
    if (!Number.isInteger(envelope.header.sequence) || envelope.header.sequence <= previousSequence) {
      throw new Error("Response event sequence must increase.");
    }
    let transitioned;
    if (message.type === "operation.complete") {
      transitioned = await state.database.setOperationState(connection.account.id, operation.id, envelope.header.ok ? "done" : "failed");
    } else {
      transitioned = await state.database.setOperationState(connection.account.id, operation.id, "running");
    }
    if (!transitioned) return;
    const event = { envelope, at: new Date().toISOString() };
    rememberOperationEvent(state, operation.id, event);
    broadcastGrant(state, operation.browserGrantId, {
      type: message.type,
      operationId: operation.id,
      envelope,
    });
    return;
  }
  throw new Error("Unsupported device message type.");
}

function assertBrowserEnvelope(account, session, value) {
  const envelope = assertEnvelopeShape(value);
  const header = envelope.header;
  const expected = {
    type: "work-fold.remote-request.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: session.browserGrantId,
    generation: session.grantGeneration,
    requestId: header.requestId,
    operation: header.operation,
    createdAt: header.createdAt,
  };
  if (!allowedOperations.has(header.operation) || canonicalizeJson(header) !== canonicalizeJson(expected)) {
    throw httpError(400, "Remote request envelope is invalid.");
  }
  if (header.operation !== "management.send"
    && envelope.ciphertext.length > maximumRoutineEnvelopeBytes * 1.4) {
    throw httpError(413, "Remote request envelope is too large for this operation.");
  }
  assertFreshTimestamp(header.createdAt);
  if (!verifyP1363(session.browserSigningPublicJwk, envelopeSignedText(envelope), envelope.signature)) {
    throw httpError(403, "Remote request signature is invalid.");
  }
  return envelope;
}

function assertDeviceEnvelope(account, value) {
  const envelope = assertEnvelopeShape(value, maximumResponseEnvelopeBytes);
  const header = envelope.header;
  if (header.type !== "work-fold.remote-response.v1" || header.accountId !== account.id || header.deviceId !== account.id
    || typeof header.grantId !== "string" || typeof header.operationId !== "string" || typeof header.requestId !== "string"
    || !Number.isInteger(header.generation) || !Number.isInteger(header.sequence) || typeof header.ok !== "boolean"
    || !new Set(["operation.event", "operation.complete"]).has(header.eventKind)) {
    throw new Error("Remote response envelope is invalid.");
  }
  assertFreshTimestamp(header.createdAt);
  if (!verifyP1363(account.deviceSigningPublicJwk, envelopeSignedText(envelope), envelope.signature)) {
    throw new Error("Remote response signature is invalid.");
  }
  return envelope;
}

function assertEnvelopeShape(value, maximumBytes = maximumEnvelopeBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.header || typeof value.header !== "object"
    || typeof value.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value.iv)
    || typeof value.ciphertext !== "string" || value.ciphertext.length > maximumBytes * 1.4
    || typeof value.signature !== "string" || value.signature.length > 256) {
    throw httpError(400, "Remote envelope is invalid.");
  }
  return { header: value.header, iv: value.iv, ciphertext: value.ciphertext, signature: value.signature };
}

function envelopeSignedText(envelope) {
  return `${canonicalizeJson(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
}

function assertFreshTimestamp(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) throw httpError(400, "Remote envelope timestamp is stale.");
}

function openEventStream(state, request, response, grantId, accountId) {
  const clients = state.sseClients.get(grantId) ?? new Set();
  const totalClients = [...state.sseClients.values()].reduce((total, set) => total + set.size, 0);
  if (clients.size >= maximumSseClientsPerGrant || totalClients >= maximumSseClients) {
    throw httpError(429, "Too many browser event streams are open. Close another tab and try again.");
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...securityHeaders(state, request),
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ desktopOnline: state.devices.has(accountId) })}\n\n`);
  clients.add(response);
  state.sseClients.set(grantId, clients);
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    clients.delete(response);
    if (!clients.size) state.sseClients.delete(grantId);
  };
  request.on("close", close);
}

function broadcastGrant(state, grantId, event) {
  const data = `event: remote\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of state.sseClients.get(grantId) ?? []) if (!response.write(data)) response.end();
}

async function broadcastAccountPresence(state, accountId, desktopOnline) {
  const grants = await state.database.listGrants(accountId);
  for (const grant of grants) {
    if (grant.status === "approved") broadcastGrant(state, grant.id, { type: "presence", desktopOnline });
  }
}

function closeSseClients(state, grantId) {
  const clients = state.sseClients.get(grantId) ?? [];
  state.sseClients.delete(grantId);
  for (const response of clients) response.end();
}

function heartbeatDevices(state) {
  for (const connection of state.devices.values()) {
    if (!connection.alive) {
      connection.socket.terminate();
      continue;
    }
    connection.alive = false;
    connection.socket.ping();
  }
}

async function requestedAccount(state, request, url) {
  const slug = requestSlug(state, request, url);
  return slug ? state.database.accountBySlug(slug) : null;
}

async function requireBrowserSession(state, request, account) {
  const token = cookies(request)[cookieName(state, request)] ?? "";
  const session = account ? await state.database.session(token) : null;
  if (!account || !session || session.accountId !== account.id) throw httpError(401, "Sign in to continue.");
  return { token, session };
}

async function browserSession(state, request, account) {
  const token = cookies(request)[cookieName(state, request)] ?? "";
  const session = await state.database.session(token);
  return session?.accountId === account.id ? session : null;
}

function validPairedSession(session) {
  return Boolean(session?.browserGrantId && session.grantStatus === "approved"
    && session.browserGrantGeneration === session.grantGeneration);
}

async function requireDevice(state, request) {
  const account = await state.database.authenticateDevice(deviceToken(request));
  if (!account) throw httpError(401, "This desktop is not authorized for remote access.");
  return account;
}

function deviceToken(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function requirePublicEnrollment(state) {
  if (!state.publicEnrollment) throw httpError(503, "New remote-access enrollment is currently closed.");
}

function requestSlug(state, request, url, bodySlug) {
  const host = requestHostname(state, request);
  const suffix = `.${state.baseDomain}`;
  if (host.endsWith(suffix)) {
    const candidate = host.slice(0, -suffix.length);
    if (candidate && !candidate.includes(".")) return normalizeSlug(candidate);
  }
  if (isLocalHost(host)) return normalizeSlug(bodySlug ?? url.searchParams.get("slug"));
  return null;
}

function requestHostname(state, request) {
  const forwarded = state.trustProxy ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
  const raw = forwarded || String(request.headers.host || "");
  try { return new URL(`http://${raw}`).hostname.toLowerCase(); } catch { return ""; }
}

function clientIp(state, request) {
  if (state.trustProxy) {
    const forwarded = String(request.headers["x-real-ip"] || "").trim();
    if (isIP(forwarded)) return forwarded;
  }
  return String(request.socket.remoteAddress || "unknown").slice(0, 128);
}

function assertSameOrigin(state, request) {
  const origin = request.headers.origin;
  if (!origin) throw httpError(403, "A browser origin is required.");
  let parsed;
  try { parsed = new URL(origin); } catch { throw httpError(403, "Request origin is not allowed."); }
  if (parsed.hostname.toLowerCase() !== requestHostname(state, request) || (!isLocalHost(parsed.hostname) && parsed.protocol !== "https:")) {
    throw httpError(403, "Request origin is not allowed.");
  }
}

function enforceRateLimit(state, key, maximum, windowMs) {
  const now = Date.now();
  const current = state.rateLimits.get(key);
  const record = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  record.count += 1;
  state.rateLimits.set(key, record);
  if (record.count > maximum) throw httpError(429, "Too many requests. Wait a little while and try again.");
  if (state.rateLimits.size > 10_000) {
    for (const [candidate, item] of state.rateLimits) if (item.resetAt <= now) state.rateLimits.delete(candidate);
    while (state.rateLimits.size > 10_000) state.rateLimits.delete(state.rateLimits.keys().next().value);
  }
}

function rememberOperationEvent(state, operationId, event) {
  const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  const current = state.operationEvents.get(operationId);
  if (current) {
    state.operationEventBytes -= current.bytes;
    state.operationEvents.delete(operationId);
  }
  const events = [...(current?.events ?? []), event].slice(-4);
  const bytes = events.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  state.operationEvents.set(operationId, { events, bytes, expiresAt: Date.now() + 2 * 60_000 });
  state.operationEventBytes += bytes;
  while (state.operationEvents.size > maximumOperationEventRecords || state.operationEventBytes > maximumOperationEventBytes) {
    const oldestId = state.operationEvents.keys().next().value;
    if (!oldestId) break;
    const oldest = state.operationEvents.get(oldestId);
    state.operationEventBytes -= oldest?.bytes ?? 0;
    state.operationEvents.delete(oldestId);
  }
}

function pruneTransientState(state) {
  const now = Date.now();
  for (const [key, record] of state.rateLimits) if (record.resetAt <= now) state.rateLimits.delete(key);
  for (const [operationId, record] of state.operationEvents) {
    if (record.expiresAt > now) continue;
    state.operationEventBytes -= record.bytes;
    state.operationEvents.delete(operationId);
  }
}

function sessionView(state, account, session) {
  return {
    authenticated: true,
    paired: validPairedSession(session),
    slug: account.slug,
    desktopOnline: state.devices.has(account.id),
    challenge: session.loginChallenge,
    deviceSigningPublicJwk: account.deviceSigningPublicJwk,
    deviceEncryptionPublicJwk: account.deviceEncryptionPublicJwk,
    grantGeneration: account.grantGeneration,
    ...(validPairedSession(session) ? {
      grant: {
        id: session.browserGrantId,
        browserId: session.browserId,
        generation: session.browserGrantGeneration,
      },
    } : {}),
  };
}

function deviceAccountView(state, account) {
  return {
    account: publicAccount(account),
    url: `https://${account.slug}.${state.baseDomain}`,
    desktopConnected: state.devices.has(account.id),
  };
}

function publicAccount(account) {
  return { id: account.id, slug: account.slug, grantGeneration: account.grantGeneration, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

function publicGrant(grant) {
  return { id: grant.id, browserId: grant.browserId, label: grant.label, generation: grant.generation, status: grant.status, approvedAt: grant.approvedAt, revokedAt: grant.revokedAt };
}

function devicePairingView(pairing) {
  return {
    id: pairing.id,
    browserId: pairing.browserId,
    label: pairing.label,
    signingPublicJwk: pairing.signingPublicJwk,
    encryptionPublicJwk: pairing.encryptionPublicJwk,
    code: pairing.code,
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
  };
}

function browserPairingView(pairing) {
  return {
    id: pairing.id,
    browserId: pairing.browserId,
    label: pairing.label,
    code: pairing.code,
    status: pairing.status,
    approvalCertificate: pairing.approvalCertificate,
    approvalSignature: pairing.approvalSignature,
    expiresAt: pairing.expiresAt,
  };
}

function sendDevice(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function readJsonBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw httpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw httpError(400, "Request body must be a JSON object.");
  }
}

async function servePublicFile(state, request, pathname, response, method) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = resolve(publicDir, requested);
  if (candidate !== publicDir && !candidate.startsWith(`${publicDir}${sep}`)) throw httpError(404, "Not found.");
  try {
    const body = await readFile(candidate);
    response.writeHead(200, {
      "content-type": contentType(candidate),
      "content-length": body.length,
      // These private-alpha assets are not fingerprinted. Revalidate them so a
      // bridge rollout cannot leave an approved browser on stale client code.
      "cache-control": candidate.endsWith("index.html") ? "no-store" : "no-cache",
      ...securityHeaders(state, request),
    });
    response.end(method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error?.code === "ENOENT" && !extname(requested)) return servePublicFile(state, request, "/", response, method);
    if (error?.code === "ENOENT") throw httpError(404, "Not found.");
    throw error;
  }
}

async function latestMacDownload(state) {
  if (state.latestMacDownload?.expiresAt > Date.now()) return state.latestMacDownload.url;
  try {
    const response = await state.releaseFetcher(macReleaseApiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "work-fold-bridge",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
    const release = await response.json();
    const asset = Array.isArray(release?.assets)
      ? release.assets.find((candidate) => /^work-fold-[0-9][0-9A-Za-z.-]*-mac-arm64\.dmg$/.test(candidate?.name))
      : null;
    const url = new URL(asset?.browser_download_url || "");
    if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("The latest macOS installer is unavailable.");
    state.latestMacDownload = { url: url.href, expiresAt: Date.now() + releaseDownloadCacheMs };
    return url.href;
  } catch (error) {
    console.warn(`work-fold could not resolve the latest macOS download: ${publicErrorMessage(error)}`);
    return macReleaseFallbackDownloadUrl;
  }
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function methodNotAllowed(response, allow, state, request) {
  response.setHeader("allow", allow);
  return writeJson(response, 405, { ok: false, error: "Method not allowed." }, "GET", state, request);
}

function writeApiError(response, error, state, request) {
  if (response.headersSent) return response.end();
  let status = error?.status ?? 500;
  let message = publicErrorMessage(error);
  let code;
  if (error instanceof BridgeDatabaseError) {
    code = error.code;
    status = new Map([
      ["unauthorized", 401], ["csrf", 403], ["pairing_required", 403], ["invalid_signature", 403],
      ["not_found", 404], ["slug_taken", 409], ["invalid_slug", 400], ["invalid_password", 400],
      ["invalid_input", 400], ["invalid_key", 400], ["invalid_certificate", 400],
      ["credentials_changed", 409], ["request_conflict", 409], ["pairing_limit", 429], ["operation_limit", 429],
    ]).get(error.code) ?? 400;
  } else if (!error?.status) {
    console.error(`work-fold bridge request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    message = "The bridge could not complete this request.";
  }
  const body = JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...securityHeaders(state, request),
  });
  response.end(body);
}

function publicErrorMessage(error) {
  return error instanceof Error ? error.message : "The bridge could not complete this request.";
}

function writeJson(response, status, value, method = "GET", state, request) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...securityHeaders(state, request),
  });
  response.end(method === "HEAD" ? undefined : body);
}

function securityHeaders(state, request) {
  return {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...(request && !isLocalHost(requestHostname(state, request)) ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

function sessionCookie(state, request, token) {
  return `${cookieName(state, request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 60 * 60}${isLocalHost(requestHostname(state, request)) ? "" : "; Secure"}`;
}

function clearSessionCookie(state, request) {
  return `${cookieName(state, request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isLocalHost(requestHostname(state, request)) ? "" : "; Secure"}`;
}

function cookieName(state, request) {
  return isLocalHost(requestHostname(state, request)) ? localSessionCookieName : sessionCookieName;
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([name]) => name));
}

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("WORKFOLD_BRIDGE_DOMAIN is invalid.");
  return domain;
}

function parsePort(value) {
  if (value === undefined || value === "") return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("PORT must be an integer from 0 through 65535.");
  return port;
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function run() {
  const service = await startBridgeServer();
  console.log(`work-fold bridge listening on ${service.host}:${service.port}`);
  const stop = async () => {
    await service.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not start the work-fold bridge.");
    process.exitCode = 1;
  });
}
