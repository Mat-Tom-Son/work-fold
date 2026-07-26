import { ArrowClockwise20Regular, Apps24Regular } from "@fluentui/react-icons";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppTheme, RestrictedAppInstalled, RestrictedAppViewRequest } from "../../types";

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
    return <div className="restricted-app-view restricted-app-view-fallback"><Apps24Regular /><strong>{app.manifest.title}</strong><span>Interactive app views run in Workspace desktop.</span></div>;
  }

  return (
    <div className="restricted-app-view" ref={hostRef} data-restricted-app-mount={mountIdRef.current}>
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
  const bounds = element.getBoundingClientRect();
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
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    active,
    occluded: !active || bounds.width < 1 || bounds.height < 1 || nativeViewOccluded(element, bounds),
    theme: currentTheme(),
  };
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
