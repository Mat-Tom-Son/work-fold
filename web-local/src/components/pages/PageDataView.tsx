import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ArrowUp, Download, Filter, Loader2, Pencil, RefreshCw, Search, TableColumns, Trash2, Undo2, X } from "../chrome/icons";
import { errorText } from "../../lib/api";
import {
  defaultGridSort,
  defaultHiddenColumns,
  editedValue,
  editorText,
  entryTitle,
  filterGridEntries,
  gridColumns,
  gridEntries,
  humanizeName,
  nextSort,
  sortGridEntries,
  type GridColumn,
  type GridEntry,
  type GridSort,
} from "../../lib/page-data-grid";
import { announcePageDataChange, pageTimeAgo, saveSpreadsheet, type DeclaredTable, type PageEntriesClient, type PageEntriesSource, type PagePublication, type PageRow, type PageTableSummary } from "../../lib/pages";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import { isNewEntry, newEntryCount, type PageTablesHandle, type PageTableState } from "../../hooks/usePageTables";
import { showToast } from "../../ui/feedback";
import { pagePublishing } from "../../ui-contract";

export const testEntriesNote = "Test entries — only you can see these. They're never published.";

/** What the Online Entries label says: where the entries come from, and when work-fold last checked in. */
export function onlineEntriesNote(publication: PagePublication | null, now = Date.now()): string {
  const where = publication?.status === "unpublished" ? pagePublishing.offlineNote : pagePublishing.onlineNote;
  const when = publication?.lastCheckIn ? pageTimeAgo(publication.lastCheckIn, now) : "";
  return `${where} ${when ? pagePublishing.lastCheckedIn(when) : pagePublishing.notCheckedIn}`;
}

/**
 * Above the Data view of a page that is online (or was): which entries to
 * show, what they are, and, for online entries, when work-fold last checked
 * in, with Check Now.
 */
export function PageEntriesSourceBar({
  source,
  publication,
  checking,
  onSourceChange,
  onCheckNow,
}: {
  source: PageEntriesSource;
  publication: PagePublication | null;
  checking: boolean;
  onSourceChange: (source: PageEntriesSource) => void;
  onCheckNow: () => void;
}) {
  const ids = useId();
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: PageEntriesSource = event.key === "Home" ? "online" : event.key === "End" ? "test" : source === "online" ? "test" : "online";
    onSourceChange(next);
    document.getElementById(`${ids}-${next}`)?.focus();
  }
  return (
    <div className="page-data-source">
      <div className="page-segmented" role="radiogroup" aria-label={pagePublishing.entriesLabel}>
        <button id={`${ids}-online`} type="button" role="radio" aria-checked={source === "online"} tabIndex={source === "online" ? 0 : -1} onKeyDown={handleKeyDown} onClick={() => onSourceChange("online")}>{pagePublishing.onlineEntries}</button>
        <button id={`${ids}-test`} type="button" role="radio" aria-checked={source === "test"} tabIndex={source === "test" ? 0 : -1} onKeyDown={handleKeyDown} onClick={() => onSourceChange("test")}>{pagePublishing.testEntries}</button>
      </div>
      <p className="page-data-note" aria-live="polite">{source === "online" ? onlineEntriesNote(publication) : testEntriesNote}</p>
      {source === "online" ? (
        <button className="ui-control page-data-check-now" type="button" disabled={checking} aria-busy={checking} onClick={onCheckNow}>
          {checking ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {checking ? pagePublishing.checking : pagePublishing.checkNow}
        </button>
      ) : null}
    </div>
  );
}

const rowHeight = 32;
const overscanRows = 12;
const leadWidth = 44;

interface TableChoice {
  name: string;
  /** No longer in page.json; its entries stay. */
  retired: boolean;
  summary: PageTableSummary | null;
  columns: Record<string, string>;
}

/**
 * The Data view (docs/pages.md, "The Data view"): the page's test entries or
 * its online entries, table by table, where the owner sorts, searches,
 * filters, reads one entry, fixes a value, and deletes or restores entries.
 * Rows are windowed, so a table of a few thousand entries scrolls and filters
 * without strain.
 */
export function PageDataView({
  workFolderId,
  path,
  title,
  client,
  ready,
  tables,
  data,
  visiting,
  viewId,
  source = "test",
  sourceBar,
  onTryInPreview,
}: {
  workFolderId: string;
  path: string;
  title: string;
  client: PageEntriesClient;
  ready: boolean;
  tables: readonly DeclaredTable[];
  data: PageTablesHandle;
  /** The Data view is on screen: marks what's new and records that it was seen. */
  visiting: boolean;
  viewId: string;
  /** Which entries `client` and `data` hold. */
  source?: PageEntriesSource;
  /** Shown in place of the test-entries label once the page has online entries. */
  sourceBar?: React.ReactNode;
  onTryInPreview: () => void;
}) {
  const tableKey = `work-fold.page.data-table:${workFolderId}:${path}`;
  const [storedTable, setStoredTable] = useState<string | null>(() => readStoredJsonValue<string | null>(tableKey, (value) => typeof value === "string" ? value : null, null));
  const [markSince, setMarkSince] = useState<Record<string, string | null>>({});
  const ids = useId();
  const choices = useMemo(() => tableChoices(tables, data.summaries), [data.summaries, tables]);
  const table = choices.find((item) => item.name === storedTable) ?? choices[0] ?? null;
  const tableName = table?.name ?? null;

  function chooseTable(name: string) {
    setStoredTable(name);
    writeStoredJsonValue(tableKey, name);
  }

  function handleTablesKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const index = choices.findIndex((item) => item.name === tableName);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = choices[(next + choices.length) % choices.length];
    if (!target) return;
    chooseTable(target.name);
    document.getElementById(`${ids}-table-${target.name}`)?.focus();
  }

  const { open, markSeen } = data;
  useEffect(() => { if (ready && tableName) open(tableName); }, [open, ready, tableName]);

  // A visit starts when the Data view comes on screen: what was new then
  // stays marked until the person leaves it.
  useEffect(() => { if (!visiting) setMarkSince({}); }, [visiting]);
  const live = tableName ? data.tables[tableName]?.live ?? null : null;
  const liveRows = live?.rows;
  useEffect(() => {
    if (!visiting || !tableName || !liveRows) return;
    const lastSeen = live?.lastSeen ?? null;
    setMarkSince((current) => tableName in current ? current : { ...current, [tableName]: lastSeen });
    const timer = window.setTimeout(() => {
      void client.seen(workFolderId, path, tableName).then((seen) => markSeen(tableName, seen)).catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
    // Seen again whenever the entries change while the person is looking.
  }, [visiting, tableName, liveRows]);

  const note = sourceBar ?? <p className="page-data-note">{testEntriesNote}</p>;
  if (!ready) return <div className="page-data">{note}<p className="page-data-loading delayed-loading" role="status"><Loader2 className="spin" size={14} />Loading Entries</p></div>;

  return (
    <div className="page-data">
      {note}
      {!choices.length ? (
        <div className="page-data-empty">
          <h3>This Page Saves Nothing</h3>
          <p>A page collects entries once its page.json declares a table, such as RSVPs or sign-ups.</p>
        </div>
      ) : (
        <>
          {choices.length > 1 ? (
            <div className="page-data-tables" role="tablist" aria-label="Tables">
              {choices.map((item) => {
                const visited = item.name in markSince;
                const fresh = visited ? newEntryCount(data.tables[item.name]?.live, markSince[item.name]) : item.summary?.newCount ?? 0;
                const count = data.tables[item.name]?.live?.total ?? item.summary?.live;
                return (
                  <button key={item.name} id={`${ids}-table-${item.name}`} type="button" role="tab" aria-selected={item.name === tableName} tabIndex={item.name === tableName ? 0 : -1} title={item.retired ? `${humanizeName(item.name)} · No longer collected` : undefined} className={item.retired ? "retired" : undefined} onKeyDown={handleTablesKeyDown} onClick={() => chooseTable(item.name)}>
                    <span>{humanizeName(item.name)}</span>
                    {count !== undefined ? <span className="page-data-table-count">{count}</span> : null}
                    {fresh ? <span className="page-data-new-pill">{fresh} New</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {table ? (
            <PageTableGrid
              key={table.name}
              workFolderId={workFolderId}
              path={path}
              pageTitle={title}
              table={table}
              single={choices.length === 1}
              state={data.tables[table.name]}
              markSince={table.name in markSince ? markSince[table.name] : undefined}
              client={client}
              viewId={viewId}
              entriesSource={source}
              onOpenDeleted={() => data.open(table.name, { deleted: true })}
              onReload={() => data.reload(table.name)}
              onTryInPreview={onTryInPreview}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Declared tables in page.json's order, then any no longer collected. */
function tableChoices(declared: readonly DeclaredTable[], summaries: readonly PageTableSummary[] | null): TableChoice[] {
  const byName = new Map((summaries ?? []).map((summary) => [summary.name, summary]));
  const choices: TableChoice[] = declared.map((table) => ({ name: table.name, retired: false, summary: byName.get(table.name) ?? null, columns: table.columns }));
  for (const summary of summaries ?? []) {
    if (!declared.some((table) => table.name === summary.name)) choices.push({ name: summary.name, retired: true, summary, columns: {} });
  }
  return choices;
}

function PageTableGrid({
  workFolderId,
  path,
  pageTitle,
  table,
  single,
  state,
  markSince,
  client,
  viewId,
  entriesSource,
  onOpenDeleted,
  onReload,
  onTryInPreview,
}: {
  workFolderId: string;
  path: string;
  pageTitle: string;
  table: TableChoice;
  single: boolean;
  state: PageTableState | undefined;
  /** When this visit started marking new entries; undefined outside a visit. */
  markSince: string | null | undefined;
  client: PageEntriesClient;
  viewId: string;
  entriesSource: PageEntriesSource;
  onOpenDeleted: () => void;
  onReload: () => void;
  onTryInPreview: () => void;
}) {
  const tableName = table.name;
  const hiddenKey = `work-fold.page.data-hidden:${workFolderId}:${path}:${tableName}`;
  const [showDeleted, setShowDeleted] = useState(false);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<GridSort>(defaultGridSort);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(readStoredJsonValue<string[]>(hiddenKey, (value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [...defaultHiddenColumns], [...defaultHiddenColumns])));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ids = useId();

  const source = showDeleted ? state?.deleted : state?.live;
  const columns = useMemo(() => {
    const fromData = source?.columns.length ? source.columns : state?.live?.columns.length ? state.live.columns : Object.entries(table.columns).map(([name, type]) => ({ name, type }));
    return gridColumns(fromData, { deleted: showDeleted });
  }, [showDeleted, source?.columns, state?.live?.columns, table.columns]);
  const shownColumns = useMemo(() => columns.filter((column) => !hidden.has(column.key)), [columns, hidden]);
  const entries = useMemo(() => gridEntries(source?.rows ?? [], columns), [columns, source?.rows]);
  const shown = useMemo(() => sortGridEntries(filterGridEntries(entries, shownColumns, query, filters), columns, sort), [columns, entries, filters, query, shownColumns, sort]);
  const selected = selectedId ? entries.find((entry) => entry.row.id === selectedId) ?? null : null;
  const liveCount = state?.live?.total ?? table.summary?.live ?? 0;
  const deletedCount = state?.deleted?.total ?? table.summary?.deleted;
  const since = markSince === undefined ? state?.live?.lastSeen : markSince;
  const newCount = showDeleted ? 0 : state?.live ? newEntryCount(state.live, since) : table.summary?.newCount ?? 0;
  const activeFilters = Object.entries(filters).filter(([key, value]) => value.trim() && shownColumns.some((column) => column.key === key)).length;
  // Test entries tell the page in Preview; online entries reach visitors through work-fold checking in.
  const announce = () => { if (entriesSource === "test") announcePageDataChange({ workFolderId, page: path, table: tableName, source: viewId }); };

  // Selections only hold entries that are still here.
  useEffect(() => {
    if (selectedId && !entries.some((entry) => entry.row.id === selectedId)) setSelectedId(null);
    setChecked((current) => {
      if (!current.size) return current;
      const present = new Set(entries.map((entry) => entry.row.id));
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [entries, selectedId]);

  function toggleHidden(key: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      // At least one column always shows.
      if (columns.every((column) => next.has(column.key))) return current;
      writeStoredJsonValue(hiddenKey, [...next]);
      return next;
    });
  }

  function switchDeleted(next: boolean) {
    if (next) onOpenDeleted();
    setShowDeleted(next);
    setSelectedId(null);
    setChecked(new Set());
  }

  async function removeEntries(rowIds: string[]) {
    if (!rowIds.length || busy) return;
    setBusy(true);
    try {
      const count = await client.remove(workFolderId, path, tableName, rowIds);
      setChecked(new Set());
      if (selectedId && rowIds.includes(selectedId)) setSelectedId(null);
      onReload();
      announce();
      showToast({
        text: count === 1 ? "Entry moved to Deleted" : `${count} entries moved to Deleted`,
        tone: "success",
        actionLabel: "Undo",
        onAction: () => void restoreEntries(rowIds, true),
      });
    } catch (error) {
      showToast({ text: errorText(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function restoreEntries(rowIds: string[], quiet = false) {
    if (!rowIds.length) return;
    setBusy(true);
    try {
      const count = await client.restore(workFolderId, path, tableName, rowIds);
      setChecked(new Set());
      if (selectedId && rowIds.includes(selectedId)) setSelectedId(null);
      onReload();
      announce();
      if (!quiet) showToast({ text: count === 1 ? "Entry restored" : `${count} entries restored`, tone: "success" });
    } catch (error) {
      showToast({ text: errorText(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function saveValue(row: PageRow, column: GridColumn, raw: string): Promise<string | null> {
    try {
      await client.update(workFolderId, path, tableName, row.id, { [column.key]: editedValue(raw, column) });
      onReload();
      announce();
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  async function exportSpreadsheet() {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await client.exportCsv(workFolderId, path, tableName);
      saveSpreadsheet(blob, single ? pageTitle : `${pageTitle} - ${humanizeName(tableName)}`);
    } catch (error) {
      showToast({ text: errorText(error), tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  const checkedIds = [...checked];
  const loading = !source && (showDeleted || state?.loading !== false);
  return (
    <div className="page-data-table">
      <div className="page-data-heading">
        <p className="page-data-summary" aria-live="polite">{summaryText({ showDeleted, liveCount, deletedCount, newCount, shown: shown.length, loaded: source?.rows.length ?? 0, total: source?.total ?? 0, retired: table.retired })}</p>
      </div>
      <div className="page-data-toolbar">
        <label className="page-data-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} placeholder="Search entries" aria-label="Search entries" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button className="ui-control" type="button" aria-pressed={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}>
          <Filter size={14} aria-hidden="true" />Filters{activeFilters ? <span className="page-data-count-badge">{activeFilters}</span> : null}
        </button>
        <span className="page-data-columns-anchor">
          <button className="ui-control" type="button" aria-haspopup="true" aria-expanded={columnsOpen} aria-controls={columnsOpen ? `${ids}-columns` : undefined} onClick={() => setColumnsOpen((value) => !value)}>
            <TableColumns size={14} aria-hidden="true" />Columns
          </button>
          {columnsOpen ? <ColumnsMenu id={`${ids}-columns`} columns={columns} hidden={hidden} onToggle={toggleHidden} onClose={() => setColumnsOpen(false)} /> : null}
        </span>
        <span className="page-data-toolbar-spacer" />
        {checkedIds.length ? (
          showDeleted
            ? <button className="ui-control" type="button" disabled={busy} onClick={() => void restoreEntries(checkedIds)}><Undo2 size={14} aria-hidden="true" />Restore {checkedIds.length}</button>
            : <button className="ui-control danger" type="button" disabled={busy} onClick={() => void removeEntries(checkedIds)}><Trash2 size={14} aria-hidden="true" />Delete {checkedIds.length}</button>
        ) : null}
        <button className="ui-control" type="button" aria-pressed={showDeleted} onClick={() => switchDeleted(!showDeleted)}>
          {showDeleted ? "Back to Entries" : <>Deleted{deletedCount ? <span className="page-data-count-badge">{deletedCount}</span> : null}</>}
        </button>
        <button className="ui-control" type="button" disabled={exporting || !liveCount} aria-label="Export as Spreadsheet" title={liveCount ? "Save the entries as a CSV file" : "Nothing to export yet"} onClick={() => void exportSpreadsheet()}>
          <Download size={14} aria-hidden="true" />Export<span className="page-data-wide-label"> as Spreadsheet</span>
        </button>
      </div>
      <div className={selected ? "page-data-body has-detail" : "page-data-body"}>
        {state?.error && !source ? (
          <div className="page-data-empty" role="alert">
            <h3>Entries Couldn't Load</h3>
            <p>{state.error}</p>
            <button className="ui-control" type="button" onClick={onReload}>Try Again</button>
          </div>
        ) : loading ? (
          <p className="page-data-loading delayed-loading" role="status"><Loader2 className="spin" size={14} />Loading Entries</p>
        ) : !source?.rows.length ? (
          <div className="page-data-empty">
            {showDeleted ? (
              <><h3>Nothing Deleted</h3><p>Deleted entries wait here for 30 days, and can be restored.</p></>
            ) : table.retired ? (
              <><h3>No Entries</h3><p>This page no longer collects {humanizeName(tableName)}.</p></>
            ) : entriesSource === "online" ? (
              <><h3>{pagePublishing.noOnlineEntriesHeading}</h3><p>{pagePublishing.noOnlineEntries}</p></>
            ) : (
              <><h3>No Test Entries Yet</h3><p>Try the page in Preview; what it saves shows up here.</p><button className="ui-control" type="button" onClick={onTryInPreview}>Open Preview</button></>
            )}
          </div>
        ) : (
          <DataGrid
            label={`${humanizeName(tableName)} ${showDeleted ? "deleted entries" : "entries"}`}
            columns={shownColumns}
            entries={shown}
            totalCount={source.rows.length}
            sort={sort}
            filters={filters}
            filtersOpen={filtersOpen}
            checked={checked}
            selectedId={selectedId}
            markSince={showDeleted ? undefined : since}
            onSort={(key) => setSort((current) => nextSort(current, key))}
            onFilter={(key, value) => setFilters((current) => ({ ...current, [key]: value }))}
            onSelect={setSelectedId}
            onCheck={(rowIds, value) => setChecked((current) => {
              const next = new Set(current);
              for (const id of rowIds) if (value) next.add(id); else next.delete(id);
              return next;
            })}
          />
        )}
        {selected ? (
          <EntryDetail
            key={selected.row.id}
            entry={selected}
            columns={columns}
            deleted={showDeleted}
            busy={busy}
            onSave={saveValue}
            onDelete={() => void removeEntries([selected.row.id])}
            onRestore={() => void restoreEntries([selected.row.id])}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function summaryText({ showDeleted, liveCount, deletedCount, newCount, shown, loaded, total, retired }: { showDeleted: boolean; liveCount: number; deletedCount: number | undefined; newCount: number; shown: number; loaded: number; total: number; retired: boolean }): string {
  const entries = (count: number) => count === 1 ? "1 entry" : `${count.toLocaleString()} entries`;
  // The Data view reads at most its bound of entries, newest first.
  const capped = loaded < total ? ` (the newest ${loaded.toLocaleString()} shown)` : "";
  if (showDeleted) {
    const count = deletedCount ?? 0;
    const base = count === 1 ? "1 deleted entry" : `${count.toLocaleString()} deleted entries`;
    return `${shown !== loaded ? `Showing ${shown.toLocaleString()} of ${base}` : base}${capped} · kept for 30 days`;
  }
  const parts = [`${shown !== loaded ? `Showing ${shown.toLocaleString()} of ${entries(liveCount)}` : entries(liveCount)}${capped}`];
  if (newCount) parts.push(`${newCount.toLocaleString()} new`);
  if (retired) parts.push("no longer collected");
  return parts.join(" · ");
}

function ColumnsMenu({ id, columns, hidden, onToggle, onClose }: { id: string; columns: readonly GridColumn[]; hidden: ReadonlySet<string>; onToggle: (key: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLInputElement>("input");
    first?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => { if (!ref.current?.parentElement?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [onClose]);
  return (
    <div id={id} ref={ref} className="page-data-columns-menu" role="group" aria-label="Columns" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); (ref.current?.previousElementSibling as HTMLElement | null)?.focus(); } }}>
      {columns.map((column) => (
        <label key={column.key}>
          <input type="checkbox" checked={!hidden.has(column.key)} onChange={() => onToggle(column.key)} />
          <span>{column.label}</span>
          {column.retired ? <small>No longer collected</small> : null}
        </label>
      ))}
    </div>
  );
}

function DataGrid({
  label,
  columns,
  entries,
  totalCount,
  sort,
  filters,
  filtersOpen,
  checked,
  selectedId,
  markSince,
  onSort,
  onFilter,
  onSelect,
  onCheck,
}: {
  label: string;
  columns: readonly GridColumn[];
  entries: readonly GridEntry[];
  totalCount: number;
  sort: GridSort;
  filters: Readonly<Record<string, string>>;
  filtersOpen: boolean;
  checked: ReadonlySet<string>;
  selectedId: string | null;
  markSince: string | null | undefined;
  onSort: (key: string) => void;
  onFilter: (key: string, value: string) => void;
  onSelect: (id: string | null) => void;
  onCheck: (ids: string[], value: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const headerRows = filtersOpen ? 2 : 1;
  // Columns share the width by their usual sizes, and scroll sideways only
  // once each is down to its smallest readable width.
  const template = [`${leadWidth}px`, ...columns.map((column) => `minmax(${minimumColumnWidth(column)}px, ${column.width}fr)`)].join(" ");
  const width = leadWidth + columns.reduce((sum, column) => sum + minimumColumnWidth(column), 0);
  const first = Math.max(0, Math.floor(viewport.top / rowHeight) - overscanRows);
  const last = Math.min(entries.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscanRows);
  const visible = entries.slice(first, last);
  const allChecked = entries.length > 0 && entries.every((entry) => checked.has(entry.row.id));
  const someChecked = !allChecked && entries.some((entry) => checked.has(entry.row.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked; }, [someChecked]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport((current) => {
      const next = { top: element.scrollTop, height: element.clientHeight || current.height };
      return next.top === current.top && next.height === current.height ? current : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function scrolled() {
    const element = scrollRef.current;
    if (element) setViewport((current) => current.top === element.scrollTop ? current : { top: element.scrollTop, height: element.clientHeight || current.height });
  }

  function reveal(index: number) {
    const element = scrollRef.current;
    if (!element) return;
    const header = headerRows * rowHeight;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight - header) element.scrollTop = top + rowHeight - element.clientHeight + header;
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input, select, button")) return;
    const index = entries.findIndex((entry) => entry.row.id === selectedId);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(entries.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index < 0 ? 0 : index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "PageDown") next = Math.min(entries.length - 1, Math.max(0, index) + Math.floor(viewport.height / rowHeight) - 1);
    else if (event.key === "PageUp") next = Math.max(0, index - Math.floor(viewport.height / rowHeight) + 1);
    else if (event.key === " " && selectedId) { event.preventDefault(); onCheck([selectedId], !checked.has(selectedId)); return; }
    else if (event.key === "Escape" && selectedId) { event.preventDefault(); onSelect(null); return; }
    else return;
    event.preventDefault();
    const target = entries[next];
    if (target) { onSelect(target.row.id); reveal(next); }
  }

  return (
    <div
      ref={scrollRef}
      className="page-data-grid"
      role="grid"
      aria-label={label}
      aria-rowcount={entries.length + headerRows}
      aria-colcount={columns.length + 1}
      aria-multiselectable="true"
      tabIndex={0}
      onScroll={scrolled}
      onKeyDown={handleKeyDown}
    >
      <div className="page-data-grid-inner" style={{ width: `max(100%, ${width}px)` }}>
        <div className="page-data-grid-head" role="rowgroup">
          <div className="page-data-row page-data-header-row" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
            <div className="page-data-cell page-data-lead" role="columnheader">
              <input ref={selectAllRef} type="checkbox" aria-label={allChecked ? "Clear selection" : "Select all shown entries"} checked={allChecked} disabled={!entries.length} onChange={() => onCheck(entries.map((entry) => entry.row.id), !allChecked)} />
            </div>
            {columns.map((column) => {
              const sorted = sort?.key === column.key ? sort.direction : null;
              return (
                <div key={column.key} className={["page-data-cell", "page-data-header-cell", column.type === "number" ? "numeric" : "", column.retired ? "retired" : ""].filter(Boolean).join(" ")} role="columnheader" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}>
                  <button type="button" title={column.retired ? `${column.label} · No longer collected` : `Sort by ${column.label}`} onClick={() => onSort(column.key)}>
                    <span>{column.label}</span>
                    {sorted === "asc" ? <ArrowUp size={12} aria-hidden="true" /> : sorted === "desc" ? <ArrowDown size={12} aria-hidden="true" /> : null}
                  </button>
                </div>
              );
            })}
          </div>
          {filtersOpen ? (
            <div className="page-data-row page-data-filter-row" role="row" aria-rowindex={2} style={{ gridTemplateColumns: template }}>
              <div className="page-data-cell page-data-lead" role="gridcell" />
              {columns.map((column) => (
                <div key={column.key} className="page-data-cell" role="gridcell">
                  <ColumnFilter column={column} value={filters[column.key] ?? ""} onChange={(value) => onFilter(column.key, value)} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="page-data-grid-body" role="rowgroup" style={{ height: entries.length * rowHeight }}>
          {visible.map((entry, offset) => {
            const index = first + offset;
            const id = entry.row.id;
            const fresh = markSince !== undefined && isNewEntry(entry.row.createdAt, markSince);
            return (
              <div
                key={id}
                className={["page-data-row", id === selectedId ? "selected" : "", checked.has(id) ? "checked" : "", fresh ? "new" : ""].filter(Boolean).join(" ")}
                role="row"
                aria-rowindex={index + headerRows + 1}
                aria-selected={checked.has(id)}
                data-entry-id={id}
                style={{ gridTemplateColumns: template, transform: `translateY(${index * rowHeight}px)` }}
                onClick={() => onSelect(id === selectedId ? null : id)}
              >
                <div className="page-data-cell page-data-lead" role="gridcell">
                  {fresh ? <span className="page-data-new-dot" title="New since you last looked" aria-label="New" /> : null}
                  <input type="checkbox" aria-label={`Select ${entry.text[columns[0]?.key ?? ""] || "entry"}`} checked={checked.has(id)} onClick={(event) => event.stopPropagation()} onChange={() => onCheck([id], !checked.has(id))} />
                </div>
                {columns.map((column) => (
                  <div key={column.key} className={["page-data-cell", column.type === "number" ? "numeric" : "", column.system ? "system" : "", column.retired ? "retired" : ""].filter(Boolean).join(" ")} role="gridcell" title={entry.text[column.key] || undefined}>
                    {entry.text[column.key]}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {!entries.length && totalCount ? <p className="page-data-no-match">No entries match.</p> : null}
      </div>
    </div>
  );
}

function minimumColumnWidth(column: GridColumn): number {
  return Math.max(72, Math.round(column.width * 0.62));
}

function ColumnFilter({ column, value, onChange }: { column: GridColumn; value: string; onChange: (value: string) => void }) {
  const label = `Filter ${column.label}`;
  if (column.type === "boolean") {
    return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option><option value="(empty)">Empty</option></select>;
  }
  if (column.type === "choice" && column.options?.length) {
    return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Any</option>{column.options.map((option) => <option key={option} value={option}>{option}</option>)}<option value="(empty)">Empty</option></select>;
  }
  return <input type="text" aria-label={label} value={value} placeholder={column.type === "number" ? "e.g. > 2" : "Contains"} onChange={(event) => onChange(event.target.value)} />;
}

function EntryDetail({
  entry,
  columns,
  deleted,
  busy,
  onSave,
  onDelete,
  onRestore,
  onClose,
}: {
  entry: GridEntry;
  columns: readonly GridColumn[];
  deleted: boolean;
  busy: boolean;
  onSave: (row: PageRow, column: GridColumn, raw: string) => Promise<string | null>;
  onDelete: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const fields = columns.filter((column) => !column.system);
  const facts = columns.filter((column) => column.system && entry.text[column.key]);
  const headingId = useId();
  return (
    <aside className="page-data-detail" aria-labelledby={headingId}>
      <header>
        <h3 id={headingId} title={entryTitle(entry.row, columns)}>{entryTitle(entry.row, columns)}</h3>
        <button className="ui-control ui-control--icon" type="button" aria-label="Close Entry" title="Close Entry" onClick={onClose}><X size={16} /></button>
      </header>
      <dl className="page-data-fields">
        {fields.map((column) => (
          <EntryField key={column.key} row={entry.row} column={column} text={entry.text[column.key] ?? ""} editable={!deleted && !column.retired} onSave={onSave} />
        ))}
      </dl>
      <dl className="page-data-facts">
        {facts.map((column) => <div key={column.key}><dt>{column.label}</dt><dd>{entry.text[column.key]}</dd></div>)}
      </dl>
      <footer>
        {deleted
          ? <button className="ui-control" type="button" disabled={busy} onClick={onRestore}><Undo2 size={14} aria-hidden="true" />Restore Entry</button>
          : <button className="ui-control danger" type="button" disabled={busy} onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Delete Entry</button>}
      </footer>
    </aside>
  );
}

function EntryField({ row, column, text, editable, onSave }: { row: PageRow; column: GridColumn; text: string; editable: boolean; onSave: (row: PageRow, column: GridColumn, raw: string) => Promise<string | null> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function begin() {
    setDraft(editorText(row[column.key], column));
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    const problem = await onSave(row, column, draft);
    setSaving(false);
    if (problem) setError(problem);
    else setEditing(false);
  }

  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
    if (event.key === "Enter" && (column.type !== "long-text" || event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  };

  return (
    <div className={editing ? "page-data-field editing" : "page-data-field"}>
      <dt>
        <label htmlFor={editing ? inputId : undefined}>{column.label}</label>
        {column.retired ? <small>No longer collected</small> : null}
        {editable && !editing ? <button className="ui-control ui-control--icon page-data-edit" type="button" aria-label={`Edit ${column.label}`} title={`Edit ${column.label}`} onClick={begin}><Pencil size={14} /></button> : null}
      </dt>
      <dd>
        {editing ? (
          <div className="page-data-editor" onKeyDown={keyDown}>
            <FieldEditor id={inputId} column={column} value={draft} onChange={setDraft} invalid={Boolean(error)} />
            {error ? <p className="page-data-field-error" role="alert">{error}</p> : null}
            <div className="page-data-editor-actions">
              <button className="ui-control ui-control--primary" type="button" disabled={saving} onClick={() => void save()}>Save</button>
              <button className="ui-control" type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : text ? <span className="page-data-value">{text}</span> : <span className="page-data-value empty">Empty</span>}
      </dd>
    </div>
  );
}

function FieldEditor({ id, column, value, invalid, onChange }: { id: string; column: GridColumn; value: string; invalid: boolean; onChange: (value: string) => void }) {
  const common = { id, "aria-invalid": invalid || undefined, autoFocus: true } as const;
  if (column.type === "long-text") return <textarea {...common} rows={4} value={value} onChange={(event) => onChange(event.target.value)} />;
  if (column.type === "boolean") return <select {...common} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Empty</option><option value="yes">Yes</option><option value="no">No</option></select>;
  if (column.type === "choice" && column.options?.length) {
    return <select {...common} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Empty</option>{column.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
  }
  const type = column.type === "number" ? "number" : column.type === "email" ? "email" : column.type === "url" ? "url" : "text";
  return <input {...common} type={type} step={column.type === "number" ? (column.integer ? 1 : "any") : undefined} placeholder={column.type === "date" ? "YYYY-MM-DD" : undefined} value={value} onChange={(event) => onChange(event.target.value)} />;
}
