import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";

/** A pane the person can widen or narrow: its default, its limits, and where its width is kept. */
export interface PaneWidthSpec {
  /** The CSS custom property on the shell that sets the pane's width. */
  property: string;
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

export const sidebarWidthSpec: PaneWidthSpec = { property: "--fm-sidebar-width", storageKey: "work-fold.file-manager.sidebar-width.v1", defaultWidth: 228, min: 168, max: 360 };
export const panelWidthSpec: PaneWidthSpec = { property: "--fm-panel-width", storageKey: "work-fold.file-manager.panel-width.v1", defaultWidth: 320, min: 270, max: 600 };

/** The folder list keeps at least this much room between the two panes. */
const minimumListWidth = 360;

export function clampPaneWidth(spec: PaneWidthSpec, width: number, room = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(spec.min, Math.min(spec.max, room, width)));
}

/** A pane's saved width, or its default. */
export function usePaneWidth(spec: PaneWidthSpec) {
  const [width, setWidth] = useState(() => readStoredJsonValue(spec.storageKey, (value) => typeof value === "number" && Number.isFinite(value) ? clampPaneWidth(spec, value) : spec.defaultWidth, spec.defaultWidth));
  const commit = (next: number) => { setWidth(next); writeStoredJsonValue(spec.storageKey, next); };
  return [width, commit] as const;
}

/**
 * The edge between two panes, dragged to resize the pane on one side as
 * Finder's sidebar edge is. While dragging, the width goes straight onto the
 * shell's custom property so the list reflows every frame without a React
 * render; letting go saves it. Double-click puts the default back, and the
 * arrow keys, Home, End, and Enter work from the keyboard.
 */
export function PaneResizer({ spec, side, width, label, shellRef, otherPaneWidth, onCommit }: {
  spec: PaneWidthSpec;
  /** Which side of the edge the pane is on: the sidebar is to the left, the panel to the right. */
  side: "left" | "right";
  width: number;
  label: string;
  shellRef: RefObject<HTMLElement | null>;
  /** The other pane's width, so the folder list always keeps room. */
  otherPaneWidth: number;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const room = () => {
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    return shellWidth - otherPaneWidth - minimumListWidth;
  };
  const show = (next: number) => shellRef.current?.style.setProperty(spec.property, `${next}px`);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, current: width };
    setDragging(true);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = event.clientX - active.startX;
    const next = clampPaneWidth(spec, active.startWidth + (side === "left" ? delta : -delta), room());
    if (next === active.current) return;
    active.current = next;
    show(next);
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (active.current !== width) onCommit(active.current);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 8;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    let next: number | null = null;
    if (event.key === grow) next = width + step;
    else if (event.key === shrink) next = width - step;
    else if (event.key === "Home") next = spec.min;
    else if (event.key === "End") next = spec.max;
    else if (event.key === "Enter") next = spec.defaultWidth;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampPaneWidth(spec, next, room());
    show(clamped);
    onCommit(clamped);
  }

  return <div
    className={`fm-resize is-${side === "left" ? "after-sidebar" : "before-panel"}${dragging ? " is-dragging" : ""}`}
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    aria-valuemin={spec.min}
    aria-valuemax={spec.max}
    aria-valuenow={width}
    tabIndex={0}
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerUp}
    onLostPointerCapture={pointerUp}
    onDoubleClick={() => { show(spec.defaultWidth); onCommit(spec.defaultWidth); }}
    onKeyDown={keyDown}
  />;
}
