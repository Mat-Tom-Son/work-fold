import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { validateRestrictedAppValue, type RestrictedAppToolDeclaration } from "./restricted-app-manifest.js";
import { restrictedAppTaskAuthorityDigest as hash, type RestrictedAppTaskScope } from "./restricted-app-tasks.js";
import type { RestrictedAppActionExecution, RestrictedAppInstalled } from "./restricted-app-service.js";
import { parseAuthorityStamp, parseTenantId, parseRuntimeInstanceId, parseDataNamespaceId, parsePrincipalId } from "./app-platform-contract.js";
import { parseAppPlatformArtifactDigest } from "./app-platform-artifact.js";

export const browserAppActionLimits = Object.freeze({
  inputBytes: 16 * 1024, resultBytes: 128 * 1024, records: 1000, fileBytes: 64 * 1024 * 1024,
  pendingPerInstallation: 4, pendingPerBrowser: 16, running: 2, requestAgeMs: 15 * 60_000, retentionMs: 24 * 60 * 60_000,
});
const limits = browserAppActionLimits;
const schema = "work-fold.browser-app-actions.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Status = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "expired";
export interface BrowserAppActionOwner { browserId: string; grantId: string }
export interface BrowserAppActionReceipt {
  id: string;
  requestId: string;
  action: string;
  title: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  cancellationRequested?: true;
}
export interface BrowserAppActionResult extends BrowserAppActionReceipt { result?: unknown }
export type BrowserAppActionProvenance = Pick<RestrictedAppInstalled, "tenantId" | "runtimeInstanceId" | "runtimeInstanceKind" | "dataNamespaceId" | "principalId" | "authority" | "artifactDigest">;
export interface BrowserAppActionApp { actions: readonly RestrictedAppToolDeclaration[]; provenance: BrowserAppActionProvenance }
interface ActionRecord {
  receipt: BrowserAppActionReceipt;
  scope: RestrictedAppTaskScope;
  owner: BrowserAppActionOwner;
  requestedAt: string;
  requestDigest: string;
  declaration: RestrictedAppToolDeclaration;
  provenance: BrowserAppActionProvenance;
  inputJson: string;
  resultJson?: string;
}
export interface BrowserAppActionPorts {
  /** Serialize bounded admission against changes to the exact installed authority. */
  withApp<T>(scope: RestrictedAppTaskScope, operation: (app: BrowserAppActionApp) => Promise<T>): Promise<T>;
  invoke(scope: RestrictedAppTaskScope, action: string, input: unknown, execution: RestrictedAppActionExecution): Promise<unknown>;
}
export class BrowserAppActionError extends Error {
  constructor(readonly code: "ACTION_INVALID" | "ACTION_DENIED" | "ACTION_CONFLICT" | "ACTION_UNAVAILABLE", message: string) { super(message); }
}

/** Private browser intents and results are bounded content; receipt projections contain no input or output. */
export class BrowserAppActionService {
  readonly #path: string;
  readonly #ports: BrowserAppActionPorts;
  readonly #now: () => Date;
  #records: ActionRecord[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #active = new Map<string, { owner: BrowserAppActionOwner; controller: AbortController; settled: Promise<void> }>();
  #cancelled = new Set<string>();
  #unavailable = false;
  #closed = false;

  private constructor(options: { path: string; ports: BrowserAppActionPorts; now?: () => Date }) {
    this.#path = options.path;
    this.#ports = options.ports;
    this.#now = options.now ?? (() => new Date());
  }

  static async create(options: { path: string; ports: BrowserAppActionPorts; now?: () => Date }): Promise<BrowserAppActionService> {
    const service = new BrowserAppActionService(options);
    await mkdir(dirname(options.path), { recursive: true });
    let handle;
    try {
      handle = await open(options.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.fileBytes) invalid("The app action journal is invalid.");
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) invalid("The app action journal changed while reading.");
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      exact(value, ["schema", "records"]);
      if (value.schema !== schema || !Array.isArray(value.records) || value.records.length > limits.records) invalid("The app action journal is invalid.");
      service.#records = value.records.map(parseRecord);
      if (new Set(service.#records.map((record) => record.receipt.id)).size !== service.#records.length
        || new Set(service.#records.map(requestKey)).size !== service.#records.length) invalid("The app action journal has duplicate identities.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") service.#unavailable = true;
    } finally { await handle?.close(); }
    if (!service.#unavailable) {
      try {
        const at = service.#now().toISOString();
        const next = service.#records.map((record) => record.receipt.status === "running"
          ? { ...record, receipt: { ...record.receipt, status: "interrupted" as const, updatedAt: at } } : record);
        if (next.some((record, index) => record !== service.#records[index])) await service.#save(next);
      } catch { service.#unavailable = true; }
    }
    return service;
  }

  async request(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, value: unknown, assertCurrent: () => void): Promise<BrowserAppActionResult> {
    validateScope(scope); validateOwner(owner);
    return this.#run(() => this.#ports.withApp(scope, async ({ actions, provenance }) => {
      exact(value, ["requestId", "requestedAt", "action", "input"]);
      if (typeof value.requestId !== "string" || !uuid.test(value.requestId)) invalid("Supply a unique app request id.");
      const requestedAt = date(value.requestedAt);
      const declaration = actions.find((item) => item.action === value.action);
      if (!declaration) denied("Choose a declared app action.");
      const inputJson = boundedJson(value.input, limits.inputBytes);
      validateInput(declaration, inputJson);
      await this.#expire();
      const requestDigest = hash({ requestedAt, action: declaration.action, input: JSON.parse(inputJson) });
      const prior = this.#records.find((record) => record.scope.featureInstallationId === scope.featureInstallationId
        && same(record.owner, owner) && record.receipt.requestId === value.requestId);
      if (prior) {
        assertScope(prior, scope, owner);
        if (prior.requestDigest !== requestDigest) conflict("This request id already belongs to different input.");
        assertCurrent();
        return projection(prior);
      }
      const now = this.#now();
      if (now.getTime() - Date.parse(requestedAt) > limits.requestAgeMs || Date.parse(requestedAt) > now.getTime() + 60_000) invalid("This request is too old. Start a new request in the app.");
      const pending = this.#records.filter((record) => live(record.receipt.status));
      if (pending.filter((record) => record.scope.featureInstallationId === scope.featureInstallationId).length >= limits.pendingPerInstallation
        || pending.filter((record) => record.owner.browserId === owner.browserId).length >= limits.pendingPerBrowser) conflict("Finish or dismiss the existing app requests first.");
      const records = this.#records.filter((record) => live(record.receipt.status) || now.getTime() - Date.parse(record.receipt.updatedAt) <= limits.retentionMs);
      this.#cancelled = new Set([...this.#cancelled].filter((id) => records.some((record) => record.receipt.id === id)));
      if (records.length >= limits.records) conflict("The app action list is full. Try again later.");
      const record: ActionRecord = {
        receipt: { id: randomUUID(), requestId: value.requestId, action: declaration.action, title: declaration.name,
          status: "pending", createdAt: now.toISOString(), updatedAt: now.toISOString() },
        scope: structuredClone(scope), owner: structuredClone(owner), requestedAt, requestDigest,
        declaration: structuredClone(declaration), provenance: structuredClone(provenance), inputJson,
      };
      assertCurrent();
      await this.#save([...records, record]);
      assertCurrent();
      return projection(record);
    }));
  }

  async get(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, requestId: string, assertCurrent: () => void): Promise<BrowserAppActionResult> {
    return this.#read(scope, owner, assertCurrent, () => projection(this.#owned(scope, owner, requestId)));
  }

  async list(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, assertCurrent: () => void): Promise<BrowserAppActionReceipt[]> {
    return this.#read(scope, owner, assertCurrent, () => this.#records.filter((record) => same(record.scope, scope) && same(record.owner, owner))
      .slice().reverse().sort((a, b) => Number(live(b.receipt.status)) - Number(live(a.receipt.status)))
      .slice(0, 50).map((record) => structuredClone(record.receipt)));
  }

  /** Only the trusted browser parent exposes review and approval. Never pass these to the app frame. */
  async review(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, requestId: string, assertCurrent: () => void) {
    return this.#read(scope, owner, assertCurrent, () => {
      const record = this.#owned(scope, owner, requestId);
      return { ...projection(record), inputJson: record.inputJson, description: record.declaration.description, reviewDigest: reviewDigest(record) };
    });
  }

  async approve(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, requestId: string, expectedReviewDigest: string, assertCurrent: () => void): Promise<BrowserAppActionResult> {
    validateScope(scope); validateOwner(owner);
    return this.#run(() => this.#ports.withApp(scope, async ({ provenance }) => {
      await this.#expire();
      const record = this.#owned(scope, owner, requestId);
      assertCurrent();
      if (!same(record.provenance, provenance)) denied("This app's execution authority changed. Review a new request.");
      if (reviewDigest(record) !== expectedReviewDigest) denied("This action changed. Review it again.");
      if (record.receipt.status !== "pending") return projection(record);
      if (this.#records.some((item) => item.scope.featureInstallationId === scope.featureInstallationId && item.receipt.status === "running")) conflict("This app is already handling an action.");
      if (this.#records.filter((item) => item.receipt.status === "running").length >= limits.running) conflict("App actions are busy. Run this request again when one finishes.");
      const at = this.#now().toISOString();
      const accepted: ActionRecord = { ...record, receipt: { ...record.receipt, status: "running", approvedAt: at, updatedAt: at } };
      await this.#replace(accepted);
      const controller = new AbortController();
      const execution: RestrictedAppActionExecution = {
        invocationId: accepted.receipt.id, signal: controller.signal,
        assertCurrent: () => {
          if (this.#closed || this.#unavailable || controller.signal.aborted || this.#cancelled.has(accepted.receipt.id)) denied("This app action was stopped.");
          assertCurrent();
        },
      };
      // Do not hold either admission queue throughout worker execution.
      const settled = Promise.resolve().then(() => this.#execute(accepted, execution))
        .finally(() => { this.#active.delete(accepted.receipt.id); });
      this.#active.set(accepted.receipt.id, { owner: structuredClone(owner), controller, settled });
      return projection(accepted);
    }));
  }

  async cancel(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, requestId: string, assertCurrent: () => void): Promise<BrowserAppActionResult> {
    validateScope(scope); validateOwner(owner);
    // Fence immediately, before waiting for journal I/O. A sibling's request cannot cancel this run.
    const record = this.#owned(scope, owner, requestId);
    assertCurrent();
    this.#cancelled.add(record.receipt.id);
    this.#active.get(record.receipt.id)?.controller.abort();
    return this.#run(async () => {
      assertCurrent();
      const current = this.#owned(scope, owner, requestId);
      await this.#cancelRecord(current);
      return projection(this.#owned(scope, owner, requestId));
    });
  }

  /** Caller must synchronously fence the grant before awaiting cleanup. */
  async revoke(grantId?: string): Promise<void> {
    const affected = [...this.#active.values()].filter((run) => grantId === undefined || run.owner.grantId === grantId);
    for (const run of affected) run.controller.abort();
    await this.#serialize(async () => {
      for (const record of this.#records) if (grantId === undefined || record.owner.grantId === grantId) await this.#cancelRecord(record);
    });
    await Promise.all(affected.map((run) => run.settled));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const run of this.#active.values()) run.controller.abort();
    await this.#queue.catch(() => undefined);
    for (const run of this.#active.values()) run.controller.abort();
    await Promise.all([...this.#active.values()].map((run) => run.settled));
    await this.#queue.catch(() => undefined);
  }

  async #execute(record: ActionRecord, execution: RestrictedAppActionExecution): Promise<void> {
    let status: Status = "failed";
    let resultJson: string | undefined;
    try {
      execution.assertCurrent();
      const value = await this.#ports.invoke(record.scope, record.receipt.action, JSON.parse(record.inputJson), execution);
      execution.assertCurrent();
      resultJson = boundedJson(value, limits.resultBytes);
      validateRestrictedAppValue(record.declaration.resultSchema, JSON.parse(resultJson), "App action result");
      status = "succeeded";
    } catch {
      // A stopped or failed action may have completed earlier effects. Never claim rollback.
      status = execution.signal.aborted || this.#cancelled.has(record.receipt.id) ? "cancelled" : "failed";
      resultJson = undefined;
    }
    try {
      await this.#serialize(async () => {
        const current = this.#records.find((item) => item.receipt.id === record.receipt.id)!;
        if (current.receipt.cancellationRequested) { status = "cancelled"; resultJson = undefined; }
        await this.#replace({ ...current, receipt: { ...current.receipt, status, updatedAt: this.#now().toISOString() },
          ...(resultJson === undefined ? {} : { resultJson }) });
      });
    } catch {
      // Persistence failure disables this lane; startup sees accepted work as interrupted, never replays it.
      this.#unavailable = true;
    }
  }

  async #cancelRecord(record: ActionRecord): Promise<void> {
    if (!live(record.receipt.status)) return;
    this.#cancelled.add(record.receipt.id);
    this.#active.get(record.receipt.id)?.controller.abort();
    await this.#replace({ ...record, receipt: { ...record.receipt, updatedAt: this.#now().toISOString(),
      ...(record.receipt.status === "pending" ? { status: "cancelled" as const } : { cancellationRequested: true as const }) } });
  }

  #owned(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, requestId: string): ActionRecord {
    const record = this.#records.find((item) => item.receipt.requestId === requestId && same(item.owner, owner)
      && item.scope.featureInstallationId === scope.featureInstallationId);
    if (!record) denied("This app request is unavailable.");
    assertScope(record, scope, owner);
    return record;
  }

  async #read<T>(scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner, assertCurrent: () => void, read: () => T): Promise<T> {
    validateScope(scope); validateOwner(owner);
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#expire(); assertCurrent(); return read();
    }));
  }

  async #expire(): Promise<void> {
    const now = this.#now();
    const records = this.#records.map((record) => record.receipt.status === "pending" && now.getTime() - Date.parse(record.receipt.createdAt) > limits.requestAgeMs
      ? { ...record, receipt: { ...record.receipt, status: "expired" as const, updatedAt: now.toISOString() } } : record);
    if (records.some((record, index) => record !== this.#records[index])) await this.#save(records);
  }

  async #replace(record: ActionRecord): Promise<void> { await this.#save(this.#records.map((item) => item.receipt.id === record.receipt.id ? record : item)); }

  async #save(records: ActionRecord[]): Promise<void> {
    if (this.#unavailable) unavailable();
    const serialized = JSON.stringify({ schema, records });
    // Reserve escaped result JSON and terminal metadata before admitting any work.
    const reserved = records.filter((record) => live(record.receipt.status)).length * (2 * limits.resultBytes + 1024);
    if (Buffer.byteLength(serialized) + reserved > limits.fileBytes) conflict("The app action journal is full. Try again later.");
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.#path);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.#path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.#records = records;
    } catch {
      this.#unavailable = true;
      for (const run of this.#active.values()) run.controller.abort();
      unavailable();
    } finally { await rm(temp, { force: true }); }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      if (this.#unavailable || this.#closed) unavailable();
      return operation();
    });
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result;
    return result;
  }
}

function projection(record: ActionRecord): BrowserAppActionResult {
  return { ...structuredClone(record.receipt), ...(record.resultJson === undefined ? {} : { result: JSON.parse(record.resultJson) }) };
}
function reviewDigest(record: ActionRecord): string {
  return hash({ id: record.receipt.id, scope: record.scope, owner: record.owner, requestDigest: record.requestDigest,
    requestedAt: record.requestedAt, createdAt: record.receipt.createdAt, declaration: record.declaration, provenance: record.provenance, input: JSON.parse(record.inputJson) });
}
function requestKey(record: ActionRecord): string { return hash([record.scope.featureInstallationId, record.owner, record.receipt.requestId]); }
function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
function live(status: Status): boolean { return status === "pending" || status === "running"; }
function assertScope(record: ActionRecord, scope: RestrictedAppTaskScope, owner: BrowserAppActionOwner): void {
  if (!same(record.scope, scope) || !same(record.owner, owner)) denied("This request belongs to a different app revision, permission selection, or browser.");
}
function validateScope(value: unknown): asserts value is RestrictedAppTaskScope {
  exact(value, ["spaceId", "appId", "featureInstallationId", "digest", "authorityDigest"]);
  if (Object.values(value).some((item) => typeof item !== "string" || !item.length || item.length > 200)
    || !/^[a-f0-9]{64}$/.test(String(value.digest)) || !/^[a-f0-9]{64}$/.test(String(value.authorityDigest))) invalid("The app scope is invalid.");
}
function validateOwner(value: unknown): asserts value is BrowserAppActionOwner {
  exact(value, ["browserId", "grantId"]);
  if (Object.values(value).some((item) => typeof item !== "string" || !item.length || item.length > 200)) invalid("The browser identity is invalid.");
}
function boundedJson(value: unknown, maximum: number): string {
  try { const result = JSON.stringify(value); if (result !== undefined && Buffer.byteLength(result) <= maximum) return result; } catch {}
  invalid("The app value is invalid or exceeds its size limit.");
}
function validateInput(declaration: RestrictedAppToolDeclaration, json: string): void {
  try { validateRestrictedAppValue(declaration.inputSchema, JSON.parse(json), "App action input"); }
  catch { invalid("The app input does not match the declared action."); }
}
function date(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid("The app request date is invalid.");
  return value;
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) invalid("The app request has invalid fields.");
}
function invalid(message: string): never { throw new BrowserAppActionError("ACTION_INVALID", message); }
function denied(message: string): never { throw new BrowserAppActionError("ACTION_DENIED", message); }
function conflict(message: string): never { throw new BrowserAppActionError("ACTION_CONFLICT", message); }
function unavailable(): never { throw new BrowserAppActionError("ACTION_UNAVAILABLE", "App actions are unavailable because their local records could not be verified."); }

function parseRecord(value: unknown): ActionRecord {
  const optional = value && typeof value === "object" && Object.hasOwn(value, "resultJson") ? ["resultJson"] : [];
  exact(value, ["receipt", "scope", "owner", "requestedAt", "requestDigest", "declaration", "provenance", "inputJson", ...optional]);
  validateScope(value.scope); validateOwner(value.owner); date(value.requestedAt);
  exact(value.provenance, ["tenantId", "runtimeInstanceId", "runtimeInstanceKind", "dataNamespaceId", "principalId", "authority", "artifactDigest"]);
  parseTenantId(value.provenance.tenantId); parseRuntimeInstanceId(value.provenance.runtimeInstanceId);
  parseDataNamespaceId(value.provenance.dataNamespaceId); parsePrincipalId(value.provenance.principalId);
  parseAuthorityStamp(value.provenance.authority); parseAppPlatformArtifactDigest(value.provenance.artifactDigest);
  if (!["development", "app"].includes(String(value.provenance.runtimeInstanceKind)) || hash(value.provenance.authority) !== value.scope.authorityDigest) invalid("The app execution authority is invalid.");
  const receipt = value.receipt;
  const receiptOptional = ["approvedAt", "cancellationRequested"].filter((key) => receipt && typeof receipt === "object" && Object.hasOwn(receipt, key));
  exact(receipt, ["id", "requestId", "action", "title", "status", "createdAt", "updatedAt", ...receiptOptional]);
  if (typeof receipt.id !== "string" || !uuid.test(receipt.id) || typeof receipt.requestId !== "string" || !uuid.test(receipt.requestId)
    || !["pending", "running", "succeeded", "failed", "cancelled", "interrupted", "expired"].includes(String(receipt.status))) invalid("The app receipt is invalid.");
  date(receipt.createdAt); date(receipt.updatedAt);
  if (receipt.approvedAt !== undefined) date(receipt.approvedAt);
  if (["running", "succeeded", "failed", "interrupted"].includes(String(receipt.status)) && !receipt.approvedAt
    || ["pending", "expired"].includes(String(receipt.status)) && receipt.approvedAt
    || receipt.cancellationRequested !== undefined && (receipt.cancellationRequested !== true || !receipt.approvedAt)) invalid("The app approval receipt is invalid.");
  exact(value.declaration, ["name", "description", "action", "inputSchema", "resultSchema"]);
  if (typeof value.declaration.name !== "string" || value.declaration.name.length > 200 || !value.declaration.name.length
    || typeof value.declaration.description !== "string" || value.declaration.description.length > 4096
    || typeof value.declaration.action !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.declaration.action)
    || receipt.action !== value.declaration.action || receipt.title !== value.declaration.name) invalid("The app declaration is invalid.");
  if (typeof value.inputJson !== "string" || Buffer.byteLength(value.inputJson) > limits.inputBytes) invalid("The app input is invalid.");
  const declaration = value.declaration as unknown as RestrictedAppToolDeclaration;
  validateInput(declaration, value.inputJson);
  if (value.requestDigest !== hash({ requestedAt: value.requestedAt, action: declaration.action, input: JSON.parse(value.inputJson) })) invalid("The app request input changed.");
  if (receipt.status === "succeeded") {
    if (typeof value.resultJson !== "string" || Buffer.byteLength(value.resultJson) > limits.resultBytes) invalid("The app result is invalid.");
    validateRestrictedAppValue(declaration.resultSchema, JSON.parse(value.resultJson), "App action result");
  } else if (value.resultJson !== undefined) invalid("An unfinished app action cannot have a result.");
  return structuredClone(value) as unknown as ActionRecord;
}
