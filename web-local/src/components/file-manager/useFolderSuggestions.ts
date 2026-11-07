import { useEffect, useState } from "react";

import { api } from "../../lib/api";

/** Suggestions already written this session, by work-folder and folder; the host keeps them longer. */
const written = new Map<string, string[]>();

/**
 * The suggested messages above the message box, written by the work-folder's
 * own model from what is in the folder shown and its recent Chats (owner
 * request, 2026-11-06). Until they arrive, or with no AI connected, or if the
 * call fails, the list is empty and the plain suggestions show instead.
 */
export function useFolderSuggestions(workFolderId: string | null, path: string, enabled: boolean): string[] {
  const key = workFolderId ? `${workFolderId}\0${path}` : "";
  const [suggestions, setSuggestions] = useState<string[]>(() => written.get(key) ?? []);
  useEffect(() => {
    setSuggestions(written.get(key) ?? []);
    if (!enabled || !workFolderId || written.has(key)) return;
    let cancelled = false;
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    void api<{ suggestions: string[] }>(`/api/work-folders/${encodeURIComponent(workFolderId)}/suggestions${query}`)
      .then((body) => {
        const list = body.suggestions.filter(Boolean).slice(0, 4);
        written.set(key, list);
        if (!cancelled) setSuggestions(list);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return suggestions;
}
