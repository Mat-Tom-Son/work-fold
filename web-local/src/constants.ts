import { maxWorkFolderAppearanceBannerImageDataUrlLength, workFolderAppearanceBannerNames } from "../../src/shared/work-folder-appearance";
import type { AppTypographyFont, CommandPaletteGroupId, WorkFolderBannerOption } from "./types";

export const productName = "work-fold";

export const desktopTitleBarMenus = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
] as const;

export const workFolderFileRefreshDelayMs = 160;
export const loadedTreeRefreshConcurrency = 4;
export const workFolderPathDragType = "application/x-work-fold-work-folder-path";
export const workFolderSidebarWidthPreferenceKey = "work-fold.work-folder.sidebar-width";
export const workFolderSidebarPreferredMinWidth = 280;
export const workFolderSidebarPreferredMaxWidth = 640;
export const workFolderChatPreferredMinWidth = 430;
export const workFolderPaneResizeHandleWidth = 16;
export const workFolderPaneKeyboardStep = 24;
export const workFolderPaneKeyboardLargeStep = 64;
export const chatDraftKeyPrefix = "work-fold.work-folder.chat-draft";
export const chatDraftNewConversationId = "new-chat";
export const chatDraftDebounceMs = 300;
/** Drafts live in browser storage, which has a few megabytes for everything. */
export const chatDraftMaxStoredChars = 500_000;
export const apiGetRetryDelaysMs = [500, 1_500, 3_500] as const;
export const eventStreamReconnectDelaysMs = [250, 750, 1_500, 3_000, 5_000] as const;
export const typographyFontOptions: Array<{ value: AppTypographyFont; label: string; detail: string }> = [
  { value: "default", label: "Default", detail: "Inter" },
  { value: "stable", label: "Segoe UI", detail: "Non-variable" },
  { value: "verdana", label: "Verdana", detail: "Wide letters" },
  { value: "aptos", label: "Aptos", detail: "Document style" },
];
export function typographyFontOptionsForPlatform(platform: NodeJS.Platform | undefined): Array<{ value: AppTypographyFont; label: string; detail: string }> {
  if (platform !== "darwin") return typographyFontOptions;
  return typographyFontOptions.filter((option) => option.value !== "stable");
}
export const untitledChatLabel = "Untitled chat";
export const commandPaletteGroupOrder: CommandPaletteGroupId[] = ["go-to", "switch-work-folder", "chats", "files", "actions"];
export const commandPaletteGroupCap = 8;
export const commandPaletteOverallCap = 24;
export const genericChatEmptyGreetings = [
  "What should we work on?",
  "Ready when you are.",
  "Where should we start?",
  "New chat, clean slate.",
  "Let's make some progress.",
];
export const workFolderCustomizationStorageKey = "work-fold.work-folder.appearance.v1";
export const defaultWorkFolderBannerName = "classic";
export const maxWorkFolderBannerImageDataUrlLength = maxWorkFolderAppearanceBannerImageDataUrlLength;
export const maxWorkFolderBannerImageFileBytes = 12 * 1024 * 1024;
export const workFolderBannerOptions: WorkFolderBannerOption[] = workFolderAppearanceBannerNames.map((name) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
}));
