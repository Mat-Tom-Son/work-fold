import { maxManagementAttachments, type ManagementAttachmentRef } from "./management-attachments.js";

/**
 * In-memory record of one management request: a single accepted management
 * turn plus every explicitly attributed act-lane action the management
 * Assistant performed, and every Space Assistant turn it started. Records live for the app
 * run, like settled turn outcomes; the transcript and the act receipts
 * journal remain the durable records.
 *
 * The turn id is carried explicitly in act-command argv and checked while the
 * parent is active. This avoids crediting an unrelated same-user CLI command
 * merely because a management turn happened to be running at the same time.
 */
export type ManagementRequestOutcome = "succeeded" | "failed" | "aborted";

export type ManagementRequestActionCommand = "files.add" | "spaces.create" | "spaces.register" | "chat.send";

export interface ManagementRequestAction {
  command: ManagementRequestActionCommand;
  at: string;
  spaceId: string;
  spaceName: string;
  /** Resolved absolute source paths for files.add; used to match dispositions. */
  sources?: string[];
  /** Space-relative destinations reported by files.add. */
  copied?: string[];
  checkpointId?: string | null;
  /** Registered or created Space root. */
  spaceRoot?: string;
  conversationId?: string;
  taskId?: string;
}

export interface ManagementChildTaskRef {
  taskId: string;
  spaceId: string;
  spaceName: string;
  conversationId: string;
}

export interface ManagementRequestRecord {
  taskId: string;
  conversationId: string;
  content: string;
  attachments: ManagementAttachmentRef[];
  startedAt: string;
  endedAt: string | null;
  outcome: ManagementRequestOutcome | null;
  stopRequestedAt: string | null;
  continuedFromTaskId: string | null;
  actions: ManagementRequestAction[];
  childTasks: ManagementChildTaskRef[];
}

export type ManagementAttachmentDispositionStatus = "placed" | "registered" | "unrecorded";

export interface ManagementAttachmentDisposition {
  attachment: ManagementAttachmentRef;
  status: ManagementAttachmentDispositionStatus;
  spaceId?: string;
  spaceName?: string;
  copied?: string[];
  checkpointId?: string | null;
}

const maxManagementRequestRecords = 100;
const maxManagementRequestActions = 200;

export class ManagementRequestRegistry {
  #records = new Map<string, ManagementRequestRecord>();
  #active = new Set<string>();

  begin(input: {
    taskId: string;
    conversationId: string;
    content: string;
    attachments: ManagementAttachmentRef[];
    continuedFromTaskId?: string;
  }): ManagementRequestRecord {
    const previous = input.continuedFromTaskId
      ? this.#records.get(input.continuedFromTaskId) ?? null
      : null;
    const record: ManagementRequestRecord = {
      taskId: input.taskId,
      conversationId: input.conversationId,
      content: input.content,
      attachments: previous
        ? dedupeAttachments([...previous.attachments, ...input.attachments]).slice(0, maxManagementAttachments)
        : [...input.attachments],
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: null,
      stopRequestedAt: null,
      continuedFromTaskId: previous?.taskId ?? null,
      actions: previous ? previous.actions.map((action) => ({ ...action })) : [],
      childTasks: previous ? previous.childTasks.map((child) => ({ ...child })) : [],
    };
    this.#records.set(input.taskId, record);
    this.#active.add(input.taskId);
    while (this.#records.size > maxManagementRequestRecords) {
      const oldestSettled = [...this.#records.keys()].find((taskId) => !this.#active.has(taskId));
      if (!oldestSettled) break;
      this.#records.delete(oldestSettled);
    }
    return record;
  }

  finish(taskId: string, outcome: ManagementRequestOutcome): void {
    this.#active.delete(taskId);
    const record = this.#records.get(taskId);
    if (!record || record.outcome !== null) return;
    record.outcome = outcome;
    record.endedAt = new Date().toISOString();
  }

  isActive(taskId: string): boolean {
    return this.#active.has(taskId) && this.#records.has(taskId);
  }

  /** Attributes an action to one explicit request id. */
  recordAction(parentTaskId: string | undefined, action: ManagementRequestAction): string | null {
    if (!parentTaskId) return null;
    const record = this.#records.get(parentTaskId);
    if (!record || record.actions.length >= maxManagementRequestActions) return null;
    record.actions.push(action);
    if (action.command === "chat.send" && action.taskId && action.conversationId) {
      record.childTasks.push({
        taskId: action.taskId,
        spaceId: action.spaceId,
        spaceName: action.spaceName,
        conversationId: action.conversationId,
      });
    }
    return parentTaskId;
  }

  markStopRequested(taskId: string): void {
    const record = this.#records.get(taskId);
    if (record && record.stopRequestedAt === null) record.stopRequestedAt = new Date().toISOString();
  }

  get(taskId: string): ManagementRequestRecord | null {
    return this.#records.get(taskId) ?? null;
  }

  latest(): ManagementRequestRecord | null {
    let latest: ManagementRequestRecord | null = null;
    for (const record of this.#records.values()) latest = record;
    return latest;
  }
}

function dedupeAttachments(attachments: ManagementAttachmentRef[]): ManagementAttachmentRef[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.kind}:${attachment.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Accounts for every attachment against the recorded actions. Nothing may
 * silently disappear from the story: an attachment with no mechanically
 * matched action is reported as `unrecorded`, and the Assistant's own report
 * remains the narrative for it.
 */
export function managementAttachmentDispositions(record: ManagementRequestRecord): ManagementAttachmentDisposition[] {
  return record.attachments.map((attachment) => {
    if (attachment.kind !== "url") {
      const placed = record.actions.find((action) =>
        action.command === "files.add" && action.sources?.includes(attachment.target));
      if (placed) {
        return {
          attachment,
          status: "placed" as const,
          spaceId: placed.spaceId,
          spaceName: placed.spaceName,
          copied: placed.copied ?? [],
          checkpointId: placed.checkpointId ?? null,
        };
      }
      const registered = record.actions.find((action) =>
        action.command === "spaces.register" && action.spaceRoot === attachment.target);
      if (registered) {
        return {
          attachment,
          status: "registered" as const,
          spaceId: registered.spaceId,
          spaceName: registered.spaceName,
        };
      }
    }
    return { attachment, status: "unrecorded" as const };
  });
}
