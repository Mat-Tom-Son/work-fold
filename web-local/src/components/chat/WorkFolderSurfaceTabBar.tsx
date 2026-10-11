import { useWorkFolderIdentityResolver } from "../../lib/work-folder-appearance-context";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Checkmark16Regular, ChevronDown16Regular, Dismiss12Regular } from "@fluentui/react-icons";

import { chatDisplayTitle } from "../../lib/format";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { readStoredValue, writeStoredValue } from "../../lib/storage";
import { groupSurfaceTabsByWorkFolder } from "../../lib/surface-tab-groups";
import { createSurfaceTabMotion } from "../../lib/surface-tab-motion";
import { createSurfaceTabReorder } from "../../lib/surface-tab-reorder";
import { workFolderIdentityStyle } from "../../lib/work-folder-identity";
import { surfacePanelDomId, surfaceTabDomId } from "../../lib/work-folder-ui";
import type { ChatActivityStatus, ConversationSummary, WorkFolderCustomizationMap, WorkFolderSummary, WorkFolderSurfaceTab } from "../../types";
import { FluentGlyph, NewChatIcon, WorkFolderIconGlyph } from "../chrome/common";
import { fileSharing } from "../../ui-contract";
import { SharedPageGlyph } from "../tree/FileTree";

const groupSurfaceTabsStorageKey = "work-fold.work-folder.surface-tabs.group-by-work-folder.v1";

export type SurfaceTabOverflow = "start" | "end" | "both" | null;

/** Size tier for the tab strip: compact above three tabs, dense above six. */
export function surfaceTabCountTier(tabCount: number): "tab-count-dense" | "tab-count-compact" | "" {
  if (tabCount > 6) return "tab-count-dense";
  if (tabCount > 3) return "tab-count-compact";
  return "";
}

/** Which edges of a horizontally scrolling strip hide content. */
export function surfaceTabOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): SurfaceTabOverflow {
  const tolerance = 1;
  if (scrollWidth - clientWidth <= tolerance) return null;
  const hiddenStart = scrollLeft > tolerance;
  const hiddenEnd = scrollLeft + clientWidth < scrollWidth - tolerance;
  if (hiddenStart && hiddenEnd) return "both";
  if (hiddenStart) return "start";
  if (hiddenEnd) return "end";
  return null;
}

export function WorkFolderSurfaceTabBar({
  tabs,
  workFolders,
  workFolderCustomizations,
  conversations,
  chatActivityStatuses,
  activeTabId,
  newChatWorkFolderId,
  onActivate,
  onClose,
  onReorder,
  onNewChatInWorkFolder,
  onChatActions,
  isSharedFile,
}: {
  tabs: WorkFolderSurfaceTab[];
  workFolders: WorkFolderSummary[];
  workFolderCustomizations: WorkFolderCustomizationMap;
  conversations: Record<string, ConversationSummary[]>;
  chatActivityStatuses: Record<string, ChatActivityStatus>;
  activeTabId: string | null;
  newChatWorkFolderId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (ids: string[]) => void;
  onNewChatInWorkFolder: (workFolder: WorkFolderSummary) => void;
  onChatActions: (workFolder: WorkFolderSummary, conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>) => void;
  /** True when this work-folder file is shared as a page; file tabs carry the mark. */
  isSharedFile?: (workFolderId: string, path: string) => boolean;
}) {
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const [workFolderMenuOpen, setWorkFolderMenuOpen] = useState(false);
  const [groupByWorkFolder, setGroupByWorkFolder] = useState(() => readStoredValue(groupSurfaceTabsStorageKey) === "true");
  const [overflow, setOverflow] = useState<SurfaceTabOverflow>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const activeChromeRef = useRef<HTMLSpanElement | null>(null);
  const tabMotionRef = useRef<ReturnType<typeof createSurfaceTabMotion> | null>(null);
  const reorderRef = useRef<ReturnType<typeof createSurfaceTabReorder> | null>(null);
  const previousSelectionRef = useRef<{ id: string | null; layout: string } | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const openWorkFolderCount = new Set(tabs.map((tab) => tab.workFolderId)).size;
  const groupingActive = groupByWorkFolder && openWorkFolderCount > 1;
  const reorderOptionsRef = useRef({ groupingActive, onReorder });
  reorderOptionsRef.current = { groupingActive, onReorder };
  const orderedTabs = useMemo(
    () => groupingActive ? groupSurfaceTabsByWorkFolder(tabs).flatMap((group) => group.tabs) : tabs,
    [groupingActive, tabs],
  );
  const tabGroups = useMemo(
    () => groupingActive
      ? groupSurfaceTabsByWorkFolder(tabs)
      : [{ workFolderId: null, tabs }],
    [groupingActive, tabs],
  );
  const countTier = surfaceTabCountTier(tabs.length);
  const tabLayout = JSON.stringify([groupingActive, orderedTabs.map((tab) => tab.id)]);
  const menuWorkFolders = [
    ...workFolders.filter((item) => item.id === newChatWorkFolderId),
    ...workFolders.filter((item) => item.id !== newChatWorkFolderId),
  ];

  useLayoutEffect(() => {
    if (!tabsRef.current || !activeChromeRef.current) return;
    const motion = createSurfaceTabMotion(tabsRef.current, activeChromeRef.current);
    tabMotionRef.current = motion;
    return () => { motion.dispose(); tabMotionRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const reorder = createSurfaceTabReorder(strip, {
      grouped: () => reorderOptionsRef.current.groupingActive,
      commit: (ids) => reorderOptionsRef.current.onReorder(ids),
      announce: (id, position, count) => {
        const title = strip.ownerDocument.getElementById(surfaceTabDomId(id))?.textContent ?? "Tab";
        setReorderAnnouncement(`${title} moved to position ${position} of ${count}.`);
      },
    });
    reorderRef.current = reorder;
    return () => { reorder.dispose(); reorderRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    const previous = previousSelectionRef.current;
    const active = activeTabId ? document.getElementById(surfaceTabDomId(activeTabId))?.closest<HTMLElement>(".surface-tab") ?? null : null;
    tabMotionRef.current?.select(active, Boolean(previous?.id && previous.id !== activeTabId && previous.layout === tabLayout));
    previousSelectionRef.current = { id: activeTabId, layout: tabLayout };
  }, [activeTabId, tabLayout]);

  useLayoutEffect(() => { reorderRef.current?.layout(); }, [tabLayout]);

  useEffect(() => {
    if (!workFolderMenuOpen) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setWorkFolderMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setWorkFolderMenuOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [workFolderMenuOpen]);

  useEffect(() => {
    const tabStrip = tabsRef.current;
    if (!tabStrip) return;
    function revealActiveTab(): void {
      const activeTab = activeTabId ? document.getElementById(surfaceTabDomId(activeTabId)) : null;
      activeTab?.closest(".surface-tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    revealActiveTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => revealActiveTab());
    observer.observe(tabStrip);
    return () => observer.disconnect();
  }, [activeTabId, groupingActive, countTier]);

  useEffect(() => {
    const tabStrip = tabsRef.current;
    if (!tabStrip) return;
    const strip = tabStrip;
    function measureOverflow(): void {
      setOverflow(surfaceTabOverflow(strip.scrollLeft, strip.scrollWidth, strip.clientWidth));
    }
    function scrollVerticalWheel(event: WheelEvent): void {
      if (strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      const lineHeight = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      strip.scrollLeft += event.deltaY * lineHeight;
    }
    measureOverflow();
    strip.addEventListener("scroll", measureOverflow, { passive: true });
    strip.addEventListener("wheel", scrollVerticalWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measureOverflow());
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measureOverflow);
      strip.removeEventListener("wheel", scrollVerticalWheel);
      observer?.disconnect();
    };
  }, [orderedTabs, groupingActive, countTier]);

  function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!orderedTabs.length) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    if (event.altKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      const focused = (event.target as HTMLElement).closest<HTMLElement>(".surface-tab")?.dataset.tabId;
      const tab = orderedTabs.find((item) => item.id === focused);
      if (!tab) return;
      event.preventDefault(); event.stopPropagation();
      const peers = groupingActive ? orderedTabs.filter((item) => item.workFolderId === tab.workFolderId) : orderedTabs;
      const index = peers.indexOf(tab);
      const target = peers[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (!target) return;
      const ids = orderedTabs.map((item) => item.id);
      const from = ids.indexOf(tab.id); const to = ids.indexOf(target.id);
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      reorderRef.current?.reorder(ids);
      setReorderAnnouncement(`${tab.title} moved to position ${peers.indexOf(target) + 1} of ${peers.length}.`);
      return;
    }
    if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;

    const activeIndex = orderedTabs.findIndex((tab) => tab.id === activeTabId);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const lastIndex = orderedTabs.length - 1;
    let nextIndex = currentIndex;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else if (event.key === "ArrowRight") nextIndex = activeIndex >= 0 ? (currentIndex + 1) % orderedTabs.length : 0;
    else if (event.key === "ArrowLeft") nextIndex = activeIndex >= 0 ? (currentIndex - 1 + orderedTabs.length) % orderedTabs.length : lastIndex;

    const nextTab = orderedTabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onActivate(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(surfaceTabDomId(nextTab.id))?.focus());
  }

  function workFolderMenuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]') ?? []);
  }

  function handleWorkFolderMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = workFolderMenuItems();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  function handleWorkFolderMenuSelect(targetWorkFolder: WorkFolderSummary): void {
    setWorkFolderMenuOpen(false);
    onNewChatInWorkFolder(targetWorkFolder);
  }

  function handleOpenTabSelect(tabId: string): void {
    setWorkFolderMenuOpen(false);
    onActivate(tabId);
    window.requestAnimationFrame(() => document.getElementById(surfaceTabDomId(tabId))?.focus());
  }

  function toggleWorkFolderGrouping(): void {
    const next = !groupByWorkFolder;
    setGroupByWorkFolder(next);
    writeStoredValue(groupSurfaceTabsStorageKey, next ? "true" : null);
    setWorkFolderMenuOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  function renderSurfaceTab(tab: WorkFolderSurfaceTab, grouped: boolean) {
    const tabWorkFolder = workFolders.find((item) => item.id === tab.workFolderId);
    const workFolderName = tabWorkFolder?.name ?? "work-folder";
    const resolvedWorkFolder = tabWorkFolder ?? fallbackWorkFolderSummary(tab.workFolderId, workFolderName);
    const identity = workFolderIdentityFor(resolvedWorkFolder, workFolderCustomizations);
    const Icon = identity.Icon;
    const style = workFolderIdentityStyle(identity);
    const activity = tab.kind === "chat" && tab.conversationId
      ? chatActivityStatuses[chatActivityKey(tab.workFolderId, tab.conversationId)]
      : undefined;
    const conversation = tab.kind === "chat" && tab.conversationId
      ? conversations[tab.workFolderId]?.find((item) => item.id === tab.conversationId)
      : undefined;
    const activityLabel = activity === "running" ? "Worker is working" : activity === "attention" ? "Worker finished" : "";
    const shared = tab.kind === "file" && Boolean(isSharedFile?.(tab.workFolderId, tab.path));
    return (
      <span
        className={["surface-tab", grouped ? "grouped" : "", tab.id === activeTabId ? "active" : "", activity ? `chat-${activity}` : ""].filter(Boolean).join(" ")}
        key={tab.id}
        data-tab-id={tab.id}
        data-work-folder-id={tab.workFolderId}
        style={style}
        title={`${tab.title} - ${workFolderName}${activityLabel ? ` · ${activityLabel}` : ""}`}
        onContextMenu={(event) => {
          if (tab.kind !== "chat" || !tab.conversationId) return;
          onChatActions(resolvedWorkFolder, conversation ?? {
            id: tab.conversationId,
            title: chatDisplayTitle({ serverTitle: tab.title }),
            updatedAt: new Date().toISOString(),
          }, event);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab.id);
        }}
      >
        <button
          id={surfaceTabDomId(tab.id)}
          className="surface-tab-main"
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          aria-controls={surfacePanelDomId(tab.id)}
          aria-label={`${tab.title} in ${workFolderName}${activityLabel ? `, ${activityLabel}` : ""}${shared ? ` · ${fileSharing.sharedMarkLabel}` : ""}`}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
          onPointerDown={(event) => reorderRef.current?.begin(event.nativeEvent, tab.id, event.currentTarget)}
          onClick={() => { if (!reorderRef.current?.consumeClick()) onActivate(tab.id); }}
        >
          {grouped ? null : <span className="surface-tab-icon" aria-hidden="true"><WorkFolderIconGlyph icon={Icon} size={15} /></span>}
          <span className="surface-tab-copy">
            <span className="surface-tab-title">{tab.title}</span>
          </span>
          {activity ? <span className={`surface-tab-chat-status ${activity}`} aria-hidden="true" /> : null}
          {shared ? <SharedPageGlyph className="surface-tab-shared-marker" /> : null}
        </button>
        <button
          className="surface-tab-close"
          type="button"
          onClick={() => onClose(tab.id)}
          aria-label={`Close ${tab.title}`}
          title="Close tab"
        >
          <Dismiss12Regular />
        </button>
      </span>
    );
  }

  return (
    <div className={tabs.length ? "surface-tabbar" : "surface-tabbar empty"}>
      <span className="sr-only" role="status" aria-live="polite">{reorderAnnouncement}</span>
      <div
        ref={tabsRef}
        className={["surface-tabs", groupingActive ? "surface-tabs-grouped" : "", countTier].filter(Boolean).join(" ")}
        data-overflow={overflow ?? undefined}
        role="tablist"
        aria-label="Open Tabs"
        onKeyDown={handleTabListKeyDown}
      >
        <span ref={activeChromeRef} className="surface-tab-active-chrome" aria-hidden="true" />
        {tabGroups.map((group) => {
          if (!group.workFolderId) return group.tabs.map((tab) => renderSurfaceTab(tab, false));
          const tabWorkFolder = workFolders.find((item) => item.id === group.workFolderId)
            ?? fallbackWorkFolderSummary(group.workFolderId, "work-folder");
          const identity = workFolderIdentityFor(tabWorkFolder, workFolderCustomizations);
          return (
            <span className="surface-tab-group" role="presentation" key={group.workFolderId}>
              <span
                className="surface-tab-group-label"
                style={workFolderIdentityStyle(identity)}
                title={tabWorkFolder.name}
                aria-hidden="true"
              >
                <WorkFolderIconGlyph icon={identity.Icon} size={14} />
                <span>{tabWorkFolder.name}</span>
              </span>
              <span className="surface-tab-group-tabs" role="presentation">
                {group.tabs.map((tab) => renderSurfaceTab(tab, true))}
              </span>
            </span>
          );
        })}
      </div>
      <div className="surface-tab-actions">
        <div
          className="surface-tab-work-folder-menu-anchor"
          ref={menuAnchorRef}
          onBlurCapture={(event) => {
            if (workFolderMenuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkFolderMenuOpen(false);
          }}
        >
          <div className="surface-tab-new-chat" role="group" aria-label="New Chat">
            <button
              className="surface-tab-action surface-tab-new-chat-main"
              type="button"
              onClick={() => {
                setWorkFolderMenuOpen(false);
                const current = workFolders.find((item) => item.id === newChatWorkFolderId);
                if (current) onNewChatInWorkFolder(current); else setWorkFolderMenuOpen(true);
              }}
              aria-label="Start a new Chat"
              title="New Chat in this work-folder"
            >
              <FluentGlyph icon={NewChatIcon} size={18} />
            </button>
            <button
              ref={menuButtonRef}
              className="surface-tab-action surface-tab-new-chat-trigger"
              type="button"
              onClick={() => setWorkFolderMenuOpen((current) => !current)}
              aria-label="Choose where to start a new Chat"
              aria-haspopup="menu"
              aria-expanded={workFolderMenuOpen}
              aria-controls="new-chat-work-folder-menu"
              title="New Chat in another work-folder, or open tabs"
            >
              <ChevronDown16Regular aria-hidden="true" />
            </button>
          </div>
          {workFolderMenuOpen ? (
            <div
              ref={menuRef}
              id="new-chat-work-folder-menu"
              className="surface-tab-work-folder-menu"
              role="menu"
              aria-label="Tab actions"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={handleWorkFolderMenuKeyDown}
            >
              <span className="surface-tab-work-folder-menu-heading">New Chat in</span>
              {menuWorkFolders.map((item) => {
                const identity = workFolderIdentityFor(item, workFolderCustomizations);
                const Icon = identity.Icon;
                const current = item.id === newChatWorkFolderId;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    key={item.id}
                    style={workFolderIdentityStyle(identity)}
                    onClick={() => handleWorkFolderMenuSelect(item)}
                    title={`New Chat in ${item.name}`}
                  >
                    <span className="work-folder-identity-icon"><WorkFolderIconGlyph icon={Icon} size={14} /></span>
                    <span className="surface-tab-work-folder-menu-copy"><strong>{item.name}</strong>{current ? <small>Current work-folder</small> : null}</span>
                  </button>
                );
              })}
              {orderedTabs.length ? (
                <>
                  <span className="surface-tab-work-folder-menu-separator" role="separator" />
                  <span className="surface-tab-work-folder-menu-heading">Open Tabs</span>
                  {orderedTabs.map((tab) => {
                    const tabWorkFolder = workFolders.find((item) => item.id === tab.workFolderId)
                      ?? fallbackWorkFolderSummary(tab.workFolderId, "work-folder");
                    const identity = workFolderIdentityFor(tabWorkFolder, workFolderCustomizations);
                    const active = tab.id === activeTabId;
                    return (
                      <button
                        className="surface-tab-open-item"
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        aria-label={`${tab.title} in ${tabWorkFolder.name}`}
                        tabIndex={-1}
                        key={tab.id}
                        style={workFolderIdentityStyle(identity)}
                        onClick={() => handleOpenTabSelect(tab.id)}
                        title={`${tab.title} - ${tabWorkFolder.name}`}
                      >
                        <span className="work-folder-identity-icon"><WorkFolderIconGlyph icon={identity.Icon} size={14} /></span>
                        <span className="surface-tab-work-folder-menu-copy"><strong>{tab.title}</strong></span>
                      </button>
                    );
                  })}
                </>
              ) : null}
              <span className="surface-tab-work-folder-menu-separator" role="separator" />
              <span className="surface-tab-work-folder-menu-heading">Tab layout</span>
              <button
                className="surface-tab-group-toggle"
                type="button"
                role="menuitemcheckbox"
                aria-checked={groupByWorkFolder}
                tabIndex={-1}
                onClick={toggleWorkFolderGrouping}
              >
                <span className="surface-tab-menu-check" aria-hidden="true">{groupByWorkFolder ? <Checkmark16Regular /> : null}</span>
                <span className="surface-tab-work-folder-menu-copy">
                  <strong>Group by work-folder</strong>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function fallbackWorkFolderSummary(id: string, name: string): WorkFolderSummary {
  return {
    id,
    name,
    workFolderRoot: "",
    location: { kind: "local", storage: "linked" },
    createdAt: "",
    updatedAt: "",
  };
}
