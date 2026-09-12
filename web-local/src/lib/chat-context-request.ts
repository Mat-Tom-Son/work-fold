import type { ChatContextPathRequest, ChatDraftRequest } from "../types";
import type { RestrictedAppChangeDraft } from "./restricted-apps";

export function chatContextRequestForTab(
  request: ChatContextPathRequest | null,
  spaceId: string,
  surfaceTabId: string,
): ChatContextPathRequest | null {
  return request?.spaceId === spaceId && request.surfaceTabId === surfaceTabId
    ? request
    : null;
}

export function chatDraftRequestForTab(
  request: ChatDraftRequest | null,
  spaceId: string,
  surfaceTabId: string,
): ChatDraftRequest | null {
  return request?.spaceId === spaceId && request.surfaceTabId === surfaceTabId
    ? request
    : null;
}

/**
 * Starter text for building a Space app with the Assistant, in plain words:
 * The native proposal tool installs a completed local preview immediately;
 * the person finishes the sentence with what the app should do.
 */
export function appBuildDraft(spaceName: string): string {
  return `Build a new app for this Space (${spaceName}). When it's ready, install a local preview for me to try.\n\nWhat it should do: `;
}

export function appChangeDraft(change: RestrictedAppChangeDraft): string {
  return `Change ${change.title} (${change.version}) using the prepared copy in ${JSON.stringify(change.sourcePath)}. Keep its app and package identity, and submit the changed package for review.\n\nWhat I'd like to change: `;
}
