import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { RuntimePreviewEntry } from "../../types";

/**
 * Reasoning is model output, not an app-authored status card. Show only the
 * text the model actually streamed; empty phases fall back to the Chat's
 * ordinary Working indicator.
 */
export function RuntimeContextPreview({ entries, running = false }: { entries: RuntimePreviewEntry[]; running?: boolean }) {
  const text = entries
    .filter((entry) => entry.kind === "thinking")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return null;
  return (
    <section className={running ? "runtime-preview running" : "runtime-preview"} aria-label="Reasoning">
      <div className="runtime-preview-text">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children }) => <>{children}</>,
            img: ({ alt }) => <span>{alt ?? ""}</span>,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </section>
  );
}
