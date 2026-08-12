import { createPublicKey, randomUUID, verify } from "node:crypto";
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
  isReservedViewerSlug,
  isValidSlug,
  normalizeSlug,
  publicationWindowServedBytes,
  verifyP1363,
} from "./database.mjs";
import { createBridgeMetrics } from "./metrics.mjs";

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
// A maximum-sized response envelope expands to a little over 4 MiB once its
// base64url ciphertext is wrapped in JSON/SSE. Keep one such event plus normal
// follow-up traffic bounded per slow client without treating write(false) as a
// disconnect signal.
const maximumSseClientQueuedBytes = 8 * 1024 * 1024;
const maximumDeviceProtocolErrors = 2;
const maximumRateLimitBuckets = 10_000;
const loginAttemptsPerIp = 24;
const loginAttemptWindowMs = 15 * 60_000;
const maximumLoginIpBuckets = 4_096;
const maximumConcurrentPasswordChecks = 3;
const maximumConcurrentPasswordChecksPerIp = 1;
const maximumQueuedPasswordChecks = 24;
const maximumQueuedPasswordChecksPerIp = 2;
const sessionCookieName = "__Host-work_fold_session";
const localSessionCookieName = "work_fold_session";
const macReleaseApiUrl = "https://api.github.com/repos/Mat-Tom-Son/work-fold-mac-releases/releases/latest";
const macReleaseFallbackUrl = "https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest";
const releaseDownloadCacheMs = 15 * 60 * 1_000;
// A publication snapshot stores at most ~2.8 MiB of base64url ciphertext;
// the JSON wrapper needs a little more room on the device upload path.
const maximumSnapshotBodyBytes = 4 * 1024 * 1024;
// The publishing ladder's viewer plane is unauthenticated by design, so every
// bound applies before anything reaches the desktop (docs/fold-publishing.md,
// "Abuse bounds"). Decoded-bytes × 1.4 accounting matches the envelope limits.
const viewerRequestsPerIpPerMinute = 60;
const viewerFetchDispatchPerAccountPerMinute = 120;
const maximumConcurrentViewerFetchesPerPublication = 4;
const maximumViewerPageCiphertextChars = Math.floor(2 * 1024 * 1024 * 1.4);
const maximumViewerInFlightCiphertextChars = Math.floor(64 * 1024 * 1024 * 1.4);
const defaultViewerFetchTimeoutMs = 25_000;
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const viewerPublicDir = join(publicDir, "viewer");
// The management operation allowlist. The publishing ladder's viewer plane is
// deliberately absent: viewer traffic never enters /api/operations, and
// unknown operation names — including any viewer.* spelling — stay rejected.
// The fold's decision and glance operations ride the same signed envelopes:
// the bridge relays ciphertext and persists no card or digest content, and
// staged acts never leave the desktop (docs/fold-consecrations.md,
// docs/fold-glance.md).
const allowedOperations = new Set([
  "management.summary",
  "management.chats",
  "management.transcript",
  "management.rename",
  "management.send",
  "management.request",
  "management.stop",
  "management.glance",
  "management.glanceSeen",
  "decisions.list",
  "decisions.decide",
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
  passwordVerifier = (slug, password) => database.authenticatePassword(slug, password),
  loginProtection,
  metrics,
  viewerFetchTimeoutMs = defaultViewerFetchTimeoutMs,
} = {}) {
  const state = createState({
    database,
    baseDomain: normalizeDomain(baseDomain),
    publicEnrollment,
    trustProxy,
    releaseFetcher,
    passwordVerifier,
    loginProtection,
    metrics,
    viewerFetchTimeoutMs,
  });
  await database.initialize();
  const server = createServer(async (request, response) => {
    state.metrics.recordHttpRequest();
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
  state.metrics.start();
  return Object.freeze({
    host,
    port: address.port,
    metrics: state.metrics,
    close: async () => {
      state.metrics.stop();
      clearInterval(heartbeat);
      clearInterval(cleanup);
      for (const client of state.sseClients.values()) for (const response of client) response.end();
      for (const fetchId of [...state.viewerFetches.keys()]) settleViewerFetch(state, fetchId, { state: "asleep" });
      for (const connection of state.devices.values()) connection.socket.close(1001, "Bridge shutting down");
      await closeServer(server);
      webSocketServer.close();
      await database.close();
    },
  });
}

function createState({ database, baseDomain, publicEnrollment, trustProxy, releaseFetcher, passwordVerifier, loginProtection, metrics, viewerFetchTimeoutMs }) {
  const protection = normalizedLoginProtection(loginProtection);
  const state = {
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
    loginRateLimits: new Map(),
    loginRateLimitMaximumBuckets: protection.maximumIpBuckets,
    loginAttemptsPerIp: protection.attemptsPerIp,
    loginAttemptWindowMs: protection.attemptWindowMs,
    passwordVerifier,
    passwordChecks: createPasswordCheckQueue(protection),
    viewerFetchTimeoutMs: positiveInteger(viewerFetchTimeoutMs, defaultViewerFetchTimeoutMs),
    viewerFetches: new Map(),
    viewerFetchCountsByPublication: new Map(),
    viewerInFlightChars: 0,
  };
  const metricOptions = metrics && typeof metrics === "object" ? metrics : {};
  state.metrics = createBridgeMetrics({
    ...metricOptions,
    enabled: metrics !== false && metricOptions.enabled !== false,
    gauges: () => bridgeMetricGauges(state),
  });
  return state;
}

function bridgeMetricGauges(state) {
  let sseClientsCurrent = 0;
  for (const clients of state.sseClients.values()) {
    for (const response of clients) {
      if (!response.destroyed && !response.writableEnded) sseClientsCurrent += 1;
    }
  }
  return {
    publicEnrollment: state.publicEnrollment,
    devicesCurrent: state.devices.size,
    sseClientsCurrent,
    viewerActiveFetches: state.viewerFetches.size,
    viewerInFlightCiphertextChars: state.viewerInFlightChars,
    passwordChecks: state.passwordChecks.snapshot(),
  };
}

async function handleRequest(state, request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";

  // The pages-* labels are the publishing ladder's viewer plane. They are
  // diverted before any personal-slug resolution so the management client,
  // its sign-in, its cookies, and approved-browser keys can never co-locate
  // with published viewer content on one origin.
  if (viewerPlaneHost(state, request) !== null) return handleViewerRequest(state, request, response, url, method);

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
    const ip = clientIp(state, request);
    enforceRateLimit(
      state.loginRateLimits,
      ip,
      state.loginAttemptsPerIp,
      state.loginAttemptWindowMs,
      state.loginRateLimitMaximumBuckets,
    );
    if (!isValidSlug(slug)) throw invalidCredentialsError();
    const account = await state.passwordChecks.run(ip, () => state.passwordVerifier(slug, body.password));
    // Account-wide failure state must never become a pre-verification lockout:
    // a distributed attacker who knows an address cannot prevent its owner from
    // proving the correct password. Resource admission is instead IP-scoped and
    // globally bounded by the fair password-check queue.
    if (!account) throw invalidCredentialsError();
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
    const csrfToken = await state.database.issueSessionCsrf(token);
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
    enforceRateLimit(state.rateLimits, `pairing:${session.accountId}`, 12, 15 * 60_000);
    enforceRateLimit(state.rateLimits, `pair:${account.id}:${clientIp(state, request)}`, 10, 60 * 60_000);
    if (!state.devices.has(account.id)) throw httpError(409, "Your work-fold desktop must be online to approve this browser.");
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const pairing = await state.database.createPairing(token, body);
    const device = state.devices.get(account.id);
    if (!device || !sendDevice(device.socket, { type: "pairing.request", pairing: devicePairingView(pairing) })) {
      throw httpError(409, "Your work-fold desktop disconnected before it received the approval request.");
    }
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
    enforceRateLimit(state.rateLimits, `operation:${session.id}`, 30, 60_000);
    if (!state.devices.has(account.id)) throw httpError(409, "Your work-fold desktop is offline.");
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
      const device = state.devices.get(account.id);
      if (!device || !sendDevice(device.socket, { type: "operation.request", operation: claimed, envelope })) {
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
    enforceRateLimit(state.rateLimits, "enroll:global", 250, 60 * 60_000);
    enforceRateLimit(state.rateLimits, `enroll:${clientIp(state, request)}`, 5, 60 * 60_000);
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
    const grants = await state.database.listGrants(account.id);
    state.devices.get(account.id)?.socket.close(4001, "Remote access removed");
    const removed = await state.database.removeAccount(account.id);
    for (const grant of grants) closeSseClients(state, grant.id);
    discardOperationEventsForAccount(state, account.id);
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
    discardOperationEventsForAccount(state, account.id);
    return writeJson(response, 200, { revoked }, method, state, request);
  }

  const grantMatch = url.pathname.match(/^\/api\/device\/grants\/([^/]+)$/);
  if (grantMatch && method === "DELETE") {
    const account = await requireDevice(state, request);
    const revoked = await state.database.revokeGrant(account.id, grantMatch[1]);
    if (revoked) closeSseClients(state, grantMatch[1]);
    return writeJson(response, 200, { revoked }, method, state, request);
  }

  // Publication slots: the desktop's idempotent, content-free sync surface
  // for the publishing ladder. These routes carry identifiers, budgets, and
  // flags — never titles, paths, or page bytes — and stay inert until a
  // desktop that publishes calls them.
  const publicationMatch = url.pathname.match(/^\/api\/device\/publications\/([^/]+)$/);
  if (publicationMatch && method === "PUT") {
    const account = await requireDevice(state, request);
    const body = await readJsonBody(request, maximumJsonBodyBytes);
    const allowed = new Set(["operationId", "kind", "state", "serveRatePerMinute", "byteBudgetPerDay", "snapshotEnabled", "expiresAt"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw httpError(400, "Publication sync accepts only content-free slot fields.");
    }
    const result = await state.database.upsertPublication(account, publicationMatch[1], body);
    return writeJson(response, result.created ? 201 : 200, { publication: publicationView(result) }, method, state, request);
  }
  if (publicationMatch && method === "DELETE") {
    const account = await requireDevice(state, request);
    const removed = await state.database.deletePublication(account.id, publicationMatch[1]);
    return writeJson(response, 200, { removed }, method, state, request);
  }

  const snapshotMatch = url.pathname.match(/^\/api\/device\/publications\/([^/]+)\/snapshot$/);
  if (snapshotMatch && method === "PUT") {
    const account = await requireDevice(state, request);
    const body = await readJsonBody(request, maximumSnapshotBodyBytes);
    const allowed = new Set(["ciphertext", "iv", "contentDigest", "capturedAt"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw httpError(400, "Snapshot sync accepts only bounded ciphertext fields.");
    }
    const result = await state.database.putPublicationSnapshot(account.id, snapshotMatch[1], body);
    return writeJson(response, 200, {
      snapshot: publicationSnapshotView(result.snapshot),
      stored: result.stored,
    }, method, state, request);
  }
  if (snapshotMatch && method === "DELETE") {
    const account = await requireDevice(state, request);
    const removed = await state.database.deletePublicationSnapshot(account.id, snapshotMatch[1]);
    return writeJson(response, 200, { removed }, method, state, request);
  }

  if (url.pathname.startsWith("/api/")) throw httpError(404, "Not found.");
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD", state, request);
  return servePublicFile(state, request, url.pathname, response, method);
}

async function handleUpgrade(state, request, socket, head) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (viewerPlaneHost(state, request) !== null) return rejectUpgrade(socket, 404, "Not found");
  if (url.pathname !== "/api/device/connect") return rejectUpgrade(socket, 404, "Not found");
  try {
    enforceRateLimit(state.rateLimits, `device-connect:${clientIp(state, request)}`, 30, 60_000);
  } catch {
    return rejectUpgrade(socket, 429, "Too Many Requests");
  }
  const account = await state.database.authenticateDevice(deviceToken(request));
  if (!account) return rejectUpgrade(socket, 401, "Unauthorized");
  state.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    const existing = state.devices.get(account.id);
    if (existing) {
      existing.displaced = true;
      existing.socket.close(4000, "A newer desktop connection replaced this one");
    }
    const connection = {
      socket: webSocket,
      account,
      alive: true,
      displaced: false,
      terminal: false,
      protocolErrors: 0,
      connectedAt: new Date().toISOString(),
      messageQueue: Promise.resolve(),
    };
    state.devices.set(account.id, connection);
    void broadcastAccountPresence(state, account.id, true).catch(() => undefined);
    webSocket.on("pong", () => {
      if (isCurrentDeviceConnection(state, connection)) connection.alive = true;
    });
    webSocket.on("message", (data) => {
      state.metrics.recordDeviceWebSocketFrame();
      if (!isCurrentDeviceConnection(state, connection)) return;
      connection.messageQueue = connection.messageQueue.catch(() => undefined).then(async () => {
        if (!isCurrentDeviceConnection(state, connection)) return;
        try {
          await handleDeviceMessage(state, connection, data);
        } catch (error) {
          handleDeviceProtocolFailure(state, connection, error);
        }
      });
    });
    webSocket.on("close", () => {
      if (state.devices.get(account.id)?.socket === webSocket) {
        state.devices.delete(account.id);
        void state.database.markActiveOperationsLost(account.id).catch(() => undefined);
        void broadcastAccountPresence(state, account.id, false).catch(() => undefined);
        settleViewerFetchesForAccount(state, account.id);
      }
    });
    webSocket.on("error", () => undefined);
    void state.database.pendingPairings(account.id).then((pairings) => {
      if (!isCurrentDeviceConnection(state, connection)) return;
      sendDevice(webSocket, {
        type: "device.ready",
        account: publicAccount(account),
        pendingPairings: pairings.map(devicePairingView),
      });
    }).catch(() => {
      if (isCurrentDeviceConnection(state, connection)) webSocket.close(1011, "Could not initialize device connection");
    });
  });
}

async function handleDeviceMessage(state, connection, raw) {
  if (!isCurrentDeviceConnection(state, connection)) return;
  let message;
  try { message = JSON.parse(raw.toString()); } catch { throw new Error("Device messages must be JSON."); }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    throw new Error("Device message is invalid.");
  }
  if (message.type === "protocol.error") {
    // A peer reporting that it cannot understand us is terminal for this
    // transport generation. Never answer protocol.error with protocol.error.
    connection.terminal = true;
    connection.socket.close(1002, "Device reported a protocol error");
    return;
  }
  if (message.type === "device.heartbeat") {
    connection.alive = true;
    return sendDevice(connection.socket, { type: "device.heartbeat", at: new Date().toISOString() });
  }
  if (message.type === "pairing.decision") {
    const currentAccount = await state.database.accountById(connection.account.id);
    if (!isCurrentDeviceConnection(state, connection)) return;
    if (!currentAccount) throw new Error("Remote access is no longer registered.");
    connection.account = currentAccount;
    const decision = await state.database.decidePairing(currentAccount, message);
    if (!isCurrentDeviceConnection(state, connection)) return;
    sendDevice(connection.socket, { type: "pairing.settled", pairingId: message.pairingId, ...decision });
    return;
  }
  if (message.type === "operation.event" || message.type === "operation.complete") {
    const envelope = assertDeviceEnvelope(connection.account, message.envelope);
    if (envelope.header.eventKind !== message.type) throw new Error("Signed response kind does not match its message.");
    const operation = await state.database.operationForDevice(connection.account.id, envelope.header.operationId);
    if (!isCurrentDeviceConnection(state, connection)) return;
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
    if (!isCurrentDeviceConnection(state, connection) || !transitioned) return;
    const event = { envelope, at: new Date().toISOString() };
    rememberOperationEvent(state, operation.id, event);
    broadcastGrant(state, operation.browserGrantId, {
      type: message.type,
      operationId: operation.id,
      envelope,
    });
    return;
  }
  if (message.type === "viewer.page") {
    if (!isStableViewerId(message.fetchId) || !isStableViewerId(message.publicationId)) {
      throw new Error("Viewer page frame is invalid.");
    }
    // A typed refusal is content-free and rides the authenticated device
    // socket. The desktop's effect-time recheck answers nothing-here for a
    // slot it no longer serves and not-available for a source problem the
    // publisher — not the audience — gets to see the reason for.
    if (message.state !== undefined) {
      if (message.envelope !== undefined || (message.state !== "not-available" && message.state !== "nothing-here")) {
        throw new Error("Viewer page frame is invalid.");
      }
      const waiter = state.viewerFetches.get(message.fetchId);
      if (waiter && waiter.kind === "page" && waiter.accountId === connection.account.id && waiter.publicationId === message.publicationId) {
        settleViewerFetch(state, message.fetchId, { state: message.state });
      }
      return;
    }
    const envelope = assertViewerPageEnvelope(connection.account, message.envelope);
    if (envelope.header.publicationId !== message.publicationId || envelope.header.fetchId !== message.fetchId) {
      throw new Error("Viewer page envelope does not match its frame.");
    }
    if (!isCurrentDeviceConnection(state, connection)) return;
    const waiter = state.viewerFetches.get(message.fetchId);
    if (waiter && waiter.kind === "page" && waiter.accountId === connection.account.id && waiter.publicationId === envelope.header.publicationId) {
      settleViewerFetch(state, message.fetchId, { state: "live", envelope });
    }
    // Snapshot refresh rides the same device-frame exchange as the serve — a
    // counter-tracked sync, not a separate receipted act. The database owns
    // opt-in, bounds, and newest-wins; a late frame may still refresh it.
    try {
      const stored = await state.database.putPublicationSnapshot(connection.account.id, envelope.header.publicationId, {
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        contentDigest: envelope.header.contentDigest,
        capturedAt: envelope.header.servedAt,
      });
      if (stored.stored) state.metrics.recordViewerSnapshotStoredBytes(envelope.ciphertext.length);
    } catch {
      // Snapshot-disabled, bounds, and revoked-slot refusals are expected;
      // a failed refresh leaves the previous snapshot in place.
    }
    return;
  }
  if (message.type === "viewer.app.result") {
    if (!isStableViewerId(message.fetchId) || !isStableViewerId(message.publicationId)) {
      throw new Error("Viewer app frame is invalid.");
    }
    if (message.state !== undefined) {
      if (message.envelope !== undefined || (message.state !== "not-available" && message.state !== "nothing-here")) {
        throw new Error("Viewer app frame is invalid.");
      }
      const waiter = state.viewerFetches.get(message.fetchId);
      if (waiter && waiter.kind === "app" && waiter.accountId === connection.account.id && waiter.publicationId === message.publicationId) {
        settleViewerFetch(state, message.fetchId, { state: message.state });
      }
      return;
    }
    const envelope = assertViewerAppEnvelope(connection.account, message.envelope);
    if (envelope.header.publicationId !== message.publicationId || envelope.header.fetchId !== message.fetchId) {
      throw new Error("Viewer app envelope does not match its frame.");
    }
    if (!isCurrentDeviceConnection(state, connection)) return;
    const waiter = state.viewerFetches.get(message.fetchId);
    if (waiter && waiter.kind === "app" && waiter.accountId === connection.account.id && waiter.publicationId === envelope.header.publicationId) {
      settleViewerFetch(state, message.fetchId, { state: "live", envelope });
    }
    // No snapshot lane for apps: the frame settles its one waiter and
    // nothing is retained.
    return;
  }
  // New desktop versions may add device-to-bridge notifications. A
  // well-formed frame with an unknown type is forward-compatible and inert.
}

function isCurrentDeviceConnection(state, connection) {
  return !connection.displaced
    && !connection.terminal
    && state.devices.get(connection.account.id) === connection
    && connection.socket.readyState === WebSocket.OPEN;
}

function handleDeviceProtocolFailure(state, connection, error) {
  if (!isCurrentDeviceConnection(state, connection)) return;
  connection.protocolErrors += 1;
  if (connection.protocolErrors > maximumDeviceProtocolErrors) {
    connection.terminal = true;
    connection.socket.close(1002, "Too many invalid device messages");
    return;
  }
  sendDevice(connection.socket, { type: "protocol.error", error: publicErrorMessage(error) });
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
  pruneClosedSseClients(state);
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
  clients.add(response);
  state.sseClients.set(grantId, clients);
  writeSseClient(state, grantId, response, `event: ready\ndata: ${JSON.stringify({ desktopOnline: state.devices.has(accountId) })}\n\n`);
  const heartbeat = setInterval(() => writeSseClient(state, grantId, response, ": keepalive\n\n"), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    removeSseClient(state, grantId, response);
  };
  request.once("close", close);
  response.once("close", close);
  response.once("finish", close);
  response.once("error", close);
}

function broadcastGrant(state, grantId, event) {
  const data = `event: remote\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of state.sseClients.get(grantId) ?? []) writeSseClient(state, grantId, response, data);
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

function writeSseClient(state, grantId, response, data) {
  if (response.destroyed || response.writableEnded) {
    removeSseClient(state, grantId, response);
    return false;
  }
  const bytes = Buffer.byteLength(data, "utf8");
  if (response.writableLength + bytes > maximumSseClientQueuedBytes) {
    removeSseClient(state, grantId, response);
    response.destroy();
    return false;
  }
  try {
    // false means Node has crossed its high-water mark, not that this client
    // failed. The bounded writableLength check above owns slow-client policy.
    response.write(data);
    return true;
  } catch {
    removeSseClient(state, grantId, response);
    response.destroy();
    return false;
  }
}

function removeSseClient(state, grantId, response) {
  const clients = state.sseClients.get(grantId);
  if (!clients) return;
  clients.delete(response);
  if (!clients.size) state.sseClients.delete(grantId);
}

function pruneClosedSseClients(state) {
  for (const [grantId, clients] of state.sseClients) {
    for (const response of clients) {
      if (response.destroyed || response.writableEnded) clients.delete(response);
    }
    if (!clients.size) state.sseClients.delete(grantId);
  }
}

function discardOperationEventsForAccount(state, accountId) {
  for (const [operationId, record] of state.operationEvents) {
    if (record.events.some((event) => event.envelope?.header?.accountId === accountId)) {
      state.operationEventBytes -= record.bytes;
      state.operationEvents.delete(operationId);
    }
  }
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
    if (candidate && !candidate.includes(".")) {
      // A reserved viewer label never resolves to a personal management
      // account, even if a legacy pages-* address row still exists.
      return isReservedViewerSlug(candidate) ? null : normalizeSlug(candidate);
    }
  }
  if (isLocalHost(host)) return normalizeSlug(bodySlug ?? url.searchParams.get("slug"));
  return null;
}

// The reserved pages-* label of the request host, or null when the request is
// for the management plane. Viewer origins exist only under the base domain.
function viewerPlaneHost(state, request) {
  const host = requestHostname(state, request);
  const suffix = `.${state.baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return isReservedViewerSlug(label) ? label : null;
}

// The publishing ladder's viewer plane (docs/fold-publishing.md, rung 2). A
// reserved pages-* host serves exactly the static viewer shell, the viewer
// page API, and robots.txt — every other path gets the one indistinguishable
// "nothing here" answer, so an outsider cannot tell revoked, never-existed,
// or wrong-account apart, and no management surface, cookie, sign-in, or
// client bundle ever exists on a viewer origin.
async function handleViewerRequest(state, request, response, url, method) {
  state.metrics.recordViewerRequest();
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    return writeViewerText(response, 405, "Nothing is published here.\n", "GET", state, request);
  }
  if (url.pathname === "/robots.txt") {
    return writeViewerText(response, 200, "User-agent: *\nDisallow: /\n", method, state, request);
  }
  if (/^\/p\/[A-Za-z0-9._:-]{1,128}$/.test(url.pathname)) {
    return serveViewerShellFile(state, request, response, method, "index.html", "text/html; charset=utf-8");
  }
  // The rung-3 app shell (docs/fold-publishing.md): same origin-isolation and
  // fragment-key rules as pages, its own document so its own CSP. The shell
  // hosts the reviewed app inside a sandboxed blob: iframe WITHOUT
  // allow-same-origin — an opaque origin with no storage and no cookies. A
  // blob: document inherits the CSP of this shell document, so this policy
  // deliberately allows inline/blob script and style for the app's own
  // reviewed code while keeping every network direction closed: 'self' never
  // matches inside the opaque-origin frame, so the app document can reach
  // nothing at all — every read rides the shell's postMessage broker. The
  // shell itself is static bridge-authored code with no injection sink.
  if (/^\/a\/[A-Za-z0-9._:-]{1,128}$/.test(url.pathname)) {
    return serveViewerShellFile(state, request, response, method, "app.html", "text/html; charset=utf-8", {
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' blob:; "
        + "img-src blob: data:; media-src blob: data:; font-src blob: data:; connect-src 'self'; frame-src blob:; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  }
  if (url.pathname === "/viewer.js") {
    return serveViewerShellFile(state, request, response, method, "viewer.js", "text/javascript; charset=utf-8");
  }
  if (url.pathname === "/viewer-app.js") {
    return serveViewerShellFile(state, request, response, method, "viewer-app.js", "text/javascript; charset=utf-8");
  }
  if (url.pathname === "/viewer.css") {
    return serveViewerShellFile(state, request, response, method, "viewer.css", "text/css; charset=utf-8");
  }
  const pageMatch = url.pathname.match(/^\/api\/viewer\/pages\/([A-Za-z0-9._:-]{1,128})$/);
  if (pageMatch && method === "GET") {
    return handleViewerPageRequest(state, request, response, pageMatch[1]);
  }
  // The rung-3 viewer-app read routes: entry, exact staged asset, and the
  // manifest-declared viewer-readable data reads. The bridge composes the
  // typed call from the URL alone — the desktop's viewer adapter is the
  // authority that refuses everything outside the closed viewer vocabulary.
  const appMatch = url.pathname.match(/^\/api\/viewer\/apps\/([A-Za-z0-9._:-]{1,128})\/(entry|asset|data\/keys|data\/get)$/);
  if (appMatch && method === "GET") {
    const call = viewerAppCallFromRequest(appMatch[2], url.searchParams);
    if (!call) return writeViewerJson(response, 404, { state: "nothing-here" }, state, request);
    return handleViewerAppRequest(state, request, response, appMatch[1], call);
  }
  return writeViewerText(response, 404, "Nothing is published here.\n", method, state, request);
}

/** The typed viewer-app call for one GET route, or null when the query is unusable. */
function viewerAppCallFromRequest(route, searchParams) {
  if (route === "entry") return { kind: "entry" };
  if (route === "asset") {
    const path = searchParams.get("path");
    if (typeof path !== "string" || !path || path.length > 240) return null;
    return { kind: "asset", path };
  }
  if (route === "data/keys") {
    const prefix = searchParams.get("prefix");
    if (prefix !== null && prefix.length > 256) return null;
    return prefix === null ? { kind: "data.keys" } : { kind: "data.keys", prefix };
  }
  const key = searchParams.get("key");
  if (typeof key !== "string" || !key || key.length > 256) return null;
  return { kind: "data.get", key };
}

/**
 * The one viewer read: resolve the slot, enforce every bridge-side budget,
 * and complete from the live desktop, the opted-in snapshot, or a typed
 * honest state. Content crosses this path only as the desktop's signed
 * AES-GCM envelope; the fragment key never reaches the bridge.
 */
async function handleViewerPageRequest(state, request, response, publicationId) {
  const label = viewerPlaneHost(state, request);
  const slug = label && label.startsWith("pages-") ? label.slice("pages-".length) : null;
  const account = slug && !isReservedViewerSlug(slug) ? await state.database.accountBySlug(slug) : null;
  if (!account) return writeViewerJson(response, 404, { state: "nothing-here" }, state, request);
  try {
    enforceRateLimit(state.rateLimits, `viewer-ip:${account.id}:${clientIp(state, request)}`, viewerRequestsPerIpPerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }
  const publication = await state.database.publicationForViewer(account.id, publicationId);
  // A slot of the other kind answers the one indistinguishable refusal: the
  // page route serves pages, the app routes serve apps, and an outsider
  // cannot use the mismatch to learn what a slot is.
  if (!publication || publication.kind !== "page") return writeViewerJson(response, 404, { state: "nothing-here" }, state, request);
  if (publicationWindowServedBytes(publication) >= publication.byteBudgetPerDay) {
    state.metrics.recordViewerBudgetExhaustion();
    notifyPublicationResting(state, account.id, publication.id, "byte-budget");
    return writeViewerJson(response, 200, { state: "resting" }, state, request);
  }
  try {
    enforceRateLimit(state.rateLimits, `viewer-serve:${publication.id}`, publication.serveRatePerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    notifyPublicationResting(state, account.id, publication.id, "serve-rate");
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }

  const device = state.devices.get(account.id);
  if (!device) {
    const offline = await viewerOfflineResult(state, account.id, publication.id);
    return writeViewerJson(response, offline.state === "nothing-here" ? 404 : 200, offline, state, request);
  }
  try {
    enforceRateLimit(state.rateLimits, `viewer-dispatch:${account.id}`, viewerFetchDispatchPerAccountPerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }
  if ((state.viewerFetchCountsByPublication.get(publication.id) ?? 0) >= maximumConcurrentViewerFetchesPerPublication
    || state.viewerInFlightChars + maximumViewerPageCiphertextChars > maximumViewerInFlightCiphertextChars) {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }

  const fetchId = randomUUID();
  const result = await new Promise((resolveFetch) => {
    const waiter = {
      kind: "page",
      accountId: account.id,
      publicationId: publication.id,
      resolve: resolveFetch,
      timer: setTimeout(() => settleViewerFetchOffline(state, fetchId), state.viewerFetchTimeoutMs),
    };
    waiter.timer.unref?.();
    state.viewerFetches.set(fetchId, waiter);
    state.viewerFetchCountsByPublication.set(publication.id, (state.viewerFetchCountsByPublication.get(publication.id) ?? 0) + 1);
    state.viewerInFlightChars += maximumViewerPageCiphertextChars;
    state.metrics.recordViewerFetchDispatched();
    if (!sendDevice(device.socket, { type: "viewer.fetch", fetchId, publicationId: publication.id })) {
      settleViewerFetchOffline(state, fetchId);
    }
  });
  if (result.state === "live") {
    await chargeViewerBytes(state, account.id, publication.id, result.envelope.ciphertext.length);
  }
  return writeViewerJson(response, result.state === "nothing-here" ? 404 : 200, result, state, request);
}

/**
 * One viewer-app read (rung 3): identical admission ladder to pages — per-IP,
 * slot resolution with the kind check, byte budget, per-slot serve rate,
 * dispatch rate, concurrency, and the in-flight ciphertext budget — then a
 * `viewer.app.fetch` frame carrying the typed call. Apps have no snapshot
 * lane, so an offline desktop is always honestly asleep.
 */
async function handleViewerAppRequest(state, request, response, publicationId, call) {
  const label = viewerPlaneHost(state, request);
  const slug = label && label.startsWith("pages-") ? label.slice("pages-".length) : null;
  const account = slug && !isReservedViewerSlug(slug) ? await state.database.accountBySlug(slug) : null;
  if (!account) return writeViewerJson(response, 404, { state: "nothing-here" }, state, request);
  try {
    enforceRateLimit(state.rateLimits, `viewer-ip:${account.id}:${clientIp(state, request)}`, viewerRequestsPerIpPerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }
  const publication = await state.database.publicationForViewer(account.id, publicationId);
  if (!publication || publication.kind !== "app") return writeViewerJson(response, 404, { state: "nothing-here" }, state, request);
  if (publicationWindowServedBytes(publication) >= publication.byteBudgetPerDay) {
    state.metrics.recordViewerBudgetExhaustion();
    notifyPublicationResting(state, account.id, publication.id, "byte-budget");
    return writeViewerJson(response, 200, { state: "resting" }, state, request);
  }
  try {
    enforceRateLimit(state.rateLimits, `viewer-serve:${publication.id}`, publication.serveRatePerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    notifyPublicationResting(state, account.id, publication.id, "serve-rate");
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }

  const device = state.devices.get(account.id);
  if (!device) return writeViewerJson(response, 200, { state: "asleep" }, state, request);
  try {
    enforceRateLimit(state.rateLimits, `viewer-dispatch:${account.id}`, viewerFetchDispatchPerAccountPerMinute, 60_000);
  } catch {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }
  if ((state.viewerFetchCountsByPublication.get(publication.id) ?? 0) >= maximumConcurrentViewerFetchesPerPublication
    || state.viewerInFlightChars + maximumViewerPageCiphertextChars > maximumViewerInFlightCiphertextChars) {
    state.metrics.recordViewerBudgetExhaustion();
    return writeViewerJson(response, 429, { state: "resting" }, state, request);
  }

  const fetchId = randomUUID();
  const result = await new Promise((resolveFetch) => {
    const waiter = {
      kind: "app",
      accountId: account.id,
      publicationId: publication.id,
      resolve: resolveFetch,
      timer: setTimeout(() => settleViewerFetchOffline(state, fetchId), state.viewerFetchTimeoutMs),
    };
    waiter.timer.unref?.();
    state.viewerFetches.set(fetchId, waiter);
    state.viewerFetchCountsByPublication.set(publication.id, (state.viewerFetchCountsByPublication.get(publication.id) ?? 0) + 1);
    state.viewerInFlightChars += maximumViewerPageCiphertextChars;
    state.metrics.recordViewerFetchDispatched();
    if (!sendDevice(device.socket, { type: "viewer.app.fetch", fetchId, publicationId: publication.id, call })) {
      settleViewerFetchOffline(state, fetchId);
    }
  });
  if (result.state === "live") {
    await chargeViewerBytes(state, account.id, publication.id, result.envelope.ciphertext.length);
  }
  return writeViewerJson(response, result.state === "nothing-here" ? 404 : 200, result, state, request);
}

/**
 * Tells the connected desktop that one of its publications is resting, so the
 * publisher's glance can say precisely what the viewer's vague page cannot
 * (docs/fold-publishing.md, "Honest states": budget exhaustion is a typed
 * viewer state and a glance item, never a silent drop). Content-free —
 * publication id and a reason token — rate-limited to one notice per
 * publication per minute, and best-effort: an asleep desktop simply never
 * hears, and per-publication resting cannot occur while asleep anyway.
 */
function notifyPublicationResting(state, accountId, publicationId, reason) {
  const device = state.devices.get(accountId);
  if (!device) return;
  try {
    enforceRateLimit(state.rateLimits, `viewer-resting-notice:${publicationId}`, 1, 60_000);
  } catch {
    return;
  }
  sendDevice(device.socket, { type: "viewer.resting", publicationId, reason });
}

/** Desktop offline or unresponsive: the opted-in snapshot if one exists, else honestly asleep. */
async function viewerOfflineResult(state, accountId, publicationId) {
  try {
    const snapshot = await state.database.publicationSnapshot(accountId, publicationId);
    if (snapshot) {
      await chargeViewerBytes(state, accountId, publicationId, snapshot.ciphertext.length);
      return {
        state: "as-of",
        page: {
          publicationId: snapshot.publicationId,
          contentDigest: snapshot.contentDigest,
          capturedAt: snapshot.capturedAt,
          iv: snapshot.iv,
          ciphertext: snapshot.ciphertext,
        },
      };
    }
  } catch {
    // A snapshot read failure downgrades to asleep; it never breaks the path.
  }
  return { state: "asleep" };
}

async function chargeViewerBytes(state, accountId, publicationId, chars) {
  // Best-effort accounting after the response bytes were already committed;
  // admission for the next request reads the counters this write maintains.
  await state.database.chargePublicationServedBytes(accountId, publicationId, chars).catch(() => undefined);
}

function settleViewerFetch(state, fetchId, result) {
  const waiter = state.viewerFetches.get(fetchId);
  if (!waiter) return false;
  state.viewerFetches.delete(fetchId);
  clearTimeout(waiter.timer);
  const count = (state.viewerFetchCountsByPublication.get(waiter.publicationId) ?? 1) - 1;
  if (count > 0) state.viewerFetchCountsByPublication.set(waiter.publicationId, count);
  else state.viewerFetchCountsByPublication.delete(waiter.publicationId);
  state.viewerInFlightChars = Math.max(0, state.viewerInFlightChars - maximumViewerPageCiphertextChars);
  waiter.resolve(result);
  return true;
}

function settleViewerFetchOffline(state, fetchId) {
  const waiter = state.viewerFetches.get(fetchId);
  if (!waiter) return;
  // Apps have no snapshot lane: an unresponsive desktop is an honestly
  // asleep app, never an "as of" copy.
  if (waiter.kind === "app") {
    settleViewerFetch(state, fetchId, { state: "asleep" });
    return;
  }
  void viewerOfflineResult(state, waiter.accountId, waiter.publicationId)
    .then((result) => settleViewerFetch(state, fetchId, result))
    .catch(() => settleViewerFetch(state, fetchId, { state: "asleep" }));
}

function settleViewerFetchesForAccount(state, accountId) {
  for (const [fetchId, waiter] of [...state.viewerFetches]) {
    if (waiter.accountId === accountId) settleViewerFetchOffline(state, fetchId);
  }
}

/**
 * Admission for the desktop's signed viewer-page envelope, exactly as
 * work-fold.remote-response.v1 admission: shape, bounded ciphertext, header
 * identity, freshness, and the device signature. The bridge never holds the
 * publication key, so this is relay and caching hygiene, not decryption.
 */
function assertViewerPageEnvelope(account, value) {
  const envelope = assertEnvelopeShape(value, maximumViewerPageCiphertextChars / 1.4);
  const header = envelope.header;
  if (header.type !== "work-fold.viewer-page.v1" || header.accountId !== account.id || header.deviceId !== account.id
    || !isStableViewerId(header.publicationId) || !isStableViewerId(header.fetchId) || !isStableViewerId(header.contentDigest)) {
    throw new Error("Viewer page envelope is invalid.");
  }
  assertFreshTimestamp(header.servedAt);
  if (!verifyP1363(account.deviceSigningPublicJwk, envelopeSignedText(envelope), envelope.signature)) {
    throw new Error("Viewer page signature is invalid.");
  }
  return envelope;
}

/**
 * Admission for the desktop's signed viewer-app envelope (rung 3): the same
 * shape, bound, identity, freshness, and signature discipline as pages, plus
 * the call digest the shell verifies against the call it made. Relay
 * hygiene, never decryption — the publication key stays with link holders.
 */
function assertViewerAppEnvelope(account, value) {
  const envelope = assertEnvelopeShape(value, maximumViewerPageCiphertextChars / 1.4);
  const header = envelope.header;
  if (header.type !== "work-fold.viewer-app.v1" || header.accountId !== account.id || header.deviceId !== account.id
    || !isStableViewerId(header.publicationId) || !isStableViewerId(header.fetchId)
    || !isStableViewerId(header.contentDigest) || !isStableViewerId(header.callDigest)) {
    throw new Error("Viewer app envelope is invalid.");
  }
  assertFreshTimestamp(header.servedAt);
  if (!verifyP1363(account.deviceSigningPublicJwk, envelopeSignedText(envelope), envelope.signature)) {
    throw new Error("Viewer app signature is invalid.");
  }
  return envelope;
}

function isStableViewerId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function serveViewerShellFile(state, request, response, method, name, contentType, headerOverrides = {}) {
  let body;
  try {
    body = await readFile(join(viewerPublicDir, name));
  } catch {
    return writeViewerText(response, 404, "Nothing is published here.\n", method, state, request);
  }
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    // The shell is not fingerprinted; revalidate so a bridge rollout cannot
    // leave a viewer on stale shell code.
    "cache-control": "no-cache",
    "x-robots-tag": "noindex, nofollow",
    ...viewerSecurityHeaders(state, request),
    // The app shell document (rung 3) overrides exactly its CSP so the
    // sandboxed opaque-origin blob: iframe can run the reviewed app's own
    // code; every other viewer response keeps the strict page policy.
    ...headerOverrides,
  });
  response.end(method === "HEAD" ? undefined : body);
}

function writeViewerText(response, status, text, method, state, request) {
  const body = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...viewerSecurityHeaders(state, request),
  });
  response.end(method === "HEAD" ? undefined : body);
}

function writeViewerJson(response, status, value, state, request) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...viewerSecurityHeaders(state, request),
  });
  response.end(body);
}

// The viewer origin never sets cookies, never runs remote script, and renders
// decrypted documents inertly: blob: frames for PDFs, blob: images, no forms,
// no external connections beyond its own page API.
function viewerSecurityHeaders(state, request) {
  return {
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...(request && !isLocalHost(requestHostname(state, request)) ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
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

function enforceRateLimit(rateLimits, key, maximum, windowMs, maximumBuckets = maximumRateLimitBuckets) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current && rateLimits.size >= maximumBuckets) {
    for (const [candidate, item] of rateLimits) if (item.resetAt <= now) rateLimits.delete(candidate);
    if (rateLimits.size >= maximumBuckets) throw tooManyRequestsError();
  }
  const record = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  record.count += 1;
  rateLimits.set(key, record);
  if (record.count > maximum) throw tooManyRequestsError();
}

export function createPasswordCheckQueue({
  maximumConcurrentChecks,
  maximumConcurrentChecksPerIp,
  maximumQueuedChecks,
  maximumQueuedChecksPerIp,
}) {
  let active = 0;
  let queued = 0;
  const activeByIp = new Map();
  const queuesByIp = new Map();
  const rotation = [];

  const drain = () => {
    while (active < maximumConcurrentChecks && queued > 0 && rotation.length > 0) {
      let selected = null;
      const candidates = rotation.length;
      for (let index = 0; index < candidates; index += 1) {
        const ip = rotation.shift();
        const queue = queuesByIp.get(ip);
        if (!queue?.length) {
          queuesByIp.delete(ip);
          continue;
        }
        rotation.push(ip);
        if ((activeByIp.get(ip) ?? 0) < maximumConcurrentChecksPerIp) {
          selected = ip;
          break;
        }
      }
      if (!selected) return;

      const queue = queuesByIp.get(selected);
      const job = queue.shift();
      queued -= 1;
      if (queue.length === 0) {
        queuesByIp.delete(selected);
        const index = rotation.indexOf(selected);
        if (index >= 0) rotation.splice(index, 1);
      }
      active += 1;
      activeByIp.set(selected, (activeByIp.get(selected) ?? 0) + 1);
      void Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        const remaining = (activeByIp.get(selected) ?? 1) - 1;
        if (remaining > 0) activeByIp.set(selected, remaining);
        else activeByIp.delete(selected);
        drain();
      });
    }
  };

  return Object.freeze({
    run(ip, operation) {
      if (queued >= maximumQueuedChecks) return Promise.reject(tooManyRequestsError());
      const queue = queuesByIp.get(ip) ?? [];
      if (queue.length >= maximumQueuedChecksPerIp) return Promise.reject(tooManyRequestsError());
      return new Promise((resolveRun, rejectRun) => {
        if (!queuesByIp.has(ip)) {
          queuesByIp.set(ip, queue);
          rotation.push(ip);
        }
        queue.push({ operation, resolve: resolveRun, reject: rejectRun });
        queued += 1;
        drain();
      });
    },
    snapshot() {
      return Object.freeze({
        active,
        queued,
        maximumActive: maximumConcurrentChecks,
        maximumQueued: maximumQueuedChecks,
      });
    },
  });
}

function normalizedLoginProtection(value) {
  const options = value && typeof value === "object" ? value : {};
  return Object.freeze({
    attemptsPerIp: positiveInteger(options.attemptsPerIp, loginAttemptsPerIp),
    attemptWindowMs: positiveInteger(options.attemptWindowMs, loginAttemptWindowMs),
    maximumIpBuckets: positiveInteger(options.maximumIpBuckets, maximumLoginIpBuckets),
    maximumConcurrentChecks: positiveInteger(options.maximumConcurrentChecks, maximumConcurrentPasswordChecks),
    maximumConcurrentChecksPerIp: positiveInteger(options.maximumConcurrentChecksPerIp, maximumConcurrentPasswordChecksPerIp),
    maximumQueuedChecks: positiveInteger(options.maximumQueuedChecks, maximumQueuedPasswordChecks),
    maximumQueuedChecksPerIp: positiveInteger(options.maximumQueuedChecksPerIp, maximumQueuedPasswordChecksPerIp),
  });
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function invalidCredentialsError() {
  return httpError(401, "The address or password is incorrect.");
}

function tooManyRequestsError() {
  return httpError(429, "Too many requests. Wait a little while and try again.");
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
  for (const [key, record] of state.loginRateLimits) if (record.resetAt <= now) state.loginRateLimits.delete(key);
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

function publicationView(publication) {
  return {
    id: publication.id,
    kind: publication.kind,
    state: publication.state,
    serveRatePerMinute: publication.serveRatePerMinute,
    byteBudgetPerDay: publication.byteBudgetPerDay,
    servedBytes: publication.servedBytes,
    snapshotEnabled: publication.snapshotEnabled,
    operationId: publication.operationId,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
    expiresAt: publication.expiresAt,
  };
}

// Snapshot acknowledgements never echo ciphertext or IVs back; the desktop
// already holds them, and responses stay content-free.
function publicationSnapshotView(snapshot) {
  return {
    publicationId: snapshot.publicationId,
    contentDigest: snapshot.contentDigest,
    byteSize: snapshot.byteSize,
    capturedAt: snapshot.capturedAt,
  };
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
  // Origin isolation is bidirectional: the management origin never serves the
  // viewer shell, just as a viewer origin never serves the management client.
  if (candidate === viewerPublicDir || candidate.startsWith(`${viewerPublicDir}${sep}`)) throw httpError(404, "Not found.");
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
    return macReleaseFallbackUrl;
  }
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ico")) return "image/vnd.microsoft.icon";
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
      ["publication_contested", 409], ["publication_limit", 429], ["snapshot_disabled", 409],
      ["snapshot_too_large", 413], ["snapshot_budget", 413],
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
