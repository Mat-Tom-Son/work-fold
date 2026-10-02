import { useRef, useState } from "react";
import { Dismiss20Regular, ChevronRight20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { spaceIdentityStyle } from "../../lib/space-identity";
import { SpaceAppearancePanel, SpaceNameEditor } from "../panes/spaceChrome";
import type { SpaceSummary } from "../../types";

export type SpaceAppearanceSection = "banner" | "icon" | "color";

export function SpaceAppearanceModal({ onRenameSpace, onClose, onOpenWorkerSettings, initialSection = "banner", ...appearance }: Omit<Parameters<typeof SpaceAppearancePanel>[0], "activeSection"> & {
  onRenameSpace: (space: SpaceSummary, name: string) => Promise<void>;
  onClose: () => void;
  initialSection?: SpaceAppearanceSection;
  onOpenWorkerSettings?: (section: "model" | "instructions", returnSection: SpaceAppearanceSection) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  const sections = ["banner", "icon", "color"] as const;
  const [activeSection, setActiveSection] = useState<SpaceAppearanceSection>(initialSection);

  return (
    <div className="modal-backdrop space-appearance-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="space-appearance-surface professional-appearance-surface space-appearance-modal"
        style={spaceIdentityStyle(appearance.identity)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-appearance-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="space-appearance-modal-title">
          <h2 id="space-appearance-title">Customize work-folder</h2>
          <div className="space-appearance-tabs" role="tablist" aria-label="work-folder appearance" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = sections.indexOf(activeSection);
            const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
            setActiveSection(sections[next]);
            document.getElementById(`folder-appearance-tab-${sections[next]}`)?.focus();
          }}>
            {sections.map((section) => <button type="button" role="tab" key={section} id={`folder-appearance-tab-${section}`} aria-selected={activeSection === section} aria-controls={`folder-appearance-panel-${section}`} tabIndex={activeSection === section ? 0 : -1} onClick={() => setActiveSection(section)}>{section[0]!.toUpperCase() + section.slice(1)}</button>)}
          </div>
          <button ref={closeRef} className="minimal-icon-button" type="button" onClick={onClose} aria-label="Close Customize work-folder"><Dismiss20Regular /></button>
        </header>
        <div className="space-appearance-modal-body">
          <div className="space-appearance-surface-heading">
            <SpaceNameEditor space={appearance.space} onRenameSpace={onRenameSpace} />
          </div>
          <SpaceAppearancePanel {...appearance} activeSection={activeSection} />
        </div>
        {onOpenWorkerSettings ? <footer className="space-customize-worker">
          <button type="button" onClick={() => onOpenWorkerSettings("model", activeSection)}>Model<ChevronRight20Regular /></button>
          <button type="button" onClick={() => onOpenWorkerSettings("instructions", activeSection)}>Instructions<ChevronRight20Regular /></button>
        </footer> : null}
      </section>
    </div>
  );
}
