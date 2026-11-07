import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lib/api";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { subscribeControlEvents } from "../../lib/control-events";
import { folderActivityStatuses, useChatActivity } from "../../hooks/useChatActivity";
import type { ChatActivityStatus, ConversationSummary, WorkFolderSummary } from "../../types";

/**
 * The file manager's activity dots, as the design draws them: a pulsing dot
 * on a work-folder while its Worker is running, and a green one when a Chat
 * has a reply nobody has read. The same host report and saved "new reply"
 * marks the classic layout uses; a Chat open in the panel counts as read.
 */
export function useFileManagerActivity(workFolders: readonly WorkFolderSummary[], fixtureMode: boolean, watchedKey: string | null) {
  const activity = useChatActivity(fixtureMode);
  const [conversations, setConversations] = useState<Record<string, ConversationSummary[]>>({});
  const watchedRef = useRef<string | null>(watchedKey);
  watchedRef.current = watchedKey;
  const workFolderIds = workFolders.map((item) => item.id).join("|");

  const loadConversations = useCallback((workFolderId: string) => {
    void api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${encodeURIComponent(workFolderId)}/conversations`)
      .then(({ conversations: list }) => setConversations((current) => ({ ...current, [workFolderId]: list })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (fixtureMode) return;
    for (const workFolder of workFolders) loadConversations(workFolder.id);
  }, [fixtureMode, loadConversations, workFolderIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fixtureMode) return;
    let disposed = false;
    let timer: number | null = null;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api<{ running: Array<{ workFolderId: string; conversationId: string }> }>("/api/work-folders/activity").then(({ running }) => {
        if (disposed || request !== generation) return;
        const finished = activity.syncBackgroundRunning(
          new Set(running.map((item) => chatActivityKey(item.workFolderId, item.conversationId))),
          (key) => key === watchedRef.current,
        );
        const changed = new Set([...running.map((item) => item.workFolderId), ...finished.map((key) => key.slice(0, key.indexOf(":")))]);
        for (const workFolderId of changed) if (workFolderId) loadConversations(workFolderId);
      }).catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeControlEvents((hint) => {
      if (hint !== "activity" && hint !== "reset") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
    });
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [activity.syncBackgroundRunning, fixtureMode, loadConversations]);

  // A Chat open in the panel has been read.
  useEffect(() => {
    if (watchedKey) activity.setAttention(watchedKey, false);
  }, [activity.setAttention, watchedKey]);

  const folderStatuses = useMemo(() => folderActivityStatuses(activity.statuses, conversations), [activity.statuses, conversations]);
  return {
    /** By work-folder id: running, or a reply waiting. */
    folderStatuses: folderStatuses as Readonly<Record<string, ChatActivityStatus>>,
    /** By chatActivityKey(work-folder, conversation). */
    chatStatuses: activity.statuses,
    setRunning: activity.setRunning,
    setAttention: activity.setAttention,
  };
}
