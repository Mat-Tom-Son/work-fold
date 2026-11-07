import { useCallback, useEffect, useRef, useState } from "react";

import { errorText } from "../lib/api";
import { subscribePageDataChanges, type PageEntriesClient, type PageTableData, type PageTableSummary } from "../lib/pages";

export interface PageTableState {
  live: PageTableData | null;
  deleted: PageTableData | null;
  loading: boolean;
  error: string | null;
}

export interface PageTablesHandle {
  /** Every stored table with its counts, or null until first read. */
  summaries: PageTableSummary[] | null;
  /** Entries of the tables the Data view opened. */
  tables: Record<string, PageTableState>;
  /** Opens a table's entries (and its Deleted list when asked); later changes keep it fresh. */
  open: (table: string, options?: { deleted?: boolean }) => void;
  reload: (table: string) => void;
  /** After the person looked: nothing in the table is new any more. */
  markSeen: (table: string, lastSeen: string | null) => void;
}

const emptyTable: PageTableState = { live: null, deleted: null, loading: false, error: null };

/**
 * A page's entries from Preview (docs/pages.md, "The Data view"). The table list and
 * its counts load once the tab is shown, for the Data view's "new" count; a
 * table's entries load when the Data view opens it, and its Deleted list only
 * when asked for. Both reload when the page's files change, or when a page
 * call or a Data view edit changes a table.
 */
export function usePageTables({
  client,
  workFolderId,
  path,
  enabled,
  revision,
  viewId,
}: {
  client: PageEntriesClient;
  workFolderId: string;
  path: string;
  enabled: boolean;
  revision: number;
  /** The Data view's own id: its own edits reload where they're made. */
  viewId: string;
}): PageTablesHandle {
  const [summaries, setSummaries] = useState<PageTableSummary[] | null>(null);
  const [tables, setTables] = useState<Record<string, PageTableState>>({});
  const summaryGenerationRef = useRef(0);
  const tableGenerationRef = useRef(new Map<string, number>());
  const openedRef = useRef(new Map<string, { deleted: boolean }>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const staleRef = useRef(true);
  const loadedKeyRef = useRef<string | null>(null);

  const loadSummaries = useCallback(() => {
    const generation = ++summaryGenerationRef.current;
    void client.tables(workFolderId, path).then((next) => {
      if (generation === summaryGenerationRef.current) setSummaries(next);
    }, () => {
      // An older local API without the table list: the Data view falls back
      // to the tables page.json declares.
      if (generation === summaryGenerationRef.current) setSummaries((current) => current ?? []);
    });
  }, [client, path, workFolderId]);

  const loadTable = useCallback((table: string) => {
    const wanted = openedRef.current.get(table);
    if (!wanted) return;
    const generation = (tableGenerationRef.current.get(table) ?? 0) + 1;
    tableGenerationRef.current.set(table, generation);
    setTables((current) => ({ ...current, [table]: { ...(current[table] ?? emptyTable), loading: true } }));
    void Promise.all([
      client.data(workFolderId, path, table, false),
      wanted.deleted ? client.data(workFolderId, path, table, true) : Promise.resolve(null),
    ]).then(([live, deleted]) => {
      if (tableGenerationRef.current.get(table) !== generation) return;
      setTables((current) => ({ ...current, [table]: { live, deleted: deleted ?? current[table]?.deleted ?? null, loading: false, error: null } }));
    }, (error: unknown) => {
      if (tableGenerationRef.current.get(table) !== generation) return;
      setTables((current) => ({ ...current, [table]: { ...(current[table] ?? emptyTable), loading: false, error: errorText(error) } }));
    });
  }, [client, path, workFolderId]);

  const refreshAll = useCallback(() => {
    loadSummaries();
    for (const table of openedRef.current.keys()) loadTable(table);
  }, [loadSummaries, loadTable]);

  // First showing, and again after the page's files changed.
  useEffect(() => {
    const key = `${workFolderId}\n${path}\n${revision}`;
    if (loadedKeyRef.current !== key) { loadedKeyRef.current = key; staleRef.current = true; }
    if (!enabled || !staleRef.current) return;
    staleRef.current = false;
    refreshAll();
  }, [enabled, path, refreshAll, revision, workFolderId]);

  const pendingRef = useRef(new Set<string | null>());
  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribePageDataChanges((change) => {
      if (change.workFolderId !== workFolderId || change.page !== path || change.source === viewId) return;
      pendingRef.current.add(change.table);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const due = [...pendingRef.current];
        pendingRef.current.clear();
        // Heard while hidden: read again when the tab is next shown.
        if (!enabledRef.current) { staleRef.current = true; return; }
        loadSummaries();
        for (const table of openedRef.current.keys()) if (due.includes(null) || due.includes(table)) loadTable(table);
      }, 150);
    });
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [loadSummaries, loadTable, path, viewId, workFolderId]);

  const open = useCallback((table: string, options: { deleted?: boolean } = {}) => {
    const current = openedRef.current.get(table);
    const deleted = Boolean(current?.deleted || options.deleted);
    if (current && current.deleted === deleted) return;
    openedRef.current.set(table, { deleted });
    loadTable(table);
  }, [loadTable]);

  const reload = useCallback((table: string) => {
    loadSummaries();
    loadTable(table);
  }, [loadSummaries, loadTable]);

  const markSeen = useCallback((table: string, lastSeen: string | null) => {
    setSummaries((current) => current?.map((summary) => summary.name === table ? { ...summary, lastSeen, newCount: 0 } : summary) ?? current);
    setTables((current) => {
      const state = current[table];
      return state?.live ? { ...current, [table]: { ...state, live: { ...state.live, lastSeen } } } : current;
    });
  }, []);

  return { summaries, tables, open, reload, markSeen };
}

/** Entries added after `since`; when the table was never looked at, every entry is new. */
export function newEntryCount(data: PageTableData | null | undefined, since: string | null | undefined): number {
  if (!data) return 0;
  let count = 0;
  for (const row of data.rows) if (isNewEntry(row.createdAt, since)) count++;
  return count;
}

export function isNewEntry(createdAt: unknown, since: string | null | undefined): boolean {
  if (since === undefined) return false;
  if (since === null) return true;
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const seen = Date.parse(since);
  return Number.isFinite(created) && Number.isFinite(seen) && created > seen;
}
