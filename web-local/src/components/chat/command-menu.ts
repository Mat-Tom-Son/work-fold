import type { AgentCommand } from "../../types";

const argumentCommands = new Set([
  "compact",
  "export",
  "login",
  "logout",
  "model",
  "name",
]);

// Pi built-ins that the app already covers with its own controls (model and
// reasoning chips, Chats list, Settings). They stay typeable; the menu just
// does not offer them.
const hiddenBuiltinCommands = new Set([
  "changelog",
  "hotkeys",
  "login",
  "logout",
  "copy",
  "model",
  "thinking",
  "settings",
  "session",
  "resume",
  "quit",
  "reload",
  "new",
  "import",
  "share",
  "fork",
  "clone",
  "tree",
  "trust",
  "name",
  "scoped-models",
]);

export function isHiddenComposerCommand(command: AgentCommand): boolean {
  return command.source === "builtin" && hiddenBuiltinCommands.has(command.name.toLowerCase());
}

export function composerCommandQuery(value: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(value);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function matchingComposerCommands(
  commands: AgentCommand[],
  query: string,
  limit = 8,
): AgentCommand[] {
  const normalized = query.trim().toLowerCase();
  // A hidden built-in typed in full closes the menu so Enter sends it as typed.
  if (commands.some((command) => isHiddenComposerCommand(command) && command.name.toLowerCase() === normalized)) return [];
  return commands
    .filter((command) => !isHiddenComposerCommand(command))
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, normalized),
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score
      || left.command.name.localeCompare(right.command.name)
      || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.command);
}

export function composerCommandValue(command: AgentCommand): string {
  return `/${command.name}${commandNeedsArguments(command.name) ? " " : ""}`;
}

function commandScore(command: AgentCommand, query: string): number {
  if (!query) return sourceScore(command.source);
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 10 + sourceScore(command.source);
  if (name.includes(query)) return 20 + sourceScore(command.source);
  if (description.includes(query)) return 30 + sourceScore(command.source);
  return Number.POSITIVE_INFINITY;
}

function sourceScore(source: AgentCommand["source"]): number {
  if (source === "skill") return 0;
  if (source === "prompt") return 1;
  if (source === "extension") return 2;
  return 3;
}

function commandNeedsArguments(name: string): boolean {
  return argumentCommands.has(name);
}
