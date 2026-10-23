/**
 * The address of the link under the pointer, shown at the bottom-left of a
 * browser page the way Chrome does (docs/built-in-browser.md). The page is a
 * native view above the app's own UI, so the bubble is a small native view of
 * its own, raised above the page, with no script of its own.
 */
import { WebContentsView, nativeTheme, type BrowserWindow, type Rectangle } from "electron";

const height = 24;
const minimumWidth = 80;
const characterWidth = 6.6;
const padding = 20;

export class BrowserStatusBubble {
  #view: WebContentsView | null = null;
  #window: BrowserWindow | null = null;
  #generation = 0;

  /**
   * Shows `text` over the bottom-left corner of `page`, a rectangle in the
   * window's content, or the bottom-right when the pointer is in that corner,
   * so the bubble never covers the link it describes.
   */
  show(window: BrowserWindow, page: Rectangle, text: string, pointer?: { x: number; y: number }): void {
    const generation = ++this.#generation;
    const view = this.#ensureView();
    if (this.#window && this.#window !== window) this.#detach();
    const width = Math.round(Math.min(Math.max(minimumWidth, text.length * characterWidth + padding), Math.max(minimumWidth, page.width * 0.6)));
    const left = { x: page.x, y: page.y + page.height - height, width, height };
    if (left.y < page.y || page.width < minimumWidth) return;
    const covered = pointer && pointer.x <= left.x + left.width + height && pointer.y >= left.y - height;
    const bounds = covered ? { ...left, x: page.x + page.width - width } : left;
    void view.webContents.loadURL(bubbleDocument(text, nativeTheme.shouldUseDarkColors, covered ? "right" : "left")).then(() => {
      if (generation !== this.#generation || window.isDestroyed() || view.webContents.isDestroyed()) return;
      view.setBounds(bounds);
      // Added last, so it sits above the page it describes.
      window.contentView.addChildView(view);
      this.#window = window;
      view.setVisible(true);
    }).catch(() => undefined);
  }

  hide(): void {
    this.#generation += 1;
    this.#detach();
  }

  close(): void {
    this.hide();
    const view = this.#view;
    this.#view = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  #detach(): void {
    if (!this.#view) return;
    this.#view.setVisible(false);
    if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(this.#view);
    this.#window = null;
  }

  #ensureView(): WebContentsView {
    if (this.#view && !this.#view.webContents.isDestroyed()) return this.#view;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        javascript: false,
        images: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());
    this.#view = view;
    return view;
  }
}

function bubbleDocument(text: string, dark: boolean, side: "left" | "right"): string {
  const background = dark ? "#35363a" : "#f1f3f4";
  const border = dark ? "#5f6368" : "#dadce0";
  const foreground = dark ? "#e8eaed" : "#202124";
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body {
      display: flex;
      align-items: center;
      padding: 0 8px;
      color: ${foreground};
      background: ${background};
      border: 1px solid ${border};
      border-radius: ${side === "left" ? "0 6px 0 0" : "6px 0 0 0"};
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
    }
    span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body><span>${escapeHtml(text)}</span></body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
