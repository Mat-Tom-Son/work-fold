import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AgentActivityPhase, RuntimePreviewEntry } from "../../types";

/**
 * Keep the Assistant's work attached to the answer it is producing. Thinking
 * contains only model-supplied reasoning; tool rows contain the safe summaries
 * already emitted by the runtime.
 */
export function RuntimeContextPreview({ entries, running = false }: { entries: RuntimePreviewEntry[]; running?: boolean }) {
  const thinkingEntries = entries.filter((entry) => entry.kind === "thinking");
  const thinkingText = thinkingEntries
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const toolEntries = entries.filter((entry) => entry.kind === "tool");
  const hasActiveEntry = entries.some((entry) => isActivePhase(entry.phase));
  const thinkingActive = thinkingEntries.some((entry) => isActivePhase(entry.phase));
  if (!thinkingEntries.length && !toolEntries.length) return null;
  return (
    <section className={running || hasActiveEntry ? "runtime-preview running" : "runtime-preview"} aria-label="Assistant work">
      {thinkingEntries.length ? (
        <div className="runtime-thinking">
          <div className="runtime-thinking-label">{thinkingActive ? "Thinking…" : "Thinking"}</div>
          {thinkingText ? (
            <div className="runtime-preview-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, repairReasoningMarkdownArtifacts]}
                components={{
                  a: ({ children }) => <>{children}</>,
                  img: ({ alt }) => <span>{alt ?? ""}</span>,
                }}
              >
                {thinkingText}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      ) : null}
      {toolEntries.length ? (
        <div className="runtime-tool-list" aria-label="Tool calls">
          {toolEntries.map((entry) => (
            <div className={`runtime-tool-row ${entry.phase ?? "running"}`} key={entry.id}>
              <span className="runtime-tool-dot" aria-hidden="true" />
              <span className="runtime-tool-main">
                <span className="runtime-tool-name">{toolLabel(entry)}</span>
                {entry.detail ? <span className="runtime-tool-detail" title={entry.detail}>{entry.detail}</span> : null}
              </span>
              {phaseLabel(entry) ? <span className="runtime-tool-phase">{phaseLabel(entry)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isActivePhase(phase: AgentActivityPhase | undefined): boolean {
  return phase === "queued" || phase === "running" || phase === "streaming";
}

function phaseLabel(entry: RuntimePreviewEntry): string {
  if (entry.phase === "queued") return "Queued";
  if (entry.phase === "error") return "Failed";
  if ((entry.phase === "running" || entry.phase === "streaming") && !knownToolLabels(toolKey(entry))) return "Running";
  return "";
}

function toolLabel(entry: RuntimePreviewEntry): string {
  const source = toolKey(entry);
  const labels = knownToolLabels(source);
  if (labels) {
    if (entry.phase === "running" || entry.phase === "streaming") return labels.running;
    if (entry.phase === "complete") return labels.complete;
    return labels.base;
  }
  return source
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function toolKey(entry: RuntimePreviewEntry): string {
  return (entry.toolName?.trim() || entry.text
    .replace(/\s+(?:queued|running|updating|finished|failed)$/i, "")
    .trim() || "Assistant tool").toLowerCase();
}

function knownToolLabels(source: string): { base: string; running: string; complete: string } | null {
  const known: Record<string, { base: string; running: string; complete: string }> = {
    bash: { base: "Command", running: "Running command", complete: "Ran command" },
    read: { base: "Read file", running: "Reading file", complete: "Read file" },
    write: { base: "Write file", running: "Writing file", complete: "Wrote file" },
    edit: { base: "Edit file", running: "Editing file", complete: "Edited file" },
    grep: { base: "Search files", running: "Searching files", complete: "Searched files" },
    search: { base: "Search", running: "Searching", complete: "Searched" },
    find: { base: "Find files", running: "Finding files", complete: "Found files" },
    ls: { base: "List files", running: "Listing files", complete: "Listed files" },
  };
  return known[source] ?? null;
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * CommonMark has already converted valid emphasis into `strong` nodes by the
 * time this runs. Only plain text nodes still contain stray model-authored
 * markers, so code and legitimate Markdown remain byte-for-byte untouched.
 */
function repairReasoningMarkdownArtifacts() {
  return (tree: MarkdownNode) => visitMarkdownNodes(tree, (node) => {
    if (node.type === "text" && typeof node.value === "string") {
      node.value = cleanReasoningTextNode(node.value);
    }
  });
}

export function cleanReasoningTextNode(value: string): string {
  return value.replace(/(^|[\s(—:])(?:\*\*|__)(?=[\p{L}\p{N}_])/gu, "$1");
}

function visitMarkdownNodes(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) visitMarkdownNodes(child, visit);
}
