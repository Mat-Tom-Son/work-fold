import { timingSafeEqual } from "node:crypto";

import type {
  WorkFoldActChatLifecycleState,
  WorkFoldActChatMessage,
  WorkFoldActCheckTaskStatus,
  WorkFoldActCheckpointSummary,
  WorkFoldActConversationRef,
  WorkFoldActFacade,
  WorkFoldActFileVersionRef,
} from "./act-facade.js";
import type {
  WorkFoldCheckDecisionKind,
  WorkFoldCheckEvidence,
  WorkFoldCheckFinding,
} from "../checks/check-types.js";
import type { WorkFoldCliActRequestV2 } from "./act-protocol.js";
import type { WorkFoldCliActReceipts, WorkFoldCliActUndoRef } from "./act-receipts.js";
import { maximumAssistantInstructionsLength } from "../agent/model-preferences.js";
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
  | "chat.rename"
  | "chat.snooze"
  | "chat.archive"
  | "chat.resume"
  | "chat.compact"
  | "chats.list"
  | "manage.send"
  | "manage.status"
  | "manage.result"
  | "manage.abort"
  | "manage.stop"
  | "manage.list"
  | "manage.glance"
  | "checks.enable"
  | "checks.disable"
  | "checks.run"
  | "checks.task"
  | "checks.result"
  | "checks.abort"
  | "checks.problems"
  | "checks.decide"
  | "history.list"
  | "history.save"
  | "history.restore"
  | "history.versions"
  | "history.restore-file"
  | "search"
  | "library.list"
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
  | "spaces.assistant.show"
  | "spaces.assistant.model"
  | "spaces.assistant.instructions"
  | "files.add"
  | "files.move"
  | "files.rename"
  | "files.delete"
  | "files.destroy"
  | "files.mkdir"
  | "files.create"
  | "tools.import-skill"
  | "tools.install"
  | "tools.update"
  | "tools.remove"
  | "apps.proposals.list"
  | "apps.proposals.dismiss"
  | "apps.install-proposal"
  | "apps.install-preview"
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
  | "routings.list"
  | "routings.show"
  | "routings.run"
  | "routings.stop"
  | "routings.disable"
  | "routings.delete"
  | "routings.receipts"
  | "pages.stage"
  | "pages.stage-app"
  | "pages.list"
  | "pages.status"
  | "pages.revoke"
  | "pages.narrow"
  | "pages.snapshot-off"
  | "staged.list"
  | "staged.show"
  | "staged.cancel";

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
  /** New Chat title for chat.rename. */
  title?: string;
  provider?: string;
  model?: string;
  instructions?: string;
  clear?: boolean;
  /** Optional restore-point label for history.save. */
  label?: string;
  checkpoint?: string;
  /** Single Space-relative entry path for file and History verbs. */
  path?: string;
  /** Staged files.destroy targets: one or more bounded --path values. */
  paths?: string[];
  /** File-version hash for history.restore-file; display version for apps.release.prepare. */
  version?: string;
  query?: string;
  searchScope?: "files" | "chats" | "all";
  /** Library-relative source item for library.copy. */
  item?: string;
  /** New entry name for files.rename. */
  entryName?: string;
  /** New Library folder name for library.folder.create. */
  folderName?: string;
  toolsScope?: "personal" | "space";
  catalogId?: string;
  source?: string;
  /** Restricted-app proposal id (apps.* commands; checks enable carries proposalPath instead). */
  proposal?: string;
  /** Space-relative packaged-app path for apps.install-preview. */
  packagePath?: string;
  app?: string;
  digest?: string;
  grantKind?: "network" | "files" | "notifications";
  declaration?: string;
  destination?: string;
  automation?: string;
  /** Typed presentation file path for apps.project.declare, resolved host-side. */
  presentationPath?: string;
  release?: string;
  targetSpace?: string;
  instance?: string;
  operation?: string;
  retained?: string;
  /** Explicit apps.uninstall data disposition; deliberately never defaulted. */
  disposition?: "retain-data" | "purge-data";
  /** Snapshot-caching opt-in for pages.stage; an explicitly labeled choice, never defaulted on. */
  snapshot?: boolean;
  /** Staged-act id for staged.show and staged.cancel. */
  stagedActId?: string;
  /** Routing id for the routings management verbs; routings take no --space. */
  routing?: string;
  /** Publication id for the pages management verbs. */
  publication?: string;
  /** Narrowed serve-rate budget for pages.narrow. */
  serveRatePerMinute?: number;
  /** Narrowed daily byte budget for pages.narrow. */
  byteBudgetPerDay?: number;
}

/**
 * Consecrated ledger rows (docs/fold-act-ledger.md): invoking one stages a
 * pending decision instead of executing, once the decision machinery exists.
 * `apps.uninstall` is consecrated only with `--purge-data`, so classification
 * reads the parsed command, never the command name alone.
 */
export const WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES = [
  "spaces.delete",
  "files.destroy",
  "tools.import-skill",
  "tools.install",
  "tools.update",
  "apps.install-proposal",
  "apps.install-preview",
  "apps.grant",
  "apps.connect",
  "apps.automation.enable",
  "apps.storage.clear",
  "apps.retained.purge",
  "routings.stage",
  "pages.stage",
  "pages.stage-app",
] as const;

export type WorkFoldCliActStagedCommandName = (typeof WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES)[number];

export function isWorkFoldCliActStagedCommand(
  command: Pick<WorkFoldCliActParsedCommand, "name" | "disposition">,
): boolean {
  if ((WORKFOLD_CLI_ACT_STAGED_COMMAND_NAMES as readonly string[]).includes(command.name)) return true;
  return command.name === "apps.uninstall" && command.disposition === "purge-data";
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
  "Open work-fold to run this command. Act commands need the work-fold app running.";

const maxActResultMessages = 500;
const maxActFromPaths = 25;
const maxActPathLength = 4_096;
/** Mirrors `maxQueryLength` in src/local/search.ts so parse and service refuse together. */
const maxActSearchQueryLength = 200;
const maxChecksCliIdLength = 256;
const maxChecksProposalPathLength = 4_096;
const maxChecksOutputFindings = 100;
const maxChecksOutputHealthErrors = 20;

const cliControlCharacters = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Setup-only families (docs/fold-act-ledger.md): authority and secret
 * surfaces the act lane can neither perform nor stage. They are refused at
 * parse time — before any journal entry — so an act that would amount to one
 * can never even be shaped, and the act lane never grows a verb for them.
 */
const workFoldCliActSetupOnlyFamilies = new Map<string, string>([
  ["remote", "Remote access administration"],
  ["browser", "Remote access administration"],
  ["browsers", "Remote access administration"],
  ["pairing", "Act-token and pairing machinery"],
  ["token", "Act-token and pairing machinery"],
  ["tokens", "Act-token and pairing machinery"],
  ["provider", "Provider credentials"],
  ["providers", "Provider credentials"],
  ["credentials", "Provider credentials"],
  ["settings", "Settings administration"],
  ["policy", "Standing-policy authoring"],
  ["policies", "Standing-policy authoring"],
]);

/**
 * Parses act-lane argv. Every command requires explicit selection — there is
 * deliberately no current-directory Space resolution for writes.
 */
export function parseWorkFoldCliActArgv(argv: readonly string[]): WorkFoldCliActParsedCommand {
  let output: WorkFoldCliOutputMode = "human";
  const flags = new Map<string, string | true>();
  const fromPaths: string[] = [];
  const attachValues: string[] = [];
  const pathValues: string[] = [];
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
    "--title",
    "--label",
    "--checkpoint",
    "--version",
    "--query",
    "--scope",
    "--item",
    "--id",
    "--source",
    "--app",
    "--digest",
    "--kind",
    "--declaration",
    "--destination",
    "--automation",
    "--package",
    "--presentation",
    "--release",
    "--target-space",
    "--instance",
    "--operation",
    "--retained",
    "--routing",
    "--publication",
    "--provider",
    "--model",
    "--instructions",
    "--serve-rate",
    "--byte-budget",
  ]);
  const booleanFlags = new Set(["--new", "--message-from-payload", "--retain-data", "--purge-data", "--snapshot", "--clear"]);

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
      if (flagName === "--path") {
        pathValues.push(value);
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
    if (!positional.length) {
      // Setup-only refusal happens here, at parse time: these families must
      // not even reach an unknown-command error,
      // let alone a journal entry or a staged act.
      const setupOnlyCategory = workFoldCliActSetupOnlyFamilies.get(token);
      if (setupOnlyCategory !== undefined) {
        throw new WorkFoldCliError(
          "permissionDenied",
          `${setupOnlyCategory} is local setup only. The act lane can neither perform nor stage it.`,
        );
      }
    }
    positional.push(token);
  }

  const command = positional.join(" ");
  const fromCommands = new Set(["files add", "files move", "library add", "tools import-skill"]);
  if (!fromCommands.has(command) && fromPaths.length) {
    throw usageError(`--from cannot be used with '${command || "(none)"}'.`);
  }
  if (command !== "manage send" && attachValues.length) {
    throw usageError(`--attach cannot be used with '${command || "(none)"}'.`);
  }
  const pathCommands = new Set([
    "spaces register",
    "files rename",
    "files delete",
    "files destroy",
    "files mkdir",
    "files create",
    "history versions",
    "history restore-file",
    "pages stage",
  ]);
  if (!pathCommands.has(command) && pathValues.length) {
    throw usageError(`--path cannot be used with '${command || "(none)"}'.`);
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
    if (cliControlCharacters.test(value)) {
      throw usageError(`${name} contains unsupported control characters.`);
    }
    return value;
  };
  const optionalBoundedFlag = (name: string, label: string, maximumLength = maxChecksCliIdLength): string | undefined =>
    stringFlag(name) === undefined ? undefined : requireBoundedFlag(name, label, maximumLength);
  const boundedActPath = (flag: string, raw: string, label: string): string => {
    const value = raw.trim();
    if (!value) throw usageError(`Provide ${flag} <${label}>.`);
    if (value.length > maxActPathLength) throw usageError(`${flag} must be at most ${maxActPathLength} characters.`);
    if (cliControlCharacters.test(value)) throw usageError(`${flag} contains unsupported control characters.`);
    return value;
  };
  const requireSinglePath = (label: string): string => {
    if (pathValues.length > 1) throw usageError("--path may be provided only once.");
    if (!pathValues.length) throw usageError(`Provide --path <${label}>.`);
    return boundedActPath("--path", pathValues[0] ?? "", label);
  };
  const requireDestroyPaths = (label: string): string[] => {
    if (!pathValues.length) throw usageError(`Provide at least one --path <${label}>.`);
    if (pathValues.length > maxActFromPaths) throw usageError(`At most ${maxActFromPaths} --path targets are allowed.`);
    return pathValues.map((value) => boundedActPath("--path", value, label));
  };
  const requireSingleFrom = (label: string): string => {
    if (fromPaths.length !== 1) throw usageError(`Provide exactly one --from <${label}>.`);
    return boundedActPath("--from", fromPaths[0] ?? "", label);
  };
  const requireIsoUntil = (): string => {
    const rawUntil = requireBoundedFlag("--until", "ISO-timestamp");
    if (!Number.isFinite(Date.parse(rawUntil))) throw usageError("--until must be an ISO timestamp.");
    return new Date(rawUntil).toISOString();
  };
  /**
   * Scope is authority (docs/fold-act-ledger.md): `space` scope must name its
   * Space explicitly, and `personal` scope must not carry one.
   */
  const requireToolsScope = (): { toolsScope: "personal" | "space"; space?: string } => {
    const rawScope = requireBoundedFlag("--scope", "personal|space");
    if (rawScope !== "personal" && rawScope !== "space") throw usageError("--scope must be personal or space.");
    const space = stringFlag("--space")?.trim();
    if (rawScope === "space" && !space) throw usageError("--scope space requires an explicit --space <id-or-name>.");
    if (rawScope === "personal" && space) throw usageError("--space cannot be used with --scope personal.");
    return { toolsScope: rawScope, ...(space ? { space } : {}) };
  };
  const rawParentTaskId = stringFlag("--parent-task");
  // Every mutation family accepts explicit management lineage; content-bearing
  // act reads (status, result, list, versions, search) deliberately do not.
  const lineageCommands = new Set([
    "chat send",
    "chat rename",
    "chat snooze",
    "chat archive",
    "chat resume",
    "chat compact",
    "history save",
    "history restore",
    "history restore-file",
    "files add",
    "files move",
    "files rename",
    "files delete",
    "files destroy",
    "files mkdir",
    "files create",
    "library add",
    "library folder create",
    "library copy",
    "spaces create",
    "spaces register",
    "spaces rename",
    "spaces unregister",
    "spaces delete",
    "spaces appearance apply",
    "spaces appearance reset",
    "spaces appearance undo",
    "spaces assistant model",
    "spaces assistant instructions",
    "tools import-skill",
    "tools install",
    "tools update",
    "tools remove",
    "apps proposals dismiss",
    "apps install-proposal",
    "apps install-preview",
    "apps remove",
    "apps grant",
    "apps revoke",
    "apps connect",
    "apps disconnect",
    "apps automation enable",
    "apps automation disable",
    "apps automation run",
    "apps storage clear",
    "apps retained purge",
    "apps project declare",
    "apps release prepare",
    "apps release publish",
    "apps release delete",
    "apps install prepare",
    "apps update prepare",
    "apps operation activate",
    "apps operation cancel",
    "apps uninstall",
    "routings stage",
    "routings run",
    "routings stop",
    "routings disable",
    "routings delete",
    "pages stage",
    "pages stage-app",
    "pages revoke",
    "pages narrow",
    "pages snapshot-off",
    "staged cancel",
  ]);
  if (rawParentTaskId !== undefined && !lineageCommands.has(command)) {
    throw usageError(`--parent-task cannot be used with '${command || "(none)"}'.`);
  }
  const parentTaskId = rawParentTaskId === undefined
    ? undefined
    : requireBoundedFlag("--parent-task", "management-task-id");

  switch (command) {
    case "chat create":
      allowOnlyFlags("--space");
      return { name: "chat.create", output, space: requireSpace() };
    case "chat send": {
      allowOnlyFlags("--space", "--conversation", "--new", "--message", "--message-from-payload", "--parent-task");
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
      allowOnlyFlags("--space", "--conversation", "--task");
      const selection = requireConversationOrTask();
      return { name: "chat.status", output, space: requireSpace(), ...selection };
    }
    case "chat result": {
      allowOnlyFlags("--space", "--conversation", "--task", "--messages");
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
      allowOnlyFlags("--space", "--conversation");
      return { name: "chat.abort", output, space: requireSpace(), conversation: requireConversation() };
    case "chat rename":
      allowOnlyFlags("--space", "--conversation", "--title", "--parent-task");
      return {
        name: "chat.rename",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        title: requireBoundedFlag("--title", "title"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat snooze":
      allowOnlyFlags("--space", "--conversation", "--until", "--parent-task");
      return {
        name: "chat.snooze",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        until: requireIsoUntil(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat archive":
      allowOnlyFlags("--space", "--conversation", "--parent-task");
      return {
        name: "chat.archive",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat resume":
      allowOnlyFlags("--space", "--conversation", "--parent-task");
      return {
        name: "chat.resume",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat compact":
      allowOnlyFlags("--space", "--conversation", "--parent-task");
      return {
        name: "chat.compact",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
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
      allowOnlyFlags("--conversation", "--new", "--message", "--message-from-payload");
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
      allowOnlyFlags("--task");
      const task = stringFlag("--task")?.trim();
      if (!task) throw usageError("Provide --task <id>.");
      return { name: "manage.stop", output, task };
    }
    case "manage status": {
      allowOnlyFlags("--conversation", "--task");
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
      allowOnlyFlags("--conversation", "--task", "--messages");
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
      allowOnlyFlags("--conversation");
      return {
        name: "manage.abort",
        output,
        ...(stringFlag("--conversation")?.trim() ? { conversation: stringFlag("--conversation")!.trim() } : {}),
      };
    case "manage list":
      allowOnlyFlags();
      return { name: "manage.list", output };
    case "manage glance":
      allowOnlyFlags();
      return { name: "manage.glance", output };
    case "chats list":
      allowOnlyFlags("--space");
      return { name: "chats.list", output, space: requireSpace() };
    case "history list":
      allowOnlyFlags("--space");
      return { name: "history.list", output, space: requireSpace() };
    case "history save": {
      allowOnlyFlags("--space", "--label", "--parent-task");
      const label = optionalBoundedFlag("--label", "label");
      return {
        name: "history.save",
        output,
        space: requireSpace(),
        ...(label !== undefined ? { label } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "history restore":
      allowOnlyFlags("--space", "--checkpoint", "--parent-task");
      return {
        name: "history.restore",
        output,
        space: requireSpace(),
        checkpoint: requireBoundedFlag("--checkpoint", "checkpoint-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "history versions":
      allowOnlyFlags("--space");
      return {
        name: "history.versions",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
      };
    case "history restore-file":
      allowOnlyFlags("--space", "--version", "--parent-task");
      return {
        name: "history.restore-file",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
        version: requireBoundedFlag("--version", "sha256"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "search": {
      allowOnlyFlags("--space", "--query", "--scope");
      const query = requireBoundedFlag("--query", "text", maxActSearchQueryLength);
      const rawScope = optionalBoundedFlag("--scope", "files|chats|all");
      if (rawScope !== undefined && rawScope !== "files" && rawScope !== "chats" && rawScope !== "all") {
        throw usageError("--scope must be files, chats, or all.");
      }
      return {
        name: "search",
        output,
        space: requireSpace(),
        query,
        ...(rawScope !== undefined ? { searchScope: rawScope } : {}),
      };
    }
    case "library list":
      allowOnlyFlags();
      return { name: "library.list", output };
    case "library add": {
      // The Library is personal and Space-free: no --space, no restore point.
      allowOnlyFlags("--to", "--parent-task");
      if (!fromPaths.length) throw usageError("Provide at least one --from <path>.");
      if (fromPaths.length > maxActFromPaths) throw usageError(`At most ${maxActFromPaths} --from sources are allowed.`);
      const toDir = optionalBoundedFlag("--to", "library-folder", maxActPathLength);
      return {
        name: "library.add",
        output,
        fromPaths: fromPaths.map((value) => boundedActPath("--from", value, "path")),
        ...(toDir !== undefined ? { toDir } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "library folder create":
      allowOnlyFlags("--name", "--parent-task");
      return {
        name: "library.folder.create",
        output,
        folderName: requireBoundedFlag("--name", "folder-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "library copy":
      allowOnlyFlags("--item", "--space", "--parent-task");
      return {
        name: "library.copy",
        output,
        item: requireBoundedFlag("--item", "library-path", maxActPathLength),
        space: requireSpace(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces create": {
      allowOnlyFlags("--name", "--parent-task");
      const spaceName = stringFlag("--name")?.trim();
      if (!spaceName) throw usageError("Provide --name <space-name>.");
      return { name: "spaces.create", output, spaceName, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "spaces register": {
      allowOnlyFlags("--parent-task");
      if (pathValues.length > 1) throw usageError("--path may be provided only once.");
      const registerPath = pathValues[0]?.trim();
      if (!registerPath) throw usageError("Provide --path <absolute-folder-path>.");
      return { name: "spaces.register", output, registerPath, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "spaces rename":
      allowOnlyFlags("--space", "--name", "--parent-task");
      return {
        name: "spaces.rename",
        output,
        space: requireSpace(),
        spaceName: requireBoundedFlag("--name", "space-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces unregister":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "spaces.unregister",
        output,
        space: requireSpace(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces delete":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "spaces.delete",
        output,
        space: requireSpace(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces appearance apply":
      // File-borne input: the typed proposal passes as a path resolved
      // host-side, the same pattern as `checks enable --proposal`.
      allowOnlyFlags("--space", "--proposal", "--parent-task");
      return {
        name: "spaces.appearance.apply",
        output,
        space: requireSpace(),
        proposalPath: requireBoundedFlag("--proposal", "proposal-path", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces appearance reset":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "spaces.appearance.reset",
        output,
        space: requireSpace(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces appearance undo":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "spaces.appearance.undo",
        output,
        space: requireSpace(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces assistant show":
      allowOnlyFlags("--space");
      return { name: "spaces.assistant.show", output, space: requireSpace() };
    case "spaces assistant model":
      allowOnlyFlags("--space", "--provider", "--model", "--parent-task");
      return {
        name: "spaces.assistant.model",
        output,
        space: requireSpace(),
        provider: requireBoundedFlag("--provider", "provider-id"),
        model: requireBoundedFlag("--model", "model-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "spaces assistant instructions": {
      allowOnlyFlags("--space", "--instructions", "--clear", "--parent-task");
      const clear = flags.get("--clear") === true;
      const rawInstructions = stringFlag("--instructions");
      if (clear === (rawInstructions !== undefined)) {
        throw usageError("Provide exactly one of --instructions <text> or --clear.");
      }
      if (rawInstructions !== undefined && rawInstructions.length > maximumAssistantInstructionsLength) {
        throw usageError(`--instructions must be at most ${maximumAssistantInstructionsLength} characters.`);
      }
      return {
        name: "spaces.assistant.instructions",
        output,
        space: requireSpace(),
        instructions: clear ? "" : rawInstructions!,
        ...(clear ? { clear: true } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "files add": {
      allowOnlyFlags("--space", "--to", "--parent-task");
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
    case "files move":
      allowOnlyFlags("--space", "--to", "--parent-task");
      return {
        name: "files.move",
        output,
        space: requireSpace(),
        fromPaths: [requireSingleFrom("space-path")],
        toDir: requireBoundedFlag("--to", "space-folder", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files rename":
      allowOnlyFlags("--space", "--name", "--parent-task");
      return {
        name: "files.rename",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
        entryName: requireBoundedFlag("--name", "new-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files delete":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "files.delete",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files destroy":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "files.destroy",
        output,
        space: requireSpace(),
        paths: requireDestroyPaths("space-path"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files mkdir":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "files.mkdir",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-folder"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files create":
      allowOnlyFlags("--space", "--parent-task");
      return {
        name: "files.create",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools import-skill":
      allowOnlyFlags("--scope", "--space", "--parent-task");
      return {
        name: "tools.import-skill",
        output,
        ...requireToolsScope(),
        fromPaths: [requireSingleFrom("skill-path")],
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools install": {
      allowOnlyFlags("--id", "--source", "--scope", "--space", "--parent-task");
      const catalogId = optionalBoundedFlag("--id", "catalog-id");
      const source = optionalBoundedFlag("--source", "package-source", maxActPathLength);
      if ((catalogId === undefined) === (source === undefined)) {
        throw usageError("Provide exactly one of --id <catalog-id> or --source <package-source>.");
      }
      return {
        name: "tools.install",
        output,
        ...requireToolsScope(),
        ...(catalogId !== undefined ? { catalogId } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "tools update":
      allowOnlyFlags("--source", "--scope", "--space", "--parent-task");
      return {
        name: "tools.update",
        output,
        ...requireToolsScope(),
        source: requireBoundedFlag("--source", "package-source", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools remove":
      allowOnlyFlags("--source", "--scope", "--space", "--parent-task");
      return {
        name: "tools.remove",
        output,
        ...requireToolsScope(),
        source: requireBoundedFlag("--source", "package-source", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps proposals list":
      allowOnlyFlags("--space", "--conversation");
      return {
        name: "apps.proposals.list",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
      };
    case "apps proposals dismiss":
      allowOnlyFlags("--space", "--conversation", "--proposal", "--parent-task");
      return {
        name: "apps.proposals.dismiss",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        proposal: requireBoundedFlag("--proposal", "proposal-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps install-proposal":
      allowOnlyFlags("--space", "--conversation", "--proposal", "--parent-task");
      return {
        name: "apps.install-proposal",
        output,
        space: requireSpace(),
        conversation: requireConversation(),
        proposal: requireBoundedFlag("--proposal", "proposal-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps install-preview":
      allowOnlyFlags("--space", "--package", "--parent-task");
      return {
        name: "apps.install-preview",
        output,
        space: requireSpace(),
        packagePath: requireBoundedFlag("--package", "space-path", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps remove":
      allowOnlyFlags("--space", "--app", "--parent-task");
      return {
        name: "apps.remove",
        output,
        space: requireSpace(),
        app: requireBoundedFlag("--app", "app-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps grant":
    case "apps revoke": {
      allowOnlyFlags("--space", "--app", "--digest", "--kind", "--declaration", "--parent-task");
      const rawKind = requireBoundedFlag("--kind", "network|files|notifications");
      if (rawKind !== "network" && rawKind !== "files" && rawKind !== "notifications") {
        throw usageError("--kind must be network, files, or notifications.");
      }
      return {
        name: command === "apps grant" ? "apps.grant" : "apps.revoke",
        output,
        space: requireSpace(),
        app: requireBoundedFlag("--app", "app-id"),
        digest: requireBoundedFlag("--digest", "sha256"),
        grantKind: rawKind,
        declaration: requireBoundedFlag("--declaration", "declaration-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "apps connect":
    case "apps disconnect":
      // The staged act names app, destination, and adapter only; credentials
      // never ride argv, payloads, or the journal.
      allowOnlyFlags("--space", "--app", "--destination", "--parent-task");
      return {
        name: command === "apps connect" ? "apps.connect" : "apps.disconnect",
        output,
        space: requireSpace(),
        app: requireBoundedFlag("--app", "app-id"),
        destination: requireBoundedFlag("--destination", "destination-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps automation enable":
    case "apps automation disable":
    case "apps automation run":
      allowOnlyFlags("--space", "--app", "--automation", "--parent-task");
      return {
        name: command === "apps automation enable"
          ? "apps.automation.enable"
          : command === "apps automation disable"
            ? "apps.automation.disable"
            : "apps.automation.run",
        output,
        space: requireSpace(),
        app: requireBoundedFlag("--app", "app-id"),
        automation: requireBoundedFlag("--automation", "automation-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps storage clear":
      allowOnlyFlags("--space", "--app", "--parent-task");
      return {
        name: "apps.storage.clear",
        output,
        space: requireSpace(),
        app: requireBoundedFlag("--app", "app-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps retained purge":
      allowOnlyFlags("--space", "--retained", "--parent-task");
      return {
        name: "apps.retained.purge",
        output,
        space: requireSpace(),
        retained: requireBoundedFlag("--retained", "retained-data-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps project declare":
      // Same file-borne pattern as `checks enable --proposal`: the typed
      // presentation file passes as a path resolved host-side.
      allowOnlyFlags("--space", "--presentation", "--parent-task");
      return {
        name: "apps.project.declare",
        output,
        space: requireSpace(),
        presentationPath: requireBoundedFlag("--presentation", "json-path", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps release prepare":
      allowOnlyFlags("--space", "--version", "--parent-task");
      return {
        name: "apps.release.prepare",
        output,
        space: requireSpace(),
        version: requireBoundedFlag("--version", "display-version"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps release publish":
    case "apps release delete":
      allowOnlyFlags("--space", "--release", "--parent-task");
      return {
        name: command === "apps release publish" ? "apps.release.publish" : "apps.release.delete",
        output,
        space: requireSpace(),
        release: requireBoundedFlag("--release", "release-digest"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps install prepare":
      allowOnlyFlags("--space", "--release", "--target-space", "--parent-task");
      return {
        name: "apps.install.prepare",
        output,
        space: requireSpace(),
        release: requireBoundedFlag("--release", "release-digest"),
        targetSpace: requireBoundedFlag("--target-space", "space-id-or-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps update prepare":
      allowOnlyFlags("--space", "--instance", "--release", "--parent-task");
      return {
        name: "apps.update.prepare",
        output,
        space: requireSpace(),
        instance: requireBoundedFlag("--instance", "instance-id"),
        release: requireBoundedFlag("--release", "release-digest"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps operation activate":
    case "apps operation cancel":
      allowOnlyFlags("--space", "--operation", "--parent-task");
      return {
        name: command === "apps operation activate" ? "apps.operation.activate" : "apps.operation.cancel",
        output,
        space: requireSpace(),
        operation: requireBoundedFlag("--operation", "operation-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "apps uninstall": {
      allowOnlyFlags("--space", "--instance", "--retain-data", "--purge-data", "--parent-task");
      const retainData = flags.get("--retain-data") === true;
      const purgeData = flags.get("--purge-data") === true;
      if (retainData === purgeData) {
        throw usageError("Provide exactly one of --retain-data or --purge-data; the disposition is never defaulted.");
      }
      return {
        name: "apps.uninstall",
        output,
        space: requireSpace(),
        instance: requireBoundedFlag("--instance", "instance-id"),
        disposition: retainData ? "retain-data" : "purge-data",
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "routings stage":
      // Routings are above Spaces (docs/fold-routings.md): no --space, like
      // the manage group. The inert typed proposal passes as a path resolved
      // host-side, the same pattern as `checks enable --proposal`.
      allowOnlyFlags("--proposal", "--parent-task");
      return {
        name: "routings.stage",
        output,
        proposalPath: requireBoundedFlag("--proposal", "proposal-path", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "routings list":
      allowOnlyFlags();
      return { name: "routings.list", output };
    case "routings show":
      allowOnlyFlags("--routing");
      return { name: "routings.show", output, routing: requireBoundedFlag("--routing", "routing-id") };
    case "routings run":
    case "routings stop":
    case "routings disable":
    case "routings delete":
      allowOnlyFlags("--routing", "--parent-task");
      return {
        name: command === "routings run"
          ? "routings.run"
          : command === "routings stop"
            ? "routings.stop"
            : command === "routings disable"
              ? "routings.disable"
              : "routings.delete",
        output,
        routing: requireBoundedFlag("--routing", "routing-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "routings receipts": {
      allowOnlyFlags("--routing");
      const routing = optionalBoundedFlag("--routing", "routing-id");
      return { name: "routings.receipts", output, ...(routing ? { routing } : {}) };
    }
    case "pages stage":
      // Outward exposure staging (docs/fold-publishing.md): the page slot's
      // pins are the Space id, exact relative path, title, budgets, and the
      // snapshot flag. Snapshot caching is an explicitly labeled opt-in.
      allowOnlyFlags("--space", "--title", "--snapshot", "--parent-task");
      return {
        name: "pages.stage",
        output,
        space: requireSpace(),
        path: requireSinglePath("space-path"),
        title: requireBoundedFlag("--title", "page-title"),
        ...(flags.get("--snapshot") === true ? { snapshot: true } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "pages stage-app":
      // Hosted-app exposure staging (docs/fold-publishing.md, rung 3): the
      // pins — App Instance id, exact Release digest, viewer entry, complete
      // viewer-readable surface — are resolved host-side from the installed
      // Instance's reviewed manifest, never supplied here. Snapshot caching
      // does not exist for apps: asleep is the only offline state.
      allowOnlyFlags("--space", "--instance", "--parent-task");
      return {
        name: "pages.stage-app",
        output,
        space: requireSpace(),
        instance: requireBoundedFlag("--instance", "instance-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "pages list":
      allowOnlyFlags();
      return { name: "pages.list", output };
    case "pages status":
      allowOnlyFlags("--publication");
      return { name: "pages.status", output, publication: requireBoundedFlag("--publication", "publication-id") };
    case "pages revoke":
    case "pages snapshot-off":
      // Narrowing verbs (docs/fold-publishing.md): revoking and turning
      // snapshot caching off never need a click; widening back is a fresh
      // consecration staged through `pages stage`.
      allowOnlyFlags("--publication", "--parent-task");
      return {
        name: command === "pages revoke" ? "pages.revoke" : "pages.snapshot-off",
        output,
        publication: requireBoundedFlag("--publication", "publication-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "pages narrow": {
      allowOnlyFlags("--publication", "--serve-rate", "--byte-budget", "--parent-task");
      const requirePositiveInteger = (flag: string, label: string): number | undefined => {
        const raw = stringFlag(flag);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) throw usageError(`${flag} must be a positive integer (${label}).`);
        return value;
      };
      const serveRatePerMinute = requirePositiveInteger("--serve-rate", "serves per minute");
      const byteBudgetPerDay = requirePositiveInteger("--byte-budget", "bytes per day");
      if (serveRatePerMinute === undefined && byteBudgetPerDay === undefined) {
        throw usageError("Provide --serve-rate <per-minute> and/or --byte-budget <bytes-per-day> to narrow.");
      }
      return {
        name: "pages.narrow",
        output,
        publication: requireBoundedFlag("--publication", "publication-id"),
        ...(serveRatePerMinute !== undefined ? { serveRatePerMinute } : {}),
        ...(byteBudgetPerDay !== undefined ? { byteBudgetPerDay } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "staged list":
      allowOnlyFlags();
      return { name: "staged.list", output };
    case "staged show":
      allowOnlyFlags("--id");
      return {
        name: "staged.show",
        output,
        stagedActId: requireBoundedFlag("--id", "staged-act-id"),
      };
    case "staged cancel":
      allowOnlyFlags("--id", "--parent-task");
      return {
        name: "staged.cancel",
        output,
        stagedActId: requireBoundedFlag("--id", "staged-act-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
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
        surface: "cli",
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
        surface: "cli",
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
        surface: "cli",
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
      surface: "cli",
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
      surface: "cli",
      ...lineage,
      ...receiptDetails(command.name, data),
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
        surface: "cli",
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
    case "spaces.assistant.show":
      return toJson(await facade.assistantShow({ space: command.space! }));
    case "spaces.assistant.model":
      return toJson(await facade.assistantSetModel({
        space: command.space!,
        provider: command.provider!,
        model: command.model!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.assistant.instructions":
      return toJson(await facade.assistantSetInstructions({
        space: command.space!,
        instructions: command.instructions ?? "",
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.create":
      return toJson(await facade.createConversation({ space: command.space! }));
    case "chat.send": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toJson(await facade.sendMessage({
        space: command.space!,
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.newConversation ? { newConversation: true } : {}),
        content,
        requestId: request.id,
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
        requestId: request.id,
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
    case "manage.glance":
      // The glance headlines carry person content (chat titles, labels), so
      // the snapshot passes through the same bounding sanitizer as Check
      // output before it reaches a terminal.
      return toChecksJson(await facade.manageGlance());
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
    case "chat.rename":
      return toJson(await facade.chatRename({
        space: command.space!,
        conversationId: command.conversation!,
        title: command.title!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.snooze":
      return toJson(await facade.chatSnooze({
        space: command.space!,
        conversationId: command.conversation!,
        until: command.until!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.archive":
      return toJson(await facade.chatArchive({
        space: command.space!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.resume":
      return toJson(await facade.chatResume({
        space: command.space!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.compact":
      return toJson(await facade.chatCompact({
        space: command.space!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.list":
      return toJson(await facade.historyList({ space: command.space! }));
    case "history.save":
      return toJson(await facade.historySave({
        space: command.space!,
        ...(command.label !== undefined ? { label: command.label } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.restore":
      return toJson(await facade.historyRestore({
        space: command.space!,
        checkpointId: command.checkpoint!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.versions":
      return toJson(await facade.historyVersions({ space: command.space!, path: command.path! }));
    case "history.restore-file":
      return toJson(await facade.historyRestoreFile({
        space: command.space!,
        path: command.path!,
        version: command.version!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.move":
      return toJson(await facade.filesMove({
        space: command.space!,
        fromPath: command.fromPaths![0]!,
        toDir: command.toDir!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.rename":
      return toJson(await facade.filesRename({
        space: command.space!,
        path: command.path!,
        newName: command.entryName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.delete":
      return toJson(await facade.filesDelete({
        space: command.space!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.mkdir":
      return toJson(await facade.filesMkdir({
        space: command.space!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.create":
      return toJson(await facade.filesCreate({
        space: command.space!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "search":
      return toJson(await facade.search({
        space: command.space!,
        query: command.query!,
        ...(command.searchScope ? { scope: command.searchScope } : {}),
      }));
    case "library.list":
      return toJson(await facade.libraryList());
    case "library.add":
      return toJson(await facade.libraryAdd({
        fromPaths: command.fromPaths ?? [],
        ...(command.toDir !== undefined ? { toDir: command.toDir } : {}),
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "library.folder.create":
      return toJson(await facade.libraryFolderCreate({
        name: command.folderName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "library.copy":
      return toJson(await facade.libraryCopy({
        item: command.item!,
        space: command.space!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.rename":
      return toJson(await facade.spacesRename({
        space: command.space!,
        name: command.spaceName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.unregister":
      return toJson(await facade.spacesUnregister({
        space: command.space!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.appearance.apply":
      return toJson(await facade.spacesAppearanceApply({
        space: command.space!,
        proposalPath: command.proposalPath!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.appearance.reset":
      return toJson(await facade.spacesAppearanceReset({
        space: command.space!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "spaces.appearance.undo":
      return toJson(await facade.spacesAppearanceUndo({
        space: command.space!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "tools.remove":
      return toJson(await facade.toolsRemove({
        scope: command.toolsScope!,
        ...(command.space ? { space: command.space } : {}),
        source: command.source!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.proposals.list":
      return toJson(await facade.appsProposalsList({
        space: command.space!,
        conversationId: command.conversation!,
      }));
    case "apps.proposals.dismiss":
      return toJson(await facade.appsProposalsDismiss({
        space: command.space!,
        conversationId: command.conversation!,
        proposal: command.proposal!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.remove":
      return toJson(await facade.appsRemove({
        space: command.space!,
        app: command.app!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.revoke":
      return toJson(await facade.appsRevoke({
        space: command.space!,
        app: command.app!,
        digest: command.digest!,
        kind: command.grantKind!,
        declaration: command.declaration!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.disconnect":
      return toJson(await facade.appsDisconnect({
        space: command.space!,
        app: command.app!,
        destination: command.destination!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.automation.disable":
      return toJson(await facade.appsAutomationDisable({
        space: command.space!,
        app: command.app!,
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.automation.run":
      return toJson(await facade.appsAutomationRun({
        space: command.space!,
        app: command.app!,
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.project.declare":
      return toJson(await facade.appsProjectDeclare({
        space: command.space!,
        presentationPath: command.presentationPath!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.release.prepare":
      return toJson(await facade.appsReleasePrepare({
        space: command.space!,
        version: command.version!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.release.publish":
      return toJson(await facade.appsReleasePublish({
        space: command.space!,
        release: command.release!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.release.delete":
      return toJson(await facade.appsReleaseDelete({
        space: command.space!,
        release: command.release!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.install.prepare":
      return toJson(await facade.appsInstallPrepare({
        space: command.space!,
        release: command.release!,
        targetSpace: command.targetSpace!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.update.prepare":
      return toJson(await facade.appsUpdatePrepare({
        space: command.space!,
        instance: command.instance!,
        release: command.release!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.operation.activate":
      return toJson(await facade.appsOperationActivate({
        space: command.space!,
        operation: command.operation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.operation.cancel":
      return toJson(await facade.appsOperationCancel({
        space: command.space!,
        operation: command.operation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "apps.uninstall":
      // The retain disposition is the direct verb; purging retained data is
      // destroying irreversibly, so `--purge-data` stages consecration 3 and
      // never reaches the retain-only uninstall method.
      if (command.disposition === "purge-data") {
        return toChecksJson(await facade.appsUninstallPurge({
          space: command.space!,
          instance: command.instance!,
          ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
          requestId: request.id,
        }));
      }
      return toJson(await facade.appsUninstall({
        space: command.space!,
        instance: command.instance!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    // The consecrated ledger rows (docs/fold-act-ledger.md; machinery in
    // docs/fold-consecrations.md): invoking one stages a fully prepared,
    // inert act and returns the pending decision's identity — it never
    // executes. Staged results pass the bounding sanitizer because pins carry
    // person content (paths, titles, names). `request.id` rides along as the
    // staged act's journal-id provenance.
    case "spaces.delete":
      return toChecksJson(await facade.spacesDelete({
        space: command.space!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "files.destroy":
      return toChecksJson(await facade.filesDestroy({
        space: command.space!,
        paths: command.paths ?? [],
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.import-skill":
      return toChecksJson(await facade.toolsImportSkill({
        scope: command.toolsScope!,
        ...(command.space ? { space: command.space } : {}),
        from: command.fromPaths![0]!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.install":
      return toChecksJson(await facade.toolsInstall({
        scope: command.toolsScope!,
        ...(command.space ? { space: command.space } : {}),
        ...(command.catalogId !== undefined ? { catalogId: command.catalogId } : {}),
        ...(command.source !== undefined ? { source: command.source } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.update":
      return toChecksJson(await facade.toolsUpdate({
        scope: command.toolsScope!,
        ...(command.space ? { space: command.space } : {}),
        source: command.source!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.install-proposal":
      return toChecksJson(await facade.appsInstallProposal({
        space: command.space!,
        conversationId: command.conversation!,
        proposal: command.proposal!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.grant":
      return toChecksJson(await facade.appsGrant({
        space: command.space!,
        app: command.app!,
        digest: command.digest!,
        kind: command.grantKind!,
        declaration: command.declaration!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.connect":
      return toChecksJson(await facade.appsConnect({
        space: command.space!,
        app: command.app!,
        destination: command.destination!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.automation.enable":
      return toChecksJson(await facade.appsAutomationEnable({
        space: command.space!,
        app: command.app!,
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.storage.clear":
      return toChecksJson(await facade.appsStorageClear({
        space: command.space!,
        app: command.app!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.retained.purge":
      return toChecksJson(await facade.appsRetainedPurge({
        space: command.space!,
        retained: command.retained!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "routings.stage":
      return toChecksJson(await facade.routingsStage({
        proposalPath: command.proposalPath!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "pages.stage":
      return toChecksJson(await facade.pagesStage({
        space: command.space!,
        path: command.path!,
        title: command.title!,
        ...(command.snapshot ? { snapshot: true } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "pages.stage-app":
      return toChecksJson(await facade.pagesStageApp({
        space: command.space!,
        instance: command.instance!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "apps.install-preview":
      // The host creates the pending review record over the named package and
      // stages the same `app.review.approve` kind an approved Chat proposal
      // uses — the closed staged-act vocabulary gains nothing.
      return toChecksJson(await facade.appsInstallPreview({
        space: command.space!,
        packagePath: command.packagePath!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    // Routing management verbs (docs/fold-routings.md): above Spaces, all
    // content-bearing results pass the bounding sanitizer. Run-now carries the
    // act request id into the run's own journal as its trigger cause.
    case "routings.list":
      return toChecksJson(await facade.routingsList());
    case "routings.show":
      return toChecksJson(await facade.routingsShow({ routing: command.routing! }));
    case "routings.run":
      return toChecksJson(await facade.routingsRun({
        routing: command.routing!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "routings.stop":
      return toChecksJson(await facade.routingsStop({
        routing: command.routing!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "routings.disable":
      return toChecksJson(await facade.routingsDisable({
        routing: command.routing!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "routings.delete":
      return toChecksJson(await facade.routingsDelete({
        routing: command.routing!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "routings.receipts":
      return toChecksJson(await facade.routingsReceipts({
        ...(command.routing ? { routing: command.routing } : {}),
      }));
    // Publication management verbs (docs/fold-publishing.md): list/status are
    // act reads; revoke and the narrowing verbs are direct, with the service
    // journaling its own accepted/terminal pair under a derived request id.
    case "pages.list":
      return toChecksJson(await facade.pagesList());
    case "pages.status":
      return toChecksJson(await facade.pagesStatus({ publication: command.publication! }));
    case "pages.revoke":
      return toChecksJson(await facade.pagesRevoke({
        publication: command.publication!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "pages.narrow":
      return toChecksJson(await facade.pagesNarrow({
        publication: command.publication!,
        ...(command.serveRatePerMinute !== undefined ? { serveRatePerMinute: command.serveRatePerMinute } : {}),
        ...(command.byteBudgetPerDay !== undefined ? { byteBudgetPerDay: command.byteBudgetPerDay } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "pages.snapshot-off":
      return toChecksJson(await facade.pagesSnapshotOff({
        publication: command.publication!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "staged.list":
      return toChecksJson(await facade.stagedList());
    case "staged.show":
      return toChecksJson(await facade.stagedShow({ id: command.stagedActId! }));
    case "staged.cancel":
      return toChecksJson(await facade.stagedCancel({
        id: command.stagedActId!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
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
    case "manage.glance": {
      const snapshot = data as {
        composedAt?: string;
        running?: Array<{ headline?: string; spaceName?: string }>;
        needsYou?: Array<{ headline?: string; spaceName?: string }>;
        changes?: Array<{ headline?: string; spaceName?: string }>;
        checks?: Array<{ spaceName?: string; state?: string; needsAttention?: number }>;
        truncated?: { running?: boolean; needsYou?: boolean; changes?: boolean; checks?: boolean };
        unavailable?: string[];
      };
      const item = (entry: { headline?: string; spaceName?: string }): string =>
        `- ${terminalText(entry.headline)}${entry.spaceName ? ` (${terminalText(entry.spaceName)})` : ""}`;
      const section = (label: string, entries: Array<{ headline?: string; spaceName?: string }> | undefined, truncated: boolean | undefined, quiet: string): string[] => {
        const list = entries ?? [];
        if (!list.length) return [`${label}: ${quiet}`];
        return [
          `${label}${truncated ? " (more omitted)" : ""}:`,
          ...list.map(item),
        ];
      };
      const lines = [
        `The glance at ${terminalText(snapshot.composedAt)}`,
        ...section("Running", snapshot.running, snapshot.truncated?.running, "nothing running"),
        ...section("Needs you", snapshot.needsYou, snapshot.truncated?.needsYou, "nothing waiting on you"),
        ...section("Since you last looked", snapshot.changes, snapshot.truncated?.changes, "no recorded changes"),
      ];
      const checks = snapshot.checks ?? [];
      if (checks.length) {
        lines.push(`Checks${snapshot.truncated?.checks ? " (more omitted)" : ""}:`);
        for (const row of checks) {
          const attention = typeof row.needsAttention === "number" && row.needsAttention > 0
            ? ` — ${row.needsAttention} finding${row.needsAttention === 1 ? "" : "s"} need attention`
            : "";
          lines.push(`- ${terminalText(row.spaceName)}: ${terminalText(row.state)}${attention}`);
        }
      }
      const unavailable = snapshot.unavailable ?? [];
      if (unavailable.length) {
        lines.push(`Unavailable sources this composition: ${unavailable.map(terminalText).join(", ")}.`);
      }
      return `${lines.join("\n")}\n`;
    }
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
    case "spaces.assistant.show": {
      const model = record.model as { provider?: unknown; id?: unknown } | null | undefined;
      const availableModels = Array.isArray(record.availableModels)
        ? record.availableModels as Array<{ provider?: unknown; id?: unknown; name?: unknown }>
        : [];
      const instructions = typeof record.instructions === "string" && record.instructions
        ? record.instructions
        : "(none)";
      const choices = availableModels.length
        ? availableModels.map((item) => `- ${terminalText(item.name)} (${terminalText(item.provider)}/${terminalText(item.id)})`).join("\n")
        : "(none connected)";
      return `${spaceLabel}\nDefault model for new Chats: ${model ? `${terminalText(model.provider)}/${terminalText(model.id)}` : "not selected"}\nAvailable connected models:\n${choices}\nSpace instructions:\n${terminalText(instructions)}\n`;
    }
    case "spaces.assistant.model": {
      const model = record.model as { provider?: unknown; id?: unknown } | null | undefined;
      return `Saved ${terminalText(model?.provider)}/${terminalText(model?.id)} as the default for new Chats in ${spaceLabel}.\n`;
    }
    case "spaces.assistant.instructions":
      return typeof record.instructions === "string" && record.instructions
        ? `Saved Space instructions for ${spaceLabel}.\n`
        : `Cleared Space instructions for ${spaceLabel}.\n`;
    case "files.add": {
      const copied = Array.isArray(record.copied) ? record.copied : [];
      const lines = copied.map((path) => `- ${terminalText(path)}`);
      const checkpoint = record.checkpointId ? `Restore point: ${terminalText(record.checkpointId)}\n` : "";
      return `Added ${copied.length} item${copied.length === 1 ? "" : "s"} to ${spaceLabel}:\n${lines.join("\n")}\n${checkpoint}`;
    }
    case "chat.rename": {
      const conversation = record.conversation;
      return `Renamed Chat [${terminalText(conversation?.id)}] to "${terminalText(conversation?.title)}" in ${spaceLabel} (was "${terminalText(record.priorTitle)}").\n`;
    }
    case "chat.snooze": {
      const conversation = record.conversation;
      return `Snoozed Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] until ${terminalText(conversation?.snoozedUntil)} in ${spaceLabel}. Resume it with 'chat resume'.\n`;
    }
    case "chat.archive": {
      const conversation = record.conversation;
      return `Archived Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] in ${spaceLabel}. Restore it with 'chat resume'.\n`;
    }
    case "chat.resume": {
      const conversation = record.conversation;
      const prior = record.priorLifecycle as Partial<WorkFoldActChatLifecycleState> | undefined;
      const was = prior?.archivedAt
        ? " (was archived)"
        : prior?.snoozedUntil ? ` (was snoozed until ${terminalText(prior.snoozedUntil)})` : "";
      return `Resumed Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] in ${spaceLabel}${was}.\n`;
    }
    case "chat.compact":
      return `Compacted Chat [${terminalText(record.conversationId)}] in ${spaceLabel} (task ${terminalText(record.taskId)}). `
        + `Compaction is additive summarization; nothing was deleted.\n`;
    case "history.list": {
      const checkpoints = (Array.isArray(record.checkpoints) ? record.checkpoints : []) as Array<Partial<WorkFoldActCheckpointSummary>>;
      if (!checkpoints.length) return `No restore points saved in ${spaceLabel}.\n`;
      const lines = checkpoints.map((checkpoint) =>
        `- ${terminalText(checkpoint.checkpointId)} — ${terminalText(checkpoint.createdAt)} — ${terminalText(checkpoint.label ?? checkpoint.reason)} (${terminalText(checkpoint.fileCount)} file${checkpoint.fileCount === 1 ? "" : "s"})`);
      return `${checkpoints.length} restore point${checkpoints.length === 1 ? "" : "s"} in ${spaceLabel}:\n${lines.join("\n")}\n`;
    }
    case "history.save": {
      const checkpoint = record.checkpoint as Partial<WorkFoldActCheckpointSummary> | undefined;
      if (record.created === false) {
        return `${spaceLabel} already matches restore point ${terminalText(checkpoint?.checkpointId)}; no new restore point was created.\n`;
      }
      return `Saved restore point ${terminalText(checkpoint?.checkpointId)} (${terminalText(checkpoint?.fileCount)} file${checkpoint?.fileCount === 1 ? "" : "s"}) in ${spaceLabel}.\n`;
    }
    case "history.restore": {
      const skipped = typeof record.skippedLargeFileCount === "number" && record.skippedLargeFileCount > 0
        ? `\nHistory skipped ${terminalText(record.skippedLargeFileCount)} oversized file${record.skippedLargeFileCount === 1 ? "" : "s"} recorded by that restore point.`
        : "";
      return `Restored ${spaceLabel} to restore point ${terminalText(record.checkpointId)}.\n${terminalText(record.restoredFileCount)} file(s) restored; ${terminalText(record.deletedFileCount)} deleted; ${terminalText(record.movedEntryCount)} moved back; ${terminalText(record.unchangedFileCount)} unchanged.${skipped}\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    }
    case "history.versions": {
      const versions = (Array.isArray(record.versions) ? record.versions : []) as Array<Partial<WorkFoldActFileVersionRef>>;
      if (!versions.length) return `No saved versions of ${terminalText(record.path)} in ${spaceLabel}.\n`;
      const lines = versions.map((version) =>
        `- ${terminalText(version.hashSha256)} — captured ${terminalText(version.capturedAt)} (${terminalText(version.sizeBytes)} bytes)`);
      return `${versions.length} saved version${versions.length === 1 ? "" : "s"} of ${terminalText(record.path)} in ${spaceLabel}:\n${lines.join("\n")}\n`;
    }
    case "history.restore-file":
      return `Restored ${terminalText(record.path)} to version ${terminalText(record.hashSha256)} in ${spaceLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.move":
      return `Moved ${terminalText(record.fromPath)} to ${terminalText(record.path)} in ${spaceLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.rename":
      return `Renamed ${terminalText(record.fromPath)} to ${terminalText(record.path)} in ${spaceLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.delete":
      return `Deleted ${record.kind === "folder" ? "folder" : "file"} ${terminalText(record.path)} in ${spaceLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)} — restore it with 'history restore' to undo this delete.\n`;
    case "files.mkdir":
      return `Created folder ${terminalText(record.path)} in ${spaceLabel}.\n`;
    case "files.create":
      return `Created empty file ${terminalText(record.path)} in ${spaceLabel}.\n`;
    case "search": {
      const files = (Array.isArray(record.files) ? record.files : []) as Array<{ path?: unknown; line?: unknown; preview?: unknown }>;
      const chats = (Array.isArray(record.chats) ? record.chats : []) as Array<{ conversationId?: unknown; title?: unknown; role?: unknown; preview?: unknown }>;
      const total = files.length + chats.length;
      const scopeLabel = `scope ${terminalText(record.scope ?? "all")}`;
      // The service's bounds are part of the answer: a stopped search must
      // never read as a complete one.
      const boundNote = record.truncated === true
        ? "\nA search bound stopped before covering everything; the results may be incomplete."
        : "";
      if (!total) return `No matches for "${terminalText(record.query)}" in ${spaceLabel} (${scopeLabel}).${boundNote}\n`;
      const sections: string[] = [];
      if (files.length) {
        const shown = files.slice(0, 20);
        sections.push(`Files (${files.length}):`);
        sections.push(...shown.map((match) => `- ${terminalText(match.path)}:${terminalText(match.line)} — ${terminalText(match.preview)}`));
        if (files.length > shown.length) sections.push(`${files.length - shown.length} more file match(es) in the --json result.`);
      }
      if (chats.length) {
        const shown = chats.slice(0, 10);
        sections.push(`Chats (${chats.length}):`);
        sections.push(...shown.map((match) => `- ${terminalText(match.title)} [${terminalText(match.conversationId)}] (${terminalText(match.role)}) — ${terminalText(match.preview)}`));
        if (chats.length > shown.length) sections.push(`${chats.length - shown.length} more Chat match(es) in the --json result.`);
      }
      return `${total} match${total === 1 ? "" : "es"} for "${terminalText(record.query)}" in ${spaceLabel} (${scopeLabel}):\n${sections.join("\n")}${boundNote}\n`;
    }
    case "library.list": {
      const items = (Array.isArray(record.items) ? record.items : []) as Array<{ path?: unknown; kind?: unknown }>;
      if (!items.length) return "The Library is empty.\n";
      const shown = items.slice(0, 50);
      const lines = shown.map((item) => `- ${terminalText(item.path)}${item.kind === "folder" ? "/" : ""}`);
      const omitted = items.length > shown.length
        ? `\n${items.length - shown.length} more Library item(s) in the --json result.`
        : "";
      const bounded = record.truncated === true
        ? "\nThe Library listing stopped at its bound; the list is incomplete."
        : "";
      return `${items.length} Library item${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}${omitted}${bounded}\n`;
    }
    case "library.copy": {
      const checkpoint = record.checkpointId ? `Restore point: ${terminalText(record.checkpointId)}\n` : "";
      return `Copied ${terminalText(record.item)} from the Library to ${terminalText(record.copied)} in ${spaceLabel}.\n${checkpoint}`;
    }
    case "library.add": {
      const added = (Array.isArray(record.added) ? record.added : []) as Array<{ path?: unknown; sizeBytes?: unknown }>;
      const shown = added.slice(0, 20);
      const lines = shown.map((file) => `- ${terminalText(file.path)}`);
      const omitted = added.length > shown.length
        ? `\n${added.length - shown.length} more added file(s) in the --json result.`
        : "";
      return `Added ${added.length} file${added.length === 1 ? "" : "s"} to the Library:\n${lines.join("\n")}${omitted}\n`
        + "The Library is personal and Space-free, so no restore point applies.\n";
    }
    case "library.folder.create":
      return `Created Library folder ${terminalText(record.path)}.\n`;
    case "apps.proposals.list": {
      const proposals = (Array.isArray(record.proposals) ? record.proposals : []) as Array<{
        id?: unknown;
        status?: unknown;
        title?: unknown;
        version?: unknown;
        digest?: unknown;
      }>;
      if (!proposals.length) return `No app proposals in Chat [${terminalText(record.conversationId)}] of ${spaceLabel}.\n`;
      const lines = proposals.map((proposal) =>
        `- ${terminalText(proposal.title)} ${terminalText(proposal.version)} [${terminalText(proposal.id)}] — ${terminalText(proposal.status)} — digest ${terminalText(proposal.digest)}`);
      return `${proposals.length} app proposal${proposals.length === 1 ? "" : "s"} in Chat [${terminalText(record.conversationId)}] of ${spaceLabel}:\n${lines.join("\n")}\n`;
    }
    case "apps.proposals.dismiss":
      return record.dismissed === true
        ? `Dismissed app proposal ${terminalText(record.proposalId)} in ${spaceLabel}. Nothing runnable existed; the Assistant may propose again.\n`
        : `App proposal ${terminalText(record.proposalId)} was no longer pending in ${spaceLabel}; nothing was dismissed.\n`;
    case "apps.remove":
      return record.removed === true
        ? `Removed app ${terminalText(record.appId)} [digest ${terminalText(record.digest)}] from ${spaceLabel}. Reinstalling it is a fresh decision for a person to approve.\n`
        : `App ${terminalText(record.appId)} was not installed in ${spaceLabel}; nothing was removed.\n`;
    case "apps.revoke":
      return record.revoked === true
        ? `Revoked the ${terminalText(record.grantKind)} grant ${terminalText(record.declaration)} from ${terminalText(record.appId)} in ${spaceLabel}. Re-granting it is a fresh decision for a person to approve.\n`
        : `The ${terminalText(record.grantKind)} declaration ${terminalText(record.declaration)} of ${terminalText(record.appId)} was not granted in ${spaceLabel}; authority is unchanged.\n`;
    case "apps.disconnect":
      return (record.disconnected === true
        ? `Removed the saved connection to ${terminalText(record.destination)} from ${terminalText(record.appId)} in ${spaceLabel}.`
        : `No saved connection to ${terminalText(record.destination)} was found for ${terminalText(record.appId)} in ${spaceLabel}.`)
        + " Deleting the local record does not revoke the credential at its provider.\n";
    case "apps.automation.disable":
      return record.wasEnabled === true
        ? `Disabled automation ${terminalText(record.automationId)} of ${terminalText(record.appId)} in ${spaceLabel}. Re-enabling it is a fresh decision for a person to approve.\n`
        : `Automation ${terminalText(record.automationId)} of ${terminalText(record.appId)} was already disabled in ${spaceLabel}.\n`;
    case "apps.automation.run": {
      const run = record.run as { runId?: unknown; outcome?: unknown; error?: unknown } | undefined;
      const error = typeof run?.error === "string" && run.error ? `\n${terminalText(run.error)}` : "";
      return `Automation ${terminalText(record.automationId)} of ${terminalText(record.appId)} ran with outcome ${terminalText(run?.outcome)} (run ${terminalText(run?.runId)}).${error}\n`;
    }
    case "spaces.rename":
      return `Renamed Space ${spaceLabel} (was "${terminalText(record.priorName)}").\n`;
    case "spaces.unregister": {
      const cleanup = record.cleanupPending === true
        ? "\nSome app-state cleanup is still pending; work-fold finishes it on the next start."
        : "";
      return `Unregistered ${terminalText(record.storage)} Space ${spaceLabel}. `
        + `The folder remains at ${terminalText(record.space?.spaceRoot)} with its portable .work-fold identity; `
        + `register it again to restore it.${cleanup}\n`;
    }
    case "spaces.appearance.apply": {
      const prior = typeof record.priorAppearanceRef === "string"
        ? ` (was ${terminalText(record.priorAppearanceRef)})`
        : " (was the default appearance)";
      return `Applied appearance proposal "${terminalText(record.proposalName)}" to ${spaceLabel}${prior}. `
        + `Undo it with 'spaces appearance undo'.\n`;
    }
    case "spaces.appearance.reset":
      return record.changed === false
        ? `${spaceLabel} already uses the default appearance.\n`
        : `Reset ${spaceLabel} to the default appearance (was ${terminalText(record.priorAppearanceRef)}). `
          + `Undo it with 'spaces appearance undo'.\n`;
    case "spaces.appearance.undo": {
      const restored = typeof record.restoredAppearanceRef === "string"
        ? terminalText(record.restoredAppearanceRef)
        : "the default appearance";
      return `Restored ${spaceLabel} to ${restored}. Running 'spaces appearance undo' again swaps back.\n`;
    }
    case "tools.remove": {
      const where = record.scope === "space" ? `Space scope in ${spaceLabel}` : "personal scope";
      return record.removed === true
        ? `Removed package ${terminalText(record.source)} (${where}). Reinstalling it is a fresh decision for a person to approve.\n`
        : `Package ${terminalText(record.source)} is not installed (${where}); nothing was removed.\n`;
    }
    case "apps.project.declare": {
      const project = record.project as { projectId?: unknown; presentation?: { title?: unknown } } | undefined;
      const prior = record.priorPresentation === null
        ? "This is the Project's first declared presentation."
        : "Re-declare with the prior values in the --json result to undo.";
      return `Declared App Project presentation "${terminalText(project?.presentation?.title)}" [${terminalText(project?.projectId)}] in ${spaceLabel}. ${prior}\n`;
    }
    case "apps.release.prepare": {
      const release = record.release as { releaseDigest?: unknown; displayVersion?: unknown; featureCount?: unknown } | undefined;
      return `Prepared Release ${terminalText(release?.displayVersion)} [${terminalText(release?.releaseDigest)}] in ${spaceLabel} `
        + `(${terminalText(release?.featureCount)} Feature${release?.featureCount === 1 ? "" : "s"}). `
        + `Later source edits cannot alter its bytes; publish it with 'apps release publish'.\n`;
    }
    case "apps.release.publish": {
      const release = record.release as { releaseDigest?: unknown; displayVersion?: unknown } | undefined;
      return `Published Release ${terminalText(release?.displayVersion)} [${terminalText(release?.releaseDigest)}] in ${spaceLabel}. `
        + `This is a local state transition — nothing is uploaded, hosted, listed, or granted.\n`;
    }
    case "apps.release.delete":
      return record.deleted === true
        ? `Deleted unused Release [${terminalText(record.releaseDigest)}] in ${spaceLabel}. Re-prepare from unchanged source to get it back.\n`
        : `Release [${terminalText(record.releaseDigest)}] was not found in ${spaceLabel}; nothing was deleted.\n`;
    case "apps.install.prepare": {
      const operation = record.operation as { operationId?: unknown; releaseDigest?: unknown } | undefined;
      const target = record.targetSpace as { id?: unknown; name?: unknown } | undefined;
      return `Prepared install of Release [${terminalText(operation?.releaseDigest)}] into ${terminalText(target?.name)} [${terminalText(target?.id)}] `
        + `— operation ${terminalText(operation?.operationId)}. Activate it with 'apps operation activate'; every power starts off.\n`;
    }
    case "apps.update.prepare": {
      const operation = record.operation as { operationId?: unknown; releaseDigest?: unknown; fromReleaseDigest?: unknown; runtimeInstanceId?: unknown } | undefined;
      return `Prepared update of instance ${terminalText(operation?.runtimeInstanceId)} from Release [${terminalText(operation?.fromReleaseDigest)}] `
        + `to [${terminalText(operation?.releaseDigest)}] — operation ${terminalText(operation?.operationId)}. `
        + `The plan is rechecked at activation; activate it with 'apps operation activate'.\n`;
    }
    case "apps.operation.activate": {
      const instance = record.instance as { runtimeInstanceId?: unknown; releaseDigest?: unknown; displayVersion?: unknown } | undefined;
      const powers = record.operationKind === "install" ? " Every power starts off." : "";
      return `Activated ${terminalText(record.operationKind)} operation ${terminalText(record.operationId)}: `
        + `instance ${terminalText(instance?.runtimeInstanceId)} now runs Release ${terminalText(instance?.displayVersion)} `
        + `[${terminalText(instance?.releaseDigest)}].${powers}\n`;
    }
    case "apps.operation.cancel":
      return record.cancelled === true
        ? `Cancelled prepared operation ${terminalText(record.operationId)}. Prepare it again when needed.\n`
        : `Operation ${terminalText(record.operationId)} was no longer pending; nothing was cancelled.\n`;
    case "apps.uninstall": {
      if (isStagedResult(record)) return stagedHumanOutput(name, record, spaceLabel);
      const retained = (Array.isArray(record.retainedNamespaceIds) ? record.retainedNamespaceIds : []) as unknown[];
      const cleanup = record.cleanupPending === true
        ? "\nSome app cleanup is still pending; work-fold finishes it on the next start."
        : "";
      if (record.removed !== true) {
        return `Instance ${terminalText(record.runtimeInstanceId)} was not installed in ${spaceLabel}; nothing was uninstalled.${cleanup}\n`;
      }
      return `Uninstalled instance ${terminalText(record.runtimeInstanceId)} from ${spaceLabel}, retaining `
        + `${retained.length} data namespace${retained.length === 1 ? "" : "s"}. Retained data does not remain runnable, `
        + `and reinstalling creates a new instance.${cleanup}\n`;
    }
    case "spaces.delete":
    case "files.destroy":
    case "tools.import-skill":
    case "tools.install":
    case "tools.update":
    case "apps.install-proposal":
    case "apps.install-preview":
    case "apps.grant":
    case "apps.connect":
    case "apps.automation.enable":
    case "apps.storage.clear":
    case "apps.retained.purge":
    case "routings.stage":
    case "pages.stage":
    case "pages.stage-app":
      return stagedHumanOutput(name, record, spaceLabel);
    case "routings.list": {
      const routings = (Array.isArray(record.routings) ? record.routings : []) as Array<{
        routingId?: unknown;
        title?: unknown;
        health?: unknown;
        trigger?: { kind?: unknown; intervalMinutes?: unknown };
        stepCount?: unknown;
        nextScheduledAt?: unknown;
        suspension?: { missingSpaceIds?: unknown };
      }>;
      if (!routings.length) return "No routings on this machine.\n";
      const lines = routings.slice(0, 50).map((routing) => {
        const trigger = routing.trigger?.kind === "interval"
          ? `every ${terminalText(routing.trigger.intervalMinutes)} min`
          : terminalText(routing.trigger?.kind ?? "manual");
        const next = typeof routing.nextScheduledAt === "string" ? `; next ${terminalText(routing.nextScheduledAt)}` : "";
        const missing = Array.isArray(routing.suspension?.missingSpaceIds) && routing.suspension.missingSpaceIds.length
          ? `; missing Space ${routing.suspension.missingSpaceIds.map(terminalText).join(", ")}`
          : "";
        return `- ${terminalText(routing.title)} [${terminalText(routing.routingId)}] — ${terminalText(routing.health)} — ${trigger}, ${terminalText(routing.stepCount)} step(s)${next}${missing}`;
      });
      return `${routings.length} routing${routings.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n`;
    }
    case "routings.show": {
      const routing = (record.routing ?? {}) as {
        routingId?: unknown;
        title?: unknown;
        health?: unknown;
        digest?: unknown;
        trigger?: { kind?: unknown; intervalMinutes?: unknown; source?: Record<string, unknown> };
        steps?: unknown;
        grants?: unknown;
        enabledAt?: unknown;
        disabledAt?: unknown;
        suspension?: { at?: unknown; missingSpaceIds?: unknown; reRegisteredSpaceIds?: unknown };
        lastScheduledAt?: unknown;
        nextScheduledAt?: unknown;
      };
      const spaceRef = (id: unknown, resolvedName: unknown): string =>
        typeof resolvedName === "string" ? `${terminalText(resolvedName)} [${terminalText(id)}]` : `[${terminalText(id)}] (not registered)`;
      const steps = (Array.isArray(routing.steps) ? routing.steps : []) as Array<Record<string, unknown>>;
      const stepLines = steps.map((step) => {
        if (step.kind === "chat") {
          return `- ${terminalText(step.id)}: chat in ${spaceRef(step.spaceId, step.spaceName)} — message (verbatim, becomes portable transcript content): ${terminalText(step.message)}`;
        }
        if (step.kind === "files") {
          const source = (step.source ?? {}) as Record<string, unknown>;
          const sourceLabel = source.kind === "paths"
            ? `paths ${(Array.isArray(source.paths) ? source.paths : []).map(terminalText).join(", ")}`
            : source.kind === "tree"
              ? `tree ${terminalText(source.path)} (${source.recursive === true ? "recursive" : "one level"}; ${(Array.isArray(source.extensions) ? source.extensions : []).map(terminalText).join(", ") || "all extensions"})`
              : `files created by step ${terminalText(source.step)} (max ${terminalText(source.maxFiles)} files, ${terminalText(source.maxTotalBytes)} bytes)`;
          return `- ${terminalText(step.id)}: files from ${spaceRef(step.fromSpaceId, step.fromSpaceName)} — ${sourceLabel} → ${spaceRef(step.toSpaceId, step.toSpaceName)}:${terminalText(step.to)}`;
        }
        return `- ${terminalText(step.id)}: check in ${spaceRef(step.spaceId, step.spaceName)} — ${typeof step.checkId === "string" ? terminalText(step.checkId) : "all enabled Checks"}`;
      });
      const trigger = routing.trigger?.kind === "interval"
        ? `interval, every ${terminalText(routing.trigger.intervalMinutes)} minutes`
        : routing.trigger?.kind === "on-settled"
          ? `on-settled: ${terminalText(routing.trigger.source?.kind)} in Space ${terminalText(routing.trigger.source?.spaceId)}`
          : "manual (run-now only)";
      const grants = (Array.isArray(routing.grants) ? routing.grants : []) as Array<Record<string, unknown>>;
      const grantLines = grants.map((grant) =>
        `- ${terminalText(grant.approvedAt)} on ${terminalText(grant.surface)} — decision ${terminalText(grant.decisionId)} — digest ${terminalText(grant.digest)}`);
      const health = routing.health === "suspended" && routing.suspension
        ? `suspended since ${terminalText(routing.suspension.at)} (missing Space ${(Array.isArray(routing.suspension.missingSpaceIds) ? routing.suspension.missingSpaceIds : []).map(terminalText).join(", ")}${Array.isArray(routing.suspension.reRegisteredSpaceIds) && routing.suspension.reRegisteredSpaceIds.length ? "; re-registered with preserved identity — re-enablement is still a fresh consecration" : ""})`
        : routing.health === "disabled"
          ? `disabled${typeof routing.disabledAt === "string" ? ` since ${terminalText(routing.disabledAt)}` : ""}`
          : `enabled${typeof routing.enabledAt === "string" ? ` since ${terminalText(routing.enabledAt)}` : ""}`;
      const lines = [
        `Routing "${terminalText(routing.title)}" [${terminalText(routing.routingId)}]`,
        `Health: ${health}`,
        `Digest: ${terminalText(routing.digest)}`,
        `Trigger: ${trigger}${typeof routing.nextScheduledAt === "string" ? `; next run ${terminalText(routing.nextScheduledAt)}` : ""}`,
        "Steps:",
        ...stepLines,
        ...(grantLines.length ? ["Enablement grants:", ...grantLines] : []),
      ];
      return `${lines.join("\n")}\n`;
    }
    case "routings.run": {
      const run = record.run as { runId?: unknown; outcome?: unknown; error?: unknown } | undefined;
      const error = typeof run?.error === "string" && run.error ? `\n${terminalText(run.error)}` : "";
      return `Routing "${terminalText(record.title)}" [${terminalText(record.routingId)}] ran with outcome ${terminalText(run?.outcome)} (run ${terminalText(run?.runId)}). `
        + `Run-now never shifts the schedule; per-hop receipts are in 'routings receipts'.${error}\n`;
    }
    case "routings.stop":
      return `Stopped the active run ${terminalText(record.runId)} of routing [${terminalText(record.routingId)}]. `
        + `The current hop was aborted through its own domain, later hops are recorded skipped, and the run settles stopped.\n`;
    case "routings.disable": {
      const stopped = typeof record.stoppedRunId === "string"
        ? ` Its active run ${terminalText(record.stoppedRunId)} was stopped first — revocation stops stale work.`
        : "";
      return `Disabled routing [${terminalText(record.routingId)}].${stopped} `
        + `The declaration, grant history, and receipts are kept; re-enabling is a fresh decision for a person to approve.\n`;
    }
    case "routings.delete":
      return `Deleted routing [${terminalText(record.routingId)}] (was ${terminalText(record.finalHealth)}). `
        + `Its receipts journal is retained — audit records survive the object.\n`;
    case "routings.receipts": {
      const receipts = (Array.isArray(record.receipts) ? record.receipts : []) as Array<{
        at?: unknown;
        scope?: unknown;
        outcome?: unknown;
        routingId?: unknown;
        runId?: unknown;
        hopId?: unknown;
        detail?: unknown;
      }>;
      if (!receipts.length) return "No routing receipts recorded.\n";
      const shown = receipts.slice(-50);
      const lines = shown.map((entry) => {
        const scope = entry.scope === "hop"
          ? `hop ${terminalText(entry.hopId)} of run ${terminalText(entry.runId)}`
          : entry.scope === "run" ? `run ${terminalText(entry.runId)}` : "routing";
        const detail = typeof entry.detail === "string" && entry.detail ? ` — ${terminalText(entry.detail)}` : "";
        return `- ${terminalText(entry.at)} [${terminalText(entry.routingId)}] ${scope}: ${terminalText(entry.outcome)}${detail}`;
      });
      const omitted = receipts.length > shown.length ? `\n${receipts.length - shown.length} older receipt(s) in the --json result.` : "";
      const damaged = typeof record.damagedLineCount === "number" && record.damagedLineCount > 0
        ? `\n${terminalText(record.damagedLineCount)} journal line(s) could not be read and are omitted.`
        : "";
      const truncated = record.truncated === true ? "\nThe journal read stopped at its bound; older receipts were omitted." : "";
      return `${receipts.length} routing receipt${receipts.length === 1 ? "" : "s"}:\n${lines.join("\n")}${omitted}${truncated}${damaged}\n`;
    }
    case "pages.list": {
      const publications = (Array.isArray(record.publications) ? record.publications : []) as Array<{
        publicationId?: unknown;
        kind?: unknown;
        title?: unknown;
        state?: unknown;
        live?: unknown;
        spaceName?: unknown;
        spaceId?: unknown;
        relativePath?: unknown;
        appInstanceId?: unknown;
        viewerPath?: unknown;
        snapshotEnabled?: unknown;
      }>;
      if (!publications.length) return "No pages are shared.\n";
      const lines = publications.slice(0, 50).map((publication) => {
        const source = publication.kind === "app"
          ? `app instance ${terminalText(publication.appInstanceId)}`
          : terminalText(publication.relativePath);
        const where = typeof publication.spaceName === "string"
          ? `${terminalText(publication.spaceName)}:${source}`
          : `[${terminalText(publication.spaceId)}]:${source}`;
        const liveness = publication.state === "active" ? (publication.live === true ? "live" : "active, bridge sync pending") : terminalText(publication.state);
        return `- "${terminalText(publication.title)}" [${terminalText(publication.publicationId)}] — ${where} — ${liveness}${publication.snapshotEnabled === true ? " — snapshot on" : ""}`;
      });
      return `${publications.length} shared page${publications.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n`;
    }
    case "pages.status": {
      const publication = (record.publication ?? {}) as Record<string, unknown>;
      const sourceLabel = publication.kind === "app"
        ? `App Instance ${terminalText(publication.appInstanceId)} at Release ${terminalText(publication.releaseDigest)} — `
          + `viewer entry ${terminalText(publication.viewerEntry)}; viewer-readable surface: `
          + `${Array.isArray(publication.viewerSurface) ? publication.viewerSurface.map(terminalText).join(", ") : "(none)"}`
        : terminalText(publication.relativePath);
      const lines = [
        `${publication.kind === "app" ? "App" : "Page"} "${terminalText(publication.title)}" [${terminalText(publication.publicationId)}]`,
        `Source: ${typeof publication.spaceName === "string" ? `${terminalText(publication.spaceName)} ` : ""}[${terminalText(publication.spaceId)}] ${sourceLabel}`,
        `State: ${terminalText(publication.state)}${publication.state === "active" ? (publication.live === true ? " (live)" : " (bridge sync pending; not presented as live)") : ""}`,
        `Viewer path: ${terminalText(publication.viewerPath)} — the full link and its key are shown only transiently in the app, never here`,
        `Budgets: ${terminalText(publication.serveRatePerMinute)}/min serve rate, ${terminalText(publication.byteBudgetPerDay)} bytes/day`,
        `Snapshot caching: ${publication.snapshotEnabled === true ? "on" : "off"}`,
        ...(typeof publication.expiresAt === "string" ? [`Expires: ${terminalText(publication.expiresAt)}`] : []),
        ...(typeof publication.revokedAt === "string" ? [`Revoked: ${terminalText(publication.revokedAt)}${publication.bridgeCleanup === "pending" ? " — bridge cleanup pending, retried on reconnect" : ""}`] : []),
      ];
      return `${lines.join("\n")}\n`;
    }
    case "pages.revoke": {
      const publication = (record.publication ?? {}) as Record<string, unknown>;
      const cleanup = publication.bridgeCleanup === "ok"
        ? "The bridge slot and any snapshot were deleted."
        : "Bridge cleanup is pending and is retried on reconnect and at startup; the desktop already refuses every new serve.";
      const already = record.alreadyRevoked === true ? " It was already revoked; revocation is idempotent." : "";
      return `Stopped sharing "${terminalText(publication.title)}" [${terminalText(publication.publicationId)}].${already}\n`
        + `${cleanup} Old links stay dead; sharing again mints a new slot, key, and link.\n`;
    }
    case "pages.narrow": {
      const publication = (record.publication ?? {}) as Record<string, unknown>;
      return `Narrowed budgets of "${terminalText(publication.title)}" [${terminalText(publication.publicationId)}]: `
        + `serve rate ${terminalText(record.priorServeRatePerMinute)} -> ${terminalText(publication.serveRatePerMinute)}/min, `
        + `byte budget ${terminalText(record.priorByteBudgetPerDay)} -> ${terminalText(publication.byteBudgetPerDay)}/day. `
        + `Raising a budget again is a fresh decision for a person to approve.\n`;
    }
    case "pages.snapshot-off": {
      const publication = (record.publication ?? {}) as Record<string, unknown>;
      const already = record.wasEnabled === false ? " Snapshot caching was already off." : "";
      return `Turned snapshot caching off for "${terminalText(publication.title)}" [${terminalText(publication.publicationId)}].${already} `
        + `The stored relay copy is deleted${publication.bridgeSlot === "confirmed" ? "" : " once the bridge sync completes"}; turning it back on is a fresh decision for a person to approve.\n`;
    }
    case "staged.list": {
      const acts = (Array.isArray(record.acts) ? record.acts : []) as Array<{
        id?: unknown;
        kind?: unknown;
        category?: unknown;
        state?: unknown;
        expiresAt?: unknown;
        decidedAt?: unknown;
        executionOutcome?: unknown;
      }>;
      if (!acts.length) return "No staged acts. Nothing is waiting on a decision.\n";
      const lines = acts.slice(0, 50).map((act) => {
        const settled = act.state === "staged"
          ? `expires ${terminalText(act.expiresAt)}`
          : `${terminalText(act.state)}${act.executionOutcome ? `, execution ${terminalText(act.executionOutcome)}` : ""}${act.decidedAt ? ` at ${terminalText(act.decidedAt)}` : ""}`;
        return `- ${terminalText(act.id)} — ${terminalText(act.kind)} (${terminalText(act.category)}) — ${settled}`;
      });
      const pending = acts.filter((act) => act.state === "staged").length;
      const omitted = acts.length > 50 ? `\n${acts.length - 50} more staged act(s) in the --json result.` : "";
      return `${acts.length} staged act${acts.length === 1 ? "" : "s"} (${pending} pending a decision):\n${lines.join("\n")}${omitted}\n`;
    }
    case "staged.show": {
      const act = (record.act ?? {}) as Record<string, unknown> & {
        provenance?: Record<string, unknown>;
        restrictions?: { desktopOnly?: unknown; stagedByGrantId?: unknown };
        decision?: Record<string, unknown>;
        execution?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
        pins?: Record<string, unknown>;
      };
      const facts = (section: Record<string, unknown> | undefined): string[] =>
        Object.entries(section ?? {}).map(([key, value]) =>
          `  ${terminalText(key)}: ${terminalText(Array.isArray(value) ? value.join(", ") : value)}`);
      const lines = [
        `Staged act ${terminalText(act.id)} — ${terminalText(act.kind)} (${categoryLine(act.category)})`,
        `State: ${terminalText(act.state)}${act.state === "staged" ? `, expires ${terminalText(act.expiresAt)}` : ""}`,
        ...(typeof act.priorDenialAt === "string" ? [`An identical act was denied at ${terminalText(act.priorDenialAt)}.`] : []),
        "Exact facts:",
        ...facts(act.pins),
        `Staged via ${terminalText(act.provenance?.stagedVia)} at ${terminalText(act.createdAt)}${act.provenance?.conversationId ? ` from conversation ${terminalText(act.provenance.conversationId)}` : ""}.`,
        ...(act.restrictions?.desktopOnly === true
          ? ["This act loads code into the fold's own runtime (Personal scope); its decision belongs to a desktop surface."]
          : []),
        ...(typeof act.restrictions?.stagedByGrantId === "string"
          ? ["Staged at a remote browser's request; that browser cannot decide it."]
          : []),
        ...(act.decision
          ? [`Decision: ${terminalText(act.decision.decision)} on ${terminalText(act.decision.surface)}${act.decision.policyId ? ` (policy ${terminalText(act.decision.policyId)})` : ""}.`]
          : []),
        ...(act.execution
          ? [`Execution: ${terminalText(act.execution.outcome)}${act.execution.errorDetail ? ` — ${terminalText(act.execution.errorDetail)}` : ""}`]
          : []),
        ...(typeof act.invalidationReason === "string" ? [`Invalidated: ${terminalText(act.invalidationReason)}`] : []),
        ...(typeof act.cancellationReason === "string" ? [`Canceled: ${terminalText(act.cancellationReason)}`] : []),
        "Deciding happens on a work-fold decision surface; the act lane can only cancel.",
      ];
      return `${lines.join("\n")}\n`;
    }
    case "staged.cancel": {
      const act = (record.act ?? {}) as { id?: unknown; kind?: unknown };
      return `Canceled staged act ${terminalText(act.id)} (${terminalText(act.kind)}). Nothing was decided or executed; restaging issues a fresh card.\n`;
    }
    default:
      return `${terminalText(name)} completed.\n`;
  }
}

/** Working card copy for the consecration categories (docs/fold-consecrations.md). */
function categoryLine(category: unknown): string {
  switch (category) {
    case "make-runnable":
      return "installs code that can run as you";
    case "widen-power":
      return "grants a standing power";
    case "destroy":
      return "deletes something for good";
    default:
      return terminalText(category);
  }
}

function isStagedResult(record: Record<string, unknown>): boolean {
  const staged = record.staged;
  return typeof staged === "object" && staged !== null && typeof (staged as { decisionId?: unknown }).decisionId === "string";
}

/**
 * One human shape for every staging verb: the family's lead line, the
 * category in plain words, the pending decision's identity and expiry, and
 * the honest "nothing ran" close. Dedupe and denial memory are stated, never
 * hidden. When a standing policy the person authored in Settings satisfied
 * the consecration at admission, no card appeared — the close reports the
 * auto-approval, the exercised policy, and the execution outcome instead
 * (docs/fold-consecrations.md §Standing policies).
 */
function stagedHumanOutput(
  name: WorkFoldCliActCommandName,
  record: Record<string, WorkFoldCliJson>,
  spaceLabel: string,
): string {
  const staged = (record.staged ?? {}) as {
    decisionId?: unknown;
    category?: unknown;
    expiresAt?: unknown;
    deduplicated?: unknown;
    priorDenialAt?: unknown;
    autoApproval?: {
      basis?: unknown;
      policyId?: unknown;
      policyLabel?: unknown;
      executionOutcome?: unknown;
      detail?: unknown;
      receipted?: unknown;
    };
  };
  const lead = ((): string => {
    switch (name) {
      case "spaces.delete":
        return `Staged deleting the managed folder of ${spaceLabel} for good.`;
      case "files.destroy": {
        const paths = (Array.isArray(record.paths) ? record.paths : []) as unknown[];
        return `Staged destroying ${paths.length} path${paths.length === 1 ? "" : "s"} in ${spaceLabel} that no restore point can cover.`;
      }
      case "tools.import-skill":
        return `Staged importing the skill bundle ${terminalText(record.source)} (${terminalText(record.scope)} scope).`;
      case "tools.install":
        return `Staged installing ${terminalText(record.packageId ?? record.source)}${record.version ? ` ${terminalText(record.version)}` : ""} (${terminalText(record.scope)} scope).`;
      case "tools.update":
        return `Staged updating ${terminalText(record.packageId)} to ${terminalText(record.version)} (${terminalText(record.scope)} scope).`;
      case "apps.install-proposal":
        return `Staged approving app review ${terminalText(record.proposalId)} [digest ${terminalText(record.digest)}] in ${spaceLabel}.`;
      case "apps.install-preview": {
        const replaces = record.replacesInstalled === true
          ? " Approval replaces the installed preview and resets every grant, connection, and automation — the card says so."
          : "";
        return `Staged installing local app preview "${terminalText(record.title)}" ${terminalText(record.version)} `
          + `[review ${terminalText(record.proposalId)}, digest ${terminalText(record.digest)}] in ${spaceLabel}.${replaces}`;
      }
      case "apps.grant":
        return `Staged granting the ${terminalText(record.grantKind)} declaration ${terminalText(record.declaration)} to ${terminalText(record.appId)} in ${spaceLabel}.`;
      case "apps.connect":
        return `Staged connecting ${terminalText(record.appId)} to ${terminalText(record.destination)} (${terminalText(record.target)}). The staged act names the connection's shape only; any secret is entered on the trusted surface at decision time.`;
      case "apps.automation.enable":
        return `Staged enabling automation ${terminalText(record.automationId)} (${terminalText(record.scheduleSummary)}) of ${terminalText(record.appId)} in ${spaceLabel}.`;
      case "apps.storage.clear":
        return `Staged clearing ${terminalText(record.observedBytes)} bytes of live storage of ${terminalText(record.appId)} in ${spaceLabel}.`;
      case "apps.retained.purge":
        return `Staged purging retained App data ${terminalText(record.retainedDataId)} in ${spaceLabel}.`;
      case "apps.uninstall":
        return `Staged uninstalling instance ${terminalText(record.runtimeInstanceId)} from ${spaceLabel} with its data purged.`;
      case "routings.stage":
        return `Staged enabling routing "${terminalText(record.title)}" [${terminalText(record.routingId)}] at digest ${terminalText(record.declarationDigest)}.`;
      case "pages.stage":
        return `Staged sharing "${terminalText(record.title)}" (${terminalText(record.relativePath)}) from ${spaceLabel} as a page — snapshot ${record.snapshotEnabled === true ? "on" : "off"}.`;
      case "pages.stage-app":
        return `Staged putting "${terminalText(record.title)}" (App Instance ${terminalText(record.appInstanceId)}, Release ${terminalText(record.releaseDigest)}) from ${spaceLabel} at your address — `
          + `viewer entry ${terminalText(record.viewerEntry)}; viewer-readable surface: ${Array.isArray(record.viewerSurface) ? record.viewerSurface.map(terminalText).join(", ") : "(none)"}.`;
      default:
        return "Staged.";
    }
  })();
  const dedupe = staged.deduplicated === true
    ? "\nAn identical act was already pending; this is the existing card, not a second one."
    : "";
  const denial = typeof staged.priorDenialAt === "string"
    ? `\nAn identical act was denied at ${terminalText(staged.priorDenialAt)}; the card states that.`
    : "";
  const auto = staged.autoApproval;
  if (auto && typeof auto === "object") {
    const outcome = auto.executionOutcome === "executed"
      ? "It executed."
      : auto.executionOutcome === "failed"
        ? `Its execution failed${typeof auto.detail === "string" ? `: ${terminalText(auto.detail)}` : "."} work-fold never retries a failed consecrated act; staging it again issues a fresh card.`
        : "Its execution outcome could not be recorded; the receipts journal is the record.";
    const unreceipted = auto.receipted === false
      ? " Warning: the decision receipt could not be fully written."
      : "";
    if (auto.basis === "unrestricted") {
      return `${lead}\nThis ${categoryLine(staged.category)}. Unrestricted authority admitted it, so no needs-you card appeared. ${outcome}`
        + `\nDecision ${terminalText(staged.decisionId)} is receipted with surface "unrestricted".${unreceipted}${denial}\n`;
    }
    return `${lead}\nThis ${categoryLine(staged.category)}. Your standing policy "${terminalText(auto.policyLabel)}" `
      + `[${terminalText(auto.policyId)}] pre-approved it, so no needs-you card appeared. ${outcome}`
      + `\nDecision ${terminalText(staged.decisionId)} is receipted with surface "policy" and the policy id.${unreceipted}${denial}\n`;
  }
  return `${lead}\nThis ${categoryLine(staged.category)}, so a person decides it on a needs-you card. `
    + `Decision ${terminalText(staged.decisionId)} expires ${terminalText(staged.expiresAt)}; nothing runs until it is approved.${dedupe}${denial}\n`;
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

/**
 * Verbs whose receipt's checkpoint column is the safety restore point the act
 * itself recorded (docs/fold-act-ledger.md "receipt adds"). `files.mkdir` and
 * `files.create` are deliberately absent: creation is additive and destroys
 * nothing, so their receipts carry the created path instead of a restore-point
 * reference — the canonical inverse is `files delete`.
 */
const actSafetyCheckpointCommands: ReadonlySet<WorkFoldCliActCommandName> = new Set([
  "history.restore-file",
  "files.move",
  "files.rename",
  "files.delete",
]);

function receiptDetails(name: WorkFoldCliActCommandName, data: WorkFoldCliJson): {
  spaceId?: string;
  conversationId?: string;
  checkpointId?: string;
  taskId?: string;
  decisionId?: string;
  undoRef?: WorkFoldCliActUndoRef;
  detail?: string;
} {
  const record = data as {
    space?: { id?: unknown };
    conversation?: { id?: unknown };
    conversationId?: unknown;
    checkpointId?: unknown;
    taskId?: unknown;
    task?: { taskId?: unknown };
    run?: { taskId?: unknown; runId?: unknown; outcome?: unknown };
    checkpoint?: { checkpointId?: unknown };
    created?: unknown;
    safetyCheckpointId?: unknown;
    scope?: unknown;
    path?: unknown;
    copied?: unknown;
    staged?: { decisionId?: unknown; kind?: unknown; category?: unknown; deduplicated?: unknown };
    act?: { id?: unknown; kind?: unknown; state?: unknown };
  };
  // Staging receipts stamp the pending decision's identity (receipts v2,
  // docs/fold-act-ledger.md "receipt adds"): the staged act and its decision
  // share one id, and `staged cancel` names the card it settled.
  const decisionId = typeof record.staged?.decisionId === "string"
    ? record.staged.decisionId
    : name === "staged.cancel" && typeof record.act?.id === "string"
      ? record.act.id
      : undefined;
  const spaceId = typeof record.space?.id === "string" ? record.space.id : undefined;
  const conversationId = typeof record.conversationId === "string"
    ? record.conversationId
    : typeof record.conversation?.id === "string" ? record.conversation.id : undefined;
  const safetyCheckpointId = typeof record.safetyCheckpointId === "string" ? record.safetyCheckpointId : undefined;
  // Per-family receipt growth from the ledger's "receipt adds" column:
  // history.save records the restore-point id plus the honest created flag,
  // and the restore and file-mutation verbs record the safety restore point
  // History created for them.
  const checkpointId = typeof record.checkpointId === "string"
    ? record.checkpointId
    : name === "history.save" && typeof record.checkpoint?.checkpointId === "string"
      ? record.checkpoint.checkpointId
      : actSafetyCheckpointCommands.has(name)
        ? safetyCheckpointId
        : undefined;
  const detail = actReceiptDetail(name, record);
  const undoRef = actUndoRef(name, data, safetyCheckpointId);
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(typeof record.taskId === "string"
      ? { taskId: record.taskId }
      : typeof record.task?.taskId === "string"
        ? { taskId: record.task.taskId }
        : typeof record.run?.taskId === "string"
          ? { taskId: record.run.taskId }
          : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(undoRef ? { undoRef } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Per-family receipt detail from the ledger's "receipt adds" column. For
 * search this is deliberately the scope alone — receipts never record the
 * query text; appearance and presentation entries carry short content refs,
 * never the customization or presentation payloads.
 */
function actReceiptDetail(
  name: WorkFoldCliActCommandName,
  record: {
    created?: unknown;
    scope?: unknown;
    path?: unknown;
    copied?: unknown;
    added?: unknown;
    storage?: unknown;
    changed?: unknown;
    appearanceRef?: unknown;
    restoredAppearanceRef?: unknown;
    removed?: unknown;
    source?: unknown;
    release?: { releaseDigest?: unknown };
    releaseDigest?: unknown;
    deleted?: unknown;
    operation?: { operationId?: unknown; fromReleaseDigest?: unknown; releaseDigest?: unknown };
    operationId?: unknown;
    cancelled?: unknown;
    instance?: { releaseDigest?: unknown };
    runtimeInstanceId?: unknown;
    retainedNamespaceIds?: unknown;
    proposalId?: unknown;
    appId?: unknown;
    digest?: unknown;
    grantKind?: unknown;
    declaration?: unknown;
    destination?: unknown;
    disconnected?: unknown;
    automationId?: unknown;
    wasEnabled?: unknown;
    dismissed?: unknown;
    revoked?: unknown;
    run?: { runId?: unknown; outcome?: unknown };
    staged?: { kind?: unknown; category?: unknown; deduplicated?: unknown };
    paths?: unknown;
    observedBytes?: unknown;
    retainedDataId?: unknown;
    routingId?: unknown;
    declarationDigest?: unknown;
    relativePath?: unknown;
    appInstanceId?: unknown;
    viewerEntry?: unknown;
    viewerSurface?: unknown;
    snapshotEnabled?: unknown;
    serveRatePerMinute?: unknown;
    byteBudgetPerDay?: unknown;
    stoppedRunId?: unknown;
    runId?: unknown;
    finalHealth?: unknown;
    replacesInstalled?: unknown;
    publication?: {
      publicationId?: unknown;
      serveRatePerMinute?: unknown;
      byteBudgetPerDay?: unknown;
      bridgeCleanup?: unknown;
      bridgeSlot?: unknown;
    };
    alreadyRevoked?: unknown;
    priorServeRatePerMinute?: unknown;
    priorByteBudgetPerDay?: unknown;
    contentDigest?: unknown;
    version?: unknown;
    packageId?: unknown;
    target?: unknown;
    adapterKind?: unknown;
    scheduleSummary?: unknown;
    model?: { provider?: unknown; id?: unknown } | null;
    instructions?: unknown;
    act?: { id?: unknown; kind?: unknown; state?: unknown };
  },
): string | undefined {
  // Consecration staging rows share one detail spine — the staged kind and
  // category plus the dedupe marker — with the family's exact identifiers
  // appended per the ledger's "receipt adds" column. Identifiers and digests
  // only; receipts never grow titles, messages, or file contents.
  if (record.staged && typeof record.staged.kind === "string") {
    const spine = `staged ${record.staged.kind}${record.staged.deduplicated === true ? " (already pending)" : ""}`;
    switch (name) {
      case "spaces.delete":
        return spine;
      case "files.destroy": {
        const paths = Array.isArray(record.paths) ? record.paths.filter((item): item is string => typeof item === "string") : [];
        const named = paths.slice(0, 5).map((path) => boundedReceiptText(path)).join(",");
        const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
        return `${spine}; ${paths.length} path(s)${named ? `: ${named}${more}` : ""}`;
      }
      case "tools.import-skill":
      case "tools.install":
      case "tools.update": {
        const scope = typeof record.scope === "string" ? `; scope ${record.scope}` : "";
        const source = typeof record.source === "string" ? `; source ${boundedReceiptText(record.source)}` : "";
        const version = typeof record.version === "string" ? `; version ${record.version}` : "";
        return `${spine}${scope}${source}${version}`;
      }
      case "apps.install-proposal":
        return `${spine}; proposal ${String(record.proposalId)}; digest ${String(record.digest)}`;
      case "apps.install-preview":
        return `${spine}; proposal ${String(record.proposalId)}; digest ${String(record.digest)}`
          + `${record.replacesInstalled === true ? "; replaces installed preview" : ""}`;
      case "apps.grant":
        return `${spine}; app ${String(record.appId)}; kind ${String(record.grantKind)}; declaration ${String(record.declaration)}`;
      case "apps.connect":
        return `${spine}; app ${String(record.appId)}; destination ${String(record.destination)}; adapter ${String(record.adapterKind)}`;
      case "apps.automation.enable":
        return `${spine}; app ${String(record.appId)}; automation ${String(record.automationId)}`;
      case "apps.storage.clear":
        return `${spine}; app ${String(record.appId)}; observed ${String(record.observedBytes)} bytes`;
      case "apps.retained.purge":
        return `${spine}; retained ${String(record.retainedDataId)}`;
      case "apps.uninstall":
        return `${spine}; instance ${String(record.runtimeInstanceId)}`;
      case "routings.stage":
        return `${spine}; routing ${String(record.routingId)}; digest ${String(record.declarationDigest)}`;
      case "pages.stage":
        return `${spine}; source ${boundedReceiptText(String(record.relativePath))}; `
          + `serveRatePerMinute=${String(record.serveRatePerMinute)} byteBudgetPerDay=${String(record.byteBudgetPerDay)} `
          + `snapshot=${record.snapshotEnabled === true ? "on" : "off"}`;
      case "pages.stage-app":
        return `${spine}; appInstanceId ${String(record.appInstanceId)}; releaseDigest ${String(record.releaseDigest)}; `
          + `viewerEntry ${boundedReceiptText(String(record.viewerEntry))}; `
          + `viewerSurface ${boundedReceiptText(Array.isArray(record.viewerSurface) ? record.viewerSurface.map(String).join(",") : "")}; `
          + `serveRatePerMinute=${String(record.serveRatePerMinute)} byteBudgetPerDay=${String(record.byteBudgetPerDay)}`;
      default:
        return spine;
    }
  }
  if (name === "staged.cancel" && record.act) {
    return `canceled staged ${String(record.act.kind)}; state ${String(record.act.state)}`;
  }
  switch (name) {
    case "spaces.assistant.model":
      return typeof record.model?.provider === "string" && typeof record.model?.id === "string"
        ? `provider ${record.model.provider}; model ${record.model.id}`
        : undefined;
    case "spaces.assistant.instructions":
      return typeof record.instructions === "string"
        ? record.instructions ? `updated; ${record.instructions.length} character(s)` : "cleared"
        : undefined;
    case "history.save":
      return typeof record.created === "boolean"
        ? record.created ? "created restore point" : "already matches the latest restore point"
        : undefined;
    case "search":
      return typeof record.scope === "string" ? `scope ${record.scope}` : undefined;
    case "files.move":
      return typeof record.path === "string" ? `moved to ${record.path}` : undefined;
    case "library.copy":
      return typeof record.copied === "string" ? `copied to ${record.copied}` : undefined;
    case "library.add":
      // The ledger's receipt column is the added-paths count; the Library is
      // Space-free, so there is no Space id and no restore point to record.
      return Array.isArray(record.added) ? `added ${record.added.length} file(s) to the Library` : undefined;
    case "library.folder.create":
      return typeof record.path === "string" ? `Library folder ${boundedReceiptText(record.path)}` : undefined;
    case "apps.proposals.dismiss":
      return typeof record.proposalId === "string"
        ? `proposal ${record.proposalId}${record.dismissed === false ? " (not pending)" : ""}`
        : undefined;
    case "apps.remove":
      return typeof record.appId === "string" && typeof record.digest === "string"
        ? `app ${record.appId}; digest ${record.digest}${record.removed === false ? " (not installed)" : ""}`
        : undefined;
    case "apps.revoke":
      return typeof record.appId === "string" && typeof record.grantKind === "string" && typeof record.declaration === "string"
        ? `app ${record.appId}; kind ${record.grantKind}; declaration ${record.declaration}${record.revoked === false ? " (was not granted)" : ""}`
        : undefined;
    case "apps.disconnect":
      // The receipt says so: removing the local record does not revoke the
      // credential at its provider (docs/fold-act-ledger.md).
      return typeof record.appId === "string" && typeof record.destination === "string"
        ? `app ${record.appId}; destination ${record.destination}; local record only — provider credential not revoked${record.disconnected === false ? " (no saved connection)" : ""}`
        : undefined;
    case "apps.automation.disable":
      return typeof record.appId === "string" && typeof record.automationId === "string"
        ? `app ${record.appId}; automation ${record.automationId}${record.wasEnabled === false ? " (already disabled)" : ""}`
        : undefined;
    case "apps.automation.run":
      return typeof record.appId === "string" && typeof record.automationId === "string" && typeof record.run?.runId === "string"
        ? `app ${record.appId}; automation ${record.automationId}; run ${record.run.runId}; outcome ${String(record.run.outcome)}`
        : undefined;
    case "spaces.unregister":
      return typeof record.storage === "string" ? `storage ${record.storage}` : undefined;
    case "spaces.appearance.apply":
      return typeof record.appearanceRef === "string" ? `applied ${record.appearanceRef}` : "applied default";
    case "spaces.appearance.reset":
      return record.changed === false ? "already default" : undefined;
    case "spaces.appearance.undo":
      return `restored ${typeof record.restoredAppearanceRef === "string" ? record.restoredAppearanceRef : "none"}`;
    case "tools.remove":
      return typeof record.scope === "string" && typeof record.source === "string"
        ? `scope ${record.scope}; source ${boundedReceiptText(record.source)}${record.removed === false ? " (not installed)" : ""}`
        : undefined;
    case "apps.release.prepare":
    case "apps.release.publish":
      return typeof record.release?.releaseDigest === "string" ? `release ${record.release.releaseDigest}` : undefined;
    case "apps.release.delete":
      return typeof record.releaseDigest === "string"
        ? `release ${record.releaseDigest}${record.deleted === false ? " (not found)" : ""}`
        : undefined;
    case "apps.install.prepare":
      return typeof record.operation?.operationId === "string" ? `operation ${record.operation.operationId}` : undefined;
    case "apps.update.prepare": {
      const operation = record.operation;
      if (typeof operation?.operationId !== "string") return undefined;
      // The transition is named by content identity — the ledger's
      // "direction" without inferring an update-versus-rollback label the
      // service does not record.
      const transition = typeof operation.fromReleaseDigest === "string" && typeof operation.releaseDigest === "string"
        ? `; from ${operation.fromReleaseDigest}; to ${operation.releaseDigest}`
        : "";
      return `operation ${operation.operationId}${transition}`;
    }
    case "apps.operation.activate":
      return typeof record.operationId === "string"
        ? `operation ${record.operationId}${typeof record.instance?.releaseDigest === "string" ? `; release ${record.instance.releaseDigest}` : ""}`
        : undefined;
    case "apps.operation.cancel":
      return typeof record.operationId === "string"
        ? `operation ${record.operationId}${record.cancelled === false ? " (not pending)" : ""}`
        : undefined;
    case "apps.uninstall": {
      if (typeof record.runtimeInstanceId !== "string") return undefined;
      const retained = Array.isArray(record.retainedNamespaceIds)
        ? record.retainedNamespaceIds.filter((item): item is string => typeof item === "string")
        : [];
      const named = retained.slice(0, 5);
      const more = retained.length - named.length;
      const retainedLabel = retained.length
        ? `; retained ${named.join(",")}${more > 0 ? ` and ${more} more` : ""}`
        : "";
      return `instance ${record.runtimeInstanceId}${retainedLabel}`;
    }
    // Routing and publication management receipts carry identifiers and
    // outcomes only, per the routings five-questions table and the publishing
    // mutation ledger — the owning journals hold the per-hop and ordering
    // evidence.
    case "routings.run":
      return typeof record.routingId === "string" && typeof record.run?.runId === "string"
        ? `routing ${record.routingId}; run ${record.run.runId}; outcome ${String(record.run.outcome)}`
        : undefined;
    case "routings.stop":
      return typeof record.routingId === "string"
        ? `routing ${record.routingId}; stopped run ${String(record.runId)}`
        : undefined;
    case "routings.disable":
      return typeof record.routingId === "string"
        ? `routing ${record.routingId}${typeof record.stoppedRunId === "string" ? `; stopped run ${record.stoppedRunId}` : ""}`
        : undefined;
    case "routings.delete":
      return typeof record.routingId === "string"
        ? `routing ${record.routingId}; digest ${String(record.digest)}; final health ${String(record.finalHealth)}`
        : undefined;
    case "pages.revoke":
      return typeof record.publication?.publicationId === "string"
        ? `publicationId=${record.publication.publicationId} bridgeCleanup=${String(record.publication.bridgeCleanup ?? "pending")}`
          + `${record.alreadyRevoked === true ? " (already revoked)" : ""}`
        : undefined;
    case "pages.narrow":
      return typeof record.publication?.publicationId === "string"
        ? `publicationId=${record.publication.publicationId} `
          + `serveRatePerMinute=${String(record.priorServeRatePerMinute)}->${String(record.publication.serveRatePerMinute)} `
          + `byteBudgetPerDay=${String(record.priorByteBudgetPerDay)}->${String(record.publication.byteBudgetPerDay)}`
        : undefined;
    case "pages.snapshot-off":
      return typeof record.publication?.publicationId === "string"
        ? `publicationId=${record.publication.publicationId} snapshot=off`
          + `${record.wasEnabled === false ? " (already off)" : ""}`
        : undefined;
    default:
      return undefined;
  }
}

/** Receipt details stay content-light; long identifiers are cut, never dropped. */
function boundedReceiptText(value: string, maximumLength = 200): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

/**
 * Typed undo reference stamped on ok receipts (docs/fold-act-ledger.md,
 * receipt schema growth): identifiers, short prior values, and restore-point
 * ids only — enough for the inverse verb, never content.
 */
function actUndoRef(
  name: WorkFoldCliActCommandName,
  data: WorkFoldCliJson,
  safetyCheckpointId: string | undefined,
): WorkFoldCliActUndoRef | undefined {
  const record = data as {
    priorTitle?: unknown;
    priorLifecycle?: { archivedAt?: unknown; snoozedUntil?: unknown };
    priorName?: unknown;
    path?: unknown;
    space?: { spaceRoot?: unknown };
    priorAppearanceRef?: unknown;
    displacedAppearanceRef?: unknown;
    priorPresentationRef?: unknown;
    release?: { releaseDigest?: unknown };
    operation?: { operationId?: unknown };
  };
  switch (name) {
    case "chat.rename":
      return typeof record.priorTitle === "string"
        ? { kind: "chat-title", value: record.priorTitle }
        : undefined;
    case "chat.snooze":
    case "chat.archive":
    case "chat.resume": {
      const prior = record.priorLifecycle;
      if (!prior || typeof prior !== "object") return undefined;
      const value = typeof prior.archivedAt === "string"
        ? "archived"
        : typeof prior.snoozedUntil === "string"
          ? `snoozed:${prior.snoozedUntil}`
          : "active";
      return { kind: "chat-lifecycle", value };
    }
    case "history.restore":
    case "history.restore-file":
    case "files.move":
    case "files.delete":
      return safetyCheckpointId ? { kind: "safety-checkpoint", value: safetyCheckpointId } : undefined;
    case "files.rename":
      return typeof record.priorName === "string" ? { kind: "entry-name", value: record.priorName } : undefined;
    case "files.mkdir":
    case "files.create":
      // Creation's inverse is `files delete` of the created path; there is
      // deliberately no restore-point reference (creation destroys nothing).
      return typeof record.path === "string" ? { kind: "created-path", value: record.path } : undefined;
    case "spaces.rename":
      return typeof record.priorName === "string" ? { kind: "space-name", value: record.priorName } : undefined;
    case "spaces.unregister":
      // Re-registering the folder is the inverse; the portable `.work-fold/`
      // identity persists at this root.
      return typeof record.space?.spaceRoot === "string"
        ? { kind: "space-root", value: record.space.spaceRoot }
        : undefined;
    case "spaces.appearance.apply":
    case "spaces.appearance.reset":
      return {
        kind: "appearance-ref",
        value: typeof record.priorAppearanceRef === "string" ? record.priorAppearanceRef : "none",
      };
    case "spaces.appearance.undo":
      // Undo is its own inverse: the displaced ref is what a second undo
      // would restore.
      return {
        kind: "appearance-ref",
        value: typeof record.displacedAppearanceRef === "string" ? record.displacedAppearanceRef : "none",
      };
    case "apps.project.declare":
      return {
        kind: "app-presentation-ref",
        value: typeof record.priorPresentationRef === "string" ? record.priorPresentationRef : "none",
      };
    case "apps.release.prepare":
    case "apps.release.publish":
      // The inverse while unused is `apps release delete` of this digest.
      return typeof record.release?.releaseDigest === "string"
        ? { kind: "release-digest", value: record.release.releaseDigest }
        : undefined;
    case "apps.install.prepare":
    case "apps.update.prepare":
      // The inverse of preparing is `apps operation cancel`.
      return typeof record.operation?.operationId === "string"
        ? { kind: "operation-id", value: record.operation.operationId }
        : undefined;
    default:
      return undefined;
  }
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
