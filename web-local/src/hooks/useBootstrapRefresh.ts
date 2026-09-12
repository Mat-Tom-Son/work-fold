import { useCallback, useEffect, useRef } from "react";
import { api, errorText } from "../lib/api";
import type { BootstrapResponse } from "../types";

/** Older registry reads must never resurrect a Space removed by a newer read. */
export function useBootstrapRefresh(enabled: boolean, receive: (value: BootstrapResponse) => void, onError: (message: string) => void) {
  const callbacks = useRef({ receive, onError });
  callbacks.current = { receive, onError };
  const request = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current += 1; pending.current?.abort(); }, []);
  return useCallback(async () => {
    if (!enabled) return;
    const version = ++request.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const result = await api<BootstrapResponse>("/api/bootstrap", { signal: controller.signal });
      if (version === request.current) {
        callbacks.current.receive(result);
        return result;
      }
    } catch (error) {
      if (version === request.current) callbacks.current.onError(errorText(error));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [enabled]);
}
