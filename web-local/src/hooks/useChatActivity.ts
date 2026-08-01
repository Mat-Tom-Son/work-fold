import { useCallback, useMemo, useState } from "react";

import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import type { ChatActivityStatus } from "../types";

const attentionStorageKey = "work-fold.space.chat-attention.v1";

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

  const statuses = useMemo<Record<string, ChatActivityStatus>>(() => {
    const result: Record<string, ChatActivityStatus> = {};
    for (const key of attentionKeys) result[key] = "attention";
    for (const key of runningKeys) result[key] = "running";
    return result;
  }, [attentionKeys, runningKeys]);

  return { statuses, setRunning, setAttention };
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
