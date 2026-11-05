import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AlertTriangle, Loader2, PageIcon, RefreshCw } from "../chrome/icons";
import { ApiError, errorText } from "../../lib/api";
import {
  announcePageDataChange,
  declaredTables,
  pageFrameUrl,
  pageProblemsBySeverity,
  pagesClient,
  pageTitle,
  runtimeColumnTypes,
  subscribePageDataChanges,
  type PageDocument,
  type PageInspection,
  type PageProblem,
  type PagesClient,
  type PageViewer,
  type PageViewerRole,
} from "../../lib/pages";
import { mountPageFrame, openPageLink, type PageFrameFailure } from "../../lib/page-frame-host";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import { changeTouchesFolder, subscribeWorkFolderFileChanges, type WorkFolderFileChange } from "../../lib/work-folder-file-events";
import { usePageTables } from "../../hooks/usePageTables";
import { PageDataView } from "./PageDataView";
import type { WorkFolderSummary } from "../../types";

export type PageTabView = "preview" | "data";

/**
 * A page tab (docs/pages.md, "Preview and test entries"): the page running in
 * its sandbox, and the test entries it collected. Bound to its work-folder
 * like every other tab; `path` is the page folder's work-folder-relative path.
 */
export function PageTab({
  workFolder,
  path,
  title,
  view,
  active,
  fixtureMode = false,
  client: givenClient,
  onViewChange,
  onTitleChange,
}: {
  workFolder: WorkFolderSummary;
  path: string;
  title: string;
  view: PageTabView;
  active: boolean;
  fixtureMode?: boolean;
  /** Tests pass their own; the app reads the local API (or the browser preview's fixture). */
  client?: PagesClient;
  onViewChange: (view: PageTabView) => void;
  onTitleChange: (title: string) => void;
}) {
  const client = givenClient ?? pagesClient(fixtureMode);
  const [inspection, setInspection] = useState<PageInspection | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dataOpened, setDataOpened] = useState(view === "data");
  const ids = useId();
  const previewViewId = `${ids}-preview`;
  const dataViewId = `${ids}-data`;
  const titleRef = useRef({ title, onTitleChange });
  titleRef.current = { title, onTitleChange };
  const activeRef = useRef(active);
  activeRef.current = active;
  const staleRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    client.inspect(workFolder.id, path).then((result) => {
      if (cancelled) return;
      setInspection(result);
      setStatus("ready");
      setLoadError(null);
      const next = pageTitle(result, path);
      if (next !== titleRef.current.title) titleRef.current.onTitleChange(next);
    }, (error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 404) setStatus("missing");
      else { setStatus("error"); setLoadError(errorText(error)); }
    });
    return () => { cancelled = true; };
  }, [client, path, revision, workFolder.id]);

  // Edits to the page's files show up on reload: a hidden tab reloads when shown.
  useEffect(() => {
    if (fixtureMode) return;
    let timer: number | null = null;
    const unsubscribe = subscribeWorkFolderFileChanges(workFolder.id, (change) => {
      if (!pageFileChange(change, path)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (activeRef.current) setRevision((value) => value + 1);
        else staleRef.current = true;
      }, 400);
    });
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [fixtureMode, path, workFolder.id]);
  useEffect(() => {
    if (!active || !staleRef.current) return;
    staleRef.current = false;
    setRevision((value) => value + 1);
  }, [active]);

  useEffect(() => { if (view === "data") setDataOpened(true); }, [view]);

  const tables = useMemo(() => declaredTables(inspection), [inspection]);
  const data = usePageTables({ client, workFolderId: workFolder.id, path, enabled: active && status === "ready", revision, viewId: dataViewId });
  const newCount = (data.summaries ?? []).reduce((sum, table) => sum + table.newCount, 0);
  // A page that saves nothing has no Data view. Tables that were removed from
  // page.json but still hold test entries keep it.
  const hasData = tables.length > 0 || (data.summaries ?? []).length > 0;
  const dataKnown = status === "ready" && data.summaries !== undefined && data.summaries !== null;
  useEffect(() => { if (dataKnown && !hasData && view === "data") onViewChange("preview"); }, [dataKnown, hasData, view, onViewChange]);

  const shownTitle = inspection ? pageTitle(inspection, path) : title;
  const selectView = (next: PageTabView) => { if (next !== view) onViewChange(next); };
  function handleViewKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: PageTabView = event.key === "Home" ? "preview" : event.key === "End" ? "data" : view === "preview" ? "data" : "preview";
    selectView(next);
    document.getElementById(`${ids}-${next}-tab`)?.focus();
  }

  return (
    <section className="page-tab" aria-label={`Page: ${shownTitle}`}>
      <header className="page-tab-header">
        <div className="page-tab-identity">
          <span className="page-tab-icon" aria-hidden="true"><PageIcon size={20} /></span>
          <div className="page-tab-title">
            <h2 title={shownTitle}>{shownTitle}</h2>
            <p title={path}>{path === shownTitle ? "Page" : path}</p>
          </div>
        </div>
        {hasData ? (
          <div className="page-tab-views" role="tablist" aria-label="Page View">
            <button id={`${ids}-preview-tab`} type="button" role="tab" aria-selected={view === "preview"} aria-controls={`${ids}-preview-panel`} tabIndex={view === "preview" ? 0 : -1} onKeyDown={handleViewKeyDown} onClick={() => selectView("preview")}>Preview</button>
            <button id={`${ids}-data-tab`} type="button" role="tab" aria-selected={view === "data"} aria-controls={`${ids}-data-panel`} tabIndex={view === "data" ? 0 : -1} onKeyDown={handleViewKeyDown} onClick={() => selectView("data")}>
              Data{newCount > 0 && view !== "data" ? <span className="page-tab-new-count" aria-label={`, ${newCount} new`}>{newCount}</span> : null}
            </button>
          </div>
        ) : null}
      </header>
      {status === "missing" ? (
        <div className="page-tab-state" role="status">
          <h3>This Page Isn't Here</h3>
          <p>The folder moved, or it no longer has a page.json file.</p>
        </div>
      ) : status === "error" ? (
        <div className="page-tab-state" role="alert">
          <h3>This Page Couldn't Open</h3>
          <p>{loadError}</p>
          <button className="ui-control" type="button" onClick={() => setRevision((value) => value + 1)}>Try Again</button>
        </div>
      ) : (
        <>
          <div id={`${ids}-preview-panel`} className="page-tab-panel" role={hasData ? "tabpanel" : undefined} aria-labelledby={hasData ? `${ids}-preview-tab` : undefined} hidden={hasData && view !== "preview"}>
            <PagePreview
              workFolderId={workFolder.id}
              path={path}
              title={shownTitle}
              client={client}
              inspection={status === "ready" ? inspection : null}
              viewId={previewViewId}
              onReload={() => setRevision((value) => value + 1)}
            />
          </div>
          <div id={`${ids}-data-panel`} className="page-tab-panel" role="tabpanel" aria-labelledby={`${ids}-data-tab`} hidden={!hasData || view !== "data"}>
            {dataOpened ? (
              <PageDataView
                workFolderId={workFolder.id}
                path={path}
                title={shownTitle}
                client={client}
                ready={status === "ready"}
                tables={tables}
                data={data}
                visiting={active && view === "data"}
                viewId={dataViewId}
                onTryInPreview={() => selectView("preview")}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** Changes that can alter what the page shows: its own files, not hidden ones or real visitors' data. */
export function pageFileChange(change: WorkFolderFileChange, path: string): boolean {
  if (!changeTouchesFolder(change, path)) return false;
  if (change.path === null || !change.path.startsWith(`${path}/`)) return true;
  const inside = change.path.slice(path.length + 1).split("/");
  if (inside.some((part) => part.startsWith("."))) return false;
  return !(inside.length === 1 && /^data\.sqlite(?:-journal|-wal|-shm)?$/i.test(inside[0]!));
}

type FrameState = "starting" | "running" | PageFrameFailure;

function PagePreview({
  workFolderId,
  path,
  title,
  client,
  inspection,
  viewId,
  onReload,
}: {
  workFolderId: string;
  path: string;
  title: string;
  client: PagesClient;
  /** Read again whenever the page's files change; each reading reloads the page. */
  inspection: PageInspection | null;
  viewId: string;
  onReload: () => void;
}) {
  const roleKey = `work-fold.page.viewing-as:${workFolderId}:${path}`;
  const [role, setRole] = useState<PageViewerRole>(() => readStoredJsonValue<PageViewerRole>(roleKey, (value) => value === "owner" ? "owner" : "visitor", "visitor"));
  const [visitor, setVisitor] = useState<string | null>(null);
  const [documentState, setDocumentState] = useState<{ document: PageDocument; viewer: PageViewer; key: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<FrameState>("starting");
  const [changingVisitor, setChangingVisitor] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [reloads, setReloads] = useState(0);
  const loadKeyRef = useRef(0);
  const visitorRef = useRef(visitor);
  visitorRef.current = visitor;
  const labelId = useId();

  useEffect(() => {
    if (!inspection) return;
    let cancelled = false;
    const key = ++loadKeyRef.current;
    setLoading(true);
    setFailure(null);
    void Promise.all([
      client.document(workFolderId, path),
      role === "visitor" && !visitorRef.current ? client.visitor(workFolderId, path, false) : Promise.resolve(visitorRef.current),
    ]).then(([document, currentVisitor]) => {
      if (cancelled || key !== loadKeyRef.current) return;
      if (role === "visitor" && !currentVisitor) throw new Error("The preview visitor couldn't be set up. Reload to try again.");
      if (currentVisitor !== visitorRef.current) setVisitor(currentVisitor);
      setFrameState("starting");
      setDocumentState({ document, viewer: role === "visitor" && currentVisitor ? { role: "visitor", visitor: currentVisitor } : { role: "owner" }, key });
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled || key !== loadKeyRef.current) return;
      setFailure(errorText(error));
      setLoading(false);
    });
    return () => { cancelled = true; };
    // The page is read with page.json, so a page and its tables always match.
    // `visitor` itself is read through its ref: a new visitor reloads through `reloads`.
  }, [client, inspection, path, reloads, role, workFolderId]);

  function chooseRole(next: PageViewerRole) {
    if (next === role) return;
    setRole(next);
    writeStoredJsonValue(roleKey, next);
  }

  async function newVisitor() {
    if (changingVisitor) return;
    setChangingVisitor(true);
    try {
      const fresh = await client.visitor(workFolderId, path, true);
      visitorRef.current = fresh;
      setVisitor(fresh);
      if (role !== "visitor") { setRole("visitor"); writeStoredJsonValue(roleKey, "visitor"); }
      else setReloads((value) => value + 1);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setChangingVisitor(false);
    }
  }

  const problems = documentState?.document.problems.length ? documentState.document.problems : inspection?.problems ?? [];
  const { errors, warnings } = pageProblemsBySeverity(problems);
  const blocked = Boolean(documentState && documentState.document.html === null);
  const tables = useMemo(() => runtimeColumnTypes(inspection), [inspection]);

  return (
    <div className="page-preview">
      <div className="page-preview-bar">
        <span className="page-preview-label" id={labelId}>Viewing As</span>
        <div className="page-segmented" role="radiogroup" aria-labelledby={labelId}>
          <button type="button" role="radio" aria-checked={role === "visitor"} onClick={() => chooseRole("visitor")}>Visitor</button>
          <button type="button" role="radio" aria-checked={role === "owner"} onClick={() => chooseRole("owner")}>Owner</button>
        </div>
        <button className="ui-control page-preview-new-visitor" type="button" disabled={changingVisitor} title="See the page as someone who hasn't been here before" onClick={() => void newVisitor()}>New Visitor</button>
        <span className="page-preview-spacer" />
        {warnings.length && !blocked ? (
          <button className="ui-control ui-control--quiet page-preview-notes-toggle" type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen((value) => !value)}>
            {warnings.length === 1 ? "1 Note" : `${warnings.length} Notes`}
          </button>
        ) : null}
        <button className="ui-control ui-control--icon" type="button" aria-label="Reload Page" title="Reload Page" onClick={onReload}>
          <RefreshCw size={16} />
        </button>
      </div>
      {notesOpen && warnings.length && !blocked ? <PageProblemList className="page-preview-notes" problems={warnings} /> : null}
      <div className="page-preview-stage">
        {failure ? (
          <div className="page-preview-state" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <h3>The Page Couldn't Load</h3>
            <p>{failure}</p>
            <button className="ui-control" type="button" onClick={() => setReloads((value) => value + 1)}>Try Again</button>
          </div>
        ) : blocked ? (
          <div className="page-problems" role="alert">
            <h3>This Page Has Problems</h3>
            <p>Fix these in the page's files and it reloads by itself.</p>
            <PageProblemList problems={errors.length ? errors : problems} />
          </div>
        ) : documentState && documentState.document.html !== null ? (
          <>
            <PageFrame
              key={documentState.key}
              workFolderId={workFolderId}
              path={path}
              title={title}
              html={documentState.document.html}
              viewer={documentState.viewer}
              tables={tables}
              client={client}
              viewId={viewId}
              onState={setFrameState}
            />
            {frameState === "starting" ? <p className="page-preview-opening delayed-loading" role="status"><Loader2 className="spin" size={14} />Opening Page</p> : null}
            {frameState === "timeout" || frameState === "navigated" ? (
              <div className="page-preview-state page-preview-overlay" role="alert">
                <h3>{frameState === "timeout" ? "The Page Didn't Start" : "The Page Tried to Leave"}</h3>
                <p>{frameState === "timeout"
                  ? "Reload to try again."
                  : "A page stays on one screen; its web links open in your browser. Reload to show it again."}</p>
                <button className="ui-control" type="button" onClick={() => setReloads((value) => value + 1)}>Reload Page</button>
              </div>
            ) : null}
          </>
        ) : loading ? <p className="page-preview-opening delayed-loading" role="status"><Loader2 className="spin" size={14} />Opening Page</p> : null}
      </div>
    </div>
  );
}

function PageProblemList({ problems, className }: { problems: readonly PageProblem[]; className?: string }) {
  const shown = problems.slice(0, 12);
  return (
    <ul className={["page-problem-list", className].filter(Boolean).join(" ")}>
      {shown.map((problem, index) => (
        <li key={`${problem.file ?? ""}:${index}`}>
          {problem.file ? <code>{problem.file}</code> : null}
          <span>{problem.message}</span>
        </li>
      ))}
      {problems.length > shown.length ? <li className="page-problem-more">{problems.length - shown.length} more</li> : null}
    </ul>
  );
}

function PageFrame({
  workFolderId,
  path,
  title,
  html,
  viewer,
  tables,
  client,
  viewId,
  onState,
}: {
  workFolderId: string;
  path: string;
  title: string;
  html: string;
  viewer: PageViewer;
  tables: Record<string, Record<string, string>>;
  client: PagesClient;
  viewId: string;
  onState: (state: FrameState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  // One frame per load (the parent keys it): what it needs is fixed when it mounts.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = mountPageFrame({
      container,
      frameUrl: pageFrameUrl(),
      title,
      html,
      owner: viewer.role === "owner",
      tables,
      call: (call) => client.call(workFolderId, path, viewer, call),
      openLink: openPageLink,
      onLoaded: () => onStateRef.current("running"),
      onFailed: (reason) => onStateRef.current(reason),
      onMutated: (table) => announcePageDataChange({ workFolderId, page: path, table, source: viewId }),
    });
    const unsubscribe = subscribePageDataChanges((change) => {
      if (change.workFolderId === workFolderId && change.page === path && change.source !== viewId) handle.notifyChanged(change.table);
    });
    return () => { unsubscribe(); handle.destroy(); };
  }, []);
  return <div ref={containerRef} className="page-preview-canvas" />;
}
