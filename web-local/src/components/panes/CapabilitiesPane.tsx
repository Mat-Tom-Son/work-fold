import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Add16Regular,
  ArrowSync16Regular,
  ArrowUpload16Regular,
  BookToolbox20Regular,
  Box16Regular,
  Code16Regular,
  Delete16Regular,
  Dismiss20Regular,
  Info20Regular,
  PlugConnected20Regular,
  Search20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";

import { api, apiForm, errorText, safeExternalHref } from "../../lib/api";
import { useModalDialog } from "../../hooks/useModalDialog";
import { createWorkspaceOperationGate, type WorkspaceOperationToken } from "../../lib/workspace-operation-gate";
import { RestrictedAppsSection } from "./RestrictedAppsSection";
import type {
  AgentCatalog,
  AgentCapabilityOrigin,
  AgentCapabilityScope,
  AgentCapabilitySource,
  AgentCapabilityStatus,
  AgentDiagnostic,
  AgentExtension,
  AgentPackage,
  AgentSkill,
  AgentStatus,
  AgentTool,
  AgentToolManagement,
  AssistantToolsView,
  CapabilityDiscoverItem,
  CapabilityDiscoverDetailsItem,
  CapabilityDiscoverDetailsResponse,
  CapabilityDiscoverResponse,
  RestrictedAppInstalled,
  WorkspaceSummary,
} from "../../types";
import { requestConfirm, showToast } from "../../ui/feedback";

type CapabilityTypeFilter = "all" | "app" | "skill" | "extension";
type CapabilityScopeFilter = "all" | AgentCapabilityScope;
type InstalledSort = "name" | "type" | "scope" | "source";
type DiscoverSort = "official" | "downloads" | "recent" | "name";

interface InstalledCapability {
  id: string;
  kind: "skill" | "extension";
  name: string;
  description: string;
  path: string;
  scope: AgentCapabilityScope;
  origin: AgentCapabilityOrigin;
  source: string;
  enabled: boolean;
  loaded: boolean;
  status: AgentCapabilityStatus;
  diagnostics: AgentDiagnostic[];
  content?: string;
  disableModelInvocation?: boolean;
  tools: string[];
  commands: string[];
  flags: string[];
}

type PendingInstall = {
  kind: "skill-files";
  files: File[];
  scope: AgentCapabilityScope;
} | {
  kind: "package";
  source: string;
  scope: AgentCapabilityScope;
  item?: CapabilityDiscoverItem;
} | {
  kind: "catalog";
  scope: AgentCapabilityScope;
  item: CapabilityDiscoverDetailsItem;
};

export function CapabilitiesPane({
  workspace,
  status,
  view,
  fixtureMode = false,
  restrictedApps,
  restrictedAppsLoading = false,
  onOpenSettings,
  onError,
  onCatalogChanged,
  onRestrictedAppChanged,
  onRestrictedAppRemoved,
  onBuildApp,
  onOpenAppStudio,
  onViewChange,
}: {
  workspace: WorkspaceSummary;
  status: AgentStatus;
  view: AssistantToolsView;
  fixtureMode?: boolean;
  restrictedApps: RestrictedAppInstalled[];
  restrictedAppsLoading?: boolean;
  onOpenSettings: () => void;
  onError: (message: string | null) => void;
  onCatalogChanged?: (catalog: AgentCatalog) => void;
  onRestrictedAppChanged: (app: RestrictedAppInstalled) => void;
  onRestrictedAppRemoved: (appId: string) => void;
  onBuildApp: () => void;
  onOpenAppStudio: (workspaceId?: string) => void;
  onViewChange: (view: AssistantToolsView) => void;
}) {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<CapabilityTypeFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<CapabilityScopeFilter>("all");
  const [installScope, setInstallScope] = useState<AgentCapabilityScope>("global");
  const [installedSort, setInstalledSort] = useState<InstalledSort>("name");
  const [discoverSort, setDiscoverSort] = useState<DiscoverSort>("official");
  const [packageSource, setPackageSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<InstalledCapability | null>(null);
  const [discoverItems, setDiscoverItems] = useState<CapabilityDiscoverItem[]>([]);
  const [discoverTotal, setDiscoverTotal] = useState(0);
  const [discoverCatalogUrl, setDiscoverCatalogUrl] = useState("");
  const [discoverDiagnostics, setDiscoverDiagnostics] = useState<string[]>([]);
  const [discoverTruncated, setDiscoverTruncated] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [reviewingItemId, setReviewingItemId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const installedViewRef = useRef<HTMLElement>(null);
  const discoverViewRef = useRef<HTMLElement>(null);
  const catalogRequestRef = useRef(0);
  const discoverRequestRef = useRef(0);
  const operationGateRef = useRef(createWorkspaceOperationGate(workspace.id));
  operationGateRef.current.activate(workspace.id);

  useEffect(() => {
    setCatalog(null);
    setInstallScope("global");
    setScopeFilter("all");
    setQuery("");
    setAddOpen(false);
    setPendingInstall(null);
    setSelectedCapability(null);
    setBusy(false);
    setPackageBusy(null);
    setReviewingItemId(null);
    void loadCatalog(operationGateRef.current.capture());
  }, [fixtureMode, workspace.id]);

  useEffect(() => {
    if (view !== "discover") return;
    const timer = window.setTimeout(() => void loadDiscover(true), 220);
    return () => window.clearTimeout(timer);
  }, [view, query, typeFilter, discoverSort, fixtureMode]);

  async function loadCatalog(operation: WorkspaceOperationToken = operationGateRef.current.capture()) {
    const requestId = ++catalogRequestRef.current;
    if (fixtureMode) {
      if (operationGateRef.current.isCurrent(operation)) {
        const next = fixtureCatalog();
        setCatalog(next);
      }
      return;
    }
    try {
      const next = await api<AgentCatalog>(`/api/workspaces/${operation.workspaceId}/agent/catalog`);
      if (catalogRequestRef.current === requestId && operationGateRef.current.isCurrent(operation)) {
        setCatalog(next);
        onCatalogChanged?.(next);
      }
    } catch (caught) {
      if (catalogRequestRef.current === requestId && operationGateRef.current.isCurrent(operation)) onError(errorText(caught));
    }
  }

  async function loadDiscover(reset: boolean) {
    const requestId = ++discoverRequestRef.current;
    const offset = reset ? 0 : discoverItems.length;
    setDiscoverLoading(true);
    setDiscoverError(null);
    if (fixtureMode) {
      const response = fixtureDiscover(query, typeFilter, discoverSort, offset);
      setDiscoverItems((current) => reset ? response.items : [...current, ...response.items]);
      setDiscoverTotal(response.total);
      setDiscoverCatalogUrl(response.catalogUrl);
      setDiscoverDiagnostics(response.diagnostics ?? []);
      setDiscoverTruncated(Boolean(response.truncated));
      setDiscoverLoading(false);
      return;
    }
    const params = new URLSearchParams({
      query: query.trim(),
      type: typeFilter,
      sort: discoverSort,
      offset: String(offset),
      limit: "24",
    });
    try {
      const response = await api<CapabilityDiscoverResponse>(`/api/agent/capabilities/discover?${params}`);
      if (discoverRequestRef.current !== requestId) return;
      setDiscoverItems((current) => reset ? response.items : [...current, ...response.items]);
      setDiscoverTotal(response.total);
      setDiscoverCatalogUrl(response.catalogUrl);
      setDiscoverDiagnostics(response.diagnostics ?? []);
      setDiscoverTruncated(Boolean(response.truncated));
    } catch (caught) {
      if (discoverRequestRef.current === requestId) setDiscoverError(errorText(caught));
    } finally {
      if (discoverRequestRef.current === requestId) setDiscoverLoading(false);
    }
  }

  const resources = useMemo(() => catalog ? normalizedCapabilities(catalog) : [], [catalog]);
  const visibleResources = useMemo(
    () => filterAndSortCapabilities(resources, query, typeFilter, scopeFilter, installedSort),
    [resources, query, typeFilter, scopeFilter, installedSort],
  );
  const visibleRestrictedApps = useMemo(
    () => filterRestrictedApps(restrictedApps, query, typeFilter, scopeFilter, installedSort),
    [installedSort, query, restrictedApps, scopeFilter, typeFilter],
  );
  const installedTotal = resources.length + restrictedApps.length;
  const installedVisible = visibleResources.length + visibleRestrictedApps.length;
  const installedIssues = resources.filter((item) => ["error", "blocked", "missing"].includes(item.status)).length;
  const hasInstalledQuery = Boolean(query.trim()) || typeFilter !== "all" || scopeFilter !== "all";
  const showRestrictedAppsSection = (typeFilter === "all" || typeFilter === "app")
    && scopeFilter !== "global"
    && (visibleRestrictedApps.length > 0 || (!query.trim() && restrictedApps.length === 0));
  const catalogHref = safeExternalHref(discoverCatalogUrl);

  function selectView(nextView: AssistantToolsView) {
    onViewChange(nextView);
    setQuery("");
    if (nextView === "discover" && typeFilter === "app") setTypeFilter("all");
    setAddOpen(false);
    window.requestAnimationFrame(() => {
      const panel = nextView === "installed" ? installedViewRef.current : discoverViewRef.current;
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: "start" });
    });
  }

  function handleViewTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const nextView = event.key === "Home" ? "installed" : event.key === "End" ? "discover" : direction ? (view === "installed" ? "discover" : "installed") : null;
    if (!nextView) return;
    event.preventDefault();
    selectView(nextView);
    window.requestAnimationFrame(() => document.getElementById(`capabilities-${nextView}-tab`)?.focus());
  }

  function chooseSkillFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setAddOpen(false);
    setPendingInstall({ kind: "skill-files", files, scope: installScope });
  }

  function reviewPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = packageSource.trim();
    if (!source) return;
    setAddOpen(false);
    setPendingInstall({ kind: "package", source, scope: installScope });
  }

  async function reviewDiscoverItem(item: CapabilityDiscoverItem) {
    if (!canInstallDiscoverItem(item)) return;
    if (fixtureMode) {
      setPendingInstall({ kind: "catalog", scope: installScope, item: fixtureDiscoverDetails(item) });
      return;
    }
    const operation = operationGateRef.current.capture();
    setReviewingItemId(item.id);
    try {
      const response = await api<CapabilityDiscoverDetailsResponse>(`/api/agent/capabilities/details?id=${encodeURIComponent(item.id)}`);
      if (!operationGateRef.current.isCurrent(operation)) return;
      setPendingInstall({ kind: "catalog", scope: installScope, item: response.item });
    } catch (caught) {
      if (operationGateRef.current.isCurrent(operation)) onError(errorText(caught));
    } finally {
      if (operationGateRef.current.isCurrent(operation)) setReviewingItemId(null);
    }
  }

  async function installPending() {
    if (!pendingInstall) return;
    const operation = operationGateRef.current.capture();
    const install = pendingInstall;
    setBusy(true);
    try {
      if (fixtureMode) {
        setCatalog(fixtureCatalog());
      } else if (install.kind === "skill-files") {
        const form = new FormData();
        form.set("workspaceId", operation.workspaceId);
        form.set("scope", install.scope);
        install.files.forEach((file) => form.append("files", file, file.name));
        await apiForm("/api/agent/skills/import", form);
      } else if (install.kind === "catalog") {
        await api("/api/agent/capabilities/install", {
          method: "POST",
          body: { workspaceId: operation.workspaceId, id: install.item.id, scope: install.scope },
        });
      } else {
        await api("/api/agent/packages/install", {
          method: "POST",
          body: { workspaceId: operation.workspaceId, source: install.source, scope: install.scope },
        });
      }
      if (!operationGateRef.current.isCurrent(operation)) return;
      const successText = install.kind === "skill-files" ? "Skill installed." : "Pi capability installed.";
      setPackageSource("");
      setPendingInstall(null);
      await loadCatalog(operation);
      if (!operationGateRef.current.isCurrent(operation)) return;
      setTypeFilter("all");
      setScopeFilter("all");
      selectView("installed");
      showToast({ text: successText, tone: "success" });
    } catch (caught) {
      if (operationGateRef.current.isCurrent(operation)) onError(errorText(caught));
    } finally {
      if (operationGateRef.current.isCurrent(operation)) setBusy(false);
    }
  }

  async function mutatePackage(item: AgentPackage, action: "update" | "remove") {
    const operation = operationGateRef.current.capture();
    const remove = action === "remove";
    const confirmed = await requestConfirm({
      title: remove ? "Remove this Pi package?" : "Update this Pi package?",
      body: remove
        ? `${item.source} will be removed from ${scopeLabel(item.scope)}. Resources managed by that package will stop loading.`
        : `${item.source} will be checked and updated in ${scopeLabel(item.scope)}. Pinned versions and refs remain pinned.`,
      confirmLabel: remove ? "Remove package" : "Update package",
      tone: remove ? "danger" : "default",
    });
    if (!confirmed) return;
    if (!operationGateRef.current.isCurrent(operation)) return;
    const key = `${action}:${item.scope}:${item.source}`;
    setPackageBusy(key);
    try {
      if (fixtureMode) {
        if (remove) setCatalog((current) => current ? { ...current, packages: current.packages.filter((pkg) => pkg !== item) } : current);
      } else {
        await api(`/api/agent/packages/${action}`, {
          method: "POST",
          body: { workspaceId: operation.workspaceId, source: item.source, scope: item.scope },
        });
        if (!operationGateRef.current.isCurrent(operation)) return;
        await loadCatalog(operation);
      }
      if (!operationGateRef.current.isCurrent(operation)) return;
      showToast({ text: remove ? "Pi package removed." : "Pi package updated.", tone: "success" });
    } catch (caught) {
      if (operationGateRef.current.isCurrent(operation)) onError(errorText(caught));
    } finally {
      if (operationGateRef.current.isCurrent(operation)) setPackageBusy(null);
    }
  }

  return (
    <div className="workspace-pane-content capabilities-pane assistant-tools-pane professional-surface professional-assistant">
      {!status.configured ? (
        <CapabilityNotice
          icon={<Info20Regular />}
          title="Assistant not set up yet"
          detail="You can organize Assistant tools now and choose a provider when you are ready."
          action={<button className="professional-button professional-button-secondary" type="button" onClick={onOpenSettings}>Open Settings</button>}
        />
      ) : null}

      <header className="assistant-tools-header">
        <div>
          <span className="professional-kicker">Assistant</span>
          <h1>Assistant tools</h1>
          <p>See what the Assistant can use in {workspace.name}. Review scope, source, health, and app access.</p>
        </div>
        <button className="professional-button professional-button-primary capabilities-add-trigger" type="button" onClick={() => setAddOpen(true)}><Add16Regular />Add tool</button>
      </header>

      <div className="capabilities-view-tabs" role="tablist" aria-label="Assistant tools view">
        <button id="capabilities-installed-tab" type="button" role="tab" tabIndex={view === "installed" ? 0 : -1} aria-controls="capabilities-installed-panel" aria-selected={view === "installed"} className={view === "installed" ? "active" : ""} onKeyDown={handleViewTabKeyDown} onClick={() => selectView("installed")}>Installed</button>
        <button id="capabilities-discover-tab" type="button" role="tab" tabIndex={view === "discover" ? 0 : -1} aria-controls="capabilities-discover-panel" aria-selected={view === "discover"} className={view === "discover" ? "active" : ""} onKeyDown={handleViewTabKeyDown} onClick={() => selectView("discover")}>Discover</button>
      </div>

      {view === "installed" ? (
        <section ref={installedViewRef} id="capabilities-installed-panel" className="capabilities-view-content" role="tabpanel" aria-labelledby="capabilities-installed-tab" tabIndex={-1}>
          <div className="capabilities-installed-context">
            <ShieldCheckmark20Regular aria-hidden="true" />
            <div>
              <strong>{workspace.name}</strong>
              <span>{installedTotal} installed {installedTotal === 1 ? "tool" : "tools"} · {scopedToolCount(resources.filter((item) => item.scope === "project").length + restrictedApps.length, "Space")} · {scopedToolCount(resources.filter((item) => item.scope === "global").length, "Personal")}</span>
            </div>
            <p className={installedIssues ? "needs-attention" : "ready"}>{installedIssues ? `${installedIssues} ${installedIssues === 1 ? "tool needs" : "tools need"} attention` : "All tools healthy · App access is approved separately"}</p>
          </div>
          <CapabilityToolbar
            view="installed"
            query={query}
            typeFilter={typeFilter}
            scopeFilter={scopeFilter}
            installedSort={installedSort}
            discoverSort={discoverSort}
            onQueryChange={setQuery}
            onTypeChange={setTypeFilter}
            onScopeChange={setScopeFilter}
            onInstalledSortChange={setInstalledSort}
            onDiscoverSortChange={setDiscoverSort}
          />
          <p className="capabilities-results-summary">{hasInstalledQuery ? `Showing ${installedVisible} of ${installedTotal} installed tools` : `${installedTotal} installed ${installedTotal === 1 ? "tool" : "tools"}`}</p>
          {!installedVisible && installedTotal && !showRestrictedAppsSection ? <CapabilityEmpty title="No matching tools" detail="Change the search or filters to see more." /> : null}
          {showRestrictedAppsSection ? (
            <RestrictedAppsSection
              workspace={workspace}
              apps={visibleRestrictedApps}
              totalApps={restrictedApps.length}
              filtered={visibleRestrictedApps.length !== restrictedApps.length}
              loading={restrictedAppsLoading}
              fixtureMode={fixtureMode}
              onBuildApp={onBuildApp}
              onOpenAppStudio={onOpenAppStudio}
              onUpsertApp={onRestrictedAppChanged}
              onRemoveApp={onRestrictedAppRemoved}
              onError={onError}
            />
          ) : null}
          {typeFilter !== "app" && (!query.trim() || visibleResources.length) ? (
            <section className="capabilities-resource-section" aria-labelledby="skills-extensions-title">
              <div className="capabilities-section-heading">
                <div><h3 id="skills-extensions-title">Skills &amp; Extensions</h3><p>{resources.filter((item) => item.scope === "project").length} in this Space · {resources.filter((item) => item.scope === "global").length} Personal</p></div>
              </div>
              <InstalledCapabilities
                catalog={catalog}
                resources={visibleResources}
                totalResources={resources.length}
                packageBusy={packageBusy}
                onSelect={setSelectedCapability}
                onPackageAction={(item, action) => void mutatePackage(item, action)}
              />
            </section>
          ) : null}
        </section>
      ) : (
        <section ref={discoverViewRef} id="capabilities-discover-panel" className="capabilities-view-content" role="tabpanel" aria-labelledby="capabilities-discover-tab" tabIndex={-1}>
          <div className="capabilities-view-heading">
            <div><h2>Discover Skills &amp; Extensions</h2><p>{discoverTotal ? `${discoverTotal.toLocaleString()} catalog entries` : "Browse Pi packages and first-party Skills."}</p></div>
            <div className="capabilities-view-actions">{catalogHref ? <a href={catalogHref} target="_blank" rel="noreferrer">Open source catalog</a> : null}</div>
          </div>
          <CapabilityToolbar
            view="discover"
            query={query}
            typeFilter={typeFilter}
            scopeFilter={scopeFilter}
            installedSort={installedSort}
            discoverSort={discoverSort}
            onQueryChange={setQuery}
            onTypeChange={setTypeFilter}
            onScopeChange={setScopeFilter}
            onInstalledSortChange={setInstalledSort}
            onDiscoverSortChange={setDiscoverSort}
          />
          <div className="capabilities-discover-install-scope"><span>Install to</span><ScopeToggle value={installScope} onChange={setInstallScope} label="Catalog installation location" /></div>
          <DiscoverCapabilities
            items={discoverItems}
            total={discoverTotal}
            loading={discoverLoading}
            error={discoverError}
            diagnostics={discoverDiagnostics}
            truncated={discoverTruncated}
            reviewingItemId={reviewingItemId}
            onInstall={reviewDiscoverItem}
            onLoadMore={() => void loadDiscover(false)}
          />
        </section>
      )}

      <input hidden ref={importRef} type="file" accept=".zip,.skill,.md" multiple onChange={chooseSkillFiles} />
      {addOpen ? (
        <AddCapabilityDialog
          busy={busy}
          installScope={installScope}
          packageSource={packageSource}
          onClose={() => setAddOpen(false)}
          onScopeChange={setInstallScope}
          onChooseFiles={() => importRef.current?.click()}
          onPackageSourceChange={setPackageSource}
          onReviewPackage={reviewPackage}
        />
      ) : null}
      {pendingInstall ? (
        <InstallReviewDialog
          pending={pendingInstall}
          busy={busy}
          onClose={() => { if (!busy) setPendingInstall(null); }}
          onInstall={() => void installPending()}
        />
      ) : null}
      {selectedCapability ? <CapabilityDetailsDialog item={selectedCapability} onClose={() => setSelectedCapability(null)} /> : null}
    </div>
  );
}

function CapabilityToolbar({
  view,
  query,
  typeFilter,
  scopeFilter,
  installedSort,
  discoverSort,
  onQueryChange,
  onTypeChange,
  onScopeChange,
  onInstalledSortChange,
  onDiscoverSortChange,
}: {
  view: AssistantToolsView;
  query: string;
  typeFilter: CapabilityTypeFilter;
  scopeFilter: CapabilityScopeFilter;
  installedSort: InstalledSort;
  discoverSort: DiscoverSort;
  onQueryChange: (value: string) => void;
  onTypeChange: (value: CapabilityTypeFilter) => void;
  onScopeChange: (value: CapabilityScopeFilter) => void;
  onInstalledSortChange: (value: InstalledSort) => void;
  onDiscoverSortChange: (value: DiscoverSort) => void;
}) {
  return (
    <section className="capabilities-toolbar" aria-label={`${view === "installed" ? "Installed" : "Discover"} tool filters`}>
      <label className="capabilities-search"><Search20Regular aria-hidden="true" /><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={view === "installed" ? "Search installed tools" : "Search the catalog"} /></label>
      <div className="capabilities-filter-row">
        <label className="capabilities-filter-select"><span>Type</span><select aria-label="Tool type" value={typeFilter} onChange={(event) => onTypeChange(event.target.value as CapabilityTypeFilter)}><option value="all">All types</option>{view === "installed" ? <option value="app">Apps</option> : null}<option value="skill">Skills</option><option value="extension">Extensions</option></select></label>
        {view === "installed" ? <label className="capabilities-filter-select"><span>Scope</span><select aria-label="Tool scope" value={scopeFilter} onChange={(event) => onScopeChange(event.target.value as CapabilityScopeFilter)}><option value="all">All scopes</option><option value="project">This Space</option><option value="global">Personal</option></select></label> : null}
        <label className="capabilities-sort"><span>Sort</span>{view === "installed" ? (
          <select value={installedSort} onChange={(event) => onInstalledSortChange(event.target.value as InstalledSort)}><option value="name">Name</option><option value="type">Type</option><option value="scope">Scope</option><option value="source">Source</option></select>
        ) : (
          <select value={discoverSort} onChange={(event) => onDiscoverSortChange(event.target.value as DiscoverSort)}><option value="official">First-party first</option><option value="downloads">Most downloaded</option><option value="recent">Recently published</option><option value="name">Name</option></select>
        )}</label>
      </div>
    </section>
  );
}

function InstalledCapabilities({ catalog, resources, totalResources, packageBusy, onSelect, onPackageAction }: {
  catalog: AgentCatalog | null;
  resources: InstalledCapability[];
  totalResources: number;
  packageBusy: string | null;
  onSelect: (item: InstalledCapability) => void;
  onPackageAction: (item: AgentPackage, action: "update" | "remove") => void;
}) {
  if (!catalog) return <div className="professional-loading-row" role="status"><ArrowSync16Regular className="spin" />Loading Assistant tools</div>;
  return (
    <div className="capabilities-installed-stack">
      {catalog.diagnostics.length ? <div className="professional-diagnostics" role="status">{catalog.diagnostics.map((item, index) => <span className={item.type} key={`${item.message}-${index}`}>{item.message}</span>)}</div> : null}
      {resources.length ? <div className="capabilities-resource-list">{resources.map((item) => <InstalledCapabilityCard key={item.id} item={item} onSelect={() => onSelect(item)} />)}</div> : <CapabilityEmpty title={totalResources ? "No matching tools" : "No Skills or Extensions installed"} detail={totalResources ? "Change the search or filters to see more." : "Use Add Skill or Extension to import a Skill or install a Pi package."} />}
      {catalog.packages.length || catalog.tools.some(isCoreTool) ? (
        <section className="capabilities-supporting-details" aria-labelledby="capabilities-supporting-title">
          <div className="capabilities-supporting-heading">
            <h3 id="capabilities-supporting-title">Supporting details</h3>
            <p>Package sources and the tools that ship with Pi.</p>
          </div>
          <div className="capabilities-supporting-list">
            {catalog.packages.length ? <PackageManagementSection packages={catalog.packages} packageBusy={packageBusy} onPackageAction={onPackageAction} /> : null}
            <CoreToolsSection tools={catalog.tools} management={catalog.toolManagement} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PackageManagementSection({ packages, packageBusy, onPackageAction }: {
  packages: AgentPackage[];
  packageBusy: string | null;
  onPackageAction: (item: AgentPackage, action: "update" | "remove") => void;
}) {
  const updates = packages.filter((item) => item.updateAvailable).length;
  return (
    <details className="capabilities-packages capabilities-management-section">
      <summary>
        <span><Box16Regular aria-hidden="true" /><strong>Packages</strong></span>
        <small>{packages.length} installed{updates ? ` · ${updates} ${updates === 1 ? "update" : "updates"}` : ""}</small>
      </summary>
      <div className="capabilities-package-list">{packages.map((item) => {
        const updateKey = `update:${item.scope}:${item.source}`;
        const removeKey = `remove:${item.scope}:${item.source}`;
        return <article className="capabilities-package-row" key={`${item.scope}:${item.source}`}><div><strong>{item.displayName || item.source}</strong><span>{scopeLabel(item.scope)}{item.filtered ? " · filtered resources" : ""}{item.installedPath ? ` · ${item.installedPath}` : ""}</span></div><span className={item.updateAvailable || item.loaded ? "professional-status-badge enabled" : "professional-status-badge"}>{packageStatusLabel(item)}</span><div className="capabilities-package-actions"><button className="professional-button professional-button-secondary" type="button" disabled={Boolean(packageBusy)} onClick={() => onPackageAction(item, "update")}>{packageBusy === updateKey ? <ArrowSync16Regular className="spin" /> : null}Update</button><button className="minimal-icon-button" type="button" disabled={Boolean(packageBusy)} onClick={() => onPackageAction(item, "remove")} aria-label={`Remove ${item.displayName || item.source}`} title="Remove package">{packageBusy === removeKey ? <ArrowSync16Regular className="spin" /> : <Delete16Regular />}</button></div></article>;
      })}</div>
    </details>
  );
}

function CoreToolsSection({ tools, management }: { tools: AgentTool[]; management?: AgentToolManagement }) {
  const coreTools = tools.filter(isCoreTool);
  if (!coreTools.length) return null;
  return (
    <details className="capabilities-core-tools capabilities-management-section" data-management-mode={management?.mode}>
      <summary><span><Code16Regular aria-hidden="true" /><strong>Core tools</strong></span><small>{coreTools.length} built in</small></summary>
      <div className="capabilities-core-tools-body">
        <p className="capabilities-core-tools-copy" title={management?.reason}>These tools ship with Pi. New Chats start with the defaults below; a Chat or Extension may change its own selection.</p>
        <div className="capabilities-core-tool-list">{coreTools.map((tool) => (
          <article className="capabilities-core-tool-row" key={`${tool.source}:${tool.name}`}>
            <div><strong>{tool.label?.trim() || humanizeToolName(tool.name)}</strong><p>{tool.description}</p><small>{tool.source}</small></div>
            <span className={`professional-status-badge ${tool.active ? "enabled" : ""}`}>{tool.active ? "On in new Chats" : "Available to Chats"}</span>
          </article>
        ))}</div>
      </div>
    </details>
  );
}

function isCoreTool(tool: AgentTool): boolean {
  return tool.core === true || tool.kind === "core" || (tool.core === undefined && tool.kind === undefined && /^(?:pi|built-?in)$/i.test(tool.source.trim()));
}

function InstalledCapabilityCard({ item, onSelect }: { item: InstalledCapability; onSelect: () => void }) {
  return (
    <article className="capabilities-resource-card">
      <span className="professional-icon-tile" aria-hidden="true">{item.kind === "skill" ? <BookToolbox20Regular /> : <PlugConnected20Regular />}</span>
      <div className="capabilities-resource-copy"><div className="capabilities-resource-title"><strong>{item.name}</strong><span>{item.kind === "skill" ? "Skill" : "Extension"}</span></div><p>{item.description}</p><div className="capabilities-resource-meta"><span>{scopeLabel(item.scope)}</span><span>{originLabel(item.origin)}</span><span>{item.source}</span></div>{item.kind === "extension" ? <small>{item.tools.length} tools · {item.commands.length} commands · {item.flags.length} flags</small> : null}</div>
      <div className="capabilities-resource-actions"><span className={`professional-status-badge ${item.status === "loaded" ? "enabled" : item.status === "error" ? "error" : ""}`}>{statusLabel(item.status)}</span><button className="professional-button professional-button-secondary" type="button" onClick={onSelect}>Details</button></div>
    </article>
  );
}

function DiscoverCapabilities({ items, total, loading, error, diagnostics, truncated, reviewingItemId, onInstall, onLoadMore }: {
  items: CapabilityDiscoverItem[];
  total: number;
  loading: boolean;
  error: string | null;
  diagnostics: string[];
  truncated: boolean;
  reviewingItemId: string | null;
  onInstall: (item: CapabilityDiscoverItem) => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="capabilities-discover-stack">
      {total ? <p className="capabilities-results-summary">Showing {items.length.toLocaleString()} of {total.toLocaleString()} catalog entries</p> : null}
      <p className="capabilities-discover-note"><Info20Regular aria-hidden="true" />First-party / reference identifies provenance, not a safety review. Inspect code and package scripts before installing.</p>
      {diagnostics.length || truncated ? <div className="professional-diagnostics" role="status">{diagnostics.map((message) => <span key={message}>{message}</span>)}{truncated ? <span>npm reported additional matches beyond this bounded catalog window.</span> : null}</div> : null}
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      {loading && !items.length ? <div className="professional-loading-row" role="status"><ArrowSync16Regular className="spin" />Loading the full Pi catalog. The first load can take about 20 seconds.</div> : null}
      {items.length ? <div className="capabilities-discover-list">{items.map((item) => <DiscoverCapabilityCard key={item.id} item={item} busy={reviewingItemId === item.id} disabled={Boolean(reviewingItemId) || !canInstallDiscoverItem(item)} onInstall={() => onInstall(item)} />)}</div> : !loading && !error ? <CapabilityEmpty title="No catalog matches" detail="Try a broader search or a different item type." /> : null}
      {items.length < total ? <button className="professional-button professional-button-secondary capabilities-load-more" type="button" disabled={loading} onClick={onLoadMore}>{loading ? <ArrowSync16Regular className="spin" /> : null}Load more</button> : null}
    </div>
  );
}

function DiscoverCapabilityCard({ item, busy, disabled, onInstall }: { item: CapabilityDiscoverItem; busy: boolean; disabled: boolean; onInstall: () => void }) {
  const repositoryHref = safeExternalHref(item.repositoryUrl || item.homepageUrl || item.npmUrl);
  const installable = canInstallDiscoverItem(item);
  return (
    <article className="capabilities-discover-card">
      <span className="professional-icon-tile" aria-hidden="true">{item.types.includes("extension") ? <PlugConnected20Regular /> : <BookToolbox20Regular />}</span>
      <div className="capabilities-resource-copy"><div className="capabilities-resource-title"><strong>{item.name}</strong>{item.official ? <span className="capabilities-official-badge">First-party / reference</span> : null}</div><p>{item.description}</p><div className="capabilities-resource-meta">{item.types.map((type) => <span key={type}>{type === "skill" ? "Skill" : "Extension"}</span>)}{item.author ? <span>{item.author}</span> : null}{item.version ? <span>v{item.version}</span> : null}{typeof item.downloads === "number" ? <span>{item.downloads.toLocaleString()} downloads</span> : null}{item.license ? <span>{item.license}</span> : null}</div>{repositoryHref ? <a href={repositoryHref} target="_blank" rel="noreferrer">View source</a> : null}</div>
      {installable ? <button className="professional-button professional-button-primary" type="button" disabled={disabled} onClick={onInstall}>{busy ? <ArrowSync16Regular className="spin" /> : null}Review</button> : <span className="professional-status-badge">Reference only</span>}
    </article>
  );
}

function AddCapabilityDialog({
  busy,
  installScope,
  packageSource,
  onClose,
  onScopeChange,
  onChooseFiles,
  onPackageSourceChange,
  onReviewPackage,
}: {
  busy: boolean;
  installScope: AgentCapabilityScope;
  packageSource: string;
  onClose: () => void;
  onScopeChange: (value: AgentCapabilityScope) => void;
  onChooseFiles: () => void;
  onPackageSourceChange: (value: string) => void;
  onReviewPackage: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useModalDialog({ onClose, blocked: busy });
  return (
    <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="capability-dialog capability-add-dialog" role="dialog" aria-modal="true" aria-labelledby="capabilities-add-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><h2 id="capabilities-add-title">Add Skill or Extension</h2><p>Import a Skill bundle or install a Pi package from a source you choose.</p></div><button className="minimal-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close Assistant tool setup"><Dismiss20Regular /></button></div>
        <div className="capability-dialog-body capabilities-add-panel">
          <div className="capabilities-add-heading">
            <div><strong>Installation location</strong><p>Keep it personal or store it with this Space.</p></div>
            <ScopeToggle value={installScope} onChange={onScopeChange} label="Installation location" />
          </div>
          <div className="capabilities-add-options">
            <div className="capabilities-add-option">
              <span className="professional-icon-tile" aria-hidden="true"><BookToolbox20Regular /></span>
              <div><strong>Skill or pack</strong><span>Import `SKILL.md`, `.skill`, or ZIP bundles. Only discovered Skill directories are preserved.</span></div>
              <button className="professional-button professional-button-primary" type="button" disabled={busy} onClick={onChooseFiles}><ArrowUpload16Regular />Choose files</button>
            </div>
            <form className="capabilities-add-option capabilities-package-option" onSubmit={onReviewPackage}>
              <span className="professional-icon-tile" aria-hidden="true"><Box16Regular /></span>
              <label><strong>Pi package</strong><span>Install from npm, git, HTTPS, or a local path. Packages can contain executable Extensions and install scripts.</span><input value={packageSource} onChange={(event) => onPackageSourceChange(event.target.value)} placeholder="npm package, git URL, or local path" aria-label="Pi package source" /></label>
              <button className="professional-button professional-button-secondary" type="submit" disabled={busy || !packageSource.trim()}>Review</button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}

function InstallReviewDialog({ pending, busy, onClose, onInstall }: { pending: PendingInstall; busy: boolean; onClose: () => void; onInstall: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, blocked: busy, initialFocusRef: cancelRef });
  const packageInstall = pending.kind === "package";
  const catalogInstall = pending.kind === "catalog";
  const catalogPackageInstall = catalogInstall && pending.item.sourceKind !== "bundle";
  const executablePackageInstall = packageInstall || catalogPackageInstall;
  const extensionInstall = executablePackageInstall || (catalogInstall && (pending.item.types.includes("extension") || Boolean(pending.item.extensions?.length)));
  const title = pending.kind === "skill-files" ? "Review Skill import" : catalogInstall ? `Review ${pending.item.name}` : `Review ${pending.item?.name ?? "Pi package"}`;
  const source = pending.kind === "skill-files" ? pending.files.map((file) => file.name).join(", ") : catalogInstall ? pending.item.installSource || pending.item.name : pending.source;
  return (
    <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="capability-dialog" role="dialog" aria-modal="true" aria-labelledby="capability-install-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><h2 id="capability-install-review-title">{title}</h2><p>Nothing is installed until you confirm.</p></div><button className="minimal-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close review"><Dismiss20Regular /></button></div>
        <div className="capability-dialog-body">
          <dl className="capability-review-facts"><div><dt>Source</dt><dd>{source}</dd></div><div><dt>Location</dt><dd>{scopeLabel(pending.scope)}</dd></div>{pending.kind !== "skill-files" ? <div><dt>Advertised contents</dt><dd>{pending.kind === "package" ? pending.item?.types.map(capabilityTypeLabel).join(", ") || "Package-defined Pi resources" : pending.item.types.map(capabilityTypeLabel).join(", ")}</dd></div> : <div><dt>Files</dt><dd>{pending.files.length}</dd></div>}{catalogInstall ? <><div><dt>Dependencies</dt><dd>{typeof pending.item.dependencyCount === "number" ? pending.item.dependencyCount : "Unknown / not inspected"}</dd></div><div><dt>Install scripts</dt><dd>{installScriptSummary(pending.item)}</dd></div></> : null}</dl>
          {catalogInstall ? <CapabilityPackageContents item={pending.item} /> : null}
          <div className={extensionInstall ? "capability-code-warning danger" : "capability-code-warning"}><ShieldCheckmark20Regular aria-hidden="true" /><div><strong>{extensionInstall ? "This can run code on your computer" : "Skills can include scripts"}</strong><p>{executablePackageInstall ? `Pi packages may run package-manager install scripts. Loaded Extensions execute with your user account's full file, process, and network access.${mutableGitSource(source) ? " This git source is not pinned to an immutable commit and can change between installs." : ""} Missing script or dependency details mean unknown, not none. Review the source before continuing.` : "Workspace imports only discovered Skill directories, but a Skill may tell the Assistant to run included scripts. Import only from a source you trust."}</p></div></div>
        </div>
        <div className="capability-dialog-footer"><button ref={cancelRef} className="professional-button professional-button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="professional-button professional-button-primary" type="button" onClick={onInstall} disabled={busy}>{busy ? <ArrowSync16Regular className="spin" /> : null}{pending.kind === "skill-files" ? "Import Skill" : "Install"}</button></div>
      </section>
    </div>
  );
}

function CapabilityDetailsDialog({ item, onClose }: { item: InstalledCapability; onClose: () => void }) {
  const dialogRef = useModalDialog({ onClose });
  return (
    <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="capability-dialog capability-details-dialog" role="dialog" aria-modal="true" aria-labelledby="capability-details-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><h2 id="capability-details-title">{item.name}</h2><p>{item.kind === "skill" ? "Skill" : "Extension"} · {scopeLabel(item.scope)} · {statusLabel(item.status)}</p></div><button className="minimal-icon-button" type="button" onClick={onClose} aria-label="Close details"><Dismiss20Regular /></button></div>
        <div className="capability-dialog-body"><p className="capability-details-summary">{item.description}</p><dl className="capability-review-facts"><div><dt>Source</dt><dd>{item.source}</dd></div><div><dt>Path</dt><dd>{item.path}</dd></div><div><dt>Origin</dt><dd>{originLabel(item.origin)}</dd></div>{item.kind === "skill" ? <div><dt>Invocation</dt><dd>{item.disableModelInvocation ? "Only when explicitly requested" : "Available to the Assistant when relevant"}</dd></div> : null}</dl>{item.diagnostics.length ? <div className="professional-diagnostics">{item.diagnostics.map((diagnostic, index) => <span className={diagnostic.type} key={`${diagnostic.message}:${index}`}>{diagnostic.message}</span>)}</div> : null}{item.kind === "skill" && item.content ? <div className="markdown-preview capability-skill-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{stripSkillFrontmatter(item.content)}</ReactMarkdown></div> : null}{item.kind === "extension" ? <div className="capability-extension-details"><CapabilityStringList title="Tools" items={item.tools} /><CapabilityStringList title="Commands" items={item.commands} /><CapabilityStringList title="Flags" items={item.flags} /><div className="capability-code-warning danger"><ShieldCheckmark20Regular /><div><strong>Executable capability</strong><p>Extensions run with the same operating-system access as Workspace. Tool and command names are not a complete permissions inventory.</p></div></div></div> : null}</div>
        <div className="capability-dialog-footer"><button className="professional-button professional-button-primary" type="button" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}

function CapabilityStringList({ title, items }: { title: string; items: string[] }) {
  return <section className="capability-string-list"><h3>{title}</h3>{items.length ? <div>{items.map((item) => <span key={item}>{item}</span>)}</div> : <p>None registered</p>}</section>;
}

function CapabilityPackageContents({ item }: { item: CapabilityDiscoverDetailsItem }) {
  const groups: Array<{ label: string; values: string[] | undefined }> = [
    { label: "Skills", values: item.skills },
    { label: "Extensions", values: item.extensions },
    { label: "Prompts", values: item.prompts },
    { label: "Themes", values: item.themes },
  ];
  return (
    <section className="capability-package-contents" aria-labelledby="capability-package-contents-title">
      <h3 id="capability-package-contents-title">Inspected package contents</h3>
      <div>{groups.map((group) => <div key={group.label}><strong>{group.label}</strong><span>{group.values === undefined ? "Unknown / not inspected" : group.values.length ? group.values.join(", ") : "None found"}</span></div>)}</div>
      <div className="capability-install-script-list"><strong>Install scripts</strong>{item.installScripts === undefined ? <span>Unknown / not inspected</span> : item.installScripts.length ? item.installScripts.map((script) => <code key={`${script.name}:${script.command}`}>{script.name}: {script.command}</code>) : <span>Inspected; none declared</span>}</div>
    </section>
  );
}

function ScopeToggle({ value, onChange, label }: { value: AgentCapabilityScope; onChange: (value: AgentCapabilityScope) => void; label: string }) {
  return <div className="professional-scope-toggle" role="group" aria-label={label}><button className={value === "global" ? "active" : ""} type="button" onClick={() => onChange("global")} aria-pressed={value === "global"}>Personal</button><button className={value === "project" ? "active" : ""} type="button" onClick={() => onChange("project")} aria-pressed={value === "project"}>This Space</button></div>;
}

function CapabilityNotice({ icon, title, detail, action, tone = "neutral" }: { icon: ReactNode; title: string; detail: string; action?: ReactNode; tone?: "neutral" | "success" }) {
  return <aside className={`trust-banner professional-notice professional-notice-${tone}`}><span className="professional-notice-icon" aria-hidden="true">{icon}</span><div className="professional-notice-copy"><strong>{title}</strong><span>{detail}</span></div>{action ? <div className="professional-notice-action">{action}</div> : null}</aside>;
}

function CapabilityEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="professional-empty-state capabilities-empty-state"><span className="professional-empty-icon" aria-hidden="true"><BookToolbox20Regular /></span><div><h2>{title}</h2><p>{detail}</p></div></div>;
}

function normalizedCapabilities(catalog: AgentCatalog): InstalledCapability[] {
  const fromSkills = catalog.skills.map((item) => normalizeSkill(item, catalog.diagnostics));
  const fromExtensions = catalog.extensions.map((item) => normalizeExtension(item, catalog.diagnostics));
  return [...fromSkills, ...fromExtensions];
}

function normalizeSkill(item: AgentSkill, catalogDiagnostics: AgentDiagnostic[]): InstalledCapability {
  const source = capabilitySource(item);
  const diagnostics = resourceDiagnostics(item.path, item.diagnostics, catalogDiagnostics);
  const enabled = item.enabled !== false;
  const status = capabilityStatus(item.status, enabled, item.loaded, diagnostics);
  return {
    id: item.id || `skill:${source.scope}:${source.source}:${item.path}:${item.name}`,
    kind: "skill",
    name: item.name,
    description: item.description,
    path: item.path,
    scope: productScope(item.scope ?? source.scope),
    origin: item.origin ?? source.origin,
    source: item.packageSource || source.packageSource || source.source,
    enabled,
    loaded: item.loaded ?? enabled,
    status,
    diagnostics,
    ...(item.content ? { content: item.content } : {}),
    ...(item.disableModelInvocation ? { disableModelInvocation: true } : {}),
    tools: [],
    commands: [],
    flags: [],
  };
}

function normalizeExtension(item: AgentExtension, catalogDiagnostics: AgentDiagnostic[]): InstalledCapability {
  const source = capabilitySource(item);
  const diagnostics = resourceDiagnostics(item.path, item.diagnostics, catalogDiagnostics);
  const enabled = item.enabled !== false;
  const status = capabilityStatus(item.status, enabled, item.loaded, diagnostics);
  return {
    id: item.id || `extension:${source.scope}:${source.source}:${item.path}`,
    kind: "extension",
    name: item.name,
    description: extensionSummary(item),
    path: item.path,
    scope: productScope(item.scope ?? source.scope),
    origin: item.origin ?? source.origin,
    source: item.packageSource || source.packageSource || source.source,
    enabled,
    loaded: item.loaded ?? enabled,
    status,
    diagnostics,
    tools: item.tools,
    commands: item.commands,
    flags: item.flags ?? [],
  };
}

function capabilitySource(item: Pick<AgentSkill, "source" | "sourceInfo" | "scope" | "origin" | "packageSource" | "path">): AgentCapabilitySource {
  if (item.sourceInfo) return item.sourceInfo;
  if (typeof item.source === "object") return item.source;
  const sourceText = item.source || item.path;
  const normalized = sourceText.toLocaleLowerCase();
  const scope = item.scope ?? (normalized.startsWith("project") || normalized.startsWith("this space") ? "project" : "user");
  const origin = item.origin ?? (normalized.includes("package") || Boolean(item.packageSource) ? "package" : "top-level");
  return { path: item.path, source: item.packageSource || sourceText, scope, origin, ...(item.packageSource ? { packageSource: item.packageSource } : {}) };
}

function resourceDiagnostics(path: string, own: AgentDiagnostic[] | undefined, catalog: AgentDiagnostic[]): AgentDiagnostic[] {
  if (own?.length) return own;
  return catalog.filter((item) => item.path === path);
}

function capabilityStatus(status: AgentCapabilityStatus | undefined, enabled: boolean, loaded: boolean | undefined, diagnostics: AgentDiagnostic[]): AgentCapabilityStatus {
  if (status) return status;
  if (diagnostics.some((item) => item.type === "error")) return "error";
  if (!enabled) return "disabled";
  return loaded ?? enabled ? "loaded" : "available";
}

function filterAndSortCapabilities(items: InstalledCapability[], query: string, type: CapabilityTypeFilter, scope: CapabilityScopeFilter, sort: InstalledSort): InstalledCapability[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => {
    if (type === "app") return false;
    if (type !== "all" && item.kind !== type) return false;
    if (scope !== "all" && item.scope !== scope) return false;
    if (!needle) return true;
    return [item.name, item.description, item.source, item.path, ...item.tools, ...item.commands, ...item.flags].some((value) => value.toLocaleLowerCase().includes(needle));
  });
  const value = (item: InstalledCapability) => sort === "type" ? item.kind : sort === "scope" ? scopeLabel(item.scope) : sort === "source" ? item.source : item.name;
  return filtered.sort((left, right) => value(left).localeCompare(value(right), undefined, { sensitivity: "base", numeric: true }) || left.name.localeCompare(right.name));
}

function filterRestrictedApps(items: RestrictedAppInstalled[], query: string, type: CapabilityTypeFilter, scope: CapabilityScopeFilter, sort: InstalledSort): RestrictedAppInstalled[] {
  if ((type !== "all" && type !== "app") || scope === "global") return [];
  const needle = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => !needle || [
      item.manifest.title,
      item.manifest.description ?? "",
      item.packageName,
      item.version,
    ].some((value) => value.toLocaleLowerCase().includes(needle)));
  const value = (item: RestrictedAppInstalled) => sort === "source" ? item.packageName : item.manifest.title;
  return filtered.sort((left, right) => value(left).localeCompare(value(right), undefined, { sensitivity: "base", numeric: true }) || left.manifest.title.localeCompare(right.manifest.title));
}

function productScope(value: AgentCapabilitySource["scope"] | AgentCapabilityScope | "user" | undefined): AgentCapabilityScope {
  return value === "project" ? "project" : "global";
}

function scopeLabel(scope: AgentCapabilityScope): string {
  return scope === "project" ? "This Space" : "Personal";
}

function scopedToolCount(count: number, scope: "Space" | "Personal"): string {
  return `${count} ${scope} ${count === 1 ? "tool" : "tools"}`;
}

function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function originLabel(origin: AgentCapabilityOrigin): string {
  return origin === "package" ? "Pi package" : "Folder or settings";
}

function statusLabel(status: AgentCapabilityStatus): string {
  if (status === "loaded") return "Loaded";
  if (status === "available") return "Available";
  if (status === "disabled") return "Disabled";
  if (status === "blocked") return "Blocked";
  if (status === "missing") return "Missing";
  return "Error";
}

function packageStatusLabel(item: AgentPackage): string {
  if (item.updateAvailable) return "Update available";
  if (item.loaded) return "Loaded";
  if (item.installed) return "Installed";
  if (item.enabled === false) return "Disabled";
  return "Configured";
}

function capabilityTypeLabel(value: "skill" | "extension"): string {
  return value === "skill" ? "Skills" : "Extensions";
}

function extensionSummary(item: AgentExtension): string {
  const parts = [item.tools.length ? `${item.tools.length} tools` : "", item.commands.length ? `${item.commands.length} commands` : "", item.flags?.length ? `${item.flags.length} flags` : ""].filter(Boolean);
  return parts.length ? `Adds ${parts.join(", ")}.` : "Executable Pi Extension.";
}

function canInstallDiscoverItem(item: CapabilityDiscoverItem): boolean {
  return Boolean(item.installSource || item.sourceKind === "bundle");
}

function installScriptSummary(item: CapabilityDiscoverDetailsItem): string {
  if (item.installScripts === undefined) return "Unknown / not inspected";
  if (!item.installScripts.length) return "Inspected; none declared";
  return item.installScripts.map((script) => script.name).join(", ");
}

function mutableGitSource(source: string): boolean {
  const normalized = source.trim();
  if (!/^(?:git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(normalized)) return false;
  const withoutScheme = normalized.replace(/^[a-z]+:\/\//i, "").replace(/^git:/i, "");
  const ref = withoutScheme.lastIndexOf("@");
  if (ref < 0) return true;
  const value = withoutScheme.slice(ref + 1);
  return !/^[0-9a-f]{40}$/i.test(value);
}

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trimStart();
}

function fixtureCatalog(): AgentCatalog {
  return {
    trust: { required: true, trusted: true, savedDecision: true },
    projectTrusted: true,
    diagnostics: [],
    packages: [{ source: "npm:@pi-workspace/calendar-tools", scope: "global", enabled: true, displayName: "Calendar tools", types: ["extension"] }],
    skills: [{ id: "trip-planner", name: "Trip planner", description: "Turns bookings and preferences into a practical itinerary.", path: "skills/trip-planner/SKILL.md", source: { source: "anthropics/skills", scope: "user", origin: "package", packageSource: "github:anthropics/skills" }, scope: "global", origin: "package", packageSource: "github:anthropics/skills", enabled: true, loaded: true, content: "---\nname: trip-planner\ndescription: Plan a trip\n---\n\n# Trip planner\n\nBuild an itinerary from confirmed details, preferences, and constraints." }],
    extensions: [{ id: "calendar", name: "Calendar helper", path: ".pi/extensions/calendar.ts", source: { source: ".pi/extensions/calendar.ts", scope: "project", origin: "top-level" }, scope: "project", origin: "top-level", enabled: true, loaded: true, commands: ["calendar"], tools: ["read_calendar"], flags: ["calendar-account"] }],
    tools: [
      { name: "read", label: "Read files", description: "Read files in the current Space", source: "Pi", active: true, kind: "core", core: true, configurable: false, configurationScope: "chat" },
      { name: "write", label: "Write files", description: "Create and update files", source: "Pi", active: true, kind: "core", core: true, configurable: false, configurationScope: "chat" },
      { name: "read_calendar", label: "Read calendar", description: "Read connected calendar events", source: "Calendar helper", active: false, kind: "extension", core: false, configurable: false, configurationScope: "chat" },
    ],
    toolManagement: { mode: "session-only", persisted: false, mutable: false, scope: "chat", reason: "Pi supports active-tool selection only for a running Chat; it has no supported persisted tool setting." },
  };
}

function fixtureDiscover(query: string, type: CapabilityTypeFilter, sort: DiscoverSort, offset: number): CapabilityDiscoverResponse {
  const all: CapabilityDiscoverItem[] = [
    { id: "anthropic-document-skills", name: "Document Skills", description: "First-party Anthropic Skills for creating and working with common document formats.", types: ["skill"], sourceKind: "bundle", official: true, author: "Anthropic", version: "1.0", downloads: 28400, publishedAt: "2026-06-14T00:00:00.000Z", repositoryUrl: "https://github.com/anthropics/skills", license: "Apache-2.0" },
    { id: "pi-web-tools", name: "Pi web tools", description: "A Pi package with browser-oriented tools and commands.", types: ["extension"], sourceKind: "npm", installSource: "npm:@pi-workspace/web-tools", official: false, author: "Pi community", version: "2.3.1", downloads: 12800, publishedAt: "2026-07-01T00:00:00.000Z", npmUrl: "https://www.npmjs.com/package/@pi-workspace/web-tools", license: "MIT" },
    { id: "research-workbench", name: "Research workbench", description: "Skills and Extensions for collecting, organizing, and citing research.", types: ["skill", "extension"], sourceKind: "git", installSource: "git:github.com/example/research-workbench", official: false, author: "Community", version: "0.9.0", downloads: 4100, publishedAt: "2026-05-20T00:00:00.000Z", repositoryUrl: "https://github.com/example/research-workbench", license: "MIT" },
  ];
  const needle = query.trim().toLocaleLowerCase();
  const filtered = all.filter((item) => (type === "all" || (type !== "app" && item.types.includes(type))) && (!needle || [item.name, item.description, item.author ?? ""].some((value) => value.toLocaleLowerCase().includes(needle))));
  filtered.sort((left, right) => sort === "downloads" ? (right.downloads ?? 0) - (left.downloads ?? 0) : sort === "recent" ? Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? "") : sort === "name" ? left.name.localeCompare(right.name) : Number(right.official) - Number(left.official) || left.name.localeCompare(right.name));
  return { items: filtered.slice(offset, offset + 24), total: filtered.length, offset, limit: 24, catalogUrl: "https://pi.dev/packages" };
}

function fixtureDiscoverDetails(item: CapabilityDiscoverItem): CapabilityDiscoverDetailsItem {
  if (item.id === "pi-web-tools") {
    return { ...item, skills: [], extensions: ["extensions/web-tools.ts"], prompts: ["prompts/research.md"], themes: [], dependencyCount: 4, installScripts: [{ name: "postinstall", command: "node scripts/prepare.js" }] };
  }
  if (item.id === "research-workbench") {
    return { ...item, skills: ["skills/research/SKILL.md"], extensions: ["extensions/research.ts"], prompts: [], themes: [], dependencyCount: 2 };
  }
  return { ...item, skills: ["skills/documents/SKILL.md"], extensions: [], prompts: [], themes: [], dependencyCount: 0, installScripts: [] };
}
