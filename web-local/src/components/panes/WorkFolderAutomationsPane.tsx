import { useEffect, useRef, useState } from "react";

import { api, errorText } from "../../lib/api";
import { folderAutomationsPath, notifyFolderAutomationsChanged } from "../../hooks/useFolderAutomations";
import { showToast } from "../../ui/feedback";
import { folderAutomations as copy } from "../../ui-contract";
import {
  formatAutomationDateTime,
  type FolderAutomationRole,
  type FolderAutomationState,
  type FolderAutomationView,
} from "../../../../src/shared/automation-presentation";
import type { WorkFolderSummary } from "../../types";

type FolderAutomationAction = "run" | "enable" | "disable";

/**
 * The work-folder-owned Automations tab (docs/automations.md, F15 as amended
 * 2026-09-24): a read-mostly window onto the automations whose trigger or
 * steps name this work-folder. Run now, Turn on, and Turn off take the same
 * receipted path as Settings → Automations, which stays the management home;
 * nothing is edited here.
 */
export function WorkFolderAutomationsPane({
  workFolder,
  automations,
  active,
  fixtureMode = false,
  onRefresh,
  onOpenAllAutomations,
}: {
  workFolder: WorkFolderSummary;
  /** Undefined until the first read of this work-folder settles. */
  automations: FolderAutomationView[] | undefined;
  active: boolean;
  fixtureMode?: boolean;
  onRefresh: () => Promise<void>;
  onOpenAllAutomations: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const anyRunning = Boolean(automations?.some((automation) => automation.state === "running"));
  useEffect(() => {
    if (!active || fixtureMode) return;
    void refreshRef.current();
  }, [active, fixtureMode, workFolder.id]);
  useEffect(() => {
    if (!active || fixtureMode || (!anyRunning && watchUntil <= Date.now())) return;
    const timer = window.setInterval(() => {
      if (!anyRunning && watchUntil <= Date.now()) {
        window.clearInterval(timer);
        setWatchUntil(0);
        return;
      }
      void refreshRef.current();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [active, anyRunning, fixtureMode, watchUntil]);

  async function act(automation: FolderAutomationView, action: FolderAutomationAction): Promise<void> {
    if (fixtureMode) {
      showToast({ text: copy.previewDisabled, tone: "info" });
      return;
    }
    if (pending) return;
    setPending(automation.automationId);
    try {
      await api(`${folderAutomationsPath(workFolder.id)}/${encodeURIComponent(automation.automationId)}/${action}`, { method: "POST" });
      notifyFolderAutomationsChanged();
      if (action === "run") setWatchUntil(Date.now() + 60_000);
      await onRefresh();
    } catch (caught) {
      showToast({ text: errorText(caught), tone: "error" });
      await onRefresh().catch(() => undefined);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="work-folder-pane-content capabilities-pane folder-automations-pane professional-surface professional-setup">
      <header className="skills-extensions-header">
        <div>
          <h1>{copy.heading(workFolder.name)}</h1>
        </div>
      </header>
      {automations && !automations.length ? (
        <p className="folder-automations-empty">{copy.noneLeft}</p>
      ) : null}
      {automations?.length ? (
        <ul className="folder-automations-list" aria-label={copy.heading(workFolder.name)}>
          {automations.map((automation) => (
            <li className="folder-automation-row" key={automation.automationId}>
              <div className="folder-automation-heading">
                <strong>{automation.title}</strong>
                <span className={`automation-health ${stateClass(automation.state)}`}>{copy.states[automation.state]}</span>
              </div>
              <p className="folder-automation-trigger">{automation.triggerSummary}</p>
              {automation.roles.length ? <p className="folder-automation-roles">{folderAutomationRoleSentence(automation.roles)}</p> : null}
              <small className="folder-automation-last-run">{lastRunText(automation)}</small>
              <div className="folder-automation-actions">
                {automation.state === "on" ? (
                  <button className="ui-control ui-control--primary" type="button" disabled={pending !== null} onClick={() => void act(automation, "run")}>{copy.runNow}</button>
                ) : null}
                {automation.state === "on" || automation.state === "running" ? (
                  <button className="ui-control" type="button" disabled={pending !== null} onClick={() => void act(automation, "disable")}>{copy.turnOff}</button>
                ) : null}
                {automation.state === "off" || automation.state === "suspended" ? (
                  <button className="ui-control ui-control--primary" type="button" disabled={pending !== null} onClick={() => void act(automation, "enable")}>{copy.turnOn}</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="folder-automations-footer">
        <button className="ui-control ui-control--quiet" type="button" onClick={onOpenAllAutomations}>{copy.allAutomations}</button>
      </footer>
    </div>
  );
}

export function folderAutomationRoleSentence(roles: readonly FolderAutomationRole[]): string {
  return roles.map((role) => copy.roles[role]).join(" · ");
}

function lastRunText(automation: FolderAutomationView): string {
  if (!automation.lastRun) return copy.notRunYet;
  const text = copy.lastRun(formatAutomationDateTime(automation.lastRun.at));
  return automation.lastRun.outcome === "failed" ? `${text} · ${copy.failed}` : text;
}

function stateClass(state: FolderAutomationState): string {
  return ({ on: "enabled", off: "disabled", running: "running", suspended: "suspended", completed: "completed" } as const)[state];
}
