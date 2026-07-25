import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  "[tabindex]",
].join(",");

interface IsolatedElementState {
  count: number;
  inert: boolean;
  ariaHidden: string | null;
}

const isolatedElements = new Map<HTMLElement, IsolatedElementState>();
const activeDialogs: HTMLElement[] = [];

export interface ModalDialogOptions {
  onClose: () => void;
  blocked?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
}

/**
 * Gives an in-tree modal the same keyboard and background-isolation contract as
 * a portal-backed dialog: focus enters the modal, cannot escape it, and returns
 * to the invoking control after close.
 */
export function useModalDialog({ onClose, blocked = false, initialFocusRef, restoreFocus = true }: ModalDialogOptions): RefObject<HTMLElement | null> {
  const dialogRef = useRef<HTMLElement>(null);
  // Capture during the opening render. In development, React Strict Mode
  // replays effects after the first isolation pass has already moved focus to
  // <body>; retaining the render-time target keeps restoration correct there
  // as well as in production.
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const onCloseRef = useRef(onClose);
  const blockedRef = useRef(blocked);
  onCloseRef.current = onClose;
  blockedRef.current = blocked;

  useEffect(() => {
    const mountedDialog = dialogRef.current;
    if (!mountedDialog) return;
    const dialog: HTMLElement = mountedDialog;
    const returnFocus = returnFocusRef.current;
    activeDialogs.push(dialog);
    focusDialogEntry(dialog, initialFocusRef);
    const releaseBackground = isolateDialogBackground(dialog);

    function isTopmostDialog(): boolean {
      return activeDialogs[activeDialogs.length - 1] === dialog;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (!isTopmostDialog()) return;
      if (event.key === "Escape") {
        if (blockedRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogFocusableElements(dialog);
      const currentIndex = focusable.findIndex((element) => element === document.activeElement);
      const targetIndex = nextDialogTabIndex(currentIndex, focusable.length, event.shiftKey);
      if (targetIndex === null) return;
      event.preventDefault();
      (focusable[targetIndex] ?? dialog).focus();
    }

    function containFocus(event: FocusEvent): void {
      if (!isTopmostDialog()) return;
      const target = event.target;
      if (target instanceof Node && dialog.contains(target)) return;
      focusDialogEntry(dialog, initialFocusRef);
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", containFocus, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus, true);
      const stackIndex = activeDialogs.lastIndexOf(dialog);
      if (stackIndex >= 0) activeDialogs.splice(stackIndex, 1);
      releaseBackground();
      if (!restoreFocus || !returnFocus?.isConnected) return;
      window.requestAnimationFrame(() => {
        if (returnFocus.isConnected && !returnFocus.inert) returnFocus.focus();
      });
    };
  }, [initialFocusRef, restoreFocus]);

  return dialogRef;
}

export function nextDialogTabIndex(currentIndex: number, itemCount: number, backwards: boolean): number | null {
  if (itemCount <= 0) return null;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return null;
}

function focusDialogEntry(dialog: HTMLElement, initialFocusRef?: RefObject<HTMLElement | null>): void {
  const requested = initialFocusRef?.current;
  if (requested && dialog.contains(requested) && requested.tabIndex >= 0) {
    requested.focus();
    return;
  }
  (dialogFocusableElements(dialog)[0] ?? dialog).focus();
}

function dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => (
    element.tabIndex >= 0
    && !element.hidden
    && element.getAttribute("aria-hidden") !== "true"
    && !element.closest("[hidden], [aria-hidden=\"true\"]")
  ));
}

function isolateDialogBackground(dialog: HTMLElement): () => void {
  const targets: HTMLElement[] = [];
  let branch: HTMLElement | null = dialog;
  while (branch?.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      acquireBackgroundIsolation(sibling);
      targets.push(sibling);
    }
    branch = branch.parentElement;
  }
  return () => targets.forEach(releaseBackgroundIsolation);
}

function acquireBackgroundIsolation(element: HTMLElement): void {
  const existing = isolatedElements.get(element);
  if (existing) {
    existing.count += 1;
    return;
  }
  isolatedElements.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function releaseBackgroundIsolation(element: HTMLElement): void {
  const state = isolatedElements.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  isolatedElements.delete(element);
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
}
