import type { ChatContextPathRequest } from "../types";

export function chatContextRequestForTab(
  request: ChatContextPathRequest | null,
  spaceId: string,
  surfaceTabId: string,
): ChatContextPathRequest | null {
  return request?.spaceId === spaceId && request.surfaceTabId === surfaceTabId
    ? request
    : null;
}
