import { useEffect, useMemo, useRef, useState } from "react";

import type { BrowserPageState } from "../../../src/shared/browser";
import type { BrowserTabLook } from "../components/chat/WorkFolderSurfaceTabBar";
import { openBrowserTabEvent, type OpenBrowserTabRequest } from "../lib/browser-links";
import { isMacOS } from "../lib/platform";
import type { WorkFolderSurfaceTab } from "../types";
import { showToast } from "../ui/feedback";
import type { useSurfaceTabs } from "./useSurfaceTabs";

/**
 * The renderer's half of the built-in browser (docs/built-in-browser.md):
 * page state from the desktop, tabs that links and Workers open, closing a
 * tab's page, downloads, and the app's own keys while a page has focus.
 * Absent outside the desktop app.
 */
export function useBrowserTabs(tabs: ReturnType<typeof useSurfaceTabs>) {
  const desktop = window.workFoldDesktop?.browser;
  const [pages, setPages] = useState<Record<string, BrowserPageState>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const browserTabs = tabs.surfaceTabs.filter((tab): tab is Extract<WorkFolderSurfaceTab, { kind: "browser" }> => tab.kind === "browser");
  const viewingPageId = browserTabs.find((tab) => tab.id === tabs.activeSurfaceTabId)?.pageId ?? null;

  useEffect(() => {
    if (!desktop) return;
    const apply = (state: BrowserPageState) => {
      setPages((current) => ({ ...current, [state.pageId]: state }));
      // A page that has not committed an address yet keeps its tab's saved one.
      if (state.url) tabsRef.current.updateBrowserSurfaceTab(state.pageId, { url: state.url, title: state.title });
    };
    const unsubscribe = desktop.onState(apply);
    // Pages outlive a renderer reload; pick their state back up.
    void desktop.states().then((states) => states.forEach(apply)).catch(() => undefined);
    return unsubscribe;
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    const offOpen = desktop.onOpenTab((command) => {
      tabsRef.current.openBrowserSurfaceTab({ pageId: command.pageId, url: command.url, title: command.title, show: command.show });
    });
    const offClose = desktop.onCloseTab(({ pageId }) => {
      const tab = tabsRef.current.surfaceTabs.find((item) => item.kind === "browser" && item.pageId === pageId);
      if (tab) tabsRef.current.closeSurfaceTab(tab.id);
    });
    // The page had focus, so the app's own tab keys arrive here instead of as key presses.
    const offShortcut = desktop.onShortcut((shortcut) => {
      const key = shortcut.key.toLowerCase();
      if (key === "l" || key === "f") return;
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: shortcut.key,
        code: shortcut.code,
        metaKey: shortcut.metaKey,
        ctrlKey: shortcut.ctrlKey,
        shiftKey: shortcut.shiftKey,
        altKey: shortcut.altKey,
        bubbles: true,
        cancelable: true,
      }));
    });
    // A link in a Chat (a Worker's dev server) asks for a browser tab.
    const openFromLink = (event: Event) => {
      const url = (event as CustomEvent<OpenBrowserTabRequest>).detail?.url;
      if (typeof url === "string" && url) tabsRef.current.openBrowserSurfaceTab({ url });
    };
    window.addEventListener(openBrowserTabEvent, openFromLink);
    const offDownload = desktop.onDownload((download) => {
      if (download.state === "completed") {
        showToast({
          text: `Downloaded ${download.filename}`,
          tone: "success",
          actionLabel: isMacOS() ? "Show in Finder" : "Show in Folder",
          onAction: () => { void desktop.showDownload(download.path).catch(() => undefined); },
          durationMs: 8000,
        });
      } else if (download.state === "interrupted") {
        showToast({ text: `${download.filename} didn't finish downloading`, tone: "error" });
      }
    });
    return () => {
      offOpen();
      offClose();
      offShortcut();
      offDownload();
      window.removeEventListener(openBrowserTabEvent, openFromLink);
    };
  }, [desktop]);

  // A closed tab closes its page; the desktop keeps no page without a tab.
  const pageIds = browserTabs.map((tab) => tab.pageId).join("|");
  const previousPageIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set(pageIds ? pageIds.split("|") : []);
    const previous = previousPageIdsRef.current;
    previousPageIdsRef.current = current;
    if (!desktop || !previous) return;
    const closed = [...previous].filter((pageId) => !current.has(pageId));
    if (!closed.length) return;
    for (const pageId of closed) void desktop.close(pageId).catch(() => undefined);
    setPages((existing) => {
      const next = { ...existing };
      for (const pageId of closed) delete next[pageId];
      return next;
    });
  }, [desktop, pageIds]);

  // Workers see the same tabs, in the same order, and which one is in front.
  const syncKey = JSON.stringify([viewingPageId, browserTabs.map((tab) => [tab.pageId, tab.url, tab.title])]);
  useEffect(() => {
    if (!desktop) return;
    desktop.sync({
      tabs: browserTabs.map((tab) => ({ pageId: tab.pageId, url: tab.url, title: tab.title })),
      viewingPageId,
    });
  }, [desktop, syncKey]);

  const looks = useMemo(() => Object.fromEntries(Object.values(pages).map((page): [string, BrowserTabLook] => [
    page.pageId,
    { favicon: page.favicon, loading: page.loading, audible: page.audible, asking: Boolean(page.permissionRequest) },
  ])), [pages]);

  return {
    available: Boolean(desktop),
    pages,
    looks,
    newTab: () => tabs.openBrowserSurfaceTab(),
    reload: (pageId: string) => { void desktop?.command(pageId, { type: "reload" }); },
  };
}
