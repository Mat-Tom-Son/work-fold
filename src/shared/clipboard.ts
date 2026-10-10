/** Content supplied by an explicit Copy action; this bridge never reads the clipboard. */
export interface ClipboardContent {
  text: string;
  html?: string;
}

export interface ClipboardWriter {
  write(content: ClipboardContent): Promise<void>;
}
