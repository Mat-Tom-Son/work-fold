import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { restrictedAppAssistantLimits as limits, type RestrictedAppAssistantTask, type RestrictedAppTaskReview } from "../../shared/restricted-app-tasks.js";
import { validateRestrictedAppValue, type RestrictedAppAssistantAction } from "./restricted-app-manifest.js";
import type { WorkFoldDurableTurnRecord } from "./turn-store.js";

export interface RestrictedAppTaskScope {
  spaceId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  authorityDigest: string;
}

export interface RestrictedAppTaskReceipt extends RestrictedAppAssistantTask {
  scope: RestrictedAppTaskScope;
  requestedAt: string;
  requestDigest: string;
  instructions: string;
  inputJson: string;
  conversationId: string;
  approvedAt?: string;
  cancellationRequested?: true;
}

export interface RestrictedAppTaskPorts {
  /** Must serialize admission against installation/grant changes and recheck every pin. */
  withApp<T>(scope: RestrictedAppTaskScope, operation: (actions: readonly RestrictedAppAssistantAction[]) => Promise<T>): Promise<T>;
  /** Ordinary Space Chat acceptance, using the receipt's fixed Chat/request identities. */
  dispatch(receipt: Readonly<RestrictedAppTaskReceipt>): Promise<void>;
  findTurn(receipt: Readonly<RestrictedAppTaskReceipt>): WorkFoldDurableTurnRecord | null;
  cancelTurn(receipt: Readonly<RestrictedAppTaskReceipt>, turnId: string): Promise<void>;
}

export class RestrictedAppTaskError extends Error {
  constructor(readonly code: "TASK_DENIED" | "TASK_INVALID" | "TASK_CONFLICT" | "TASK_UNAVAILABLE", message: string) { super(message); }
}

const schema = "work-fold.app-assistant-tasks.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const live = new Set<RestrictedAppAssistantTask["status"]>(["pending", "dispatching", "running"]);
const maxFileBytes = 64 * 1024 * 1024;

/**
 * An app can place an inert request in this journal. Only a trusted review
 * surface gets approve(). An approved request starts a normal full-trust Space
 * Chat; this broker constrains request/result ownership, not Pi's native tools.
 */
export class RestrictedAppTaskService extends EventEmitter {
  readonly #path: string;
  readonly #ports: RestrictedAppTaskPorts;
  readonly #now: () => Date;
  #records: RestrictedAppTaskReceipt[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #unavailable = false;

  private constructor(options: { path: string; ports: RestrictedAppTaskPorts; now?: () => Date }) {
    super();
    this.#path = options.path;
    this.#ports = options.ports;
    this.#now = options.now ?? (() => new Date());
  }

  static async create(options: { path: string; ports: RestrictedAppTaskPorts; now?: () => Date }): Promise<RestrictedAppTaskService> {
    const service = new RestrictedAppTaskService(options);
    await mkdir(dirname(options.path), { recursive: true });
    let handle;
    try {
      handle = await open(options.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxFileBytes) throw new Error("App Assistant request journal exceeds its limit.");
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error("App Assistant request journal changed while reading.");
      const data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      exact(data, ["schema", "records"]);
      if (data.schema !== schema || !Array.isArray(data.records) || data.records.length > limits.records) throw new Error("App Assistant request journal is invalid.");
      service.#records = data.records.map(parseReceipt);
      if (new Set(service.#records.map((item) => item.id)).size !== service.#records.length
        || new Set(service.#records.map((item) => `${item.scope.featureInstallationId}:${item.requestId}`)).size !== service.#records.length) {
        throw new Error("App Assistant request journal has duplicate identities.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") service.#unavailable = true;
    } finally { await handle?.close(); }
    // Reconcile with the durable turn journal; never redispatch after a crash.
    if (!service.#unavailable) {
      try { await service.#refresh(); } catch { service.#unavailable = true; }
    }
    return service;
  }

  async request(scope: RestrictedAppTaskScope, value: unknown, assertCurrent = () => {}): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async (actions) => {
      exact(value, ["requestId", "requestedAt", "actionId", "input"]);
      if (typeof value.requestId !== "string" || !uuid.test(value.requestId)) invalid("Supply a unique request id.");
      const requestedAt = date(value.requestedAt);
      const action = actions.find((item) => item.id === value.actionId);
      if (!action) throw new RestrictedAppTaskError("TASK_DENIED", "Choose a declared Assistant action.");
      let inputJson: string;
      try {
        const raw = JSON.stringify(value.input);
        if (raw === undefined || Buffer.byteLength(raw) > limits.inputBytes) invalid("Assistant request input is too large.");
        // Validate the JSON value delivered across the bridge, without prototypes or toJSON methods.
        const input = JSON.parse(raw);
        validateRestrictedAppValue(action.inputSchema, input, "Assistant request input");
        inputJson = canonicalJson(input);
      } catch { invalid("Assistant request input does not match its declaration or exceeds its limit."); }
      await this.#refresh();
      const requestDigest = hash({ actionId: action.id, requestedAt, inputJson });
      const prior = this.#records.find((item) => item.scope.featureInstallationId === scope.featureInstallationId && item.requestId === value.requestId);
      if (prior) {
        assertScope(prior.scope, scope);
        if (prior.requestDigest !== requestDigest) conflict("This request id already belongs to different input.");
        assertCurrent();
        return projection(prior);
      }
      const now = this.#now();
      if (now.getTime() - Date.parse(requestedAt) > limits.requestAgeMs || Date.parse(requestedAt) > now.getTime() + 60_000) {
        invalid("This request is too old. Start a new request in the app.");
      }
      if (this.#records.filter((item) => item.scope.featureInstallationId === scope.featureInstallationId && live.has(item.status)).length >= limits.pendingPerInstallation) {
        conflict("Finish or dismiss this app's existing Assistant requests first.");
      }
      // Expired request timestamps cannot be submitted again, even after pruning.
      const records = this.#records.filter((item) => live.has(item.status)
        || now.getTime() - Date.parse(item.updatedAt) <= limits.reviewAgeMs);
      if (records.length >= limits.records) conflict("The Assistant request list is full. Try again later.");
      const id = randomUUID();
      const record: RestrictedAppTaskReceipt = { id, requestId: value.requestId, actionId: action.id, title: action.title,
        status: "pending", createdAt: now.toISOString(), updatedAt: now.toISOString(), requestedAt, requestDigest,
        scope: structuredClone(scope), instructions: action.instructions, inputJson, conversationId: `chat-app-${id}` };
      assertCurrent();
      await this.#save([...records, record]);
      return projection(record);
    }));
  }

  async list(scope: RestrictedAppTaskScope): Promise<RestrictedAppAssistantTask[]> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      return this.#records.filter((item) => sameScope(item.scope, scope)).reverse()
        .sort((a, b) => Number(live.has(b.status)) - Number(live.has(a.status))).slice(0, limits.listItems)
        .map((item) => { const { result: _result, ...summary } = projection(item); return summary; });
    }));
  }

  async get(scope: RestrictedAppTaskScope, requestId: string): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      return projection(this.#owned(scope, requestId));
    }));
  }

  /** Trusted Apps review only. Never expose through a restricted app bridge. */
  async review(scope: RestrictedAppTaskScope, requestId: string): Promise<RestrictedAppTaskReview> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      const record = this.#owned(scope, requestId);
      return { task: projection(record), instructions: record.instructions, inputJson: record.inputJson,
        reviewDigest: reviewDigest(record), conversationId: record.approvedAt ? record.conversationId : null };
    }));
  }

  /** The review digest pins the exact app incarnation, authority, instructions and input. */
  async approve(scope: RestrictedAppTaskScope, requestId: string, expectedReviewDigest: string): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      let record = this.#owned(scope, requestId);
      if (reviewDigest(record) !== expectedReviewDigest) conflict("The Assistant request changed. Review it again.");
      // A lost approval response returns the first acceptance; it never creates a second turn.
      if (record.approvedAt) return projection(record);
      if (record.status !== "pending") conflict("This Assistant request is no longer waiting for review.");
      if (this.#records.some((item) => item.scope.featureInstallationId === scope.featureInstallationId
        && (item.status === "running" || item.status === "dispatching"))) conflict("This app already has an Assistant task running.");
      const at = this.#now().toISOString();
      record = { ...record, status: "dispatching", approvedAt: at, updatedAt: at };
      await this.#replace(record); // Journal the clicked decision before ordinary Chat admission.
      try { await this.#ports.dispatch(structuredClone(record)); }
      catch {
        // Admission can throw after its own durable acceptance. Reconcile first;
        // never convert an uncertain outcome into a fresh dispatch.
        const turn = this.#turn(record);
        if (!turn) {
          record = { ...record, status: "failed", updatedAt: this.#now().toISOString() };
          await this.#replace(record);
          return projection(record);
        }
      }
      await this.#refresh();
      return projection(this.#owned(scope, requestId));
    }));
  }

  async cancel(scope: RestrictedAppTaskScope, requestId: string, assertCurrent = () => {}): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      let record = this.#owned(scope, requestId);
      assertCurrent();
      if (record.status === "pending") {
        record = { ...record, status: "cancelled", updatedAt: this.#now().toISOString() };
        await this.#replace(record);
      } else if (record.status === "running") {
        const turn = this.#turn(record);
        if (turn) {
          record = { ...record, cancellationRequested: true, updatedAt: this.#now().toISOString() };
          await this.#replace(record);
          await this.#ports.cancelTurn(structuredClone(record), turn.turnId);
          await this.#refresh();
        }
      }
      return projection(this.#owned(scope, requestId));
    }));
  }

  async flush(): Promise<void> { await this.#queue.catch(() => undefined); }

  #owned(scope: RestrictedAppTaskScope, requestId: string): RestrictedAppTaskReceipt {
    const record = this.#records.find((item) => item.requestId === requestId && sameScope(item.scope, scope));
    if (!record) throw new RestrictedAppTaskError("TASK_DENIED", "This Assistant request is unavailable to this app revision.");
    return record;
  }

  #turn(record: RestrictedAppTaskReceipt): WorkFoldDurableTurnRecord | null {
    const turn = this.#ports.findTurn(record);
    if (turn && (turn.spaceId !== record.scope.spaceId || turn.conversationId !== record.conversationId
      || turn.requestId !== restrictedAppTaskTurnRequestId(record))) {
      throw new RestrictedAppTaskError("TASK_UNAVAILABLE", "The Assistant task outcome is unavailable.");
    }
    return turn;
  }

  async #refresh(): Promise<void> {
    const at = this.#now().toISOString();
    const next = this.#records.map((record): RestrictedAppTaskReceipt => {
      if (record.status === "pending" && Date.parse(at) - Date.parse(record.createdAt) > limits.reviewAgeMs) return { ...record, status: "expired", updatedAt: at };
      if (record.status !== "running" && record.status !== "dispatching") return record;
      const turn = this.#turn(record);
      const status = !turn ? "interrupted" : turn.status === "accepted" || turn.status === "running" ? "running"
        : turn.status === "aborted" ? "cancelled" : turn.status;
      const result = status === "succeeded" && turn ? boundedResult(turn.assistantText) : undefined;
      if (status === record.status && JSON.stringify(result) === JSON.stringify(record.result)) return record;
      return { ...record, status, updatedAt: at, ...(result ? { result } : {}) };
    });
    if (next.some((item, index) => item !== this.#records[index])) await this.#save(next);
  }

  async #replace(record: RestrictedAppTaskReceipt): Promise<void> {
    await this.#save(this.#records.map((item) => item.id === record.id ? record : item));
  }

  async #save(records: RestrictedAppTaskReceipt[]): Promise<void> {
    const serialized = JSON.stringify({ schema, records });
    if (Buffer.byteLength(serialized) > maxFileBytes) conflict("The Assistant request journal is full. Try again later.");
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      try { await handle.writeFile(serialized); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.#path);
      this.#records = records;
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.#path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temp, { force: true }); }
    this.emit("changed");
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#unavailable) return Promise.reject(new RestrictedAppTaskError("TASK_UNAVAILABLE", "Assistant requests are unavailable because their local record could not be verified."));
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result;
    return result;
  }
}

export function restrictedAppTaskTurnRequestId(record: Pick<RestrictedAppTaskReceipt, "id">): string { return `app-task-${record.id}`; }

/** Stable, fully reviewable content; no arbitrary Chat, fold context or tool policy injection. */
export function restrictedAppTaskPrompt(record: Pick<RestrictedAppTaskReceipt, "title" | "instructions" | "inputJson">): string {
  return `App task: ${record.title}\n\n${record.instructions}\n\nApp-supplied input (JSON):\n${record.inputJson}\n\nThe person approved this one request. Work in this Space using your usual tools. Your final reply will be shared with the requesting app; include only the task's result and relevant Space-relative deliverable paths.`;
}

export function restrictedAppTaskAuthorityDigest(authority: unknown): string { return hash(authority); }

function projection(record: RestrictedAppTaskReceipt): RestrictedAppAssistantTask {
  return { id: record.id, requestId: record.requestId, actionId: record.actionId, title: record.title,
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
    ...(record.cancellationRequested ? { cancellationRequested: true as const } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}) };
}
function reviewDigest(record: RestrictedAppTaskReceipt): string {
  return hash({ id: record.id, scope: record.scope, requestDigest: record.requestDigest, title: record.title, instructions: record.instructions, inputJson: record.inputJson });
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sameScope(a: RestrictedAppTaskScope, b: RestrictedAppTaskScope): boolean {
  return a.spaceId === b.spaceId && a.appId === b.appId && a.featureInstallationId === b.featureInstallationId && a.digest === b.digest && a.authorityDigest === b.authorityDigest;
}
function assertScope(a: RestrictedAppTaskScope, b: RestrictedAppTaskScope): void {
  if (!sameScope(a, b)) throw new RestrictedAppTaskError("TASK_DENIED", "This request belongs to a different app revision or permission selection.");
}
function boundedResult(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limits.resultBytes) return { text, truncated: false };
  let end = limits.resultBytes;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid("The Assistant request has invalid fields.");
}
function date(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid("The Assistant request date is invalid.");
  return value;
}
function invalid(message: string): never { throw new RestrictedAppTaskError("TASK_INVALID", message); }
function conflict(message: string): never { throw new RestrictedAppTaskError("TASK_CONFLICT", message); }

function parseReceipt(value: unknown): RestrictedAppTaskReceipt {
  if (!value || typeof value !== "object") invalid("The Assistant request journal is invalid.");
  const optional = ["result", "approvedAt", "cancellationRequested"].filter((key) => Object.hasOwn(value, key));
  exact(value, ["id", "requestId", "actionId", "title", "status", "createdAt", "updatedAt", "scope", "requestedAt", "requestDigest", "instructions", "inputJson", "conversationId", ...optional]);
  exact(value.scope, ["spaceId", "appId", "featureInstallationId", "digest", "authorityDigest"]);
  if (typeof value.id !== "string" || typeof value.requestId !== "string" || !uuid.test(value.id) || !uuid.test(value.requestId) || value.conversationId !== `chat-app-${value.id}`
    || !["pending", "dispatching", "running", "succeeded", "failed", "cancelled", "interrupted", "expired"].includes(value.status)
    || typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.actionId)
    || typeof value.title !== "string" || !value.title.length || value.title.length > 80
    || typeof value.instructions !== "string" || !value.instructions.length || value.instructions.length > limits.instructions
    || typeof value.inputJson !== "string" || Buffer.byteLength(value.inputJson) > limits.inputBytes
    || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || Object.values(value.scope).some((item) => typeof item !== "string" || !item.length || item.length > 200)
    || !/^[a-f0-9]{64}$/.test(value.scope.digest) || !/^[a-f0-9]{64}$/.test(value.scope.authorityDigest)) invalid("The Assistant request journal is invalid.");
  for (const key of ["createdAt", "updatedAt", "requestedAt", ...(Object.hasOwn(value, "approvedAt") ? ["approvedAt"] : [])]) date(value[key]);
  if ((value.status === "pending" || value.status === "expired") && Object.hasOwn(value, "approvedAt")) invalid("The pending Assistant request cannot already be approved.");
  if (value.requestDigest !== hash({ actionId: value.actionId, requestedAt: value.requestedAt, inputJson: value.inputJson })) invalid("The Assistant request journal input changed.");
  JSON.parse(value.inputJson);
  if (["dispatching", "running", "succeeded", "failed", "interrupted"].includes(value.status) && !value.approvedAt) invalid("The Assistant request lacks its review receipt.");
  if (value.cancellationRequested !== undefined && (value.cancellationRequested !== true || !value.approvedAt)) invalid("The Assistant cancellation receipt is invalid.");
  if (value.result !== undefined) {
    exact(value.result, ["text", "truncated"]);
    if (value.status !== "succeeded" || typeof value.result.text !== "string" || Buffer.byteLength(value.result.text) > limits.resultBytes || typeof value.result.truncated !== "boolean") invalid("The Assistant result is invalid.");
  }
  if (value.status === "succeeded" && !value.result) invalid("The Assistant result is missing.");
  return structuredClone(value) as RestrictedAppTaskReceipt;
}
