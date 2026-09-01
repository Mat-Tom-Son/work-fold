import type { SpaceSummary } from "../types";

export function spaceHeaderSourceBadgeLabel(space: SpaceSummary): string {
  if (space.location.providerHint === "google-drive") return "Google Drive";
  return space.location.storage === "linked" ? "Linked folder" : "On this computer";
}

export function slugId(value: string): string {
  return surfaceDomIdSuffix(value.trim().toLowerCase().replace(/\s+/g, "-"));
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

export interface SpaceAppStudioRemovalSummary {
  project: unknown | null;
  previews: readonly unknown[];
  releases: readonly unknown[];
  operations: readonly unknown[];
  incomingPreparedOperationCount?: number;
}

export function removeSpaceConfirmText(
  space: SpaceSummary,
  appStudio?: SpaceAppStudioRemovalSummary,
): string {
  const folderOutcome = space.location.storage === "linked"
    ? `Remove ${space.name} from work-fold? The original folder and everything inside it will stay on your computer.`
    : `Delete ${space.name} from this computer? This permanently deletes the managed Space folder, every file and folder inside it, and its local chat history. This cannot be undone.`;
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
    consequences.push(`This also cancels ${formatRemovalCount(appStudio.incomingPreparedOperationCount, "prepared App operation")} aimed at this Space.`);
  }
  return consequences.length ? `${folderOutcome} ${consequences.join(" ")}` : folderOutcome;
}

export function removeWorkFoldActionLabel(space: SpaceSummary): string {
  return space.location.storage === "linked" ? `Remove ${space.name}` : `Delete ${space.name}`;
}

function formatRemovalCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
