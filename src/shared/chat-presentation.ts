/** Optional portable presentation data; the existing message content remains authoritative. */
export interface AssistantPresentation {
  version: 1;
  /** UTF-16 offsets into the unchanged ChatMessage.content string. */
  segments: AssistantPresentationSegment[];
  /** Some later segment boundaries were omitted because the metadata limit was reached. */
  truncated: boolean;
}

export interface AssistantPresentationSegment {
  start: number;
  end: number;
  kind: "progress" | "final" | "command";
  /** Turn-local chronology shared with work-trail rows; absent on legacy messages. */
  order?: number;
}

/** Selected native edit evidence, not a raw tool result or a currently live file preview. */
export interface ChatToolEdit {
  /** A validated work-folder-relative path, with portable forward slashes. */
  path: string;
  /** Pi's display diff at the time of the successful edit; never a runnable patch. */
  diff: string;
  firstChangedLine?: number;
  truncated: boolean;
}

export const maxAssistantPresentationSegments = 256;
/** An app title (80) plus " (preview): " and a tool name (64), with room to spare. */
export const maxChatToolTitleLength = 200;
export const maxChatToolEditDiffBytes = 16 * 1024;

/**
 * A picture generate_image made (2026-10-11), shown under the reply. The bytes
 * stay in work-fold's machine-local app state; the Chat log carries only this.
 */
export interface ChatToolImage {
  /** Machine-local generated-picture id: 32 lowercase hex characters. */
  id: string;
  /** The file name used when the picture is added to the folder. */
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** work-folder-relative path when the Worker saved it in the folder itself. */
  path?: string;
}
export const maxTurnToolEditDiffBytes = 64 * 1024;

export interface ChatWorkTrailEntry {
  kind: "thinking" | "tool";
  text: string;
  detail?: string;
  toolName?: string;
  /**
   * What to call a tool whose registered name is not readable, such as an
   * app's tool (`app_<hash>_search` → "Inbox: Search"). Display only;
   * `toolName` stays the identity.
   */
  toolTitle?: string;
  phase?: "queued" | "running" | "streaming" | "complete" | "error";
  edit?: ChatToolEdit;
  /** generate_image's picture, on a completed step. */
  image?: ChatToolImage;
  durationMs?: number;
  /** Assigned once at the first event for this row. */
  order?: number;
}

export interface ChatLiveWorkTrailEntry extends ChatWorkTrailEntry {
  /** Stable within one turn; never inferred from a renderer's clock. */
  id: string;
  /** Epoch milliseconds for a currently active thinking row. */
  startedAt?: number;
}

/** Transient read projection; a host restart does not resume this work. */
export interface ChatLiveTurnPresentation {
  text: string;
  assistantPresentation?: AssistantPresentation;
  workTrail: ChatLiveWorkTrailEntry[];
  truncated: boolean;
  textTruncated?: boolean;
}

/** Leaves room for the legacy text field in the 512 KiB stream queue. */
export const maxLiveTurnPresentationBytes = 192 * 1024;
