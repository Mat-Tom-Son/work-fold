import { useState } from "react";
import { Check, FolderOpen, FolderPlus } from "lucide-react";

import type { AgentStatus } from "../../types";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { ConnectAi, type ConnectedAi } from "./ConnectAi";

type OnboardingStep = "welcome" | "connect" | "folder";

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
  const steps: OnboardingStep[] = agentConfigured && !connected ? ["welcome", "folder"] : ["welcome", "connect", "folder"];
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

      {step === "folder" ? (
        <section className="onboarding-step onboarding-choose" aria-labelledby="onboarding-folder-title">
          <p className="onboarding-progress">Step {position} of {steps.length}</p>
          <h1 id="onboarding-folder-title">Pick a folder to start with</h1>
          <p>A Worker works inside one folder. You can add more anytime.</p>
          <div className="onboarding-actions" aria-label="Choose a folder" role="group">
            <button className="onboarding-folder-action" type="button" onClick={onOpenFolder}>
              <FolderOpen size={20} aria-hidden="true" />
              <strong>Add existing folder</strong>
              <span>Use a folder you already have. Nothing moves.</span>
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
