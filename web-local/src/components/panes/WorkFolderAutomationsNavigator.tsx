import { ChevronRight16Regular, Flash20Regular } from "@fluentui/react-icons";

import { folderAutomations as copy } from "../../ui-contract";
import type { FolderAutomationView } from "../../../../src/shared/automation-presentation";
import { lastRunText, stateClass } from "./WorkFolderAutomationsPane";

/**
 * The Automations list in the left pane (2026-10-11): like Files, the rail
 * button shows it, and clicking an automation opens that automation's tab.
 */
export function WorkFolderAutomationsNavigator({
  automations,
  activeAutomationId,
  onOpen,
  onOpenAllAutomations,
}: {
  /** Undefined until the first read of this work-folder settles. */
  automations: FolderAutomationView[] | undefined;
  activeAutomationId: string | null;
  onOpen: (automation: FolderAutomationView) => void;
  onOpenAllAutomations: () => void;
}) {
  return (
    <div className="work-folder-pane-content history-pane professional-surface professional-history automations-navigator">
      <div className="history-pane-actions">
        <div className="history-title"><h2>{copy.rail}</h2>{automations ? <span>{copy.count(automations.length)}</span> : null}</div>
      </div>
      <div className="history-journal">
        {automations && !automations.length ? (
          <div className="professional-empty-state">
            <span className="professional-empty-icon" aria-hidden="true"><Flash20Regular /></span>
            <div><h2>{copy.noneLeft}</h2></div>
          </div>
        ) : null}
        {automations?.length ? (
          <div>
            {automations.map((automation) => {
              const current = automation.automationId === activeAutomationId;
              return (
                <button
                  className={current ? "history-entry selected" : "history-entry"}
                  type="button"
                  key={automation.automationId}
                  aria-current={current ? "true" : undefined}
                  aria-label={copy.open(automation.title)}
                  onClick={() => onOpen(automation)}
                >
                  <span className={`automation-health ${stateClass(automation.state)}`}>{copy.states[automation.state]}</span>
                  <span><strong>{automation.title}</strong><small>{lastRunText(automation)}</small></span>
                  <ChevronRight16Regular aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <footer className="folder-automations-footer">
        <button className="ui-control ui-control--quiet" type="button" onClick={onOpenAllAutomations}>{copy.allAutomations}</button>
      </footer>
    </div>
  );
}
