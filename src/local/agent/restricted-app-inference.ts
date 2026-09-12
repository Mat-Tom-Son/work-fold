/**
 * The bounded-inference lane for Space apps (docs/receipts-not-gates.md, F22):
 * an installed app's view or worker calls `assistant.infer`, the host parses
 * and bounds the request, pins the exact installation before and after the
 * model call, and appends a receipt line carrying the effective model and its
 * usage. Nothing here waits on a person; the receipt is the disclosure.
 *
 * The transport itself is `bounded-inference.ts` running on the owning Space's
 * configured session. This module owns everything around it: request shape,
 * byte bounds, the concurrency limiter, identity pins, and the journal.
 *
 * The limiter is deliberately not the Check reviewer's serial chain. Check
 * runs serialize machine-wide so a run cannot fan provider calls out; an app
 * is granted four concurrent calls per installation, which a serial queue
 * cannot honour. Both lanes bound their own total budget instead.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  restrictedAppInferenceLimits as limits,
  type RestrictedAppInferenceErrorCode,
  type RestrictedAppInferenceReceipt,
  type RestrictedAppInferenceResult,
} from "../../shared/restricted-app-inference.js";
import type { BoundedInferenceOutcome, BoundedInferenceRequest } from "./bounded-inference.js";
import { BoundedInferenceError } from "./bounded-inference.js";
import { parseRestrictedAppJsonSchema, type RestrictedAppJsonSchema } from "./restricted-app-manifest.js";
import { RestrictedAppTaskError, type RestrictedAppTaskScope } from "./restricted-app-tasks.js";

/** The same installation, revision, and authority pin an Assistant request carries. */
export type RestrictedAppInferenceScope = RestrictedAppTaskScope;

/** Where the call came from; viewers and remote app views never reach this lane. */
export type RestrictedAppInferenceSurface = "view" | "worker";

/** Which receipts a reader may see: the calling revision, or the whole installation for the Apps tab. */
export type RestrictedAppInferenceOwnership = "revision" | "installation";

export class RestrictedAppInferenceError extends Error {
  constructor(readonly code: RestrictedAppInferenceErrorCode, message: string) {
    super(message);
    this.name = "RestrictedAppInferenceError";
  }
}

export interface RestrictedAppInferencePorts {
  /**
   * Rechecks installation, revision, and authority. Held only for the check,
   * never across the model call, so inference cannot block a grant change.
   */
  pin(scope: RestrictedAppInferenceScope): Promise<void>;
  /** The owning Space's bounded transport; the server hands over its per-Space client. */
  infer(spaceId: string, request: BoundedInferenceRequest): Promise<BoundedInferenceOutcome>;
}

export interface RestrictedAppInferenceParsedRequest {
  instructions: string;
  input: string;
  inputBytes: number;
  outputSchema?: RestrictedAppJsonSchema;
  maxOutputBytes: number;
}

const limitsSection = "Settings → General → Limits";
const maxJournalBytes = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const surfaces: RestrictedAppInferenceSurface[] = ["view", "worker"];
const outcomes: RestrictedAppInferenceReceipt["outcome"][] = ["accepted", "ok", "error"];
const errorCodes: RestrictedAppInferenceErrorCode[] = [
  "INFER_INVALID",
  "INFER_INPUT_TOO_LARGE",
  "INFER_MODEL_UNAVAILABLE",
  "INFER_BUSY",
  "INFER_OUTPUT_TOO_LARGE",
  "INFER_OUTPUT_INVALID",
  "INFER_INTERRUPTED",
  "INFER_FAILED",
  "INFER_UNAVAILABLE",
];
/** Only line breaks and tabs; anything else would be invisible instruction text. */
const disallowedControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The published record is frozen at its exact values, which types every bound
 * as a literal. A host or a test may run different numbers, so both the
 * resolved set and the overrides speak plain numbers.
 */
export type RestrictedAppInferenceLimitOverrides = { [K in keyof typeof limits]?: number };
type ResolvedInferenceLimits = { [K in keyof typeof limits]: number };

type LimiterLimits = Pick<
  ResolvedInferenceLimits,
  "runningPerInstallation" | "waitingPerInstallation" | "runningMachineWide"
>;

interface LimiterWaiter {
  key: string;
  start: () => void;
  fail: (error: RestrictedAppInferenceError) => void;
}

/**
 * Four running and twelve waiting per installation, eight running machine-wide.
 * A call that cannot even queue is refused immediately with both numbers, so an
 * app can back off instead of discovering the bound by timing out.
 */
export class RestrictedAppInferenceLimiter {
  readonly #limits: LimiterLimits;
  readonly #running = new Map<string, number>();
  readonly #waiting: LimiterWaiter[] = [];
  #runningTotal = 0;

  constructor(overrides: Partial<LimiterLimits> = {}) {
    this.#limits = {
      runningPerInstallation: overrides.runningPerInstallation ?? limits.runningPerInstallation,
      waitingPerInstallation: overrides.waitingPerInstallation ?? limits.waitingPerInstallation,
      runningMachineWide: overrides.runningMachineWide ?? limits.runningMachineWide,
    };
  }

  snapshot(key: string): { running: number; waiting: number } {
    return { running: this.#running.get(key) ?? 0, waiting: this.#waiting.filter((item) => item.key === key).length };
  }

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw interrupted();
    if (this.#canStart(key)) return this.#occupy(key);
    const { waiting } = this.snapshot(key);
    if (waiting >= this.#limits.waitingPerInstallation) {
      throw new RestrictedAppInferenceError(
        "INFER_BUSY",
        `This app already has ${this.#limits.runningPerInstallation} inference calls running and `
        + `${this.#limits.waitingPerInstallation} waiting, the limit in ${limitsSection}. Try again when one finishes.`,
      );
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: LimiterWaiter = {
        key,
        start: () => {
          signal.removeEventListener("abort", onAbort);
          resolve(this.#occupy(key));
        },
        fail: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        waiter.fail(interrupted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  #canStart(key: string): boolean {
    return (this.#running.get(key) ?? 0) < this.#limits.runningPerInstallation
      && this.#runningTotal < this.#limits.runningMachineWide;
  }

  #occupy(key: string): () => void {
    this.#running.set(key, (this.#running.get(key) ?? 0) + 1);
    this.#runningTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#running.get(key) ?? 1) - 1;
      if (next > 0) this.#running.set(key, next);
      else this.#running.delete(key);
      this.#runningTotal -= 1;
      this.#pump();
    };
  }

  /** Roughly FIFO: the oldest waiter whose installation has room starts first. */
  #pump(): void {
    for (let index = 0; index < this.#waiting.length;) {
      const waiter = this.#waiting[index]!;
      if (this.#runningTotal >= this.#limits.runningMachineWide) return;
      if (!this.#canStart(waiter.key)) {
        index += 1;
        continue;
      }
      this.#waiting.splice(index, 1);
      waiter.start();
    }
  }
}

/**
 * Parses one `assistant.infer` argument into the transport's shape. Every
 * refusal names the bound it hit, so an app can shrink its request instead of
 * guessing.
 */
export function parseRestrictedAppInferenceRequest(value: unknown): RestrictedAppInferenceParsedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Inference request fields are invalid.");
  const request = value as Record<string, unknown>;
  const allowed = ["instructions", "input", "outputSchema", "maxOutputBytes"];
  if (Object.keys(request).some((key) => !allowed.includes(key))) invalid("Inference request fields are invalid.");
  if (!Object.hasOwn(request, "instructions") || !Object.hasOwn(request, "input")) {
    invalid("Provide instructions and input for the inference call.");
  }
  const instructions = request.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) invalid("Inference instructions must be text.");
  if (disallowedControlCharacters.test(instructions)) invalid("Inference instructions contain unsupported control characters.");
  if (Buffer.byteLength(instructions, "utf8") > limits.instructionsBytes) {
    invalid(`Inference instructions exceed the ${limits.instructionsBytes}-byte limit in ${limitsSection}.`);
  }
  let input: string;
  if (typeof request.input === "string") input = request.input;
  else {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(request.input, null, 2);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) invalid("Inference input must be text or a JSON value.");
    input = serialized;
  }
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > limits.inputBytes) {
    throw new RestrictedAppInferenceError(
      "INFER_INPUT_TOO_LARGE",
      `Inference input exceeds the ${limits.inputBytes}-byte limit in ${limitsSection}. `
      + "Send less, or write the data as Space files and summarize.",
    );
  }
  let outputSchema: RestrictedAppJsonSchema | undefined;
  if (request.outputSchema !== undefined) {
    try {
      outputSchema = parseRestrictedAppJsonSchema(request.outputSchema, "Inference output schema");
    } catch (error) {
      invalid(error instanceof Error && error.message ? error.message : "The inference output schema is invalid.");
    }
    if (Buffer.byteLength(JSON.stringify(outputSchema), "utf8") > limits.schemaBytes) {
      invalid(`The inference output schema exceeds the ${limits.schemaBytes}-byte limit in ${limitsSection}.`);
    }
  }
  let maxOutputBytes = limits.defaultOutputBytes;
  if (request.maxOutputBytes !== undefined) {
    const requested = request.maxOutputBytes;
    if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > limits.maxOutputBytes) {
      invalid(`maxOutputBytes must be a whole number from 1 through ${limits.maxOutputBytes}, the limit in ${limitsSection}.`);
    }
    maxOutputBytes = requested as number;
  }
  return { instructions, input, inputBytes, ...(outputSchema ? { outputSchema } : {}), maxOutputBytes };
}

export interface RestrictedAppInferenceServiceOptions {
  path: string;
  ports: RestrictedAppInferencePorts;
  now?: () => Date;
  limits?: RestrictedAppInferenceLimitOverrides;
}

/**
 * One receipt line landed. Emitted with `changed` so a host can turn owned-id
 * activity into a bounded `bridge.tasks.onChanged` hint without reading the
 * journal (docs/collaboration-contract.md, F30).
 */
export interface RestrictedAppInferenceActivity {
  receipt: { id: string; spaceId: string; appId: string; featureInstallationId: string };
  terminal: boolean;
}

/**
 * Runs bounded calls and journals them. Attribution damage never disables the
 * lane: an unreadable journal is moved aside and a fresh one starts, because a
 * lost record is a lost record, not a reason to stop an app from working.
 */
export class RestrictedAppInferenceService extends EventEmitter {
  readonly #path: string;
  readonly #ports: RestrictedAppInferencePorts;
  readonly #now: () => Date;
  readonly #limits: ResolvedInferenceLimits;
  readonly #limiter: RestrictedAppInferenceLimiter;
  readonly #active = new Set<string>();
  #receipts: RestrictedAppInferenceReceipt[] = [];
  #journal: Promise<unknown> = Promise.resolve();
  #bytes = 0;

  private constructor(options: RestrictedAppInferenceServiceOptions) {
    super();
    this.#path = options.path;
    this.#ports = options.ports;
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...limits, ...options.limits };
    this.#limiter = new RestrictedAppInferenceLimiter(this.#limits);
  }

  static async create(options: RestrictedAppInferenceServiceOptions): Promise<RestrictedAppInferenceService> {
    const service = new RestrictedAppInferenceService(options);
    await mkdir(dirname(options.path), { recursive: true });
    await service.#load();
    return service;
  }

  /** Current occupancy for one installation; the Apps tab and tests read it. */
  occupancy(featureInstallationId: string): { running: number; waiting: number } {
    return this.#limiter.snapshot(featureInstallationId);
  }

  async infer(
    scope: RestrictedAppInferenceScope,
    surface: RestrictedAppInferenceSurface,
    value: unknown,
    options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
  ): Promise<RestrictedAppInferenceResult> {
    const assertCurrent = options.assertCurrent ?? (() => {});
    const request = parseRestrictedAppInferenceRequest(value);
    await this.#pin(scope);
    assertCurrent();
    const controller = new AbortController();
    const forward = () => controller.abort();
    options.signal?.addEventListener("abort", forward, { once: true });
    if (options.signal?.aborted) controller.abort();
    const deadline = this.#now().getTime() + this.#limits.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.#limits.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const startedAt = this.#now().getTime();
    let release: (() => void) | undefined;
    let id: string | undefined;
    let activeKey: string | undefined;
    try {
      release = await this.#limiter.acquire(scope.featureInstallationId, controller.signal);
      // Journal first, like every other effect: a call work-fold cannot record
      // does not run, and `id` means an accepted line landed.
      const receiptId = randomUUID();
      activeKey = inferenceReceiptKey({ ...scope, id: receiptId });
      this.#active.add(activeKey);
      try {
        await this.#append({
          v: 1,
          id: receiptId,
          at: this.#now().toISOString(),
          spaceId: scope.spaceId,
          appId: scope.appId,
          featureInstallationId: scope.featureInstallationId,
          digest: scope.digest,
          surface,
          outcome: "accepted",
          inputBytes: request.inputBytes,
          schema: Boolean(request.outputSchema),
        });
      } catch {
        throw new RestrictedAppInferenceError("INFER_UNAVAILABLE", "work-fold could not record this inference call, so it did not run.");
      }
      id = receiptId;
      const remaining = deadline - this.#now().getTime();
      if (remaining <= 0) throw interrupted();
      const outcome = await this.#ports.infer(scope.spaceId, {
        instructions: request.instructions,
        input: request.input,
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        maxOutputBytes: request.maxOutputBytes,
        timeoutMs: remaining,
        signal: controller.signal,
      });
      // Deliver only to the same installation, revision, and authority that asked.
      await this.#pin(scope);
      assertCurrent();
      const usage = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };
      const result: RestrictedAppInferenceResult = outcome.kind === "text"
        ? { text: outcome.text, truncated: outcome.truncated, receiptId: id, model: outcome.model, usage }
        : { json: outcome.json, receiptId: id, model: outcome.model, usage };
      await this.#append({
        v: 1,
        id,
        at: this.#now().toISOString(),
        spaceId: scope.spaceId,
        appId: scope.appId,
        featureInstallationId: scope.featureInstallationId,
        digest: scope.digest,
        surface,
        outcome: "ok",
        inputBytes: request.inputBytes,
        outputBytes: Buffer.byteLength(outcome.kind === "text" ? outcome.text : JSON.stringify(outcome.json), "utf8"),
        schema: Boolean(request.outputSchema),
        model: outcome.model,
        usage: outcome.usage,
        durationMs: this.#now().getTime() - startedAt,
      });
      return result;
    } catch (error) {
      const failure = toInferenceError(error);
      if (id) {
        await this.#append({
          v: 1,
          id,
          at: this.#now().toISOString(),
          spaceId: scope.spaceId,
          appId: scope.appId,
          featureInstallationId: scope.featureInstallationId,
          digest: scope.digest,
          surface,
          outcome: "error",
          errorCode: failure.code,
          inputBytes: request.inputBytes,
          schema: Boolean(request.outputSchema),
          durationMs: this.#now().getTime() - startedAt,
        }).catch(() => undefined);
      }
      throw failure;
    } finally {
      if (activeKey) this.#active.delete(activeKey);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forward);
      release?.();
    }
  }

  /** One current row per call, newest first. The bridge never reads this list. */
  async list(
    scope: RestrictedAppInferenceScope,
    options: { ownership?: RestrictedAppInferenceOwnership; limit?: number } = {},
  ): Promise<RestrictedAppInferenceReceipt[]> {
    await this.#pin(scope);
    const ownership = options.ownership ?? "revision";
    const limit = Math.min(options.limit ?? this.#limits.listItems, this.#limits.listItems);
    return latestInferenceReceipts(this.#receipts
      .filter((receipt) => receipt.spaceId === scope.spaceId
        && receipt.appId === scope.appId
        && receipt.featureInstallationId === scope.featureInstallationId
        && (ownership === "installation" || receipt.digest === scope.digest)))
      .slice(0, limit)
      .map((receipt) => structuredClone(receipt.outcome === "accepted" && !this.#active.has(inferenceReceiptKey(receipt))
        ? { ...receipt, outcome: "error" as const, errorCode: "INFER_INTERRUPTED" as const }
        : receipt));
  }

  async flush(): Promise<void> {
    await this.#journal.catch(() => undefined);
  }

  async #pin(scope: RestrictedAppInferenceScope): Promise<void> {
    try {
      await this.#ports.pin(scope);
    } catch (error) {
      if (error instanceof RestrictedAppInferenceError) throw error;
      throw new RestrictedAppInferenceError(
        "INFER_UNAVAILABLE",
        error instanceof RestrictedAppTaskError && error.message
          ? error.message
          : "This app's permissions changed. Open the app again.",
      );
    }
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      const info = await stat(this.#path);
      if (!info.isFile()) throw new Error("The inference journal is not a file.");
      const handle = await open(this.#path, "r");
      try {
        const bytes = Buffer.alloc(info.size);
        await handle.read(bytes, 0, bytes.length, 0);
        text = bytes.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.#quarantine();
      return;
    }
    try {
      this.#receipts = text
        .split("\n")
        .filter((line) => line.trim().length)
        .map((line) => parseInferenceReceipt(JSON.parse(line)))
        .slice(-this.#limits.receipts);
      this.#bytes = Buffer.byteLength(text, "utf8");
    } catch {
      await this.#quarantine();
    }
    // No provider call survives this host. Keep the acceptance as audit evidence
    // and append an interruption, without guessing whether the provider finished
    // or making another call. Later launches see the terminal row and do nothing.
    for (const receipt of latestInferenceReceipts(this.#receipts).filter((item) => item.outcome === "accepted")) {
      await this.#append({ ...receipt, at: this.#now().toISOString(), outcome: "error", errorCode: "INFER_INTERRUPTED" })
        .catch(() => undefined);
    }
  }

  async #quarantine(): Promise<void> {
    const moved = `${this.#path}.damaged-${this.#now().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.#path, moved);
      console.warn(`work-fold could not read the app inference receipts; the file was kept at ${moved}.`);
    } catch {
      await rm(this.#path, { force: true }).catch(() => undefined);
    }
    this.#receipts = [];
    this.#bytes = 0;
  }

  async #append(receipt: RestrictedAppInferenceReceipt): Promise<void> {
    const line = `${JSON.stringify(receipt)}\n`;
    const write = this.#journal.catch(() => undefined).then(async () => {
      await appendFile(this.#path, line, { mode: 0o600 });
      // Readers and rotation see only written events, in journal order.
      this.#receipts.push(structuredClone(receipt));
      if (this.#receipts.length > this.#limits.receipts) this.#receipts.splice(0, this.#receipts.length - this.#limits.receipts);
      this.#bytes += Buffer.byteLength(line, "utf8");
      if (this.#bytes > maxJournalBytes) await this.#rotate();
    });
    this.#journal = write;
    await write;
    // Ids only, after the line is durable. `terminal` marks the lines an app
    // can act on: an `accepted` line is a half-fact, and a hint for it would
    // make a view re-read twice for one call.
    this.emit("changed", {
      receipt: {
        id: receipt.id,
        spaceId: receipt.spaceId,
        appId: receipt.appId,
        featureInstallationId: receipt.featureInstallationId,
      },
      terminal: receipt.outcome === "ok" || receipt.outcome === "error",
    } satisfies RestrictedAppInferenceActivity);
  }

  /** Keeps the newest half so the file cannot grow without bound. */
  async #rotate(): Promise<void> {
    const kept = this.#receipts.slice(Math.floor(this.#receipts.length / 2));
    const text = kept.map((receipt) => `${JSON.stringify(receipt)}\n`).join("");
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#path);
      this.#receipts = kept;
      this.#bytes = Buffer.byteLength(text, "utf8");
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** Journal order wins even if the clock changes. Preserve every ownership pin. */
function latestInferenceReceipts(receipts: RestrictedAppInferenceReceipt[]): RestrictedAppInferenceReceipt[] {
  const seen = new Set<string>();
  const current: RestrictedAppInferenceReceipt[] = [];
  for (let index = receipts.length - 1; index >= 0; index--) {
    const receipt = receipts[index]!;
    const key = inferenceReceiptKey(receipt);
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(receipt);
  }
  return current;
}

function inferenceReceiptKey(receipt: Pick<RestrictedAppInferenceReceipt, "spaceId" | "appId" | "featureInstallationId" | "digest" | "id">): string {
  return JSON.stringify([receipt.spaceId, receipt.appId, receipt.featureInstallationId, receipt.digest, receipt.id]);
}

function toInferenceError(error: unknown): RestrictedAppInferenceError {
  if (error instanceof RestrictedAppInferenceError) return error;
  if (error instanceof BoundedInferenceError) return new RestrictedAppInferenceError(error.code, error.message);
  if (error instanceof RestrictedAppTaskError) {
    return new RestrictedAppInferenceError("INFER_UNAVAILABLE", error.message);
  }
  // Never let provider or transport text reach an app.
  return new RestrictedAppInferenceError(
    "INFER_FAILED",
    "The model call did not complete. Check the Space's provider connection in Settings → Agents, then try again.",
  );
}

function interrupted(): RestrictedAppInferenceError {
  return new RestrictedAppInferenceError("INFER_INTERRUPTED", "The inference call was interrupted before it finished.");
}

function invalid(message: string): never {
  throw new RestrictedAppInferenceError("INFER_INVALID", message);
}

function parseInferenceReceipt(value: unknown): RestrictedAppInferenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An inference receipt is invalid.");
  const receipt = value as Record<string, unknown>;
  const required = ["v", "id", "at", "spaceId", "appId", "featureInstallationId", "digest", "surface", "outcome", "inputBytes", "schema"];
  const optional = ["errorCode", "outputBytes", "model", "usage", "durationMs"];
  if (required.some((key) => !Object.hasOwn(receipt, key))
    || Object.keys(receipt).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("An inference receipt has invalid fields.");
  }
  if (receipt.v !== 1
    || typeof receipt.id !== "string" || !uuid.test(receipt.id)
    || typeof receipt.at !== "string" || new Date(receipt.at).toISOString() !== receipt.at
    || typeof receipt.spaceId !== "string" || !receipt.spaceId
    || typeof receipt.appId !== "string" || !receipt.appId
    || typeof receipt.featureInstallationId !== "string" || !receipt.featureInstallationId
    || typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)
    || !surfaces.includes(receipt.surface as RestrictedAppInferenceSurface)
    || !outcomes.includes(receipt.outcome as RestrictedAppInferenceReceipt["outcome"])
    || !Number.isSafeInteger(receipt.inputBytes) || (receipt.inputBytes as number) < 0
    || typeof receipt.schema !== "boolean") {
    throw new Error("An inference receipt is invalid.");
  }
  if (receipt.errorCode !== undefined && !errorCodes.includes(receipt.errorCode as RestrictedAppInferenceErrorCode)) {
    throw new Error("An inference receipt error code is invalid.");
  }
  if (receipt.outputBytes !== undefined && (!Number.isSafeInteger(receipt.outputBytes) || (receipt.outputBytes as number) < 0)) {
    throw new Error("An inference receipt output size is invalid.");
  }
  if (receipt.durationMs !== undefined && (!Number.isSafeInteger(receipt.durationMs) || (receipt.durationMs as number) < 0)) {
    throw new Error("An inference receipt duration is invalid.");
  }
  if (receipt.model !== undefined) {
    const model = receipt.model as Record<string, unknown>;
    if (!model || typeof model !== "object" || typeof model.provider !== "string" || typeof model.id !== "string"
      || Object.keys(model).some((key) => key !== "provider" && key !== "id")) {
      throw new Error("An inference receipt model is invalid.");
    }
  }
  if (receipt.usage !== undefined) {
    const usage = receipt.usage as Record<string, unknown>;
    if (!usage || typeof usage !== "object"
      || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)
      || Object.keys(usage).some((key) => key !== "inputTokens" && key !== "outputTokens" && key !== "amountUsd")) {
      throw new Error("An inference receipt usage record is invalid.");
    }
  }
  return structuredClone(receipt) as unknown as RestrictedAppInferenceReceipt;
}
