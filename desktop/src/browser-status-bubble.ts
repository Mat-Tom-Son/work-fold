/**
 * The address of the link under the pointer, shown at the bottom-left of a
 * browser page the way Chrome does (docs/built-in-browser.md). The page is a
 * native view above the app's own UI, so the bubble is a small native view of
 * its own, raised above the page. It loads once and stays in the window;
 * hovering only changes its text, place, and visibility, so moving across a
 * page full of links stays smooth.
 */
import { WebContentsView, nativeTheme, type BrowserWindow, type Rectangle } from "electron";

const height = 24;
const minimumWidth = 80;
const characterWidth = 6.6;
const padding = 20;
/** Moving from one link to the next keeps the bubble instead of flashing it. */
const hideDelayMs = 120;

export class BrowserStatusBubble {
  #view: WebContentsView | null = null;
  #ready: Promise<void> | null = null;
  #window: BrowserWindow | null = null;
  #generation = 0;
  #hideTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Shows `text` over the bottom-left corner of `page`, a rectangle in the
   * window's content, or the bottom-right when the pointer is in that corner,
   * so the bubble never covers the link it describes.
   */
  show(window: BrowserWindow, page: Rectangle, text: string, pointer?: { x: number; y: number }): void {
    this.#cancelHide();
    const generation = ++this.#generation;
    const width = Math.round(Math.min(Math.max(minimumWidth, text.length * characterWidth + padding), Math.max(minimumWidth, page.width * 0.6)));
    const left = { x: page.x, y: page.y + page.height - height, width, height };
    if (left.y < page.y || page.width < minimumWidth) {
      this.hide();
      return;
    }
    const covered = pointer && pointer.x <= left.x + left.width + height && pointer.y >= left.y - height;
    const side = covered ? "right" : "left";
    const bounds = covered ? { ...left, x: page.x + page.width - width } : left;
    const { view, ready } = this.#ensureView();
    void ready
      .then(() => view.webContents.executeJavaScript(`update(${JSON.stringify(text)}, ${JSON.stringify(side)}, ${nativeTheme.shouldUseDarkColors})`))
      .then(() => {
        if (generation !== this.#generation || window.isDestroyed() || view.webContents.isDestroyed()) return;
        if (this.#window !== window) {
          this.#detach();
          this.#window = window;
        }
        // The last child sits on top; a page laid out since then may have covered the bubble.
        if (window.contentView.children.at(-1) !== view) window.contentView.addChildView(view);
        view.setBounds(bounds);
        view.setVisible(true);
      })
      .catch(() => undefined);
  }

  /** The pointer left the link. */
  hideSoon(): void {
    if (this.#hideTimer) return;
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = null;
      this.hide();
    }, hideDelayMs);
    this.#hideTimer.unref?.();
  }

  /** The page went away or was covered: hide now. */
  hide(): void {
    this.#cancelHide();
    this.#generation += 1;
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.setVisible(false);
  }

  close(): void {
    this.hide();
    this.#detach();
    const view = this.#view;
    this.#view = null;
    this.#ready = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  #cancelHide(): void {
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  #detach(): void {
    if (!this.#view) return;
    this.#view.setVisible(false);
    if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(this.#view);
    this.#window = null;
  }

  #ensureView(): { view: WebContentsView; ready: Promise<void> } {
    if (this.#view && this.#ready && !this.#view.webContents.isDestroyed()) return { view: this.#view, ready: this.#ready };
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        images: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    this.#view = view;
    this.#ready = view.webContents.loadURL(bubbleDocument).then(() => undefined);
    return { view, ready: this.#ready };
  }
}

// The bubble's own page: no network and nothing from a site, only the text it is handed.
const bubbleDocument = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body {
      display: flex;
      align-items: center;
      padding: 0 8px;
      color: #202124;
      background: #f1f3f4;
      border: 1px solid #dadce0;
      border-radius: 0 6px 0 0;
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
    }
    body.right { border-radius: 6px 0 0 0; }
    body.dark { color: #e8eaed; background: #35363a; border-color: #5f6368; }
    span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body><span id="text"></span>
<script>
  function update(text, side, dark) {
    document.getElementById("text").textContent = text;
    document.body.className = side + (dark ? " dark" : "");
  }
</script>
</body>
</html>`)}`;
