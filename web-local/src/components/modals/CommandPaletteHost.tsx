import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search } from "lucide-react";
import { commandPaletteGroupCap, commandPaletteGroupOrder, commandPaletteOverallCap } from "../../constants";
import { desktopShortcutKeyLabel, desktopShortcutModifierKey } from "../../lib/keyboard";
import { normalizeSearchQuery } from "../../lib/format";
import { useModalDialog } from "../../hooks/useModalDialog";
import type { CommandPaletteGroupId } from "../../types";

interface CommandPaletteCommand {
  id: string;
  groupId: CommandPaletteGroupId;
  groupLabel: string;
  label: string;
  detail?: string;
  keywords?: string[];
  matchTargets?: string[];
  defaultVisible?: boolean;
  minQueryLength?: number;
  run: () => void;
}

interface CommandPaletteMatch {
  rank: number;
  offset: number;
  spread: number;
  targetLength: number;
}

interface CommandPaletteResult {
  command: CommandPaletteCommand;
  order: number;
  match: CommandPaletteMatch | null;
}

interface CommandPaletteResultGroup {
  id: CommandPaletteGroupId;
  label: string;
  results: CommandPaletteResult[];
}

function CommandPaletteHost({
  commands,
  onClose,
}: {
  commands: CommandPaletteCommand[];
  onClose: (options?: { restoreFocus?: boolean }) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: inputRef, restoreFocus: false });
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const { groups, flatResults } = useMemo(() => {
    const resultGroups = commandPaletteResultGroups(commands, query);
    return { groups: resultGroups, flatResults: resultGroups.flatMap((group) => group.results) };
  }, [commands, query]);
  const activeResult = flatResults[highlightedIndex] ?? null;
  const activeOptionId = activeResult ? `command-palette-option-${highlightedIndex}` : undefined;
  const modifier = desktopShortcutModifierKey();

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    setHighlightedIndex((current) => flatResults.length ? Math.min(current, flatResults.length - 1) : 0);
  }, [flatResults.length]);

  function moveHighlight(offset: number): void {
    if (!flatResults.length) return;
    setHighlightedIndex((current) => (current + offset + flatResults.length) % flatResults.length);
  }

  function runResult(result: CommandPaletteResult): void {
    onClose({ restoreFocus: false });
    result.command.run();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeResult) runResult(activeResult);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
    }
  }

  let optionIndex = 0;

  return (
    <div className="modal-backdrop command-palette-backdrop" role="presentation" onMouseDown={() => onClose()}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="command-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={activeOptionId}
            aria-describedby="command-palette-hint"
            aria-label="Command palette"
            placeholder="Search commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <span className="command-palette-shortcut" aria-hidden="true">
            <kbd>{desktopShortcutKeyLabel(modifier)}</kbd>
            <kbd>K</kbd>
          </span>
        </div>
        <h2 id="command-palette-title" className="sr-only">Command palette</h2>
        <div id="command-palette-results" className="command-palette-results" role="listbox" aria-label="Commands">
          {flatResults.length ? groups.map((group) => (
            <section className="command-palette-group" key={group.id}>
              <div className="command-palette-group-title" role="presentation">{group.label}</div>
              <div className="command-palette-group-list">
                {group.results.map((result) => {
                  const currentIndex = optionIndex;
                  optionIndex += 1;
                  return (
                    <button
                      className={currentIndex === highlightedIndex ? "command-palette-option active" : "command-palette-option"}
                      type="button"
                      role="option"
                      aria-selected={currentIndex === highlightedIndex}
                      id={`command-palette-option-${currentIndex}`}
                      key={result.command.id}
                      onMouseEnter={() => setHighlightedIndex(currentIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => runResult(result)}
                    >
                      <span className="command-palette-option-label">{result.command.label}</span>
                      {result.command.detail ? <span className="command-palette-option-detail">{result.command.detail}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          )) : (
            <div className="command-palette-empty">No matching commands.</div>
          )}
        </div>
        <div id="command-palette-hint" className="command-palette-footer">
          <span><kbd>{modifier}</kbd><kbd>K</kbd> closes</span>
        </div>
      </section>
    </div>
  );
}

function commandPaletteResultGroups(commands: CommandPaletteCommand[], query: string): CommandPaletteResultGroup[] {
  const normalizedQuery = normalizeSearchQuery(query);
  const results = commands.map((command, order) => {
    if (normalizedQuery.length < (command.minQueryLength ?? 0)) return null;
    if (!normalizedQuery) return command.defaultVisible ? { command, order, match: null } : null;
    const match = commandPaletteMatchCommand(command, normalizedQuery);
    return match ? { command, order, match } : null;
  }).filter((result): result is CommandPaletteResult => Boolean(result));

  const groups: CommandPaletteResultGroup[] = [];
  let emitted = 0;
  for (const groupId of commandPaletteGroupOrder) {
    const groupResults = results
      .filter((result) => result.command.groupId === groupId)
      .sort((left, right) => normalizedQuery ? compareCommandPaletteResults(left, right) : left.order - right.order)
      .slice(0, commandPaletteGroupCap);
    if (!groupResults.length) continue;
    const available = commandPaletteOverallCap - emitted;
    if (available <= 0) break;
    const limited = groupResults.slice(0, available);
    groups.push({ id: groupId, label: limited[0].command.groupLabel, results: limited });
    emitted += limited.length;
  }
  return groups;
}

function commandPaletteMatchCommand(command: CommandPaletteCommand, normalizedQuery: string): CommandPaletteMatch | null {
  const targets = (command.matchTargets ?? [command.label, command.detail ?? "", ...(command.keywords ?? [])])
    .map(normalizeSearchQuery)
    .filter(Boolean);
  let best: CommandPaletteMatch | null = null;
  for (const target of targets) {
    const match = commandPaletteMatchText(normalizedQuery, target);
    if (!match) continue;
    if (!best || compareCommandPaletteMatches(match, best) < 0) best = match;
  }
  return best;
}

function commandPaletteMatchText(query: string, target: string): CommandPaletteMatch | null {
  if (!query) return { rank: 0, offset: 0, spread: 0, targetLength: target.length };
  if (target.startsWith(query)) return { rank: 0, offset: 0, spread: 0, targetLength: target.length };
  const wordStartOffset = commandPaletteWordStartOffset(target, query);
  if (wordStartOffset >= 0) return { rank: 1, offset: wordStartOffset, spread: 0, targetLength: target.length };
  const substringOffset = target.indexOf(query);
  if (substringOffset >= 0) return { rank: 2, offset: substringOffset, spread: 0, targetLength: target.length };
  return commandPaletteSubsequenceMatch(target, query);
}

function commandPaletteWordStartOffset(target: string, query: string): number {
  for (let index = 1; index <= target.length - query.length; index += 1) {
    if (target.startsWith(query, index) && commandPaletteIsWordStart(target, index)) return index;
  }
  return -1;
}

function commandPaletteIsWordStart(target: string, index: number): boolean {
  const previous = target[index - 1];
  return !previous || previous === " " || previous === ":" || previous === "/" || previous === "-" || previous === "_" || previous === ".";
}

function commandPaletteSubsequenceMatch(target: string, query: string): CommandPaletteMatch | null {
  const positions: number[] = [];
  let searchFrom = 0;
  for (const character of query) {
    const index = target.indexOf(character, searchFrom);
    if (index < 0) return null;
    positions.push(index);
    searchFrom = index + 1;
  }
  const first = positions[0] ?? 0;
  const last = positions[positions.length - 1] ?? first;
  return {
    rank: 3,
    offset: first,
    spread: Math.max(0, last - first - query.length + 1),
    targetLength: target.length,
  };
}

function compareCommandPaletteResults(left: CommandPaletteResult, right: CommandPaletteResult): number {
  if (left.match && right.match) {
    const byMatch = compareCommandPaletteMatches(left.match, right.match);
    if (byMatch !== 0) return byMatch;
  }
  return left.order - right.order;
}

function compareCommandPaletteMatches(left: CommandPaletteMatch, right: CommandPaletteMatch): number {
  return left.rank - right.rank
    || left.offset - right.offset
    || left.spread - right.spread
    || left.targetLength - right.targetLength;
}

export { CommandPaletteHost };
export type { CommandPaletteCommand };
