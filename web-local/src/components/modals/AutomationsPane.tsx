import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorText } from "../../lib/api";
import { notifyFolderAutomationsChanged } from "../../hooks/useFolderAutomations";
import {
  formatAutomationDateTime as formatDateTime,
  automationTriggerSummary as triggerSummary,
  type AutomationOutcome,
  type AutomationTriggerView,
} from "../../../../src/shared/automation-presentation";

export type AutomationHealthState = "enabled" | "disabled" | "suspended" | "completed";
export type AutomationsPaneOutcome = AutomationOutcome;

export interface AutomationWorkFolderRef {
  workFolderId: string;
  workFolderName?: string;
}

export type AutomationsPaneTriggerView = AutomationTriggerView;

export type AutomationStepView =
  | {
    id: string;
    kind: "chat";
    workFolder: AutomationWorkFolderRef;
    message: string;
  }
  | {
    id: string;
    kind: "files";
    fromWorkFolder: AutomationWorkFolderRef;
    toWorkFolder: AutomationWorkFolderRef;
    to: string;
    source:
      | { kind: "paths"; paths: string[] }
      | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
      | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number };
  }
  | {
    id: string;
    kind: "check";
    workFolder: AutomationWorkFolderRef;
    checkId?: string;
  }
  | {
    id: string;
    kind: "agent";
    message: string;
  };

export interface AutomationSummaryView {
  automationId: string;
  title: string;
  health: AutomationHealthState;
  trigger: AutomationsPaneTriggerView;
  fileWatch?: { state: "starting" | "watching" | "paused" | "error"; detail?: string; lastObservedAt?: string; lastTriggeredAt?: string };
  stepCount: number;
  /** Every work-folder the trigger or a step names; drives the work-folder filter. */
  workFolders?: AutomationWorkFolderRef[];
  nextScheduledAt?: string;
  lastScheduledAt?: string;
  activeRun?: { runId: string; startedAt: string };
  lastRun?: {
    runId: string;
    outcome: AutomationsPaneOutcome;
    startedAt: string;
    finishedAt?: string;
  };
  suspension?: {
    at: string;
    reason?: string;
    missingWorkFolders?: AutomationWorkFolderRef[];
  };
}

export interface AutomationDetailView extends AutomationSummaryView {
  createdAt: string;
  createdBy?: string;
  workFolders: AutomationWorkFolderRef[];
  steps: AutomationStepView[];
  completedAt?: string;
}

export interface AutomationHistoryHopView {
  hopId: string;
  kind: "chat" | "files" | "check" | "agent";
  outcome: AutomationsPaneOutcome;
  workFolderName?: string;
  detail?: string;
  evidence?: Array<{ label: string; value: string }>;
}

export interface AutomationHistoryRunView {
  runId: string;
  outcome: AutomationsPaneOutcome;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  detail?: string;
  hops: AutomationHistoryHopView[];
}

export interface AutomationsResponse {
  automations: AutomationSummaryView[];
  status: {
    storeDamaged: boolean;
    storeDamageReason?: string;
    journalDamaged: boolean;
    journalDamageReason?: string;
    activeRunCount: number;
  };
}

export interface AutomationDetailResponse {
  automation: AutomationDetailView;
}

export interface AutomationHistoryResponse {
  runs: AutomationHistoryRunView[];
  truncated: boolean;
  damagedLineCount: number;
}

export interface AutomationEnableResponse {
  automationId: string;
  requestId: string;
  enabled: true;
  /** True when this exact automation was already on, so nothing changed. */
  alreadyEnabled: boolean;
}

export interface AutomationRunResponse {
  automationId: string;
  requestId: string;
  runId: string;
  accepted: true;
}

/** A `*.work-fold-automation.json` file the work-fold agent wrote that is not stored yet. */
export type AutomationProposalView =
  | {
    valid: true;
    path: string;
    fileName: string;
    automationId: string;
    digest: string;
    title: string;
    trigger: AutomationsPaneTriggerView;
  }
  | { valid: false; path: string; fileName: string; problem: string };

export interface AutomationProposalsResponse {
  proposals: AutomationProposalView[];
  truncated: boolean;
}

export interface AutomationEnableProposalResponse extends AutomationEnableResponse {
  automation: AutomationSummaryView;
}

const emptyHistory: AutomationHistoryResponse = { runs: [], truncated: false, damagedLineCount: 0 };

/**
 * Settings-only projection over the host automation service. The renderer never
 * parses declarations or receipt JSONL itself: the host resolves work-folder names,
 * safe details, run groups, and evidence identifiers before they arrive here.
 */
export function AutomationsPane() {
  const [data, setData] = useState<AutomationsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationDetailView | null>(null);
  const [history, setHistory] = useState<AutomationHistoryResponse>(emptyHistory);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [runWatches, setRunWatches] = useState<Record<string, { startedAt: number; runId?: string }>>({});
  const [proposals, setProposals] = useState<AutomationProposalView[]>([]);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  // Pending proposal files are a desktop-only read; without the bridge the
  // section is simply absent and the load error line explains why.
  const loadProposals = useCallback(async () => {
    const scan = window.workFoldDesktop?.automations?.proposals;
    if (!scan) return;
    const next = await scan();
    setProposals((current) => sameProposals(current, next.proposals) ? current : next.proposals);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const scan = window.workFoldDesktop?.automations?.proposals;
      if (!scan) return;
      void scan()
        .then((next) => {
          if (!cancelled) setProposals((current) => sameProposals(current, next.proposals) ? current : next.proposals);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const selectAutomation = useCallback((automationId: string | null) => {
    selectedIdRef.current = automationId;
    setSelectedId(automationId);
  }, []);

  const loadList = useCallback(async () => {
    const next = await automationBridge().list();
    setData(next);
    setLoadError(null);
    const current = selectedIdRef.current;
    selectAutomation(current && next.automations.some((automation) => automation.automationId === current)
      ? current
      : next.automations[0]?.automationId ?? null);
    return next;
  }, [selectAutomation]);

  const loadSelected = useCallback(async (automationId: string) => {
    const [nextDetail, nextHistory] = await Promise.all([
      automationBridge().show(automationId),
      automationBridge().history(automationId),
    ]);
    if (selectedIdRef.current !== automationId) return;
    setDetail(nextDetail.automation);
    setHistory(nextHistory);
    setDetailError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => automationBridge().list())
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoadError(null);
        const current = selectedIdRef.current;
        selectAutomation(current && next.automations.some((automation) => automation.automationId === current)
          ? current
          : next.automations[0]?.automationId ?? null);
      })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [selectAutomation]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!selectedId) {
      setDetail(null);
      setHistory(emptyHistory);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setHistory(emptyHistory);
    setDetailError(null);
    void Promise.resolve().then(() => Promise.all([
      automationBridge().show(selectedId),
      automationBridge().history(selectedId),
    ]))
      .then(([nextDetail, nextHistory]) => {
        if (cancelled) return;
        setDetail(nextDetail.automation);
        setHistory(nextHistory);
        setDetailError(null);
      })
      .catch((caught) => { if (!cancelled) setDetailError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const hasActiveRun = Boolean(data?.automations.some((automation) => automation.activeRun))
    || pending.some((key) => key.startsWith("run:"))
    || Object.keys(runWatches).length > 0;
  const hasFileWatch = Boolean(data?.automations.some((automation) => automation.trigger.kind === "files-changed" && automation.health === "enabled"));
  useEffect(() => {
    if (!hasActiveRun && !hasFileWatch) return;
    const timer = window.setInterval(() => {
      void loadList()
        .then(async (next) => {
          const selectedStillExists = selectedId && next.automations.some((automation) => automation.automationId === selectedId);
          if (selectedStillExists) await loadSelected(selectedId);
          const settled: string[] = [];
          for (const [automationId, watch] of Object.entries(runWatches)) {
            const automation = next.automations.find((candidate) => candidate.automationId === automationId);
            if (!automation || automation.health !== "enabled" || next.status.journalDamaged || Date.now() - watch.startedAt > 10 * 60_000) {
              settled.push(automationId);
              continue;
            }
            if (automation.activeRun) continue;
            const recent = await automationBridge().history(automationId).catch(() => null);
            if (recent?.runs.some((run) => run.outcome !== "accepted" && (
              watch.runId ? run.runId === watch.runId : Date.parse(run.startedAt) >= watch.startedAt - 1_000
            ))) {
              settled.push(automationId);
            }
          }
          if (settled.length) {
            setRunWatches((current) => Object.fromEntries(
              Object.entries(current).filter(([automationId]) => !settled.includes(automationId)),
            ));
          }
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, hasFileWatch, loadList, loadSelected, runWatches, selectedId]);

  const selectedSummary = useMemo(
    () => data?.automations.find((automation) => automation.automationId === selectedId) ?? null,
    [data?.automations, selectedId],
  );

  async function runAction(key: string, operation: () => Promise<string | null>) {
    if (pending.includes(key)) return;
    const watchedAutomationId = key.startsWith("run:") ? key.slice("run:".length) : null;
    if (watchedAutomationId) {
      setRunWatches((current) => ({ ...current, [watchedAutomationId]: { startedAt: Date.now() } }));
    }
    setPending((current) => [...current, key]);
    setActionError(null);
    setNotice(null);
    try {
      const nextNotice = await operation();
      notifyFolderAutomationsChanged();
      await loadProposals().catch(() => undefined);
      const next = await loadList();
      const nextSelectedId = selectedId && next.automations.some((automation) => automation.automationId === selectedId)
        ? selectedId
        : next.automations[0]?.automationId ?? null;
      if (nextSelectedId) await loadSelected(nextSelectedId);
      else {
        setDetail(null);
        setHistory(emptyHistory);
      }
      if (nextNotice) setNotice(nextNotice);
    } catch (caught) {
      if (watchedAutomationId) {
        setRunWatches((current) => Object.fromEntries(
          Object.entries(current).filter(([automationId]) => automationId !== watchedAutomationId),
        ));
      }
      setActionError(errorText(caught));
    } finally {
      setPending((current) => current.filter((item) => item !== key));
    }
  }

  async function openAutomationDraft(existing: AutomationDetailView): Promise<void> {
    const openDraft = window.workFoldDesktop?.agent?.openWorkFoldAgentDraft;
    if (!openDraft || drafting) {
      setActionError("Open the work-fold agent in the desktop app to draft an automation.");
      return;
    }
    setDrafting(true);
    setActionError(null);
    try {
      const draft = `Review the automation “${existing.title}” (id: ${existing.automationId}). Its current trigger is: ${triggerSummary(existing.trigger)}. Preserve it until I give a clear instruction to change it.`;
      await openDraft(draft);
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setDrafting(false);
    }
  }

  const status = data?.status;
  const allAutomations = useMemo(() => data?.automations ?? [], [data?.automations]);
  const storeUnavailable = Boolean(status?.storeDamaged);
  const wideningUnavailable = storeUnavailable || Boolean(status?.journalDamaged);

  // Automations sit above work-folders and are managed here, so the work-folder filter
  // is a client-side view over one list. A work-folder's own Automations tab is
  // a read-mostly window onto the same automations (docs/automations.md,
  // F15 as amended 2026-09-24).
  const folderChips = useMemo(() => {
    const byId = new Map<string, AutomationWorkFolderRef>();
    for (const automation of allAutomations) {
      for (const workFolder of automation.workFolders ?? []) {
        if (!byId.has(workFolder.workFolderId) || (!byId.get(workFolder.workFolderId)!.workFolderName && workFolder.workFolderName)) byId.set(workFolder.workFolderId, workFolder);
      }
    }
    return [...byId.values()].sort((left, right) => workFolderLabel(left).localeCompare(workFolderLabel(right)));
  }, [allAutomations]);
  const showFolderFilter = allAutomations.length > 1 && folderChips.length > 1;
  const activeFolder = showFolderFilter && folderFilter && folderChips.some((workFolder) => workFolder.workFolderId === folderFilter)
    ? folderFilter
    : null;
  const automations = activeFolder
    ? allAutomations.filter((automation) => automation.workFolders?.some((workFolder) => workFolder.workFolderId === activeFolder))
    : allAutomations;

  function chooseFolder(workFolderId: string | null) {
    setFolderFilter(workFolderId);
    const visible = workFolderId
      ? allAutomations.filter((automation) => automation.workFolders?.some((workFolder) => workFolder.workFolderId === workFolderId))
      : allAutomations;
    if (!visible.some((automation) => automation.automationId === selectedIdRef.current)) {
      selectAutomation(visible[0]?.automationId ?? null);
    }
  }

  return (
    <section className="settings-section automations-pane" aria-label="Automations">
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {status?.storeDamaged ? (
        <span className="settings-inline-error" role="alert">
          {status.storeDamageReason ?? "The automation records could not be read."} Nothing will run until they are recovered.
        </span>
      ) : null}
      {status?.journalDamaged ? (
        <span className="settings-inline-error" role="alert">
          {status.journalDamageReason ?? "Run history could not be verified."} New runs are unavailable.
        </span>
      ) : null}
      {notice ? <span className="settings-save-status" role="status">{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {proposals.length ? (
        <section className="automation-proposals" aria-labelledby="automation-proposals-title">
          <h5 id="automation-proposals-title">{proposals.some((proposal) => proposal.valid) ? "Ready to turn on" : "Automation files"}</h5>
          <ul>
            {proposals.map((proposal) => proposal.valid ? (
              <li className="automation-proposal" key={proposal.path}>
                <div>
                  <strong>{proposal.title}</strong>
                  <small>{triggerSummary(proposal.trigger)}</small>
                </div>
                <button
                  className="ui-control ui-control--primary"
                  type="button"
                  disabled={wideningUnavailable || pending.includes(`enable-proposal:${proposal.path}`)}
                  onClick={() => void runAction(`enable-proposal:${proposal.path}`, async () => {
                    const result = await automationBridge().enableProposal(proposal.path);
                    selectAutomation(result.automationId);
                    setFolderFilter(null);
                    return result.alreadyEnabled ? "Automation is already on" : "Automation turned on";
                  })}
                >
                  {pending.includes(`enable-proposal:${proposal.path}`) ? "Turning on…" : "Turn On"}
                </button>
              </li>
            ) : (
              <li className="automation-proposal invalid" key={proposal.path} title={proposal.problem}>
                <div>
                  <strong>{proposal.fileName}</strong>
                  <small>Can&apos;t be turned on</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data && !allAutomations.length ? (
        <div className="automations-empty">No automations yet. To set one up, ask the work-fold agent in the menu bar. Say what should happen, when, and in which work-folders.</div>
      ) : null}
      {showFolderFilter ? (
        <div className="capabilities-type-chips automation-folder-filter" role="group" aria-label="work-folder">
          <button type="button" className={activeFolder === null ? "active" : ""} aria-pressed={activeFolder === null} onClick={() => chooseFolder(null)}>All</button>
          {folderChips.map((workFolder) => (
            <button
              key={workFolder.workFolderId}
              type="button"
              className={activeFolder === workFolder.workFolderId ? "active" : ""}
              aria-pressed={activeFolder === workFolder.workFolderId}
              onClick={() => chooseFolder(workFolder.workFolderId)}
            >
              {workFolderLabel(workFolder)}
            </button>
          ))}
        </div>
      ) : null}
      {automations.length ? (
        <div className="automations-workbench">
          <div className="automation-list" role="listbox" aria-label="Automations">
            {automations.map((automation) => (
              <button
                className={automation.automationId === selectedId ? "automation-list-row selected" : "automation-list-row"}
                type="button"
                role="option"
                aria-selected={automation.automationId === selectedId}
                key={automation.automationId}
                onClick={() => {
                  selectAutomation(automation.automationId);
                  setActionError(null);
                  setNotice(null);
                }}
              >
                <span className="automation-list-heading">
                  <strong>{automation.title}</strong>
                  <AutomationHealth
                    health={automation.health}
                    running={Boolean(automation.activeRun)}
                    starting={Boolean(runWatches[automation.automationId]) && !automation.activeRun}
                  />
                </span>
                <small>{triggerSummary(automation.trigger)}</small>
                <small>{automation.activeRun
                  ? "Running now"
                  : runWatches[automation.automationId]
                    ? "Starting…"
                    : automation.nextScheduledAt
                      ? `Next ${formatDateTime(automation.nextScheduledAt)}`
                      : lastRunSummary(automation)}</small>
              </button>
            ))}
          </div>
          <div className="automation-inspector" aria-live="polite">
            {detailError ? <span className="settings-inline-error" role="alert">{detailError}</span> : null}
            {!detail && !detailError ? <div className="automation-loading">Loading</div> : null}
            {detail && selectedSummary ? (
              <>
                <header className="automation-inspector-header">
                  <div>
                    <h4>{detail.title}</h4>
                    <span>{triggerSummary(detail.trigger)}</span>
                  </div>
                  <div className="automation-inspector-actions">
                    <AutomationHealth
                      health={selectedSummary.health}
                      running={Boolean(selectedSummary.activeRun)}
                      starting={Boolean(runWatches[selectedSummary.automationId]) && !selectedSummary.activeRun}
                    />
                    <button className="ui-control" type="button" onClick={() => void openAutomationDraft(detail)} disabled={drafting}>Edit with work-fold agent</button>
                  </div>
                </header>

                {detail.health === "suspended" ? (
                  <p className="automation-suspension">
                    {detail.suspension?.reason ?? missingWorkFoldersMessage(detail.suspension?.missingWorkFolders)}
                  </p>
                ) : null}

                {detail.trigger.kind === "files-changed" ? <section className="automation-detail-section">
                  <h5>Watched folder</h5>
                  <p>{detail.trigger.watch.path}{detail.trigger.watch.recursive ? " and subfolders" : ""} · {detail.trigger.watch.extensions.join(", ")}</p>
                  <p>Observer: {detail.fileWatch?.state ?? "off"}{detail.fileWatch?.detail ? ` · ${detail.fileWatch.detail}` : ""}</p>
                  <p>Changes during automation work, sleep, or restart are not replayed.</p>
                </section> : null}
                <dl className="automation-facts">
                  <div><dt>Next</dt><dd>{detail.nextScheduledAt ? formatDateTime(detail.nextScheduledAt) : "—"}</dd></div>
                  <div><dt>Last run</dt><dd>{detail.lastRun ? `${outcomeLabel(detail.lastRun.outcome)} · ${formatDateTime(detail.lastRun.startedAt)}` : "Not Run Yet"}</dd></div>
                </dl>

                <section className="automation-detail-section" aria-labelledby="automation-steps-title">
                  <h5 id="automation-steps-title">Steps</h5>
                  <ol className="automation-step-list">
                    {detail.steps.map((step) => <AutomationStep key={step.id} step={step} />)}
                  </ol>
                  <AutomationResiduals steps={detail.steps} />
                </section>

                <AutomationActions
                  automation={detail}
                  pending={pending}
                  storeUnavailable={storeUnavailable}
                  wideningUnavailable={wideningUnavailable}
                  runQueued={Boolean(runWatches[detail.automationId]) && !detail.activeRun}
                  onRun={(key, operation) => void runAction(key, operation)}
                  onRunAdmitted={(automationId, runId) => {
                    setRunWatches((current) => ({
                      ...current,
                      [automationId]: { startedAt: current[automationId]?.startedAt ?? Date.now(), runId },
                    }));
                  }}
                  onDeleted={() => selectAutomation(null)}
                />

                <section className="automation-detail-section automation-history" aria-labelledby="automation-history-title">
                  <div className="automation-section-heading">
                    <h5 id="automation-history-title">Recent Runs</h5>
                    {history.truncated ? <span>Newest shown</span> : null}
                  </div>
                  {history.damagedLineCount ? <small className="settings-inline-error">Some older run records could not be read.</small> : null}
                  {!history.runs.length ? <p>Nothing has run yet.</p> : (
                    <div className="automation-run-list">
                      {history.runs.map((run) => <AutomationRun key={run.runId} run={run} />)}
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AutomationActions({ automation, pending, storeUnavailable, wideningUnavailable, runQueued, onRun, onRunAdmitted, onDeleted }: {
  automation: AutomationDetailView;
  pending: string[];
  storeUnavailable: boolean;
  wideningUnavailable: boolean;
  runQueued: boolean;
  onRun: (key: string, operation: () => Promise<string | null>) => void;
  onRunAdmitted: (automationId: string, runId: string) => void;
  onDeleted: () => void;
}) {
  const anyPending = pending.some((key) => key.endsWith(`:${automation.automationId}`));
  const isRunning = Boolean(automation.activeRun);
  const canDelete = !isRunning
    && (automation.health === "disabled" || automation.health === "suspended" || automation.health === "completed");

  return (
    <section className="automation-actions" aria-label="Automation actions">
      <div className="settings-actions">
        {automation.health === "enabled" ? (
          <button
            className="ui-control ui-control--primary"
            type="button"
            disabled={wideningUnavailable || anyPending || isRunning || runQueued}
            onClick={() => onRun(`run:${automation.automationId}`, async () => {
              const requested = await automationBridge().run(automation.automationId);
              onRunAdmitted(automation.automationId, requested.runId);
              return "Run Requested";
            })}
          >
            {pending.includes(`run:${automation.automationId}`) || runQueued ? "Starting…" : "Run a copy now"}
          </button>
        ) : null}
        {isRunning ? (
          <button
            className="ui-control danger"
            type="button"
            disabled={pending.includes(`stop:${automation.automationId}`)}
            onClick={() => onRun(`stop:${automation.automationId}`, async () => {
              await automationBridge().stop(automation.automationId);
              return "Stopping run";
            })}
          >
            {pending.includes(`stop:${automation.automationId}`) ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {automation.health === "enabled" ? (
          <button
            className="ui-control"
            type="button"
            disabled={storeUnavailable || anyPending}
            onClick={() => onRun(`disable:${automation.automationId}`, async () => {
              await automationBridge().disable(automation.automationId);
              return "Automation turned off";
            })}
          >
            {pending.includes(`disable:${automation.automationId}`) ? "Turning off…" : "Turn Off"}
          </button>
        ) : null}
        {automation.health === "disabled" || automation.health === "suspended" ? (
          <button
            className="ui-control ui-control--primary"
            type="button"
            disabled={wideningUnavailable || anyPending}
            onClick={() => onRun(`enable:${automation.automationId}`, async () => {
              const result = await automationBridge().enable(automation.automationId);
              return result.alreadyEnabled ? "Automation is already on" : "Automation turned on";
            })}
          >
            {pending.includes(`enable:${automation.automationId}`) ? "Turning on…" : "Turn On"}
          </button>
        ) : null}
        {canDelete ? (
          <button
            className="ui-control danger"
            type="button"
            disabled={storeUnavailable || anyPending}
            onClick={() => {
              if (!window.confirm(`Delete “${automation.title}”? Its run history will remain.`)) return;
              onRun(`delete:${automation.automationId}`, async () => {
                await automationBridge().delete(automation.automationId);
                onDeleted();
                return "Automation deleted";
              });
            }}
          >
            {pending.includes(`delete:${automation.automationId}`) ? "Deleting…" : "Delete"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function AutomationHealth({ health, running, starting = false }: { health: AutomationHealthState; running: boolean; starting?: boolean }) {
  const label = running
    ? "Running"
    : starting
      ? "Starting"
    : health === "enabled"
      ? "On"
      : health === "disabled"
        ? "Off"
        : health === "completed"
          ? "Done"
          : "Suspended";
  return <span className={`automation-health ${running ? "running" : health}`}>{label}</span>;
}

/**
 * What stays true for as long as this automation is on (docs/automations.md).
 * These are residuals rather than gates: a created-files handoff is a
 * standing, content-dependent channel from one work-folder into another, and a chat
 * step's turn runs with whatever Worker authority its work-folder holds at that
 * moment. `automations show` states the same two things in the terminal.
 */
function AutomationResiduals({ steps }: { steps: AutomationStepView[] }) {
  const handoffs = steps.flatMap((step) => step.kind === "files" && step.source.kind === "step-created-files"
    ? [{ id: step.id, from: step.source.step, toWorkFolder: step.toWorkFolder }]
    : []);
  const hasChat = steps.some((step) => step.kind === "chat");
  if (!handoffs.length && !hasChat) return null;
  return (
    <div className="automation-residuals">
      <h6>While this automation is on</h6>
      <ul>
        {handoffs.map((handoff) => (
          <li key={`residual-${handoff.id}`}>
            Standing channel: whatever step {handoff.from}&apos;s turn writes is copied into{" "}
            {workFolderLabel(handoff.toWorkFolder)} on every run.
          </li>
        ))}
        {hasChat ? (
          <li key="residual-authority">
            Each Worker turn uses the permissions its work-folder has at that moment, not the
            permissions it had when this automation was turned on.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function AutomationStep({ step }: { step: AutomationStepView }) {
  if (step.kind === "chat") {
    return (
      <li>
        <div className="automation-step-heading"><strong>Worker</strong><span>{workFolderLabel(step.workFolder)}</span></div>
        <blockquote>{step.message}</blockquote>
      </li>
    );
  }
  if (step.kind === "files") {
    return (
      <li>
        <div className="automation-step-heading"><strong>Copy Files</strong><span>{workFolderLabel(step.fromWorkFolder)} → {workFolderLabel(step.toWorkFolder)}</span></div>
        <p>{filesSourceSummary(step.source)} into <code>{step.to || "/"}</code></p>
      </li>
    );
  }
  if (step.kind === "agent") {
    return (
      <li>
        <div className="automation-step-heading"><strong>Message work-fold agent</strong><span>Starts a new chat</span></div>
        <blockquote>{step.message}</blockquote>
      </li>
    );
  }
  return (
    <li>
      <div className="automation-step-heading"><strong>Run Checks</strong><span>{workFolderLabel(step.workFolder)}</span></div>
      <p>{step.checkId ? `Check ${step.checkId}` : "All enabled Checks"}</p>
    </li>
  );
}

function AutomationRun({ run }: { run: AutomationHistoryRunView }) {
  return (
    <details className="automation-run">
      <summary>
        <span className={`automation-run-dot ${run.outcome}`} aria-hidden="true" />
        <strong>{outcomeLabel(run.outcome)}</strong>
        <span>{formatDateTime(run.startedAt)}</span>
      </summary>
      <div className="automation-run-detail">
        {run.cause ? <p>{run.cause}</p> : null}
        {run.detail ? <p>{run.detail}</p> : null}
        {run.hops.length ? (
          <ol>
            {run.hops.map((hop) => (
              <li key={hop.hopId}>
                <div><strong>{hopLabel(hop.kind)}</strong><span>{outcomeLabel(hop.outcome)}{hop.workFolderName ? ` · ${hop.workFolderName}` : ""}</span></div>
                {hop.detail ? <small>{hop.detail}</small> : null}
                {hop.evidence?.map((item) => <small key={`${hop.hopId}:${item.label}:${item.value}`}>{item.label}: <code>{item.value}</code></small>)}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  );
}

function filesSourceSummary(source: Extract<AutomationStepView, { kind: "files" }>["source"]): string {
  if (source.kind === "paths") return source.paths.join(", ");
  if (source.kind === "tree") {
    const suffix = source.extensions.length ? ` (${source.extensions.join(", ")})` : "";
    return `${source.path || "/"}${source.recursive ? " and its folders" : ""}${suffix}`;
  }
  const suffix = source.extensions?.length ? ` matching ${source.extensions.join(", ")}` : "";
  return `Files created by ${source.step}${suffix} · up to ${source.maxFiles} files / ${formatBytes(source.maxTotalBytes)}`;
}

function lastRunSummary(automation: AutomationSummaryView): string {
  if (!automation.lastRun) return automation.health === "completed" ? "Completed" : "Not Run Yet";
  return `${outcomeLabel(automation.lastRun.outcome)} · ${formatDateTime(automation.lastRun.startedAt)}`;
}

function missingWorkFoldersMessage(workFolders: AutomationWorkFolderRef[] | undefined): string {
  if (!workFolders?.length) return "A referenced work-folder is no longer available. Review the automation before turning it on again.";
  return `${workFolders.map(workFolderLabel).join(", ")} ${workFolders.length === 1 ? "is" : "are"} no longer available. Review the automation before turning it on again.`;
}

function workFolderLabel(workFolder: AutomationWorkFolderRef): string {
  return workFolder.workFolderName ?? workFolder.workFolderId;
}

function outcomeLabel(outcome: AutomationsPaneOutcome): string {
  return ({
    accepted: "Started",
    succeeded: "Succeeded",
    failed: "Failed",
    stopped: "Stopped",
    interrupted: "Interrupted",
    skipped: "Skipped",
    lapsed: "Missed",
  })[outcome];
}

function hopLabel(kind: AutomationHistoryHopView["kind"]): string {
  if (kind === "chat") return "Chat";
  if (kind === "files") return "Copy Files";
  return kind === "agent" ? "Message work-fold agent" : "Run Checks";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function sameProposals(left: AutomationProposalView[], right: AutomationProposalView[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function automationBridge() {
  const bridge = window.workFoldDesktop?.automations;
  if (!bridge) throw new Error("Automation settings are available in the desktop app.");
  return bridge;
}
