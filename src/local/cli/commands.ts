import {
  WORKSPACE_CLI_PROTOCOL_VERSION,
  WorkspaceCliError,
  WorkspaceCliExitCode,
  createWorkspaceCliResponse,
  type WorkspaceCliActor,
  type WorkspaceCliCapabilitySummary,
  type WorkspaceCliCheckStatusSummary,
  type WorkspaceCliCommandName,
  type WorkspaceCliContextSnapshot,
  type WorkspaceCliJson,
  type WorkspaceCliKernel,
  type WorkspaceCliOutputMode,
  type WorkspaceCliParsedCommand,
  type WorkspaceCliRequestV1,
  type WorkspaceCliResponseV1,
  type WorkspaceCliSpaceSummary,
  type WorkspaceCliTaskSummary,
} from "./protocol.js";

export interface WorkspaceCliExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
}

export interface WorkspaceCliCommandResult {
  command: WorkspaceCliCommandName;
  data: WorkspaceCliJson;
}

const commandPatterns: Array<{ tokens: string[]; name: WorkspaceCliCommandName }> = [
  { tokens: ["context"], name: "context" },
  { tokens: ["spaces", "list"], name: "spaces.list" },
  { tokens: ["tasks", "list"], name: "tasks.list" },
  { tokens: ["capabilities", "list"], name: "capabilities.list" },
  { tokens: ["checks", "status"], name: "checks.status" },
];

export function parseWorkspaceCliArgv(argv: readonly string[]): WorkspaceCliParsedCommand {
  let output: WorkspaceCliOutputMode = "human";
  let space: string | undefined;
  let help = false;
  let version = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      output = "json";
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }
    if (token === "--space") {
      if (space !== undefined) throw usageError("--space may be provided only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw usageError("--space requires a Space id or name.");
      space = normalizeSpaceSelector(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--space=")) {
      if (space !== undefined) throw usageError("--space may be provided only once.");
      space = normalizeSpaceSelector(token.slice("--space=".length));
      continue;
    }
    if (token.startsWith("-")) throw usageError(`Unknown option: ${token}`);
    positional.push(token);
  }

  if (help) {
    return {
      name: "help",
      output,
      ...(positional.length ? { topic: positional.join(" ") } : {}),
    };
  }
  if (version) {
    if (positional.length || space !== undefined) throw usageError("--version cannot be combined with a command or --space.");
    return { name: "version", output };
  }
  if (!positional.length) {
    if (space !== undefined) throw usageError("--space must be used with context, spaces list, tasks list, capabilities list, or checks status.");
    return { name: "help", output };
  }
  if (positional[0] === "help") {
    return { name: "help", output, ...(positional.length > 1 ? { topic: positional.slice(1).join(" ") } : {}) };
  }
  if (positional[0] === "version") {
    if (positional.length !== 1 || space !== undefined) throw usageError("version does not accept arguments or --space.");
    return { name: "version", output };
  }

  const matched = commandPatterns.find(({ tokens }) => tokens.length === positional.length && tokens.every((token, index) => positional[index] === token));
  if (!matched) throw usageError(`Unknown command: ${positional.join(" ")}`);
  return { name: matched.name, output, ...(space ? { space } : {}) };
}

export async function executeWorkspaceCliRequest(
  request: WorkspaceCliRequestV1,
  kernel: WorkspaceCliKernel,
  options: WorkspaceCliExecutorOptions,
): Promise<WorkspaceCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: WorkspaceCliParsedCommand | undefined;
  try {
    command = parseWorkspaceCliArgv(request.argv);
    const actor: WorkspaceCliActor = { kind: "cli", cwd: request.cwd };
    const result = await runCommand(command, actor, kernel, options);
    return createWorkspaceCliResponse({
      id: request.id,
      exitCode: WorkspaceCliExitCode.success,
      stdout: command.output === "json" ? `${JSON.stringify({ ok: true, command: result.command, data: result.data }, null, 2)}\n` : humanOutput(result, options),
      stderr: "",
      result: result.data,
      completedAt: completedAt(),
    });
  } catch (error) {
    const normalized = normalizeCommandError(error);
    const json = command?.output === "json" || request.argv.includes("--json");
    return createWorkspaceCliResponse({
      id: request.id,
      exitCode: normalized.exitCode,
      stdout: "",
      stderr: json
        ? `${JSON.stringify({ ok: false, error: { code: normalized.code, message: normalized.message } }, null, 2)}\n`
        : `${humanErrorMessage(normalized)}\n`,
      result: { ok: false, error: { code: normalized.code, message: normalized.message } },
      completedAt: completedAt(),
    });
  }
}

export function workspaceCliHelp(productName = "Workspace", topic?: string): string {
  const executable = "workspace";
  const normalizedTopic = topic?.trim().toLocaleLowerCase();
  const header = `${terminalText(productName)} CLI`;
  if (normalizedTopic === "context") return `${header}\n\nUsage: ${executable} context [--space <id-or-name>] [--json]\n\nShow the resolved Space and host context for this working directory.\n`;
  if (normalizedTopic === "spaces" || normalizedTopic === "spaces list") return `${header}\n\nUsage: ${executable} spaces list [--space <id-or-name>] [--json]\n\nList Spaces visible to this user.\n`;
  if (normalizedTopic === "tasks" || normalizedTopic === "tasks list") return `${header}\n\nUsage: ${executable} tasks list [--space <id-or-name>] [--json]\n\nList host-managed tasks, optionally for one Space.\n`;
  if (normalizedTopic === "capabilities" || normalizedTopic === "capabilities list") return `${header}\n\nUsage: ${executable} capabilities list [--space <id-or-name>] [--json]\n\nList Personal and Space capabilities.\n`;
  if (normalizedTopic === "checks" || normalizedTopic?.startsWith("checks ")) {
    return [
      header,
      "",
      `Usage: ${executable} checks status [--space <id-or-name>] [--json]`,
      `       ${executable} checks enable --space <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks disable --space <id-or-name> --check <id> [--json]`,
      `       ${executable} checks run --space <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks task --space <id-or-name> --task <id> [--json]`,
      `       ${executable} checks result --space <id-or-name> --task <id> [--json]`,
      `       ${executable} checks wait --space <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} checks abort --space <id-or-name> --task <id> [--json]`,
      `       ${executable} checks problems --space <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks decide --space <id-or-name> --finding <id> --decision <accept|reject|resolve|defer> [--until <ISO-time>] [--json]`,
      "",
      "Checks are optional expectations over explicitly designated files or",
      "bounded file sets. Status is content-free. Every mutation, run, and",
      "contentful result uses the authenticated act lane and an explicit Space.",
      "Nothing watches a Space or enables a portable declaration automatically.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chat" || normalizedTopic?.startsWith("chat ")) {
    return [
      header,
      "",
      `Usage: ${executable} chat create --space <id-or-name> [--json]`,
      `       ${executable} chat send --space <id-or-name> (--conversation <id> | --new) (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} chat status --space <id-or-name> (--conversation <id> | --task <id>) [--json]`,
      `       ${executable} chat result --space <id-or-name> (--conversation <id> [--messages <n>] | --task <id>) [--json]`,
      `       ${executable} chat wait --space <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} chat abort --space <id-or-name> --conversation <id> [--json]`,
      "",
      "Start, continue, await, inspect, or abort a Space Chat. These act",
      "commands need the Workspace app running and require an explicit --space.",
      "chat send returns a task id; wait and result take it to follow exactly",
      "that turn's outcome instead of whatever message is newest.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chats" || normalizedTopic === "chats list") return `${header}\n\nUsage: ${executable} chats list --space <id-or-name> [--json]\n\nList a Space's Chats. Needs the Workspace app running.\n`;
  if (normalizedTopic === "manage" || normalizedTopic?.startsWith("manage ")) {
    return [
      header,
      "",
      `Usage: ${executable} manage send [--conversation <id> | --new] (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} manage status [--conversation <id> | --task <id>] [--json]`,
      `       ${executable} manage result [--conversation <id> [--messages <n>] | --task <id>] [--json]`,
      `       ${executable} manage wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} manage abort [--conversation <id>] [--json]`,
      `       ${executable} manage list [--json]`,
      "",
      "Talk to the management conversation that sits above all Spaces. It runs",
      "on the same Assistant runtime as Space Chats but belongs to no Space:",
      "its transcript is machine-local application state, and it acts across",
      "Spaces through these same workspace commands. Without a selector,",
      "commands target the most recent active management conversation,",
      "creating it on first send. Needs the Workspace app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "spaces create") return `${header}\n\nUsage: ${executable} spaces create --name <space-name> [--json]\n\nCreate a managed Space. Needs the Workspace app running.\n`;
  if (normalizedTopic === "spaces register") return `${header}\n\nUsage: ${executable} spaces register --path <absolute-folder-path> [--json]\n\nRegister an existing folder as a Space in place. Needs the Workspace app running.\n`;
  if (normalizedTopic === "files" || normalizedTopic === "files add") return `${header}\n\nUsage: ${executable} files add --space <id-or-name> --from <path> [--from <path>...] [--to <space-folder>] [--json]\n\nCopy outside files or folders into a Space with a History restore point. Needs the Workspace app running.\n`;
  return [
    header,
    "",
    `Usage: ${executable} [--json] <command> [--space <id-or-name>]`,
    "",
    "Read commands:",
    "  context             Show the resolved Space and host context",
    "  spaces list         List Spaces",
    "  tasks list          List host-managed tasks",
    "  capabilities list   List Assistant capabilities",
    "  checks status       Show aggregate Check status for one Space",
    "  version             Show the installed Workspace version",
    "  help [command]      Show command help",
    "",
    "Act commands (need the Workspace app running; Space commands take --space):",
    "  chat create|send|status|result|wait|abort",
    "                      Start, continue, await, or abort a Space Chat",
    "  chats list          List a Space's Chats",
    "  manage send|status|result|wait|abort|list",
    "                      Talk to the management conversation above all Spaces",
    "  checks enable|disable|run|task|result|wait|abort|problems|decide",
    "                      Operate optional, explicitly scoped Space Checks",
    "  spaces create       Create a managed Space (--name)",
    "  spaces register     Register a folder as a Space (--path)",
    "  files add           Copy outside material into a Space (--from, --to)",
    "",
    "Options:",
    "  --space <value>     Select a Space by id or exact name",
    "  --json              Emit stable JSON output",
    "  -h, --help          Show help",
    "  -v, --version       Show the version",
    "",
  ].join("\n");
}

async function runCommand(
  command: WorkspaceCliParsedCommand,
  actor: WorkspaceCliActor,
  kernel: WorkspaceCliKernel,
  options: WorkspaceCliExecutorOptions,
): Promise<WorkspaceCliCommandResult> {
  switch (command.name) {
    case "help":
      return {
        command: command.name,
        data: {
          product: options.productName ?? "Workspace",
          protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
          topic: command.topic ?? null,
          text: workspaceCliHelp(options.productName, command.topic),
        },
      };
    case "version":
      return {
        command: command.name,
        data: {
          name: options.productName ?? "Workspace",
          version: options.version,
          protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
        },
      };
    case "context":
      return { command: command.name, data: contextJson(await kernel.getContext(actor, { space: command.space })) };
    case "spaces.list":
      return { command: command.name, data: spacesJson(await kernel.listSpaces(actor, { space: command.space })) };
    case "tasks.list":
      return { command: command.name, data: tasksJson(await kernel.listTasks(actor, { space: command.space })) };
    case "capabilities.list":
      return { command: command.name, data: capabilitiesJson(await kernel.listCapabilities(actor, { space: command.space })) };
    case "checks.status": {
      if (!kernel.getChecksStatus) throw new WorkspaceCliError("unavailable", "Checks status is unavailable in this Workspace host.");
      return { command: command.name, data: checksStatusJson(await kernel.getChecksStatus(actor, { space: command.space })) };
    }
  }
}

function humanOutput(result: WorkspaceCliCommandResult, options: WorkspaceCliExecutorOptions): string {
  switch (result.command) {
    case "help":
      return `${String((result.data as { text: string }).text).trimEnd()}\n`;
    case "version": {
      const data = result.data as { name: string; version: string };
      return `${terminalText(data.name)} ${terminalText(data.version)}\n`;
    }
    case "context":
      return humanContext(result.data as unknown as WorkspaceCliContextSnapshot);
    case "spaces.list":
      return humanSpaces((result.data as unknown as { spaces: WorkspaceCliSpaceSummary[] }).spaces);
    case "tasks.list":
      return humanTasks((result.data as unknown as { tasks: WorkspaceCliTaskSummary[] }).tasks);
    case "capabilities.list":
      return humanCapabilities((result.data as unknown as { capabilities: WorkspaceCliCapabilitySummary[] }).capabilities);
    case "checks.status":
      return humanChecksStatus(result.data as unknown as WorkspaceCliCheckStatusSummary);
    default:
      return `${options.productName ?? "Workspace"}\n`;
  }
}

function contextJson(value: WorkspaceCliContextSnapshot): WorkspaceCliJson {
  return {
    cwd: value.cwd,
    space: value.space ? spaceJson(value.space) : null,
    selectedPath: value.selectedPath ?? null,
    activeSurface: value.activeSurface ?? null,
  };
}

function spacesJson(values: WorkspaceCliSpaceSummary[]): WorkspaceCliJson {
  return { spaces: values.map(spaceJson), total: values.length };
}

function tasksJson(values: WorkspaceCliTaskSummary[]): WorkspaceCliJson {
  return {
    tasks: values.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      workspaceId: item.workspaceId ?? null,
      updatedAt: item.updatedAt ?? null,
    })),
    total: values.length,
  };
}

function capabilitiesJson(values: WorkspaceCliCapabilitySummary[]): WorkspaceCliJson {
  return {
    capabilities: values.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      scope: item.scope,
      status: item.status ?? null,
      source: item.source ?? null,
    })),
    total: values.length,
  };
}

function checksStatusJson(value: WorkspaceCliCheckStatusSummary): WorkspaceCliJson {
  return {
    kind: value.kind,
    version: value.version,
    available: value.available,
    workspaceId: value.workspaceId,
    state: value.state,
    configured: value.configured,
    proposed: value.proposed,
    enabled: value.enabled,
    current: value.current,
    neverRun: value.neverRun,
    stale: value.stale,
    blocked: value.blocked,
    errors: value.errors,
    needsAttention: value.needsAttention,
    running: value.running,
    lastRunAt: value.lastRunAt,
  };
}

function spaceJson(value: WorkspaceCliSpaceSummary): WorkspaceCliJson {
  return {
    id: value.id,
    name: value.name,
    rootPath: value.rootPath ?? null,
    active: value.active ?? false,
  };
}

function humanContext(value: WorkspaceCliContextSnapshot): string {
  const lines = [`Working directory: ${terminalText(value.cwd)}`];
  if (value.space) {
    lines.push(`Space: ${terminalText(value.space.name)} [${terminalText(value.space.id)}]`);
    if (value.space.rootPath) lines.push(`Root: ${terminalText(value.space.rootPath)}`);
  } else {
    lines.push("Space: none");
  }
  if (value.selectedPath) lines.push(`Selected: ${terminalText(value.selectedPath)}`);
  if (value.activeSurface) lines.push(`Surface: ${terminalText(value.activeSurface)}`);
  return `${lines.join("\n")}\n`;
}

function humanSpaces(values: WorkspaceCliSpaceSummary[]): string {
  if (!values.length) return "No Spaces found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.id)}]${item.rootPath ? ` — ${terminalText(item.rootPath)}` : ""}${item.active ? " (active)" : ""}`).join("\n")}\n`;
}

function humanTasks(values: WorkspaceCliTaskSummary[]): string {
  if (!values.length) return "No tasks found.\n";
  return `${values.map((item) => `- ${terminalText(item.label)} [${terminalText(item.status)}] (${terminalText(item.id)})${item.workspaceId ? ` — Space ${terminalText(item.workspaceId)}` : ""}`).join("\n")}\n`;
}

function humanCapabilities(values: WorkspaceCliCapabilitySummary[]): string {
  if (!values.length) return "No capabilities found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.kind)}, ${terminalText(item.scope)}${item.status ? `, ${terminalText(item.status)}` : ""}]${item.source ? ` — ${terminalText(item.source)}` : ""}`).join("\n")}\n`;
}

function humanChecksStatus(value: WorkspaceCliCheckStatusSummary): string {
  if (!value.available) return `Checks: unavailable\nSpace: ${terminalText(value.workspaceId)}\n`;
  const labels: Record<Exclude<WorkspaceCliCheckStatusSummary["state"], "unavailable">, string> = {
    "not-configured": "not configured",
    "current-clear": "current, no findings",
    "needs-attention": "needs attention",
    stale: "stale",
    blocked: "blocked",
    "check-error": "check error",
  };
  const state = value.state === "unavailable" ? "unavailable" : labels[value.state];
  return [
    `Checks: ${state}`,
    `Space: ${terminalText(value.workspaceId)}`,
    `Configured: ${value.configured} (${value.enabled} enabled, ${value.proposed} proposed)`,
    `Current: ${value.current}`,
    `Never run: ${value.neverRun}`,
    `Needs attention: ${value.needsAttention}`,
    `Stale: ${value.stale}`,
    `Blocked: ${value.blocked}`,
    `Errors: ${value.errors}`,
    `Running: ${value.running}`,
    `Last run: ${value.lastRunAt ? terminalText(value.lastRunAt) : "never"}`,
    "",
  ].join("\n");
}

function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
}

function humanErrorMessage(error: WorkspaceCliError): string {
  const usageHint = "\nRun 'workspace help' for usage.";
  if (error.code === "usage" && error.message.endsWith(usageHint)) {
    return `${terminalText(error.message.slice(0, -usageHint.length))}${usageHint}`;
  }
  return terminalText(error.message);
}

function normalizeSpaceSelector(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw usageError("--space requires a valid Space id or name.");
  }
  return normalized;
}

function usageError(message: string): WorkspaceCliError {
  return new WorkspaceCliError("usage", `${message}\nRun 'workspace help' for usage.`);
}

function normalizeCommandError(error: unknown): WorkspaceCliError {
  if (error instanceof WorkspaceCliError) return error;
  return new WorkspaceCliError("failure", error instanceof Error ? error.message : String(error ?? "Workspace command failed."), { cause: error });
}
