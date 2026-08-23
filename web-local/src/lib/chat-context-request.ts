import type { ChatContextPathRequest, ChatDraftRequest } from "../types";

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
 * "app for this Space" and "submit it for review" are what the
 * propose_space_app tool guidance keys on, and the person finishes the
 * sentence with what the app should do.
 */
export function appBuildDraft(spaceName: string): string {
  return `Build a new app for this Space (${spaceName}). When it's ready, submit it for review.\n\nWhat it should do: `;
}
