import { useEffect, useMemo, useState } from "react";

import { conversationLifecycleView } from "../../lib/chat-lifecycle";
import { api } from "../../lib/api";
import type { ChatLifecycleView, ConversationSummary, SpaceSummary } from "../../types";

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
  bySpace: Record<string, ChatSearchResponse>;
  truncated: boolean;
  failedSpaces: number;
}

const searchDebounceMs = 250;
const searchConcurrency = 3;
const visibleMatchLimit = 50;

export function ChatContentSearch({
  spaces,
  conversations,
  query,
  view,
  now,
  onOpen,
}: {
  spaces: SpaceSummary[];
  conversations: Record<string, ConversationSummary[]>;
  query: string;
  view: ChatLifecycleView;
  now: number;
  onOpen: (space: SpaceSummary, conversation: ConversationSummary) => void;
}) {
  const [state, setState] = useState<{
    status: "idle" | "searching" | "ready" | "error";
    result: ChatSearchResult | null;
  }>({ status: "idle", result: null });
  const spaceIds = spaces.map((space) => space.id).join("|");

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", result: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching", result: null });
    const timer = window.setTimeout(() => {
      void searchChatTranscripts(spaces, trimmed, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState({ status: "ready", result }); })
        .catch(() => { if (!controller.signal.aborted) setState({ status: "error", result: null }); });
    }, searchDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, spaceIds]);

  const matches = useMemo(() => {
    if (!state.result) return [];
    const result: Array<{
      space: SpaceSummary;
      conversation: ConversationSummary;
      match: ChatContentMatch;
    }> = [];
    for (const space of spaces) {
      const summaries = new Map((conversations[space.id] ?? []).map((conversation) => [conversation.id, conversation]));
      for (const match of state.result.bySpace[space.id]?.chats ?? []) {
        const conversation = summaries.get(match.conversationId);
        if (!conversation || conversationLifecycleView(conversation, now) !== view) continue;
        result.push({ space, conversation, match });
      }
    }
    return result;
  }, [state.result, spaces, conversations, now, view]);

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
              {visible.map(({ space, conversation, match }, index) => (
                <li key={`${space.id}:${match.conversationId}:${match.createdAt}:${index}`}>
                  <button type="button" onClick={() => onOpen(space, conversation)}>
                    <span className="chat-content-search-title">{conversation.title}</span>
                    <span className="chat-content-search-meta">{space.name} · {chatRoleLabel(match.role)}</span>
                    <span className="chat-content-search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {truncated
        ? <p className="chat-content-search-note">Showing the first {visible.length} matches. Narrow the search to see fewer.</p>
        : null}
      {state.result?.failedSpaces
        ? <p className="chat-content-search-note">Some Spaces couldn&rsquo;t be searched.</p>
        : null}
    </section>
  );
}

function chatRoleLabel(role: ChatContentMatch["role"]): string {
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

async function searchChatTranscripts(
  spaces: SpaceSummary[],
  query: string,
  signal: AbortSignal,
): Promise<ChatSearchResult> {
  const bySpace: Record<string, ChatSearchResponse> = {};
  let failedSpaces = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(searchConcurrency, spaces.length) }, async () => {
    while (next < spaces.length) {
      const space = spaces[next++];
      if (!space) continue;
      try {
        const result = await api<ChatSearchResponse>(
          `/api/spaces/${space.id}/search?scope=chats&q=${encodeURIComponent(query)}`,
          { signal },
        );
        bySpace[space.id] = result;
      } catch (error) {
        if (signal.aborted) throw error;
        failedSpaces += 1;
      }
    }
  }));
  if (spaces.length > 0 && failedSpaces === spaces.length) {
    throw new Error("No Chat transcripts could be searched.");
  }
  return {
    bySpace,
    truncated: Object.values(bySpace).some((result) => result.truncated),
    failedSpaces,
  };
}
