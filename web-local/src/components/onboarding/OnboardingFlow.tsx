import { FolderOpen, FolderPlus } from "lucide-react";

export function OnboardingFlow({ onCreateWorkFolder, onOpenFolder }: { onCreateWorkFolder: () => void; onOpenFolder: () => void }) {
  return <main className="onboarding-flow">
    <section className="onboarding-choose" aria-label="Choose a folder">
      <div className="onboarding-actions">
        <button className="onboarding-folder-action" type="button" onClick={onOpenFolder}>
          <FolderOpen size={19} aria-hidden="true" />
          <span>Add existing folder</span>
        </button>
        <button className="onboarding-folder-action" type="button" onClick={onCreateWorkFolder}>
          <FolderPlus size={19} aria-hidden="true" />
          <span>Create new work-folder</span>
        </button>
      </div>
    </section>
  </main>;
}
