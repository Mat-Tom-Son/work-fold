import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowDownload20Regular,
  ArrowClockwise20Regular,
  ArrowReset20Regular,
  ArrowUndo20Regular,
  ArrowUpload20Regular,
  Add24Regular,
  Apps24Filled,
  Apps24Regular,
  ChatMultiple24Filled,
  ChatMultiple24Regular,
  Checkmark16Regular,
  Checkmark20Regular,
  ChevronDown20Regular,
  Dismiss20Regular,
  DocumentFolder24Filled,
  DocumentFolder24Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History24Filled,
  History24Regular,
  ImageAdd20Regular,
  Keyboard24Regular,
  Search20Regular,
  ShieldCheckmark20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import {
  accentIdentityFromHex,
  createSpaceAppearanceProposal,
  parseSpaceAppearanceProposal,
  upgradeSpaceAppearanceCustomization,
} from "../../../../src/shared/space-appearance";
import { filterWorkspaceIconOptions, workspaceIconOptionFor, workspaceIconOptions } from "../../workspace-icons";
import { workspaceBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { normalizeWorkspaceCustomizations } from "../../lib/workspace-customization";
import { normalizeWorkspaceColor, processWorkspaceBannerImageFile, workspaceColorOptions, workspaceIdentityFor, workspaceIdentityStyle, type WorkspaceIdentity } from "../../lib/workspace-identity";
import { workspaceLookOptions } from "../../lib/workspace-looks";
import { surfaceDomIdSuffix, workspaceHeaderSourceBadgeLabel } from "../../lib/workspace-ui";
import type { AssistantToolsView, CapabilitySurface, RestrictedAppInstalled, WorkspaceCustomization, WorkspaceCustomizationMap, WorkspaceCustomizationPatch, WorkspaceRailMode, WorkspaceSummary } from "../../types";
import { WorkspaceIconGlyph } from "../chrome/common";

function WorkspaceModeRail({
  activeMode,
  workspace,
  surfaces,
  apps,
  onModeChange,
  onOpenLibrary,
  onOpenAssistantTools,
  onBuildApp,
  accountControl,
  onOpenKeyboardShortcuts,
  updateControl,
}: {
  activeMode: WorkspaceRailMode;
  workspace: WorkspaceSummary;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  onModeChange: (mode: WorkspaceRailMode) => void;
  onOpenLibrary: () => void;
  onOpenAssistantTools: (view: AssistantToolsView) => void;
  onBuildApp: () => void;
  accountControl: ReactNode;
  onOpenKeyboardShortcuts: () => void;
  updateControl?: ReactNode;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const addAnchorRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  useNativeRailTooltips(railRef);
  const FilesIcon = activeMode === "files" ? DocumentFolder24Filled : DocumentFolder24Regular;
  const ChatsIcon = activeMode === "chats" ? ChatMultiple24Filled : ChatMultiple24Regular;
  const HistoryIcon = activeMode === "history" ? History24Filled : History24Regular;
  const primaryItems: Array<{ mode: WorkspaceRailMode; label: string; ariaLabel: string; title: string; icon: ReactNode }> = [
    { mode: "files", label: "Files", ariaLabel: "Files", title: "Files in this Space", icon: <FilesIcon className="fluent-rail-icon" /> },
    { mode: "chats", label: "Chats", ariaLabel: "Chats", title: "Chats", icon: <ChatsIcon className="fluent-rail-icon" /> },
    { mode: "history", label: "History", ariaLabel: "History", title: "Restore points and recent activity", icon: <HistoryIcon className="fluent-rail-icon" /> },
  ];

  useEffect(() => {
    if (!addOpen) return;
    window.requestAnimationFrame(() => addMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function closeFromOutside(event: PointerEvent): void {
      if (addAnchorRef.current?.contains(event.target as Node)) return;
      setAddOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAddOpen(false);
      window.requestAnimationFrame(() => addButtonRef.current?.focus());
    }
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [addOpen]);

  function chooseAddAction(action: () => void): void {
    setAddOpen(false);
    action();
  }

  function handleAddMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(addMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <nav ref={railRef} className="workspace-mode-rail professional-workspace-rail" aria-label="Workspace navigation">
      <div className="workspace-rail-nav">
        {primaryItems.map((item) => (
          <button
            className={[
              "workspace-rail-button",
              activeMode === item.mode ? "active" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            key={item.mode}
            onClick={() => onModeChange(item.mode)}
            aria-label={item.ariaLabel}
            aria-current={activeMode === item.mode ? "page" : undefined}
            data-rail-tooltip={item.title}
          >
            <span className="workspace-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="workspace-rail-label">{item.label}</span>
          </button>
        ))}
        {surfaces.length || apps.length ? <span className="workspace-rail-app-divider" aria-hidden="true" /> : null}
        {surfaces.map((surface) => {
          const mode = `app:${surface.key}` as const;
          const SurfaceIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = surface.icon ? workspaceIconOptionFor(surface.icon) : null;
          return (
            <button
              className={["workspace-rail-button", "workspace-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={surface.key}
              onClick={() => onModeChange(mode)}
              aria-label={surface.title}
              aria-current={activeMode === mode ? "page" : undefined}
              data-rail-tooltip={`${surface.title} · ${surface.scope === "project" ? "Pi Extension · This Space" : "Pi Extension · Personal"}`}
            >
              <span className="workspace-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <WorkspaceIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <SurfaceIcon className="fluent-rail-icon" />}
              </span>
              <span className="workspace-rail-label">{surface.title}</span>
            </button>
          );
        })}
        {apps.map((app) => {
          const mode = `app:restricted:${workspace.id}:${app.manifest.id}` as const;
          const AppIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = app.manifest.ui.icon ? workspaceIconOptionFor(app.manifest.ui.icon) : null;
          return (
            <button
              className={["workspace-rail-button", "workspace-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={`${app.manifest.id}:${app.digest}`}
              onClick={() => onModeChange(mode)}
              aria-label={app.manifest.title}
              aria-current={activeMode === mode ? "page" : undefined}
              data-rail-tooltip={`${app.manifest.title} · Sandboxed app · This Space`}
            >
              <span className="workspace-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <WorkspaceIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <AppIcon className="fluent-rail-icon" />}
              </span>
              <span className="workspace-rail-label">{app.manifest.title}</span>
            </button>
          );
        })}
      </div>
      <div className="workspace-rail-account">
        <div className="workspace-rail-tools">
          {updateControl ? <div className="workspace-rail-update">{updateControl}</div> : null}
          <div className="workspace-rail-add-anchor" ref={addAnchorRef} onBlurCapture={(event) => { if (addOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setAddOpen(false); }}>
            <button
              ref={addButtonRef}
              className="workspace-rail-quiet-button workspace-rail-add-button"
              type="button"
              onClick={() => setAddOpen((current) => !current)}
              aria-label="Add or manage"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              aria-controls="workspace-add-menu"
              data-rail-tooltip="Add or manage"
            >
              <Add24Regular aria-hidden="true" />
              <span>Add</span>
            </button>
            {addOpen ? (
              <div ref={addMenuRef} id="workspace-add-menu" className="workspace-rail-add-menu" role="menu" aria-label="Add or manage" onKeyDown={handleAddMenuKeyDown}>
                <span className="workspace-rail-add-menu-heading">Add or manage</span>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(onOpenLibrary)}><strong>Open Library</strong><span>Reuse files across your Spaces</span></button>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(() => onOpenAssistantTools("discover"))}><strong>Browse Skills &amp; Extensions</strong><span>Review tools before installing them</span></button>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(() => onBuildApp())}><strong>Build an app</strong><span>Start with the Assistant in this Space</span></button>
                <span className="workspace-rail-add-menu-divider" aria-hidden="true" />
                <button type="button" role="menuitem" onClick={() => chooseAddAction(() => onOpenAssistantTools("installed"))}><strong>Manage Assistant tools</strong><span>Inspect scope, source, and access</span></button>
              </div>
            ) : null}
          </div>
          <button
            className="workspace-rail-quiet-button"
            type="button"
            onClick={onOpenKeyboardShortcuts}
            aria-label="Keyboard shortcuts"
            data-rail-tooltip="Keyboard shortcuts"
          >
            <Keyboard24Regular aria-hidden="true" />
            <span>Shortcuts</span>
          </button>
        </div>
        <div className="workspace-rail-settings-control">
          {accountControl}
        </div>
      </div>
    </nav>
  );
}

function useNativeRailTooltips(railRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const tooltip = window.workspaceDesktop?.window.railTooltip;
    const rail = railRef.current;
    if (!tooltip || !rail) return;
    let timer = 0;
    let target: HTMLElement | null = null;

    function hide(): void {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      target = null;
      tooltip?.hide();
    }

    function schedule(nextTarget: HTMLElement, delay: number): void {
      if (timer) window.clearTimeout(timer);
      tooltip?.hide();
      target = nextTarget;
      timer = window.setTimeout(() => {
        timer = 0;
        if (target !== nextTarget || !nextTarget.isConnected) return;
        const text = nextTarget.dataset.railTooltip?.trim();
        if (!text) return;
        tooltip?.show(nativeRailTooltipRequest(nextTarget, text));
      }, delay);
    }

    function handlePointerOver(event: PointerEvent): void {
      const nextTarget = railTooltipTarget(event.target);
      if (!nextTarget || railTooltipTarget(event.relatedTarget) === nextTarget) return;
      schedule(nextTarget, 320);
    }

    function handlePointerOut(event: PointerEvent): void {
      const previousTarget = railTooltipTarget(event.target);
      if (!previousTarget || railTooltipTarget(event.relatedTarget) === previousTarget) return;
      hide();
    }

    function handleFocusIn(event: FocusEvent): void {
      const nextTarget = railTooltipTarget(event.target);
      if (nextTarget) schedule(nextTarget, 40);
    }

    function handleFocusOut(event: FocusEvent): void {
      const previousTarget = railTooltipTarget(event.target);
      if (!previousTarget || railTooltipTarget(event.relatedTarget) === previousTarget) return;
      hide();
    }

    rail.addEventListener("pointerover", handlePointerOver);
    rail.addEventListener("pointerout", handlePointerOut);
    rail.addEventListener("pointerdown", hide, true);
    rail.addEventListener("focusin", handleFocusIn);
    rail.addEventListener("focusout", handleFocusOut);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      rail.removeEventListener("pointerover", handlePointerOver);
      rail.removeEventListener("pointerout", handlePointerOut);
      rail.removeEventListener("pointerdown", hide, true);
      rail.removeEventListener("focusin", handleFocusIn);
      rail.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      hide();
    };
  }, [railRef]);
}

function nativeRailTooltipRequest(target: HTMLElement, text: string) {
  const rect = target.getBoundingClientRect();
  const context = document.createElement("canvas").getContext("2d");
  if (context) context.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const measuredWidth = context?.measureText(text).width ?? text.length * 7;
  const width = Math.ceil(Math.max(48, Math.min(260, measuredWidth + 16)));
  const height = 28;
  const x = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right + 8));
  const y = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top + (rect.height - height) / 2));
  return {
    text,
    bounds: { x, y, width, height },
    theme: document.documentElement.dataset.theme === "dark" ? "dark" as const : "light" as const,
  };
}

function railTooltipTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".professional-workspace-rail [data-rail-tooltip]")
    : null;
}

function WorkspacePaneHeader({
  workspace,
  identity,
  workspaces,
  workspaceCustomizations,
  onSwitchWorkspace,
  onCreateSpace,
  onOpenFolder,
  onManageSpaces,
  managingSpaces = false,
  switchable = true,
  action,
}: {
  workspace: WorkspaceSummary;
  identity: WorkspaceIdentity;
  workspaces: WorkspaceSummary[];
  workspaceCustomizations: WorkspaceCustomizationMap;
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onManageSpaces: () => void;
  managingSpaces?: boolean;
  switchable?: boolean;
  action?: ReactNode;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherEnabled = switchable && Boolean(workspaceCustomizations && onSwitchWorkspace);
  const switcherId = `space-header-switcher-${surfaceDomIdSuffix(workspace.id)}`;
  const detail = workspaceHeaderSourceBadgeLabel(workspace);
  const headerClassName = [
    "workspace-pane-current",
    "workspace-pane-header",
    "professional-pane-header",
    "workspace-banner-surface",
    "space-identity-header",
    `banner-${identity.bannerName}`,
    identity.bannerImage ? "has-banner-image" : "",
    switcherEnabled ? "has-switcher" : "",
    switcherOpen ? "switcher-open" : "",
    action ? "has-action" : "",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    if (!switcherEnabled) setSwitcherOpen(false);
  }, [switcherEnabled]);

  useEffect(() => {
    if (!switcherOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (headerRef.current?.contains(event.target as Node)) return;
      setSwitcherOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSwitcherOpen(false);
      window.requestAnimationFrame(() => switchTriggerRef.current?.focus());
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherOpen]);

  function toggleSwitcher() {
    if (!switcherEnabled) return;
    setSwitcherOpen((current) => !current);
  }

  const identityLockup = (
    <span className="workspace-pane-current-copy space-identity-header-copy">
      <span className="workspace-pane-current-lockup">
        <strong>{workspace.name}</strong>
      </span>
      <span className="sr-only">{detail}</span>
    </span>
  );

  return (
    <div
      className="workspace-pane-header-wrap space-identity-header-wrap"
      ref={headerRef}
      onBlurCapture={(event) => {
        if (switcherOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSwitcherOpen(false);
      }}
    >
      <div
        className={headerClassName}
        style={workspaceIdentityStyle(identity)}
        aria-label={switcherEnabled ? undefined : `Current Space: ${workspace.name}. ${detail}`}
      >
        {identity.bannerImage ? (
          <span className="workspace-pane-banner-image" aria-hidden="true">
            <img src={identity.bannerImage} alt="" draggable={false} style={{ objectPosition: `center ${identity.bannerImagePosition}` }} />
            <span className="workspace-pane-banner-scrim" />
          </span>
        ) : null}
        {switcherEnabled ? (
          <button
            ref={switchTriggerRef}
            className="workspace-pane-switch-trigger"
            type="button"
            aria-label={`Current Space: ${workspace.name}. ${detail}. Switch Space`}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-controls={switcherId}
            onClick={toggleSwitcher}
            title="Switch Space"
          >
            {identityLockup}
            <ChevronDown20Regular className="workspace-pane-switch-caret" aria-hidden="true" />
          </button>
        ) : identityLockup}
        {action ? (
          <span className="workspace-pane-header-action professional-header-action workspace-pane-action-group">
            {action}
          </span>
        ) : null}
      </div>
      {switcherEnabled && switcherOpen ? (
        <WorkspaceHeaderSwitcher
          id={switcherId}
          currentWorkspace={workspace}
          workspaces={workspaces}
          workspaceCustomizations={workspaceCustomizations}
          onSwitchWorkspace={onSwitchWorkspace}
          onCreateSpace={onCreateSpace}
          onOpenFolder={onOpenFolder}
          onManageSpaces={onManageSpaces}
          managingSpaces={managingSpaces}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}
    </div>
  );
}

function WorkspaceHeaderSwitcher({
  id,
  currentWorkspace,
  workspaces,
  workspaceCustomizations,
  onSwitchWorkspace,
  onCreateSpace,
  onOpenFolder,
  onManageSpaces,
  managingSpaces,
  onClose,
}: {
  id: string;
  currentWorkspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  workspaceCustomizations: WorkspaceCustomizationMap;
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onManageSpaces: () => void;
  managingSpaces: boolean;
  onClose: () => void;
}) {
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(switcherRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="workspace-header-switcher professional-space-switcher" id={id} role="menu" aria-label="Space menu" data-native-view-occluder="true" ref={switcherRef} onKeyDown={handleMenuKeyDown}>
      <div className="workspace-header-switcher-list">
        {[currentWorkspace, ...workspaces
          .filter((item) => item.id !== currentWorkspace.id)
          .sort((left, right) => left.name.localeCompare(right.name))].map((item) => {
          const active = item.id === currentWorkspace.id;
          const itemIdentity = workspaceIdentityFor(item, workspaceCustomizations);
          return (
            <button
              className={active ? "workspace-header-switcher-row active" : "workspace-header-switcher-row"}
              type="button"
              role="menuitem"
              key={item.id}
              aria-current={active ? "page" : undefined}
              style={workspaceIdentityStyle(itemIdentity)}
              onClick={() => {
                onClose();
                if (!active) onSwitchWorkspace(item);
              }}
            >
              <span className="workspace-header-switcher-icon" aria-hidden="true" data-space-icon={itemIdentity.iconName}><WorkspaceIconGlyph icon={itemIdentity.Icon} size={17} filled /></span>
              <span className="workspace-header-switcher-copy"><strong>{item.name}</strong></span>
              <span className="workspace-header-switcher-badge">{workspaceHeaderSourceBadgeLabel(item)}</span>
              {active ? <Checkmark16Regular className="workspace-header-switcher-check" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="workspace-header-switcher-actions" aria-label="Space actions">
        <button
          className="workspace-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onOpenFolder();
          }}
        >
          <FolderOpen20Regular aria-hidden="true" />
          <span>Use existing folder</span>
        </button>
        <button
          className="workspace-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCreateSpace();
          }}
        >
          <FolderAdd20Regular aria-hidden="true" />
          <span>Create new Space</span>
        </button>
        <button
          className={managingSpaces ? "workspace-header-switcher-action workspace-header-switcher-manage active" : "workspace-header-switcher-action workspace-header-switcher-manage"}
          type="button"
          role="menuitem"
          aria-current={managingSpaces ? "page" : undefined}
          onClick={() => {
            onClose();
            onManageSpaces();
          }}
        >
          <Apps24Regular aria-hidden="true" />
          <span>Manage Spaces</span>
        </button>
      </div>
    </div>
  );
}

function WorkspaceRenameEditor({
  open,
  workspace,
  onRenameWorkspace,
  onClose,
}: {
  open: boolean;
  workspace: WorkspaceSummary;
  onRenameWorkspace: (workspace: WorkspaceSummary, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(workspace.name);
    setSaving(false);
    setError(null);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, workspace.id, workspace.name]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a Space name.");
      return;
    }
    if (nextName === workspace.name) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameWorkspace(workspace, nextName);
      onClose();
    } catch (renameError) {
      setError(errorText(renameError));
      setSaving(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || saving) return;
    event.preventDefault();
    onClose();
  }

  return (
    <div className="workspace-rename-panel">
      <form className="workspace-rename-form" onSubmit={(event) => void handleSubmit(event)}>
        <input
          ref={inputRef}
          value={name}
          maxLength={80}
          autoComplete="off"
          disabled={saving}
          onChange={(event) => {
            setName(event.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          aria-label={`Space name for ${workspace.name}`}
        />
        <button className="workspace-rename-action save" type="submit" disabled={saving || !name.trim()} aria-label="Save Space name" title="Save">
          {saving ? <ArrowClockwise20Regular className="spin" /> : <Checkmark20Regular />}
        </button>
        <button className="workspace-rename-action" type="button" disabled={saving} onClick={onClose} aria-label="Cancel rename" title="Cancel">
          <Dismiss20Regular />
        </button>
      </form>
      {error ? <span className="workspace-rename-error">{error}</span> : null}
    </div>
  );
}

const recommendedWorkspaceIconNames = new Set(["folder", "home", "briefcase", "files", "messages", "notebook", "calendar", "target", "people-team", "airplane", "star", "rocket"]);

function WorkspaceAppearancePanel({
  workspace,
  identity,
  customization,
  canUndo,
  onCustomizeWorkspace,
  onReplaceWorkspace,
  onUndoWorkspace,
  onResetWorkspace,
}: {
  workspace: WorkspaceSummary;
  identity: WorkspaceIdentity;
  customization?: WorkspaceCustomization;
  canUndo: boolean;
  onCustomizeWorkspace: (workspaceId: string, patch: WorkspaceCustomizationPatch) => void;
  onReplaceWorkspace: (workspaceId: string, customization: WorkspaceCustomization) => void;
  onUndoWorkspace: (workspaceId: string) => void;
  onResetWorkspace: (workspaceId: string) => void;
}) {
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [showAllIcons, setShowAllIcons] = useState(false);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const workspaceId = workspace.id;
  const filteredWorkspaceIconOptions = useMemo(() => {
    const matches = filterWorkspaceIconOptions(iconSearchQuery);
    if (iconSearchQuery.trim() || showAllIcons) return matches;
    return matches.filter((option) => recommendedWorkspaceIconNames.has(option.name));
  }, [iconSearchQuery, showAllIcons]);
  const looks = useMemo(() => workspaceLookOptions.map((look) => ({
    ...look,
    identity: workspaceIdentityFor(workspace, {
      [workspace.id]: { color: look.primary, color2: look.secondary, bannerName: look.bannerName },
    }),
  })), [workspace]);
  const activeLook = looks.find((look) => (
    !identity.bannerImage
    && identity.hasCustomSecondary
    && identity.color === look.primary
    && identity.secondaryColor === look.secondary
    && identity.bannerName === look.bannerName
  ));
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    setIconSearchQuery("");
    setShowAllIcons(false);
    setBannerUploadBusy(false);
    setBannerUploadError(null);
    setProposalImportError(null);
  }, [workspaceId]);

  const appearancePasses = identity.resolved.passes;
  const uncertified = identity.resolved.uncertified.length > 0;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processWorkspaceBannerImageFile(file);
      onCustomizeWorkspace(workspaceId, { bannerImage });
    } catch (uploadError) {
      setBannerUploadError(errorText(uploadError));
    } finally {
      setBannerUploadBusy(false);
    }
  }

  function exportAppearanceProposal() {
    setProposalImportError(null);
    const upgraded = upgradeSpaceAppearanceCustomization(customization ?? {});
    const proposal = createSpaceAppearanceProposal({
      name: `${workspace.name} appearance`,
      description: "A safe, code-free Workspace Space appearance preset.",
      target: { workspaceId: workspace.id, workspaceName: workspace.name },
      customization: {
        ...upgraded,
        schema: 2,
        primary: upgraded.primary ?? accentIdentityFromHex(identity.color),
        ...(identity.hasCustomSecondary
          ? { secondary: upgraded.secondary ?? accentIdentityFromHex(identity.secondaryColor) }
          : {}),
      },
      createdBy: "human",
    });
    const blob = new Blob([`${JSON.stringify(proposal, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${workspace.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space"}-appearance.workspace.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function importAppearanceProposal(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setProposalImportError(null);
    try {
      if (file.size > 850_000) throw new Error("Appearance proposal is too large.");
      const proposal = parseSpaceAppearanceProposal(JSON.parse(await file.text()));
      const normalized = normalizeWorkspaceCustomizations(
        { [workspaceId]: proposal.customization },
        new Set([workspaceId]),
        new Set(workspaceIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])])),
      )[workspaceId];
      if (!normalized) throw new Error("The proposal does not contain a supported appearance.");
      onReplaceWorkspace(workspaceId, normalized);
    } catch (caught) {
      setProposalImportError(errorText(caught));
    }
  }

  return (
    <div className="workspace-appearance-inner">
      <div className="workspace-appearance-toolbar">
        <div>
          <strong>Space appearance</strong>
          <span>Saved on this computer. Importing a preset never runs code.</span>
        </div>
        <div className="workspace-appearance-toolbar-actions">
          <button type="button" disabled={!canUndo} onClick={() => onUndoWorkspace(workspaceId)} title="Undo the last appearance change">
            <ArrowUndo20Regular />
            Undo
          </button>
          <button type="button" onClick={() => proposalFileInputRef.current?.click()} title="Apply a Workspace appearance proposal">
            <ArrowUpload20Regular />
            Import
          </button>
          <button type="button" onClick={exportAppearanceProposal} title="Save a code-free appearance proposal">
            <ArrowDownload20Regular />
            Export
          </button>
          <button className="workspace-appearance-reset" type="button" disabled={!customized} onClick={() => onResetWorkspace(workspaceId)}>
            <ArrowReset20Regular />
            Reset
          </button>
          <input
            ref={proposalFileInputRef}
            className="workspace-banner-file-input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => void importAppearanceProposal(event)}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
      </div>
      {proposalImportError ? <div className="workspace-appearance-import-error" role="alert"><Warning20Regular aria-hidden="true" /><span>{proposalImportError}</span></div> : null}
      <div className="workspace-appearance-previews" aria-label="Light and dark Space previews">
        {(["light", "dark"] as const).map((mode) => (
          <div
            className={["workspace-appearance-preview", "workspace-banner-surface", `preview-${mode}`, `banner-${identity.bannerName}`, identity.bannerImage ? "has-banner-image" : ""].filter(Boolean).join(" ")}
            style={{ ...workspaceIdentityStyle(identity, mode), colorScheme: mode }}
            data-preview-mode={mode}
            key={mode}
          >
            {identity.bannerImage ? <span className="workspace-appearance-preview-image" aria-hidden="true"><img src={identity.bannerImage} alt="" draggable={false} style={{ objectPosition: `center ${identity.bannerImagePosition}` }} /><span /></span> : null}
            <span className="workspace-appearance-preview-copy"><strong>{workspace.name}</strong><small className="sr-only">{workspaceHeaderSourceBadgeLabel(workspace)}</small></span>
            <span className="workspace-appearance-preview-label">{mode === "light" ? "Light" : "Dark"}</span>
          </div>
        ))}
      </div>
      <div className={appearancePasses ? "workspace-appearance-audit passes" : "workspace-appearance-audit warning"}>
        {appearancePasses ? <ShieldCheckmark20Regular aria-hidden="true" /> : <Warning20Regular aria-hidden="true" />}
        <span>
          <strong>{appearancePasses ? "Readable in light and dark" : "Some roles need attention"}</strong>
          <small>
            {appearancePasses
              ? `${activeLook ? `${activeLook.name} is pre-checked. ` : ""}The generated text, icon, active-border, and marker roles meet their contrast targets.${uncertified ? " Decorative banners stay advisory." : ""}`
              : "Choose a different accent to restore readable text and controls."}
          </small>
        </span>
      </div>
      <div className="workspace-appearance-row looks">
        <span className="workspace-appearance-label">
          <strong>Looks</strong>
          <small>{activeLook ? `${activeLook.name} selected. Fine-tune anything below.` : "Start with a balanced color pair and finish."}</small>
        </span>
        <div className="workspace-look-gallery" role="group" aria-label="Curated Space looks">
          {looks.map((look) => {
            const active = activeLook?.name === look.name;
            return (
              <button
                className={active ? "workspace-look-card active" : "workspace-look-card"}
                key={look.name}
                type="button"
                style={workspaceIdentityStyle(look.identity)}
                onClick={() => onCustomizeWorkspace(workspaceId, {
                  color: look.primary,
                  color2: look.secondary,
                  bannerName: look.bannerName,
                  bannerImage: undefined,
                })}
                aria-label={`Use ${look.name} look: ${look.hint}`}
                aria-pressed={active}
                title={`${look.name} · ${look.hint}`}
              >
                <span className={["workspace-look-swatch", "workspace-banner-surface", `banner-${look.bannerName}`].join(" ")} aria-hidden="true">
                  {active ? <Checkmark16Regular /> : null}
                </span>
                <span className="workspace-look-copy"><strong>{look.name}</strong><small>{look.hint}</small></span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="workspace-appearance-fine-tune">
        <strong>Fine tune</strong>
        <span>Adjust one part without losing the rest of the look.</span>
      </div>
      <div className="workspace-appearance-row colors">
        <span className="workspace-appearance-label"><strong>Accent</strong><small>Identify this Space without recoloring the app.</small></span>
        <div className="workspace-color-controls">
          <div className="workspace-color-swatches" role="group" aria-label="Space color presets">
            {workspaceColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "workspace-color-swatch active" : "workspace-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft } as CSSProperties}
                onClick={() => onCustomizeWorkspace(workspaceId, { color: option.color })}
                aria-label={`Use ${option.label} color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                {identity.color === option.color ? <Checkmark20Regular /> : null}
              </button>
            ))}
          </div>
          <div className="workspace-color-wheels">
            <label className="workspace-color-picker" style={workspaceIdentityStyle(identity)}>
              <span className="workspace-color-wheel" aria-hidden="true">
                <span className="workspace-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeWorkspace(workspaceId, { color: normalizeWorkspaceColor(event.currentTarget.value) })}
                aria-label="Choose Space color"
              />
              <span className="workspace-color-value">{identity.color.toUpperCase()}</span>
            </label>
            <label
              className={identity.hasCustomSecondary ? "workspace-color-picker secondary" : "workspace-color-picker secondary matched"}
              style={{ ...workspaceIdentityStyle(identity), "--workspace-picker-color": identity.secondaryColor } as CSSProperties}
              title="Second banner color"
            >
              <span className="workspace-color-wheel" aria-hidden="true">
                <span className="workspace-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.secondaryColor}
                onInput={(event) => onCustomizeWorkspace(workspaceId, { color2: normalizeWorkspaceColor(event.currentTarget.value) })}
                aria-label="Choose second banner color"
              />
              <span className="workspace-color-value">{identity.hasCustomSecondary ? identity.secondaryColor.toUpperCase() : "+ Pair"}</span>
            </label>
            {identity.hasCustomSecondary ? (
              <button
                className="workspace-color-pair-clear"
                type="button"
                onClick={() => onCustomizeWorkspace(workspaceId, { color2: undefined })}
                aria-label="Remove second banner color"
                title="Match primary color"
              >
                <Dismiss20Regular />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="workspace-appearance-row banners">
        <span className="workspace-appearance-label"><strong>Banner</strong><small>Choose a restrained pattern or your own image.</small></span>
        <div className="workspace-banner-picker" style={workspaceIdentityStyle(identity)}>
          <div className="workspace-banner-gallery" role="group" aria-label="Space banner styles">
            {workspaceBannerOptions.map((option) => {
              const active = !identity.bannerImage && identity.bannerName === option.name;
              return (
                <button
                  className={[
                    "workspace-banner-swatch",
                    "workspace-banner-surface",
                    `banner-${option.name}`,
                    active ? "active" : "",
                  ].filter(Boolean).join(" ")}
                  key={option.name}
                  type="button"
                  onClick={() => onCustomizeWorkspace(workspaceId, { bannerName: option.name, bannerImage: undefined })}
                  aria-label={`Use ${option.label} banner`}
                  aria-pressed={active}
                  title={option.label}
                >
                  <span className="workspace-banner-swatch-name">{option.label}</span>
                </button>
              );
            })}
            <button
              className={identity.bannerImage ? "workspace-banner-swatch upload has-image active" : "workspace-banner-swatch upload"}
              type="button"
              onClick={() => bannerFileInputRef.current?.click()}
              disabled={bannerUploadBusy}
              aria-label={identity.bannerImage ? "Replace custom banner image" : "Upload custom banner image"}
              aria-pressed={Boolean(identity.bannerImage)}
              title={identity.bannerImage ? "Replace image" : "Upload image"}
            >
              {identity.bannerImage ? <img src={identity.bannerImage} alt="" draggable={false} /> : null}
              <span className="workspace-banner-swatch-name">
                {bannerUploadBusy ? <ArrowClockwise20Regular className="spin" /> : <ImageAdd20Regular />}
                {identity.bannerImage ? "Replace" : "Upload"}
              </span>
            </button>
          </div>
          <input
            ref={bannerFileInputRef}
            className="workspace-banner-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            onChange={(event) => void handleBannerFileChange(event)}
            tabIndex={-1}
            aria-hidden="true"
          />
          {identity.bannerImage ? (
            <div className="workspace-banner-image-controls">
              <span>Image position</span>
              <div className="workspace-banner-position-control" role="radiogroup" aria-label="Banner image position">
                {(["top", "center", "bottom"] as const).map((position) => <button className={identity.bannerImagePosition === position ? "active" : ""} type="button" role="radio" aria-checked={identity.bannerImagePosition === position} key={position} onClick={() => onCustomizeWorkspace(workspaceId, { bannerImagePosition: position })}>{position[0]!.toUpperCase() + position.slice(1)}</button>)}
              </div>
              <button
                className="workspace-banner-remove"
                type="button"
                onClick={() => {
                  setBannerUploadError(null);
                  onCustomizeWorkspace(workspaceId, { bannerImage: undefined, bannerImagePosition: undefined });
                }}
                disabled={bannerUploadBusy}
              >
                <Dismiss20Regular />
                Remove image
              </button>
            </div>
          ) : null}
          {bannerUploadError ? <span className="workspace-banner-upload-error">{bannerUploadError}</span> : null}
        </div>
      </div>
      <div className="workspace-appearance-row icons">
        <span className="workspace-appearance-label"><strong>Icon</strong><small>Shown in the Space menu and tabs.</small></span>
        <div className="workspace-icon-picker">
          <label className="workspace-icon-search">
            <Search20Regular aria-hidden="true" />
            <input
              type="search"
              value={iconSearchQuery}
              onChange={(event) => setIconSearchQuery(event.currentTarget.value)}
              placeholder={`Search ${workspaceIconOptions.length} icons`}
              aria-label="Search Space icons"
            />
          </label>
          <div className="workspace-icon-grid" aria-label="Space icon">
            {filteredWorkspaceIconOptions.map((option) => {
              const Icon = option.Icon;
              return (
                <button
                  className={identity.iconName === option.name ? "workspace-icon-option active" : "workspace-icon-option"}
                  key={option.name}
                  type="button"
                  onClick={() => onCustomizeWorkspace(workspaceId, { iconName: option.name })}
                  aria-label={`Use ${option.label} icon`}
                  aria-pressed={identity.iconName === option.name}
                  title={option.label}
                >
                  <WorkspaceIconGlyph icon={Icon} size={18} filled={identity.iconName === option.name} />
                </button>
              );
            })}
          </div>
          <span className="workspace-icon-result-count">
            {filteredWorkspaceIconOptions.length ? `${filteredWorkspaceIconOptions.length} icons` : "No icons found"}
          </span>
          {!iconSearchQuery.trim() ? <button className="workspace-icon-browse" type="button" onClick={() => setShowAllIcons((current) => !current)}>{showAllIcons ? "Show recommended" : `Browse all ${workspaceIconOptions.length}`}</button> : null}
        </div>
      </div>
    </div>
  );
}

export { WorkspaceAppearancePanel, WorkspaceHeaderSwitcher, WorkspaceModeRail, WorkspacePaneHeader, WorkspaceRenameEditor };
