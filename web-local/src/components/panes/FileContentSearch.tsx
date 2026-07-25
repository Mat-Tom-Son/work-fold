import { useEffect, useState } from "react";

import { api } from "../../lib/api";

export interface FileContentMatch {
  path: string;
  line: number;
  preview: string;
}

interface SearchResponse {
  files: FileContentMatch[];
  truncated: boolean;
}

const searchDebounceMs = 250;
const visibleMatchLimit = 50;

/**
 * Matches inside file contents, alongside the tree's filename matching. The
 * request is debounced and abandoned when the query or Space changes, so
 * typing never leaves a stale result on screen.
 */
export function FileContentSearch({ workspaceId, query, onOpenFile }: {
  workspaceId: string;
  query: string;
  onOpenFile: (path: string) => void;
}) {
  const [state, setState] = useState<{ status: "idle" | "searching" | "ready" | "error"; result: SearchResponse | null }>({
    status: "idle",
    result: null,
  });

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", result: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ status: "searching", result: current.result }));
    const timer = window.setTimeout(() => {
      void api<SearchResponse>(`/api/workspaces/${workspaceId}/search?scope=files&q=${encodeURIComponent(trimmed)}`)
        .then((result) => { if (!cancelled) setState({ status: "ready", result }); })
        .catch(() => { if (!cancelled) setState({ status: "error", result: null }); });
    }, searchDebounceMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, workspaceId]);

  if (state.status === "idle") return null;
  const matches = state.result?.files ?? [];
  const visible = matches.slice(0, visibleMatchLimit);

  return (
    <section className="file-content-search" aria-label="Matches in file contents">
      <h3>
        In file contents
        <span aria-live="polite">
          {state.status === "searching" && !state.result ? "Searching"
            : state.status === "error" ? "Unavailable"
              : `${matches.length}${state.result?.truncated ? "+" : ""}`}
        </span>
      </h3>
      {state.status === "error"
        ? <p className="file-content-search-note">Couldn&rsquo;t search this Space.</p>
        : visible.length === 0 && state.status === "ready"
          ? <p className="file-content-search-note">No file contents match.</p>
          : (
            <ul>
              {visible.map((match) => (
                <li key={`${match.path}:${match.line}`}>
                  <button type="button" onClick={() => onOpenFile(match.path)} title={`${match.path}:${match.line}`}>
                    <span className="file-content-search-path">{match.path}<span>:{match.line}</span></span>
                    <span className="file-content-search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {matches.length > visible.length || state.result?.truncated
        ? <p className="file-content-search-note">Showing the first {visible.length} matches. Narrow the search to see fewer.</p>
        : null}
    </section>
  );
}
