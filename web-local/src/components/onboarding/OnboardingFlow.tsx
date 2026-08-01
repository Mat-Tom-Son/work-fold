import { FolderOpen, HardDrive, Sparkles } from "lucide-react";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";

export function OnboardingFlow({ onCreateSpace, onOpenFolder }: { onCreateSpace: () => void; onOpenFolder: () => void }) {
  return <main className="onboarding-flow">
    <section className="onboarding-choose">
      <WorkFoldLockup className="onboarding-brand" animated />
      <div className="onboarding-copy"><h1>Turn your work into a Space.</h1><p>A Space is an ordinary folder with everything around it—Chats, a reusable Library, History, and Assistant tools.</p></div>
      <h2>How do you want to begin?</h2>
      <div className="onboarding-choice-list">
        <button className="onboarding-choice-card" type="button" onClick={onOpenFolder}><span className="onboarding-choice-icon"><FolderOpen size={24} /></span><span className="onboarding-choice-copy"><strong>Use a folder you already have</strong><span>Your files stay exactly where they are. work-fold adds the Space around them.</span></span></button>
        <button className="onboarding-choice-card" type="button" onClick={onCreateSpace}><span className="onboarding-choice-icon"><Sparkles size={24} /></span><span className="onboarding-choice-copy"><strong>Create a new Space</strong><span>Start clean with a new ordinary folder managed by work-fold.</span></span></button>
      </div>
      <p className="onboarding-helper"><HardDrive size={14} /> Local by default. Google Drive for desktop folders work too.</p>
    </section>
  </main>;
}
