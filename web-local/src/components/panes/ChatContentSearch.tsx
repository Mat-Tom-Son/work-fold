import { useEffect, useMemo, useState } from "react";

import { conversationLifecycleView } from "../../lib/chat-lifecycle";
import { api } from "../../lib/api";
import type { ChatLifecycleView, ConversationSummary, WorkFolderSummary } from "../../types";

export interface ChatContentMatch {
  conversationId: string;
  title: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  preview: string;
}

interface ChatSearchResponse {
  chats: ChatContentMatch[];
  truncated: boolean;
}

interface ChatSearchResult {
  byWorkFolder: Record<string, ChatSearchResponse>;
  truncated: boolean;
  failedWorkFolders: number;
}

const searchDebounceMs = 250;
const searchConcurrency = 3;
const visibleMatchLimit = 50;

export function ChatContentSearch({
  workFolders,
  conversations,
  query,
  now,
  onOpen,
}: {
  workFolders: WorkFolderSummary[];
  conversations: Record<string, ConversationSummary[]>;
  query: string;
  now: number;
  onOpen: (workFolder: WorkFolderSummary, conversation: ConversationSummary) => void;
}) {
  const [state, setState] = useState<{
    status: "idle" | "searching" | "ready" | "error";
    result: ChatSearchResult | null;
  }>({ status: "idle", result: null });
  const workFolderIds = workFolders.map((workFolder) => workFolder.id).join("|");

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", result: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching", result: null });
    const timer = window.setTimeout(() => {
      void searchChatTranscripts(workFolders, trimmed, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState({ status: "ready", result }); })
        .catch(() => { if (!controller.signal.aborted) setState({ status: "error", result: null }); });
    }, searchDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, workFolderIds]);

  const matches = useMemo(() => {
    if (!state.result) return [];
    const result: Array<{
      workFolder: WorkFolderSummary;
      conversation: ConversationSummary;
      match: ChatContentMatch;
    }> = [];
    for (const workFolder of workFolders) {
      const summaries = new Map((conversations[workFolder.id] ?? []).map((conversation) => [conversation.id, conversation]));
      for (const match of state.result.byWorkFolder[workFolder.id]?.chats ?? []) {
        const conversation = summaries.get(match.conversationId);
        // Search covers every Chat; a snoozed or archived one says so on its row.
        if (!conversation) continue;
        result.push({ workFolder, conversation, match });
      }
    }
    return result;
  }, [state.result, workFolders, conversations]);

  if (state.status === "idle") return null;
  const visible = matches.slice(0, visibleMatchLimit);
  const truncated = Boolean(state.result?.truncated) || matches.length > visible.length;

  return (
    <section className="chat-content-search" aria-label="Matches in Chat transcripts">
      <h3>
        In Chat transcripts
        <span aria-live="polite">
          {state.status === "searching"
            ? "Searching"
            : state.status === "error"
              ? "Unavailable"
              : `${matches.length}${truncated ? "+" : ""}`}
        </span>
      </h3>
      {state.status === "error"
        ? <p className="chat-content-search-note">Couldn&rsquo;t search Chat transcripts.</p>
        : visible.length === 0 && state.status === "ready"
          ? <p className="chat-content-search-note">No Chat transcripts match.</p>
          : (
            <ul>
              {visible.map(({ workFolder, conversation, match }, index) => (
                <li key={`${workFolder.id}:${match.conversationId}:${match.createdAt}:${index}`}>
                  <button type="button" onClick={() => onOpen(workFolder, conversation)}>
                    <span className="chat-content-search-title">{conversation.title}</span>
                    <span className="chat-content-search-meta">{[workFolder.name, lifecycleLabel(conversationLifecycleView(conversation, now)), chatRoleLabel(match.role)].filter(Boolean).join(" · ")}</span>
                    <span className="chat-content-search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {truncated
        ? <p className="chat-content-search-note">Showing the first {visible.length} matches.</p>
        : null}
      {state.result?.failedWorkFolders
        ? <p className="chat-content-search-note">Some work-folders couldn&rsquo;t be searched.</p>
        : null}
    </section>
  );
}

function lifecycleLabel(view: ChatLifecycleView): string | null {
  return view === "snoozed" ? "Snoozed" : view === "archived" ? "Archived" : null;
}

function chatRoleLabel(role: ChatContentMatch["role"]): string {
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

async function searchChatTranscripts(
  workFolders: WorkFolderSummary[],
  query: string,
  signal: AbortSignal,
): Promise<ChatSearchResult> {
  const byWorkFolder: Record<string, ChatSearchResponse> = {};
  let failedWorkFolders = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(searchConcurrency, workFolders.length) }, async () => {
    while (next < workFolders.length) {
      const workFolder = workFolders[next++];
      if (!workFolder) continue;
      try {
        const result = await api<ChatSearchResponse>(
          `/api/work-folders/${workFolder.id}/search?scope=chats&q=${encodeURIComponent(query)}`,
          { signal },
        );
        byWorkFolder[workFolder.id] = result;
      } catch (error) {
        if (signal.aborted) throw error;
        failedWorkFolders += 1;
      }
    }
  }));
  if (workFolders.length > 0 && failedWorkFolders === workFolders.length) {
    throw new Error("No Chat transcripts could be searched.");
  }
  return {
    byWorkFolder,
    truncated: Object.values(byWorkFolder).some((result) => result.truncated),
    failedWorkFolders,
  };
}
