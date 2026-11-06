import { useEffect, useRef } from "react";
import { Dismiss20Regular, ChevronRight20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { workFolderIdentityStyle } from "../../lib/work-folder-identity";
import { WorkFolderAppearancePanel, WorkFolderNameEditor } from "../panes/workFolderChrome";
import type { WorkFolderSummary } from "../../types";

export type WorkFolderAppearanceSection = "banner" | "title" | "icon" | "color";

export function WorkFolderAppearanceModal({ onRenameWorkFolder, onClose, onOpenWorkerSettings, initialSection = "banner", ...appearance }: Omit<Parameters<typeof WorkFolderAppearancePanel>[0], "activeSection"> & {
  onRenameWorkFolder: (workFolder: WorkFolderSummary, name: string) => Promise<void>;
  onClose: () => void;
  initialSection?: WorkFolderAppearanceSection;
  onOpenWorkerSettings?: (section: "model" | "instructions", returnSection: WorkFolderAppearanceSection) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  const sections = ["banner", "title", "icon", "color"] as const;
  // One scrolling page (2026-11-05): opening at a section scrolls to it.
  useEffect(() => {
    if (initialSection === "banner") return;
    document.getElementById(`folder-appearance-section-${initialSection}`)?.scrollIntoView({ block: "start" });
  }, [initialSection]);
  /** The section at the top of the page, so Settings can bring the person back to it. */
  function sectionInView(): WorkFolderAppearanceSection {
    const scroller = dialogRef.current?.querySelector<HTMLElement>(".work-folder-appearance-sections");
    const top = (scroller?.getBoundingClientRect().top ?? 0) + 24;
    return [...sections].reverse().find((section) => (document.getElementById(`folder-appearance-section-${section}`)?.getBoundingClientRect().top ?? Infinity) <= top) ?? "banner";
  }

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
          <button ref={closeRef} className="ui-control ui-control--icon" type="button" onClick={onClose} aria-label="Close Customize work-folder"><Dismiss20Regular /></button>
        </header>
        <div className="work-folder-appearance-modal-body">
          <div className="work-folder-appearance-surface-heading">
            <WorkFolderNameEditor workFolder={appearance.workFolder} onRenameWorkFolder={onRenameWorkFolder} />
          </div>
          <WorkFolderAppearancePanel {...appearance} />
        </div>
        {onOpenWorkerSettings ? <footer className="work-folder-customize-worker">
          <button type="button" onClick={() => onOpenWorkerSettings("model", sectionInView())}>Model<ChevronRight20Regular /></button>
          <button type="button" onClick={() => onOpenWorkerSettings("instructions", sectionInView())}>Instructions<ChevronRight20Regular /></button>
        </footer> : null}
      </section>
    </div>
  );
}
