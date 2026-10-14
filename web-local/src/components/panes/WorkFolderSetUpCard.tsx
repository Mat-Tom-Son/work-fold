import { Dismiss16Regular } from "@fluentui/react-icons";

import type { WorkFolderSetUpMode } from "../../lib/work-folder-setup";

/** Offered once right after a work-folder is added; × dismisses it for good. */
export function WorkFolderSetUpCard({ workFolderName, onSetUp, onDismiss }: {
  workFolderName: string;
  onSetUp: (mode: WorkFolderSetUpMode) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="work-folder-setup-card" aria-label={`Set up ${workFolderName}`}>
      <button type="button" className="work-folder-setup-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <Dismiss16Regular aria-hidden="true" />
      </button>
      <strong>{workFolderName}</strong>
      <p>Your Worker can look over this folder and set it up for you.</p>
      <div className="work-folder-setup-actions">
        <button type="button" className="ui-control ui-control--primary" onClick={() => onSetUp("full")}>Set up for me</button>
        <button type="button" className="ui-control" onClick={() => onSetUp("look")}>Just the look</button>
      </div>
    </section>
  );
}
