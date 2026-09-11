import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { restrictedAppAssistantLimits as limits, type RestrictedAppAssistantModelRef, type RestrictedAppAssistantTask, type RestrictedAppAssistantUsage, type RestrictedAppResultFile, type RestrictedAppTaskDetail, type RestrictedAppTaskResult } from "../../shared/restricted-app-tasks.js";
import { parseRestrictedAppJsonSchema, validateRestrictedAppValue, type RestrictedAppAssistantAction, type RestrictedAppJsonSchema } from "./restricted-app-manifest.js";
import type { WorkFoldDurableTurnRecord, WorkFoldDurableTurnUsage } from "./turn-store.js";

export interface RestrictedAppTaskScope {
  spaceId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  authorityDigest: string;
}

/**
 * Who may see a task. The app bridge sees only its own revision and authority
 * ("revision"); the trusted Apps tab sees every task of the installation
 * across code changes ("installation") so a task started before a change can
 * still be opened and stopped.
 */
export type RestrictedAppTaskOwnership = "revision" | "installation";

export interface RestrictedAppTaskReceipt extends RestrictedAppAssistantTask {
  scope: RestrictedAppTaskScope;
  requestedAt: string;
  requestDigest: string;
  instructions: string;
  inputJson: string;
  conversationId: string;
  startedAt: string;
  cancellationRequested?: true;
  /**
   * The output shape the action declared when this request was made (F29). It
   * is pinned on the receipt, not read back from the manifest, so a code change
   * mid-task cannot change what the request asked for — and so the reporting
   * verb can read the declared shape off the request record.
   */
  outputSchema?: RestrictedAppJsonSchema;
}

/**
 * One installation's tasks moved. Emitted with `changed` so a host can turn
 * owned-id activity into a bounded `bridge.tasks.onChanged` hint without
 * re-reading the journal (docs/collaboration-contract.md, F30).
 */
export interface RestrictedAppAssistantActivity {
  spaceId: string;
  appId: string;
  featureInstallationId: string;
  taskIds: string[];
  receiptIds: string[];
}

export interface RestrictedAppTaskPorts {
  /**
   * Must serialize admission against installation/grant changes and recheck
   * every pin. `app` carries the installed app's own title, which is the
   * provenance the dispatched Chat is told — a receipt's `title` is the
   * per-request action label, not the app's name.
   */
  withApp<T>(
    scope: RestrictedAppTaskScope,
    operation: (actions: readonly RestrictedAppAssistantAction[], app: { title: string }) => Promise<T>,
  ): Promise<T>;
  /** Ordinary Space Chat acceptance, using the receipt's fixed Chat/request identities. */
  dispatch(receipt: Readonly<RestrictedAppTaskReceipt>, app: { title: string }): Promise<void>;
  findTurn(receipt: Readonly<RestrictedAppTaskReceipt>): WorkFoldDurableTurnRecord | null;
  cancelTurn(receipt: Readonly<RestrictedAppTaskReceipt>, turnId: string): Promise<void>;
  /**
   * The result envelope the Space Assistant filed for this task with `chat
   * report`, or null when the turn finished without filing one. The report
   * store stays the authority; nothing here is replayed. Optional so a host
   * that has no report store yet falls back to the final reply as the summary.
   */
  findReport?(receipt: Readonly<RestrictedAppTaskReceipt>): Promise<RestrictedAppTaskResult | null>;
}

export class RestrictedAppTaskError extends Error {
  constructor(readonly code: "TASK_DENIED" | "TASK_INVALID" | "TASK_CONFLICT" | "TASK_UNAVAILABLE", message: string) { super(message); }
}

const schema = "work-fold.app-assistant-tasks.v3";
const priorSchema = "work-fold.app-assistant-tasks.v2";
const legacySchema = "work-fold.app-assistant-tasks.v1";
const acceptedSchemas = [schema, priorSchema, legacySchema];
const outcomes: RestrictedAppTaskResult["outcome"][] = ["succeeded", "partial", "failed"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const statuses: RestrictedAppAssistantTask["status"][] = ["dispatching", "running", "succeeded", "failed", "cancelled", "interrupted"];
const live = new Set<RestrictedAppAssistantTask["status"]>(["dispatching", "running"]);
const maxFileBytes = 64 * 1024 * 1024;
const limitsSection = "Settings → The fold → Limits";

/**
 * An app request is journaled, then dispatched as an ordinary full-trust Space
 * Chat immediately; the journal is attribution and recovery, not a gate. This
 * broker constrains request/result ownership and envelope bounds, never Pi's
 * native tools.
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
      if (!acceptedSchemas.includes(data.schema) || !Array.isArray(data.records) || data.records.length > limits.records) {
        throw new Error("App Assistant request journal is invalid.");
      }
      const loadedAt = service.#now().toISOString();
      service.#records = data.records.map((record: unknown) => parseReceipt(
        data.schema === legacySchema ? upgradeV2Receipt(upgradeLegacyReceipt(record, loadedAt))
          : data.schema === priorSchema ? upgradeV2Receipt(record)
            : record,
      ));
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

  /** Journal first, then dispatch the Chat. A lost response replays the same record. */
  async request(scope: RestrictedAppTaskScope, value: unknown, assertCurrent = () => {}): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async (actions, app) => {
      exact(value, ["requestId", "requestedAt", "actionId", "input"]);
      if (typeof value.requestId !== "string" || !uuid.test(value.requestId)) invalid("Supply a unique request id.");
      const requestedAt = date(value.requestedAt);
      const action = actions.find((item) => item.id === value.actionId);
      if (!action) throw new RestrictedAppTaskError("TASK_DENIED", "Choose a declared Assistant action.");
      const raw = JSON.stringify(value.input);
      if (raw === undefined || Buffer.byteLength(raw) > limits.inputBytes) {
        invalid(`Assistant request input is larger than ${limits.inputBytes / 1024} KiB, the limit in ${limitsSection}.`);
      }
      let inputJson: string;
      try {
        // Validate the JSON value delivered across the bridge, without prototypes or toJSON methods.
        const input = JSON.parse(raw);
        validateRestrictedAppValue(action.inputSchema, input, "Assistant request input");
        inputJson = canonicalJson(input);
      } catch { invalid("Assistant request input does not match its declaration."); }
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
      const running = this.#records.filter((item) => item.scope.featureInstallationId === scope.featureInstallationId && live.has(item.status)).length;
      if (running >= limits.runningPerInstallation) {
        conflict(`This app already has ${limits.runningPerInstallation} Assistant requests running, the limit in ${limitsSection}. Wait for one to finish.`);
      }
      // Retired request timestamps cannot be submitted again, even after pruning.
      const records = this.#records.filter((item) => live.has(item.status)
        || now.getTime() - Date.parse(item.updatedAt) <= limits.receiptRetentionMs);
      if (records.length >= limits.records) conflict("The Assistant request list is full. Try again later.");
      const id = randomUUID();
      const at = now.toISOString();
      let record: RestrictedAppTaskReceipt = { id, requestId: value.requestId, actionId: action.id, title: action.title,
        status: "dispatching", createdAt: at, updatedAt: at, startedAt: at, requestedAt, requestDigest,
        scope: structuredClone(scope), instructions: action.instructions, inputJson, conversationId: `chat-app-${id}`,
        ...(action.outputSchema ? { outputSchema: structuredClone(action.outputSchema) } : {}) };
      assertCurrent();
      await this.#save([...records, record]); // Journal the receipt before ordinary Chat admission.
      try { await this.#ports.dispatch(structuredClone(record), { title: app.title }); }
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
      return projection(this.#owned(scope, value.requestId));
    }));
  }

  async list(scope: RestrictedAppTaskScope, ownership: RestrictedAppTaskOwnership = "revision"): Promise<RestrictedAppAssistantTask[]> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      return this.#records.filter((item) => matches(item.scope, scope, ownership)).reverse()
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

  /** Trusted Apps tab only. Never expose through a restricted app bridge. */
  async detail(scope: RestrictedAppTaskScope, requestId: string, ownership: RestrictedAppTaskOwnership = "revision"): Promise<RestrictedAppTaskDetail> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      const record = this.#owned(scope, requestId, ownership);
      return { task: projection(record), instructions: record.instructions, inputJson: record.inputJson, conversationId: record.conversationId };
    }));
  }

  async cancel(scope: RestrictedAppTaskScope, requestId: string, assertCurrent = () => {}, ownership: RestrictedAppTaskOwnership = "revision"): Promise<RestrictedAppAssistantTask> {
    return this.#run(() => this.#ports.withApp(scope, async () => {
      await this.#refresh();
      let record = this.#owned(scope, requestId, ownership);
      assertCurrent();
      if (live.has(record.status)) {
        const turn = this.#turn(record);
        if (turn) {
          record = { ...record, cancellationRequested: true, updatedAt: this.#now().toISOString() };
          await this.#replace(record);
          await this.#ports.cancelTurn(structuredClone(record), turn.turnId);
          await this.#refresh();
        }
      }
      return projection(this.#owned(scope, requestId, ownership));
    }));
  }

  async flush(): Promise<void> { await this.#queue.catch(() => undefined); }

  #owned(scope: RestrictedAppTaskScope, requestId: string, ownership: RestrictedAppTaskOwnership = "revision"): RestrictedAppTaskReceipt {
    const record = this.#records.find((item) => item.requestId === requestId && matches(item.scope, scope, ownership));
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
    const current = this.#records;
    const next: RestrictedAppTaskReceipt[] = [];
    for (const record of current) {
      if (!live.has(record.status)) { next.push(record); continue; }
      const turn = this.#turn(record);
      const status = !turn ? "interrupted" : turn.status === "accepted" || turn.status === "running" ? "running"
        : turn.status === "aborted" ? "cancelled" : turn.status;
      const result = status === "succeeded" && turn ? await this.#resolveResult(record, turn) : undefined;
      // The settled turn journal owns the effective model and its usage; the
      // receipt copies them so the Apps tab and the app read the same numbers,
      // including for a turn that failed or was stopped after spending them.
      const spent = turn?.usage ? turnSpend(turn.usage) : undefined;
      if (status === record.status && JSON.stringify(result) === JSON.stringify(record.result)
        && JSON.stringify(spent?.model) === JSON.stringify(record.model)
        && JSON.stringify(spent?.usage) === JSON.stringify(record.usage)) { next.push(record); continue; }
      next.push({ ...record, status, updatedAt: at, ...(result ? { result } : {}), ...(spent ?? {}) });
    }
    // The read above can await, so the journal is only rewritten when nothing
    // else replaced it while this pass ran.
    if (this.#records !== current) return;
    if (next.some((item, index) => item !== current[index])) await this.#save(next);
  }

  /**
   * The one result shape (F29) for a settled turn. A filed report is the
   * Assistant's own account of the work: its summary, its outcome, the details
   * matching the shape the action declared, and the deliverables it chose. With
   * no report the final reply is the summary and nothing else is exposed —
   * `fileChanges` turn metadata stays evidence and never becomes `files`.
   */
  async #resolveResult(record: RestrictedAppTaskReceipt, turn: WorkFoldDurableTurnRecord): Promise<RestrictedAppTaskResult> {
    const report = await this.#ports.findReport?.(structuredClone(record)).catch(() => null) ?? null;
    if (!report) return withinResultCeiling({ ...boundedSummary(turn.assistantText), outcome: "succeeded" });
    let outcome: RestrictedAppTaskResult["outcome"] = outcomes.includes(report.outcome) ? report.outcome : "failed";
    let summaryText = typeof report.summary === "string" && report.summary.length ? report.summary : turn.assistantText;
    let data: unknown;
    if (report.data !== undefined) {
      // Validated twice: once by the reporting verb against the shape on this
      // request record, and again here, so a report that got past the first
      // check can never surface to an app as matching details.
      const accepted = record.outputSchema ? acceptedResultData(record.outputSchema, report.data) : null;
      if (accepted) data = accepted.value;
      else {
        outcome = "failed";
        summaryText = `${record.outputSchema
          ? `The reported details did not match the ${record.outputSchema.type} shape this action declared, so they were left out.`
          : "This action declared no shape for reported details, so they were left out."}\n\n${summaryText}`;
      }
    }
    const files = Array.isArray(report.files)
      ? report.files.filter(isResultFile).slice(0, limits.resultFiles).map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }))
      : [];
    return withinResultCeiling({
      ...boundedSummary(summaryText),
      outcome,
      ...(data === undefined ? {} : { data }),
      ...(files.length ? { files } : {}),
    });
  }

  async #replace(record: RestrictedAppTaskReceipt): Promise<void> {
    await this.#save(this.#records.map((item) => item.id === record.id ? record : item));
  }

  async #save(records: RestrictedAppTaskReceipt[]): Promise<void> {
    const serialized = JSON.stringify({ schema, records });
    if (Buffer.byteLength(serialized) > maxFileBytes) conflict("The Assistant request journal is full. Try again later.");
    const activity = taskActivity(this.#records, records);
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
    // Emitted only after the durable rename, and only with ids: a listener
    // turns this into a bounded hint, never into content. Listeners that take
    // no argument keep working unchanged.
    this.emit("changed", { tasks: activity });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#unavailable) return Promise.reject(new RestrictedAppTaskError("TASK_UNAVAILABLE", "Assistant requests are unavailable because their local record could not be verified."));
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result;
    return result;
  }
}

export function restrictedAppTaskTurnRequestId(record: Pick<RestrictedAppTaskReceipt, "id">): string { return `app-task-${record.id}`; }

/**
 * Stable, fully inspectable content; no arbitrary Chat, fold context or tool
 * policy injection. `record.title` is the action's own label (for example
 * "Compare quotes"); `appTitle` is the installed app's name, and the
 * provenance sentence must use that one. Without a resolved app title the
 * sentence says only that an app asked, rather than naming the wrong thing.
 */
export function restrictedAppTaskPrompt(
  record: Pick<RestrictedAppTaskReceipt, "title" | "instructions" | "inputJson" | "outputSchema">,
  appTitle?: string,
): string {
  const from = appTitle?.trim()
    ? `This request came from the app “${appTitle.trim()}” installed in this Space.`
    : "This request came from an app installed in this Space.";
  const details = record.outputSchema
    ? `\n\nThe app asked for details in this shape (JSON Schema):\n${JSON.stringify(record.outputSchema)}`
    : "";
  return `App request: ${record.title}\n\n${record.instructions}\n\nApp-supplied input (JSON):\n${record.inputJson}${details}\n\n${from} Work in this Space using your usual tools. Report the result with \`work-fold chat report\`: a short summary, ${record.outputSchema ? "details in the shape above, " : ""}and the Space-relative files you want the app to receive. If you do not report, your final reply becomes the summary, so include only the task's result and relevant Space-relative deliverable paths.`;
}

export function restrictedAppTaskAuthorityDigest(authority: unknown): string { return hash(authority); }

function projection(record: RestrictedAppTaskReceipt): RestrictedAppAssistantTask {
  return { id: record.id, requestId: record.requestId, actionId: record.actionId, title: record.title,
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, startedAt: record.startedAt,
    ...(record.cancellationRequested ? { cancellationRequested: true as const } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}),
    ...(record.model ? { model: { ...record.model } } : {}),
    ...(record.usage ? { usage: { ...record.usage } } : {}) };
}

/**
 * The turn journal's usage, in the shape both app AI lanes publish: a provider
 * and model id, token counts, and a cost only when one was actually reported.
 * Missing pricing stays missing rather than becoming a zero charge.
 */
function turnSpend(usage: WorkFoldDurableTurnUsage): { model: RestrictedAppAssistantModelRef; usage: RestrictedAppAssistantUsage } {
  return {
    model: { provider: usage.provider, id: usage.modelId },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.amountUsd === undefined ? {} : { amountUsd: usage.amountUsd }),
    },
  };
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
function matches(recorded: RestrictedAppTaskScope, scope: RestrictedAppTaskScope, ownership: RestrictedAppTaskOwnership): boolean {
  if (ownership === "revision") return sameScope(recorded, scope);
  return recorded.spaceId === scope.spaceId && recorded.appId === scope.appId && recorded.featureInstallationId === scope.featureInstallationId;
}
function assertScope(a: RestrictedAppTaskScope, b: RestrictedAppTaskScope): void {
  if (!sameScope(a, b)) throw new RestrictedAppTaskError("TASK_DENIED", "This request belongs to a different app revision or permission selection.");
}
function boundedText(text: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximum) return { text, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** F29's summary bound, applied on a UTF-8 boundary so the text stays readable. */
function boundedSummary(text: string): { summary: string; truncated: boolean } {
  const bounded = boundedText(text, limits.summaryBytes);
  return { summary: bounded.text, truncated: bounded.truncated };
}

/**
 * The whole envelope has its own ceiling. Details go first because the app can
 * ask for them again, then deliverables, then the summary — the one field an
 * app always has. `truncated` says the app is holding the trimmed version; the
 * Apps tab names the bound and where to raise it.
 */
function withinResultCeiling(envelope: RestrictedAppTaskResult): RestrictedAppTaskResult {
  let summary = envelope.summary;
  let truncated = envelope.truncated;
  let data = envelope.data;
  const files = envelope.files ? [...envelope.files] : [];
  const build = (): RestrictedAppTaskResult => ({
    summary,
    truncated,
    outcome: envelope.outcome,
    ...(data === undefined ? {} : { data }),
    ...(files.length ? { files } : {}),
  });
  const size = () => Buffer.byteLength(JSON.stringify(build()) ?? "", "utf8");
  if (size() <= limits.resultBytes) return build();
  if (data !== undefined) { data = undefined; truncated = true; }
  while (size() > limits.resultBytes && files.length) { files.pop(); truncated = true; }
  for (let attempt = 0; attempt < 8 && size() > limits.resultBytes; attempt += 1) {
    const overflow = size() - limits.resultBytes;
    const target = Math.max(0, Buffer.byteLength(summary, "utf8") - overflow - 16);
    summary = target ? boundedText(summary, target).text : "";
    truncated = true;
  }
  return build();
}

/**
 * Re-serialized before validation so a value carrying prototypes or `toJSON`
 * cannot pass a check and then deliver something else across the bridge.
 */
function acceptedResultData(schema: RestrictedAppJsonSchema, value: unknown): { value: unknown } | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.dataBytes) return null;
    const plain = JSON.parse(serialized) as unknown;
    validateRestrictedAppValue(schema, plain, "Assistant result details");
    return { value: plain };
  } catch { return null; }
}

function isResultFile(value: unknown): value is RestrictedAppResultFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => key !== "path" && key !== "sha256" && key !== "sizeBytes")) return false;
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
  if (typeof file.sizeBytes !== "number" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) return false;
  return typeof file.path === "string" && isSpaceRelativeDeliverablePath(file.path);
}

/**
 * The same endpoint rule the file broker and the reporting verb enforce: no
 * absolute path, no traversal, and never work-fold, Pi, or legacy product
 * metadata.
 */
function isSpaceRelativeDeliverablePath(path: string): boolean {
  if (!path.length || path.length > 1024) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const segments = path.split(/[\\/]+/u);
  if (segments.some((segment) => !segment.length || segment === "." || segment === "..")) return false;
  return !segments.some((segment) => {
    const value = segment.toLocaleLowerCase("en-US");
    return value === ".work-fold" || value === ".workspace" || value === ".pi";
  });
}

/**
 * Which installations' tasks moved between two journal states. Presence and
 * `updatedAt` are the whole comparison: a receipt whose fields never changed
 * cannot have produced anything for an app to re-read.
 */
function taskActivity(
  before: readonly RestrictedAppTaskReceipt[],
  after: readonly RestrictedAppTaskReceipt[],
): RestrictedAppAssistantActivity[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  const changes = new Map<string, RestrictedAppAssistantActivity>();
  for (const record of after) {
    const prior = previous.get(record.id);
    if (prior && prior.updatedAt === record.updatedAt && prior.status === record.status) continue;
    const key = `${record.scope.spaceId} ${record.scope.appId} ${record.scope.featureInstallationId}`;
    const change = changes.get(key) ?? {
      spaceId: record.scope.spaceId,
      appId: record.scope.appId,
      featureInstallationId: record.scope.featureInstallationId,
      taskIds: [],
      receiptIds: [],
    };
    change.taskIds.push(record.id);
    changes.set(key, change);
  }
  return [...changes.values()];
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

/** A v1 journal's inert or expired requests were never dispatched; they load as stopped. */
function upgradeLegacyReceipt(value: unknown, loadedAt: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { approvedAt, ...rest } = value as Record<string, unknown>;
  const retired = rest.status === "pending" || rest.status === "expired";
  return {
    ...rest,
    ...(retired ? { status: "cancelled", updatedAt: loadedAt } : {}),
    startedAt: typeof approvedAt === "string" ? approvedAt : rest.createdAt,
  };
}

/**
 * A v2 journal recorded a settled reply as `{ text, truncated }`. It becomes
 * the one result shape with the reply as the summary; a settled turn that the
 * app already saw stays a success.
 */
function upgradeV2Receipt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== "object" || Array.isArray(result) || !("text" in result)) return record;
  const legacy = result as { text?: unknown; truncated?: unknown };
  return {
    ...record,
    result: { summary: legacy.text, truncated: legacy.truncated, outcome: "succeeded" },
  };
}

function parseReceipt(value: unknown): RestrictedAppTaskReceipt {
  if (!value || typeof value !== "object") invalid("The Assistant request journal is invalid.");
  const optional = ["result", "cancellationRequested", "model", "usage", "outputSchema"].filter((key) => Object.hasOwn(value, key));
  exact(value, ["id", "requestId", "actionId", "title", "status", "createdAt", "updatedAt", "startedAt", "scope", "requestedAt", "requestDigest", "instructions", "inputJson", "conversationId", ...optional]);
  exact(value.scope, ["spaceId", "appId", "featureInstallationId", "digest", "authorityDigest"]);
  if (typeof value.id !== "string" || typeof value.requestId !== "string" || !uuid.test(value.id) || !uuid.test(value.requestId) || value.conversationId !== `chat-app-${value.id}`
    || !statuses.includes(value.status)
    || typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.actionId)
    || typeof value.title !== "string" || !value.title.length || value.title.length > 80
    || typeof value.instructions !== "string" || !value.instructions.length || value.instructions.length > limits.instructions
    || typeof value.inputJson !== "string" || Buffer.byteLength(value.inputJson) > limits.inputBytes
    || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || Object.values(value.scope).some((item) => typeof item !== "string" || !item.length || item.length > 200)
    || !/^[a-f0-9]{64}$/.test(value.scope.digest) || !/^[a-f0-9]{64}$/.test(value.scope.authorityDigest)) invalid("The Assistant request journal is invalid.");
  for (const key of ["createdAt", "updatedAt", "startedAt", "requestedAt"]) date(value[key]);
  if (value.requestDigest !== hash({ actionId: value.actionId, requestedAt: value.requestedAt, inputJson: value.inputJson })) invalid("The Assistant request journal input changed.");
  JSON.parse(value.inputJson);
  if (value.cancellationRequested !== undefined && value.cancellationRequested !== true) invalid("The Assistant cancellation receipt is invalid.");
  if (value.outputSchema !== undefined) {
    try { value.outputSchema = parseRestrictedAppJsonSchema(value.outputSchema, "The Assistant result shape"); }
    catch { invalid("The Assistant request result shape is invalid."); }
  }
  if (value.result !== undefined) {
    const optionalResult = ["data", "files"].filter((key) => Object.hasOwn(value.result, key));
    exact(value.result, ["summary", "truncated", "outcome", ...optionalResult]);
    if (value.status !== "succeeded" || typeof value.result.summary !== "string"
      || Buffer.byteLength(value.result.summary) > limits.summaryBytes
      || typeof value.result.truncated !== "boolean"
      || !outcomes.includes(value.result.outcome)) invalid("The Assistant result is invalid.");
    if (Object.hasOwn(value.result, "data")) {
      const serialized = JSON.stringify(value.result.data);
      if (serialized === undefined || Buffer.byteLength(serialized) > limits.dataBytes) invalid("The Assistant result details are invalid.");
      // Details survive a restart only while the shape the request declared
      // still accepts them; anything else is dropped rather than delivered.
      if (!value.outputSchema || !acceptedResultData(value.outputSchema, value.result.data)) invalid("The Assistant result details are invalid.");
    }
    if (Object.hasOwn(value.result, "files")) {
      if (!Array.isArray(value.result.files) || value.result.files.length > limits.resultFiles
        || !value.result.files.every((file: unknown) => isResultFile(file))) invalid("The Assistant result files are invalid.");
    }
    if (Buffer.byteLength(JSON.stringify(value.result) ?? "") > limits.resultBytes) invalid("The Assistant result is invalid.");
  }
  if (value.status === "succeeded" && !value.result) invalid("The Assistant result is missing.");
  if (value.model !== undefined) {
    exact(value.model, ["provider", "id"]);
    if (Object.values(value.model).some((item) => typeof item !== "string" || !item.length || item.length > 200)) invalid("The Assistant usage receipt is invalid.");
  }
  if (value.usage !== undefined) {
    exact(value.usage, ["inputTokens", "outputTokens", ...(Object.hasOwn(value.usage, "amountUsd") ? ["amountUsd"] : [])]);
    if ([value.usage.inputTokens, value.usage.outputTokens, ...(Object.hasOwn(value.usage, "amountUsd") ? [value.usage.amountUsd] : [])]
      .some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) invalid("The Assistant usage receipt is invalid.");
  }
  return structuredClone(value) as RestrictedAppTaskReceipt;
}
