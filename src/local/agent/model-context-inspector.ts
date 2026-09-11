import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { workFoldModelContextLimits } from "../../shared/fold-limits.js";
import type {
  ModelContextFilter, ModelContextInspection, ModelContextInspectionLimits,
  ModelContextInspectionState, ModelContextInspectionSummary, ModelContextOwner,
  ModelContextSnapshot, ModelContextValue,
} from "../../shared/model-context-inspection.js";

type StreamFunction = AgentSession["agent"]["streamFn"];
type InspectionSession = { agent: { streamFn: StreamFunction } };
interface Capture {
  payload(value: unknown): void;
  response(): void;
  failed(): void;
}

/** Diagnostics are off by default, detached from Pi, and never persisted. */
export class ModelContextInspector {
  private enabled = false;
  private generation = 0;
  private readonly records = new Map<string, ModelContextInspection>();
  private readonly limits: ModelContextInspectionLimits;
  private readonly now: () => number;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: { limits?: Partial<ModelContextInspectionLimits>; now?: () => number } = {}) {
    this.limits = { ...workFoldModelContextLimits };
    for (const key of Object.keys(this.limits) as (keyof ModelContextInspectionLimits)[]) {
      const value = options.limits?.[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) this.limits[key] = value;
    }
    this.limits.recordBytes = Math.max(4096, this.limits.recordBytes);
    this.limits.totalBytes = Math.max(this.limits.recordBytes, this.limits.totalBytes);
    this.now = options.now ?? Date.now;
  }

  setEnabled(enabled: boolean): ModelContextInspectionState {
    this.enabled = enabled;
    if (!enabled) this.clear();
    return this.inspect();
  }

  clear(): ModelContextInspectionState {
    this.generation += 1;
    this.records.clear();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    return this.inspect();
  }

  inspect(filter?: ModelContextFilter): ModelContextInspectionState {
    return { enabled: this.enabled, records: this.list(filter), limits: { ...this.limits } };
  }

  list(filter?: ModelContextFilter): ModelContextInspectionSummary[] {
    this.prune();
    return [...this.records.values()].filter((record) => matches(record, filter)).reverse().map(summary);
  }

  get(id: string, filter?: ModelContextFilter): ModelContextInspection | undefined {
    this.prune();
    const record = this.records.get(id);
    return record && matches(record, filter) ? structuredClone(record) : undefined;
  }

  /** Used by the transport observer; nothing from options or auth enters here. */
  begin(owner: ModelContextOwner, model: unknown, context: unknown): Capture | undefined {
    if (!this.enabled) return undefined;
    this.prune();
    const generation = this.generation;
    const createdAt = this.now();
    const id = randomUUID();
    const record: ModelContextInspection = {
      id, owner: copyOwner(owner), provider: label(own(model, "provider")),
      model: label(own(model, "id")), api: label(own(model, "api")), createdAt,
      status: "captured", stage: "assembled", payloadSamples: 0, truncated: false, bytes: 0,
      assembled: this.snapshot(context), payloads: [],
    };
    this.records.set(id, record);
    this.refresh(record);
    return this.captureFor(id, generation);
  }

  private captureFor(id: string, generation: number): Capture {
    // Keep only identity in callbacks: eviction/clear releases snapshot memory
    // even while a provider retains its request callbacks indefinitely.
    const current = () => {
      this.prune();
      return this.enabled && this.generation === generation ? this.records.get(id) : undefined;
    };
    return {
      payload: (value) => {
        const record = current();
        if (!record) return;
        if (record.payloads.length >= this.limits.payloadSamples) {
          record.truncated = true;
          const last = record.payloads.at(-1);
          if (last && !last.omissions.includes("Additional provider payload samples omitted.")) {
            last.omissions.push("Additional provider payload samples omitted.");
            last.truncated = true;
          }
        } else {
          record.payloads.push(this.snapshot(value));
          record.payloadSamples = record.payloads.length;
          record.stage = "provider_payload";
        }
        this.refresh(record);
      },
      response: () => { const record = current(); if (record) { record.status = "response_received"; this.refresh(record); } },
      failed: () => { const record = current(); if (record) { record.status = "dispatch_error"; this.refresh(record); } },
    };
  }

  private snapshot(value: unknown): ModelContextSnapshot {
    // Reserve room for each possible stage and its metadata within one record.
    const budget = Math.max(128, Math.floor((this.limits.recordBytes - 2048) / (this.limits.payloadSamples + 1)) - 512);
    return captureValue(value, this.limits, budget, this.now());
  }

  private refresh(record: ModelContextInspection): void {
    record.truncated ||= record.assembled.truncated || record.payloads.some((item) => item.truncated);
    record.bytes = Buffer.byteLength(JSON.stringify(record));
    record.bytes = Buffer.byteLength(JSON.stringify(record));
    if (record.bytes > this.limits.recordBytes) this.records.delete(record.id);
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.limits.retentionMs;
    for (const [id, record] of this.records) if (record.createdAt <= cutoff) this.records.delete(id);
    let bytes = [...this.records.values()].reduce((total, item) => total + item.bytes, 0);
    for (const [id, record] of this.records) {
      if (this.records.size <= this.limits.records && bytes <= this.limits.totalBytes) break;
      this.records.delete(id);
      bytes -= record.bytes;
    }
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const oldest = this.records.values().next().value;
    if (this.enabled && oldest) {
      const delay = Math.max(1, Math.min(2_147_483_647, oldest.createdAt + this.limits.retentionMs - this.now()));
      this.expiryTimer = setTimeout(() => { this.expiryTimer = undefined; this.prune(); }, delay);
      this.expiryTimer.unref();
    }
  }
}

const installed = new WeakMap<object, { original: StreamFunction; wrapped: StreamFunction; inspector: ModelContextInspector; getOwner: () => ModelContextOwner }>();

/** Preserve native transport and hook semantics; observing never consumes a stream. */
export function installModelContextInspection(
  session: InspectionSession,
  inspector: ModelContextInspector,
  getOwner: () => ModelContextOwner,
): () => void {
  const previous = installed.get(session.agent);
  if (previous && session.agent.streamFn === previous.wrapped) {
    previous.inspector = inspector;
    previous.getOwner = getOwner;
    return () => uninstall(session, previous.wrapped);
  }
  const original = session.agent.streamFn;
  const binding = { original, wrapped: original, inspector, getOwner };
  const wrapped: StreamFunction = function (this: unknown, model, context, options) {
    const capture = safely(() => binding.inspector.begin(binding.getOwner(), model, context));
    if (!capture) return original.call(this, model, context, options);
    const priorPayload = options?.onPayload;
    const priorResponse = options?.onResponse;
    const nextOptions = {
      ...options,
      onPayload: async (payload: unknown, requestModel: typeof model) => {
        const replacement = await priorPayload?.call(options, payload, requestModel);
        safely(() => capture.payload(replacement === undefined ? payload : replacement));
        // Undefined means unchanged to Pi; preserve it rather than returning payload.
        return replacement;
      },
      onResponse: async (...args: Parameters<NonNullable<typeof priorResponse>>) => {
        await priorResponse?.call(options, ...args);
        safely(() => capture.response());
      },
    };
    try {
      const stream = original.call(this, model, context, nextOptions);
      // Preserve synchronous stream identity and never call/replace result().
      if (stream instanceof Promise) return stream.catch((error: unknown) => {
        safely(() => capture.failed());
        throw error;
      });
      return stream;
    } catch (error) {
      safely(() => capture.failed());
      throw error;
    }
  };
  binding.wrapped = wrapped;
  installed.set(session.agent, binding);
  session.agent.streamFn = wrapped;
  return () => uninstall(session, wrapped);
}

function uninstall(session: InspectionSession, wrapped: StreamFunction): void {
  const binding = installed.get(session.agent);
  if (binding?.wrapped !== wrapped) return;
  if (session.agent.streamFn === wrapped) session.agent.streamFn = binding.original;
  installed.delete(session.agent);
}

function safely<T>(operation: () => T): T | undefined {
  try { return operation(); } catch { return undefined; }
}

function matches(record: ModelContextInspection, filter?: ModelContextFilter): boolean {
  return (!filter?.spaceRoot || record.owner.spaceRoot === filter.spaceRoot)
    && (!filter?.conversationId || record.owner.conversationId === filter.conversationId);
}

function summary(record: ModelContextInspection): ModelContextInspectionSummary {
  const { assembled: _assembled, payloads: _payloads, ...rest } = record;
  return structuredClone(rest);
}

function label(value: unknown): string { return typeof value === "string" ? value.slice(0, 256) : "Unknown"; }

function copyOwner(owner: ModelContextOwner): ModelContextOwner {
  const taskId = own(owner, "taskId");
  const identity = (key: string): string => {
    const value = own(owner, key);
    if (typeof value !== "string" || !value || value.length > 4096) throw new Error("Invalid diagnostic owner identity.");
    return value;
  };
  return Object.freeze({ spaceRoot: identity("spaceRoot"), conversationId: identity("conversationId"),
    sessionId: identity("sessionId"), purpose: label(own(owner, "purpose")),
    ...(taskId !== undefined ? { taskId: identity("taskId") } : {}) });
}

/** Read data properties only. Native extension objects may contain getters or proxies. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function captureValue(value: unknown, limits: ModelContextInspectionLimits, byteBudget: number, capturedAt: number): ModelContextSnapshot {
  const omissions = new Set<string>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  let available = byteBudget;
  let digestRemaining = limits.digestBytes;
  const omit = (reason: string): string => { omissions.add(reason); return `[Omitted: ${reason}]`; };
  const charge = (result: ModelContextValue): ModelContextValue => {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > available) return omit("Snapshot byte limit reached.");
    available -= size;
    return result;
  };
  const image = (data: string, mimeType: string, offset = 0): ModelContextValue => {
    omissions.add("Image bytes replaced with metadata.");
    const length = data.length - offset;
    const digest = length <= digestRemaining ? createHash("sha256").update(data.slice(offset)).digest("hex") : undefined;
    if (digest) digestRemaining -= length;
    return charge({ omitted: "image bytes", mimeType: mimeType.slice(0, 96), encodedCharacters: length,
      ...(digest ? { sha256OfEncodedData: digest } : { digest: "omitted: size limit" }) });
  };
  const visit = (input: unknown, depth: number): ModelContextValue => {
    if (++nodes > limits.nodes) return omit("Snapshot node limit reached.");
    if (available < 96) return omit("Snapshot byte limit reached.");
    if (input === null || typeof input === "boolean") return charge(input);
    if (typeof input === "number") return charge(Number.isFinite(input) ? input : String(input));
    if (typeof input === "string") {
      const prefix = input.slice(0, 160);
      const dataImage = /^data:(image\/[a-z0-9.+-]+)(?:;|,)/i.exec(prefix);
      if (dataImage) {
        const comma = prefix.indexOf(",");
        return comma >= 0 ? image(input, dataImage[1]!, comma + 1)
          : charge(omit("Image data URL header exceeds inspection limit."));
      }
      // Limit before encoding: no full pass over arbitrarily large strings.
      const prefixText = input.slice(0, Math.min(limits.stringBytes, available));
      const encoded = Buffer.from(prefixText);
      const allowance = Math.max(0, Math.min(limits.stringBytes, available - 96));
      const clipped = encoded.subarray(0, allowance).toString("utf8");
      return charge(input.length > prefixText.length || encoded.length > allowance
        ? `${clipped}\n${omit("String limit reached; remaining text omitted.")}` : clipped);
    }
    if (typeof input !== "object") return charge(omit(`Unsupported ${typeof input} value.`));
    if (types.isProxy(input)) return charge(omit("Proxy object not inspected."));
    if (seen.has(input)) return charge(omit("Repeated or circular object."));
    if (depth >= limits.depth) return charge(omit("Snapshot depth limit reached."));
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return charge(omit("Binary data not inspected."));
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return charge(omit("Non-plain object not inspected."));
    seen.add(input);
    const data = own(input, "data");
    const mime = own(input, "mimeType") ?? own(input, "media_type");
    if (typeof data === "string" && (own(input, "type") === "image" || own(input, "type") === "base64" || typeof mime === "string" && mime.startsWith("image/"))) {
      return image(data, typeof mime === "string" ? mime : "image/unknown");
    }
    const result: ModelContextValue[] | { [key: string]: ModelContextValue } = Array.isArray(input) ? [] : Object.create(null);
    let incompleteArray = false;
    available -= 2;
    // for-in avoids creating an unbounded key array; inherited properties are ignored.
    for (const key in input) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) continue;
      if (nodes >= limits.nodes || available < 192) {
        omit(nodes >= limits.nodes ? "Snapshot node limit reached." : "Snapshot byte limit reached.");
        incompleteArray = true;
        break;
      }
      // Property names are identity too: truncating them can merge two fields
      // or remove a credential suffix before redaction. Omit the whole field.
      if (key.length > 256) {
        nodes += 1;
        omit("Object property name exceeds 256 characters; field omitted.");
        continue;
      }
      if (Array.isArray(result)) {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
          nodes += 1;
          omit("Named array property omitted.");
          continue;
        }
        if (index !== result.length) {
          omit("Sparse array remainder omitted to preserve indices.");
          incompleteArray = true;
          break;
        }
      }
      const keyBytes = Buffer.byteLength(JSON.stringify(key)) + 2;
      if (keyBytes + 96 > available) {
        omit("Snapshot byte limit reached.");
        incompleteArray = true;
        break;
      }
      available -= keyBytes;
      const item = !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ? charge(omit("Accessor property not evaluated."))
        : /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|cookie|private[_-]?key|^token$)/i.test(key)
          ? charge(omit("Credential-like field redacted."))
          : visit(descriptor.value, depth + 1);
      if (Array.isArray(result)) result.push(item); else result[key] = item;
    }
    if (Array.isArray(result) && !incompleteArray && result.length < (own(input, "length") as number)) {
      omit("Sparse array remainder omitted to preserve indices.");
    }
    return result;
  };
  const captured = visit(value, 0);
  return { capturedAt, value: captured, truncated: omissions.size > 0, omissions: [...omissions], bytes: Buffer.byteLength(JSON.stringify(captured)) };
}
