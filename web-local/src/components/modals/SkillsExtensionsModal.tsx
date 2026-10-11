import { useState } from "react";
import { Dismiss20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { CapabilitiesPane } from "../panes/CapabilitiesPane";
import type { AgentCatalog, AgentStatus, SkillsExtensionsView, WorkFolderSummary } from "../../types";

/**
 * Skills & Extensions as a popup like Settings (2026-09-25). The rail's Add
 * button opens it for the work-folder that was active, and "This work-folder only"
 * keeps meaning that work-folder for as long as the popup is open.
 */
export function SkillsExtensionsModal({ workFolder, status, initialView, fixtureMode = false, onError, onCatalogChanged, onClose }: {
  workFolder: WorkFolderSummary;
  status: AgentStatus;
  initialView: SkillsExtensionsView;
  fixtureMode?: boolean;
  onError: (message: string | null) => void;
  onCatalogChanged?: (catalog: AgentCatalog) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<SkillsExtensionsView>(initialView);
  const dialogRef = useModalDialog({ onClose });
  return (
    <div className="modal-backdrop skills-extensions-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="skills-extensions-modal" role="dialog" aria-modal="true" aria-label="Skills & Extensions" onMouseDown={(event) => event.stopPropagation()}>
        <button className="ui-control ui-control--icon skills-extensions-close" type="button" onClick={onClose} aria-label="Close Skills & Extensions"><Dismiss20Regular /></button>
        <CapabilitiesPane
          workFolder={workFolder}
          status={status}
          view={view}
          fixtureMode={fixtureMode}
          onViewChange={setView}
          onError={onError}
          onCatalogChanged={onCatalogChanged}
        />
      </section>
    </div>
  );
}
