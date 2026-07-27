import { ArrowClockwise20Regular, Apps24Regular } from "@fluentui/react-icons";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { resolveRestrictedAppCornerRadius } from "../../../../src/shared/restricted-app-presentation";
import type { AppTheme, RestrictedAppInstalled, RestrictedAppViewRequest } from "../../types";

const restrictedAppRailGuard = 12;

export function RestrictedAppViewport({
  app,
  placement,
  appTabId,
  route = "/",
  state,
  active,
}: {
  app: RestrictedAppInstalled;
  placement: "navigator" | "tab";
  appTabId?: string;
  route?: string;
  state?: unknown;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountIdRef = useRef(crypto.randomUUID());
  const sequenceRef = useRef(0);
  const latestRef = useRef({ app, placement, appTabId, route, state, active });
  const [generation, setGeneration] = useState(0);
  const [viewState, setViewState] = useState<"loading" | "ready" | "crashed">("loading");
  const [message, setMessage] = useState("");
  const cornerRadius = resolveRestrictedAppCornerRadius(app.manifest.ui.cornerRadius);
  latestRef.current = { app, placement, appTabId, route, state, active };
  const desktop = window.workspaceDesktop?.restrictedApps;

  useEffect(() => {
    if (!desktop) return;
    return desktop.onViewState((event) => {
      if (event.mountId !== mountIdRef.current) return;
      if (event.state === "ready") {
        setMessage("");
        setViewState("ready");
      } else if (event.state === "crashed") {
        setMessage(event.message ?? "The app view stopped unexpectedly.");
        setViewState("crashed");
      } else if (event.state === "stopped") {
        mountIdRef.current = crypto.randomUUID();
        sequenceRef.current = 0;
        setMessage("");
        setViewState("loading");
        setGeneration((value) => value + 1);
      }
    });
  }, [desktop]);

  useLayoutEffect(() => {
    if (!desktop) return;
    const element = hostRef.current;
    if (!element) return;
    const mountId = mountIdRef.current;
    let disposed = false;
    let mounted = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (disposed) return;
      const request = viewRequest(element, mountId, sequenceRef.current++, latestRef.current);
      if (mounted) desktop.layoutView(request);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    resizeObserver.observe(element);
    mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    setViewState("loading");
    setMessage("");
    const initial = viewRequest(element, mountId, sequenceRef.current++, latestRef.current);
    void desktop.mountView(initial).then(() => {
      if (disposed || mountId !== mountIdRef.current) return;
      mounted = true;
      setViewState("ready");
      schedule();
    }).catch((error) => {
      if (disposed || mountId !== mountIdRef.current) return;
      setMessage(error instanceof Error ? error.message : "The app view could not start.");
      setViewState("crashed");
    });
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void desktop.unmountView(mountId).catch(() => undefined);
    };
  }, [desktop, generation, app.workspaceId, app.manifest.id, app.digest]);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!desktop || !element) return;
    desktop.layoutView(viewRequest(element, mountIdRef.current, sequenceRef.current++, latestRef.current));
  }, [active, appTabId, desktop, placement, route, state]);

  if (!desktop) {
    return <div className="restricted-app-view restricted-app-view-fallback" style={{ borderRadius: cornerRadius }}><Apps24Regular /><strong>{app.manifest.title}</strong><span>Interactive app views run in Workspace desktop.</span></div>;
  }

  return (
    <div className="restricted-app-view" ref={hostRef} data-restricted-app-mount={mountIdRef.current} style={{ borderRadius: cornerRadius }}>
      {viewState === "loading" ? <div className="restricted-app-view-status"><Loader2 className="spin" /><span>Starting {app.manifest.title}</span></div> : null}
      {viewState === "crashed" ? (
        <div className="restricted-app-view-status restricted-app-view-error">
          <Apps24Regular />
          <strong>{app.manifest.title} stopped</strong>
          <span>{message}</span>
          <button type="button" className="secondary-button" onClick={() => { mountIdRef.current = crypto.randomUUID(); sequenceRef.current = 0; setGeneration((value) => value + 1); }}><ArrowClockwise20Regular />Try again</button>
        </div>
      ) : null}
    </div>
  );
}

function viewRequest(
  element: HTMLElement,
  mountId: string,
  sequence: number,
  latest: {
    app: RestrictedAppInstalled;
    placement: "navigator" | "tab";
    appTabId?: string;
    route: string;
    state?: unknown;
    active: boolean;
  },
): RestrictedAppViewRequest {
  const elementBounds = element.getBoundingClientRect();
  const bounds = nativeViewBounds(element, elementBounds, latest.placement);
  const active = latest.active && !element.hidden && document.visibilityState === "visible";
  return {
    workspaceId: latest.app.workspaceId,
    appId: latest.app.manifest.id,
    digest: latest.app.digest,
    mountId,
    placement: latest.placement,
    ...(latest.appTabId ? { appTabId: latest.appTabId } : {}),
    route: latest.route,
    ...(latest.state !== undefined ? { state: latest.state } : {}),
    sequence,
    bounds,
    active,
    occluded: !active || bounds.width < 1 || bounds.height < 1 || nativeViewOccluded(element, elementBounds),
    theme: currentTheme(),
  };
}

function nativeViewBounds(element: HTMLElement, bounds: DOMRect, placement: "navigator" | "tab"): RestrictedAppViewRequest["bounds"] {
  const style = getComputedStyle(element);
  const borderLeft = cssPixelValue(style.borderLeftWidth);
  const borderTop = cssPixelValue(style.borderTopWidth);
  const borderRight = cssPixelValue(style.borderRightWidth);
  const borderBottom = cssPixelValue(style.borderBottomWidth);
  let left = bounds.left + borderLeft;
  const top = bounds.top + borderTop;
  const right = bounds.right - borderRight;
  const bottom = bounds.bottom - borderBottom;
  if (placement === "navigator") {
    const rail = document.querySelector<HTMLElement>(".professional-workspace-rail")?.getBoundingClientRect();
    if (rail) left = Math.max(left, rail.right + restrictedAppRailGuard);
  }
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function currentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function nativeViewOccluded(element: HTMLElement, bounds: DOMRect): boolean {
  const candidates = document.querySelectorAll<HTMLElement>([
    "[data-native-view-occluder='true']",
    ".modal-backdrop",
    ".publish-review-backdrop",
    ".command-palette-backdrop",
    ".context-menu-backdrop",
    ".context-menu",
    ".surface-tab-workspace-menu",
    ".chat-rename-popover",
    "[role='menu']",
    "[role='dialog'][aria-modal='true']",
  ].join(","));
  for (const candidate of candidates) {
    if (candidate === element || candidate.contains(element) || element.contains(candidate)) continue;
    const style = getComputedStyle(candidate);
    const explicitOccluder = candidate.dataset.nativeViewOccluder === "true";
    if (style.display === "none" || style.visibility === "hidden" || (!explicitOccluder && Number(style.opacity) === 0)) continue;
    const other = candidate.getBoundingClientRect();
    if (other.right > bounds.left && other.left < bounds.right && other.bottom > bounds.top && other.top < bounds.bottom) return true;
  }
  return false;
}
