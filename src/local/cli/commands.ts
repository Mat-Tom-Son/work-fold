import {
  WORKFOLD_CLI_PROTOCOL_VERSION,
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliResponse,
  type WorkFoldCliActor,
  type WorkFoldCliCapabilitySummary,
  type WorkFoldCliCheckStatusSummary,
  type WorkFoldCliCommandName,
  type WorkFoldCliContextSnapshot,
  type WorkFoldCliJson,
  type WorkFoldCliKernel,
  type WorkFoldCliOutputMode,
  type WorkFoldCliParsedCommand,
  type WorkFoldCliRequestV1,
  type WorkFoldCliResponseV1,
  type WorkFoldCliSpaceSummary,
  type WorkFoldCliTaskSummary,
} from "./protocol.js";

export interface WorkFoldCliExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
}

export interface WorkFoldCliCommandResult {
  command: WorkFoldCliCommandName;
  data: WorkFoldCliJson;
}

const commandPatterns: Array<{ tokens: string[]; name: WorkFoldCliCommandName }> = [
  { tokens: ["context"], name: "context" },
  { tokens: ["spaces", "list"], name: "spaces.list" },
  { tokens: ["tasks", "list"], name: "tasks.list" },
  { tokens: ["capabilities", "list"], name: "capabilities.list" },
  { tokens: ["checks", "status"], name: "checks.status" },
];

export function parseWorkFoldCliArgv(argv: readonly string[]): WorkFoldCliParsedCommand {
  let output: WorkFoldCliOutputMode = "human";
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

export async function executeWorkFoldCliRequest(
  request: WorkFoldCliRequestV1,
  kernel: WorkFoldCliKernel,
  options: WorkFoldCliExecutorOptions,
): Promise<WorkFoldCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: WorkFoldCliParsedCommand | undefined;
  try {
    command = parseWorkFoldCliArgv(request.argv);
    const actor: WorkFoldCliActor = { kind: "cli", cwd: request.cwd };
    const result = await runCommand(command, actor, kernel, options);
    return createWorkFoldCliResponse({
      id: request.id,
      exitCode: WorkFoldCliExitCode.success,
      stdout: command.output === "json" ? `${JSON.stringify({ ok: true, command: result.command, data: result.data }, null, 2)}\n` : humanOutput(result, options),
      stderr: "",
      result: result.data,
      completedAt: completedAt(),
    });
  } catch (error) {
    const normalized = normalizeCommandError(error);
    const json = command?.output === "json" || request.argv.includes("--json");
    return createWorkFoldCliResponse({
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

export function workFoldCliHelp(productName = "work-fold", topic?: string): string {
  const executable = "work-fold";
  const normalizedTopic = topic?.trim().toLocaleLowerCase();
  const header = `${terminalText(productName)} CLI`;
  if (normalizedTopic === "context") return `${header}\n\nUsage: ${executable} context [--space <id-or-name>] [--json]\n\nShow the resolved Space and host context for this working directory.\n`;
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
      `       ${executable} chat rename --space <id-or-name> --conversation <id> --title <title> [--json]`,
      `       ${executable} chat snooze --space <id-or-name> --conversation <id> --until <ISO-time> [--json]`,
      `       ${executable} chat archive --space <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat resume --space <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat compact --space <id-or-name> --conversation <id> [--json]`,
      "",
      "Start, continue, await, inspect, curate, or abort a Space Chat. These",
      "act commands need the work-fold app running and require an explicit",
      "--space. chat send returns a task id; wait and result take it to follow",
      "exactly that turn's outcome instead of whatever message is newest.",
      "rename, snooze, archive, and resume are the receipted lifecycle verbs;",
      "compact condenses an idle Chat's context and is refused while a turn is",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chats" || normalizedTopic === "chats list") return `${header}\n\nUsage: ${executable} chats list --space <id-or-name> [--json]\n\nList a Space's Chats. Needs the work-fold app running.\n`;
  if (normalizedTopic === "manage" || normalizedTopic?.startsWith("manage ")) {
    return [
      header,
      "",
      `Usage: ${executable} manage send [--conversation <id> | --new] (--message <text> | --message-file <path>) [--attach <path-or-link> ...] [--json]`,
      `       ${executable} manage status [--conversation <id> | --task <id>] [--json]`,
      `       ${executable} manage result [--conversation <id> [--messages <n>] | --task <id>] [--json]`,
      `       ${executable} manage wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} manage stop --task <id> [--json]`,
      `       ${executable} manage abort [--conversation <id>] [--json]`,
      `       ${executable} manage list [--json]`,
      `       ${executable} manage glance [--json]`,
      "",
      "Talk to the management conversation that sits above all Spaces. It runs",
      "on the same Assistant runtime as Space Chats but belongs to no Space:",
      "its transcript is machine-local application state, and it acts across",
      "Spaces through these same work-fold commands. Without a selector,",
      "commands target the most recent active management conversation,",
      "creating it on first send. --attach adds reference attachments (file or",
      "folder paths, or http(s) links); nothing is copied until the Assistant",
      "places material with a restore point. manage status --task reports the",
      "request's attachments, actions, delegated turns, and phase, and manage",
      "stop --task stops the request plus every recorded delegated turn still",
      "running. manage glance prints the deterministic digest of recorded",
      "state — running work, needs-you items, what changed, and Check rows —",
      "composed by app code, never by the Assistant. Needs the work-fold app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "spaces" || normalizedTopic?.startsWith("spaces ")) {
    return [
      header,
      "",
      `Usage: ${executable} spaces list [--space <id-or-name>] [--json]`,
      `       ${executable} spaces create --name <space-name> [--json]`,
      `       ${executable} spaces register --path <absolute-folder-path> [--json]`,
      `       ${executable} spaces rename --space <id-or-name> --name <space-name> [--json]`,
      `       ${executable} spaces unregister --space <id-or-name> [--json]`,
      `       ${executable} spaces delete --space <id-or-name> [--json]`,
      `       ${executable} spaces appearance apply --space <id-or-name> --proposal <path> [--json]`,
      `       ${executable} spaces appearance reset --space <id-or-name> [--json]`,
      `       ${executable} spaces appearance undo --space <id-or-name> [--json]`,
      "",
      "spaces list is a content-free read; every other spaces command needs",
      "the work-fold app running. register never moves, copies, or renames",
      "the folder's files, and unregister removes only the registration while",
      "the folder stays in place. spaces delete removes a managed Space's",
      "folder irreversibly, so it stages a pending decision for the person to",
      "approve in work-fold instead of executing. appearance apply imports a",
      "typed proposal file; reset and undo step the appearance back.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "files" || normalizedTopic?.startsWith("files ")) {
    return [
      header,
      "",
      `Usage: ${executable} files add --space <id-or-name> --from <path> [--from <path>...] [--to <space-folder>] [--json]`,
      `       ${executable} files move --space <id-or-name> --from <space-path> --to <space-folder> [--json]`,
      `       ${executable} files rename --space <id-or-name> --path <space-path> --name <new-name> [--json]`,
      `       ${executable} files delete --space <id-or-name> --path <space-path> [--json]`,
      `       ${executable} files mkdir --space <id-or-name> --path <space-folder> [--json]`,
      `       ${executable} files create --space <id-or-name> --path <space-path> [--json]`,
      `       ${executable} files destroy --space <id-or-name> --path <space-path> [--path <space-path>...] [--json]`,
      "",
      "Work with files inside one Space. add copies outside material in, and",
      "move, rename, and delete take a History restore point first so they",
      "stay undoable. destroy is irreversible removal with no restore path:",
      "it stages a pending decision for the person to approve in work-fold",
      "instead of executing. Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "history" || normalizedTopic?.startsWith("history ")) {
    return [
      header,
      "",
      `Usage: ${executable} history list --space <id-or-name> [--json]`,
      `       ${executable} history save --space <id-or-name> [--label <label>] [--json]`,
      `       ${executable} history restore --space <id-or-name> --checkpoint <id> [--json]`,
      `       ${executable} history versions --space <id-or-name> --path <space-path> [--json]`,
      `       ${executable} history restore-file --space <id-or-name> --path <space-path> --version <sha256> [--json]`,
      "",
      "List a Space's History checkpoints, save a restore point, restore the",
      "Space to a checkpoint, or restore one file to a captured version",
      "(restore-file takes the hash shown by history versions). Every restore",
      "records a safety checkpoint first. history restore is refused while",
      "the Space has active work; finish or stop it first. Needs the",
      "work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "search") {
    return [
      header,
      "",
      `Usage: ${executable} search --space <id-or-name> --query <text> [--scope <files|chats|all>] [--json]`,
      "",
      "Search one Space's files and Chats with the same in-app search the",
      "desktop uses. The results carry content, so this rides the act lane",
      "and needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "library" || normalizedTopic?.startsWith("library ")) {
    return [
      header,
      "",
      `Usage: ${executable} library list [--json]`,
      `       ${executable} library add --from <path> [--from <path>...] [--to <library-folder>] [--json]`,
      `       ${executable} library folder create --name <folder-name> [--json]`,
      `       ${executable} library copy --item <library-path> --space <id-or-name> [--json]`,
      "",
      "The Library is your passive personal collection, shared across all",
      "Spaces, so only library copy takes --space. add copies outside files",
      "in, folder create adds a Library folder, and copy places one Library",
      "item into a Space with a History restore point. Nothing in the Library",
      "becomes Assistant context automatically. Needs the work-fold app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "tools" || normalizedTopic?.startsWith("tools ")) {
    return [
      header,
      "",
      `Usage: ${executable} tools import-skill --scope <personal|space> [--space <id-or-name>] --from <skill-path> [--json]`,
      `       ${executable} tools install --scope <personal|space> [--space <id-or-name>] (--id <catalog-id> | --source <package-source>) [--json]`,
      `       ${executable} tools update --scope <personal|space> [--space <id-or-name>] --source <package-source> [--json]`,
      `       ${executable} tools remove --scope <personal|space> [--space <id-or-name>] --source <package-source> [--json]`,
      "",
      "Manage Assistant tools (Skills and Extensions). --scope space requires",
      "an explicit --space; --scope personal forbids one. import-skill,",
      "install, and update make bytes runnable, so each stages a pending",
      "decision for the person to approve in work-fold instead of executing.",
      "remove executes directly with a receipt. Needs the work-fold app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "apps" || normalizedTopic?.startsWith("apps ")) {
    return [
      header,
      "",
      `Usage: ${executable} apps proposals list --space <id-or-name> --conversation <id> [--json]`,
      `       ${executable} apps proposals dismiss --space <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-proposal --space <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-preview --space <id-or-name> --package <space-path> [--json]`,
      `       ${executable} apps remove --space <id-or-name> --app <id> [--json]`,
      `       ${executable} apps grant --space <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--json]`,
      `       ${executable} apps revoke --space <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--json]`,
      `       ${executable} apps connect --space <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps disconnect --space <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps automation enable --space <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation disable --space <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation run --space <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps storage clear --space <id-or-name> --app <id> [--json]`,
      `       ${executable} apps retained purge --space <id-or-name> --retained <id> [--json]`,
      `       ${executable} apps project declare --space <id-or-name> --presentation <json-path> [--json]`,
      `       ${executable} apps release prepare --space <id-or-name> --version <display-version> [--json]`,
      `       ${executable} apps release publish --space <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps release delete --space <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps install prepare --space <id-or-name> --release <digest> --target-space <id-or-name> [--json]`,
      `       ${executable} apps update prepare --space <id-or-name> --instance <id> --release <digest> [--json]`,
      `       ${executable} apps operation activate --space <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps operation cancel --space <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps uninstall --space <id-or-name> --instance <id> (--retain-data | --purge-data) [--json]`,
      "",
      "Operate restricted apps and App Studio. install-proposal,",
      "install-preview, grant, connect, automation enable, storage clear,",
      "retained purge, and uninstall --purge-data make bytes runnable, widen",
      "a power, or destroy data irreversibly, so each stages a pending",
      "decision for the person to approve in work-fold instead of executing.",
      "remove, revoke, disconnect, and automation disable only narrow",
      "authority and execute directly with a receipt, as do the",
      "authority-neutral App Studio verbs (project declare, release",
      "prepare/publish/delete, install prepare, update prepare, operation",
      "activate/cancel, uninstall --retain-data). Credentials never ride this",
      "lane: apps connect names the destination, and the person completes the",
      "credential in work-fold. Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "routings" || normalizedTopic?.startsWith("routings ")) {
    return [
      header,
      "",
      `Usage: ${executable} routings stage --proposal <path> [--json]`,
      `       ${executable} routings list [--json]`,
      `       ${executable} routings show --routing <id> [--json]`,
      `       ${executable} routings run --routing <id> [--json]`,
      `       ${executable} routings stop --routing <id> [--json]`,
      `       ${executable} routings disable --routing <id> [--json]`,
      `       ${executable} routings delete --routing <id> [--json]`,
      `       ${executable} routings receipts [--routing <id>] [--json]`,
      "",
      "Routings are declared, machine-local cross-Space glue: a trigger plus",
      "bounded deterministic steps executed by app code, never by an open",
      "conversation. They sit above Spaces, so no --space. stage submits an",
      "inert typed declaration and stages the enabling decision for the",
      "person to approve in work-fold; run starts one bounded run now; stop,",
      "disable, and delete only narrow standing behavior and execute",
      "directly. receipts lists per-run receipts. Needs the work-fold app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "pages" || normalizedTopic?.startsWith("pages ")) {
    return [
      header,
      "",
      `Usage: ${executable} pages stage --space <id-or-name> --path <space-path> --title <page-title> [--snapshot] [--json]`,
      `       ${executable} pages stage-app --space <id-or-name> --instance <app-instance-id> [--json]`,
      `       ${executable} pages list [--json]`,
      `       ${executable} pages status --publication <id> [--json]`,
      `       ${executable} pages revoke --publication <id> [--json]`,
      `       ${executable} pages narrow --publication <id> [--serve-rate <per-minute>] [--byte-budget <bytes-per-day>] [--json]`,
      `       ${executable} pages snapshot-off --publication <id> [--json]`,
      "",
      "Publish one Space file as a read-only page served live from this",
      "desktop at your work-fold address. Creating outward exposure always",
      "takes a click: pages stage prepares the page and stages the decision",
      "for the person to approve in work-fold. stage-app stages putting one",
      "installed App Instance at the address instead: viewers get the app's",
      "reviewed entry, staged assets, and manifest-declared viewer-readable",
      "data, read-only, over a desktop-enforced broker subset — never",
      "actions, network, connections, files, or writes. --snapshot is an",
      "explicitly labeled opt-in that lets a page survive desktop sleep;",
      "apps have no snapshot and sleep honestly. revoke, narrow, and",
      "snapshot-off only reduce exposure and execute directly.",
      "Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "staged" || normalizedTopic?.startsWith("staged ")) {
    return [
      header,
      "",
      `Usage: ${executable} staged list [--json]`,
      `       ${executable} staged show --id <staged-act-id> [--json]`,
      `       ${executable} staged cancel --id <staged-act-id> [--json]`,
      "",
      "Inspect or withdraw staged acts. A consecrated act command never",
      "executes directly: it stages a fully prepared, inert act, and",
      "work-fold shows the person a decision card. list shows what is",
      "pending, show prints one staged act's exact pins, and cancel",
      "withdraws one before it is decided. Approval happens only in",
      "work-fold or an approved remote browser, never through this CLI.",
      "Staged acts expire, and expiry is not approval. Needs the work-fold",
      "app running.",
      "",
    ].join("\n");
  }
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
    "  version             Show the installed work-fold version",
    "  help [command]      Show command help",
    "",
    "Act commands (need the work-fold app running; Space commands take --space):",
    "  chat create|send|status|result|wait|abort|rename|snooze|archive|resume|compact",
    "                      Start, continue, follow, curate, or compact a Space Chat",
    "  chats list          List a Space's Chats",
    "  manage send|status|result|wait|stop|abort|list|glance",
    "                      Talk to the management conversation above all Spaces",
    "  checks enable|disable|run|task|result|wait|abort|problems|decide",
    "                      Operate optional, explicitly scoped Space Checks",
    "  history list|save|restore|versions|restore-file",
    "                      Save and restore Space History",
    "  search              Search one Space's files and Chats (--query)",
    "  files add|move|rename|delete|mkdir|create|destroy",
    "                      Work with files inside a Space",
    "  library list|add|copy; library folder create",
    "                      Use the passive personal Library",
    "  spaces create|register|rename|unregister|delete; spaces appearance apply|reset|undo",
    "                      Create, register, rename, remove, or restyle Spaces",
    "  tools import-skill|install|update|remove",
    "                      Manage Assistant tools (Skills and Extensions)",
    `  apps <verb>         Restricted apps and App Studio (see '${executable} help apps')`,
    "  routings stage|list|show|run|stop|disable|delete|receipts",
    "                      Declared cross-Space glue, above Spaces",
    "  pages stage|list|status|revoke|narrow|snapshot-off",
    "                      Read-only pages served from this desktop",
    "  staged list|show|cancel",
    "                      Inspect or withdraw staged acts awaiting a decision",
    "",
    "Consecrated actions — making bytes runnable, widening a power, or",
    "destroying something irreversibly — always stage first. Reviewed mode",
    "waits for a person or policy; Unrestricted lets the desktop host decide",
    "new admissions automatically. Mutating act",
    "verbs accept --parent-task <id> to record management-request lineage.",
    "Remote access administration, pairing and act tokens, provider",
    "credentials, settings, standing policies, and root authority are local setup: this CLI",
    "refuses them.",
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
  command: WorkFoldCliParsedCommand,
  actor: WorkFoldCliActor,
  kernel: WorkFoldCliKernel,
  options: WorkFoldCliExecutorOptions,
): Promise<WorkFoldCliCommandResult> {
  switch (command.name) {
    case "help":
      return {
        command: command.name,
        data: {
          product: options.productName ?? "work-fold",
          protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
          topic: command.topic ?? null,
          text: workFoldCliHelp(options.productName, command.topic),
        },
      };
    case "version":
      return {
        command: command.name,
        data: {
          name: options.productName ?? "work-fold",
          version: options.version,
          protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
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
      if (!kernel.getChecksStatus) throw new WorkFoldCliError("unavailable", "Checks status is unavailable in this work-fold host.");
      return { command: command.name, data: checksStatusJson(await kernel.getChecksStatus(actor, { space: command.space })) };
    }
  }
}

function humanOutput(result: WorkFoldCliCommandResult, options: WorkFoldCliExecutorOptions): string {
  switch (result.command) {
    case "help":
      return `${String((result.data as { text: string }).text).trimEnd()}\n`;
    case "version": {
      const data = result.data as { name: string; version: string };
      return `${terminalText(data.name)} ${terminalText(data.version)}\n`;
    }
    case "context":
      return humanContext(result.data as unknown as WorkFoldCliContextSnapshot);
    case "spaces.list":
      return humanSpaces((result.data as unknown as { spaces: WorkFoldCliSpaceSummary[] }).spaces);
    case "tasks.list":
      return humanTasks((result.data as unknown as { tasks: WorkFoldCliTaskSummary[] }).tasks);
    case "capabilities.list":
      return humanCapabilities((result.data as unknown as { capabilities: WorkFoldCliCapabilitySummary[] }).capabilities);
    case "checks.status":
      return humanChecksStatus(result.data as unknown as WorkFoldCliCheckStatusSummary);
    default:
      return `${options.productName ?? "work-fold"}\n`;
  }
}

function contextJson(value: WorkFoldCliContextSnapshot): WorkFoldCliJson {
  return {
    cwd: value.cwd,
    space: value.space ? spaceJson(value.space) : null,
    selectedPath: value.selectedPath ?? null,
    activeSurface: value.activeSurface ?? null,
  };
}

function spacesJson(values: WorkFoldCliSpaceSummary[]): WorkFoldCliJson {
  return { spaces: values.map(spaceJson), total: values.length };
}

function tasksJson(values: WorkFoldCliTaskSummary[]): WorkFoldCliJson {
  return {
    tasks: values.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      spaceId: item.spaceId ?? null,
      updatedAt: item.updatedAt ?? null,
    })),
    total: values.length,
  };
}

function capabilitiesJson(values: WorkFoldCliCapabilitySummary[]): WorkFoldCliJson {
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

function checksStatusJson(value: WorkFoldCliCheckStatusSummary): WorkFoldCliJson {
  return {
    kind: value.kind,
    version: value.version,
    available: value.available,
    spaceId: value.spaceId,
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

function spaceJson(value: WorkFoldCliSpaceSummary): WorkFoldCliJson {
  return {
    id: value.id,
    name: value.name,
    spaceRoot: value.spaceRoot ?? null,
    active: value.active ?? false,
  };
}

function humanContext(value: WorkFoldCliContextSnapshot): string {
  const lines = [`Working directory: ${terminalText(value.cwd)}`];
  if (value.space) {
    lines.push(`Space: ${terminalText(value.space.name)} [${terminalText(value.space.id)}]`);
    if (value.space.spaceRoot) lines.push(`Root: ${terminalText(value.space.spaceRoot)}`);
  } else {
    lines.push("Space: none");
  }
  if (value.selectedPath) lines.push(`Selected: ${terminalText(value.selectedPath)}`);
  if (value.activeSurface) lines.push(`Surface: ${terminalText(value.activeSurface)}`);
  return `${lines.join("\n")}\n`;
}

function humanSpaces(values: WorkFoldCliSpaceSummary[]): string {
  if (!values.length) return "No Spaces found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.id)}]${item.spaceRoot ? ` — ${terminalText(item.spaceRoot)}` : ""}${item.active ? " (active)" : ""}`).join("\n")}\n`;
}

function humanTasks(values: WorkFoldCliTaskSummary[]): string {
  if (!values.length) return "No tasks found.\n";
  return `${values.map((item) => `- ${terminalText(item.label)} [${terminalText(item.status)}] (${terminalText(item.id)})${item.spaceId ? ` — Space ${terminalText(item.spaceId)}` : ""}`).join("\n")}\n`;
}

function humanCapabilities(values: WorkFoldCliCapabilitySummary[]): string {
  if (!values.length) return "No capabilities found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.kind)}, ${terminalText(item.scope)}${item.status ? `, ${terminalText(item.status)}` : ""}]${item.source ? ` — ${terminalText(item.source)}` : ""}`).join("\n")}\n`;
}

function humanChecksStatus(value: WorkFoldCliCheckStatusSummary): string {
  if (!value.available) return `Checks: unavailable\nSpace: ${terminalText(value.spaceId)}\n`;
  const labels: Record<Exclude<WorkFoldCliCheckStatusSummary["state"], "unavailable">, string> = {
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
    `Space: ${terminalText(value.spaceId)}`,
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

function humanErrorMessage(error: WorkFoldCliError): string {
  const usageHint = "\nRun 'work-fold help' for usage.";
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

function usageError(message: string): WorkFoldCliError {
  return new WorkFoldCliError("usage", `${message}\nRun 'work-fold help' for usage.`);
}

function normalizeCommandError(error: unknown): WorkFoldCliError {
  if (error instanceof WorkFoldCliError) return error;
  return new WorkFoldCliError("failure", error instanceof Error ? error.message : String(error ?? "work-fold command failed."), { cause: error });
}
