import { isAbsolute, resolve } from "node:path";

import {
  WorkFoldCliError,
  normalizeWorkFoldCliRequestId,
  parseBoundedCliArgv,
  parseWorkFoldCliRequest,
  WORKFOLD_CLI_ACT_TOKEN_PATTERN,
  type WorkFoldCliRequestV1,
} from "./protocol.js";

/**
 * The act lane is the separately versioned mutation surface for the installed
 * CLI. It shares the hardened request-file broker with read-only protocol v1,
 * but every act request must carry the per-launch act token minted while the
 * interactive work-fold app is running; without that token the desktop host
 * answers "unavailable" and nothing is mutated. Responses stay on the
 * lane-neutral v1 response contract so shims and the broker keep exactly one
 * response and error path. Version 3 advanced when the verbs that install
 * code, widen a power, or destroy data stopped returning a pending decision
 * and started returning their receipted result (docs/receipts-not-gates.md);
 * an older shim is refused with the typed version error instead of receiving
 * a silently different result.
 *
 * The collaboration verbs (docs/collaboration-contract.md, F27/F28) do not
 * advance it, and that is deliberate rather than an oversight: adding
 * `chat report|ask|answer|handoff` and the `requests` family changes the
 * meaning of no existing response, so an older shim running a newer host
 * keeps every verb it already had. The one surface that does change is the
 * shim-side wait loop, which learns to settle on a task that is waiting on an
 * answer; a shim that has not learned it still sees a terminal turn state and
 * prints the Assistant's question, which is honest rather than wrong.
 */
export const WORKFOLD_CLI_ACT_PROTOCOL_VERSION = 3 as const;

/** Bound for `payload.messageFile` text (UTF-8 bytes), kept out of argv. */
export const WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES = 256 * 1024;

/** File-level bound for a serialized act request (JSON-escape headroom). */
export const WORKFOLD_CLI_MAX_ACT_REQUEST_BYTES = 2 * 1024 * 1024;

export interface WorkFoldCliActRequestPayload {
  /** UTF-8 text supplied through `--message-file`, embedded by the shim. */
  messageFile?: string;
}

/** Stable on-disk act request contract shared by platform shims and the desktop broker. */
export interface WorkFoldCliActRequest {
  protocolVersion: typeof WORKFOLD_CLI_ACT_PROTOCOL_VERSION;
  lane: "act";
  id: string;
  argv: string[];
  cwd: string;
  createdAt: string;
  actToken: string;
  payload?: WorkFoldCliActRequestPayload;
}

export type WorkFoldCliBrokeredRequest = WorkFoldCliRequestV1 | WorkFoldCliActRequest;

export function isWorkFoldCliActRequest(request: WorkFoldCliBrokeredRequest): request is WorkFoldCliActRequest {
  return request.protocolVersion === WORKFOLD_CLI_ACT_PROTOCOL_VERSION;
}

/**
 * Dispatches a raw request document to the lane that owns its version.
 * Protocol v1 parsing stays byte-for-byte unchanged; unsupported versions
 * fail with v1's stable "Unsupported CLI protocol version" error. A request
 * that declares the act lane at any version is answered by the act parser,
 * so an older act shim hears the act version error rather than v1's
 * unsupported-field complaint.
 */
export function parseWorkFoldCliRequestEnvelope(value: unknown): WorkFoldCliBrokeredRequest {
  const record = objectRecord(value, "CLI request must be a JSON object.");
  if (record.protocolVersion === WORKFOLD_CLI_ACT_PROTOCOL_VERSION || record.lane === "act") return parseWorkFoldCliActRequest(record);
  return parseWorkFoldCliRequest(value);
}

export function parseWorkFoldCliActRequest(value: unknown): WorkFoldCliActRequest {
  const record = objectRecord(value, "CLI act request must be a JSON object.");
  assertKeys(record, ["protocolVersion", "lane", "id", "argv", "cwd", "createdAt", "actToken"], ["payload"], "CLI act request");
  if (record.protocolVersion !== WORKFOLD_CLI_ACT_PROTOCOL_VERSION) {
    throw new WorkFoldCliError(
      "protocolError",
      `Unsupported CLI act protocol version: ${String(record.protocolVersion)}. Expected ${WORKFOLD_CLI_ACT_PROTOCOL_VERSION}.`,
    );
  }
  if (record.lane !== "act") throw new WorkFoldCliError("protocolError", "CLI act request lane must be \"act\".");
  if (typeof record.id !== "string") throw new WorkFoldCliError("protocolError", "CLI act request id must be a string.");
  const id = normalizeWorkFoldCliRequestId(record.id);
  const argv = parseBoundedCliArgv(record.argv);
  if (typeof record.cwd !== "string" || !record.cwd.trim() || !isAbsolute(record.cwd)) {
    throw new WorkFoldCliError("protocolError", "CLI act request cwd must be an absolute path.");
  }
  if (record.cwd.includes("\u0000")) throw new WorkFoldCliError("protocolError", "CLI act request cwd contains an invalid character.");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new WorkFoldCliError("protocolError", "CLI act request createdAt must be an ISO timestamp.");
  }
  if (typeof record.actToken !== "string" || !WORKFOLD_CLI_ACT_TOKEN_PATTERN.test(record.actToken)) {
    throw new WorkFoldCliError("protocolError", "CLI act request token is malformed.");
  }
  return {
    protocolVersion: WORKFOLD_CLI_ACT_PROTOCOL_VERSION,
    lane: "act",
    id,
    argv,
    cwd: resolve(record.cwd),
    createdAt: new Date(record.createdAt).toISOString(),
    actToken: record.actToken,
    ...(record.payload !== undefined ? { payload: parseActPayload(record.payload) } : {}),
  };
}

export function createWorkFoldCliActRequest(input: {
  id: string;
  argv: string[];
  cwd: string;
  actToken: string;
  createdAt?: string;
  payload?: WorkFoldCliActRequestPayload;
}): WorkFoldCliActRequest {
  return parseWorkFoldCliActRequest({
    protocolVersion: WORKFOLD_CLI_ACT_PROTOCOL_VERSION,
    lane: "act",
    id: input.id,
    argv: input.argv,
    cwd: input.cwd,
    createdAt: input.createdAt ?? new Date().toISOString(),
    actToken: input.actToken,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  });
}

function parseActPayload(value: unknown): WorkFoldCliActRequestPayload {
  const record = objectRecord(value, "CLI act request payload must be a JSON object.");
  assertKeys(record, [], ["messageFile"], "CLI act request payload");
  if (record.messageFile === undefined) return {};
  if (typeof record.messageFile !== "string" || record.messageFile.includes("\u0000")) {
    throw new WorkFoldCliError("protocolError", "CLI act request messageFile must be text.");
  }
  if (Buffer.byteLength(record.messageFile, "utf8") > WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES) {
    throw new WorkFoldCliError("protocolError", `CLI act request messageFile exceeds ${WORKFOLD_CLI_ACT_MAX_PAYLOAD_BYTES} bytes.`);
  }
  return { messageFile: record.messageFile };
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkFoldCliError("protocolError", message);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new WorkFoldCliError("protocolError", `${label} contains unsupported field: ${unexpected[0]}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new WorkFoldCliError("protocolError", `${label} is missing required field: ${missing[0]}.`);
}
