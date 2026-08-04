/**
 * In-process authority the act-lane executor calls to apply commands. The
 * interactive local API implements this interface inside `startLocalApi`
 * (where the chat runtime state lives) and exposes it on `LocalApiHandle`;
 * the desktop CLI host receives it through a getter that answers null while
 * the interactive app is not running. Methods throw `WorkFoldCliError` so
 * exit codes map without translation.
 */

import type {
  WorkFoldCheckDecision,
  WorkFoldCheckDecisionKind,
  WorkFoldCheckFinding,
  WorkFoldCheckRunRecord,
} from "../checks/check-types.js";
import type { ManagementAttachmentRef } from "../management-attachments.js";
import type {
  ManagementAttachmentDisposition,
  ManagementRequestAction,
} from "../management-requests.js";

export interface WorkFoldActSpaceRef {
  id: string;
  name: string;
  spaceRoot: string;
}

export interface WorkFoldActConversationRef {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export type WorkFoldActChatState = "idle" | "running" | "compacting";

/**
 * Task-scoped view of one accepted Assistant turn. `unknown` means the app
 * run holding the record has ended or the id was never accepted here — turn
 * outcomes are kept in memory for the app run; transcripts stay durable.
 */
export type WorkFoldActTurnState = "running" | "succeeded" | "failed" | "aborted" | "unknown";

export interface WorkFoldActTurnStatus {
  taskId: string;
  state: WorkFoldActTurnState;
  conversationId: string | null;
  messageId: string | null;
  error: string | null;
  endedAt: string | null;
}

export interface WorkFoldActChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  interrupted?: true;
}

/**
 * Phase of one management request. `working` is the management turn itself;
 * `handed_off` means the management turn finished but a Space Assistant turn
 * it started is still running — "done" is never claimed while downstream work
 * continues. `needs_you` reflects a completed turn whose reply ends by asking
 * the person a question.
 */
export type WorkFoldActManagementRequestPhase =
  | "working"
  | "needs_you"
  | "handed_off"
  | "done"
  | "failed"
  | "stopped";

export interface WorkFoldActManagementChildStatus {
  taskId: string;
  spaceId: string;
  spaceName: string;
  conversationId: string;
  state: WorkFoldActTurnState;
  error: string | null;
}

export interface WorkFoldActManagementRequest {
  taskId: string;
  conversationId: string;
  phase: WorkFoldActManagementRequestPhase;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  content: string;
  attachments: ManagementAttachmentRef[];
  dispositions: ManagementAttachmentDisposition[];
  actions: ManagementRequestAction[];
  children: WorkFoldActManagementChildStatus[];
  reply: { messageId: string; content: string } | null;
  source: "local" | "remote_web";
  remotePrincipalId: string | null;
  remoteRequestId: string | null;
}

export interface WorkFoldActCheckTaskStatus {
  taskId: string;
  runId: string | null;
  state: WorkFoldCheckRunRecord["state"] | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface WorkFoldActFacade {
  createConversation(input: { space: string }): Promise<{ space: WorkFoldActSpaceRef; conversation: WorkFoldActConversationRef }>;
  listConversations(input: { space: string }): Promise<{ space: WorkFoldActSpaceRef; conversations: WorkFoldActConversationRef[] }>;
  sendMessage(input: {
    space: string;
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Explicit active management request that initiated this action. */
    parentTaskId?: string;
  }): Promise<{ space: WorkFoldActSpaceRef; conversationId: string; messageId: string; taskId: string }>;
  conversationStatus(input: { space: string; conversationId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    state: WorkFoldActChatState;
  }>;
  conversationResult(input: { space: string; conversationId: string; messages?: number }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    state: WorkFoldActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkFoldActChatMessage[];
  }>;
  abortTurn(input: { space: string; conversationId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    aborted: boolean;
  }>;
  turnStatus(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    task: WorkFoldActTurnStatus;
  }>;
  turnResult(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkFoldActChatMessage;
  }>;
  createSpace(input: { name: string; parentTaskId?: string }): Promise<{ space: WorkFoldActSpaceRef }>;
  registerSpace(input: { spaceRoot: string; parentTaskId?: string }): Promise<{ space: WorkFoldActSpaceRef }>;
  addFiles(input: { space: string; fromPaths: string[]; toDir?: string; cwd: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    copied: string[];
    checkpointId: string | null;
  }>;

  /**
   * Experimental Checks act surface. All methods resolve an explicit Space;
   * declarations remain inert until `checksEnable` imports one proposal, and
   * runs remain task-scoped so polling and abort never depend on ambient UI
   * state.
   */
  checksEnable(input: { space: string; proposalPath: string; cwd: string }): Promise<{
    space: WorkFoldActSpaceRef;
    check: {
      id: string;
      title: string;
      severity: WorkFoldCheckFinding["severity"];
      sensorId: string;
      sensorRevision: number;
      targetCount: number;
      trigger: "manual";
      targets: Array<{
        kind: "file" | "tree";
        role: "primary" | "reference";
        path: string;
        recursive?: boolean;
        extensions?: string[];
      }>;
    };
    declarationDigest: string;
  }>;
  checksDisable(input: { space: string; checkId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkId: string;
    disabled: boolean;
  }>;
  checksRun(input: { space: string; checkId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    taskId: string;
    runId: string;
    checkIds: string[];
  }>;
  checksTask(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    task: WorkFoldActCheckTaskStatus;
  }>;
  checksResult(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    run: WorkFoldCheckRunRecord;
  }>;
  checksAbort(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    taskId: string;
    aborted: boolean;
  }>;
  checksProblems(input: { space: string; checkId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkId?: string;
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }>;
  checksDecide(input: {
    space: string;
    findingId: string;
    decision: WorkFoldCheckDecisionKind;
    deferUntil?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    findingId: string;
    decision: WorkFoldCheckDecision;
  }>;

  /**
   * Management scope: the conversation above all Spaces. It reuses the same
   * turn orchestration and Pi runtime as Space Chats, but its transcript is
   * machine-local application state, it carries no user Space's project
   * configuration (only work-fold's two app-owned management resources), and
   * its cross-Space hands are these same act commands.
   * Omitting conversationId targets the default (most recent active)
   * management conversation, creating it on first send.
   */
  manageList(): Promise<{ conversations: WorkFoldActConversationRef[] }>;
  manageSend(input: {
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Raw --attach values: absolute or cwd-relative paths, or http(s) links. */
    attachments?: string[];
    cwd?: string;
  }): Promise<{
    conversationId: string;
    messageId: string;
    taskId: string;
    attachments: ManagementAttachmentRef[];
  }>;
  manageConversationStatus(input: { conversationId?: string }): Promise<{
    conversation: WorkFoldActConversationRef;
    state: WorkFoldActChatState;
  }>;
  manageTurnStatus(input: { taskId: string }): Promise<{
    task: WorkFoldActTurnStatus;
    request: WorkFoldActManagementRequest | null;
  }>;
  /** Request-level stop: aborts the management turn and every recorded child turn still running. */
  manageStop(input: { taskId: string }): Promise<{
    taskId: string;
    managementAborted: boolean;
    children: Array<{ taskId: string; conversationId: string; spaceId: string; aborted: boolean }>;
  }>;
  manageConversationResult(input: { conversationId?: string; messages?: number }): Promise<{
    conversationId: string;
    state: WorkFoldActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkFoldActChatMessage[];
  }>;
  manageTurnResult(input: { taskId: string }): Promise<{
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkFoldActChatMessage;
  }>;
  manageAbort(input: { conversationId?: string }): Promise<{ conversationId: string; aborted: boolean }>;
}
