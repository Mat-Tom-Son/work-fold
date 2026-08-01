import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { ChecksDecorations, ChecksStatus, WorkspaceSummary } from "../types";

export function useWorkspaceChecks(workspace: WorkspaceSummary, fixtureMode = false, autoRefresh = true) {
  const [status, setStatus] = useState<ChecksStatus | null>(null);
  const [attentionPaths, setAttentionPaths] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(!fixtureMode);
  const requestRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const scopeKey = `${fixtureMode ? "fixture" : "live"}:${workspace.id}`;
  const scopeKeyRef = useRef(scopeKey);

  const refresh = useCallback((): Promise<void> => {
    if (fixtureMode) {
      setStatus(null);
      setAttentionPaths(new Set());
      setLoading(false);
      return Promise.resolve();
    }
    if (inFlightRef.current) return inFlightRef.current;
    const request = ++requestRef.current;
    const workspaceId = workspace.id;
    const operation = (async () => {
      try {
        const response = await api<{ status: ChecksStatus }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/checks/status`,
        );
        if (request !== requestRef.current) return;
        setStatus(response.status);
        if (response.status.needsAttention < 1) {
          setAttentionPaths(new Set());
          return;
        }
        try {
          const decorations = await api<{ decorations: ChecksDecorations }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/checks/decorations`,
          );
          if (request !== requestRef.current) return;
          setAttentionPaths(new Set(decorations.decorations.items.map((item) => item.path)));
        } catch {
          if (request === requestRef.current) setAttentionPaths(new Set());
        }
      } catch {
        if (request !== requestRef.current) return;
        setStatus(null);
        setAttentionPaths(new Set());
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    })().finally(() => {
      if (inFlightRef.current === operation) inFlightRef.current = null;
    });
    inFlightRef.current = operation;
    return operation;
  }, [fixtureMode, workspace.id]);

  useEffect(() => {
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey;
      requestRef.current += 1;
      inFlightRef.current = null;
      setStatus(null);
      setAttentionPaths(new Set());
      setLoading(!fixtureMode);
    }
    if (autoRefresh) void refresh();
  }, [autoRefresh, refresh, scopeKey]);

  useEffect(() => {
    if (!autoRefresh || !status?.running) return;
    const timer = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh, status?.running]);

  return { status, attentionPaths, loading, refresh };
}
