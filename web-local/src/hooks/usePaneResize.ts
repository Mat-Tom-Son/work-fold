import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  spaceChatPreferredMinWidth,
  spacePaneKeyboardLargeStep,
  spacePaneKeyboardStep,
  spacePaneResizeHandleWidth,
  spaceSidebarPreferredMaxWidth,
  spaceSidebarPreferredMinWidth,
  spaceSidebarWidthPreferenceKey,
} from "../constants";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import type { SpacePaneBounds } from "../types";

function readStoredSpaceSidebarWidth(): number | null {
  const stored = readStoredValue(spaceSidebarWidthPreferenceKey);
  if (!stored) return null;
  const width = Number.parseInt(stored, 10);
  return Number.isFinite(width) ? width : null;
}

function writeStoredSpaceSidebarWidth(width: number | null) {
  writeStoredValue(spaceSidebarWidthPreferenceKey, width === null ? null : String(Math.round(width)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePaneResize(deterministic = false) {
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => deterministic ? null : readStoredSpaceSidebarWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const spaceLayoutRef = useRef<HTMLElement | null>(null);
  const preferredSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const renderedSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  // Pane bounds are stable for the duration of a pointer drag; cache them so
  // per-frame renders skip getComputedStyle.
  const dragBoundsRef = useRef<SpacePaneBounds | null>(null);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.();
    sidebarResizeCleanupRef.current = null;
    if (sidebarResizeFrameRef.current !== null) window.cancelAnimationFrame(sidebarResizeFrameRef.current);
    document.body.classList.remove("space-pane-resizing");
  }, []);

  useEffect(() => {
    const layout = spaceLayoutRef.current;
    if (!layout) return;
    const initialWidth = preferredSidebarWidthRef.current ?? defaultSpaceSidebarWidth(layout);
    renderSpaceSidebarWidth(initialWidth);
  }, []);

  useEffect(() => {
    const layout = spaceLayoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      renderSpaceSidebarWidth(preferredSidebarWidthRef.current ?? defaultSpaceSidebarWidth(layout));
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  function spacePaneBounds(layout = spaceLayoutRef.current): SpacePaneBounds {
    if (!layout) {
      return {
        min: spaceSidebarPreferredMinWidth,
        max: spaceSidebarPreferredMaxWidth,
        fallback: 420,
      };
    }
    const styles = window.getComputedStyle(layout);
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    const availableWidth = Math.max(0, layout.clientWidth - horizontalPadding);
    const minimumByChat = Math.max(220, availableWidth - spacePaneResizeHandleWidth - spaceChatPreferredMinWidth);
    const min = Math.min(spaceSidebarPreferredMinWidth, minimumByChat);
    const max = Math.max(min, Math.min(spaceSidebarPreferredMaxWidth, availableWidth - spacePaneResizeHandleWidth - spaceChatPreferredMinWidth));
    const fallback = clampNumber(Math.round(availableWidth * 0.34), min, max);
    return { min, max, fallback };
  }

  function defaultSpaceSidebarWidth(layout = spaceLayoutRef.current): number {
    return spacePaneBounds(layout).fallback;
  }

  function renderSpaceSidebarWidth(width: number): number {
    const bounds = dragBoundsRef.current ?? spacePaneBounds();
    const nextWidth = Math.round(clampNumber(width, bounds.min, bounds.max));
    renderedSidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    spaceLayoutRef.current?.style.setProperty("--space-sidebar-width", `${nextWidth}px`);
    return nextWidth;
  }

  function queueSpaceSidebarWidth(width: number) {
    pendingSidebarWidthRef.current = width;
    if (sidebarResizeFrameRef.current !== null) return;
    sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
      sidebarResizeFrameRef.current = null;
      const pendingWidth = pendingSidebarWidthRef.current;
      if (pendingWidth !== null) renderSpaceSidebarWidth(pendingWidth);
    });
  }

  function commitSpaceSidebarWidth(width: number | null = renderedSidebarWidthRef.current) {
    if (width === null) return;
    const nextWidth = renderSpaceSidebarWidth(width);
    preferredSidebarWidthRef.current = nextWidth;
    if (!deterministic) writeStoredSpaceSidebarWidth(nextWidth);
  }

  function resetSpaceSidebarWidth() {
    preferredSidebarWidthRef.current = null;
    if (!deterministic) writeStoredSpaceSidebarWidth(null);
    renderSpaceSidebarWidth(defaultSpaceSidebarWidth());
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const layout = spaceLayoutRef.current;
    if (!layout) return;
    event.preventDefault();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      resizeHandle.setPointerCapture(pointerId);
    } catch {
      // Pointer capture can fail for synthetic or already-cancelled events; window listeners still cover normal drags.
    }
    setSidebarResizing(true);
    document.body.classList.add("space-pane-resizing");
    const pane = document.getElementById("space-file-panel");
    const dragStartClientX = event.clientX;
    dragBoundsRef.current = spacePaneBounds(layout);
    const dragStartWidth = pane?.getBoundingClientRect().width ?? renderedSidebarWidthRef.current ?? defaultSpaceSidebarWidth(layout);
    const widthFromPointer = (clientX: number) => dragStartWidth + clientX - dragStartClientX;
    let stopped = false;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      queueSpaceSidebarWidth(widthFromPointer(pointerEvent.clientX));
    };
    const stopResize = (pointerEvent?: PointerEvent | Event) => {
      if (stopped) return;
      stopped = true;
      dragBoundsRef.current = null;
      if (pointerEvent) pointerEvent.preventDefault();
      sidebarResizeCleanupRef.current?.();
      sidebarResizeCleanupRef.current = null;
      try {
        if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      } catch {
        // The pointer may already be released by the browser.
      }
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      if (pendingSidebarWidthRef.current !== null) renderSpaceSidebarWidth(pendingSidebarWidthRef.current);
      pendingSidebarWidthRef.current = null;
      commitSpaceSidebarWidth();
      setSidebarResizing(false);
      document.body.classList.remove("space-pane-resizing");
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopResize, { passive: false });
    window.addEventListener("pointercancel", stopResize, { passive: false });
    window.addEventListener("blur", stopResize);
    resizeHandle.addEventListener("lostpointercapture", stopResize);
    sidebarResizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
      resizeHandle.removeEventListener("lostpointercapture", stopResize);
    };
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const bounds = spacePaneBounds();
    const currentWidth = renderedSidebarWidthRef.current ?? bounds.fallback;
    const step = event.shiftKey ? spacePaneKeyboardLargeStep : spacePaneKeyboardStep;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = currentWidth - step;
    else if (event.key === "ArrowRight") nextWidth = currentWidth + step;
    else if (event.key === "Home") nextWidth = bounds.min;
    else if (event.key === "End") nextWidth = bounds.max;
    else if (event.key === "Enter") {
      event.preventDefault();
      resetSpaceSidebarWidth();
      return;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    commitSpaceSidebarWidth(nextWidth);
  }

  const sidebarResizeBounds = spacePaneBounds();
  const sidebarResizeValue = Math.round(clampNumber(sidebarWidth ?? sidebarResizeBounds.fallback, sidebarResizeBounds.min, sidebarResizeBounds.max));

  return {
    sidebarWidth,
    sidebarResizing,
    spaceLayoutRef,
    resetSpaceSidebarWidth,
    startSidebarResize,
    handleSidebarResizeKeyDown,
    sidebarResizeBounds,
    sidebarResizeValue,
  };
}
