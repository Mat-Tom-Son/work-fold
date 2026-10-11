import { useRef, useState } from "react";
import { Dismiss20Regular, ChevronRight20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { workFolderIdentityStyle } from "../../lib/work-folder-identity";
import { WorkFolderAppearancePanel, WorkFolderNameEditor } from "../panes/workFolderChrome";
import type { WorkFolderSummary } from "../../types";

export type WorkFolderAppearanceSection = "banner" | "icon" | "color";

export function WorkFolderAppearanceModal({ onRenameWorkFolder, onClose, onOpenWorkerSettings, initialSection = "banner", ...appearance }: Omit<Parameters<typeof WorkFolderAppearancePanel>[0], "activeSection"> & {
  onRenameWorkFolder: (workFolder: WorkFolderSummary, name: string) => Promise<void>;
  onClose: () => void;
  initialSection?: WorkFolderAppearanceSection;
  onOpenWorkerSettings?: (section: "model" | "instructions", returnSection: WorkFolderAppearanceSection) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  const sections = ["banner", "icon", "color"] as const;
  const [activeSection, setActiveSection] = useState<WorkFolderAppearanceSection>(initialSection);

  return (
    <div className="modal-backdrop work-folder-appearance-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="work-folder-appearance-surface professional-appearance-surface work-folder-appearance-modal"
        style={workFolderIdentityStyle(appearance.identity)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-folder-appearance-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="work-folder-appearance-modal-title">
          <h2 id="work-folder-appearance-title">Customize work-folder</h2>
          <div className="work-folder-appearance-tabs" role="tablist" aria-label="work-folder appearance" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = sections.indexOf(activeSection);
            const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
            setActiveSection(sections[next]);
            document.getElementById(`folder-appearance-tab-${sections[next]}`)?.focus();
          }}>
            {sections.map((section) => <button type="button" role="tab" key={section} id={`folder-appearance-tab-${section}`} aria-selected={activeSection === section} aria-controls={`folder-appearance-panel-${section}`} tabIndex={activeSection === section ? 0 : -1} onClick={() => setActiveSection(section)}>{section[0]!.toUpperCase() + section.slice(1)}</button>)}
          </div>
          <button ref={closeRef} className="ui-control ui-control--icon" type="button" onClick={onClose} aria-label="Close Customize work-folder"><Dismiss20Regular /></button>
        </header>
        <div className="work-folder-appearance-modal-body">
          <div className="work-folder-appearance-surface-heading">
            <WorkFolderNameEditor workFolder={appearance.workFolder} onRenameWorkFolder={onRenameWorkFolder} />
          </div>
          <WorkFolderAppearancePanel {...appearance} activeSection={activeSection} />
        </div>
        {onOpenWorkerSettings ? <footer className="work-folder-customize-worker">
          <button type="button" onClick={() => onOpenWorkerSettings("model", activeSection)}>Model<ChevronRight20Regular /></button>
          <button type="button" onClick={() => onOpenWorkerSettings("instructions", activeSection)}>Instructions<ChevronRight20Regular /></button>
        </footer> : null}
      </section>
    </div>
  );
}
