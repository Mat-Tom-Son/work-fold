import type { ClipboardContent } from "../../src/shared/clipboard.js";

/** Validate before touching the OS clipboard. The caller must authorize its IPC sender. */
export function writeDesktopClipboard(value: unknown, write: (content: ClipboardContent) => void): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid clipboard content.");
  const content = value as Record<string, unknown>;
  if (Object.keys(content).some((key) => key !== "text" && key !== "html")
    || typeof content.text !== "string"
    || (content.html !== undefined && typeof content.html !== "string")) {
    throw new Error("Invalid clipboard content.");
  }
  write({ text: content.text, ...(typeof content.html === "string" ? { html: content.html } : {}) });
}
