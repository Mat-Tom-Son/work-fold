import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown16Regular, Dismiss12Regular } from "@fluentui/react-icons";

import { chatDisplayTitle } from "../../lib/format";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { workspaceIdentityFor, workspaceIdentityStyle } from "../../lib/workspace-identity";
import { surfacePanelDomId, surfaceTabDomId } from "../../lib/workspace-ui";
import type { ChatActivityStatus, ConversationSummary, WorkspaceCustomizationMap, WorkspaceSummary, WorkspaceSurfaceTab } from "../../types";
import { FluentGlyph, NewChatIcon, WorkspaceIconGlyph } from "../chrome/common";

export function WorkspaceSurfaceTabBar({
  tabs,
  workspaces,
  workspaceCustomizations,
  conversations,
  chatActivityStatuses,
  activeTabId,
  newChatWorkspaceId,
  onActivate,
  onClose,
  onNewChatInWorkspace,
  onChatActions,
}: {
  tabs: WorkspaceSurfaceTab[];
  workspaces: WorkspaceSummary[];
  workspaceCustomizations: WorkspaceCustomizationMap;
  conversations: Record<string, ConversationSummary[]>;
  chatActivityStatuses: Record<string, ChatActivityStatus>;
  activeTabId: string | null;
  newChatWorkspaceId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewChatInWorkspace: (workspace: WorkspaceSummary) => void;
  onChatActions: (workspace: WorkspaceSummary, conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuWorkspaces = [
    ...workspaces.filter((item) => item.id === newChatWorkspaceId),
    ...workspaces.filter((item) => item.id !== newChatWorkspaceId),
  ];

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setWorkspaceMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setWorkspaceMenuOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [workspaceMenuOpen]);

  function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!tabs.length) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const lastIndex = tabs.length - 1;
    let nextIndex = currentIndex;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else if (event.key === "ArrowRight") nextIndex = activeIndex >= 0 ? (currentIndex + 1) % tabs.length : 0;
    else if (event.key === "ArrowLeft") nextIndex = activeIndex >= 0 ? (currentIndex - 1 + tabs.length) % tabs.length : lastIndex;

    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onActivate(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(surfaceTabDomId(nextTab.id))?.focus());
  }

  function workspaceMenuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function handleWorkspaceMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = workspaceMenuItems();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  function handleWorkspaceMenuSelect(targetWorkspace: WorkspaceSummary): void {
    setWorkspaceMenuOpen(false);
    onNewChatInWorkspace(targetWorkspace);
  }

  return (
    <div className={tabs.length ? "surface-tabbar" : "surface-tabbar empty"}>
      <div className="surface-tabs" role="tablist" aria-label="Open tabs" onKeyDown={handleTabListKeyDown}>
        {tabs.map((tab) => {
          const tabWorkspace = workspaces.find((item) => item.id === tab.workspaceId);
          const workspaceName = tabWorkspace?.name ?? "Space";
          const resolvedWorkspace = tabWorkspace ?? fallbackWorkspaceSummary(tab.workspaceId, workspaceName);
          const identity = workspaceIdentityFor(resolvedWorkspace, workspaceCustomizations);
          const Icon = identity.Icon;
          const style = workspaceIdentityStyle(identity);
          const activity = tab.kind === "chat" && tab.conversationId
            ? chatActivityStatuses[chatActivityKey(tab.workspaceId, tab.conversationId)]
            : undefined;
          const conversation = tab.kind === "chat" && tab.conversationId
            ? conversations[tab.workspaceId]?.find((item) => item.id === tab.conversationId)
            : undefined;
          const activityLabel = activity === "running" ? "Assistant working" : activity === "attention" ? "Assistant finished" : "";
          return (
            <span
              className={["surface-tab", tab.id === activeTabId ? "active" : "", activity ? `chat-${activity}` : ""].filter(Boolean).join(" ")}
              key={tab.id}
              style={style}
              title={`${tab.title} - ${workspaceName}${activityLabel ? ` · ${activityLabel}` : ""}`}
              onContextMenu={(event) => {
                if (tab.kind !== "chat" || !tab.conversationId) return;
                onChatActions(resolvedWorkspace, conversation ?? {
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
                aria-label={`${tab.title} in ${workspaceName}${activityLabel ? `, ${activityLabel}` : ""}`}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                onClick={() => onActivate(tab.id)}
              >
                <span className="surface-tab-icon" aria-hidden="true"><WorkspaceIconGlyph icon={Icon} size={15} /></span>
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
        })}
      </div>
      <div className="surface-tab-actions">
        <div
          className="surface-tab-workspace-menu-anchor"
          ref={menuAnchorRef}
          onBlurCapture={(event) => {
            if (workspaceMenuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkspaceMenuOpen(false);
          }}
        >
          <button
            ref={menuButtonRef}
            className="surface-tab-action surface-tab-new-chat-trigger"
            type="button"
            onClick={() => setWorkspaceMenuOpen((current) => !current)}
            aria-label="Start a new Chat"
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            aria-controls="new-chat-space-menu"
            title="Start a new Chat"
          >
            <FluentGlyph icon={NewChatIcon} size={18} />
            <ChevronDown16Regular aria-hidden="true" />
          </button>
          {workspaceMenuOpen ? (
            <div
              ref={menuRef}
              id="new-chat-space-menu"
              className="surface-tab-workspace-menu"
              role="menu"
              aria-label="Start a new Chat in Space"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={handleWorkspaceMenuKeyDown}
            >
              <span className="surface-tab-workspace-menu-heading">New Chat in</span>
              {menuWorkspaces.map((item) => {
                const identity = workspaceIdentityFor(item, workspaceCustomizations);
                const Icon = identity.Icon;
                const current = item.id === newChatWorkspaceId;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    key={item.id}
                    style={workspaceIdentityStyle(identity)}
                    onClick={() => handleWorkspaceMenuSelect(item)}
                    title={`New Chat in ${item.name}`}
                  >
                    <span className="workspace-identity-icon"><WorkspaceIconGlyph icon={Icon} size={14} /></span>
                    <span className="surface-tab-workspace-menu-copy"><strong>{item.name}</strong>{current ? <small>Current Space</small> : null}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function fallbackWorkspaceSummary(id: string, name: string): WorkspaceSummary {
  return {
    id,
    name,
    rootPath: "",
    location: { kind: "local", storage: "linked" },
    createdAt: "",
    updatedAt: "",
  };
}
