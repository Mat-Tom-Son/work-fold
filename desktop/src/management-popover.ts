import { BrowserWindow, screen, type Rectangle } from "electron";

/**
 * The menu-bar/tray popover: a small always-available surface for the
 * management conversation. It is deliberately its own window, not a child of
 * the main window, because its whole point on macOS is to keep working after
 * the last window closes — work-fold stays alive in the menu bar and the
 * person can still hand it material and instructions.
 */
export interface ManagementPopoverStagedItem {
  kind: "path" | "text";
  value: string;
}

export interface ManagementPopoverOptions {
  appProtocol: string;
  preloadPath: string;
  additionalArguments: string[];
  backgroundColor: string;
  /** macOS gets the native menu material behind the popover. */
  vibrancy: boolean;
  devTools: boolean;
  configureNavigation: (window: BrowserWindow) => void;
  onError: (message: string) => void;
}

const popoverWidth = 400;
const popoverHeight = 560;
const popoverEdgeGap = 6;
const maxStagedItems = 16;
const maxStagedValueLength = 4_096;

export class ManagementPopover {
  #window: BrowserWindow | null = null;
  #options: ManagementPopoverOptions;
  #loaded = false;
  #pendingStaged: ManagementPopoverStagedItem[] = [];
  #destroyed = false;

  constructor(options: ManagementPopoverOptions) {
    this.#options = options;
  }

  isVisible(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isVisible());
  }

  async toggle(anchor: Rectangle | null): Promise<void> {
    if (this.isVisible()) {
      this.hide();
      return;
    }
    await this.show(anchor);
  }

  async show(anchor: Rectangle | null): Promise<void> {
    if (this.#destroyed) return;
    const window = await this.#ensureWindow();
    window.setPosition(...popoverPosition(anchor));
    window.show();
    window.focus();
  }

  hide(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
  }

  /** Queues dropped material for the renderer; delivered once it has loaded. */
  async stage(items: ManagementPopoverStagedItem[], anchor: Rectangle | null): Promise<void> {
    if (this.#destroyed || !items.length) return;
    const room = Math.max(0, maxStagedItems - this.#pendingStaged.length);
    const safe = items
      .filter((item) => item.value.length > 0 && item.value.length <= maxStagedValueLength)
      .slice(0, room);
    if (!safe.length) return;
    this.#pendingStaged.push(...safe);
    await this.show(anchor);
    this.#flushStaged();
  }

  destroy(): void {
    this.#destroyed = true;
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  async #ensureWindow(): Promise<BrowserWindow> {
    const existing = this.#window;
    if (existing && !existing.isDestroyed()) return existing;
    this.#loaded = false;
    const window = new BrowserWindow({
      width: popoverWidth,
      height: popoverHeight,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      ...(process.platform === "darwin" && this.#options.vibrancy
        ? { vibrancy: "menu" as const, visualEffectState: "active" as const, backgroundColor: "#00000000" }
        : { backgroundColor: this.#options.backgroundColor }),
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        devTools: this.#options.devTools,
        additionalArguments: this.#options.additionalArguments,
      },
    });
    this.#window = window;
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    this.#options.configureNavigation(window);
    window.on("blur", () => {
      if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) this.hide();
    });
    window.on("close", (event) => {
      if (this.#destroyed) return;
      event.preventDefault();
      this.hide();
    });
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    window.webContents.on("did-finish-load", () => {
      this.#loaded = true;
      this.#flushStaged();
    });
    try {
      await window.loadURL(`${this.#options.appProtocol}://app/popover.html`);
    } catch (error) {
      this.#options.onError(error instanceof Error ? error.message : String(error));
    }
    return window;
  }

  #flushStaged(): void {
    const window = this.#window;
    if (!this.#loaded || !window || window.isDestroyed() || !this.#pendingStaged.length) return;
    const items = this.#pendingStaged.splice(0, this.#pendingStaged.length);
    window.webContents.send("work-fold:management:staged", items);
  }
}

/**
 * Positions the popover near its anchor (the tray icon) inside the work area:
 * under a macOS menu-bar icon, above a Windows taskbar tray, and centered on
 * the primary display when no anchor is available.
 */
function popoverPosition(anchor: Rectangle | null): [number, number] {
  const display = anchor
    ? screen.getDisplayNearestPoint({ x: anchor.x + Math.round(anchor.width / 2), y: anchor.y + Math.round(anchor.height / 2) })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
    return [
      area.x + Math.round((area.width - popoverWidth) / 2),
      area.y + Math.round((area.height - popoverHeight) / 3),
    ];
  }
  let x = anchor.x + Math.round(anchor.width / 2) - Math.round(popoverWidth / 2);
  x = Math.min(Math.max(x, area.x + popoverEdgeGap), area.x + area.width - popoverWidth - popoverEdgeGap);
  const anchorCenterY = anchor.y + anchor.height / 2;
  const below = anchorCenterY < area.y + area.height / 2;
  const y = below
    ? Math.min(anchor.y + anchor.height + popoverEdgeGap, area.y + area.height - popoverHeight - popoverEdgeGap)
    : Math.max(anchor.y - popoverHeight - popoverEdgeGap, area.y + popoverEdgeGap);
  return [x, y];
}
