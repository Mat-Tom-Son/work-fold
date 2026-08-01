import { timingSafeEqual } from "node:crypto";

import type {
  WorkFoldActChatMessage,
  WorkFoldActCheckTaskStatus,
  WorkFoldActConversationRef,
  WorkFoldActFacade,
} from "./act-facade.js";
import type {
  WorkFoldCheckDecisionKind,
  WorkFoldCheckEvidence,
  WorkFoldCheckFinding,
} from "../checks/check-types.js";
import type { WorkFoldCliActRequestV2 } from "./act-protocol.js";
import type { WorkFoldCliActReceipts } from "./act-receipts.js";
import {
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliResponse,
  type WorkFoldCliJson,
  type WorkFoldCliOutputMode,
  type WorkFoldCliResponseV1,
} from "./protocol.js";

export type WorkFoldCliActCommandName =
  | "chat.create"
  | "chat.send"
  | "chat.status"
  | "chat.result"
  | "chat.abort"
  | "chats.list"
  | "manage.send"
  | "manage.status"
  | "manage.result"
  | "manage.abort"
  | "manage.stop"
  | "manage.list"
  | "checks.enable"
  | "checks.disable"
  | "checks.run"
  | "checks.task"
  | "checks.result"
  | "checks.abort"
  | "checks.problems"
  | "checks.decide"
  | "spaces.create"
  | "spaces.register"
  | "files.add";

export interface WorkFoldCliActParsedCommand {
  name: WorkFoldCliActCommandName;
  output: WorkFoldCliOutputMode;
  space?: string;
  conversation?: string;
  task?: string;
  /** Explicit management request lineage for downstream mutation commands. */
  parentTaskId?: string;
  newConversation?: boolean;
  message?: string;
  messageFromPayload?: boolean;
  messages?: number;
  spaceName?: string;
  registerPath?: string;
  fromPaths?: string[];
  /** Raw --attach values for manage send: paths or http(s) links. */
  attachments?: string[];
  toDir?: string;
  proposalPath?: string;
  check?: string;
  finding?: string;
  decision?: WorkFoldCheckDecisionKind;
  until?: string;
}

/** The running interactive app's act authority: the facade plus this run's token. */
export interface WorkFoldCliActAuthority {
  facade: WorkFoldActFacade;
  token: string;
}

export interface WorkFoldCliActExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
  getActFacade: () => WorkFoldCliActAuthority | null;
  receipts: Pick<WorkFoldCliActReceipts, "append" | "hasAccepted">;
  /** Resolves an explicitly named management parent only while it is active. */
  resolveLineageParent?: (taskId: string) => { taskId: string } | null;
}

export const workFoldCliActUnavailableMessage =
  "Open work-fold to run this command. Chat, Check, and Space actions need the work-fold app running.";

const maxActResultMessages = 500;
const maxActFromPaths = 25;
const maxChecksCliIdLength = 256;
const maxChecksProposalPathLength = 4_096;
const maxChecksOutputFindings = 100;
const maxChecksOutputHealthErrors = 20;

/**
 * Parses act-lane argv. Every command requires explicit selection — there is
 * deliberately no current-directory Space resolution for writes.
 */
export function parseWorkFoldCliActArgv(argv: readonly string[]): WorkFoldCliActParsedCommand {
  let output: WorkFoldCliOutputMode = "human";
  const flags = new Map<string, string | true>();
  const fromPaths: string[] = [];
  const attachValues: string[] = [];
  const positional: string[] = [];

  const valueFlags = new Set([
    "--space",
    "--conversation",
    "--task",
    "--parent-task",
    "--message",
    "--messages",
    "--name",
    "--path",
    "--from",
    "--attach",
    "--to",
    "--proposal",
    "--check",
    "--finding",
    "--decision",
    "--until",
  ]);
  const booleanFlags = new Set(["--new", "--message-from-payload"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      output = "json";
      continue;
    }
    const equals = token.indexOf("=");
    const flagName = token.startsWith("--") && equals > 2 ? token.slice(0, equals) : token;
    if (valueFlags.has(flagName)) {
      let value: string | undefined;
      if (flagName !== token) {
        value = token.slice(equals + 1);
      } else {
        value = argv[index + 1];
        if (value === undefined || (value.startsWith("--") && value !== "--")) {
          throw usageError(`${flagName} requires a value.`);
        }
        index += 1;
      }
      if (flagName === "--from") {
        fromPaths.push(value);
        continue;
      }
      if (flagName === "--attach") {
        attachValues.push(value);
        continue;
      }
      if (flags.has(flagName)) throw usageError(`${flagName} may be provided only once.`);
      flags.set(flagName, value);
      continue;
    }
    if (booleanFlags.has(token)) {
      if (flags.has(token)) throw usageError(`${token} may be provided only once.`);
      flags.set(token, true);
      continue;
    }
    if (token.startsWith("-")) throw usageError(`Unknown option: ${token}`);
    positional.push(token);
  }

  const command = positional.join(" ");
  if (command !== "files add" && fromPaths.length) {
    throw usageError(`--from cannot be used with '${command || "(none)"}'.`);
  }
  if (command !== "manage send" && attachValues.length) {
    throw usageError(`--attach cannot be used with '${command || "(none)"}'.`);
  }
  const stringFlag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const requireSpace = (): string => {
    const space = stringFlag("--space")?.trim();
    if (!space) throw usageError("Act commands require an explicit --space <id-or-name>.");
    return space;
  };
  const requireConversation = (): string => {
    const conversation = stringFlag("--conversation")?.trim();
    if (!conversation) throw usageError("Provide --conversation <id>.");
    return conversation;
  };
  const requireConversationOrTask = (): { conversation?: string; task?: string } => {
    const conversation = stringFlag("--conversation")?.trim();
    const task = stringFlag("--task")?.trim();
    if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
    if (!conversation && !task) throw usageError("Provide --conversation <id> or --task <id>.");
    return conversation ? { conversation } : { task };
  };
  const rejectFlags = (...names: string[]) => {
    for (const name of names) if (flags.has(name)) throw usageError(`${name} cannot be used with '${command}'.`);
  };
  const allowOnlyFlags = (...names: string[]) => {
    const allowed = new Set(names);
    for (const name of flags.keys()) {
      if (!allowed.has(name)) throw usageError(`${name} cannot be used with '${command}'.`);
    }
  };
  const requireBoundedFlag = (name: string, label: string, maximumLength = maxChecksCliIdLength): string => {
    const value = stringFlag(name)?.trim();
    if (!value) throw usageError(`Provide ${name} <${label}>.`);
    if (value.length > maximumLength) throw usageError(`${name} must be at most ${maximumLength} characters.`);
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
      throw usageError(`${name} contains unsupported control characters.`);
    }
    return value;
  };
  const rawParentTaskId = stringFlag("--parent-task");
  const lineageCommands = new Set(["chat send", "spaces create", "spaces register", "files add"]);
  if (rawParentTaskId !== undefined && !lineageCommands.has(command)) {
    throw usageError(`--parent-task cannot be used with '${command || "(none)"}'.`);
  }
  const parentTaskId = rawParentTaskId === undefined
    ? undefined
    : requireBoundedFlag("--parent-task", "management-task-id");

  if (!command.startsWith("checks ")) {
    rejectFlags("--proposal", "--check", "--finding", "--decision", "--until");
  }

  switch (command) {
    case "chat create":
      rejectFlags("--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      return { name: "chat.create", output, space: requireSpace() };
    case "chat send": {
      rejectFlags("--task", "--messages", "--name", "--path", "--to");
      const space = requireSpace();
      const newConversation = flags.get("--new") === true;
      const conversation = stringFlag("--conversation")?.trim();
      if (newConversation && conversation) throw usageError("Use either --conversation <id> or --new, not both.");
      if (!newConversation && !conversation) throw usageError("Provide --conversation <id> or --new.");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) {
        throw usageError("Use either --message <text> or --message-file <path>, not both.");
      }
      if (message === undefined && !messageFromPayload) {
        throw usageError("Provide --message <text> or --message-file <path>.");
      }
      return {
        name: "chat.send",
        output,
        space,
        ...(conversation ? { conversation } : {}),
        ...(newConversation ? { newConversation } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "chat status": {
      rejectFlags("--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      const selection = requireConversationOrTask();
      return { name: "chat.status", output, space: requireSpace(), ...selection };
    }
    case "chat result": {
      rejectFlags("--new", "--message", "--message-from-payload", "--name", "--path", "--to");
      const selection = requireConversationOrTask();
      const rawMessages = stringFlag("--messages");
      if (rawMessages !== undefined && selection.task) {
        throw usageError("--messages applies to --conversation results; a --task result is one message.");
      }
      let messages: number | undefined;
      if (rawMessages !== undefined) {
        messages = Number(rawMessages);
        if (!Number.isInteger(messages) || messages < 1 || messages > maxActResultMessages) {
          throw usageError(`--messages must be an integer between 1 and ${maxActResultMessages}.`);
        }
      }
      return {
        name: "chat.result",
        output,
        space: requireSpace(),
        ...selection,
        ...(messages !== undefined ? { messages } : {}),
      };
    }
    case "chat abort":
      rejectFlags("--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      return { name: "chat.abort", output, space: requireSpace(), conversation: requireConversation() };
    case "chat wait":
    case "manage wait":
    case "checks wait":
      throw usageError(`${command} runs inside the work-fold shim; update the installed work-fold CLI.`);
    case "checks enable":
      allowOnlyFlags("--space", "--proposal");
      return {
        name: "checks.enable",
        output,
        space: requireSpace(),
        proposalPath: requireBoundedFlag("--proposal", "proposal-path", maxChecksProposalPathLength),
      };
    case "checks disable":
      allowOnlyFlags("--space", "--check");
      return {
        name: "checks.disable",
        output,
        space: requireSpace(),
        check: requireBoundedFlag("--check", "check-id"),
      };
    case "checks run": {
      allowOnlyFlags("--space", "--check");
      const check = stringFlag("--check") === undefined
        ? undefined
        : requireBoundedFlag("--check", "check-id");
      return {
        name: "checks.run",
        output,
        space: requireSpace(),
        ...(check ? { check } : {}),
      };
    }
    case "checks task":
      allowOnlyFlags("--space", "--task");
      return {
        name: "checks.task",
        output,
        space: requireSpace(),
        task: requireBoundedFlag("--task", "task-id"),
      };
    case "checks result":
      allowOnlyFlags("--space", "--task");
      return {
        name: "checks.result",
        output,
        space: requireSpace(),
        task: requireBoundedFlag("--task", "task-id"),
      };
    case "checks abort":
      allowOnlyFlags("--space", "--task");
      return {
        name: "checks.abort",
        output,
        space: requireSpace(),
        task: requireBoundedFlag("--task", "task-id"),
      };
    case "checks problems": {
      allowOnlyFlags("--space", "--check");
      const check = stringFlag("--check") === undefined
        ? undefined
        : requireBoundedFlag("--check", "check-id");
      return {
        name: "checks.problems",
        output,
        space: requireSpace(),
        ...(check ? { check } : {}),
      };
    }
    case "checks decide": {
      allowOnlyFlags("--space", "--finding", "--decision", "--until");
      const finding = requireBoundedFlag("--finding", "finding-id");
      const rawDecision = requireBoundedFlag("--decision", "accept|reject|resolve|defer");
      if (!(["accept", "reject", "resolve", "defer"] as const).includes(rawDecision as WorkFoldCheckDecisionKind)) {
        throw usageError("--decision must be accept, reject, resolve, or defer.");
      }
      const decision = rawDecision as WorkFoldCheckDecisionKind;
      const rawUntil = stringFlag("--until")?.trim();
      if (decision !== "defer" && rawUntil !== undefined) {
        throw usageError("--until may be used only with --decision defer.");
      }
      if (decision === "defer" && !rawUntil) {
        throw usageError("--decision defer requires --until <ISO-timestamp>.");
      }
      let until: string | undefined;
      if (rawUntil !== undefined) {
        if (!Number.isFinite(Date.parse(rawUntil))) throw usageError("--until must be an ISO timestamp.");
        until = new Date(rawUntil).toISOString();
      }
      return {
        name: "checks.decide",
        output,
        space: requireSpace(),
        finding,
        decision,
        ...(until ? { until } : {}),
      };
    }
    case "manage send": {
      rejectFlags("--space", "--task", "--messages", "--name", "--path", "--to");
      const newConversation = flags.get("--new") === true;
      const conversation = stringFlag("--conversation")?.trim();
      if (newConversation && conversation) throw usageError("Use either --conversation <id> or --new, not both.");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) {
        throw usageError("Use either --message <text> or --message-file <path>, not both.");
      }
      if (message === undefined && !messageFromPayload) {
        throw usageError("Provide --message <text> or --message-file <path>.");
      }
      return {
        name: "manage.send",
        output,
        ...(conversation ? { conversation } : {}),
        ...(newConversation ? { newConversation } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(attachValues.length ? { attachments: [...attachValues] } : {}),
      };
    }
    case "manage stop": {
      rejectFlags("--space", "--conversation", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      const task = stringFlag("--task")?.trim();
      if (!task) throw usageError("Provide --task <id>.");
      return { name: "manage.stop", output, task };
    }
    case "manage status": {
      rejectFlags("--space", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      const conversation = stringFlag("--conversation")?.trim();
      const task = stringFlag("--task")?.trim();
      if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
      return {
        name: "manage.status",
        output,
        ...(conversation ? { conversation } : {}),
        ...(task ? { task } : {}),
      };
    }
    case "manage result": {
      rejectFlags("--space", "--new", "--message", "--message-from-payload", "--name", "--path", "--to");
      const conversation = stringFlag("--conversation")?.trim();
      const task = stringFlag("--task")?.trim();
      if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
      const rawMessages = stringFlag("--messages");
      if (rawMessages !== undefined && task) {
        throw usageError("--messages applies to conversation results; a --task result is one message.");
      }
      let messages: number | undefined;
      if (rawMessages !== undefined) {
        messages = Number(rawMessages);
        if (!Number.isInteger(messages) || messages < 1 || messages > maxActResultMessages) {
          throw usageError(`--messages must be an integer between 1 and ${maxActResultMessages}.`);
        }
      }
      return {
        name: "manage.result",
        output,
        ...(conversation ? { conversation } : {}),
        ...(task ? { task } : {}),
        ...(messages !== undefined ? { messages } : {}),
      };
    }
    case "manage abort":
      rejectFlags("--space", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      return {
        name: "manage.abort",
        output,
        ...(stringFlag("--conversation")?.trim() ? { conversation: stringFlag("--conversation")!.trim() } : {}),
      };
    case "manage list":
      rejectFlags("--space", "--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      return { name: "manage.list", output };
    case "chats list":
      rejectFlags("--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path", "--to");
      return { name: "chats.list", output, space: requireSpace() };
    case "spaces create": {
      rejectFlags("--space", "--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--path", "--to");
      const spaceName = stringFlag("--name")?.trim();
      if (!spaceName) throw usageError("Provide --name <space-name>.");
      return { name: "spaces.create", output, spaceName, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "spaces register": {
      rejectFlags("--space", "--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--to");
      const registerPath = stringFlag("--path")?.trim();
      if (!registerPath) throw usageError("Provide --path <absolute-folder-path>.");
      return { name: "spaces.register", output, registerPath, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "files add": {
      rejectFlags("--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--path");
      if (!fromPaths.length) throw usageError("Provide at least one --from <path>.");
      if (fromPaths.length > maxActFromPaths) throw usageError(`At most ${maxActFromPaths} --from sources are allowed.`);
      const toDir = stringFlag("--to");
      return {
        name: "files.add",
        output,
        space: requireSpace(),
        fromPaths: [...fromPaths],
        ...(toDir !== undefined ? { toDir } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    default:
      throw usageError(`Unknown command: ${command || "(none)"}`);
  }
}

export async function executeWorkFoldCliActRequest(
  request: WorkFoldCliActRequestV2,
  options: WorkFoldCliActExecutorOptions,
): Promise<WorkFoldCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: WorkFoldCliActParsedCommand | undefined;
  let accepted = false;
  let receiptParentTaskId: string | undefined;
  try {
    command = parseWorkFoldCliActArgv(request.argv);
    const authority = options.getActFacade();
    if (!authority || !tokensMatch(authority.token, request.actToken)) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "unavailable",
      });
      throw new WorkFoldCliError("unavailable", workFoldCliActUnavailableMessage);
    }
    // The broker's response-file dedup only covers a pending request; the
    // journal's accepted records are the durable at-most-once ledger.
    if (await options.receipts.hasAccepted(request.id)) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "conflict",
        detail: "duplicate act request id",
      });
      throw new WorkFoldCliError("conflict", "This act request id was already executed. Submit a new request instead of replaying it.");
    }
    // The accepted record lands before the mutation so a crash can never
    // leave an applied action without a journal trace; an unwritable journal
    // refuses the command entirely.
    const lineageParent = command.parentTaskId
      ? options.resolveLineageParent?.(command.parentTaskId) ?? null
      : null;
    if (command.parentTaskId && !lineageParent) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "conflict",
        parentTaskId: command.parentTaskId,
        detail: "inactive management parent",
      });
      throw new WorkFoldCliError("conflict", "The management request named by --parent-task is no longer active.");
    }
    receiptParentTaskId = lineageParent?.taskId;
    const lineage = receiptParentTaskId ? { parentTaskId: receiptParentTaskId } : {};
    const acceptedRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "accepted",
      ...lineage,
      ...(command.space ? { detail: `space ${command.space}` } : {}),
    });
    if (!acceptedRecorded) {
      throw new WorkFoldCliError("failure", "work-fold could not record the act receipt, so the command was not run.");
    }
    accepted = true;
    const data = await runActCommand(command, request, authority.facade);
    const outcomeRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "ok",
      ...lineage,
      ...receiptDetails(data),
    });
    return createWorkFoldCliResponse({
      id: request.id,
      exitCode: WorkFoldCliExitCode.success,
      stdout: command.output === "json"
        ? `${JSON.stringify({ ok: true, command: command.name, data }, null, 2)}\n`
        : humanActOutput(command.name, data),
      stderr: outcomeRecorded ? "" : "work-fold: warning: the act outcome receipt could not be recorded.\n",
      result: data,
      completedAt: completedAt(),
    });
  } catch (error) {
    const normalized = normalizeActError(error);
    if (accepted && command) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "error",
        errorCode: normalized.code,
        ...(receiptParentTaskId ? { parentTaskId: receiptParentTaskId } : {}),
      });
    }
    const json = command?.output === "json" || request.argv.includes("--json");
    return createWorkFoldCliResponse({
      id: request.id,
      exitCode: normalized.exitCode,
      stdout: "",
      stderr: json
        ? `${JSON.stringify({ ok: false, error: { code: normalized.code, message: terminalText(normalized.message) } }, null, 2)}\n`
        : `${humanActErrorMessage(normalized)}\n`,
      result: { ok: false, error: { code: normalized.code, message: terminalText(normalized.message) } },
      completedAt: completedAt(),
    });
  }
}

async function runActCommand(
  command: WorkFoldCliActParsedCommand,
  request: WorkFoldCliActRequestV2,
  facade: WorkFoldActFacade,
): Promise<WorkFoldCliJson> {
  switch (command.name) {
    case "chat.create":
      return toJson(await facade.createConversation({ space: command.space! }));
    case "chat.send": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toJson(await facade.sendMessage({
        space: command.space!,
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.newConversation ? { newConversation: true } : {}),
        content,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    }
    case "chat.status":
      return command.task
        ? toJson(await facade.turnStatus({ space: command.space!, taskId: command.task }))
        : toJson(await facade.conversationStatus({ space: command.space!, conversationId: command.conversation! }));
    case "chat.result":
      return command.task
        ? toJson(await facade.turnResult({ space: command.space!, taskId: command.task }))
        : toJson(await facade.conversationResult({
            space: command.space!,
            conversationId: command.conversation!,
            ...(command.messages !== undefined ? { messages: command.messages } : {}),
          }));
    case "chat.abort":
      return toJson(await facade.abortTurn({ space: command.space!, conversationId: command.conversation! }));
    case "chats.list":
      return toJson(await facade.listConversations({ space: command.space! }));
    case "manage.send": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toJson(await facade.manageSend({
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.newConversation ? { newConversation: true } : {}),
        content,
        ...(command.attachments?.length ? { attachments: command.attachments, cwd: request.cwd } : {}),
      }));
    }
    case "manage.stop":
      return toJson(await facade.manageStop({ taskId: command.task! }));
    case "manage.status":
      return command.task
        ? toJson(await facade.manageTurnStatus({ taskId: command.task }))
        : toJson(await facade.manageConversationStatus({
            ...(command.conversation ? { conversationId: command.conversation } : {}),
          }));
    case "manage.result":
      return command.task
        ? toJson(await facade.manageTurnResult({ taskId: command.task }))
        : toJson(await facade.manageConversationResult({
            ...(command.conversation ? { conversationId: command.conversation } : {}),
            ...(command.messages !== undefined ? { messages: command.messages } : {}),
          }));
    case "manage.abort":
      return toJson(await facade.manageAbort({
        ...(command.conversation ? { conversationId: command.conversation } : {}),
      }));
    case "manage.list":
      return toJson(await facade.manageList());
    case "checks.enable":
      return toChecksJson(await facade.checksEnable({
        space: command.space!,
        proposalPath: command.proposalPath!,
        cwd: request.cwd,
      }));
    case "checks.disable":
      return toChecksJson(await facade.checksDisable({
        space: command.space!,
        checkId: command.check!,
      }));
    case "checks.run":
      return toChecksJson(await facade.checksRun({
        space: command.space!,
        ...(command.check ? { checkId: command.check } : {}),
      }));
    case "checks.task":
      return toChecksJson(await facade.checksTask({
        space: command.space!,
        taskId: command.task!,
      }));
    case "checks.result":
      return projectChecksResult(await facade.checksResult({
        space: command.space!,
        taskId: command.task!,
      }));
    case "checks.abort":
      return toChecksJson(await facade.checksAbort({
        space: command.space!,
        taskId: command.task!,
      }));
    case "checks.problems":
      return projectChecksProblems(await facade.checksProblems({
        space: command.space!,
        ...(command.check ? { checkId: command.check } : {}),
      }));
    case "checks.decide":
      return toChecksJson(await facade.checksDecide({
        space: command.space!,
        findingId: command.finding!,
        decision: command.decision!,
        ...(command.until ? { deferUntil: command.until } : {}),
      }));
    case "spaces.create":
      return toJson(await facade.createSpace({
        name: command.spaceName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.register":
      return toJson(await facade.registerSpace({
        spaceRoot: command.registerPath!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.add":
      return toJson(await facade.addFiles({
        space: command.space!,
        fromPaths: command.fromPaths ?? [],
        ...(command.toDir !== undefined ? { toDir: command.toDir } : {}),
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
  }
}

function projectChecksResult(
  value: Awaited<ReturnType<WorkFoldActFacade["checksResult"]>>,
): WorkFoldCliJson {
  const { run } = value;
  const findings = run.findings.slice(0, maxChecksOutputFindings).map(projectCheckFinding);
  return toChecksJson({
    space: value.space,
    run: {
      id: run.id,
      taskId: run.taskId,
      checkIds: run.checkIds,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      state: run.state,
      authorities: run.authorities,
      limits: run.limits,
      inputs: run.inputs,
      findings,
      findingCount: run.findings.length,
      findingsReturned: findings.length,
      findingsTruncated: run.findings.length > findings.length,
      admittedCount: run.admittedCount,
      discardedCount: run.discardedCount,
      skippedCount: run.skippedCount,
      ...(run.error ? { error: run.error } : {}),
      ...(run.cost ? { cost: run.cost } : {}),
    },
  });
}

function projectChecksProblems(
  value: Awaited<ReturnType<WorkFoldActFacade["checksProblems"]>>,
): WorkFoldCliJson {
  const findings = value.findings.slice(0, maxChecksOutputFindings).map(projectCheckFinding);
  const healthErrors = value.healthErrors.slice(0, maxChecksOutputHealthErrors);
  return toChecksJson({
    space: value.space,
    ...(value.checkId ? { checkId: value.checkId } : {}),
    findings,
    findingCount: value.findings.length,
    findingsReturned: findings.length,
    findingsTruncated: value.truncated || value.findings.length > findings.length,
    sourceTruncated: value.truncated,
    invalidated: value.invalidated,
    healthErrors,
    healthErrorCount: value.healthErrors.length,
    healthErrorsTruncated: value.healthErrors.length > healthErrors.length,
  });
}

function projectCheckFinding(finding: WorkFoldCheckFinding): Record<string, unknown> {
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    checkId: finding.checkId,
    declarationDigest: finding.declarationDigest,
    sensorId: finding.sensorId,
    sensorRevision: finding.sensorRevision,
    severity: finding.severity,
    observedAt: finding.observedAt,
    status: finding.status,
    title: finding.title,
    targetPath: finding.targetPath,
    evidence: finding.evidence.slice(0, 16).map(projectCheckEvidence),
    ...(finding.detail ? { detail: finding.detail } : {}),
    ...(finding.remediation ? { remediation: finding.remediation } : {}),
    ...(finding.invalidatedAt ? { invalidatedAt: finding.invalidatedAt } : {}),
    ...(finding.invalidationReason ? { invalidationReason: finding.invalidationReason } : {}),
  };
}

function projectCheckEvidence(evidence: WorkFoldCheckEvidence): WorkFoldCliJson {
  return sanitizeChecksJson(evidence);
}

function toChecksJson(value: unknown): WorkFoldCliJson {
  return sanitizeChecksJson(value);
}

/**
 * The facade is trusted application code, but its values can contain file and
 * model content. Bound every collection/string and scrub terminal controls at
 * this final adapter boundary so both JSON and human projections are safe.
 */
function sanitizeChecksJson(value: unknown, depth = 0): WorkFoldCliJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedTerminalText(value, 8_192);
  if (depth >= 12) return "[nested output omitted]";
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => sanitizeChecksJson(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, WorkFoldCliJson> = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      output[terminalText(key)] = sanitizeChecksJson(item, depth + 1);
    }
    return output;
  }
  return boundedTerminalText(value, 8_192);
}

function boundedTerminalText(value: unknown, maximumLength: number): string {
  const scrubbed = terminalText(value);
  return scrubbed.length <= maximumLength ? scrubbed : `${scrubbed.slice(0, maximumLength - 1)}…`;
}

const manageRenderAliases: Partial<Record<WorkFoldCliActCommandName, WorkFoldCliActCommandName>> = {
  "manage.send": "chat.send",
  "manage.status": "chat.status",
  "manage.result": "chat.result",
  "manage.abort": "chat.abort",
  "manage.list": "chats.list",
};

function humanActOutput(name: WorkFoldCliActCommandName, data: WorkFoldCliJson): string {
  const record = data as Record<string, WorkFoldCliJson> & {
    space?: { id?: string; name?: string; spaceRoot?: string };
    conversation?: WorkFoldActConversationRef;
    conversations?: WorkFoldActConversationRef[];
    messages?: WorkFoldActChatMessage[];
    task?: WorkFoldActCheckTaskStatus;
  };
  const spaceLabel = record.space ? `${terminalText(record.space.name)} [${terminalText(record.space.id)}]` : "";
  switch (manageRenderAliases[name] ?? name) {
    case "chat.create":
      return `Created Chat ${terminalText(record.conversation?.id)} in ${spaceLabel}.\n`;
    case "chat.send":
      return `Accepted. Conversation ${terminalText(record.conversationId)}, task ${terminalText(record.taskId)}.\n`;
    case "chat.status": {
      const task = record.task as { taskId?: string; state?: string; conversationId?: string | null; error?: string | null } | undefined;
      if (task) {
        const error = typeof task.error === "string" && task.error ? `\n${terminalText(task.error)}` : "";
        const conversation = task.conversationId ? ` — Chat ${terminalText(task.conversationId)}` : "";
        const request = record.request as {
          phase?: string;
          children?: Array<{ taskId?: string; spaceName?: string; state?: string }>;
        } | null | undefined;
        const requestLines = request
          ? [
              `Request phase: ${terminalText(request.phase)}`,
              ...(request.children ?? []).map((child) =>
                `- delegated task ${terminalText(child.taskId)} in ${terminalText(child.spaceName)} — ${terminalText(child.state)}`),
            ].join("\n")
          : "";
        return `Task ${terminalText(task.taskId)} — ${terminalText(task.state)}${conversation}${error}${requestLines ? `\n${requestLines}` : ""}\n`;
      }
      const conversation = record.conversation;
      const lifecycle = conversation?.archivedAt ? " (archived)" : conversation?.snoozedUntil ? " (snoozed)" : "";
      return `Chat ${terminalText(conversation?.title)} [${terminalText(conversation?.id)}] — ${terminalText(record.state)}${lifecycle}\n`;
    }
    case "chat.result": {
      const task = record.task as { taskId?: string; state?: string } | undefined;
      const message = record.message as unknown as WorkFoldActChatMessage | undefined;
      if (task && message) {
        return `${terminalText(message.content)}\n\n[${terminalText(task.state)}] task ${terminalText(task.taskId)} in ${terminalText(record.conversationId)}\n`;
      }
      const last = typeof record.lastAssistant === "string" && record.lastAssistant.trim()
        ? terminalText(record.lastAssistant)
        : "(no assistant reply yet)";
      return `${last}\n\n[${terminalText(record.state)}] ${terminalText(record.total)} message${record.total === 1 ? "" : "s"} in ${terminalText(record.conversationId)}\n`;
    }
    case "chat.abort":
      return record.aborted ? "Aborted the active turn.\n" : "No active turn to abort.\n";
    case "manage.stop": {
      const children = (Array.isArray(record.children) ? record.children : []) as Array<{ taskId?: string; spaceId?: string; aborted?: boolean }>;
      const managementLine = record.managementAborted
        ? "Stopped the management turn."
        : "The management turn was not running.";
      if (!children.length) return `${managementLine}\nNo delegated Space turns were running.\n`;
      const childLines = children.map((child) =>
        `- ${child.aborted ? "Stopped" : "Could not stop"} task ${terminalText(child.taskId)} in Space ${terminalText(child.spaceId)}`);
      return `${managementLine}\n${childLines.join("\n")}\n`;
    }
    case "chats.list": {
      const conversations = record.conversations ?? [];
      if (!conversations.length) return "No Chats found.\n";
      return `${conversations.map((item) => {
        const lifecycle = item.archivedAt ? " (archived)" : item.snoozedUntil ? " (snoozed)" : "";
        return `- ${terminalText(item.title)} [${terminalText(item.id)}]${lifecycle}`;
      }).join("\n")}\n`;
    }
    case "checks.enable": {
      const check = record.check as { id?: string; title?: string; trigger?: string; targets?: Array<Record<string, WorkFoldCliJson>> } | undefined;
      const targets = check?.targets ?? [];
      const scope = targets.slice(0, 64).map((target) => {
        const membership = target.kind === "tree"
          ? ` (${target.recursive ? "recursive" : "one level"}; ${(Array.isArray(target.extensions) ? target.extensions : []).map(terminalText).join(", ")})`
          : "";
        return `- ${terminalText(target.role)} ${terminalText(target.kind)}: ${terminalText(target.path)}${membership}`;
      });
      return `Enabled Check ${terminalText(check?.title)} [${terminalText(check?.id)}] in ${spaceLabel}.\nTrigger: ${terminalText(check?.trigger)}\n${scope.join("\n")}\n`;
    }
    case "checks.disable":
      return record.disabled
        ? `Disabled Check ${terminalText(record.checkId)} in ${spaceLabel}.\n`
        : `Check ${terminalText(record.checkId)} was not enabled in ${spaceLabel}.\n`;
    case "checks.run": {
      const checkIds = Array.isArray(record.checkIds) ? record.checkIds : [];
      return `Accepted Check run ${terminalText(record.runId)}, task ${terminalText(record.taskId)} (${checkIds.length} Check${checkIds.length === 1 ? "" : "s"}) in ${spaceLabel}.\n`;
    }
    case "checks.task": {
      const task = record.task;
      const run = task?.runId ? ` — run ${terminalText(task.runId)}` : "";
      const error = task?.error ? `\n${terminalText(task.error)}` : "";
      return `Check task ${terminalText(task?.taskId)} — ${terminalText(task?.state)}${run}${error}\n`;
    }
    case "checks.result": {
      const run = record.run as {
        id?: string;
        taskId?: string;
        state?: string;
        admittedCount?: number;
        discardedCount?: number;
        skippedCount?: number;
        findingCount?: number;
        findingsTruncated?: boolean;
        error?: string;
      } | undefined;
      const truncated = run?.findingsTruncated ? " (output bounded)" : "";
      const error = run?.error ? `\n${terminalText(run.error)}` : "";
      return `Check run ${terminalText(run?.id)} — ${terminalText(run?.state)}\n${terminalText(run?.findingCount ?? 0)} finding(s) admitted; ${terminalText(run?.discardedCount ?? 0)} discarded; ${terminalText(run?.skippedCount ?? 0)} skipped${truncated}.${error}\n`;
    }
    case "checks.abort":
      return record.aborted
        ? `Aborted Check task ${terminalText(record.taskId)}.\n`
        : `Check task ${terminalText(record.taskId)} was not running in ${spaceLabel}.\n`;
    case "checks.problems": {
      const findings = (Array.isArray(record.findings) ? record.findings : []) as Array<{
        id?: string;
        severity?: string;
        title?: string;
        targetPath?: string;
        evidence?: WorkFoldCliJson[];
      }>;
      const shown = findings.slice(0, 20);
      const total = typeof record.findingCount === "number" ? record.findingCount : findings.length;
      const sourceTruncated = record.sourceTruncated === true;
      const healthErrors = (Array.isArray(record.healthErrors) ? record.healthErrors : []).slice(0, 5);
      const lines = shown.map((finding) => {
        const evidence = finding.evidence?.[0];
        const proof = evidence ? `\n  Evidence: ${humanCheckEvidence(evidence)}` : "";
        return `- [${terminalText(finding.severity)}] ${terminalText(finding.title)} — ${terminalText(finding.targetPath)} [${terminalText(finding.id)}]${proof}`;
      });
      const omitted = sourceTruncated
        ? "\nAdditional findings were omitted by the bounded service result; use a narrower --check query."
        : total > shown.length ? `\n${total - shown.length} more finding(s) omitted from human output; use --json for the bounded structured result.` : "";
      const health = healthErrors.length
        ? `\nCheck health errors:\n${healthErrors.map((item) => `- ${terminalText(item)}`).join("\n")}`
        : "";
      if (!lines.length && !sourceTruncated) return `No active Check problems in ${spaceLabel}.${health}\n`;
      const countLabel = sourceTruncated ? `At least ${total}` : String(total);
      return `${countLabel} active Check problem${total === 1 && !sourceTruncated ? "" : "s"} in ${spaceLabel}:\n${lines.join("\n")}${omitted}${health}\n`;
    }
    case "checks.decide": {
      const decision = record.decision as { decision?: string; deferUntil?: string } | undefined;
      const until = decision?.deferUntil ? ` until ${terminalText(decision.deferUntil)}` : "";
      return `Recorded ${terminalText(decision?.decision)}${until} for finding ${terminalText(record.findingId)}.\n`;
    }
    case "spaces.create":
    case "spaces.register":
      return `Space ${spaceLabel} — ${terminalText(record.space?.spaceRoot)}\n`;
    case "files.add": {
      const copied = Array.isArray(record.copied) ? record.copied : [];
      const lines = copied.map((path) => `- ${terminalText(path)}`);
      const checkpoint = record.checkpointId ? `Restore point: ${terminalText(record.checkpointId)}\n` : "";
      return `Added ${copied.length} item${copied.length === 1 ? "" : "s"} to ${spaceLabel}:\n${lines.join("\n")}\n${checkpoint}`;
    }
    default:
      return `${terminalText(name)} completed.\n`;
  }
}

function humanCheckEvidence(value: WorkFoldCliJson): string {
  const evidence = value as Record<string, WorkFoldCliJson>;
  switch (evidence.kind) {
    case "path-state":
      return `${terminalText(evidence.path)} expected ${terminalText(evidence.expected)}, observed ${terminalText(evidence.observed)}`;
    default:
      return terminalText(evidence.kind ?? "verified evidence");
  }
}

function receiptDetails(data: WorkFoldCliJson): {
  spaceId?: string;
  conversationId?: string;
  checkpointId?: string;
  taskId?: string;
} {
  const record = data as {
    space?: { id?: unknown };
    conversation?: { id?: unknown };
    conversationId?: unknown;
    checkpointId?: unknown;
    taskId?: unknown;
    task?: { taskId?: unknown };
    run?: { taskId?: unknown };
  };
  const spaceId = typeof record.space?.id === "string" ? record.space.id : undefined;
  const conversationId = typeof record.conversationId === "string"
    ? record.conversationId
    : typeof record.conversation?.id === "string" ? record.conversation.id : undefined;
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof record.checkpointId === "string" ? { checkpointId: record.checkpointId } : {}),
    ...(typeof record.taskId === "string"
      ? { taskId: record.taskId }
      : typeof record.task?.taskId === "string"
        ? { taskId: record.task.taskId }
        : typeof record.run?.taskId === "string"
          ? { taskId: record.run.taskId }
          : {}),
  };
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.byteLength !== providedBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

function toJson(value: unknown): WorkFoldCliJson {
  return JSON.parse(JSON.stringify(value)) as WorkFoldCliJson;
}

// Unlike the read lane's single-line values, act output legitimately spans
// lines (assistant replies, provider errors), so newlines and tabs survive.
function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}

function humanActErrorMessage(error: WorkFoldCliError): string {
  const usageHint = "\nRun 'work-fold help' for usage.";
  if (error.code === "usage" && error.message.endsWith(usageHint)) {
    return `${terminalText(error.message.slice(0, -usageHint.length))}${usageHint}`;
  }
  return terminalText(error.message);
}

function usageError(message: string): WorkFoldCliError {
  return new WorkFoldCliError("usage", `${message}\nRun 'work-fold help' for usage.`);
}

function normalizeActError(error: unknown): WorkFoldCliError {
  if (error instanceof WorkFoldCliError) return error;
  return new WorkFoldCliError("failure", error instanceof Error ? error.message : String(error ?? "work-fold act command failed."), { cause: error });
}
