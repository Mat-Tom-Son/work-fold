import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Checkmark16Regular, ChevronDown16Regular, Dismiss12Regular } from "@fluentui/react-icons";

import { chatDisplayTitle } from "../../lib/format";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { readStoredValue, writeStoredValue } from "../../lib/storage";
import { groupSurfaceTabsBySpace } from "../../lib/surface-tab-groups";
import { spaceIdentityFor, spaceIdentityStyle } from "../../lib/space-identity";
import { surfacePanelDomId, surfaceTabDomId } from "../../lib/space-ui";
import type { ChatActivityStatus, ConversationSummary, SpaceCustomizationMap, SpaceSummary, SpaceSurfaceTab } from "../../types";
import { FluentGlyph, NewChatIcon, SpaceIconGlyph } from "../chrome/common";

const groupSurfaceTabsStorageKey = "work-fold.space.surface-tabs.group-by-space.v1";

export function SpaceSurfaceTabBar({
  tabs,
  spaces,
  spaceCustomizations,
  conversations,
  chatActivityStatuses,
  activeTabId,
  newChatSpaceId,
  onActivate,
  onClose,
  onNewChatInSpace,
  onChatActions,
}: {
  tabs: SpaceSurfaceTab[];
  spaces: SpaceSummary[];
  spaceCustomizations: SpaceCustomizationMap;
  conversations: Record<string, ConversationSummary[]>;
  chatActivityStatuses: Record<string, ChatActivityStatus>;
  activeTabId: string | null;
  newChatSpaceId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewChatInSpace: (space: SpaceSummary) => void;
  onChatActions: (space: SpaceSummary, conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [groupBySpace, setGroupBySpace] = useState(() => readStoredValue(groupSurfaceTabsStorageKey) === "true");
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSpaceCount = new Set(tabs.map((tab) => tab.spaceId)).size;
  const groupingActive = groupBySpace && openSpaceCount > 1;
  const orderedTabs = useMemo(
    () => groupingActive ? groupSurfaceTabsBySpace(tabs).flatMap((group) => group.tabs) : tabs,
    [groupingActive, tabs],
  );
  const tabGroups = useMemo(
    () => groupingActive
      ? groupSurfaceTabsBySpace(tabs)
      : [{ spaceId: null, tabs }],
    [groupingActive, tabs],
  );
  const menuSpaces = [
    ...spaces.filter((item) => item.id === newChatSpaceId),
    ...spaces.filter((item) => item.id !== newChatSpaceId),
  ];

  useEffect(() => {
    if (!spaceMenuOpen) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setSpaceMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSpaceMenuOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [spaceMenuOpen]);

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
  }, [activeTabId, groupingActive]);

  function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!orderedTabs.length) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

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

  function spaceMenuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? []);
  }

  function handleSpaceMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = spaceMenuItems();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  function handleSpaceMenuSelect(targetSpace: SpaceSummary): void {
    setSpaceMenuOpen(false);
    onNewChatInSpace(targetSpace);
  }

  function toggleSpaceGrouping(): void {
    const next = !groupBySpace;
    setGroupBySpace(next);
    writeStoredValue(groupSurfaceTabsStorageKey, next ? "true" : null);
    setSpaceMenuOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  function renderSurfaceTab(tab: SpaceSurfaceTab, grouped: boolean) {
    const tabSpace = spaces.find((item) => item.id === tab.spaceId);
    const spaceName = tabSpace?.name ?? "Space";
    const resolvedSpace = tabSpace ?? fallbackSpaceSummary(tab.spaceId, spaceName);
    const identity = spaceIdentityFor(resolvedSpace, spaceCustomizations);
    const Icon = identity.Icon;
    const style = spaceIdentityStyle(identity);
    const activity = tab.kind === "chat" && tab.conversationId
      ? chatActivityStatuses[chatActivityKey(tab.spaceId, tab.conversationId)]
      : undefined;
    const conversation = tab.kind === "chat" && tab.conversationId
      ? conversations[tab.spaceId]?.find((item) => item.id === tab.conversationId)
      : undefined;
    const activityLabel = activity === "running" ? "Assistant working" : activity === "attention" ? "Assistant finished" : "";
    return (
      <span
        className={["surface-tab", grouped ? "grouped" : "", tab.id === activeTabId ? "active" : "", activity ? `chat-${activity}` : ""].filter(Boolean).join(" ")}
        key={tab.id}
        style={style}
        title={`${tab.title} - ${spaceName}${activityLabel ? ` · ${activityLabel}` : ""}`}
        onContextMenu={(event) => {
          if (tab.kind !== "chat" || !tab.conversationId) return;
          onChatActions(resolvedSpace, conversation ?? {
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
          aria-label={`${tab.title} in ${spaceName}${activityLabel ? `, ${activityLabel}` : ""}`}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          onClick={() => onActivate(tab.id)}
        >
          {grouped ? null : <span className="surface-tab-icon" aria-hidden="true"><SpaceIconGlyph icon={Icon} size={15} /></span>}
          <span className="surface-tab-copy">
            <span className="surface-tab-title">{tab.title}</span>
          </span>
          {activity ? <span className={`surface-tab-chat-status ${activity}`} aria-hidden="true" /> : null}
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
      <div
        ref={tabsRef}
        className={["surface-tabs", groupingActive ? "surface-tabs-grouped" : "", tabs.length > 8 ? "tab-count-dense" : tabs.length > 4 ? "tab-count-compact" : ""].filter(Boolean).join(" ")}
        role="tablist"
        aria-label="Open tabs"
        onKeyDown={handleTabListKeyDown}
      >
        {tabGroups.map((group) => {
          if (!group.spaceId) return group.tabs.map((tab) => renderSurfaceTab(tab, false));
          const tabSpace = spaces.find((item) => item.id === group.spaceId)
            ?? fallbackSpaceSummary(group.spaceId, "Space");
          const identity = spaceIdentityFor(tabSpace, spaceCustomizations);
          return (
            <span className="surface-tab-group" role="presentation" key={group.spaceId}>
              <span
                className="surface-tab-group-label"
                style={spaceIdentityStyle(identity)}
                title={tabSpace.name}
                aria-hidden="true"
              >
                <SpaceIconGlyph icon={identity.Icon} size={14} />
                <span>{tabSpace.name}</span>
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
          className="surface-tab-space-menu-anchor"
          ref={menuAnchorRef}
          onBlurCapture={(event) => {
            if (spaceMenuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSpaceMenuOpen(false);
          }}
        >
          <button
            ref={menuButtonRef}
            className="surface-tab-action surface-tab-new-chat-trigger"
            type="button"
            onClick={() => setSpaceMenuOpen((current) => !current)}
            aria-label="Start a new Chat"
            aria-haspopup="menu"
            aria-expanded={spaceMenuOpen}
            aria-controls="new-chat-space-menu"
            title="Start a new Chat"
          >
            <FluentGlyph icon={NewChatIcon} size={18} />
            <ChevronDown16Regular aria-hidden="true" />
          </button>
          {spaceMenuOpen ? (
            <div
              ref={menuRef}
              id="new-chat-space-menu"
              className="surface-tab-space-menu"
              role="menu"
              aria-label="Tab actions"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={handleSpaceMenuKeyDown}
            >
              <span className="surface-tab-space-menu-heading">New Chat in</span>
              {menuSpaces.map((item) => {
                const identity = spaceIdentityFor(item, spaceCustomizations);
                const Icon = identity.Icon;
                const current = item.id === newChatSpaceId;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    key={item.id}
                    style={spaceIdentityStyle(identity)}
                    onClick={() => handleSpaceMenuSelect(item)}
                    title={`New Chat in ${item.name}`}
                  >
                    <span className="space-identity-icon"><SpaceIconGlyph icon={Icon} size={14} /></span>
                    <span className="surface-tab-space-menu-copy"><strong>{item.name}</strong>{current ? <small>Current Space</small> : null}</span>
                  </button>
                );
              })}
              <span className="surface-tab-space-menu-separator" role="separator" />
              <span className="surface-tab-space-menu-heading">Tab layout</span>
              <button
                className="surface-tab-group-toggle"
                type="button"
                role="menuitemcheckbox"
                aria-checked={groupBySpace}
                tabIndex={-1}
                onClick={toggleSpaceGrouping}
              >
                <span className="surface-tab-menu-check" aria-hidden="true">{groupBySpace ? <Checkmark16Regular /> : null}</span>
                <span className="surface-tab-space-menu-copy">
                  <strong>Group by Space</strong>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function fallbackSpaceSummary(id: string, name: string): SpaceSummary {
  return {
    id,
    name,
    rootPath: "",
    location: { kind: "local", storage: "linked" },
    createdAt: "",
    updatedAt: "",
  };
}
