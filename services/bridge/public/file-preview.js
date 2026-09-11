import { renderMarkdown } from "./markdown.js";

const mediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"]);

/** File bytes never become page HTML or an executable iframe. */
export function filePreviewMarkup(preview) {
  if (!preview || typeof preview !== "object") throw new Error("The file preview is unavailable.");
  if (preview.kind === "text" && typeof preview.text === "string" && preview.text.length <= 256 * 1024) {
    const body = preview.format === "markdown" ? `<div class="markdown">${renderMarkdown(preview.text)}</div>` : `<pre>${escape(preview.text)}</pre>`;
    return `${body}${preview.truncated ? '<p class="file-preview-note">Showing the first 256 KiB. Open the file on your desktop for the rest.</p>' : ""}`;
  }
  if (preview.kind === "image" && mediaTypes.has(preview.mediaType) && typeof preview.base64 === "string"
    && preview.base64.length <= 1_398_104 && preview.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.base64)) {
    return `<img class="file-preview-image" src="data:${preview.mediaType};base64,${preview.base64}" alt="${escape(preview.path)}" />`;
  }
  if (preview.kind === "none") return `<p class="file-preview-note">${preview.reason === "too-large" ? "This image is too large to preview here." : "This file type cannot be previewed here."} Open it on your desktop.</p>`;
  throw new Error("The file preview is unavailable.");
}

export function createFilePreview({ fetchPreview, available, online, container = null, askAboutFile = null, onClose = null }) {
  const dialog = document.createElement(container ? "section" : "dialog");
  dialog.className = container ? "file-preview-inline" : "file-preview-dialog";
  if (container) dialog.hidden = true;
  dialog.setAttribute("aria-labelledby", "file-preview-title");
  dialog.innerHTML = '<header><div><h2 id="file-preview-title"></h2><p class="file-preview-location"></p></div><button type="button" class="file-preview-close" aria-label="Close preview">✕</button></header><div class="file-preview-content" tabindex="0" aria-live="polite"></div><footer><span class="file-preview-status"></span><button class="quiet" type="button" data-refresh>Refresh</button></footer>';
  if (container) {
    dialog.querySelector("h2").id = "space-file-preview-title";
    dialog.setAttribute("aria-labelledby", "space-file-preview-title");
  }
  (container ?? document.body).append(dialog);
  if (askAboutFile) {
    const ask = document.createElement("button");
    ask.type = "button"; ask.className = "quiet"; ask.textContent = "Ask about this file";
    ask.addEventListener("click", () => { if (selected) askAboutFile({ ...selected }); });
    dialog.querySelector("footer").append(ask);
  }
  const content = dialog.querySelector(".file-preview-content");
  const status = dialog.querySelector(".file-preview-status");
  const refresh = dialog.querySelector("[data-refresh]");
  let selected = null;
  let version = 0;
  let opener = null;
  let opened = false;

  function clear() { version++; content.replaceChildren(); status.textContent = ""; }
  function close() {
    clear(); selected = null;
    opened = false;
    if (container) dialog.hidden = true;
    else if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  }
  async function load() {
    clear();
    if (!selected) return;
    refresh.disabled = true;
    if (!available()) { content.textContent = "Update work-fold on your desktop to preview files here."; return; }
    if (!online()) { content.textContent = "Desktop offline. Reconnect to preview this file."; return; }
    content.textContent = "Loading…";
    const requestVersion = version;
    const target = selected;
    try {
      const preview = await fetchPreview(target.spaceId, target.path);
      if (requestVersion !== version || !opened || !online()) return;
      if (preview.spaceId !== target.spaceId || preview.path !== target.path) throw new Error("The file preview does not match the selected file.");
      content.innerHTML = filePreviewMarkup(preview);
      const image = content.querySelector("img");
      image?.addEventListener("error", () => { if (requestVersion === version) content.textContent = "This image could not be displayed. Open it on your desktop."; }, { once: true });
      status.textContent = "Read-only preview";
    } catch (error) {
      if (requestVersion === version && opened) content.textContent = error instanceof Error ? error.message : "The file preview is unavailable.";
    } finally { if (requestVersion === version) refresh.disabled = !online(); }
  }
  dialog.querySelector(".file-preview-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  refresh.addEventListener("click", () => void load());
  return {
    async open(target) {
      opener = document.activeElement;
      selected = { ...target };
      dialog.querySelector("h2").textContent = target.path.split("/").at(-1);
      dialog.querySelector(".file-preview-location").textContent = `${target.spaceName} · ${target.path}`;
      opened = true;
      if (container) dialog.hidden = false;
      else if (!dialog.open) dialog.showModal();
      await load();
    },
    connectionChanged(connected) {
      if (!selected) return;
      clear();
      content.textContent = connected ? "Desktop reconnected. Refresh to read the current file." : "Desktop offline. Reconnect to preview this file.";
      refresh.disabled = !connected;
    },
    destroy() { close(); dialog.remove(); },
  };
}

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
