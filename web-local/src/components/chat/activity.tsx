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
                remarkPlugins={[remarkGfm]}
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
              <span className="runtime-tool-phase">{phaseLabel(entry.phase)}</span>
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

function phaseLabel(phase: AgentActivityPhase | undefined): string {
  if (phase === "queued") return "Queued";
  if (phase === "complete") return "Done";
  if (phase === "error") return "Failed";
  return "Running";
}

function toolLabel(entry: RuntimePreviewEntry): string {
  const source = entry.toolName?.trim() || entry.text
    .replace(/\s+(?:queued|running|updating|finished|failed)$/i, "")
    .trim() || "Assistant tool";
  return source
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
