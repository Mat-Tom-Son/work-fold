import { maxManagementAttachments, type ManagementAttachmentRef } from "./management-attachments.js";

/**
 * In-memory record of one management request: a single accepted management
 * turn plus every explicitly attributed act-lane action the management
 * Assistant performed, and every Space Assistant turn it started. These rich
 * request projections live for the app run; the transcript, bounded turn
 * journal, and act receipts remain the durable records.
 *
 * The turn id is carried explicitly in act-command argv and checked while the
 * parent is active. This avoids crediting an unrelated same-user CLI command
 * merely because a management turn happened to be running at the same time.
 */
export type ManagementRequestOutcome = "succeeded" | "failed" | "aborted";

/**
 * Every landed act-lane mutation verb (docs/fold-act-ledger.md). The registry
 * records one entry per explicitly attributed act so the request's story stays
 * complete; consumers render the commands they understand and fall back to the
 * command token for the rest. Act reads (status, result, list, search,
 * versions, glance) are deliberately absent — reads carry no lineage.
 */
export type ManagementRequestActionCommand =
  | "spaces.assistant.model"
  | "spaces.assistant.instructions"
  | "chat.send"
  | "chat.rename"
  | "chat.snooze"
  | "chat.archive"
  | "chat.resume"
  | "chat.compact"
  | "history.save"
  | "history.restore"
  | "history.restore-file"
  | "files.add"
  | "files.move"
  | "files.rename"
  | "files.delete"
  | "files.destroy"
  | "files.mkdir"
  | "files.create"
  | "library.add"
  | "library.folder.create"
  | "library.copy"
  | "spaces.create"
  | "spaces.register"
  | "spaces.rename"
  | "spaces.unregister"
  | "spaces.delete"
  | "spaces.appearance.apply"
  | "spaces.appearance.reset"
  | "spaces.appearance.undo"
  | "tools.import-skill"
  | "tools.install"
  | "tools.update"
  | "tools.remove"
  | "apps.proposals.dismiss"
  | "apps.install-proposal"
  | "apps.remove"
  | "apps.grant"
  | "apps.revoke"
  | "apps.connect"
  | "apps.disconnect"
  | "apps.automation.enable"
  | "apps.automation.disable"
  | "apps.automation.run"
  | "apps.storage.clear"
  | "apps.retained.purge"
  | "apps.project.declare"
  | "apps.release.prepare"
  | "apps.release.publish"
  | "apps.release.delete"
  | "apps.install.prepare"
  | "apps.update.prepare"
  | "apps.operation.activate"
  | "apps.operation.cancel"
  | "apps.uninstall"
  | "routings.stage"
  | "pages.stage"
  | "pages.stage-app"
  | "staged.cancel";

export interface ManagementRequestAction {
  command: ManagementRequestActionCommand;
  at: string;
  /**
   * Absent exactly for Space-free acts: the personal Library verbs and
   * personal-scope tools removal. Every Space-bound act names its Space.
   */
  spaceId?: string;
  spaceName?: string;
  /** Resolved absolute source paths for files.add; used to match dispositions. */
  sources?: string[];
  /** Space-relative destinations reported by files.add. */
  copied?: string[];
  checkpointId?: string | null;
  /** Registered or created Space root. */
  spaceRoot?: string;
  conversationId?: string;
  taskId?: string;
  /**
   * Staged-act id for consecration staging verbs and `staged cancel`
   * (docs/fold-consecrations.md): the staged act and its pending decision
   * share one identity, so the request's action trail can point at the card.
   */
  decisionId?: string;
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
  source: "local" | "remote_web";
  remotePrincipalId: string | null;
  remoteGrantId: string | null;
  remoteRequestId: string | null;
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
    source?: "local" | "remote_web";
    remotePrincipalId?: string;
    remoteGrantId?: string;
    remoteRequestId?: string;
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
      source: input.source ?? "local",
      remotePrincipalId: input.remotePrincipalId ?? null,
      remoteGrantId: input.remoteGrantId ?? null,
      remoteRequestId: input.remoteRequestId ?? null,
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
    const record = this.#records.get(taskId);
    return this.#active.has(taskId) && record !== undefined && record.stopRequestedAt === null;
  }

  /** Attributes an action to one explicit request id. */
  recordAction(parentTaskId: string | undefined, action: ManagementRequestAction): string | null {
    if (!parentTaskId) return null;
    const record = this.#records.get(parentTaskId);
    if (!record || record.actions.length >= maxManagementRequestActions) return null;
    record.actions.push(action);
    if (action.command === "chat.send" && action.taskId && action.conversationId
      && action.spaceId !== undefined && action.spaceName !== undefined) {
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

  /**
   * Every retained request record, oldest first (the registry is already
   * bounded to the newest hundred). Copies only — the glance and other
   * projections must never mutate the registry's own records.
   */
  list(): ManagementRequestRecord[] {
    return [...this.#records.values()].map((record) => ({
      ...record,
      attachments: [...record.attachments],
      actions: record.actions.map((action) => ({ ...action })),
      childTasks: record.childTasks.map((child) => ({ ...child })),
    }));
  }

  latestForConversation(conversationId: string): ManagementRequestRecord | null {
    let latest: ManagementRequestRecord | null = null;
    for (const record of this.#records.values()) {
      if (record.conversationId === conversationId) latest = record;
    }
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
