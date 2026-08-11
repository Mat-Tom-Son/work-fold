import type {
  WorkFoldAutomationRunOutcome,
  WorkFoldAutomationRunReason,
} from "../agent/work-fold-automation-service.js";
import type { WorkFoldCheckRunState } from "../checks/check-types.js";

const defaultMaxListeners = 8;
const defaultMaxListenerErrors = 500;
const maxListenerErrorLength = 300;

/**
 * Lineage stamped on a settle record when a routing hop caused the settled
 * run. Trigger evaluation drops these records, which is what makes routing
 * chains structurally impossible rather than merely bounded.
 */
export interface WorkFoldRoutingHopLineage {
  kind: "routing-hop";
  routingId: string;
  routingRunId: string;
  hopId: string;
}

export type WorkFoldSettleLineage = WorkFoldRoutingHopLineage;

/** Terminal Check-run states; a settle record never carries pending work. */
export type WorkFoldCheckRunSettleState = Exclude<WorkFoldCheckRunState, "accepted" | "running">;

/**
 * A named Space's Check run reached a durable terminal state. Published by the
 * Check service's terminal-persistence funnel only after the exact terminal
 * run record is durable; startup `interrupted` reconciliation is recorded by
 * the store before any listener exists and is deliberately never published.
 */
export interface WorkFoldCheckRunSettleRecord {
  kind: "check-run";
  spaceId: string;
  runId: string;
  taskId: string;
  checkIds: string[];
  state: WorkFoldCheckRunSettleState;
  startedAt: string;
  endedAt: string;
  lineage?: WorkFoldSettleLineage;
}

/**
 * A named Space's restricted-app named-automation run settled and its
 * digest-scoped run receipt is durable. Results that produced no durable
 * receipt (for example an app uninstalled mid-run) are never published, and a
 * replayed result that deduplicated against the historical receipt ledger is
 * never published twice.
 */
export interface WorkFoldAppAutomationRunSettleRecord {
  kind: "app-automation-run";
  spaceId: string;
  appId: string;
  automationId: string;
  runId: string;
  outcome: WorkFoldAutomationRunOutcome;
  reason: WorkFoldAutomationRunReason;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  lineage?: WorkFoldSettleLineage;
}

export type WorkFoldSettleRecord = WorkFoldCheckRunSettleRecord | WorkFoldAppAutomationRunSettleRecord;

export type WorkFoldSettleListener = (record: WorkFoldSettleRecord) => void | Promise<void>;

export interface WorkFoldSettleListenerError {
  recordKind: WorkFoldSettleRecord["kind"];
  runId: string;
  occurredAt: string;
  error: string;
}

export interface WorkFoldSettleSignalOptions {
  now?: () => Date;
  maxListeners?: number;
  maxListenerErrors?: number;
}

/**
 * The one narrow in-process seam between the two admitted settlement funnels
 * — the Check service's terminal-persistence funnel and the restricted-app
 * automation result funnel — and the routing service that consumes them.
 *
 * Publishers call `publish` only after the settlement fact is durable, so a
 * listener observes nothing that a crash could un-record. `publish` is
 * fire-and-forget and never throws: a listener error is captured in a bounded
 * diagnostic history instead of failing the owning service's run or receipt.
 * Listeners are invoked synchronously in subscription order with their own
 * copies, so delivery order matches persistence order at each funnel and no
 * listener can mutate what another sees. Settles are in-process facts:
 * nothing here is persisted, queued across restarts, or reachable from any
 * external channel.
 */
export class WorkFoldSettleSignal {
  readonly #now: () => Date;
  readonly #maxListeners: number;
  readonly #maxListenerErrors: number;
  readonly #listeners = new Set<WorkFoldSettleListener>();
  readonly #listenerErrors: WorkFoldSettleListenerError[] = [];

  constructor(options: WorkFoldSettleSignalOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#maxListeners = positiveInteger(options.maxListeners ?? defaultMaxListeners, "Settle listener capacity");
    this.#maxListenerErrors = positiveInteger(
      options.maxListenerErrors ?? defaultMaxListenerErrors,
      "Settle listener error history size",
    );
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Registers a listener and returns its idempotent unsubscribe. */
  subscribe(listener: WorkFoldSettleListener): () => void {
    if (this.#listeners.has(listener)) throw new Error("Settle listener is already subscribed.");
    if (this.#listeners.size >= this.#maxListeners) {
      throw new Error("Settle signal listener capacity exhausted; a listener is leaking subscriptions.");
    }
    this.#listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#listeners.delete(listener);
    };
  }

  /** Fire-and-forget delivery to every listener; never throws. */
  publish(record: WorkFoldSettleRecord): void {
    for (const listener of [...this.#listeners]) {
      try {
        void Promise.resolve(listener(structuredClone(record)))
          .catch((error: unknown) => this.#recordListenerError(record, error));
      } catch (error) {
        this.#recordListenerError(record, error);
      }
    }
  }

  listListenerErrors(): WorkFoldSettleListenerError[] {
    return this.#listenerErrors.map((error) => ({ ...error }));
  }

  #recordListenerError(record: WorkFoldSettleRecord, error: unknown): void {
    this.#listenerErrors.push({
      recordKind: record.kind,
      runId: record.runId,
      occurredAt: this.#now().toISOString(),
      error: boundedError(error),
    });
    const overflow = this.#listenerErrors.length - this.#maxListenerErrors;
    if (overflow > 0) this.#listenerErrors.splice(0, overflow);
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Settle listener failed.");
  return message.length > maxListenerErrorLength ? `${message.slice(0, maxListenerErrorLength - 1)}…` : message;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
