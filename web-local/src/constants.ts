import { maxSpaceAppearanceBannerImageDataUrlLength, spaceAppearanceBannerNames } from "../../src/shared/space-appearance";
import type { AppTextSize, AppTypographyFont, AppTypographyPreference, CommandPaletteGroupId, SpaceBannerOption } from "./types";

export const productName = "work-fold";
export const assistantName = "Assistant";

export const desktopTitleBarMenus = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
] as const;

export const spaceFileRefreshDelayMs = 160;
export const loadedTreeRefreshConcurrency = 4;
export const agentActivityLogLimit = 200;
export const spacePathDragType = "application/x-work-fold-space-path";
export const themePreferenceKey = "work-fold.theme";
export const typographyPreferenceKey = "work-fold.typography.v1";
export const spaceSidebarWidthPreferenceKey = "work-fold.space.sidebar-width";
export const spaceSidebarPreferredMinWidth = 280;
export const spaceSidebarPreferredMaxWidth = 640;
export const spaceChatPreferredMinWidth = 430;
export const spacePaneResizeHandleWidth = 16;
export const spacePaneKeyboardStep = 24;
export const spacePaneKeyboardLargeStep = 64;
export const chatDraftKeyPrefix = "work-fold.space.chat-draft";
export const chatDraftNewConversationId = "new-chat";
export const chatDraftDebounceMs = 300;
export const chatDraftMaxStoredChars = 20_000;
export const apiGetRetryDelaysMs = [500, 1_500, 3_500] as const;
export const eventStreamReconnectDelaysMs = [250, 750, 1_500, 3_000, 5_000] as const;
export const localDeleteUndoDurationMs = 6_000;
export const defaultTypographyPreference: AppTypographyPreference = { font: "default", textSize: "standard" };
export const typographyFontValues: AppTypographyFont[] = ["default", "stable", "verdana", "aptos"];
export const textSizeValues: AppTextSize[] = ["compact", "standard", "comfortable"];
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
export const textSizeOptions: Array<{ value: AppTextSize; label: string; detail: string }> = [
  { value: "compact", label: "Compact", detail: "14 px" },
  { value: "standard", label: "Standard", detail: "15 px" },
  { value: "comfortable", label: "Comfortable", detail: "16 px" },
];
export const untitledChatLabel = "Untitled chat";
export const commandPaletteGroupOrder: CommandPaletteGroupId[] = ["go-to", "switch-space", "chats", "files", "actions"];
export const commandPaletteGroupCap = 8;
export const commandPaletteOverallCap = 24;
export const runtimeThinkingFallbackTitle = "Working through the request";
export const genericChatEmptyGreetings = [
  "What should we work on?",
  "Ready when you are.",
  "Where should we start?",
  "New chat, clean slate.",
  "Let's make some progress.",
];
export const spaceCustomizationStorageKey = "work-fold.space.appearance.v1";
export const defaultSpaceBannerName = "classic";
export const maxSpaceBannerImageDataUrlLength = maxSpaceAppearanceBannerImageDataUrlLength;
export const maxSpaceBannerImageFileBytes = 12 * 1024 * 1024;
export const spaceBannerOptions: SpaceBannerOption[] = spaceAppearanceBannerNames.map((name) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
}));
