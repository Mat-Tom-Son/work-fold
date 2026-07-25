import type { AgentCommand } from "../../types";

const argumentCommands = new Set([
  "compact",
  "export",
  "login",
  "logout",
  "model",
  "name",
]);

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
  return commands
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
