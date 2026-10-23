import { useEffect, useState } from "react";
import { Check, ChevronDown, FolderOpen, FolderPlus, Globe, MousePointerClick } from "lucide-react";

import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api } from "../../lib/api";
import { includedToolsPath } from "../../lib/included-tool-scope";
import type { AgentStatus } from "../../types";
import { IncludedChromeSetup } from "../panes/IncludedChromeSetup";
import { IncludedComputerSetup } from "../panes/IncludedComputerSetup";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { ConnectAi, type ConnectedAi } from "./ConnectAi";

type OnboardingStep = "welcome" | "connect" | "tools" | "folder";
type MacTool = "chrome" | "computer";

/**
 * First run (2026-10-11): what work-fold is, connecting an AI provider, then
 * the first folder. Connecting comes before the folder so the first thing a
 * Worker is asked to do, often Set up for me, can actually run. Skipping it
 * is fine: a work-folder is still a useful folder without AI.
 */
export function OnboardingFlow({ agentConfigured, onAiConnected, onCreateWorkFolder, onOpenFolder, onOpenSettings, fixtureMode = false }: {
  agentConfigured: boolean;
  onAiConnected: (status: AgentStatus) => void;
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onOpenSettings?: () => void;
  fixtureMode?: boolean;
}) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [connected, setConnected] = useState<ConnectedAi | null>(null);
  const macTools = useMacTools(fixtureMode);
  const [openTool, setOpenTool] = useState<MacTool | null>(null);
  const steps: OnboardingStep[] = [
    "welcome",
    ...(agentConfigured && !connected ? [] : ["connect" as const]),
    ...(macTools.length ? ["tools" as const] : []),
    "folder",
  ];
  const position = steps.indexOf(step) + 1;

  function next() {
    setStep(steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]!);
  }

  return (
    <main className="onboarding-flow">
      {step === "welcome" ? (
        <section className="onboarding-step onboarding-welcome" aria-labelledby="onboarding-welcome-title">
          <WorkFoldLockup className="onboarding-lockup" />
          <h1 id="onboarding-welcome-title">Put your folders to work</h1>
          <p>work-fold gives any folder on your Mac its own AI Worker. Ask it to sort, write, research, or build, right where your files live.</p>
          <button className="ui-control ui-control--primary onboarding-primary" type="button" onClick={next} autoFocus>Get started</button>
        </section>
      ) : null}

      {step === "connect" ? (
        <section className="onboarding-step onboarding-connect" aria-labelledby="onboarding-connect-title">
          <p className="onboarding-progress">Step {position} of {steps.length}</p>
          <h1 id="onboarding-connect-title">Connect your AI</h1>
          {connected ? (
            <>
              <p className="onboarding-connected" role="status"><Check size={18} aria-hidden="true" />Connected to {connected.providerName}{connected.modelName ? `. Your Workers will use ${connected.modelName}.` : "."}</p>
              <p className="onboarding-note">You can change the model anytime in Settings → AI Models.</p>
              <button className="ui-control ui-control--primary onboarding-primary" type="button" onClick={next} autoFocus>Continue</button>
            </>
          ) : (
            <>
              <p>Your Workers think with an AI model from a provider you choose. Sign in with an account you already have, or paste an API key.</p>
              <ConnectAi
                fixtureMode={fixtureMode}
                onOpenSettings={onOpenSettings}
                onConnected={(result) => { setConnected(result); onAiConnected(result.status); }}
              />
              <button className="onboarding-skip" type="button" onClick={next}>Skip for now</button>
            </>
          )}
        </section>
      ) : null}

      {step === "tools" ? (
        <section className="onboarding-step onboarding-tools" aria-labelledby="onboarding-tools-title">
          <p className="onboarding-progress">Step {position} of {steps.length}</p>
          <h1 id="onboarding-tools-title">Let your Worker use your Mac</h1>
          <p>Optional. When you ask, your Worker can browse with your own Chrome and use apps on your Mac. You can set these up later in Skills &amp; Extensions.</p>
          <div className="onboarding-tool-list">
            {macTools.map((tool) => (
              <div key={tool} className={`onboarding-tool${openTool === tool ? " open" : ""}`}>
                <button className="onboarding-tool-header" type="button" aria-expanded={openTool === tool} onClick={() => setOpenTool((current) => current === tool ? null : tool)}>
                  {tool === "chrome" ? <Globe size={18} aria-hidden="true" /> : <MousePointerClick size={18} aria-hidden="true" />}
                  <span><strong>{tool === "chrome" ? "Chrome" : "Computer Control"}</strong>{tool === "chrome" ? "Browse the web with your signed-in Chrome" : "See the screen and use apps"}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {openTool === tool ? <div className="onboarding-tool-body">{tool === "chrome" ? <IncludedChromeSetup enabled /> : <IncludedComputerSetup enabled />}</div> : null}
              </div>
            ))}
          </div>
          <button className="ui-control ui-control--primary onboarding-primary" type="button" onClick={next}>Continue</button>
        </section>
      ) : null}

      {step === "folder" ? (
        <section className="onboarding-step onboarding-choose" aria-labelledby="onboarding-folder-title">
          <p className="onboarding-progress">Step {position} of {steps.length}</p>
          <h1 id="onboarding-folder-title">Pick a folder to start with</h1>
          <p>A Worker works inside one folder. You can add more anytime.</p>
          <div className="onboarding-actions" aria-label="Choose a folder" role="group">
            <button className="onboarding-folder-action" type="button" onClick={onOpenFolder}>
              <FolderOpen size={20} aria-hidden="true" />
              <strong>Use existing folder</strong>
              <span>A folder you already have. Nothing moves.</span>
            </button>
            <button className="onboarding-folder-action" type="button" onClick={onCreateWorkFolder}>
              <FolderPlus size={20} aria-hidden="true" />
              <strong>Create new work-folder</strong>
              <span>Start with an empty folder work-fold keeps for you.</span>
            </button>
          </div>
          {!agentConfigured && !connected ? <p className="onboarding-note">No AI connected yet. Your Worker will offer to connect one when you need it.</p> : null}
        </section>
      ) : null}

      {step !== "welcome" ? <button className="onboarding-back" type="button" onClick={() => setStep(steps[Math.max(steps.indexOf(step) - 1, 0)]!)}>Back</button> : null}
    </main>
  );
}

/**
 * The included Mac tools first run can offer: Chrome when its extension is
 * available, and Computer Control on a Mac that supports it. None outside the
 * desktop app, where the tools are not included.
 */
function useMacTools(fixtureMode: boolean): MacTool[] {
  const [tools, setTools] = useState<MacTool[]>([]);
  useEffect(() => {
    if (fixtureMode) return;
    const controller = new AbortController();
    api<{ tools: IncludedToolStatus[] }>(includedToolsPath(), { signal: controller.signal })
      .then(({ tools: statuses }) => {
        const offered: MacTool[] = [];
        const chrome = statuses.find((item) => item.id === "chrome");
        if (chrome && chrome.chrome?.state !== "store_unavailable" && chrome.chrome?.state !== "connected") offered.push("chrome");
        const computer = statuses.find((item) => item.id === "computer");
        if (computer && computer.state !== "ready" && computer.facts?.supportedOS !== false) offered.push("computer");
        if (!controller.signal.aborted) setTools(offered);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [fixtureMode]);
  return tools;
}
