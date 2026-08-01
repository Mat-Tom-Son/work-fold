import { timingSafeEqual } from "node:crypto";

import type {
  WorkspaceActChatMessage,
  WorkspaceActConversationRef,
  WorkspaceActFacade,
} from "./act-facade.js";
import type { WorkspaceCliActRequestV2 } from "./act-protocol.js";
import type { WorkspaceCliActReceipts } from "./act-receipts.js";
import {
  WorkspaceCliError,
  WorkspaceCliExitCode,
  createWorkspaceCliResponse,
  type WorkspaceCliJson,
  type WorkspaceCliOutputMode,
  type WorkspaceCliResponseV1,
} from "./protocol.js";

export type WorkspaceCliActCommandName =
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
  | "manage.list"
  | "spaces.create"
  | "spaces.register"
  | "files.add";

export interface WorkspaceCliActParsedCommand {
  name: WorkspaceCliActCommandName;
  output: WorkspaceCliOutputMode;
  space?: string;
  conversation?: string;
  task?: string;
  newConversation?: boolean;
  message?: string;
  messageFromPayload?: boolean;
  messages?: number;
  spaceName?: string;
  registerPath?: string;
  fromPaths?: string[];
  toDir?: string;
}

/** The running interactive app's act authority: the facade plus this run's token. */
export interface WorkspaceCliActAuthority {
  facade: WorkspaceActFacade;
  token: string;
}

export interface WorkspaceCliActExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
  getActFacade: () => WorkspaceCliActAuthority | null;
  receipts: Pick<WorkspaceCliActReceipts, "append" | "hasAccepted">;
}

export const workspaceCliActUnavailableMessage =
  "Open Workspace to run this command. Chat and Space actions need the Workspace app running.";

const maxActResultMessages = 500;
const maxActFromPaths = 25;

/**
 * Parses act-lane argv. Every command requires explicit selection — there is
 * deliberately no current-directory Space resolution for writes.
 */
export function parseWorkspaceCliActArgv(argv: readonly string[]): WorkspaceCliActParsedCommand {
  let output: WorkspaceCliOutputMode = "human";
  const flags = new Map<string, string | true>();
  const fromPaths: string[] = [];
  const positional: string[] = [];

  const valueFlags = new Set(["--space", "--conversation", "--task", "--message", "--messages", "--name", "--path", "--from", "--to"]);
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
      throw usageError(`${command} runs inside the workspace shim; update the installed Workspace CLI.`);
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
      };
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
      return { name: "spaces.create", output, spaceName };
    }
    case "spaces register": {
      rejectFlags("--space", "--conversation", "--task", "--new", "--message", "--message-from-payload", "--messages", "--name", "--to");
      const registerPath = stringFlag("--path")?.trim();
      if (!registerPath) throw usageError("Provide --path <absolute-folder-path>.");
      return { name: "spaces.register", output, registerPath };
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
      };
    }
    default:
      throw usageError(`Unknown command: ${command || "(none)"}`);
  }
}

export async function executeWorkspaceCliActRequest(
  request: WorkspaceCliActRequestV2,
  options: WorkspaceCliActExecutorOptions,
): Promise<WorkspaceCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: WorkspaceCliActParsedCommand | undefined;
  let accepted = false;
  try {
    command = parseWorkspaceCliActArgv(request.argv);
    const authority = options.getActFacade();
    if (!authority || !tokensMatch(authority.token, request.actToken)) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "unavailable",
      });
      throw new WorkspaceCliError("unavailable", workspaceCliActUnavailableMessage);
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
      throw new WorkspaceCliError("conflict", "This act request id was already executed. Submit a new request instead of replaying it.");
    }
    // The accepted record lands before the mutation so a crash can never
    // leave an applied action without a journal trace; an unwritable journal
    // refuses the command entirely.
    const acceptedRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "accepted",
      ...(command.space ? { detail: `space ${command.space}` } : {}),
    });
    if (!acceptedRecorded) {
      throw new WorkspaceCliError("failure", "Workspace could not record the act receipt, so the command was not run.");
    }
    accepted = true;
    const data = await runActCommand(command, request, authority.facade);
    const outcomeRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "ok",
      ...receiptDetails(data),
    });
    return createWorkspaceCliResponse({
      id: request.id,
      exitCode: WorkspaceCliExitCode.success,
      stdout: command.output === "json"
        ? `${JSON.stringify({ ok: true, command: command.name, data }, null, 2)}\n`
        : humanActOutput(command.name, data),
      stderr: outcomeRecorded ? "" : "workspace: warning: the act outcome receipt could not be recorded.\n",
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
      });
    }
    const json = command?.output === "json" || request.argv.includes("--json");
    return createWorkspaceCliResponse({
      id: request.id,
      exitCode: normalized.exitCode,
      stdout: "",
      stderr: json
        ? `${JSON.stringify({ ok: false, error: { code: normalized.code, message: normalized.message } }, null, 2)}\n`
        : `${humanActErrorMessage(normalized)}\n`,
      result: { ok: false, error: { code: normalized.code, message: normalized.message } },
      completedAt: completedAt(),
    });
  }
}

async function runActCommand(
  command: WorkspaceCliActParsedCommand,
  request: WorkspaceCliActRequestV2,
  facade: WorkspaceActFacade,
): Promise<WorkspaceCliJson> {
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
      }));
    }
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
    case "spaces.create":
      return toJson(await facade.createSpace({ name: command.spaceName! }));
    case "spaces.register":
      return toJson(await facade.registerSpace({ rootPath: command.registerPath! }));
    case "files.add":
      return toJson(await facade.addFiles({
        space: command.space!,
        fromPaths: command.fromPaths ?? [],
        ...(command.toDir !== undefined ? { toDir: command.toDir } : {}),
        cwd: request.cwd,
      }));
  }
}

const manageRenderAliases: Partial<Record<WorkspaceCliActCommandName, WorkspaceCliActCommandName>> = {
  "manage.send": "chat.send",
  "manage.status": "chat.status",
  "manage.result": "chat.result",
  "manage.abort": "chat.abort",
  "manage.list": "chats.list",
};

function humanActOutput(name: WorkspaceCliActCommandName, data: WorkspaceCliJson): string {
  const record = data as Record<string, WorkspaceCliJson> & {
    space?: { id?: string; name?: string; rootPath?: string };
    conversation?: WorkspaceActConversationRef;
    conversations?: WorkspaceActConversationRef[];
    messages?: WorkspaceActChatMessage[];
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
        return `Task ${terminalText(task.taskId)} — ${terminalText(task.state)}${conversation}${error}\n`;
      }
      const conversation = record.conversation;
      const lifecycle = conversation?.archivedAt ? " (archived)" : conversation?.snoozedUntil ? " (snoozed)" : "";
      return `Chat ${terminalText(conversation?.title)} [${terminalText(conversation?.id)}] — ${terminalText(record.state)}${lifecycle}\n`;
    }
    case "chat.result": {
      const task = record.task as { taskId?: string; state?: string } | undefined;
      const message = record.message as unknown as WorkspaceActChatMessage | undefined;
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
    case "chats.list": {
      const conversations = record.conversations ?? [];
      if (!conversations.length) return "No Chats found.\n";
      return `${conversations.map((item) => {
        const lifecycle = item.archivedAt ? " (archived)" : item.snoozedUntil ? " (snoozed)" : "";
        return `- ${terminalText(item.title)} [${terminalText(item.id)}]${lifecycle}`;
      }).join("\n")}\n`;
    }
    case "spaces.create":
    case "spaces.register":
      return `Space ${spaceLabel} — ${terminalText(record.space?.rootPath)}\n`;
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

function receiptDetails(data: WorkspaceCliJson): {
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
  };
  const spaceId = typeof record.space?.id === "string" ? record.space.id : undefined;
  const conversationId = typeof record.conversationId === "string"
    ? record.conversationId
    : typeof record.conversation?.id === "string" ? record.conversation.id : undefined;
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof record.checkpointId === "string" ? { checkpointId: record.checkpointId } : {}),
    ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
  };
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.byteLength !== providedBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

function toJson(value: unknown): WorkspaceCliJson {
  return JSON.parse(JSON.stringify(value)) as WorkspaceCliJson;
}

// Unlike the read lane's single-line values, act output legitimately spans
// lines (assistant replies, provider errors), so newlines and tabs survive.
function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}

function humanActErrorMessage(error: WorkspaceCliError): string {
  const usageHint = "\nRun 'workspace help' for usage.";
  if (error.code === "usage" && error.message.endsWith(usageHint)) {
    return `${terminalText(error.message.slice(0, -usageHint.length))}${usageHint}`;
  }
  return terminalText(error.message);
}

function usageError(message: string): WorkspaceCliError {
  return new WorkspaceCliError("usage", `${message}\nRun 'workspace help' for usage.`);
}

function normalizeActError(error: unknown): WorkspaceCliError {
  if (error instanceof WorkspaceCliError) return error;
  return new WorkspaceCliError("failure", error instanceof Error ? error.message : String(error ?? "Workspace act command failed."), { cause: error });
}
