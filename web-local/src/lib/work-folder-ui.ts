import type { WorkFolderSummary } from "../types";

export function workFolderHeaderSourceBadgeLabel(workFolder: WorkFolderSummary): string {
  if (workFolder.location.providerHint === "google-drive") return "Google Drive";
  return workFolder.location.storage === "linked" ? "Linked folder" : "On this computer";
}
export function surfaceDomIdSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `-${character.charCodeAt(0).toString(16)}-`);
}

export function surfaceTabDomId(tabId: string): string {
  return `surface-tab-${surfaceDomIdSuffix(tabId)}`;
}

export function surfacePanelDomId(tabId: string): string {
  return `surface-panel-${surfaceDomIdSuffix(tabId)}`;
}

export interface WorkFolderAppStudioRemovalSummary {
  project: unknown | null;
  previews: readonly unknown[];
  releases: readonly unknown[];
  operations: readonly unknown[];
  incomingPreparedOperationCount?: number;
}

export function removeWorkFolderConfirmText(
  workFolder: WorkFolderSummary,
  appStudio?: WorkFolderAppStudioRemovalSummary,
): string {
  const folderOutcome = workFolder.location.storage === "linked"
    ? `Remove ${workFolder.name} from work-fold? The original folder and everything inside it will stay on your computer.`
    : `Delete ${workFolder.name} from this computer? Its managed folder — every file and folder inside it, and its Chats and History — `
      + "moves to Recently Deleted in Settings, where you can put it back until its time runs out.";
  if (!appStudio) return folderOutcome;
  const consequences: string[] = [];
  if (appStudio.project) {
    const appState = [
      formatRemovalCount(appStudio.previews.length, "Development preview"),
      formatRemovalCount(appStudio.releases.length, "Release"),
      formatRemovalCount(appStudio.operations.length, "prepared operation"),
    ].join(", ");
    consequences.push(`This also permanently clears this computer's App Studio history for it (${appState}), including its receipts and unreferenced Release objects. Keeping the folder does not preserve that state.`);
  }
  if (appStudio.incomingPreparedOperationCount) {
    consequences.push(`This also cancels ${formatRemovalCount(appStudio.incomingPreparedOperationCount, "prepared App operation")} aimed at this work-folder.`);
  }
  return consequences.length ? `${folderOutcome} ${consequences.join(" ")}` : folderOutcome;
}
function formatRemovalCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
