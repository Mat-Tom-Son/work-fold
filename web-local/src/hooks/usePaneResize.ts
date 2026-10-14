import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  workFolderChatPreferredMinWidth,
  workFolderPaneKeyboardLargeStep,
  workFolderPaneKeyboardStep,
  workFolderPaneResizeHandleWidth,
  workFolderSidebarPreferredMaxWidth,
  workFolderSidebarPreferredMinWidth,
  workFolderSidebarWidthPreferenceKey,
} from "../constants";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import type { WorkFolderPaneBounds } from "../types";

function readStoredWorkFolderSidebarWidth(): number | null {
  const stored = readStoredValue(workFolderSidebarWidthPreferenceKey);
  if (!stored) return null;
  const width = Number.parseInt(stored, 10);
  return Number.isFinite(width) ? width : null;
}

function writeStoredWorkFolderSidebarWidth(width: number | null) {
  writeStoredValue(workFolderSidebarWidthPreferenceKey, width === null ? null : String(Math.round(width)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePaneResize(deterministic = false) {
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => deterministic ? null : readStoredWorkFolderSidebarWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const workFolderLayoutRef = useRef<HTMLElement | null>(null);
  const preferredSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const renderedSidebarWidthRef = useRef<number | null>(sidebarWidth);
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  // Pane bounds are stable for the duration of a pointer drag; cache them so
  // per-frame renders skip getComputedStyle.
  const dragBoundsRef = useRef<WorkFolderPaneBounds | null>(null);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.();
    sidebarResizeCleanupRef.current = null;
    if (sidebarResizeFrameRef.current !== null) window.cancelAnimationFrame(sidebarResizeFrameRef.current);
    document.body.classList.remove("work-folder-pane-resizing");
  }, []);

  useEffect(() => {
    const layout = workFolderLayoutRef.current;
    if (!layout) return;
    const initialWidth = preferredSidebarWidthRef.current ?? defaultWorkFolderSidebarWidth(layout);
    renderWorkFolderSidebarWidth(initialWidth);
  }, []);

  useEffect(() => {
    const layout = workFolderLayoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      renderWorkFolderSidebarWidth(preferredSidebarWidthRef.current ?? defaultWorkFolderSidebarWidth(layout));
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  function workFolderPaneBounds(layout = workFolderLayoutRef.current): WorkFolderPaneBounds {
    if (!layout) {
      return {
        min: workFolderSidebarPreferredMinWidth,
        max: workFolderSidebarPreferredMaxWidth,
        fallback: 420,
      };
    }
    const styles = window.getComputedStyle(layout);
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    const availableWidth = Math.max(0, layout.clientWidth - horizontalPadding);
    const minimumByChat = Math.max(220, availableWidth - workFolderPaneResizeHandleWidth - workFolderChatPreferredMinWidth);
    const min = Math.min(workFolderSidebarPreferredMinWidth, minimumByChat);
    const max = Math.max(min, Math.min(workFolderSidebarPreferredMaxWidth, availableWidth - workFolderPaneResizeHandleWidth - workFolderChatPreferredMinWidth));
    const fallback = clampNumber(Math.round(availableWidth * 0.34), min, max);
    return { min, max, fallback };
  }

  function defaultWorkFolderSidebarWidth(layout = workFolderLayoutRef.current): number {
    return workFolderPaneBounds(layout).fallback;
  }

  function renderWorkFolderSidebarWidth(width: number): number {
    const bounds = dragBoundsRef.current ?? workFolderPaneBounds();
    const nextWidth = Math.round(clampNumber(width, bounds.min, bounds.max));
    renderedSidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    workFolderLayoutRef.current?.style.setProperty("--work-folder-sidebar-width", `${nextWidth}px`);
    return nextWidth;
  }

  function queueWorkFolderSidebarWidth(width: number) {
    pendingSidebarWidthRef.current = width;
    if (sidebarResizeFrameRef.current !== null) return;
    sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
      sidebarResizeFrameRef.current = null;
      const pendingWidth = pendingSidebarWidthRef.current;
      if (pendingWidth !== null) renderWorkFolderSidebarWidth(pendingWidth);
    });
  }

  function commitWorkFolderSidebarWidth(width: number | null = renderedSidebarWidthRef.current) {
    if (width === null) return;
    const nextWidth = renderWorkFolderSidebarWidth(width);
    preferredSidebarWidthRef.current = nextWidth;
    if (!deterministic) writeStoredWorkFolderSidebarWidth(nextWidth);
  }

  function resetWorkFolderSidebarWidth() {
    preferredSidebarWidthRef.current = null;
    if (!deterministic) writeStoredWorkFolderSidebarWidth(null);
    renderWorkFolderSidebarWidth(defaultWorkFolderSidebarWidth());
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const layout = workFolderLayoutRef.current;
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
    document.body.classList.add("work-folder-pane-resizing");
    const pane = document.getElementById("work-folder-file-panel");
    const dragStartClientX = event.clientX;
    dragBoundsRef.current = workFolderPaneBounds(layout);
    const dragStartWidth = pane?.getBoundingClientRect().width ?? renderedSidebarWidthRef.current ?? defaultWorkFolderSidebarWidth(layout);
    const widthFromPointer = (clientX: number) => dragStartWidth + clientX - dragStartClientX;
    let stopped = false;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      queueWorkFolderSidebarWidth(widthFromPointer(pointerEvent.clientX));
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
      if (pendingSidebarWidthRef.current !== null) renderWorkFolderSidebarWidth(pendingSidebarWidthRef.current);
      pendingSidebarWidthRef.current = null;
      commitWorkFolderSidebarWidth();
      setSidebarResizing(false);
      document.body.classList.remove("work-folder-pane-resizing");
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
    const bounds = workFolderPaneBounds();
    const currentWidth = renderedSidebarWidthRef.current ?? bounds.fallback;
    const step = event.shiftKey ? workFolderPaneKeyboardLargeStep : workFolderPaneKeyboardStep;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = currentWidth - step;
    else if (event.key === "ArrowRight") nextWidth = currentWidth + step;
    else if (event.key === "Home") nextWidth = bounds.min;
    else if (event.key === "End") nextWidth = bounds.max;
    else if (event.key === "Enter") {
      event.preventDefault();
      resetWorkFolderSidebarWidth();
      return;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    commitWorkFolderSidebarWidth(nextWidth);
  }

  const sidebarResizeBounds = workFolderPaneBounds();
  const sidebarResizeValue = Math.round(clampNumber(sidebarWidth ?? sidebarResizeBounds.fallback, sidebarResizeBounds.min, sidebarResizeBounds.max));

  return {
    sidebarWidth,
    sidebarResizing,
    workFolderLayoutRef,
    resetWorkFolderSidebarWidth,
    startSidebarResize,
    handleSidebarResizeKeyDown,
    sidebarResizeBounds,
    sidebarResizeValue,
  };
}
