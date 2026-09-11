/**
 * The host-owned identity a Space turn receives in its hidden context
 * (docs/collaboration-contract.md, F26): this Space's id, this turn's task
 * id, the durable request it belongs to (F25), and — only when another
 * request delegated the work — an opaque handle for that request plus the
 * assignment it sent.
 *
 * The parent handle is derived, never the parent's real task or request id.
 * The parent is usually the fold's management turn: handing a Space Assistant
 * the raw parent task id would let it act with the fold's lineage through
 * `--parent-task`, and handing it the parent request id would let it read the
 * request graph a management-scope verb exposes. Either is an F9 leak one
 * command away, so the handle is a per-launch keyed hash that no verb accepts.
 *
 * Pure and synchronous: no filesystem, no store, no server import.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** The chat-message bound; an assignment longer than this is cut and says so. */
export const spaceTurnAssignmentMaxBytes = 16 * 1024;

export interface PiSpaceTurnDelegation {
  /** Opaque, machine-local handle for the request that delegated this work. */
  parentHandle: string;
  /** The assignment text released into this Space. */
  assignment?: string;
  /** True when the assignment is this turn's own message; the text is not repeated. */
  assignmentIsThisMessage?: boolean;
  /** True when the assignment text was cut at the bound. */
  assignmentTruncated?: boolean;
}

export interface PiSpaceTurnContext {
  /** This Space's own id — never another Space's, never the registry. */
  spaceId: string;
  /** This turn's task id; the only id `--task` accepts. */
  taskId: string;
  /** The durable request this turn belongs to (F25). */
  requestId: string;
  /**
   * The question this turn's message answers, when it is a continuation
   * (F27). A request may hold several open questions at once, and the answer
   * arrives as ordinary message text, so the link belongs in host-built
   * context rather than only in the travelling transcript.
   */
  answeredQuestionId?: string;
  delegated?: PiSpaceTurnDelegation;
}

export interface SpaceTurnContextInput {
  spaceId: string;
  taskId: string;
  requestId: string;
  answeredQuestionId?: string;
  parentTaskId?: string;
  assignment?: string;
  assignmentIsThisMessage?: boolean;
  /** Minted once per app launch; a handle is a conversational reference, not a key. */
  handleSalt: string;
}

export function spaceTurnParentHandle(parentTaskId: string, handleSalt: string): string {
  if (!handleSalt.trim()) throw new Error("A parent handle needs a non-empty salt.");
  if (!parentTaskId.trim()) throw new Error("A parent handle needs a parent task id.");
  return `parent-${createHash("sha256").update(`${handleSalt} ${parentTaskId}`).digest("hex").slice(0, 16)}`;
}

export function buildSpaceTurnContext(input: SpaceTurnContextInput): PiSpaceTurnContext {
  const spaceId = requireId(input.spaceId, "Space id");
  const taskId = requireId(input.taskId, "task id");
  const requestId = requireId(input.requestId, "request id");
  const context: PiSpaceTurnContext = { spaceId, taskId, requestId };
  const answeredQuestionId = input.answeredQuestionId?.trim();
  if (answeredQuestionId) context.answeredQuestionId = answeredQuestionId;
  const parentTaskId = input.parentTaskId?.trim();
  if (!parentTaskId) return context;
  const delegated: PiSpaceTurnDelegation = { parentHandle: spaceTurnParentHandle(parentTaskId, input.handleSalt) };
  if (input.assignmentIsThisMessage) {
    delegated.assignmentIsThisMessage = true;
  } else if (input.assignment !== undefined) {
    const bounded = boundAssignment(input.assignment);
    delegated.assignment = bounded.text;
    if (bounded.truncated) delegated.assignmentTruncated = true;
  } else {
    delegated.assignmentIsThisMessage = true;
  }
  context.delegated = delegated;
  return context;
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`A Space turn context needs a ${label}.`);
  return trimmed;
}

function boundAssignment(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= spaceTurnAssignmentMaxBytes) return { text, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, spaceTurnAssignmentMaxBytes).toString("utf8").replace(/�+$/u, "");
  return { text: cut, truncated: true };
}
