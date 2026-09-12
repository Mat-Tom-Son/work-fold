import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { ChromeBootstrapRequest, ChromeBootstrapResponse, ChromeBridgeCompatibility, ChromeConnectionObservation, ChromeConnectionSummary, ChromeHostFacilities, ChromeRuntimeConnection } from "../../shared/chrome-connection.js";

export interface ChromeDistribution {
  version: number; storeId: string | null; nativeHostName: string; bootstrapVersion: number;
  extensionVersion: string; bridge: ChromeBridgeCompatibility;
}
export interface IncludedChromeConnectionHost extends ChromeHostFacilities {
  status(): ChromeConnectionSummary;
  prepare(): Promise<ChromeConnectionSummary>;
  check(): Promise<ChromeConnectionSummary>;
  disconnect(): Promise<ChromeConnectionSummary>;
  changeProfile(): Promise<ChromeConnectionSummary>;
}
interface Selection { clientId: string; proofHash: string; extensionOrigin: string; generation: number }
interface SavedConnection { version: 1; enabled: boolean; generation: number; selected?: Selection }
interface Options {
  stateRoot: string;
  distribution: ChromeDistribution;
  registerNativeHost(explicit: boolean): Promise<void>;
  openStore(): Promise<void>;
  probe(): Promise<void>;
  startTransport(facilities: ChromeHostFacilities): Promise<{ close(): void }>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const secret = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (left: string, right: string) => Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** One app-owned selection; neither the helper nor a renderer writes authority. */
export class IncludedChromeConnectionService implements IncludedChromeConnectionHost {
  readonly #options: Options;
  readonly #launchId = randomUUID();
  readonly #bootstrapToken = token();
  readonly #listeners = new Set<() => void>();
  readonly #active = new Set<symbol>();
  readonly #requests = new Map<string, { digest: string; response: ChromeBootstrapResponse }>();
  readonly #owned = new Set<Promise<unknown>>();
  #saved: SavedConnection = { version: 1, enabled: false, generation: 0 };
  #lease?: ChromeRuntimeConnection;
  #leaseIssuedAt = 0;
  #recordUnreadable = false;
  #observation?: { at: number; value: ChromeConnectionObservation };
  #server?: Server;
  #transport?: { close(): void };
  #closed = false;
  #changing = false;
  #serial: Promise<unknown> = Promise.resolve();
  #closing?: Promise<void>;
  private constructor(options: Options) { this.#options = options; }

  static async create(options: Options): Promise<IncludedChromeConnectionService> {
    const service = new IncludedChromeConnectionService(options);
    try {
      const value = JSON.parse(await readFile(service.#recordPath, "utf8")) as SavedConnection;
      if (value.version !== 1 || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.generation) || value.generation < 0
        || (value.selected && (!identifier(value.selected.clientId) || !secret(value.selected.proofHash) || value.selected.extensionOrigin !== service.#origin || value.selected.generation !== value.generation))) throw new Error("Invalid Chrome connection record");
      service.#saved = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") service.#recordUnreadable = true;
    }
    return service;
  }
  get #root() { return join(this.#options.stateRoot, "chrome", "native-host"); }
  get #recordPath() { return join(this.#root, "connection.json"); }
  get #descriptorPath() { return join(this.#root, "launch.json"); }
  get #origin() { const id = this.#options.distribution.storeId; return id && /^[a-p]{32}$/.test(id) ? `chrome-extension://${id}/` : undefined; }
  #summary(state: ChromeConnectionSummary["state"]): ChromeConnectionSummary {
    return { state, checkedAt: new Date().toISOString(), hasSelection: Boolean(this.#saved.selected), ...(this.#observation?.value.extensionVersion ? { extensionVersion: this.#observation.value.extensionVersion } : {}) };
  }
  status(): ChromeConnectionSummary {
    if (!this.#origin) return this.#summary("store_unavailable");
    if (this.#closed) return this.#summary("app_not_running");
    if (this.#recordUnreadable) return this.#summary("connection_error");
    if (!this.#saved.selected) return this.#summary("not_connected");
    const observed = this.#observation;
    if (observed && Date.now() - observed.at < 30_000 && observed.value.connectionId === this.#lease?.connectionId) return this.#summary(observed.value.state);
    if (!observed && this.#lease && Date.now() - this.#leaseIssuedAt < 30_000) return this.#summary("connecting");
    return this.#summary("not_connected");
  }
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(operation);
    this.#serial = next.catch(() => {});
    return this.#track(next);
  }
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#owned.add(operation);
    void operation.finally(() => this.#owned.delete(operation)).catch(() => {});
    return operation;
  }
  async #persist(next: SavedConnection) {
    if (this.#recordUnreadable) throw new Error("The Chrome connection settings could not be read. They have not been replaced.");
    await mkdir(this.#root, { recursive: true, mode: 0o700 }); await chmod(this.#root, 0o700);
    const temporary = `${this.#recordPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 }); await rename(temporary, this.#recordPath); }
    finally { await rm(temporary, { force: true }); }
    this.#saved = next;
  }
  #revoke() {
    const wasOwned = Boolean(this.#lease || this.#transport);
    this.#lease = undefined; this.#observation = undefined;
    if (wasOwned) for (const listener of this.#listeners) { try { listener(); } catch { /* Revocation must reach every owner. */ } }
    this.#transport?.close(); this.#transport = undefined;
  }
  getChromeConnection = async (): Promise<ChromeRuntimeConnection | undefined> => {
    if (this.#closed || this.#changing || this.#recordUnreadable || !this.#saved.enabled || !this.#saved.selected || !this.#origin) return undefined;
    if (!this.#lease) {
      this.#lease = { connectionId: randomUUID(), leaseToken: token(), extensionOrigin: this.#origin, bridge: this.#options.distribution.bridge };
      this.#leaseIssuedAt = Date.now();
    }
    return { ...this.#lease, bridge: { ...this.#lease.bridge, capabilities: [...this.#lease.bridge.capabilities] } };
  };
  onChromeConnectionRevoked = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  reportChromeConnectionObservation = (value: ChromeConnectionObservation): void => {
    if (!this.#closed && value.connectionId === this.#lease?.connectionId) this.#observation = { at: Date.now(), value: { ...value } };
  };
  beginChromeWork = (connectionId: string): (() => void) => {
    if (this.#closed || this.#changing || connectionId !== this.#lease?.connectionId) throw new Error("Chrome connection changed before this work started. Observe the current connection before continuing.");
    const owner = Symbol("Chrome work"); this.#active.add(owner);
    return () => { this.#active.delete(owner); };
  };

  async startIfEnabled(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#saved.enabled && this.#origin && !this.#closed) {
        await this.#options.registerNativeHost(false);
        if (this.#closed) return;
        await this.#start();
        if (!this.#closed && this.#saved.selected) {
          await this.getChromeConnection();
          if (!this.#closed) this.#transport = await this.#options.startTransport(this);
        }
      }
    });
  }
  async prepare(): Promise<ChromeConnectionSummary> {
    return this.#exclusive(async () => {
      if (!this.#origin) return this.#summary("store_unavailable");
      if (this.#closed) return this.#summary("app_not_running");
      if (this.#recordUnreadable) return this.#summary("connection_error");
      if (this.#active.size) return this.#summary("busy");
      this.#changing = true;
      try {
        await this.#options.registerNativeHost(true);
        if (this.#closed) return this.#summary("app_not_running");
        await this.#persist({ ...this.#saved, enabled: true });
        if (this.#closed) return this.#summary("app_not_running");
        await this.#start();
        if (this.#closed) return this.#summary("app_not_running");
        await this.#options.openStore();
        return this.status();
      } finally { this.#changing = false; }
    });
  }
  async check(): Promise<ChromeConnectionSummary> {
    return this.#track((async () => {
      if (!this.#origin || this.#closed || !this.#saved.selected) return this.status();
      this.#observation = undefined;
      try { await this.#options.probe(); } catch { return this.#summary(this.#closed ? "app_not_running" : "connection_error"); }
      return this.status();
    })());
  }
  async #disconnect(): Promise<ChromeConnectionSummary> {
    if (this.#closed) return this.#summary("app_not_running");
    if (!this.#origin) return this.#summary("store_unavailable");
    if (this.#active.size) return this.#summary("busy");
    this.#changing = true;
    try {
      await this.#persist({ version: 1, enabled: this.#saved.enabled, generation: this.#saved.generation + 1 });
      this.#revoke();
    } finally { this.#changing = false; }
    // Keep the installed bootstrap available for a later deliberate Connect.
    // Resume with the old proof cannot enroll a selection or recover a lease.
    return this.status();
  }
  disconnect(): Promise<ChromeConnectionSummary> { return this.#exclusive(() => this.#disconnect()); }
  changeProfile(): Promise<ChromeConnectionSummary> {
    return this.#exclusive(async () => {
      const summary = await this.#disconnect();
      if (summary.state === "not_connected" && !this.#closed) await this.#options.openStore();
      return summary;
    });
  }

  async bootstrap(origin: string, input: unknown): Promise<ChromeBootstrapResponse> {
    return this.#exclusive(async () => {
      const result = (state: ChromeConnectionSummary["state"]): ChromeBootstrapResponse => ({ version: 1, state: "status", status: this.#summary(state) });
      if (this.#closed) return result("app_not_running");
      if (this.#recordUnreadable) return result("connection_error");
      if (!this.#origin) return result("store_unavailable");
      if (origin !== this.#origin || !validRequest(input)) return result("connection_error");
      const request = input;
      const expected = this.#options.distribution.bridge;
      if (request.bridge.major > expected.major) return result("update_app");
      if (request.bridge.major < expected.major || expected.capabilities.some(capability => !request.bridge.capabilities.includes(capability))) return result("update_extension");
      const digest = hash(JSON.stringify(request));
      const old = this.#requests.get(request.requestId);
      if (old) return old.digest !== digest ? result("connection_error")
        : old.response.state === "lease_ready" && old.response.connection.connectionId !== this.#lease?.connectionId ? result("not_connected") : old.response;
      const selected = this.#saved.selected;
      const owned = selected && selected.clientId === request.clientId && secret(request.clientProof) && same(selected.proofHash, hash(request.clientProof));
      let response: ChromeBootstrapResponse;
      if (selected && !owned) response = result("profile_conflict");
      else if (request.action === "status") response = { version: 1, state: "status", status: this.status() };
      else if (request.action === "disconnect") response = selected ? { version: 1, state: "status", status: await this.#disconnect() } : result("not_connected");
      else if (!selected && request.action === "resume") response = result("not_connected");
      else if (!this.#saved.enabled) response = result("not_connected");
      else {
        if (!selected) {
          if (this.#active.size) return result("busy");
          const generation = this.#saved.generation + 1;
          await this.#persist({ version: 1, enabled: true, generation, selected: { clientId: request.clientId, proofHash: hash(request.clientProof!), extensionOrigin: origin, generation } });
        }
        const connection = await this.getChromeConnection();
        if (!connection || this.#closed) return result(this.#closed ? "app_not_running" : "not_connected");
        this.#transport ??= await this.#options.startTransport(this);
        if (this.#closed) return result("app_not_running");
        response = { version: 1, state: "lease_ready", connection };
      }
      // Cache only successful mutation identity; status is always a fresh read.
      if (request.action !== "status" && response.state === "lease_ready") {
        this.#requests.set(request.requestId, { digest, response });
        while (this.#requests.size > 256) this.#requests.delete(this.#requests.keys().next().value!);
      }
      return response;
    });
  }
  async #start() {
    if (this.#server || this.#closed) return;
    const server = createServer((request, response) => {
      void (async () => {
        const answer = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
        const authorization = request.headers.authorization;
        if (request.method !== "POST" || request.url !== "/bootstrap" || request.headers.origin !== undefined
          || typeof authorization !== "string" || !same(authorization, `Bearer ${this.#bootstrapToken}`)) { answer(403, { error: "Native bootstrap authentication required." }); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 20 * 1024) { answer(413, { error: "Native bootstrap request too large." }); return; } chunks.push(chunk); }
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (envelope.version !== 1 || envelope.launchId !== this.#launchId || envelope.extensionOrigin !== this.#origin || Object.keys(envelope).some(key => !["version", "launchId", "extensionOrigin", "request"].includes(key))) { answer(403, { error: "Native bootstrap ownership expired." }); return; }
        answer(200, await this.bootstrap(envelope.extensionOrigin, envelope.request));
      })().catch(() => { if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"Native bootstrap request failed."}'); });
    });
    server.requestTimeout = 5_000; server.headersTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      this.#server = server;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Chrome bootstrap did not bind loopback.");
      if (this.#closed) return;
      await mkdir(this.#root, { recursive: true, mode: 0o700 }); await chmod(this.#root, 0o700);
      const temporary = `${this.#descriptorPath}.${this.#launchId}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify({ version: 1, launchId: this.#launchId, endpoint: `http://127.0.0.1:${address.port}/bootstrap`, bootstrapToken: this.#bootstrapToken })}\n`, { mode: 0o600 }); await rename(temporary, this.#descriptorPath); }
      finally { await rm(temporary, { force: true }); }
    } catch (error) {
      if (this.#server === server) this.#server = undefined;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#revoke();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#owned]);
      this.#revoke(); this.#requests.clear(); this.#listeners.clear();
      const server = this.#server; this.#server = undefined;
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      try { if (JSON.parse(await readFile(this.#descriptorPath, "utf8")).launchId === this.#launchId) await rm(this.#descriptorPath, { force: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    })();
    return this.#closing;
  }
}

function validRequest(value: unknown): value is ChromeBootstrapRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as ChromeBootstrapRequest;
  if (Object.keys(value).some(key => !["version", "action", "requestId", "clientId", "clientProof", "extensionVersion", "bridge"].includes(key))) return false;
  if (request.version !== 1 || !["connect", "resume", "disconnect", "status"].includes(request.action) || !identifier(request.requestId) || !identifier(request.clientId)
    || (request.action !== "status" && !secret(request.clientProof)) || typeof request.extensionVersion !== "string" || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(request.extensionVersion)) return false;
  const bridge = request.bridge;
  return Boolean(bridge && !Array.isArray(bridge) && Object.keys(bridge).every(key => ["major", "minor", "capabilities"].includes(key)) && Number.isSafeInteger(bridge.major) && bridge.major >= 0 && Number.isSafeInteger(bridge.minor) && bridge.minor >= 0 && Array.isArray(bridge.capabilities) && bridge.capabilities.length <= 32 && bridge.capabilities.every(value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value)));
}
