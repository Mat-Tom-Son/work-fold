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
  type WorkFoldCliWorkFolderSummary,
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
  { tokens: ["work-folders", "list"], name: "work-folders.list" },
  { tokens: ["tasks", "list"], name: "tasks.list" },
  { tokens: ["capabilities", "list"], name: "capabilities.list" },
  { tokens: ["checks", "status"], name: "checks.status" },
];

export function parseWorkFoldCliArgv(argv: readonly string[]): WorkFoldCliParsedCommand {
  let output: WorkFoldCliOutputMode = "human";
  let workFolder: string | undefined;
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
    if (token === "--work-folder") {
      if (workFolder !== undefined) throw usageError("--work-folder may be provided only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw usageError("--work-folder requires a work-folder id or name.");
      workFolder = normalizeWorkFolderSelector(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--work-folder=")) {
      if (workFolder !== undefined) throw usageError("--work-folder may be provided only once.");
      workFolder = normalizeWorkFolderSelector(token.slice("--work-folder=".length));
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
    if (positional.length || workFolder !== undefined) throw usageError("--version cannot be combined with a command or --work-folder.");
    return { name: "version", output };
  }
  if (!positional.length) {
    if (workFolder !== undefined) throw usageError("--work-folder must be used with context, work-folders list, tasks list, capabilities list, or checks status.");
    return { name: "help", output };
  }
  if (positional[0] === "help") {
    return { name: "help", output, ...(positional.length > 1 ? { topic: positional.slice(1).join(" ") } : {}) };
  }
  if (positional[0] === "version") {
    if (positional.length !== 1 || workFolder !== undefined) throw usageError("version does not accept arguments or --work-folder.");
    return { name: "version", output };
  }

  const matched = commandPatterns.find(({ tokens }) => tokens.length === positional.length && tokens.every((token, index) => positional[index] === token));
  if (!matched) throw usageError(`Unknown command: ${positional.join(" ")}`);
  return { name: matched.name, output, ...(workFolder ? { workFolder } : {}) };
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
  if (normalizedTopic === "context") return `${header}\n\nUsage: ${executable} context [--work-folder <id-or-name>] [--json]\n\nShow the resolved work-folder and host context for this working directory.\n`;
  if (normalizedTopic === "tasks" || normalizedTopic === "tasks list") return `${header}\n\nUsage: ${executable} tasks list [--work-folder <id-or-name>] [--json]\n\nList host-managed tasks, optionally for one work-folder.\n`;
  if (normalizedTopic === "capabilities" || normalizedTopic === "capabilities list") return `${header}\n\nUsage: ${executable} capabilities list [--work-folder <id-or-name>] [--json]\n\nList Skills & Extensions, everywhere and for one work-folder.\n`;
  if (normalizedTopic === "checks" || normalizedTopic?.startsWith("checks ")) {
    return [
      header,
      "",
      `Usage: ${executable} checks status [--work-folder <id-or-name>] [--json]`,
      `       ${executable} checks propose --work-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks enable --work-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks propose-fix --work-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks disable --work-folder <id-or-name> --check <id> [--json]`,
      `       ${executable} checks run --work-folder <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks task --work-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks result --work-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks wait --work-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} checks abort --work-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks problems --work-folder <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks decide --work-folder <id-or-name> --finding <id> --decision <accept|reject|resolve|defer> [--until <ISO-time>] [--json]`,
      "",
      "Checks are optional expectations over explicitly designated files or",
      "bounded file sets. Status is content-free. Every mutation, run, and",
      "contentful result uses the authenticated act lane and an explicit work-folder.",
      "Nothing watches a work-folder or enables a portable declaration automatically.",
      "",
      "To prepare a correction, read checks problems for the current finding and",
      "its evidence. Save this JSON in a temporary file and pass it to propose-fix:",
      '{"kind":"work-fold.check-correction","version":1,"findingId":"<finding id>","fingerprint":"<finding fingerprint>","path":"<primary file>","beforeHash":"<evidence SHA-256>","replacement":"<complete corrected UTF-8 text>"}',
      "The beforeHash must match the primary file's current evidence and bytes.",
      "One correction covers one existing primary file, at most 128 KiB.",
      "Leave the original unchanged. Submission creates a pending review; the",
      "person applies it in Checks, with History preservation and a fresh recheck.",
      "Do not write Check findings or correction records directly into .work-fold.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chat" || normalizedTopic?.startsWith("chat ")) {
    return [
      header,
      "",
      `Usage: ${executable} chat create --work-folder <id-or-name> [--json]`,
      `       ${executable} chat send --work-folder <id-or-name> (--conversation <id> | --new) (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} chat status --work-folder <id-or-name> (--conversation <id> | --task <id>) [--json]`,
      `       ${executable} chat result --work-folder <id-or-name> (--conversation <id> [--messages <n>] | --task <id>) [--json]`,
      `       ${executable} chat wait --work-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} chat abort --work-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat rename --work-folder <id-or-name> --conversation <id> --title <title> [--json]`,
      `       ${executable} chat snooze --work-folder <id-or-name> --conversation <id> --until <ISO-time> [--json]`,
      `       ${executable} chat archive --work-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat resume --work-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat compact --work-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat report --work-folder <id-or-name> --task <id> (--summary <text> | --summary-file <path>) [--data <json-or-@path>] [--file <work-folder-path>]... [--outcome <succeeded|partial|failed>] [--json]`,
      `       ${executable} chat ask --work-folder <id-or-name> --task <id> (--question <text> | --question-file <path>) [--to <person|parent>] [--json]`,
      `       ${executable} chat answer --work-folder <id-or-name> --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} chat handoff --work-folder <id-or-name> --task <id> --to-work-folder <id-or-name> (--message <text> | --message-file <path>) [--file <work-folder-path>]... [--json]`,
      "",
      "Start, continue, await, inspect, curate, or abort a Worker Chat. These",
      "act commands need the work-fold app running and require an explicit",
      "--work-folder. chat send returns a task id; wait and result take it to",
      "follow exactly that turn's outcome instead of whatever message is newest.",
      "wait settles when that turn ends or when the task is waiting on an",
      "answer, and says which; it never sits on a question.",
      "rename, snooze, archive, and resume are the receipted lifecycle verbs;",
      "compact condenses an idle Chat's context and is refused while a turn is",
      "running.",
      "",
      "report, ask, answer, and handoff move results, questions, and work",
      "between work-folders without a work-fold agent turn in the middle. Run",
      `'${executable} help collaborate' for what each one does and a worked example.`,
      "",
    ].join("\n");
  }
  if (normalizedTopic === "collaborate" || normalizedTopic === "collaboration") {
    return [
      header,
      "",
      `Usage: ${executable} chat report --work-folder <id-or-name> --task <own-task-id> (--summary <text> | --summary-file <path>) [--data <json-or-@path>] [--file <work-folder-path>]... [--outcome <succeeded|partial|failed>] [--json]`,
      `       ${executable} chat ask --work-folder <id-or-name> --task <own-task-id> (--question <text> | --question-file <path>) [--to <person|parent>] [--json]`,
      `       ${executable} chat answer --work-folder <id-or-name> --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} chat handoff --work-folder <id-or-name> --task <own-task-id> --to-work-folder <id-or-name> (--message <text> | --message-file <path>) [--file <work-folder-path>]... [--json]`,
      `       ${executable} chat wait --work-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} agent ask --task <own-task-id> (--question <text> | --question-file <path>) [--json]`,
      `       ${executable} agent answer --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} agent wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} requests list [--json]`,
      `       ${executable} requests show --request <id> [--json]`,
      "",
      "How a Worker, an app, the work-fold agent, and an outside agent hand work",
      "to each other. Every verb here runs immediately and leaves a receipt.",
      "Nothing waits on someone clicking something.",
      "",
      "report attaches one result to a task you own: a summary of at most",
      "4 MiB, optional --data JSON of at most 16 MiB, any deliverables you",
      "name with --file, and an outcome of succeeded, partial, or failed.",
      "--data takes inline JSON or @<path> to a JSON file. --summary-file,",
      "--question-file, and --answer-file take the text from a file instead;",
      "every file is read from the directory you ran in. A file is the",
      "practical form for anything long.",
      "When the request that gave you the task declared a shape for --data,",
      "work-fold checks it and names the property that does not fit.",
      "",
      "ask records one question against your task and lets your turn end. The",
      "task is then waiting; you are not blocked, and neither is whoever gave",
      "you the work. --to person is the default; --to parent puts it to the",
      "request above you, and on a request with no parent it reaches the",
      "person instead and says so.",
      "",
      "answer delivers exactly one answer to one question and continues that",
      "Chat once, in the work-folder that owns the question. A second answer,",
      "an answer after Stop, and an answer sent from another work-folder are",
      "all refused. A person typing a reply in the Chat answers it too.",
      "",
      "handoff asks for a new Chat in another work-folder with your message and",
      "copies of the files you name. Copies are additive and land with a",
      "History restore point, exactly as 'files add' does; the new Chat is",
      "recorded under the same request as yours, so what it reports comes back",
      "to the same place. Handing off to your own work-folder is allowed and",
      "just means a fresh Chat there; the files are already in place, so --file",
      "is left off.",
      "",
      "wait follows one task and comes back when that turn ends or when the",
      "task is waiting on an answer, and tells you which happened. When it",
      "comes back waiting, answer it if the answer is yours to give, or put",
      "the question in your own final line and finish. Never loop on wait.",
      "",
      "requests list and requests show read the record: what was handed out,",
      "what is still open, and what came back. Both sit above work-folders and",
      "take no --work-folder, and both are refused when they are run from inside",
      "a registered work-folder, because the record carries every work-folder's",
      "results.",
      "",
      "A worked example. The work-fold agent hands a draft to a Worker, the",
      "Worker asks one question and stops, the answer continues it, and the",
      "finished work comes back. The work-fold agent runs every line but the",
      "report, which the Worker runs during its own turn. chat answer returns",
      "the continuation's own task id: wait on that one and report from it,",
      "not the task that asked.",
      "Ids here are examples; use the ones each command returns.",
      "",
      `  $ ${executable} chat send --work-folder space-0000000000000002 --new --message "Draft the Q3 note from Incoming/brief.md and report back." --parent-task task-root --json`,
      `  $ ${executable} chat wait --work-folder space-0000000000000002 --task task-child --json`,
      `  $ ${executable} chat answer --work-folder space-0000000000000002 --question q-20260911120000-a1b2c3d4 --answer "Use the November figures." --json`,
      `  $ ${executable} chat report --work-folder space-0000000000000002 --task task-continuation --summary "Drafted drafts/q3-note.md from the brief." --file drafts/q3-note.md --outcome succeeded --json`,
      `  $ ${executable} chat wait --work-folder space-0000000000000002 --task task-continuation --json`,
      `  $ ${executable} requests show --request req-20260911115900-0f1e2d3c --json`,
      "",
      "Requests have no fixed lifetime, child-count, depth, or continuation-count",
      "quota. Concurrent child work and transport fields remain bounded, and",
      "every refusal names the bound it hit. See Settings → Automations → Limits.",
      "Stop ends a request explicitly.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "requests" || normalizedTopic?.startsWith("requests ")) {
    return [
      header,
      "",
      `Usage: ${executable} requests list [--json]`,
      `       ${executable} requests show --request <id> [--json]`,
      "",
      "A request is the machine-local record of one piece of work and",
      "everything handed out under it: the turns it started, the questions",
      "still open, the results that came back, and what it spent. Requests sit",
      "above work-folders, so neither verb takes --work-folder; both are reads —",
      "nothing here starts or stops work — and both are refused when they run",
      "from inside a registered work-folder, because the record carries every",
      "work-folder's results. list shows recent roots, newest first; show",
      "prints one request with its children, its questions, and each result.",
      "Worker Chats stay portable and carry none of this.",
      `Run '${executable} help collaborate' for the verbs that fill it in.`,
      "Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chats" || normalizedTopic === "chats list") return `${header}\n\nUsage: ${executable} chats list --work-folder <id-or-name> [--json]\n\nList a work-folder's Chats. Needs the work-fold app running.\n`;
  if (normalizedTopic === "agent" || normalizedTopic?.startsWith("manage ")) {
    return [
      header,
      "",
      `Usage: ${executable} agent send [--conversation <id> | --new] (--message <text> | --message-file <path>) [--attach <path-or-link> ...] [--json]`,
      `       ${executable} agent ask --task <own-task-id> (--question <text> | --question-file <path>) [--json]`,
      `       ${executable} agent answer --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} agent status [--conversation <id> | --task <id>] [--json]`,
      `       ${executable} agent result [--conversation <id> [--messages <n>] | --task <id>] [--json]`,
      `       ${executable} agent wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} agent stop --task <id> [--json]`,
      `       ${executable} agent abort [--conversation <id>] [--json]`,
      `       ${executable} agent list [--json]`,
      `       ${executable} agent overview [--json]`,
      "",
      "Talk to the work-fold agent that sits above all work-folders. It runs",
      "on the same runtime as Worker Chats but belongs to no work-folder: its",
      "transcript is machine-local application state, and it acts across",
      "work-folders through these same work-fold commands. Without a selector,",
      "commands target the most recent active work-fold agent chat, starting",
      "one on first send. --attach adds reference attachments (file or folder",
      "paths, or http(s) links); nothing is copied until the work-fold agent",
      "places material with a restore point. agent status --task reports the",
      "request's attachments, actions, delegated turns, and phase, and agent",
      "stop --task stops the request plus every recorded delegated turn still",
      "running. agent overview prints the deterministic digest of recorded",
      "state — running work, needs-you items, what changed, and Check rows —",
      "composed by app code, never by the model. Needs the work-fold app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "work-folders" || normalizedTopic?.startsWith("work-folders ")) {
    return [
      header,
      "",
      `Usage: ${executable} work-folders list [--work-folder <id-or-name>] [--json]`,
      `       ${executable} work-folders create --name <work-folder-name> [--json]`,
      `       ${executable} work-folders register --path <absolute-folder-path> [--json]`,
      `       ${executable} work-folders rename --work-folder <id-or-name> --name <work-folder-name> [--json]`,
      `       ${executable} work-folders unregister --work-folder <id-or-name> [--json]`,
      `       ${executable} work-folders delete --work-folder <id-or-name> [--json]`,
      `       ${executable} work-folders appearance apply --work-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} work-folders appearance reset --work-folder <id-or-name> [--json]`,
      `       ${executable} work-folders appearance undo --work-folder <id-or-name> [--json]`,
      `       ${executable} work-folders worker show --work-folder <id-or-name> [--json]`,
      `       ${executable} work-folders worker model --work-folder <id-or-name> --provider <id> --model <id> [--json]`,
      `       ${executable} work-folders worker instructions --work-folder <id-or-name> (--instructions <text> | --instructions-file <path> | --clear) [--json]`,
      "",
      "work-folders list is a content-free read; every other work-folders",
      "command needs the work-fold app running. register never moves, copies,",
      "or renames the folder's files, and unregister removes only the",
      "registration while the folder stays in place. work-folders delete moves",
      "a managed work-folder to Recently deleted and records a receipt.",
      "appearance apply imports a typed proposal file; reset and undo step the",
      "appearance back. worker show reports the connected model choices and",
      "the Worker Instructions; worker model saves the default for new Chats,",
      "while worker instructions affect subsequent turns. Provider connections",
      "and credentials stay in Settings → AI Models.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "files" || normalizedTopic?.startsWith("files ")) {
    return [
      header,
      "",
      `Usage: ${executable} files add --work-folder <id-or-name> --from <path> [--from <path>...] [--to <folder-in-work-folder>] [--json]`,
      `       ${executable} files move --work-folder <id-or-name> --from <work-folder-path> --to <folder-in-work-folder> [--json]`,
      `       ${executable} files rename --work-folder <id-or-name> --path <work-folder-path> --name <new-name> [--json]`,
      `       ${executable} files delete --work-folder <id-or-name> --path <work-folder-path> [--json]`,
      `       ${executable} files mkdir --work-folder <id-or-name> --path <folder-in-work-folder> [--json]`,
      `       ${executable} files create --work-folder <id-or-name> --path <work-folder-path> [--json]`,
      "",
      "Work with files inside one work-folder. add copies outside material in,",
      "and move, rename, and delete take a History restore point first so they",
      "stay undoable. delete always goes through: whatever History cannot keep",
      "a copy of moves to Recently deleted instead",
      `(see '${executable} help recently-deleted'). Needs the work-fold app running.`,
      "",
    ].join("\n");
  }
  if (normalizedTopic === "history" || normalizedTopic?.startsWith("history ")) {
    return [
      header,
      "",
      `Usage: ${executable} history list --work-folder <id-or-name> [--limit <n>] [--cursor <cursor>] [--json]`,
      `       ${executable} history save --work-folder <id-or-name> [--label <label>] [--json]`,
      `       ${executable} history restore --work-folder <id-or-name> --checkpoint <id> [--json]`,
      `       ${executable} history versions --work-folder <id-or-name> --path <work-folder-path> [--limit <n>] [--cursor <cursor>] [--json]`,
      `       ${executable} history read --work-folder <id-or-name> --path <work-folder-path> --checkpoint <id> [--offset-bytes <n>] [--length-bytes <n>] [--expected-sha256 <hash>] [--json]`,
      `       ${executable} history diff --work-folder <id-or-name> --path <work-folder-path> --from-checkpoint <id> [--to-checkpoint <id>] [--json]`,
      `       ${executable} history restore-file --work-folder <id-or-name> --path <work-folder-path> --version <sha256> [--json]`,
      "",
      "list/versions return total and nextCursor. Keep the same selection and pass",
      "--cursor to continue; a changed ledger requires starting again.",
      "For large saved text use read --offset-bytes 0 --length-bytes 65536.",
      "Continue with range.nextOffsetBytes and --expected-sha256 range.hashSha256",
      "until nextOffsetBytes is null. Every page verifies the whole saved blob.",
      "read returns bounded saved text and coverage; diff compares saved versions",
      "or the current file when --to-checkpoint is omitted. Neither restores or",
      "changes files. Binary, oversized and uncaptured content is reported explicitly.",
      "These content-bearing reads require the running app's authenticated act lane.",
      "List a work-folder's History checkpoints, save a restore point, restore the",
      "work-folder to a checkpoint, or restore one file to a captured version",
      "(restore-file takes the hash shown by history versions). Every restore",
      "records a safety checkpoint first. history restore is refused while",
      "the work-folder has active work; finish or stop it first. Needs the",
      "work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "search") {
    return [
      header,
      "",
      `Usage: ${executable} search --work-folder <id-or-name> --query <text> [--scope <files|chats|all>] [--path <file-or-folder>] [--limit <n>] [--cursor <cursor>] [--json]`,
      "",
      "Narrow files with --path; ordinary text has no per-file size ceiling.",
      "Repeat the same query/scope/path with --cursor nextCursor until it is null.",
      "Pages may contain no matches while advancing through large files. Coverage",
      "names skipped categories; incomplete coverage is never a complete no-match.",
      "Cursors expire on restart or changed source/selection; start again then.",
      "Search one work-folder's files and Chats with the same in-app search the",
      "desktop uses. The results carry content, so this rides the act lane",
      "and needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "tools" || normalizedTopic?.startsWith("tools ")) {
    return [
      header,
      "",
      `Usage: ${executable} tools import-skill --scope <everywhere|work-folder> [--work-folder <id-or-name>] --from <skill-path> [--json]`,
      `       ${executable} tools install --scope <everywhere|work-folder> [--work-folder <id-or-name>] (--id <catalog-id> | --source <package-source>) [--json]`,
      `       ${executable} tools enable|disable --scope <everywhere|work-folder> [--work-folder <id-or-name>] --kind <extensions|skills|prompts|themes> --path <resource-path> [--json]`,
      `       ${executable} tools update --scope <everywhere|work-folder> [--work-folder <id-or-name>] --source <package-source> [--json]`,
      `       ${executable} tools remove --scope <everywhere|work-folder> [--work-folder <id-or-name>] --source <package-source> [--json]`,
      "",
      "Manage Skills & Extensions. --scope everywhere puts them in every",
      "work-folder and the work-fold agent (Everywhere) and forbids",
      "--work-folder; --scope work-folder keeps them in one work-folder (This",
      "work-folder only) and requires an explicit --work-folder. import-skill",
      "copies in a Skill; install adds a package by catalog id or source;",
      "enable and disable turn one installed extension, skill, prompt, or",
      "theme on or off by its path without removing it; update refreshes a",
      "package; remove uninstalls one.",
      "Every verb runs immediately with a receipt. Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "apps" || normalizedTopic?.startsWith("apps ")) {
    return [
      header,
      "",
      `Usage: ${executable} apps list --work-folder <id-or-name> [--json]`,
      `       ${executable} apps invoke --work-folder <id-or-name> --app <id> --tool <name> --input <json> [--json]`,
      `       ${executable} apps proposals list --work-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} apps proposals dismiss --work-folder <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-proposal --work-folder <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-preview --work-folder <id-or-name> --package <work-folder-path> [--json]`,
      `       ${executable} apps remove --work-folder <id-or-name> --app <id> [--json]`,
      `       ${executable} apps grant --work-folder <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--path <work-folder-path>] [--json]`,
      `       ${executable} apps revoke --work-folder <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--json]`,
      `       ${executable} apps connect --work-folder <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps disconnect --work-folder <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps automation enable --work-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation disable --work-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation run --work-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps storage clear --work-folder <id-or-name> --app <id> [--json]`,
      `       ${executable} apps retained purge --work-folder <id-or-name> --retained <id> [--json]`,
      `       ${executable} apps project declare --work-folder <id-or-name> --presentation <json-path> [--json]`,
      `       ${executable} apps release prepare --work-folder <id-or-name> --version <display-version> [--json]`,
      `       ${executable} apps release publish --work-folder <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps release delete --work-folder <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps install prepare --work-folder <id-or-name> --release <digest> --target-work-folder <id-or-name> [--json]`,
      `       ${executable} apps update prepare --work-folder <id-or-name> --instance <id> --release <digest> [--json]`,
      `       ${executable} apps operation activate --work-folder <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps operation cancel --work-folder <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps uninstall --work-folder <id-or-name> --instance <id> (--retain-data | --purge-data) [--json]`,
      "",
      "Operate restricted apps and App Studio. Every apps verb runs",
      "immediately and leaves a receipt: install-proposal, install-preview,",
      "grant, connect, automation enable, storage clear, retained purge, and",
      "uninstall --purge-data widen or narrow what an app may do, and remove,",
      "revoke, disconnect, and automation disable narrow it, as do the App",
      "Studio verbs (project declare, release prepare/publish/delete, install",
      "prepare, update prepare, operation activate/cancel, uninstall",
      "--retain-data). Credentials never ride this lane: apps connect opens",
      "the browser sign-in flow; a destination that takes a typed secret is",
      "connected from Settings → Apps. A --kind files permission that covers a",
      "folder covers the whole work-folder; one that names a single file needs",
      "--path <work-folder-path> to say which file it covers. list shows each",
      "installed app with its tools and their schemas, named Worker actions,",
      "powers, connections, and automations; invoke runs one declared tool",
      "through the app's own runtime and returns its result with a receipt.",
      "Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "automations" || normalizedTopic?.startsWith("automations ")) {
    return [
      header,
      "",
      `Usage: ${executable} automations enable --proposal <path> [--json]`,
      `       ${executable} automations list [--json]`,
      `       ${executable} automations show --automation <id> [--json]`,
      `       ${executable} automations run --automation <id> [--json]`,
      `       ${executable} automations stop --automation <id> [--json]`,
      `       ${executable} automations disable --automation <id> [--json]`,
      `       ${executable} automations delete --automation <id> [--json]`,
      `       ${executable} automations receipts [--automation <id>] [--json]`,
      "",
      "Automations are declared, machine-local cross-work-folder glue: a trigger",
      "plus bounded deterministic steps executed by app code, never by an open",
      "conversation. They sit above work-folders, so none takes --work-folder.",
      "enable reads an inert typed proposal, checks that every work-folder it",
      "names is registered, and turns it on at once — the receipt pins the",
      "exact declaration, and enabling the same declaration again changes",
      "nothing. run starts one bounded run now; stop, disable, and delete only",
      "narrow standing behavior and run immediately. receipts lists per-run",
      "receipts. Needs the work-fold app running.",
      "",
      "folder-change proposal example (replace the sample work-folder and Check",
      "ids, paths, messages, and timestamp with your own values):",
      JSON.stringify({
        kind: "work-fold.automation-proposal", version: 4, name: "Brief handoff",
        createdBy: "assistant", createdAt: "2026-01-01T00:00:00.000Z",
        automation: {
          title: "Brief handoff",
          trigger: { kind: "files-changed", workFolder: "space-0000000000000001", watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] }, debounceSeconds: 5, cooldownMinutes: 1 },
          steps: [
            { id: "copy", kind: "files", fromWorkFolder: "space-0000000000000001", from: { kind: "paths", paths: ["Ready/brief.md"] }, toWorkFolder: "space-0000000000000002", to: "Incoming" },
            { id: "adopt", kind: "chat", workFolder: "space-0000000000000002", message: "Adopt the newest Incoming/brief*.md copy into reference/brief.md. Preserve the draft and other files. Changed files this run:\n{{trigger.changedFiles}}" },
            { id: "review", kind: "check", workFolder: "space-0000000000000002", check: "check-example1" },
            { id: "report", kind: "agent", message: "{{trigger.summary}} The brief handoff finished. Files the adopt step created:\n{{steps.adopt.createdFiles}}" },
          ],
        },
      }),
      "Keep title, trigger, and steps inside the automation object. Copies are",
      "additive and collision-renamed; a Check step completing does not mean its",
      "findings are clear. Observers establish a baseline on enable/restart/wake",
      "and pause during automation runs. They do not replay edits from that",
      "pause or while quit/asleep.",
      "",
      "Messages in chat and agent steps may use {{trigger.summary}},",
      "{{trigger.changedFiles}} (folder-change triggers), {{trigger.findings}}",
      "(Check-run triggers), and {{steps.<id>.createdFiles}} (an earlier chat",
      "step). work-fold fills them in when the run starts, keeps each under",
      "8 KiB, and records what it filled in on the hop receipt; anything else",
      "inside {{ }} is refused when you enable. An agent step starts a new",
      "work-fold agent chat.",
      "Debounce: 2–120 seconds. Cooldown: 1–1440 minutes. Eight runs may",
      "execute at once; declarations have no step-count quota.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "pages" || normalizedTopic?.startsWith("pages ")) {
    return [
      header,
      "",
      `Usage: ${executable} pages share --work-folder <id-or-name> --path <work-folder-path> --title <page-title> [--snapshot] [--json]`,
      `       ${executable} pages share-app --work-folder <id-or-name> --instance <app-instance-id> [--json]`,
      `       ${executable} pages list [--json]`,
      `       ${executable} pages status --publication <id> [--json]`,
      `       ${executable} pages revoke --publication <id> [--json]`,
      `       ${executable} pages narrow --publication <id> [--serve-rate <per-minute>] [--byte-budget <bytes-per-day>] [--json]`,
      `       ${executable} pages widen --publication <id> [--serve-rate <per-minute>] [--byte-budget <bytes-per-day>] [--snapshot] [--json]`,
      `       ${executable} pages snapshot-off --publication <id> [--json]`,
      "",
      "Publish one work-folder file as a read-only page served live from this",
      "desktop at your work-fold address. pages share shares the page",
      "immediately and records a receipt; share-app puts one installed App",
      "Instance at the address instead: viewers get the app's reviewed",
      "entry, prepared assets, and manifest-declared viewer-readable data,",
      "read-only, over a desktop-enforced broker subset — never",
      "actions, network, connections, files, or writes. --snapshot is an",
      "explicitly labeled opt-in that lets a page survive desktop sleep;",
      "apps have no snapshot and sleep honestly. revoke, narrow, and",
      "snapshot-off only reduce exposure and run immediately. widen raises",
      "a page's budgets (up to 600 serves per minute and 1 GiB per day) or",
      "turns --snapshot on in place with a receipt; the link stays the same.",
      "Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "recently-deleted" || normalizedTopic?.startsWith("trash ")) {
    return [
      header,
      "",
      `Usage: ${executable} recently-deleted list [--json]`,
      `       ${executable} recently-deleted restore --entry <id> [--to <absolute-path>] [--json]`,
      "",
      "Recently deleted holds what a delete could not leave to History: files",
      "and folders History could not keep a copy of, deleted managed",
      "work-folders, and app data that was cleared or purged. list shows what",
      "is waiting and when it will be removed (30 days by default; change that",
      "in Settings → Recently deleted). restore puts an item back where it",
      "came from, renaming it if something else now has that name. App data",
      "whose app is gone can only be saved as a file, which is what --to does.",
      "Nothing empties Recently deleted early. Needs the work-fold app running.",
      "",
    ].join("\n");
  }
  return [
    header,
    "",
    `Usage: ${executable} [--json] <command> [--work-folder <id-or-name>]`,
    "",
    "Read commands:",
    "  context             Show the resolved work-folder and host context",
    "  work-folders list   List work-folders",
    "  tasks list          List host-managed tasks",
    "  capabilities list   List Skills & Extensions, everywhere and per work-folder",
    "  checks status       Show aggregate Check status for one work-folder",
    "  version             Show the installed work-fold version",
    "  help [command]      Show command help",
    "",
    "Act commands (need the work-fold app running; work-folder commands take --work-folder):",
    "  chat create|send|status|result|wait|abort|rename|snooze|archive|resume|compact",
    "                      Start, continue, follow, curate, or compact a Worker Chat",
    "  chat report|ask|answer|handoff",
    "                      Hand results, questions, answers, and work between work-folders",
    "  chats list          List a work-folder's Chats",
    "  agent send|ask|answer|status|result|wait|stop|abort|list|overview",
    "                      Talk to the work-fold agent above all work-folders",
    "  checks propose|propose-fix|enable|disable|run|task|result|wait|abort|problems|decide",
    "                      Operate optional, explicitly scoped work-folder Checks",
    "  history list|save|restore|versions|read|diff|restore-file",
    "                      Save and restore work-folder History",
    "  search              Search one work-folder's files and Chats (--query)",
    "  files add|move|rename|delete|mkdir|create",
    "                      Work with files inside a work-folder",
    "  work-folders create|register|rename|unregister|delete",
    "  work-folders appearance apply|reset|undo",
    "  work-folders worker show|model|instructions",
    "                      Create, manage, restyle, or configure work-folders and their Workers",
    "  tools import-skill|install|enable|disable|update|remove",
    "                      Manage Skills & Extensions",
    `  apps <verb>         Restricted apps and App Studio (see '${executable} help apps')`,
    "  automations enable|list|show|run|stop|disable|delete|receipts",
    "                      Declared steps that run across work-folders on a trigger",
    "  pages share|share-app|list|status|revoke|narrow|widen|snapshot-off",
    "                      Read-only pages served from this desktop",
    "  recently-deleted list|restore",
    "                      Bring back what was deleted",
    `  requests list|show  Follow one piece of work across work-folders (see '${executable} help collaborate')`,
    "",
    "Every act verb runs immediately and leaves a receipt in the act",
    "journal. Mutating act verbs accept --parent-task <id> to record which",
    "work-fold agent request they belong to. Web Access administration,",
    "pairing and act tokens, and provider credentials are local setup: this",
    "CLI refuses them.",
    "",
    "Options:",
    "  --work-folder <value>",
    "                      Select a work-folder by id or exact name",
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
      return { command: command.name, data: contextJson(await kernel.getContext(actor, { workFolder: command.workFolder })) };
    case "work-folders.list":
      return { command: command.name, data: workFoldersJson(await kernel.listWorkFolders(actor, { workFolder: command.workFolder })) };
    case "tasks.list":
      return { command: command.name, data: tasksJson(await kernel.listTasks(actor, { workFolder: command.workFolder })) };
    case "capabilities.list":
      return { command: command.name, data: capabilitiesJson(await kernel.listCapabilities(actor, { workFolder: command.workFolder })) };
    case "checks.status": {
      if (!kernel.getChecksStatus) throw new WorkFoldCliError("unavailable", "Checks status is unavailable in this work-fold host.");
      return { command: command.name, data: checksStatusJson(await kernel.getChecksStatus(actor, { workFolder: command.workFolder })) };
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
    case "work-folders.list":
      return humanWorkFolders((result.data as unknown as { workFolders: WorkFoldCliWorkFolderSummary[] }).workFolders);
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
    workFolder: value.workFolder ? workFolderJson(value.workFolder) : null,
    selectedPath: value.selectedPath ?? null,
    activeSurface: value.activeSurface ?? null,
  };
}

function workFoldersJson(values: WorkFoldCliWorkFolderSummary[]): WorkFoldCliJson {
  return { workFolders: values.map(workFolderJson), total: values.length };
}

function tasksJson(values: WorkFoldCliTaskSummary[]): WorkFoldCliJson {
  return {
    tasks: values.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      workFolderId: item.workFolderId ?? null,
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
    workFolderId: value.workFolderId,
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

function workFolderJson(value: WorkFoldCliWorkFolderSummary): WorkFoldCliJson {
  return {
    id: value.id,
    name: value.name,
    workFolderRoot: value.workFolderRoot ?? null,
    active: value.active ?? false,
    ...(value.parentWorkFolderId ? { parentWorkFolderId: value.parentWorkFolderId } : {}),
  };
}

function humanContext(value: WorkFoldCliContextSnapshot): string {
  const lines = [`Working directory: ${terminalText(value.cwd)}`];
  if (value.workFolder) {
    lines.push(`work-folder: ${terminalText(value.workFolder.name)} [${terminalText(value.workFolder.id)}]`);
    if (value.workFolder.workFolderRoot) lines.push(`Root: ${terminalText(value.workFolder.workFolderRoot)}`);
  } else {
    lines.push("work-folder: none");
  }
  if (value.selectedPath) lines.push(`Selected: ${terminalText(value.selectedPath)}`);
  if (value.activeSurface) lines.push(`Surface: ${terminalText(value.activeSurface)}`);
  return `${lines.join("\n")}\n`;
}

function humanWorkFolders(values: WorkFoldCliWorkFolderSummary[]): string {
  if (!values.length) return "No work-folders found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.id)}]${item.workFolderRoot ? ` — ${terminalText(item.workFolderRoot)}` : ""}${item.active ? " (active)" : ""}`).join("\n")}\n`;
}

function humanTasks(values: WorkFoldCliTaskSummary[]): string {
  if (!values.length) return "No tasks found.\n";
  return `${values.map((item) => `- ${terminalText(item.label)} [${terminalText(item.status)}] (${terminalText(item.id)})${item.workFolderId ? ` — work-folder ${terminalText(item.workFolderId)}` : ""}`).join("\n")}\n`;
}

function humanCapabilities(values: WorkFoldCliCapabilitySummary[]): string {
  if (!values.length) return "No capabilities found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.kind)}, ${terminalText(item.scope)}${item.status ? `, ${terminalText(item.status)}` : ""}]${item.source ? ` — ${terminalText(item.source)}` : ""}`).join("\n")}\n`;
}

function humanChecksStatus(value: WorkFoldCliCheckStatusSummary): string {
  if (!value.available) return `Checks: unavailable\nwork-folder: ${terminalText(value.workFolderId)}\n`;
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
    `work-folder: ${terminalText(value.workFolderId)}`,
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

function normalizeWorkFolderSelector(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw usageError("--work-folder requires a valid work-folder id or name.");
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
