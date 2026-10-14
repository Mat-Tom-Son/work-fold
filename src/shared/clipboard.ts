/** Content supplied by an explicit Copy action; this bridge never reads the clipboard. */
export interface ClipboardContent {
  text: string;
  html?: string;
  /** A picture as a PNG or JPEG data URL, for Copy on a generated image (2026-10-11); copied alone, without the text. */
  image?: string;
}

/** Largest picture Copy carries across the desktop bridge. */
export const maxClipboardImageDataUrlLength = 48 * 1024 * 1024;

export function isClipboardImageDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= maxClipboardImageDataUrlLength
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value);
}

export interface ClipboardWriter {
  write(content: ClipboardContent): Promise<void>;
}
