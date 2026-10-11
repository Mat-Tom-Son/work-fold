import type { ClipboardContent } from "../../../src/shared/clipboard";

/** Desktop Copy belongs to the native host, including while a native menu owns focus. */
export async function copyToClipboard(content: ClipboardContent): Promise<void> {
  const native = window.workFoldDesktop?.clipboard ?? window.workFoldDiagnostics?.clipboard;
  if (native) {
    await native.write(content);
    return;
  }
  const browser = navigator.clipboard;
  if (content.image !== undefined && browser?.write && typeof ClipboardItem !== "undefined") {
    // A browser clipboard takes PNG pictures, which is what Copy on a generated image sends.
    // Decoded here: the renderer's connect-src policy refuses fetch() on a data: URL.
    const [header = "", data = ""] = content.image.split(",", 2);
    const type = header.slice("data:".length).split(";")[0] || "image/png";
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    await browser.write([new ClipboardItem({ [type]: new Blob([bytes], { type }) })]);
    return;
  }
  if (content.html !== undefined && browser?.write && typeof ClipboardItem !== "undefined") {
    try {
      await browser.write([new ClipboardItem({
        "text/html": new Blob([content.html], { type: "text/html" }),
        "text/plain": new Blob([content.text], { type: "text/plain" }),
      })]);
      return;
    } catch {
      // Some browser hosts support only plain text. Its failure must still reach the caller.
    }
  }
  if (!browser?.writeText) throw new Error("Clipboard access is unavailable. Select the text and copy it manually.");
  await browser.writeText(content.text);
}
