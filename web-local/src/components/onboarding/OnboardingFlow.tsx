import {
  ArrowRight,
  BatteryMedium,
  File,
  FolderOpen,
  FolderPlus,
  Link2,
  Send,
  Wifi,
} from "lucide-react";
import { WorkFoldLockup, WorkFoldMark } from "../brand/WorkFoldBrand";

export function OnboardingFlow({ onCreateSpace, onOpenFolder }: { onCreateSpace: () => void; onOpenFolder: () => void }) {
  return <main className="onboarding-flow">
    <section className="onboarding-choose" aria-labelledby="onboarding-title">
      <div className="onboarding-menubar-scene" role="img" aria-label="The work-fold menu-bar icon opens a small place to drop files, folders, or links and tell work-fold what to do.">
        <div className="onboarding-menubar-strip">
          <div className="onboarding-menubar-menus" aria-hidden="true">
            <strong>work-fold</strong><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span>
          </div>
          <div className="onboarding-menubar-status" aria-hidden="true">
            <span className="onboarding-menubar-fold"><WorkFoldMark /></span>
            <Wifi size={16} strokeWidth={2.2} />
            <BatteryMedium size={19} strokeWidth={2} />
            <small>2:00 PM</small>
          </div>
        </div>

        <span className="onboarding-menubar-pin" aria-hidden="true"><i /></span>

        <div className="onboarding-popover-preview">
          <header><WorkFoldLockup className="onboarding-popover-brand" /><span>Across your Spaces</span></header>
          <div className="onboarding-popover-drop">
            <span aria-hidden="true"><File size={17} /><Link2 size={16} /></span>
            <strong>Drop files, folders, or links</strong>
            <small>They wait here until you add an instruction.</small>
          </div>
          <div className="onboarding-popover-prompt"><span>Tell work-fold what to do</span><Send size={16} aria-hidden="true" /></div>
          <p><span>Close the main window whenever you like.</span><strong> Work keeps going.</strong></p>
        </div>
      </div>

      <div className="onboarding-identity">
        <WorkFoldLockup className="onboarding-brand" animated />
        <div className="onboarding-copy">
          <h1 id="onboarding-title">work-fold lives in your menu bar.</h1>
          <p>Click the fold—or drop something on it—from anywhere on your Mac.</p>
        </div>
      </div>

      <div className="onboarding-start">
        <span>Start with a folder</span>
        <div className="onboarding-choice-list">
          <button className="onboarding-choice-card onboarding-choice-primary" type="button" onClick={onOpenFolder}><span className="onboarding-choice-icon"><FolderOpen size={20} /></span><span className="onboarding-choice-copy"><strong>Use an existing folder</strong><span>Register it in place. Nothing moves.</span></span><ArrowRight className="onboarding-choice-arrow" size={18} /></button>
          <button className="onboarding-choice-card onboarding-choice-secondary" type="button" onClick={onCreateSpace}><span className="onboarding-choice-icon"><FolderPlus size={20} /></span><span className="onboarding-choice-copy"><strong>Create a new Space</strong><span>work-fold creates a new ordinary folder.</span></span><ArrowRight className="onboarding-choice-arrow" size={18} /></button>
        </div>
      </div>
    </section>
  </main>;
}
