import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkRequestView } from "../../../src/shared/request-presentation";
import { api, errorText } from "../lib/api";
import { subscribeControlEvents } from "../lib/control-events";

/** One visible surface re-reads durable work; hints are never work triggers. */
export function useWorkRequest(path: string | null) {
  const [work, setWork] = useState<WorkRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const scope = useRef(0);
  const reading = useRef<number | null>(null);
  const pending = useRef(false);
  const delivery = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (!path || document.visibilityState === "hidden") return;
    const owner = scope.current;
    if (reading.current === owner) return;
    reading.current = owner;
    const current = ++generation.current;
    try {
      const result = await api<{ work: WorkRequestView | null }>(path);
      if (current === generation.current) {
        setWork((previous) => JSON.stringify(previous) === JSON.stringify(result.work) ? previous : result.work);
        setError(null);
      }
    } catch (caught) { if (current === generation.current) setError(errorText(caught)); }
    finally { if (reading.current === owner) reading.current = null; }
  }, [path]);
  useEffect(() => {
    scope.current++; generation.current++; reading.current = null; pending.current = false; delivery.current = null;
    setWork(null); setError(null); setActionError(null); setBusy(false);
    if (!path) return;
    void refresh();
    const unsubscribe = subscribeControlEvents(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 2_000);
    const returned = () => void refresh();
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => { scope.current++; generation.current++; unsubscribe(); window.clearInterval(timer); window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned); };
  }, [path, refresh]);
  const act = async (action: "answer" | "stop" | "continue", body: Record<string, unknown> = {}) => {
    if (!work || pending.current) return false;
    pending.current = true; setBusy(true); setActionError(null);
    const owner = scope.current;
    if (action === "continue") delivery.current ??= `resume-${crypto.randomUUID()}`;
    const current = ++generation.current;
    try {
      const result = await api<{ work: WorkRequestView }>(`/api/requests/${encodeURIComponent(work.requestId)}/${action}`, {
        method: "POST", body: { ...body, surface: window.workFoldDesktop?.management ? "popover" : "main-window", ...(action === "continue" ? { deliveryId: delivery.current } : {}) },
      });
      if (owner !== scope.current) return true;
      if (current === generation.current) setWork(result.work);
      delivery.current = null;
      await refresh();
      return true;
    } catch (caught) {
      // Retain both the answer draft and continuation identity after a lost
      // response. Requery without hiding the failure message.
      if (owner !== scope.current) return false;
      await refresh();
      if (owner === scope.current) setActionError(errorText(caught));
      return false;
    } finally { if (owner === scope.current) { pending.current = false; setBusy(false); } }
  };
  return { work, error: actionError ?? error, busy, refresh, act };
}
