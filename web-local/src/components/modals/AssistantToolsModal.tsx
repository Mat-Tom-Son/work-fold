import { useState } from "react";

import { useModalDialog } from "../../hooks/useModalDialog";
import { CapabilitiesPane } from "../panes/CapabilitiesPane";
import type { AgentCatalog, AgentStatus, AssistantToolsView, SpaceSummary } from "../../types";

/**
 * Skills & Extensions as a popup like Settings (2026-09-25). The rail's Add
 * button opens it for the Folder that was active, and "This folder only"
 * keeps meaning that Folder for as long as the popup is open.
 */
export function AssistantToolsModal({ space, status, initialView, fixtureMode = false, onOpenSettings, onError, onCatalogChanged, onClose }: {
  space: SpaceSummary;
  status: AgentStatus;
  initialView: AssistantToolsView;
  fixtureMode?: boolean;
  onOpenSettings: () => void;
  onError: (message: string | null) => void;
  onCatalogChanged?: (catalog: AgentCatalog) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<AssistantToolsView>(initialView);
  const dialogRef = useModalDialog({ onClose });
  return (
    <div className="modal-backdrop assistant-tools-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="assistant-tools-modal" role="dialog" aria-modal="true" aria-label="Skills & Extensions" onMouseDown={(event) => event.stopPropagation()}>
        <CapabilitiesPane
          space={space}
          status={status}
          view={view}
          fixtureMode={fixtureMode}
          onViewChange={setView}
          onOpenSettings={onOpenSettings}
          onError={onError}
          onCatalogChanged={onCatalogChanged}
          onClose={onClose}
        />
      </section>
    </div>
  );
}
