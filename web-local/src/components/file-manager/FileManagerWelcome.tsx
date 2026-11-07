import { useRef, useState } from "react";
import { Checkmark16Regular, ChevronRight16Regular, FolderAdd20Regular, FolderOpen20Regular, Globe20Regular, CursorClick20Regular, WindowConsole20Regular } from "@fluentui/react-icons";

import "./file-manager.css";
import "./file-manager-dialogs.css";
import type { AgentStatus } from "../../types";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { ConnectAi, type ConnectedAi } from "../onboarding/ConnectAi";
import { useMacTools, type MacTool } from "../onboarding/OnboardingFlow";
import { IncludedChromeSetup } from "../panes/IncludedChromeSetup";
import { IncludedComputerSetup } from "../panes/IncludedComputerSetup";
import { CommandLinePane } from "../modals/CommandLinePane";
import { productIdentity } from "../../../../src/shared/product-identity";
import { StandardFolderGlyph } from "./file-manager-glyphs";
import { useStandardFolders } from "./useFileManagerPlaces";

type Step = "welcome" | "connect" | "tools" | "folder";

/** What putting each Standard Folder to work is good for, in a few words. */
const standardFolderPitch: Record<string, string> = {
  downloads: "Sort what you download, and keep it tidy",
  documents: "Find, sum up, and organize your documents",
  desktop: "Clear the clutter and file what’s there",
  pictures: "Name, sort, and find your pictures",
};

/**
 * First run in the file manager (owner request, 2026-11-07): the same steps as
 * the classic first run (what work-fold is, connecting an AI, the Mac tools,
 * the first folder), shown in a file manager window, as macOS's Setup
 * Assistant shows its steps in a window. The sidebar already lists the
 * Standard Folders, and the last step offers each one to put to work in one
 * click, beside Use Existing Folder and Create New work-folder.
 */
export function FileManagerWelcome({ agentConfigured, fixtureMode, onAiConnected, onPutToWork, onCreateWorkFolder, onOpenFolder, onOpenSettings }: {
  agentConfigured: boolean;
  fixtureMode: boolean;
  onAiConnected: (status: AgentStatus) => void;
  onPutToWork: (standardFolderId: string) => Promise<void>;
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onOpenSettings?: () => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [connected, setConnected] = useState<ConnectedAi | null>(null);
  const [openTool, setOpenTool] = useState<MacTool | "command-line" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const macTools = useMacTools(fixtureMode);
  const standard = useStandardFolders(fixtureMode);
  const startable = ["downloads", "documents", "desktop", "pictures"]
    .map((id) => standard.folders.find((folder) => folder.id === id && !folder.workFolderId))
    .filter((folder): folder is NonNullable<typeof folder> => Boolean(folder));
  const steps: Step[] = ["welcome", ...(agentConfigured && !connected ? [] : ["connect" as const]), ...(macTools.length || fixtureMode || window.workFoldDesktop?.commandLine ? ["tools" as const] : []), "folder"];
  const index = steps.indexOf(step);
  // Each step slides in from the side you went: Continue from the right, Back from the left.
  // Kept until the step changes again, so an unrelated re-render never replays it.
  const stepMotionRef = useRef<{ index: number; from: "left" | "right" | "none" }>({ index, from: "none" });
  if (stepMotionRef.current.index !== index) stepMotionRef.current = { index, from: index > stepMotionRef.current.index ? "right" : "left" };
  const stepFrom = stepMotionRef.current.from;
  const next = () => setStep(steps[Math.min(index + 1, steps.length - 1)]!);
  const back = () => setStep(steps[Math.max(index - 1, 0)]!);

  async function putToWork(id: string) {
    setBusy(id);
    try { await onPutToWork(id); } finally { setBusy(null); }
  }

  return <div className="fm-shell fm-welcome-shell">
    <nav className="fm-sidebar" aria-label="Sidebar">
      <div className="fm-sidebar-inset" aria-hidden="true" />
      <div className="fm-sidebar-scroll">
        <div className="fm-sidebar-heading"><span>Standard Folders</span></div>
        <ul className="fm-sidebar-list">
          {standard.folders.filter((folder) => !folder.workFolderId).map((folder) => <li key={folder.id}>
            <div className="fm-sidebar-item is-static">
              <span className="fm-sidebar-icon"><StandardFolderGlyph id={folder.id} /></span>
              <span className="fm-sidebar-name">{folder.name}</span>
            </div>
          </li>)}
        </ul>
        <div className="fm-sidebar-heading"><span>work-folders</span></div>
        <p className="fm-welcome-none">None yet</p>
      </div>
    </nav>

    <section className="fm-main fm-welcome-main" aria-label="Welcome">
      <header className="fm-toolbar fm-welcome-toolbar">
        <h1 className="fm-title"><span className="fm-title-text">{step === "welcome" ? "Welcome" : step === "connect" ? "Connect Your AI" : step === "tools" ? "Your Mac" : "Your First Folder"}</span></h1>
      </header>

      <div className="fm-welcome-stage">
        <article className="fm-welcome-card" aria-live="polite">
          {steps.length > 1 ? <div className="fm-welcome-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((item, position) => <span key={item} className={`fm-welcome-dot${position === index ? " is-on" : position < index ? " is-done" : ""}`} />)}
          </div> : null}

          <div key={step} className="fm-welcome-step" data-from={stepFrom}>
          {step === "welcome" ? <>
            <WorkFoldLockup className="fm-welcome-lockup" />
            <h2>Put your folders to work</h2>
            <p>work-fold gives any folder on your Mac its own AI Worker. Ask it to sort, write, research, or build, right where your files live.</p>
          </> : null}

          {step === "connect" ? <>
            <h2>Connect Your AI</h2>
            {connected ? <>
              <p className="fm-welcome-ok"><Checkmark16Regular aria-hidden="true" />Connected to {connected.providerName}{connected.modelName ? `. Your Workers will use ${connected.modelName}.` : "."}</p>
              <p className="fm-welcome-note">You can change the model anytime in Settings → AI Models.</p>
            </> : <>
              <p>Your Workers think with an AI model from a provider you choose. Sign in with an account you already have, or paste an API key.</p>
              <div className="fm-welcome-connect">
                <ConnectAi fixtureMode={fixtureMode} onOpenSettings={onOpenSettings} onConnected={(result) => { setConnected(result); onAiConnected(result.status); }} />
              </div>
            </>}
          </> : null}

          {step === "tools" ? <>
            <h2>Let Your Worker Use Your Mac</h2>
            <p>Optional. When you ask, your Worker can browse with your own Chrome and use apps on your Mac, and other AI agents can use {productIdentity.productName} too. You can set these up later in Skills &amp; Extensions and Settings → Command Line.</p>
            <div className="fm-welcome-list">
              {macTools.map((tool) => <div key={tool} className={`fm-welcome-tool${openTool === tool ? " is-open" : ""}`}>
                <button type="button" className="fm-welcome-row" aria-expanded={openTool === tool} onClick={() => setOpenTool((current) => current === tool ? null : tool)}>
                  <span className="fm-welcome-row-icon">{tool === "chrome" ? <Globe20Regular /> : <CursorClick20Regular />}</span>
                  <span className="fm-welcome-row-text"><strong>{tool === "chrome" ? "Chrome" : "Computer Control"}</strong><span>{tool === "chrome" ? "Browse the web with your signed-in Chrome" : "See the screen and use apps"}</span></span>
                  <ChevronRight16Regular className="fm-welcome-chev" aria-hidden="true" />
                </button>
                {openTool === tool ? <div className="fm-welcome-tool-body">{tool === "chrome" ? <IncludedChromeSetup enabled /> : <IncludedComputerSetup enabled />}</div> : null}
              </div>)}
              {/* Other AI agents can use the app's command too (owner request, 2026-11-07). */}
              <div className={`fm-welcome-tool${openTool === "command-line" ? " is-open" : ""}`}>
                <button type="button" className="fm-welcome-row" aria-expanded={openTool === "command-line"} onClick={() => setOpenTool((current) => current === "command-line" ? null : "command-line")}>
                  <span className="fm-welcome-row-icon"><WindowConsole20Regular /></span>
                  <span className="fm-welcome-row-text"><strong>Other AI Agents</strong><span>Let Claude Code and Codex use {productIdentity.productName}</span></span>
                  <ChevronRight16Regular className="fm-welcome-chev" aria-hidden="true" />
                </button>
                {openTool === "command-line" ? <div className="fm-welcome-tool-body"><CommandLinePane compact fixtureMode={fixtureMode} /></div> : null}
              </div>
            </div>
          </> : null}

          {step === "folder" ? <>
            <h2>Pick a Folder to Start With</h2>
            <p>A Worker works inside one folder. Nothing moves; you can add more anytime.</p>
            <div className="fm-welcome-list">
              {startable.map((folder) => <button key={folder.id} type="button" className="fm-welcome-row" disabled={busy !== null} onClick={() => void putToWork(folder.id)}>
                <span className="fm-welcome-row-icon is-folder"><StandardFolderGlyph id={folder.id} /></span>
                <span className="fm-welcome-row-text"><strong>{folder.name}</strong><span>{standardFolderPitch[folder.id] ?? "Put this folder to work"}</span></span>
                <span className="fm-welcome-row-action">{busy === folder.id ? "Starting…" : "Put to Work"}</span>
              </button>)}
              <button type="button" className="fm-welcome-row" disabled={busy !== null} onClick={onOpenFolder}>
                <span className="fm-welcome-row-icon"><FolderOpen20Regular /></span>
                <span className="fm-welcome-row-text"><strong>Use Existing Folder…</strong><span>A folder you already have, anywhere on your Mac</span></span>
                <ChevronRight16Regular className="fm-welcome-chev" aria-hidden="true" />
              </button>
              <button type="button" className="fm-welcome-row" disabled={busy !== null} onClick={onCreateWorkFolder}>
                <span className="fm-welcome-row-icon"><FolderAdd20Regular /></span>
                <span className="fm-welcome-row-text"><strong>Create New work-folder…</strong><span>An empty folder work-fold keeps for you</span></span>
                <ChevronRight16Regular className="fm-welcome-chev" aria-hidden="true" />
              </button>
            </div>
            {!agentConfigured && !connected ? <p className="fm-welcome-note">No AI connected yet. Your Worker will offer to connect one when you need it.</p> : null}
          </> : null}

          </div>

          <footer className="fm-welcome-footer">
            {index > 0 ? <button type="button" className="fm-btn fm-welcome-back" onClick={back}>Back</button> : null}
            {step === "connect" && !connected ? <button type="button" className="fm-btn" onClick={next}>Skip for Now</button> : null}
            {step === "welcome" ? <button type="button" className="fm-btn is-primary" onClick={next} autoFocus>Get Started</button> : null}
            {step === "connect" && connected ? <button type="button" className="fm-btn is-primary" onClick={next} autoFocus>Continue</button> : null}
            {step === "tools" ? <button type="button" className="fm-btn is-primary" onClick={next}>Continue</button> : null}
          </footer>
        </article>
      </div>
    </section>
  </div>;
}
