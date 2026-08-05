import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

import WebSocket from "ws";

import type { WorkFoldRemoteFacade, WorkFoldRemoteOperation, WorkFoldRemotePrincipal } from "../../src/local/remote-management.js";
import type { RemoteAccessSettings, RemoteBrowserGrantSettings, SecureSettingsStore } from "./settings.js";

const reconnectDelaysMs = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
const maximumRememberedResponses = 256;
const maximumRemoteRequestCiphertextCharacters = Math.floor(12 * 1024 * 1024 * 1.4);
const operationSet = new Set<WorkFoldRemoteOperation>([
  "management.summary", "management.chats", "management.transcript", "management.send", "management.request",
  "management.stop", "spaces.list", "spaces.tree", "spaces.chats", "spaces.transcript", "spaces.send", "spaces.stop",
]);

export interface RemoteAccessStatus {
  configured: boolean;
  enabled: boolean;
  connection: "stopped" | "connecting" | "connected" | "error";
  slug: string | null;
  url: string | null;
  lastError: string | null;
  approvedBrowsers: Array<{ id: string; browserId: string; label: string; approvedAt: string }>;
}

export interface RemotePairingPrompt {
  id: string;
  browserId: string;
  label: string;
  code: string;
  expiresAt: string;
}

interface PairingRequest extends RemotePairingPrompt {
  signingPublicJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
}

interface RemoteEnvelope {
  header: Record<string, unknown>;
  iv: string;
  ciphertext: string;
  signature: string;
}

interface TrackedRemoteTask {
  principal: WorkFoldRemotePrincipal;
  operation: "management.send" | "spaces.send";
  spaceId?: string;
}

export class RemoteAccessClient {
  #settingsStore: SecureSettingsStore;
  #facade: WorkFoldRemoteFacade;
  #promptPairing: (pairing: RemotePairingPrompt) => Promise<boolean>;
  #onStatus: (status: RemoteAccessStatus) => void;
  #socket: WebSocket | null = null;
  #stopped = true;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #connection: RemoteAccessStatus["connection"] = "stopped";
  #lastError: string | null = null;
  #responses = new Map<string, RemoteEnvelope>();
  #inFlight = new Map<string, Promise<void>>();
  #authorityQueue: Promise<void> = Promise.resolve();
  #activeTasks = new Map<string, Map<string, TrackedRemoteTask>>();

  constructor(options: {
    settingsStore: SecureSettingsStore;
    facade: WorkFoldRemoteFacade;
    promptPairing: (pairing: RemotePairingPrompt) => Promise<boolean>;
    onStatus?: (status: RemoteAccessStatus) => void;
  }) {
    this.#settingsStore = options.settingsStore;
    this.#facade = options.facade;
    this.#promptPairing = options.promptPairing;
    this.#onStatus = options.onStatus ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.#stopped = false;
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) return;
    await this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#reconnectTimer = null;
    this.#heartbeatTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Remote access disabled");
    this.#connection = "stopped";
    this.#lastError = null;
    void this.emitStatus();
  }

  async status(): Promise<RemoteAccessStatus> {
    const settings = await this.#settingsStore.getRemoteAccess();
    return statusView(settings, this.#connection, this.#lastError);
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const settings = await this.#settingsStore.getRemoteAccess();
    if (!settings?.enabled) return this.stop();
    this.#connection = "connecting";
    await this.emitStatus();
    const url = new URL("/api/device/connect", settings.bridgeUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${settings.deviceToken}` } });
    this.#socket = socket;
    socket.on("open", () => {
      if (this.#socket !== socket || this.#stopped) return socket.close();
      this.#reconnectAttempt = 0;
      this.#connection = "connected";
      this.#lastError = null;
      void this.emitStatus();
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = setInterval(() => this.send({ type: "device.heartbeat" }), 20_000);
    });
    socket.on("message", (raw) => {
      void this.#handleMessage(raw.toString()).catch((error) => {
        this.#lastError = errorMessage(error);
        void this.emitStatus();
        this.send({ type: "protocol.error", error: "The desktop rejected an invalid remote message." });
      });
    });
    socket.on("close", (code) => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
      if (this.#stopped) return;
      this.#connection = code === 4001 ? "error" : "connecting";
      this.#lastError = code === 4001 ? "The remote-access device credential was revoked." : null;
      void this.emitStatus();
      this.#scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.#lastError = error.message;
      this.#connection = "error";
      void this.emitStatus();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = reconnectDelaysMs[Math.min(this.#reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch((error) => {
        this.#lastError = errorMessage(error);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  async #handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as { type?: unknown; [key: string]: unknown };
    if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("Remote message is invalid.");
    if (message.type === "device.ready") {
      const pending = Array.isArray(message.pendingPairings) ? message.pendingPairings : [];
      for (const pairing of pending) await this.#handlePairing(pairing);
      return;
    }
    if (message.type === "pairing.request") return this.#handlePairing(message.pairing);
    if (message.type === "operation.request") return this.#handleOperation(message.operation, message.envelope);
    if (message.type === "device.heartbeat" || message.type === "pairing.settled") return;
    if (message.type === "protocol.error" && typeof message.error === "string") throw new Error(message.error);
    throw new Error("Remote message type is unsupported.");
  }

  async #handlePairing(value: unknown): Promise<void> {
    const pairing = parsePairing(value);
    const settings = await this.requireActiveSettings();
    const approved = await this.#promptPairing({
      id: pairing.id,
      browserId: pairing.browserId,
      label: pairing.label,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
    });
    if (!approved || Date.parse(pairing.expiresAt) <= Date.now()) {
      this.send({ type: "pairing.decision", pairingId: pairing.id, approved: false });
      return;
    }
    const grant: RemoteBrowserGrantSettings = {
      id: randomUUID(),
      browserId: pairing.browserId,
      label: pairing.label,
      signingPublicJwk: pairing.signingPublicJwk,
      encryptionPublicJwk: pairing.encryptionPublicJwk,
      generation: await currentGrantGeneration(settings),
      approvedAt: new Date().toISOString(),
    };
    const certificate = {
      type: "work-fold.browser-grant.v1",
      accountId: settings.accountId,
      deviceId: settings.accountId,
      grantId: grant.id,
      pairingId: pairing.id,
      pairingCode: pairing.code,
      browserId: grant.browserId,
      browserSigningPublicJwk: grant.signingPublicJwk,
      browserEncryptionPublicJwk: grant.encryptionPublicJwk,
      generation: grant.generation,
      approvedAt: grant.approvedAt,
    };
    const signature = signP1363(settings.deviceSigningPrivateJwk, canonicalize(certificate));
    await this.#settingsStore.saveRemoteBrowserGrant(grant);
    this.send({ type: "pairing.decision", pairingId: pairing.id, approved: true, certificate, signature });
    await this.emitStatus();
  }

  async #handleOperation(operationValue: unknown, envelopeValue: unknown): Promise<void> {
    const operation = parseOperation(operationValue);
    const existing = this.#inFlight.get(operation.requestId);
    if (existing) {
      await existing;
      const remembered = this.#responses.get(operation.requestId);
      if (remembered) this.send({ type: "operation.complete", envelope: remembered });
      return;
    }
    const execution = this.#executeOperation(operation, envelopeValue);
    this.#inFlight.set(operation.requestId, execution);
    try {
      await execution;
    } finally {
      if (this.#inFlight.get(operation.requestId) === execution) this.#inFlight.delete(operation.requestId);
    }
  }

  async #executeOperation(operation: ReturnType<typeof parseOperation>, envelopeValue: unknown): Promise<void> {
    const settings = await this.requireActiveSettings();
    const envelope = parseEnvelope(envelopeValue);
    const grant = settings.grants.find((item) => item.id === operation.browserGrantId && item.generation === operation.generation);
    if (!grant) throw new Error("This browser grant is not active on the desktop.");
    assertRequestEnvelope(settings, grant, operation, envelope);
    const remembered = this.#responses.get(operation.requestId);
    if (remembered) {
      this.send({ type: "operation.complete", envelope: remembered });
      return;
    }
    const payload = decryptEnvelope(settings.deviceEncryptionPrivateJwk, grant.encryptionPublicJwk, grant.id, envelope);
    const input = parseRequestPayload(payload);
    const remoteOperation = operationName(envelope.header.operation);
    const principal: WorkFoldRemotePrincipal = { browserId: grant.browserId, grantId: grant.id, requestId: operation.requestId };
    this.sendEncrypted(settings, grant, operation, 1, true, { status: "running" }, "operation.event");
    try {
      // Re-read immediately before execution so disabling or revoking cannot
      // leave a stale envelope authorized in a queued microtask.
      const result = await this.#withAuthority(async () => {
        const current = await this.requireActiveSettings();
        if (!current.grants.some((item) => item.id === grant.id && item.generation === grant.generation)) {
          throw new Error("This browser was revoked before the request could start.");
        }
        const value = await this.#facade.execute(remoteOperation, input, principal);
        if (remoteOperation === "management.send" || remoteOperation === "spaces.send") {
          this.rememberActiveTask(grant.id, remoteOperation, value, principal);
        }
        return value;
      });
      const response = this.sendEncrypted(settings, grant, operation, 2, true, { result }, "operation.complete");
      this.remember(operation.requestId, response);
    } catch (error) {
      const response = this.sendEncrypted(settings, grant, operation, 2, false, { error: errorMessage(error) }, "operation.complete");
      this.remember(operation.requestId, response);
    }
  }

  sendEncrypted(
    settings: RemoteAccessSettings,
    grant: RemoteBrowserGrantSettings,
    operation: ReturnType<typeof parseOperation>,
    sequence: number,
    ok: boolean,
    payload: unknown,
    type: "operation.event" | "operation.complete",
  ): RemoteEnvelope {
    const header = {
      type: "work-fold.remote-response.v1",
      accountId: settings.accountId,
      deviceId: settings.accountId,
      grantId: grant.id,
      operationId: operation.id,
      requestId: operation.requestId,
      generation: grant.generation,
      sequence,
      ok,
      eventKind: type,
      createdAt: new Date().toISOString(),
    };
    const envelope = encryptEnvelope(settings.deviceEncryptionPrivateJwk, grant.encryptionPublicJwk, grant.id, header, payload);
    envelope.signature = signP1363(settings.deviceSigningPrivateJwk, signedEnvelopeText(envelope));
    this.send({ type, envelope });
    return envelope;
  }

  remember(requestId: string, response: RemoteEnvelope): void {
    this.#responses.set(requestId, response);
    while (this.#responses.size > maximumRememberedResponses) this.#responses.delete(this.#responses.keys().next().value!);
  }

  async revokeLocalGrant(grantId: string): Promise<void> {
    await this.#withAuthority(async () => {
      await this.#settingsStore.removeRemoteBrowserGrant(grantId);
      await this.#finishRevocationCleanup(grantId);
    });
  }

  async revokeAllLocalGrants(): Promise<void> {
    await this.#withAuthority(async () => {
      await this.#settingsStore.clearRemoteBrowserGrants();
      await this.#finishRevocationCleanup();
    });
  }

  async stopActiveRemoteTasks(): Promise<void> {
    await this.#withAuthority(() => this.#finishRevocationCleanup());
  }

  rememberActiveTask(
    grantId: string,
    operation: "management.send" | "spaces.send",
    value: unknown,
    principal: WorkFoldRemotePrincipal,
  ): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as { taskId?: unknown; space?: unknown };
    const taskId = record.taskId;
    if (typeof taskId !== "string" || !taskId) return;
    const spaceId = operation === "spaces.send"
      && record.space && typeof record.space === "object" && !Array.isArray(record.space)
      && typeof (record.space as { id?: unknown }).id === "string"
      ? (record.space as { id: string }).id
      : undefined;
    if (operation === "spaces.send" && !spaceId) return;
    const tasks = this.#activeTasks.get(grantId) ?? new Map<string, TrackedRemoteTask>();
    tasks.set(taskId, { principal, operation, ...(spaceId ? { spaceId } : {}) });
    this.#activeTasks.set(grantId, tasks);
  }

  async #stopTrackedTasks(grantId?: string): Promise<void> {
    const selected = grantId ? [[grantId, this.#activeTasks.get(grantId)] as const] : [...this.#activeTasks.entries()];
    const failures: string[] = [];
    for (const [selectedGrantId, tasks] of selected) {
      if (!tasks) continue;
      for (const [taskId, tracked] of tasks) {
        try {
          const result = await this.#facade.execute(
            tracked.operation === "spaces.send" ? "spaces.stop" : "management.stop",
            tracked.operation === "spaces.send" ? { taskId, spaceId: tracked.spaceId } : { taskId },
            {
              ...tracked.principal,
              grantId: selectedGrantId,
              requestId: randomUUID(),
            },
          );
          if (tracked.operation === "spaces.send") {
            if (!remoteSpaceStopSettled(result)) throw new Error("The Space task could not be stopped.");
          } else if (!remoteStopWasAccepted(result)) {
            const status = await this.#facade.execute("management.request", { taskId }, {
              ...tracked.principal,
              grantId: selectedGrantId,
              requestId: randomUUID(),
            });
            if (remoteRequestIsActive(status)) throw new Error("The request is still active.");
          }
          tasks.delete(taskId);
        } catch (error) {
          failures.push(`${taskId}: ${errorMessage(error)}`);
        }
      }
      if (!tasks.size) this.#activeTasks.delete(selectedGrantId);
    }
    if (failures.length) throw new Error(`Could not confirm that remote work stopped (${failures.join("; ")}).`);
  }

  async #finishRevocationCleanup(grantId?: string): Promise<void> {
    const failures: string[] = [];
    try { await this.#stopTrackedTasks(grantId); }
    catch (error) { failures.push(errorMessage(error)); }
    try { await this.#facade.purgeUploads(grantId); }
    catch (error) { failures.push(`Could not purge remote uploads: ${errorMessage(error)}`); }
    if (failures.length) throw new Error(failures.join(" "));
  }

  async #withAuthority<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#authorityQueue.catch(() => undefined).then(operation);
    this.#authorityQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  send(value: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(value));
  }

  async requireActiveSettings(): Promise<RemoteAccessSettings> {
    const settings = await this.#settingsStore.getRemoteAccess();
    if (!settings?.enabled) throw new Error("Remote access is disabled.");
    return settings;
  }

  async emitStatus(): Promise<void> {
    this.#onStatus(await this.status());
  }
}

export function generateRemoteDeviceKeys(): Pick<RemoteAccessSettings,
  "deviceSigningPrivateJwk" | "deviceSigningPublicJwk" | "deviceEncryptionPrivateJwk" | "deviceEncryptionPublicJwk"> {
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encryption = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    deviceSigningPrivateJwk: signing.privateKey.export({ format: "jwk" }),
    deviceSigningPublicJwk: { ...signing.publicKey.export({ format: "jwk" }), use: "sig" },
    deviceEncryptionPrivateJwk: encryption.privateKey.export({ format: "jwk" }),
    deviceEncryptionPublicJwk: { ...encryption.publicKey.export({ format: "jwk" }), use: "enc" },
  };
}

function parsePairing(value: unknown): PairingRequest {
  const record = objectValue(value, "pairing request");
  const pairing = {
    id: stableId(record.id, "pairing id"),
    browserId: stableId(record.browserId, "browser id"),
    label: stringValue(record.label, "browser label", 80),
    code: stringValue(record.code, "pairing code", 6),
    expiresAt: timestampValue(record.expiresAt, "pairing expiry"),
    signingPublicJwk: publicEcJwk(record.signingPublicJwk, "browser signing key"),
    encryptionPublicJwk: publicEcJwk(record.encryptionPublicJwk, "browser encryption key"),
  };
  if (!/^\d{6}$/.test(pairing.code)) throw new Error("Pairing code is invalid.");
  return pairing;
}

function parseOperation(value: unknown): {
  id: string;
  accountId: string;
  browserGrantId: string;
  requestId: string;
  operation: string;
  generation: number;
} {
  const record = objectValue(value, "remote operation");
  return {
    id: stableId(record.id, "operation id"),
    accountId: stableId(record.accountId, "account id"),
    browserGrantId: stableId(record.browserGrantId, "browser grant id"),
    requestId: stableId(record.requestId, "request id"),
    operation: stringValue(record.operation, "operation", 80),
    generation: positiveInteger(record.generation, "grant generation"),
  };
}

function parseEnvelope(value: unknown): RemoteEnvelope {
  const record = objectValue(value, "remote envelope");
  return {
    header: objectValue(record.header, "remote envelope header"),
    iv: base64urlValue(record.iv, "envelope iv", 16),
    ciphertext: base64urlValue(record.ciphertext, "envelope ciphertext", maximumRemoteRequestCiphertextCharacters),
    signature: base64urlValue(record.signature, "envelope signature", 128),
  };
}

function assertRequestEnvelope(
  settings: RemoteAccessSettings,
  grant: RemoteBrowserGrantSettings,
  operation: ReturnType<typeof parseOperation>,
  envelope: RemoteEnvelope,
): void {
  const header = envelope.header;
  const expected = {
    type: "work-fold.remote-request.v1",
    accountId: settings.accountId,
    deviceId: settings.accountId,
    grantId: grant.id,
    generation: grant.generation,
    requestId: operation.requestId,
    operation: operation.operation,
    createdAt: header.createdAt,
  };
  if (canonicalize(header) !== canonicalize(expected) || !freshTimestamp(header.createdAt)
    || !verifyP1363(grant.signingPublicJwk, signedEnvelopeText(envelope), envelope.signature)) {
    throw new Error("The remote request signature or identity is invalid.");
  }
}

function parseRequestPayload(value: unknown): unknown {
  const record = objectValue(value, "remote request payload");
  const unknown = Object.keys(record).find((key) => key !== "input");
  if (unknown) throw new Error(`Remote request payload does not accept ${unknown}.`);
  return record.input ?? {};
}

function operationName(value: unknown): WorkFoldRemoteOperation {
  if (typeof value !== "string" || !operationSet.has(value as WorkFoldRemoteOperation)) throw new Error("Remote operation is unsupported.");
  return value as WorkFoldRemoteOperation;
}

function encryptEnvelope(privateJwk: JsonWebKey, publicJwk: JsonWebKey, grantId: string, header: Record<string, unknown>, payload: unknown): RemoteEnvelope {
  const key = transportKey(privateJwk, publicJwk, grantId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonicalize(header)));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return { header, iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url"), signature: "" };
}

function decryptEnvelope(privateJwk: JsonWebKey, publicJwk: JsonWebKey, grantId: string, envelope: RemoteEnvelope): unknown {
  const key = transportKey(privateJwk, publicJwk, grantId);
  const encrypted = Buffer.from(envelope.ciphertext, "base64url");
  if (encrypted.length < 17) throw new Error("Remote envelope ciphertext is invalid.");
  const body = encrypted.subarray(0, -16);
  const tag = encrypted.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(canonicalize(envelope.header)));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

function transportKey(privateJwk: JsonWebKey, publicJwk: JsonWebKey, grantId: string): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: nodeJwk(privateJwk), format: "jwk" }),
    publicKey: createPublicKey({ key: nodeJwk(publicJwk), format: "jwk" }),
  });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(grantId), Buffer.from("work-fold.remote-envelope.v1"), 32));
}

function signP1363(privateJwk: JsonWebKey, text: string): string {
  return sign("sha256", Buffer.from(text), {
    key: createPrivateKey({ key: nodeJwk(privateJwk), format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

function verifyP1363(publicJwk: JsonWebKey, text: string, signature: string): boolean {
  try {
    return verify("sha256", Buffer.from(text), {
      key: createPublicKey({ key: nodeJwk(publicJwk), format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    }, Buffer.from(signature, "base64url"));
  } catch { return false; }
}

function signedEnvelopeText(envelope: RemoteEnvelope): string {
  return `${canonicalize(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Only JSON values can be signed.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

async function currentGrantGeneration(settings: RemoteAccessSettings): Promise<number> {
  const response = await fetch(new URL("/api/device/account", settings.bridgeUrl), {
    headers: { authorization: `Bearer ${settings.deviceToken}` },
  });
  const body = await response.json() as { account?: { grantGeneration?: unknown }; error?: unknown };
  if (!response.ok || !Number.isInteger(body.account?.grantGeneration)) throw new Error(typeof body.error === "string" ? body.error : "Could not read the remote grant generation.");
  return Number(body.account!.grantGeneration);
}

function statusView(settings: RemoteAccessSettings | null, connection: RemoteAccessStatus["connection"], lastError: string | null): RemoteAccessStatus {
  const bridge = settings ? new URL(settings.bridgeUrl) : null;
  const baseHost = bridge?.hostname.replace(/^www\./, "") ?? "";
  return {
    configured: Boolean(settings),
    enabled: settings?.enabled ?? false,
    connection: settings?.enabled ? connection : "stopped",
    slug: settings?.slug ?? null,
    url: settings ? `${bridge!.protocol}//${settings.slug}.${baseHost}${bridge!.port ? `:${bridge!.port}` : ""}` : null,
    lastError,
    approvedBrowsers: settings?.grants.map((grant) => ({ id: grant.id, browserId: grant.browserId, label: grant.label, approvedAt: grant.approvedAt })) ?? [],
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error(`A valid ${label} is required.`);
  return value;
}
function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) throw new Error(`A valid ${label} is required.`);
  return value.trim();
}
function timestampValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`A valid ${label} is required.`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`A valid ${label} is required.`);
  return Number(value);
}
function base64urlValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`A valid ${label} is required.`);
  return value;
}
function publicEcJwk(value: unknown, label: string): JsonWebKey {
  const record = objectValue(value, label) as JsonWebKey;
  if (record.kty !== "EC" || record.crv !== "P-256" || typeof record.x !== "string" || typeof record.y !== "string" || record.d !== undefined) throw new Error(`${label} is invalid.`);
  try { createPublicKey({ key: nodeJwk(record), format: "jwk" }); } catch { throw new Error(`${label} is invalid.`); }
  return structuredClone(record);
}
function nodeJwk(value: JsonWebKey): NodeJsonWebKey {
  return value as unknown as NodeJsonWebKey;
}
function freshTimestamp(value: unknown): boolean {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(Date.now() - time) <= 5 * 60_000;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? "unknown error"); }

function remoteStopWasAccepted(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stopped = (value as { stopped?: unknown }).stopped;
  if (!stopped || typeof stopped !== "object" || Array.isArray(stopped)) return false;
  const result = stopped as { managementAborted?: unknown; children?: unknown };
  const children = Array.isArray(result.children) ? result.children : [];
  const childrenStopped = children.every((child) => child && typeof child === "object" && (child as { aborted?: unknown }).aborted === true);
  return childrenStopped && (result.managementAborted === true || children.length > 0);
}

function remoteRequestIsActive(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const request = (value as { request?: unknown }).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return true;
  return new Set(["working", "handed_off"]).has((request as { phase?: unknown }).phase as string);
}

function remoteSpaceStopSettled(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { stopped?: unknown }).stopped === "boolean");
}
