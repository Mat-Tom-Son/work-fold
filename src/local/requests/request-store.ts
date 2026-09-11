/**
 * The durable request graph (docs/collaboration-contract.md, F25).
 *
 * Every accepted Assistant turn belongs to exactly one machine-local request
 * record. A management turn creates a root; `chat send --parent-task` creates
 * a child under it; a Space turn with no parent is its own root. Records
 * survive restart, are reconciled against the turn journal, and are never
 * replayed. This store replaces the in-memory management request registry, so
 * it also carries the assignment text, the attachment references, and the
 * attributed action trail that `manage status` projects.
 *
 * Layout under `rootPath` (`requests/` beneath the state root in production):
 *
 *   requests.jsonl              append-only, whole-record, latest-wins by requestId
 *   requests.1.jsonl            the generation a compaction replaced
 *   questions.jsonl             append-only, whole-record, latest-wins by questionId
 *   questions.1.jsonl           the generation a compaction replaced
 *   results/<requestId>/<resultId>.json   one atomic file per result envelope
 *   settings.json               { version: 1, lastPurgeAt, continuationsEnabled }
 *
 * Why the split: a request record must stay small — ids, enums, counters — so
 * a whole-record append stays cheap, while one result envelope can reach 288
 * KB and a request may hold 64 of them. Questions get their own journal so an
 * answer rewrites one small record instead of the whole request. The rotated
 * generation is read only when the live journal is missing, which is exactly
 * the crash window in the middle of a compaction.
 *
 * Invariants:
 *
 * - The turn journal is the outcome authority. A request never overrides a
 *   turn's recorded status; it only aggregates.
 * - Records are never replayed. `reconcile` may settle a request; it can
 *   never dispatch a turn — this store has no way to start one. A request it
 *   settled at startup carries `reconciledAt`, so nothing continues it.
 * - A task id belongs to at most one request. Beginning or joining twice with
 *   the same task id returns the existing record and appends nothing, which
 *   matches the acceptance path's own replay handling.
 * - A terminal request never moves again except by an explicitly joined new
 *   turn or by retention.
 * - Every write is bounded before it is appended; no caller text reaches a
 *   journal unbounded, and each bound refuses by name
 *   ("Settings → The fold → Limits").
 * - Result payloads never enter the request journal. The journal carries the
 *   result id, its outcome, its receipt id, and how many files it named.
 * - A damaged middle line is skipped and counted, never thrown on: a request
 *   record is a projection over turns and receipts, so a lost line degrades to
 *   the turn-only view rather than keeping the app from starting.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  workFoldRequestContinuationsDefaultEnabled,
  workFoldRequestLimits,
} from "../../shared/fold-limits.js";
import { directorySyncUnsupported, type WorkFoldDurableTurnRecord, type WorkFoldDurableTurnUsage } from "../agent/turn-store.js";
import { maxManagementAttachments, type ManagementAttachmentRef } from "../management-attachments.js";
import type { RestrictedAppJsonSchema } from "../agent/restricted-app-manifest.js";
import {
  computeWorkFoldRequestState,
  isWorkFoldRequestTerminalState,
  parseWorkFoldQuestionRecord,
  parseWorkFoldRequestRecord,
  parseWorkFoldResultEnvelope,
  parseWorkFoldResultRecord,
  workFoldQuestionRecordSchema,
  workFoldRequestIdPattern,
  workFoldRequestLimitError,
  WorkFoldRequestLineageError,
  workFoldRequestRecordSchema,
  workFoldResultIdPattern,
  workFoldResultRecordSchema,
  type WorkFoldQuestionRecord,
  type WorkFoldRequestAction,
  type WorkFoldRequestAppRef,
  type WorkFoldRequestKind,
  type WorkFoldRequestOwner,
  type WorkFoldRequestRecord,
  type WorkFoldRequestRemoteRef,
  type WorkFoldRequestSurface,
  type WorkFoldRequestTurnRef,
  type WorkFoldRequestTurnState,
  type WorkFoldResultEnvelope,
  type WorkFoldResultRecord,
} from "./request-records.js";

/** "Daily while awake": `purgeExpiredIfDue` runs at most this often by default. */
export const WORKFOLD_REQUEST_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const defaultMaxRecords = 2_000;
const defaultCompactBytes = 8 * 1024 * 1024;
const maximumErrorLength = 2_048;
const interruptedByShutdown = "work-fold closed before this Assistant turn finished.";

export interface WorkFoldRequestStoreOptions {
  rootPath: string;
  now?: () => Date;
  maxRecords?: number;
  compactBytes?: number;
  retentionDays?: number;
  /** Shipped default is `null`: no cap. A host may set one; reaching it fails the request. */
  providerBudgetUsd?: number | null;
}

/** A result payload either read back whole, or reported as damaged — never silently dropped. */
export type WorkFoldResultRead =
  | { state: "ok"; record: WorkFoldResultRecord }
  | { state: "damaged"; resultId: string; requestId: string; error: string };

export interface WorkFoldRequestReconcileResult {
  settled: number;
  expired: number;
}

interface RequestSettingsFile {
  version: 1;
  lastPurgeAt: string | null;
  continuationsEnabled: boolean;
}

/** What retention needs about a record the in-memory read cache no longer holds. */
interface TrimmedRequestRef {
  requestId: string;
  rootId: string;
  state: WorkFoldRequestRecord["state"];
  settledAt: string | null;
}

export class WorkFoldRequestStore {
  readonly rootPath: string;
  readonly requestsPath: string;
  readonly questionsPath: string;

  readonly #now: () => Date;
  readonly #maxRecords: number;
  readonly #compactBytes: number;
  readonly #retentionDays: number;
  readonly #providerBudgetUsd: number | null;
  readonly #records = new Map<string, WorkFoldRequestRecord>();
  /** Records the read cache dropped; still on record, still subject only to retention. */
  readonly #trimmed = new Map<string, TrimmedRequestRef>();
  readonly #byTask = new Map<string, string>();
  readonly #questions = new Map<string, WorkFoldQuestionRecord>();
  readonly #resultOwner = new Map<string, string>();
  #settings: RequestSettingsFile;
  #damaged = 0;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(rootPath: string, options: WorkFoldRequestStoreOptions, settings: RequestSettingsFile) {
    this.rootPath = rootPath;
    this.requestsPath = join(rootPath, "requests.jsonl");
    this.questionsPath = join(rootPath, "questions.jsonl");
    this.#now = options.now ?? (() => new Date());
    this.#maxRecords = options.maxRecords ?? defaultMaxRecords;
    this.#compactBytes = options.compactBytes ?? defaultCompactBytes;
    this.#retentionDays = options.retentionDays ?? workFoldRequestLimits.retentionDays;
    this.#providerBudgetUsd = options.providerBudgetUsd ?? workFoldRequestLimits.providerBudgetUsd;
    this.#settings = settings;
  }

  static async open(options: WorkFoldRequestStoreOptions): Promise<WorkFoldRequestStore> {
    const rootPath = resolve(options.rootPath);
    await mkdir(join(rootPath, "results"), { recursive: true, mode: 0o700 });
    const settings = await loadSettings(join(rootPath, "settings.json"));
    const store = new WorkFoldRequestStore(rootPath, options, settings.settings);
    if (settings.damaged) store.#damaged += 1;
    if (!settings.existed) await store.#writeSettings(settings.settings);
    await store.#load();
    return store;
  }

  // --- reads -------------------------------------------------------------

  get(requestId: string): WorkFoldRequestRecord | null {
    const record = this.#records.get(requestId);
    return record ? copyRecord(record) : null;
  }

  byTaskId(taskId: string): WorkFoldRequestRecord | null {
    const requestId = this.#byTask.get(taskId);
    return requestId ? this.get(requestId) : null;
  }

  children(requestId: string): WorkFoldRequestRecord[] {
    const record = this.#records.get(requestId);
    if (!record) return [];
    return record.childRequestIds
      .map((id) => this.#records.get(id))
      .filter((child): child is WorkFoldRequestRecord => child !== undefined)
      .map(copyRecord);
  }

  /**
   * Every record whose root is `rootId`, the root itself excluded. This
   * answers only for a ROOT id — a mid-graph id gets nothing back, because
   * every record below a root carries the root's id, not its parent's. Use
   * `subtree` for the graph below an arbitrary request.
   */
  rootDescendants(rootId: string): WorkFoldRequestRecord[] {
    return this.#sorted(
      [...this.#records.values()].filter((record) => record.rootId === rootId && record.requestId !== rootId),
    ).map(copyRecord);
  }

  /**
   * Every record below `requestId` at any depth, the request itself excluded,
   * followed transitively through `childRequestIds` so a mid-graph request
   * answers for its own branch. A stop, and the glance's rolled-up child
   * turns, both need this rather than the root-only form.
   */
  subtree(requestId: string): WorkFoldRequestRecord[] {
    const seen = new Set<string>([requestId]);
    const found: WorkFoldRequestRecord[] = [];
    const frontier = [requestId];
    while (frontier.length) {
      const current = frontier.shift()!;
      const record = this.#records.get(current);
      if (!record) continue;
      for (const childId of record.childRequestIds) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const child = this.#records.get(childId);
        if (!child) continue;
        found.push(child);
        frontier.push(childId);
      }
    }
    return this.#sorted(found).map(copyRecord);
  }

  latest(): WorkFoldRequestRecord | null {
    const records = this.#sorted([...this.#records.values()]);
    const latest = records.at(-1);
    return latest ? copyRecord(latest) : null;
  }

  /**
   * The newest request on one Chat, within one owner scope. The conversation
   * id alone is not identity: a Chat log travels with its folder, so a copied
   * Space can hold the same conversation id under a different owner. Pass the
   * Space that is asking (or nothing for the management scope) so a reply can
   * never join another Space's request.
   */
  latestForConversation(conversationId: string, owner: { spaceId?: string } = {}): WorkFoldRequestRecord | null {
    const records = this.#sorted([...this.#records.values()].filter((record) =>
      record.owner.conversationId === conversationId
      && (owner.spaceId ?? null) === (record.owner.spaceId ?? null)));
    const latest = records.at(-1);
    return latest ? copyRecord(latest) : null;
  }

  /** Oldest first, like the registry this store replaces. `limit` keeps the newest. */
  list(options: { kind?: WorkFoldRequestKind; rootId?: string; spaceId?: string; limit?: number } = {}): WorkFoldRequestRecord[] {
    let records = [...this.#records.values()];
    if (options.kind) records = records.filter((record) => record.kind === options.kind);
    if (options.rootId) records = records.filter((record) => record.rootId === options.rootId);
    if (options.spaceId) records = records.filter((record) => record.owner.spaceId === options.spaceId);
    records = this.#sorted(records);
    if (options.limit !== undefined && records.length > options.limit) records = records.slice(-options.limit);
    return records.map(copyRecord);
  }

  /**
   * Oldest first by creation, tie-broken by id. Iteration order of the record
   * map is creation order only until a compaction rewrites the journal by
   * `updatedAt`; sorting explicitly means "newest request" means the same
   * thing before and after a restart.
   */
  #sorted(records: WorkFoldRequestRecord[]): WorkFoldRequestRecord[] {
    return records.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
  }

  /** True while the named turn can still have work attributed to it. */
  isAccepting(taskId: string): boolean {
    const record = this.byTaskId(taskId);
    if (!record || record.stopRequestedAt !== null) return false;
    const newest = record.turns.at(-1);
    return newest?.state === "accepted" || newest?.state === "running";
  }

  /**
   * The `--task` rule for `chat report`, `chat ask`, and `chat handoff`
   * (docs/collaboration-contract.md, F27): a task id must name the caller's
   * own turn — the newest turn of a request the named Space owns — and that
   * turn must still be running, exactly the way `--parent-task` is checked.
   * An id from an older turn, another Space, or another request is refused
   * by name. Returns the owning record so the verb can continue with it.
   */
  assertOwnAcceptingTurn(taskId: string, owner: { spaceId?: string }): WorkFoldRequestRecord {
    const record = this.byTaskId(taskId);
    if (!record) throw new WorkFoldRequestLineageError("That task does not belong to a request on record.");
    if ((owner.spaceId ?? null) !== (record.owner.spaceId ?? null)) {
      throw new WorkFoldRequestLineageError("That task belongs to another Space's turn.");
    }
    if (record.turns.at(-1)?.taskId !== taskId) {
      throw new WorkFoldRequestLineageError("That task is an older turn of its request; use the turn that is running now.");
    }
    if (!this.isAccepting(taskId)) {
      throw new WorkFoldRequestLineageError("That task's turn is stopping or has already finished.");
    }
    return record;
  }

  /** Journal lines that could not be read. Reported honestly rather than hidden. */
  damagedRecordCount(): number {
    return this.#damaged;
  }

  retentionDays(): number {
    return this.#retentionDays;
  }

  lastPurgeAt(): string | null {
    return this.#settings.lastPurgeAt;
  }

  /** F28's follow-up turns; a person can turn them off without a second store. */
  continuationsEnabled(): boolean {
    return this.#settings.continuationsEnabled;
  }

  setContinuationsEnabled(enabled: boolean): Promise<void> {
    return this.#run(async () => {
      await this.#writeSettings({ ...this.#settings, continuationsEnabled: enabled });
    });
  }

  question(questionId: string): WorkFoldQuestionRecord | null {
    const record = this.#questions.get(questionId);
    return record ? { ...record } : null;
  }

  questions(requestId: string): WorkFoldQuestionRecord[] {
    return [...this.#questions.values()].filter((record) => record.requestId === requestId).map((record) => ({ ...record }));
  }

  openQuestions(rootId?: string): WorkFoldQuestionRecord[] {
    return [...this.#questions.values()]
      .filter((record) => record.state === "open" && (rootId === undefined || record.rootId === rootId))
      .map((record) => ({ ...record }));
  }

  // --- creation and joining ----------------------------------------------

  beginRoot(input: {
    kind: WorkFoldRequestKind;
    owner: WorkFoldRequestOwner;
    surface: WorkFoldRequestSurface;
    taskId: string;
    app?: WorkFoldRequestAppRef;
    content?: string;
    attachments?: readonly ManagementAttachmentRef[];
    remote?: WorkFoldRequestRemoteRef | null;
    continuedFromTaskId?: string | null;
    acceptedAt?: string;
  }): Promise<WorkFoldRequestRecord> {
    return this.#run(async () => {
      const existing = this.#byTask.get(input.taskId);
      if (existing) return copyRecord(this.#records.get(existing)!);
      const record = this.#newRecord({
        ...input,
        parent: null,
      });
      await this.#writeRequest(record);
      return copyRecord(record);
    });
  }

  /**
   * A child of the turn named by `parentTaskId`. Every bound that could refuse
   * the child is checked here, before the caller accepts the turn, so a turn
   * is never accepted and then cancelled.
   */
  beginChild(input: {
    parentTaskId: string;
    kind: WorkFoldRequestKind;
    owner: WorkFoldRequestOwner;
    surface: WorkFoldRequestSurface;
    taskId: string;
    app?: WorkFoldRequestAppRef;
    content?: string;
    attachments?: readonly ManagementAttachmentRef[];
    acceptedAt?: string;
  }): Promise<WorkFoldRequestRecord> {
    return this.#run(async () => {
      const existing = this.#byTask.get(input.taskId);
      if (existing) return copyRecord(this.#records.get(existing)!);
      const parent = this.#requireByTask(input.parentTaskId);
      this.assertCanAddChild(input.parentTaskId);
      const record = this.#newRecord({ ...input, parent });
      await this.#writeRequest(record);
      const updatedParent = {
        ...this.#records.get(parent.requestId)!,
        childRequestIds: [...this.#records.get(parent.requestId)!.childRequestIds, record.requestId],
      };
      await this.#writeRequest(updatedParent);
      await this.#recomputeFrom(parent.requestId);
      return copyRecord(this.#records.get(record.requestId)!);
    });
  }

  /**
   * A new turn joins an existing request: a person's reply to a question, or a
   * follow-up turn. The request keeps one record and one story rather than
   * copying its trail into a second one.
   */
  joinTurn(input: {
    requestId: string;
    taskId: string;
    role?: "continuation";
    content?: string;
    attachments?: readonly ManagementAttachmentRef[];
    acceptedAt?: string;
  }): Promise<WorkFoldRequestRecord> {
    return this.#run(async () => {
      const existing = this.#byTask.get(input.taskId);
      if (existing) return copyRecord(this.#records.get(existing)!);
      const record = this.#requireRecord(input.requestId);
      this.assertCanContinue(record.requestId);
      const at = input.acceptedAt ?? this.#now().toISOString();
      const turn: WorkFoldRequestTurnRef = {
        taskId: input.taskId,
        acceptedAt: at,
        role: input.role ?? "continuation",
        state: "accepted",
        settledAt: null,
        messageId: null,
        error: null,
      };
      const next: WorkFoldRequestRecord = {
        ...record,
        turns: [...record.turns, turn],
        content: input.content === undefined ? record.content : boundContent(input.content),
        attachments: dedupeAttachments([...record.attachments, ...(input.attachments ?? [])]).slice(0, maxManagementAttachments),
        continuedFromTaskId: record.turns.at(-1)?.taskId ?? record.continuedFromTaskId,
        // A joined turn reopens the request: it is working again, and its
        // settle time belongs to whatever this new turn does.
        state: "working",
        settledAt: null,
        reconciledAt: null,
        continuationState: null,
      };
      await this.#writeRequest(next);
      await this.#recomputeFrom(next.requestId);
      return copyRecord(this.#records.get(next.requestId)!);
    });
  }

  // --- turn lifecycle ----------------------------------------------------

  markTurnRunning(taskId: string): Promise<WorkFoldRequestRecord | null> {
    return this.#run(async () => await this.#updateTurn(taskId, (turn) =>
      turn.state === "accepted" ? { ...turn, state: "running" } : turn));
  }

  /**
   * Puts a settled turn back to `accepted`: the acceptance path retries a
   * turn whose user message could not be persisted the first time, and a
   * task id belongs to exactly one request, so the same turn resumes rather
   * than a second record appearing. The request is working again.
   */
  reopenTurn(taskId: string): Promise<WorkFoldRequestRecord | null> {
    return this.#run(async () => await this.#updateTurn(taskId, (turn) =>
      turn.state === "accepted" || turn.state === "running"
        ? turn
        : { ...turn, state: "accepted", settledAt: null, error: null }));
  }

  /**
   * Records one turn's outcome. Settling a turn that already settled is a
   * no-op: the first outcome stands, exactly as the turn journal's does.
   */
  settleTurn(
    taskId: string,
    input: {
      status: Exclude<WorkFoldRequestTurnState, "accepted" | "running">;
      messageId?: string;
      error?: string;
      usage?: WorkFoldDurableTurnUsage;
    },
  ): Promise<WorkFoldRequestRecord | null> {
    return this.#run(async () => {
      const record = await this.#updateTurn(taskId, (turn) => {
        if (turn.state !== "accepted" && turn.state !== "running") return turn;
        return {
          ...turn,
          state: input.status,
          settledAt: this.#now().toISOString(),
          messageId: input.messageId ?? turn.messageId,
          error: input.error ? input.error.slice(0, maximumErrorLength) : turn.error,
        };
      }, input.usage);
      if (!record) return null;
      await this.#applyProviderBudget(record.rootId);
      return copyRecord(this.#records.get(record.requestId) ?? record);
    });
  }

  markStopRequested(requestId: string): Promise<WorkFoldRequestRecord | null> {
    return this.#run(async () => {
      const record = this.#records.get(requestId);
      if (!record) return null;
      if (record.stopRequestedAt === null) {
        await this.#writeRequest({ ...record, stopRequestedAt: this.#now().toISOString() });
        await this.#recomputeFrom(requestId);
      }
      return copyRecord(this.#records.get(requestId)!);
    });
  }

  // --- the action trail --------------------------------------------------

  /**
   * Attributes one landed act to the request that named it. Returns the
   * request id it credited, or `null` when nothing was named or the trail is
   * already at its bound — attribution never refuses the act itself.
   */
  recordAction(parentTaskId: string | undefined, action: WorkFoldRequestAction): Promise<string | null> {
    if (!parentTaskId) return Promise.resolve(null);
    return this.#run(async () => {
      const requestId = this.#byTask.get(parentTaskId);
      const record = requestId ? this.#records.get(requestId) : undefined;
      if (!record || record.actions.length >= workFoldRequestLimits.maxActionsPerRequest) return null;
      await this.#writeRequest({ ...record, actions: [...record.actions, structuredClone(action)] });
      return record.requestId;
    });
  }

  // --- questions ---------------------------------------------------------

  ask(input: {
    requestId: string;
    taskId: string;
    respondent: "person" | "parent";
    text: string;
  }): Promise<WorkFoldQuestionRecord> {
    return this.#run(async () => {
      const record = this.#requireRecord(input.requestId);
      if (isWorkFoldRequestTerminalState(record.state)) {
        // A request that ran out of time hit a bound, not a lineage rule, so
        // the refusal names the number and where to see it (principle 6).
        throw this.#terminalRefusal(record, "This request has already finished, so it cannot ask a question.");
      }
      this.#requireOwnTurn(record, input.taskId);
      if (record.questionIds.length >= workFoldRequestLimits.maxQuestionsPerRequest) {
        throw workFoldRequestLimitError("questionsPerRequest", workFoldRequestLimits.maxQuestionsPerRequest);
      }
      const at = this.#now().toISOString();
      const question = parseWorkFoldQuestionRecord({
        schema: workFoldQuestionRecordSchema,
        questionId: newId("q", at),
        requestId: record.requestId,
        rootId: record.rootId,
        taskId: input.taskId,
        respondent: input.respondent,
        text: input.text,
        askedAt: at,
        updatedAt: at,
        expiresAt: record.deadline,
        state: "open",
        answer: null,
        answeredAt: null,
        continuationTaskId: null,
        answeredBySpaceId: null,
      });
      await this.#writeQuestion(question);
      await this.#writeRequest({ ...this.#records.get(record.requestId)!, questionIds: [...record.questionIds, question.questionId] });
      await this.#recomputeFrom(record.requestId);
      return { ...question };
    });
  }

  /** Exactly one answer per question, from the Space that was asked, inside the request's window. */
  answer(input: { questionId: string; answer: string; answeredBySpaceId?: string }): Promise<WorkFoldQuestionRecord> {
    return this.#run(async () => {
      const question = this.#questions.get(input.questionId);
      if (!question) throw new WorkFoldRequestLineageError("That question is not on record.");
      if (question.state === "answered") throw new WorkFoldRequestLineageError("This question already has an answer.");
      if (question.state === "cancelled") throw new WorkFoldRequestLineageError("This question was withdrawn when its request stopped.");
      // A refused answer changes nothing: `expireDue` owns the transition, so
      // the request keeps the open question that makes it run out of time.
      if (question.state === "expired" || this.#now().getTime() >= Date.parse(question.expiresAt)) {
        throw workFoldRequestLimitError("questionLifetime", workFoldRequestLimits.deadlineMs);
      }
      const record = this.#requireRecord(question.requestId);
      this.assertCanContinue(record.requestId);
      if (input.answeredBySpaceId !== undefined && record.owner.spaceId !== input.answeredBySpaceId) {
        throw new WorkFoldRequestLineageError("An answer can only come from the Space that was asked.");
      }
      const at = this.#now().toISOString();
      const answered = parseWorkFoldQuestionRecord({
        ...question,
        updatedAt: at,
        state: "answered",
        answer: input.answer,
        answeredAt: at,
        answeredBySpaceId: input.answeredBySpaceId ?? null,
      });
      await this.#writeQuestion(answered);
      await this.#recomputeFrom(question.requestId);
      return { ...answered };
    });
  }

  /** Links the one continuation turn an answer starts. Set once, never twice. */
  linkContinuation(questionId: string, continuationTaskId: string): Promise<WorkFoldQuestionRecord> {
    return this.#run(async () => {
      const question = this.#questions.get(questionId);
      if (!question) throw new WorkFoldRequestLineageError("That question is not on record.");
      if (question.state !== "answered") throw new WorkFoldRequestLineageError("A follow-up turn needs an answer first.");
      if (question.continuationTaskId !== null) {
        throw new WorkFoldRequestLineageError("This question already started its follow-up turn.");
      }
      this.#requireOwnTurn(this.#requireRecord(question.requestId), continuationTaskId);
      const linked = parseWorkFoldQuestionRecord({
        ...question,
        updatedAt: this.#now().toISOString(),
        continuationTaskId,
      });
      await this.#writeQuestion(linked);
      await this.#recomputeFrom(question.requestId);
      return { ...linked };
    });
  }

  cancelQuestions(requestId: string, reason: "stopped" | "expired"): Promise<number> {
    return this.#run(async () => await this.#cancelQuestions(requestId, reason));
  }

  // --- results -----------------------------------------------------------

  recordResult(input: {
    requestId: string;
    taskId: string;
    receiptId: string;
    envelope: unknown;
    schema?: RestrictedAppJsonSchema;
  }): Promise<WorkFoldResultRecord> {
    return this.#run(async () => {
      const record = this.#requireRecord(input.requestId);
      this.#requireOwnTurn(record, input.taskId);
      if (record.results.length >= workFoldRequestLimits.maxResultsPerRequest) {
        throw workFoldRequestLimitError("resultsPerRequest", workFoldRequestLimits.maxResultsPerRequest);
      }
      const envelope: WorkFoldResultEnvelope = parseWorkFoldResultEnvelope(
        input.envelope,
        input.schema ? { schema: input.schema } : {},
      );
      const at = this.#now().toISOString();
      const result = parseWorkFoldResultRecord({
        schema: workFoldResultRecordSchema,
        resultId: newId("res", at),
        requestId: record.requestId,
        rootId: record.rootId,
        taskId: input.taskId,
        recordedAt: at,
        receiptId: input.receiptId,
        envelope,
      });
      const path = this.#resultPath(result.requestId, result.resultId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, `${JSON.stringify(result, null, 2)}\n`);
      await this.#writeRequest({
        ...this.#records.get(record.requestId)!,
        results: [...record.results, {
          resultId: result.resultId,
          taskId: result.taskId,
          outcome: envelope.outcome,
          recordedAt: at,
          receiptId: result.receiptId,
          fileCount: envelope.files?.length ?? 0,
        }],
      });
      this.#resultOwner.set(result.resultId, result.requestId);
      await this.#recomputeFrom(record.requestId);
      return result;
    });
  }

  async result(resultId: string): Promise<WorkFoldResultRead | null> {
    const requestId = this.#resultOwner.get(resultId);
    if (!requestId) return null;
    return await this.#readResult(requestId, resultId);
  }

  async results(requestId: string): Promise<WorkFoldResultRead[]> {
    const record = this.#records.get(requestId);
    if (!record) return [];
    const reads: WorkFoldResultRead[] = [];
    for (const ref of record.results) reads.push(await this.#readResult(requestId, ref.resultId));
    return reads;
  }

  // --- limits ------------------------------------------------------------

  /** Rechecked at acceptance, including every ancestor's stop and window. */
  assertCanContinue(requestId: string): void {
    let record: WorkFoldRequestRecord | null = this.#requireRecord(requestId);
    if (record.turns.length >= workFoldRequestLimits.maxTurnsPerRequest) {
      throw workFoldRequestLimitError("turnsPerRequest", workFoldRequestLimits.maxTurnsPerRequest);
    }
    const seen = new Set<string>();
    while (record && !seen.has(record.requestId)) {
      seen.add(record.requestId);
      if (record.stopRequestedAt || record.state === "stopped" || record.limitHit) {
        throw this.#terminalRefusal(record, "This request or its parent stopped and cannot continue.");
      }
      if (record.state === "expired" || this.#now().getTime() >= Date.parse(record.deadline)) {
        throw workFoldRequestLimitError("deadline", workFoldRequestLimits.deadlineMs);
      }
      record = record.parentRequestId ? this.#requireRecord(record.parentRequestId) : null;
    }
  }

  /**
   * Every bound that can refuse a new child turn, in the order a person would
   * read them. Each throws a `WorkFoldRequestLimitError` naming its number.
   */
  assertCanAddChild(parentTaskId: string): void {
    const parent = this.#requireByTask(parentTaskId);
    if (isWorkFoldRequestTerminalState(parent.state)) {
      throw this.#terminalRefusal(parent, "The request this work belongs to is stopping or has already finished.");
    }
    if (parent.depth + 1 > workFoldRequestLimits.maxDelegationDepth) {
      throw workFoldRequestLimitError("depth", workFoldRequestLimits.maxDelegationDepth);
    }
    const family = [...this.#records.values()].filter((record) => record.rootId === parent.rootId && record.requestId !== parent.rootId);
    if (family.length >= workFoldRequestLimits.maxChildRequestsPerRoot) {
      throw workFoldRequestLimitError("childTasks", workFoldRequestLimits.maxChildRequestsPerRoot);
    }
    const running = family.filter((record) => !isWorkFoldRequestTerminalState(record.state)).length;
    if (running >= workFoldRequestLimits.maxConcurrentChildrenPerRoot) {
      throw workFoldRequestLimitError("concurrentChildren", workFoldRequestLimits.maxConcurrentChildrenPerRoot);
    }
  }

  /**
   * Counts one follow-up turn against a root. Past the bound the settle is
   * still recorded — it is simply not narrated by another turn (F28).
   */
  noteContinuation(requestId: string, childTaskIds: string[] = []): Promise<{ allowed: boolean; count: number }> {
    return this.#run(async () => {
      const record = this.#requireRecord(requestId);
      const root = this.#requireRecord(record.rootId);
      this.assertCanContinue(requestId);
      if (root.continuationCount >= workFoldRequestLimits.maxContinuationsPerRoot
        || (childTaskIds.length > 0 && childTaskIds.every((id) => record.deliveredChildTaskIds.includes(id)))) {
        return { allowed: false, count: root.continuationCount };
      }
      for (const id of childTaskIds) {
        if (this.#requireByTask(id).parentRequestId !== requestId) throw new WorkFoldRequestLineageError("A continuation can receive only its own children's results.");
      }
      const count = root.continuationCount + 1;
      await this.#writeRequest({ ...root, continuationCount: count });
      if (childTaskIds.length) {
        await this.#writeRequest({
          ...this.#requireRecord(requestId),
          deliveredChildTaskIds: this.#childDeliveryIds(record, childTaskIds),
          continuationState: "pending",
        });
        await this.#recomputeFrom(requestId);
      }
      return { allowed: true, count };
    });
  }

  failContinuation(requestId: string): Promise<void> {
    return this.#run(async () => {
      const record = this.#requireRecord(requestId);
      if (record.continuationState !== "pending") return;
      await this.#writeRequest({ ...record, continuationState: "failed" });
      await this.#recomputeFrom(requestId);
    });
  }

  // --- lifecycle ---------------------------------------------------------

  /** Selected child results admitted into an already accepted turn's context. */
  noteChildDelivery(requestId: string, taskIds: string[]): Promise<void> {
    return this.#run(async () => {
      const record = this.#requireRecord(requestId);
      await this.#writeRequest({ ...record, deliveredChildTaskIds: this.#childDeliveryIds(record, taskIds) });
    });
  }

  #childDeliveryIds(record: WorkFoldRequestRecord, taskIds: string[]): string[] {
    const delivered = new Map<string, string>();
    for (const id of [...record.deliveredChildTaskIds, ...taskIds]) {
      const child = this.#requireByTask(id);
      if (child.parentRequestId !== record.requestId) throw new WorkFoldRequestLineageError("A request can receive only its own children's results.");
      delivered.set(child.requestId, id);
    }
    return [...delivered.values()];
  }

  /**
   * Startup recovery, run strictly after the turn journal has repaired
   * itself: every turn this store still believes is live is resolved against
   * that journal, questions past their window expire, and each request's
   * state is recomputed children-first so a parent sees settled children.
   *
   * This settles; it never dispatches. A request touched here carries
   * `reconciledAt` so nothing mistakes a recovered settle for fresh work.
   */
  reconcile(input: { turns: readonly WorkFoldDurableTurnRecord[]; now?: Date }): Promise<WorkFoldRequestReconcileResult> {
    return this.#run(async () => {
      const now = input.now ?? this.#now();
      const journal = new Map(input.turns.map((turn) => [turn.turnId, turn]));
      const targets = [...this.#records.values()]
        .filter((record) => !isWorkFoldRequestTerminalState(record.state))
        .sort((left, right) => right.depth - left.depth || left.createdAt.localeCompare(right.createdAt));
      let settled = 0;
      let expired = 0;
      for (const target of targets) {
        const record = this.#records.get(target.requestId);
        if (!record) continue;
        let usage = record.usage;
        const turns = record.turns.map((turn) => {
          if (turn.state !== "accepted" && turn.state !== "running") return turn;
          settled += 1;
          const durable = journal.get(turn.taskId);
          const recovered = durable && durable.status !== "accepted" && durable.status !== "running" ? durable : null;
          if (recovered?.usage) usage = accumulateUsage(usage, recovered.usage);
          return {
            ...turn,
            state: (recovered?.status ?? "interrupted") as WorkFoldRequestTurnState,
            settledAt: recovered?.updatedAt ?? now.toISOString(),
            messageId: recovered?.messageId ?? turn.messageId,
            error: recovered?.error ?? (recovered ? turn.error : interruptedByShutdown),
          };
        });
        await this.#writeRequest({ ...record, turns, usage, reconciledAt: now.toISOString(),
          continuationState: record.continuationState === "pending" ? "failed" : record.continuationState });
        await this.#expireQuestionsDue(record.requestId, now);
        await this.#recomputeFrom(record.requestId, now);
        if (this.#records.get(record.requestId)?.state === "expired") expired += 1;
      }
      return { settled, expired };
    });
  }

  /** Closes every request whose window has passed, and the questions under it. */
  expireDue(now?: Date): Promise<{ requests: number; questions: number }> {
    return this.#run(async () => {
      const at = now ?? this.#now();
      const targets = [...this.#records.values()]
        .filter((record) => !isWorkFoldRequestTerminalState(record.state) && at.getTime() >= Date.parse(record.deadline))
        .sort((left, right) => right.depth - left.depth);
      let requests = 0;
      let questions = 0;
      for (const target of targets) {
        await this.#recomputeFrom(target.requestId, at);
        if (this.#records.get(target.requestId)?.state === "expired") requests += 1;
        questions += await this.#expireQuestionsDue(target.requestId, at);
      }
      return { requests, questions };
    });
  }

  /**
   * Retention: a whole root graph leaves together, once every request in it
   * has settled and the newest settle is older than the retention window. A
   * root with work still outstanding below it is never removed.
   *
   * A record the read cache trimmed is still a family member: `#trimmed` keeps
   * the three fields retention needs, so the cache bound can never leave a
   * settled record on disk forever or take one away before its window.
   */
  purgeExpired(now?: Date): Promise<{ purged: number }> {
    return this.#run(async () => {
      const at = now ?? this.#now();
      const cutoff = at.getTime() - this.#retentionDays * 24 * 60 * 60 * 1000;
      const family = new Map<string, TrimmedRequestRef[]>();
      for (const record of this.#records.values()) {
        const entry = family.get(record.rootId) ?? [];
        entry.push({ requestId: record.requestId, rootId: record.rootId, state: record.state, settledAt: record.settledAt });
        family.set(record.rootId, entry);
      }
      for (const record of this.#trimmed.values()) {
        const entry = family.get(record.rootId) ?? [];
        entry.push(record);
        family.set(record.rootId, entry);
      }
      const doomed: TrimmedRequestRef[] = [];
      for (const members of family.values()) {
        const settledOut = members.every((member) =>
          isWorkFoldRequestTerminalState(member.state) && member.settledAt !== null && Date.parse(member.settledAt) <= cutoff);
        if (settledOut) doomed.push(...members);
      }
      // The ids retention removes are the only ids a rewrite may drop; the
      // journal is otherwise the authority over what is still on record.
      const purgedRequests = new Set<string>();
      const purgedQuestions = new Set<string>();
      for (const member of doomed) {
        for (const questionId of [...this.#questions.values()].filter((q) => q.requestId === member.requestId).map((q) => q.questionId)) {
          this.#questions.delete(questionId);
          purgedQuestions.add(questionId);
        }
        const record = this.#records.get(member.requestId);
        if (record) {
          for (const ref of record.results) this.#resultOwner.delete(ref.resultId);
          for (const turn of record.turns) this.#byTask.delete(turn.taskId);
        }
        await rm(join(this.rootPath, "results", member.requestId), { recursive: true, force: true }).catch(() => undefined);
        this.#records.delete(member.requestId);
        this.#trimmed.delete(member.requestId);
        purgedRequests.add(member.requestId);
      }
      if (doomed.length) {
        await this.#compact("requests", true, purgedRequests);
        await this.#compact("questions", true, purgedQuestions);
      }
      await this.#writeSettings({ ...this.#settings, lastPurgeAt: at.toISOString() });
      return { purged: doomed.length };
    });
  }

  /** The wake-tolerant "once a day while awake" wrapper, like Recently deleted. */
  async purgeExpiredIfDue(intervalMs: number = WORKFOLD_REQUEST_PURGE_INTERVAL_MS): Promise<{ purged: number } | null> {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("The purge interval must be a non-negative number of milliseconds.");
    const last = this.#settings.lastPurgeAt === null ? Number.NaN : Date.parse(this.#settings.lastPurgeAt);
    if (Number.isFinite(last) && this.#now().getTime() - last < intervalMs) return null;
    return await this.purgeExpired();
  }

  flush(): Promise<void> {
    return this.#queue.then(() => undefined, () => undefined);
  }

  // --- internals ---------------------------------------------------------

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #requireRecord(requestId: string): WorkFoldRequestRecord {
    const record = this.#records.get(requestId);
    if (!record) throw new WorkFoldRequestLineageError("That request is not on record.");
    return record;
  }

  #requireByTask(taskId: string): WorkFoldRequestRecord {
    const requestId = this.#byTask.get(taskId);
    const record = requestId ? this.#records.get(requestId) : undefined;
    if (!record) throw new WorkFoldRequestLineageError("That task does not belong to a request on record.");
    return record;
  }

  /**
   * The refusal for a request that is already terminal. A request that ran out
   * of time, or that stopped at a configured bound, reached a limit rather
   * than a lineage rule, so it refuses with the number and the Settings
   * section every bound names (docs/receipts-not-gates.md, principle 6). A
   * stopped or finished request keeps the plain lineage sentence.
   */
  #terminalRefusal(record: WorkFoldRequestRecord, lineage: string): Error {
    if (record.limitHit?.limit === "providerBudget" && this.#providerBudgetUsd !== null) {
      return workFoldRequestLimitError("providerBudget", this.#providerBudgetUsd);
    }
    if (record.state === "expired") return workFoldRequestLimitError("deadline", workFoldRequestLimits.deadlineMs);
    return new WorkFoldRequestLineageError(lineage);
  }

  /** A verb may only speak for a turn of its own request. */
  #requireOwnTurn(record: WorkFoldRequestRecord, taskId: string): void {
    if (!record.turns.some((turn) => turn.taskId === taskId)) {
      throw new WorkFoldRequestLineageError("That task does not belong to this request.");
    }
  }

  #newRecord(input: {
    kind: WorkFoldRequestKind;
    owner: WorkFoldRequestOwner;
    surface: WorkFoldRequestSurface;
    taskId: string;
    app?: WorkFoldRequestAppRef;
    content?: string;
    attachments?: readonly ManagementAttachmentRef[];
    remote?: WorkFoldRequestRemoteRef | null;
    continuedFromTaskId?: string | null;
    acceptedAt?: string;
    parentTaskId?: string;
    parent: WorkFoldRequestRecord | null;
  }): WorkFoldRequestRecord {
    const createdAt = input.acceptedAt ?? this.#now().toISOString();
    const requestId = newId("req", createdAt);
    const deadline = new Date(Date.parse(createdAt) + workFoldRequestLimits.deadlineMs).toISOString();
    const owner: WorkFoldRequestOwner = { conversationId: input.owner.conversationId };
    if (input.owner.spaceId !== undefined) owner.spaceId = input.owner.spaceId;
    if (input.owner.spaceName !== undefined) owner.spaceName = input.owner.spaceName;
    const draft: WorkFoldRequestRecord = {
      schema: workFoldRequestRecordSchema,
      requestId,
      kind: input.kind,
      rootId: input.parent ? input.parent.rootId : requestId,
      parentRequestId: input.parent ? input.parent.requestId : null,
      parentTaskId: input.parentTaskId ?? null,
      depth: input.parent ? input.parent.depth + 1 : 0,
      owner,
      surface: input.surface,
      createdAt,
      updatedAt: createdAt,
      settledAt: null,
      deadline,
      state: "working",
      turns: [{
        taskId: input.taskId,
        acceptedAt: createdAt,
        role: "origin",
        state: "accepted",
        settledAt: null,
        messageId: null,
        error: null,
      }],
      childRequestIds: [],
      questionIds: [],
      results: [],
      usage: { turns: 0, inputTokens: 0, outputTokens: 0, amountUsdComplete: true },
      continuationCount: 0,
      deliveredChildTaskIds: [],
      continuationState: null,
      stopRequestedAt: null,
      limitHit: null,
      reconciledAt: null,
      remote: input.remote ?? null,
      assignment: boundContent(input.content ?? ""),
      content: boundContent(input.content ?? ""),
      attachments: dedupeAttachments([...(input.attachments ?? [])]).slice(0, maxManagementAttachments),
      actions: [],
      continuedFromTaskId: input.continuedFromTaskId ?? null,
    };
    if (input.app) draft.app = { ...input.app };
    // Validating what is about to be appended keeps a malformed record from
    // reaching the journal at all, rather than only failing on the way back.
    return parseWorkFoldRequestRecord(draft);
  }

  async #updateTurn(
    taskId: string,
    mutate: (turn: WorkFoldRequestTurnRef) => WorkFoldRequestTurnRef,
    usage?: WorkFoldDurableTurnUsage,
  ): Promise<WorkFoldRequestRecord | null> {
    const requestId = this.#byTask.get(taskId);
    const record = requestId ? this.#records.get(requestId) : undefined;
    if (!record) return null;
    let changed = false;
    const turns = record.turns.map((turn) => {
      if (turn.taskId !== taskId) return turn;
      const next = mutate(turn);
      if (next !== turn) changed = true;
      return next;
    });
    if (!changed) return copyRecord(record);
    await this.#writeRequest({ ...record, turns, ...(usage ? { usage: accumulateUsage(record.usage, usage) } : {}) });
    await this.#recomputeFrom(record.requestId);
    return copyRecord(this.#records.get(record.requestId)!);
  }

  /** Recomputes this request and then each ancestor, so a settle reaches the root. */
  async #recomputeFrom(requestId: string, now?: Date): Promise<void> {
    const at = now ?? this.#now();
    const seen = new Set<string>();
    let current: string | null = requestId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const record: WorkFoldRequestRecord | undefined = this.#records.get(current);
      if (!record) break;
      const next = this.#withComputedState(record, at);
      if (next.state !== record.state || next.settledAt !== record.settledAt) await this.#writeRequest(next);
      current = record.parentRequestId;
    }
  }

  #withComputedState(record: WorkFoldRequestRecord, now: Date): WorkFoldRequestRecord {
    // Completion can change when a descendant legitimately continues. Stop
    // and expiry remain final; they cannot be undone by a later child settle.
    if (record.state === "stopped" || record.state === "expired") return record;
    const state = computeWorkFoldRequestState({
      stopRequestedAt: record.stopRequestedAt,
      deadline: record.deadline,
      now,
      turnStates: [record.turns.at(-1)!.state,
        ...(record.continuationState === "pending" ? ["accepted" as const] : record.continuationState === "failed" ? ["failed" as const] : [])],
      openQuestions: this.#openQuestionCount(record.requestId),
      openDescendantQuestions: record.childRequestIds.reduce((total, id) => total + this.#openQuestionCount(id, true), 0),
      childStates: record.childRequestIds.map((id) => this.#records.get(id)?.state ?? null),
      resultOutcomes: record.results.filter((ref) => ref.taskId === record.turns.at(-1)!.taskId).slice(-1).map((ref) => ref.outcome),
      limitHit: record.limitHit,
    });
    const terminal = isWorkFoldRequestTerminalState(state);
    return {
      ...record,
      state,
      settledAt: terminal ? record.settledAt ?? now.toISOString() : null,
    };
  }

  /**
   * Open questions this request asked; with `subtree`, every open question
   * below it as well. The two are counted separately because a request's own
   * open question makes it wait immediately, while a child's only surfaces
   * once the parent's own turn has ended (F28).
   */
  #openQuestionCount(requestId: string, subtree = false, seen = new Set<string>()): number {
    if (seen.has(requestId)) return 0;
    seen.add(requestId);
    const record = this.#records.get(requestId);
    if (!record) return 0;
    let count = 0;
    for (const questionId of record.questionIds) {
      const question = this.#questions.get(questionId);
      if (question && (question.state === "open" || (question.state === "answered" && question.continuationTaskId === null))) count += 1;
    }
    if (!subtree) return count;
    for (const childId of record.childRequestIds) count += this.#openQuestionCount(childId, true, seen);
    return count;
  }

  async #expireQuestionsDue(requestId: string, now: Date): Promise<number> {
    let expired = 0;
    for (const question of [...this.#questions.values()]) {
      if (question.requestId !== requestId || !(question.state === "open" || (question.state === "answered" && question.continuationTaskId === null))) continue;
      if (now.getTime() < Date.parse(question.expiresAt)) continue;
      await this.#writeQuestion({ ...question, state: "expired", updatedAt: now.toISOString() });
      expired += 1;
    }
    if (expired) await this.#recomputeFrom(requestId, now);
    return expired;
  }

  async #cancelQuestions(requestId: string, reason: "stopped" | "expired"): Promise<number> {
    const at = this.#now().toISOString();
    let touched = 0;
    for (const question of [...this.#questions.values()]) {
      if (question.requestId !== requestId || !(question.state === "open" || (question.state === "answered" && question.continuationTaskId === null))) continue;
      await this.#writeQuestion({ ...question, state: reason === "stopped" ? "cancelled" : "expired", updatedAt: at });
      touched += 1;
    }
    if (touched) await this.#recomputeFrom(requestId);
    return touched;
  }

  /**
   * Model spending is attribution, not permission — but a root that runs away
   * has to stop. When a cap is configured and the graph passes it, the root
   * records the bound it reached and fails, naming the cap.
   */
  async #applyProviderBudget(rootId: string): Promise<void> {
    if (this.#providerBudgetUsd === null) return;
    const root = this.#records.get(rootId);
    if (!root || root.limitHit !== null) return;
    const family = [root, ...[...this.#records.values()].filter((record) => record.rootId === rootId && record.requestId !== rootId)];
    const spend = family.reduce((total, record) => total + (record.usage.amountUsd ?? 0), 0);
    if (spend <= this.#providerBudgetUsd) return;
    await this.#writeRequest({ ...root, limitHit: { limit: "providerBudget", at: this.#now().toISOString() } });
    await this.#recomputeFrom(rootId);
  }

  #resultPath(requestId: string, resultId: string): string {
    if (!workFoldRequestIdPattern.test(requestId) || !workFoldResultIdPattern.test(resultId)) {
      throw new Error("A result path needs valid request and result ids.");
    }
    return join(this.rootPath, "results", requestId, `${resultId}.json`);
  }

  async #readResult(requestId: string, resultId: string): Promise<WorkFoldResultRead> {
    try {
      const text = await readFile(this.#resultPath(requestId, resultId), "utf8");
      return { state: "ok", record: parseWorkFoldResultRecord(JSON.parse(text)) };
    } catch (error) {
      return { state: "damaged", resultId, requestId, error: errorMessage(error) };
    }
  }

  // --- persistence -------------------------------------------------------

  async #writeRequest(record: WorkFoldRequestRecord): Promise<void> {
    const next = parseWorkFoldRequestRecord({ ...record, updatedAt: this.#now().toISOString() });
    await this.#append(this.requestsPath, next);
    this.#rememberRequest(next);
    await this.#compact("requests", false);
  }

  async #writeQuestion(record: WorkFoldQuestionRecord): Promise<void> {
    const next = parseWorkFoldQuestionRecord(record);
    await this.#append(this.questionsPath, next);
    this.#questions.set(next.questionId, next);
    await this.#compact("questions", false);
  }

  async #writeSettings(settings: RequestSettingsFile): Promise<void> {
    await writeFileAtomic(join(this.rootPath, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    this.#settings = settings;
  }

  async #append(path: string, record: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  #rememberRequest(record: WorkFoldRequestRecord): void {
    this.#records.set(record.requestId, record);
    for (const turn of record.turns) this.#byTask.set(turn.taskId, record.requestId);
    for (const ref of record.results) this.#resultOwner.set(ref.resultId, record.requestId);
  }

  async #load(): Promise<void> {
    for (const line of await this.#readJournal(this.requestsPath)) {
      try {
        this.#rememberRequest(parseWorkFoldRequestRecord(JSON.parse(line)));
      } catch {
        this.#damaged += 1;
      }
    }
    for (const line of await this.#readJournal(this.questionsPath)) {
      try {
        const question = parseWorkFoldQuestionRecord(JSON.parse(line));
        this.#questions.set(question.questionId, question);
      } catch {
        this.#damaged += 1;
      }
    }
    this.#healLineage();
    this.#trimMemory();
  }

  /**
   * Reads a journal's usable lines. A torn final append is dropped silently;
   * a damaged line anywhere else is left for the caller to count, because a
   * request record is a projection and losing one degrades the view rather
   * than the app. The rotated generation is read only when the live journal
   * is absent, which is the crash window inside a compaction.
   */
  async #readJournal(path: string, options: { countDamaged?: boolean } = {}): Promise<string[]> {
    const countDamaged = options.countDamaged ?? true;
    let text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (text === null) {
      text = await readFile(rotatedPath(path), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
    }
    const lines = text.split("\n");
    const usable: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const isLastNonEmpty = lines.slice(index + 1).every((candidate) => !candidate.trim());
      try {
        JSON.parse(line);
      } catch {
        if (isLastNonEmpty) break;
        if (countDamaged) this.#damaged += 1;
        continue;
      }
      usable.push(line);
    }
    return usable;
  }

  /**
   * A child names its parent; a parent names its children. A crash between the
   * two appends can leave the parent's list short, so the child's pointer
   * repairs it. The reverse is deliberately not repaired: a parent naming a
   * child that is not on record is a real loss, and the state rules report it.
   */
  #healLineage(): void {
    for (const record of this.#records.values()) {
      if (!record.parentRequestId) continue;
      const parent = this.#records.get(record.parentRequestId);
      if (!parent || parent.childRequestIds.includes(record.requestId)) continue;
      this.#records.set(parent.requestId, { ...parent, childRequestIds: [...parent.childRequestIds, record.requestId] });
    }
  }

  /**
   * The in-memory map is a bounded READ CACHE, never the record itself. Past
   * the bound the oldest settled records leave memory; they stay in the
   * journal, come back on the next start, and `#trimmed` keeps the three
   * fields retention needs so they still leave on their own window rather
   * than on a cache bound (docs/receipts-not-gates.md, principle 6).
   */
  #trimMemory(): void {
    if (this.#records.size <= this.#maxRecords) return;
    const records = [...this.#records.values()]
      .filter((record) => isWorkFoldRequestTerminalState(record.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const record of records.slice(0, Math.max(0, this.#records.size - this.#maxRecords))) {
      for (const turn of record.turns) this.#byTask.delete(turn.taskId);
      for (const ref of record.results) this.#resultOwner.delete(ref.resultId);
      this.#records.delete(record.requestId);
      this.#trimmed.set(record.requestId, {
        requestId: record.requestId,
        rootId: record.rootId,
        state: record.state,
        settledAt: record.settledAt,
      });
    }
  }

  /**
   * Rewrites a journal when it outgrows its bound: temp file, rotate the live
   * generation aside, rename into place, fsync the directory.
   *
   * The rewrite reads the LIVE JOURNAL, not memory. A whole-record journal is
   * latest-wins by id, so compaction's whole job is dropping superseded lines;
   * the in-memory map is a bounded read cache (`#trimMemory`) and a record it
   * no longer holds is still on record. Rebuilding from memory would make the
   * cache bound erase settled requests years before retention, which is a
   * bound with no name (docs/receipts-not-gates.md, principle 6). Records in
   * memory are overlaid last so a lineage repair reaches disk.
   *
   * `purged` names the ids retention just removed; they are the only ids a
   * rewrite drops, and `force` also removes the rotated generation so purged
   * text does not survive on disk.
   */
  async #compact(kind: "requests" | "questions", force: boolean, purged?: ReadonlySet<string>): Promise<void> {
    const path = kind === "requests" ? this.requestsPath : this.questionsPath;
    if (!force) {
      const info = await stat(path).catch(() => null);
      if (!info || info.size <= this.#compactBytes) return;
    }
    this.#trimMemory();
    const idField = kind === "requests" ? "requestId" : "questionId";
    const byId = new Map<string, { id: string; updatedAt: string; record: unknown }>();
    for (const line of await this.#readJournal(path, { countDamaged: false })) {
      let parsed: { [key: string]: unknown };
      try {
        parsed = JSON.parse(line) as { [key: string]: unknown };
      } catch {
        continue;
      }
      const id = parsed[idField];
      const updatedAt = parsed.updatedAt;
      if (typeof id !== "string" || typeof updatedAt !== "string") continue;
      byId.set(id, { id, updatedAt, record: parsed });
    }
    const live: Iterable<{ requestId?: string; questionId?: string; updatedAt: string }> = kind === "requests"
      ? this.#records.values()
      : this.#questions.values();
    for (const record of live) {
      const id = kind === "requests" ? record.requestId! : record.questionId!;
      byId.set(id, { id, updatedAt: record.updatedAt, record });
    }
    if (purged) for (const id of purged) byId.delete(id);
    const records: unknown[] = [...byId.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .map((entry) => entry.record);
    const tempPath = `${path}.tmp-${randomUUID()}`;
    await writeFile(tempPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
    await rename(path, rotatedPath(path)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rename(tempPath, path);
    if (force) await rm(rotatedPath(path), { force: true }).catch(() => undefined);
    await syncDirectory(dirname(path));
  }
}

function rotatedPath(path: string): string {
  return path.replace(/\.jsonl$/, ".1.jsonl");
}

function newId(prefix: "req" | "q" | "res", at: string): string {
  return `${prefix}-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function boundContent(content: string): string {
  const limit = workFoldRequestLimits.maxRequestContentBytes;
  if (Buffer.byteLength(content, "utf8") <= limit) return content;
  // Cut on a byte bound, then drop a trailing partial character rather than
  // storing a replacement glyph the person never wrote.
  return Buffer.from(content, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD+$/u, "");
}

function dedupeAttachments(attachments: readonly ManagementAttachmentRef[]): ManagementAttachmentRef[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.kind}:${attachment.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((attachment) => ({ ...attachment }));
}

/**
 * Sums what the turns actually reported. A turn whose model carries no
 * published rates leaves the cost incomplete rather than counting as zero.
 */
function accumulateUsage(
  usage: WorkFoldRequestRecord["usage"],
  turn: WorkFoldDurableTurnUsage,
): WorkFoldRequestRecord["usage"] {
  const next: WorkFoldRequestRecord["usage"] = {
    turns: usage.turns + 1,
    inputTokens: usage.inputTokens + turn.inputTokens,
    outputTokens: usage.outputTokens + turn.outputTokens,
    amountUsdComplete: usage.amountUsdComplete && turn.amountUsd !== undefined,
  };
  const amount = (usage.amountUsd ?? 0) + (turn.amountUsd ?? 0);
  if (usage.amountUsd !== undefined || turn.amountUsd !== undefined) next.amountUsd = amount;
  return next;
}

function copyRecord(record: WorkFoldRequestRecord): WorkFoldRequestRecord {
  return structuredClone(record);
}

async function loadSettings(path: string): Promise<{ settings: RequestSettingsFile; existed: boolean; damaged: boolean }> {
  const fallback: RequestSettingsFile = {
    version: 1,
    lastPurgeAt: null,
    continuationsEnabled: workFoldRequestContinuationsDefaultEnabled,
  };
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return { settings: fallback, existed: false, damaged: false };
  try {
    const parsed = JSON.parse(raw) as Partial<RequestSettingsFile> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).some((key) => !["version", "lastPurgeAt", "continuationsEnabled"].includes(key))
      || parsed.version !== 1
      || typeof parsed.continuationsEnabled !== "boolean"
      || (parsed.lastPurgeAt !== null && parsed.lastPurgeAt !== undefined
        && (typeof parsed.lastPurgeAt !== "string" || !Number.isFinite(Date.parse(parsed.lastPurgeAt))))) {
      return { settings: fallback, existed: true, damaged: true };
    }
    return {
      settings: { version: 1, lastPurgeAt: parsed.lastPurgeAt ?? null, continuationsEnabled: parsed.continuationsEnabled },
      existed: true,
      damaged: false,
    };
  } catch {
    return { settings: fallback, existed: true, damaged: true };
  }
}

/** Temp file, fsync, rename; 0o600 like the other machine-local stores. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
