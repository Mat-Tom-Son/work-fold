import type { ChatContextPathRequest } from "../types";

export function chatContextRequestForTab(
  request: ChatContextPathRequest | null,
  workspaceId: string,
  surfaceTabId: string,
): ChatContextPathRequest | null {
  return request?.workspaceId === workspaceId && request.surfaceTabId === surfaceTabId
    ? request
    : null;
}
