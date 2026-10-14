import { useState } from "react";
import { Check } from "lucide-react";

import { useModalDialog } from "../../hooks/useModalDialog";
import { ConnectAi, type ConnectedAi } from "../onboarding/ConnectAi";

/** The Connect your AI dialog any surface can open with requestConnectAi() (2026-10-11). */
export function ConnectAiDialog({ onClose, onConnected, onOpenSettings, fixtureMode = false }: {
  onClose: () => void;
  onConnected: (connected: ConnectedAi) => void;
  onOpenSettings: () => void;
  fixtureMode?: boolean;
}) {
  const [connected, setConnected] = useState<ConnectedAi | null>(null);
  const dialogRef = useModalDialog({ onClose });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="connect-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-ai-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div><h2 id="connect-ai-title">Connect your AI</h2></div>
          <button className="ui-control ui-control--quiet" type="button" onClick={onClose}>Close</button>
        </div>
        {connected ? (
          <div className="connect-ai-dialog-done">
            <p className="onboarding-connected" role="status"><Check size={18} aria-hidden="true" />Connected to {connected.providerName}{connected.modelName ? `. Your Workers will use ${connected.modelName}.` : "."}</p>
            <div className="connect-ai-key-actions"><button className="ui-control ui-control--primary" type="button" autoFocus onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <>
            <p className="connect-ai-dialog-intro">Your Workers think with an AI model from a provider you choose. Sign in with an account you already have, or paste an API key.</p>
            <ConnectAi
              fixtureMode={fixtureMode}
              onOpenSettings={onOpenSettings}
              onConnected={(result) => { setConnected(result); onConnected(result); }}
            />
          </>
        )}
      </section>
    </div>
  );
}
