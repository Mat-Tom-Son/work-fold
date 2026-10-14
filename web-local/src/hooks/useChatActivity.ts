import { useCallback, useMemo, useRef, useState } from "react";

import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { chatActivityKey, conversationLifecycleView } from "../lib/chat-lifecycle";
import type { ChatActivityStatus, ConversationSummary } from "../types";

const attentionStorageKey = "work-fold.work-folder.chat-attention.v1";

export function useChatActivity(fixtureMode = false) {
  const [runningKeys, setRunningKeys] = useState<Set<string>>(() => new Set());
  const [attentionKeys, setAttentionKeys] = useState<Set<string>>(() => fixtureMode
    ? new Set()
    : readStoredJsonValue(attentionStorageKey, normalizeChatAttentionKeys, new Set()));

  const setAttention = useCallback((key: string, attention: boolean) => {
    setAttentionKeys((current) => {
      const next = updateSet(current, key, attention);
      if (!fixtureMode) writeStoredJsonValue(attentionStorageKey, [...next].sort());
      return next;
    });
  }, [fixtureMode]);

  const setRunning = useCallback((key: string, running: boolean) => {
    setRunningKeys((current) => updateSet(current, key, running));
    if (running) setAttention(key, false);
  }, [setAttention]);

  // Turns the host reports running that no mounted Chat tab follows — a
  // handoff into a nested work-folder, a CLI send. When one ends unwatched, its
  // Chat earns the same "new reply" dot a background tab would.
  const [backgroundKeys, setBackgroundKeys] = useState<Set<string>>(() => new Set());
  const backgroundRef = useRef<Set<string>>(new Set());
  const syncBackgroundRunning = useCallback((next: ReadonlySet<string>, isWatched: (key: string) => boolean): string[] => {
    const transition = backgroundRunningTransition(backgroundRef.current, next, isWatched);
    for (const key of transition.started) setAttention(key, false);
    for (const key of transition.finishedUnwatched) setAttention(key, true);
    if (transition.changed) {
      backgroundRef.current = new Set(next);
      setBackgroundKeys(backgroundRef.current);
    }
    return transition.finished;
  }, [setAttention]);

  const statuses = useMemo<Record<string, ChatActivityStatus>>(() => {
    const result: Record<string, ChatActivityStatus> = {};
    for (const key of attentionKeys) result[key] = "attention";
    for (const key of backgroundKeys) result[key] = "running";
    for (const key of runningKeys) result[key] = "running";
    return result;
  }, [attentionKeys, backgroundKeys, runningKeys]);

  // Saved "new reply" marks outlive their Chats (deleted from the CLI, a
  // removed work-folder). Drop the ones the caller can prove are gone.
  const pruneAttention = useCallback((isGone: (key: string) => boolean) => {
    setAttentionKeys((current) => {
      const next = new Set([...current].filter((key) => !isGone(key)));
      if (next.size === current.size) return current;
      if (!fixtureMode) writeStoredJsonValue(attentionStorageKey, [...next].sort());
      return next;
    });
  }, [fixtureMode]);

  return { statuses, setRunning, setAttention, syncBackgroundRunning, pruneAttention };
}

/** What changed between two host reports of running turns. Pure, for tests. */
export function backgroundRunningTransition(previous: ReadonlySet<string>, next: ReadonlySet<string>, isWatched: (key: string) => boolean) {
  const started = [...next].filter((key) => !previous.has(key));
  const finished = [...previous].filter((key) => !next.has(key));
  return {
    started,
    finished,
    finishedUnwatched: finished.filter((key) => !isWatched(key)),
    changed: started.length > 0 || finished.length > 0,
  };
}

/**
 * One dot per work-folder. A running turn counts wherever it is; a waiting reply
 * counts only for a Chat the person can open from the active Chats list, so a
 * deleted, archived, or snoozed Chat never leaves a work-folder dot nobody can clear.
 */
export function folderActivityStatuses(
  statuses: Readonly<Record<string, ChatActivityStatus>>,
  conversations: Readonly<Record<string, readonly ConversationSummary[]>>,
  now = Date.now(),
): Record<string, ChatActivityStatus> {
  const result: Record<string, ChatActivityStatus> = {};
  for (const [key, status] of Object.entries(statuses)) {
    if (status !== "running") continue;
    const workFolderId = key.slice(0, key.indexOf(":"));
    if (workFolderId) result[workFolderId] = "running";
  }
  for (const [workFolderId, list] of Object.entries(conversations)) {
    if (result[workFolderId]) continue;
    if (list.some((chat) => statuses[chatActivityKey(workFolderId, chat.id)] === "attention" && conversationLifecycleView(chat, now) === "active")) {
      result[workFolderId] = "attention";
    }
  }
  return result;
}

function updateSet(current: Set<string>, key: string, present: boolean): Set<string> {
  if (!key || current.has(key) === present) return current;
  const next = new Set(current);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

export function normalizeChatAttentionKeys(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string =>
    typeof item === "string"
    && item.length > 2
    && item.length <= 300
    && item.includes(":")));
}
