import { BrowserWindow, WebContentsView } from "electron";

import {
  parseRailTooltipRequest,
  railTooltipNativeBounds,
  type RailTooltipRequest,
} from "../../src/shared/rail-tooltip.js";

export class RailTooltipOverlay {
  readonly #parent: BrowserWindow;
  #view: WebContentsView | null = null;
  #attached = false;
  #visible = false;
  #generation = 0;

  constructor(parent: BrowserWindow) {
    this.#parent = parent;
  }

  show(value: unknown): void {
    const request = parseRailTooltipRequest(value);
    const generation = ++this.#generation;
    const view = this.#ensureView();
    this.#visible = false;
    view.setVisible(false);
    void view.webContents.loadURL(tooltipDocument(request)).then(() => {
      if (generation !== this.#generation || this.#parent.isDestroyed() || view.webContents.isDestroyed()) return;
      const contentBounds = this.#parent.getContentBounds();
      const bounds = railTooltipNativeBounds(
        request.bounds,
        { width: contentBounds.width, height: contentBounds.height },
        this.#parent.webContents.getZoomFactor(),
      );
      if (bounds.width < 1 || bounds.height < 1) return;
      view.setBounds(bounds);
      this.#visible = true;
      this.raise();
      view.setVisible(true);
    }).catch(() => {
      if (generation === this.#generation) this.hide();
    });
  }

  hide(): void {
    this.#generation += 1;
    this.#visible = false;
    if (!this.#view) return;
    this.#view.setVisible(false);
    if (this.#attached && !this.#parent.isDestroyed()) {
      this.#parent.contentView.removeChildView(this.#view);
      this.#attached = false;
    }
  }

  raise(): void {
    if (!this.#visible || !this.#view || this.#parent.isDestroyed() || this.#view.webContents.isDestroyed()) return;
    if (this.#attached) this.#parent.contentView.removeChildView(this.#view);
    this.#parent.contentView.addChildView(this.#view);
    this.#attached = true;
  }

  close(): void {
    this.hide();
    const view = this.#view;
    this.#view = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
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
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setBorderRadius(6);
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());
    this.#view = view;
    return view;
  }
}

function tooltipDocument(request: RailTooltipRequest): string {
  const background = request.theme === "dark" ? "#f5f6f8" : "#24272c";
  const foreground = request.theme === "dark" ? "#20242b" : "#ffffff";
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
      padding: 6px 8px;
      color: ${foreground};
      background: ${background};
      border-radius: 6px;
      font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
    }
    span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body><span>${escapeHtml(request.text)}</span></body>
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
