/**
 * Tray/menu-bar toggle discipline for the management popover.
 *
 * Clicking the tray icon while the popover is open delivers two events: the
 * popover's blur (the mousedown lands outside it) and then the tray's click.
 * The blur handler hides the popover, so by the time the click's toggle runs
 * the popover already reads "hidden" — a naive toggle re-shows it, and the
 * icon can never close the popover (it flashes instead of dismissing). A
 * blur-hide inside the grace window before the click is therefore part of the
 * same gesture: the person wanted the popover closed, and the toggle must not
 * re-show it.
 *
 * The suppression is consumed by the toggle that observes it, so a deliberate
 * follow-up click (person closed it, then immediately wants it back) opens
 * the popover instead of being swallowed by the same stale timestamp.
 */
export const trayToggleBlurGraceMs = 300;

export type TrayPopoverToggleAction = "hide" | "suppress" | "show";

export interface TrayPopoverToggleState {
  /** Whether the popover window is currently visible. */
  visible: boolean;
  /**
   * When a blur-caused hide last ran, or null. Only blur hides arm this;
   * programmatic hides (Escape, Open work-fold) never suppress a tray click.
   */
  lastBlurHiddenAt: number | null;
}

export function trayPopoverToggleAction(
  state: TrayPopoverToggleState,
  now: number,
  graceMs: number = trayToggleBlurGraceMs,
): TrayPopoverToggleAction {
  if (state.visible) return "hide";
  if (state.lastBlurHiddenAt !== null) {
    const elapsed = now - state.lastBlurHiddenAt;
    // A negative elapsed means the clock moved backwards; treat the timestamp
    // as stale rather than suppressing an unbounded run of future clicks.
    if (elapsed >= 0 && elapsed <= graceMs) return "suppress";
  }
  return "show";
}
