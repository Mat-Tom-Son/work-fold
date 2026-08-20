import { BrowserWindow, screen, type Rectangle } from "electron";

import { trayPopoverToggleAction } from "./tray-popover-toggle.js";

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
  #lastBlurHiddenAt: number | null = null;
  #pendingShow: Promise<void> | null = null;

  constructor(options: ManagementPopoverOptions) {
    this.#options = options;
  }

  isVisible(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isVisible());
  }

  async toggle(anchor: Rectangle | null): Promise<void> {
    // The click that dismisses the popover blurs it first, and the blur
    // handler hides it, so a naive toggle would observe "hidden" and re-show
    // the popover the person just closed (see tray-popover-toggle.ts).
    const action = trayPopoverToggleAction(
      { visible: this.isVisible(), lastBlurHiddenAt: this.#lastBlurHiddenAt },
      Date.now(),
    );
    if (action === "suppress") {
      // Consumed: the very next click means "open it again".
      this.#lastBlurHiddenAt = null;
      return;
    }
    if (action === "hide") {
      this.hide();
      return;
    }
    await this.show(anchor);
  }

  async show(anchor: Rectangle | null): Promise<void> {
    if (this.#destroyed) return;
    // A second tray event while the first cold open is still loading must not
    // start a second show/focus pass over the same window.
    if (this.#pendingShow) return this.#pendingShow;
    this.#pendingShow = (async () => {
      const window = await this.#ensureWindow();
      if (this.#destroyed || window.isDestroyed()) return;
      window.setPosition(...popoverPosition(anchor));
      window.show();
      if (process.platform === "darwin") {
        // The popover is a nonactivating panel: show() alone grants it key
        // status. window.focus() would also request app activation, and
        // activating the app raises the main window behind the popover —
        // summoning the menu-bar surface must not front the rest of work-fold
        // or steal the previous app's active state.
        window.webContents.focus();
      } else {
        window.focus();
      }
    })();
    try {
      await this.#pendingShow;
    } finally {
      this.#pendingShow = null;
    }
  }

  hide(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
  }

  /**
   * Creates and loads the hidden window ahead of the first summon so the
   * first tray click paints the ready surface instead of a loading beat.
   */
  async warm(): Promise<void> {
    if (this.#destroyed || this.#window) return;
    await this.#ensureWindow();
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
      // A nonactivating macOS panel takes key status (typing works) without
      // activating the app, so opening the popover never raises the main
      // window behind it, and hiding it hands focus straight back to the app
      // the person was using.
      ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
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
      // skipTransformProcessType is required: without it Electron transforms
      // the whole app to a UIElementApplication the moment this window is
      // created — the Dock icon disappears, the app is forcibly deactivated
      // (which blurs and instantly hides the freshly shown popover), and the
      // later transform back re-activates work-fold and fronts the main
      // window at an arbitrary moment.
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    this.#options.configureNavigation(window);
    window.on("blur", () => {
      if (window.isDestroyed() || window.webContents.isDevToolsOpened()) return;
      // Arm the tray-click grace only for blur-caused hides: if the window is
      // already hidden this blur is the tail of a programmatic hide (Escape,
      // Open work-fold), and suppressing the next tray click would swallow a
      // deliberate reopen.
      if (!window.isVisible()) return;
      this.#lastBlurHiddenAt = Date.now();
      this.hide();
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
