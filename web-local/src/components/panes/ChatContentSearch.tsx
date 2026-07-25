import { useEffect, useMemo, useState } from "react";

import { conversationLifecycleView } from "../../lib/chat-lifecycle";
import { api } from "../../lib/api";
import type { ChatLifecycleView, ConversationSummary, WorkspaceSummary } from "../../types";

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
  byWorkspace: Record<string, ChatSearchResponse>;
  truncated: boolean;
  failedWorkspaces: number;
}

const searchDebounceMs = 250;
const searchConcurrency = 3;
const visibleMatchLimit = 50;

export function ChatContentSearch({
  workspaces,
  conversations,
  query,
  view,
  now,
  onOpen,
}: {
  workspaces: WorkspaceSummary[];
  conversations: Record<string, ConversationSummary[]>;
  query: string;
  view: ChatLifecycleView;
  now: number;
  onOpen: (workspace: WorkspaceSummary, conversation: ConversationSummary) => void;
}) {
  const [state, setState] = useState<{
    status: "idle" | "searching" | "ready" | "error";
    result: ChatSearchResult | null;
  }>({ status: "idle", result: null });
  const workspaceIds = workspaces.map((workspace) => workspace.id).join("|");

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", result: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching", result: null });
    const timer = window.setTimeout(() => {
      void searchChatTranscripts(workspaces, trimmed, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState({ status: "ready", result }); })
        .catch(() => { if (!controller.signal.aborted) setState({ status: "error", result: null }); });
    }, searchDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, workspaceIds]);

  const matches = useMemo(() => {
    if (!state.result) return [];
    const result: Array<{
      workspace: WorkspaceSummary;
      conversation: ConversationSummary;
      match: ChatContentMatch;
    }> = [];
    for (const workspace of workspaces) {
      const summaries = new Map((conversations[workspace.id] ?? []).map((conversation) => [conversation.id, conversation]));
      for (const match of state.result.byWorkspace[workspace.id]?.chats ?? []) {
        const conversation = summaries.get(match.conversationId);
        if (!conversation || conversationLifecycleView(conversation, now) !== view) continue;
        result.push({ workspace, conversation, match });
      }
    }
    return result;
  }, [state.result, workspaces, conversations, now, view]);

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
          ? <p className="chat-content-search-note">No {view} Chat transcripts match.</p>
          : (
            <ul>
              {visible.map(({ workspace, conversation, match }, index) => (
                <li key={`${workspace.id}:${match.conversationId}:${match.createdAt}:${index}`}>
                  <button type="button" onClick={() => onOpen(workspace, conversation)}>
                    <span className="chat-content-search-title">{conversation.title}</span>
                    <span className="chat-content-search-meta">{workspace.name} · {chatRoleLabel(match.role)}</span>
                    <span className="chat-content-search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {truncated
        ? <p className="chat-content-search-note">Showing the first {visible.length} matches. Narrow the search to see fewer.</p>
        : null}
      {state.result?.failedWorkspaces
        ? <p className="chat-content-search-note">Some Spaces couldn&rsquo;t be searched.</p>
        : null}
    </section>
  );
}

function chatRoleLabel(role: ChatContentMatch["role"]): string {
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

async function searchChatTranscripts(
  workspaces: WorkspaceSummary[],
  query: string,
  signal: AbortSignal,
): Promise<ChatSearchResult> {
  const byWorkspace: Record<string, ChatSearchResponse> = {};
  let failedWorkspaces = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(searchConcurrency, workspaces.length) }, async () => {
    while (next < workspaces.length) {
      const workspace = workspaces[next++];
      if (!workspace) continue;
      try {
        const result = await api<ChatSearchResponse>(
          `/api/workspaces/${workspace.id}/search?scope=chats&q=${encodeURIComponent(query)}`,
          { signal },
        );
        byWorkspace[workspace.id] = result;
      } catch (error) {
        if (signal.aborted) throw error;
        failedWorkspaces += 1;
      }
    }
  }));
  if (workspaces.length > 0 && failedWorkspaces === workspaces.length) {
    throw new Error("No Chat transcripts could be searched.");
  }
  return {
    byWorkspace,
    truncated: Object.values(byWorkspace).some((result) => result.truncated),
    failedWorkspaces,
  };
}
