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
}

/** Selected native edit evidence, not a raw tool result or a currently live file preview. */
export interface ChatToolEdit {
  /** A validated Folder-relative path, with portable forward slashes. */
  path: string;
  /** Pi's display diff at the time of the successful edit; never a runnable patch. */
  diff: string;
  firstChangedLine?: number;
  truncated: boolean;
}

export const maxAssistantPresentationSegments = 256;
export const maxChatToolEditDiffBytes = 16 * 1024;
export const maxTurnToolEditDiffBytes = 64 * 1024;
