import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { ChecksDecorations, ChecksStatus, SpaceSummary } from "../types";

export function useSpaceChecks(space: SpaceSummary, fixtureMode = false, autoRefresh = true) {
  const [status, setStatus] = useState<ChecksStatus | null>(null);
  const [attentionPaths, setAttentionPaths] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(!fixtureMode);
  const [unavailable, setUnavailable] = useState(false);
  const requestRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const suspendedRef = useRef(false);
  const scopeKey = `${fixtureMode ? "fixture" : "live"}:${space.id}`;
  const scopeKeyRef = useRef(scopeKey);

  const refresh = useCallback((): Promise<void> => {
    if (suspendedRef.current) return Promise.resolve();
    if (fixtureMode) {
      setStatus(null);
      setAttentionPaths(new Set());
      setLoading(false);
      setUnavailable(false);
      return Promise.resolve();
    }
    if (inFlightRef.current) return inFlightRef.current;
    const request = ++requestRef.current;
    const spaceId = space.id;
    const operation = (async () => {
      try {
        const response = await api<{ status: ChecksStatus }>(
          `/api/spaces/${encodeURIComponent(spaceId)}/checks/status`,
        );
        if (request !== requestRef.current) return;
        setStatus(response.status);
        setUnavailable(false);
        if (response.status.needsAttention < 1) {
          setAttentionPaths(new Set());
          return;
        }
        try {
          const decorations = await api<{ decorations: ChecksDecorations }>(
            `/api/spaces/${encodeURIComponent(spaceId)}/checks/decorations`,
          );
          if (request !== requestRef.current) return;
          setAttentionPaths(new Set(decorations.decorations.items.map((item) => item.path)));
        } catch {
          if (request === requestRef.current) setAttentionPaths(new Set());
        }
      } catch {
        if (request !== requestRef.current) return;
        setUnavailable(true);
        setAttentionPaths(new Set());
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    })().finally(() => {
      if (inFlightRef.current === operation) inFlightRef.current = null;
    });
    inFlightRef.current = operation;
    return operation;
  }, [fixtureMode, space.id]);

  const suspend = useCallback(async (): Promise<void> => {
    suspendedRef.current = true;
    requestRef.current += 1;
    await inFlightRef.current;
  }, []);

  const resume = useCallback((): Promise<void> => {
    suspendedRef.current = false;
    return refresh();
  }, [refresh]);

  useEffect(() => {
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey;
      suspendedRef.current = false;
      requestRef.current += 1;
      inFlightRef.current = null;
      setStatus(null);
      setAttentionPaths(new Set());
      setLoading(!fixtureMode);
      setUnavailable(false);
    }
    if (autoRefresh && !suspendedRef.current) void refresh();
  }, [autoRefresh, refresh, scopeKey]);

  useEffect(() => {
    if (!autoRefresh || unavailable || !status?.running) return;
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh, status?.running, unavailable]);

  useEffect(() => {
    if (!autoRefresh || fixtureMode) return;
    const refreshOnReturn = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [autoRefresh, fixtureMode, refresh]);

  return { status, attentionPaths, loading, unavailable, refresh, suspend, resume };
}
