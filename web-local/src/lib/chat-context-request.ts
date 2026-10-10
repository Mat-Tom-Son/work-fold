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

export function appChangeDraft(change: RestrictedAppChangeDraft): string {
  return `Change ${change.title} (${change.version}) using the prepared copy in ${JSON.stringify(change.sourcePath)}. Keep its app and package identity, and submit the changed package for review.\n\nWhat I'd like to change: `;
}
