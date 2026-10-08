import { useSpaceIdentityResolver } from "../../lib/space-appearance-context";
import { restrictedAppRailMode, restrictedAppRailLabel } from "../../lib/restricted-app-navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { createPortal } from "react-dom";
import {
  ArrowDownload20Regular,
  ArrowClockwise20Regular,
  ArrowReset20Regular,
  ArrowUndo20Regular,
  ArrowUpload20Regular,
  Apps24Filled,
  ChatAdd16Regular,
  Folder16Regular,
  FolderOpen16Regular,
  PaintBrush16Regular,
  Apps24Regular,
  ChatMultiple24Filled,
  ChatMultiple24Regular,
  Checkmark16Regular,
  Checkmark20Regular,
  ChevronDown20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Dismiss20Regular,
  DocumentFolder24Filled,
  DocumentFolder24Regular,
  Flash24Filled,
  Flash24Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History24Filled,
  History24Regular,
  ImageAdd20Regular,
  Keyboard24Regular,
  Search20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import {
  accentIdentityFromHex,
  createSpaceAppearanceProposal,
  parseSpaceAppearanceProposal,
  upgradeSpaceAppearanceCustomization,
} from "../../../../src/shared/space-appearance";
import { filterSpaceIconOptions, spaceIconOptionFor, spaceIconOptions, spaceIconGroups, type SpaceIconGroupId } from "../../space-icons";
import { spaceBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { revealInFileManagerLabel } from "../../lib/file-actions";
import { normalizeSpaceCustomizations } from "../../lib/space-customization";
import { normalizeSpaceColor, processSpaceBannerImageFile, spaceColorOptions, spaceIdentityStyle, spaceBannerImageStyle, type SpaceIdentity } from "../../lib/space-identity";
import { SpaceBannerPreview } from "../chrome/SpaceBannerPreview";
import { spaceBannerPresets } from "../../lib/space-banner-presets";
import { readableTextColorOn } from "../../lib/color-contrast";
import { surfaceDomIdSuffix, spaceHeaderSourceBadgeLabel } from "../../lib/space-ui";
import type { AssistantToolsView, CapabilitySurface, ChatActivityStatus, RestrictedAppInstalled, SpaceCustomization, SpaceCustomizationMap, SpaceCustomizationPatch, SpaceRailMode, SpaceSummary } from "../../types";
import { SpaceIconGlyph } from "../chrome/common";
import { ActivityDot } from "../chrome/ActivityDot";
import { combineActivityStatuses, descendantFolders, folderAncestors, folderTreeRows } from "../../lib/folder-nesting";

function SpaceModeRail({
  activeMode,
  space,
  surfaces,
  apps,
  onModeChange,
  onOpenAssistantTools,
  accountControl,
  onOpenKeyboardShortcuts,
  updateControl,
  automations = null,
}: {
  activeMode: SpaceRailMode;
  space: SpaceSummary;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  onModeChange: (mode: SpaceRailMode) => void;
  /**
   * The Folder-owned Automations entry (docs/fold-routings.md, F15 as
   * amended 2026-09-24), present only while an automation touches this
   * Folder. `active` follows the Automations tab, not the navigator mode.
   */
  automations?: { active: boolean } | null;
  /** The rail's Add button opens the Skills & Extensions popup (2026-09-25: no Add menu, no Library, no Apps tab). */
  onOpenAssistantTools: (view: AssistantToolsView) => void;
  accountControl: ReactNode;
  onOpenKeyboardShortcuts: () => void;
  updateControl?: ReactNode;
}) {
  const FilesIcon = activeMode === "files" ? DocumentFolder24Filled : DocumentFolder24Regular;
  const ChatsIcon = activeMode === "chats" ? ChatMultiple24Filled : ChatMultiple24Regular;
  const HistoryIcon = activeMode === "history" ? History24Filled : History24Regular;
  const primaryItems: Array<{ mode: SpaceRailMode; label: string; ariaLabel: string; icon: ReactNode }> = [
    { mode: "files", label: "Files", ariaLabel: "Files", icon: <FilesIcon className="fluent-rail-icon" /> },
    { mode: "chats", label: "Chats", ariaLabel: "Chats", icon: <ChatsIcon className="fluent-rail-icon" /> },
    { mode: "history", label: "History", ariaLabel: "History", icon: <HistoryIcon className="fluent-rail-icon" /> },
  ];

  return (
    <nav className="space-mode-rail professional-space-rail" aria-label="work-fold navigation">
      <div className="space-rail-nav">
        {primaryItems.map((item) => (
          <button
            className={[
              "space-rail-button",
              activeMode === item.mode ? "active" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            key={item.mode}
            onClick={() => onModeChange(item.mode)}
            aria-label={item.ariaLabel}
            aria-current={activeMode === item.mode ? "page" : undefined}
          >
            <span className="space-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="space-rail-label">{item.label}</span>
          </button>
        ))}
        {automations ? (
          <button
            className={["space-rail-button", automations.active ? "active" : ""].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onModeChange("automations")}
            aria-label="Automations"
            aria-current={automations.active ? "page" : undefined}
          >
            <span className="space-rail-icon" aria-hidden="true">
              {automations.active ? <Flash24Filled className="fluent-rail-icon" /> : <Flash24Regular className="fluent-rail-icon" />}
            </span>
            <span className="space-rail-label">Automations</span>
          </button>
        ) : null}
        {surfaces.length || apps.length ? <span className="space-rail-app-divider" aria-hidden="true" /> : null}
        {surfaces.map((surface) => {
          const mode = `app:${surface.key}` as const;
          const SurfaceIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = surface.icon ? spaceIconOptionFor(surface.icon) : null;
          return (
            <button
              className={["space-rail-button", "space-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={surface.key}
              onClick={() => onModeChange(mode)}
              aria-label={surface.title}
              aria-current={activeMode === mode ? "page" : undefined}
            >
              <span className="space-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <SpaceIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <SurfaceIcon className="fluent-rail-icon" />}
              </span>
              <span className="space-rail-label">{surface.title}</span>
            </button>
          );
        })}
        {apps.map((app) => {
          const mode = restrictedAppRailMode(space.id, app.manifest.id, app.featureInstallationId);
          const label = restrictedAppRailLabel(app, apps);
          const AppIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = app.manifest.ui.icon ? spaceIconOptionFor(app.manifest.ui.icon) : null;
          return (
            <button
              className={["space-rail-button", "space-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={app.featureInstallationId}
              onClick={() => onModeChange(mode)}
              aria-label={label}
              aria-current={activeMode === mode ? "page" : undefined}
            >
              <span className="space-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <SpaceIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <AppIcon className="fluent-rail-icon" />}
              </span>
              <span className="space-rail-label">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="space-rail-account">
        <div className="space-rail-tools">
          {updateControl ? <div className="space-rail-update">{updateControl}</div> : null}
          <button
            className="space-rail-quiet-button space-rail-add-button"
            type="button"
            onClick={() => onOpenAssistantTools("installed")}
            aria-label="Skills & Extensions"
          >
            <Blocks size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>Add</span>
          </button>
          <button
            className="space-rail-quiet-button"
            type="button"
            onClick={onOpenKeyboardShortcuts}
            aria-label="Keyboard Shortcuts"
          >
            <Keyboard24Regular aria-hidden="true" />
            <span>Shortcuts</span>
          </button>
        </div>
        <div className="space-rail-settings-control">
          {accountControl}
        </div>
      </div>
    </nav>
  );
}

function SpacePaneHeader({
  space,
  identity,
  spaces,
  spaceCustomizations,
  onSwitchSpace,
  onCreateSpace,
  onOpenFolder,
  onManageSpaces,
  managingSpaces = false,
  switchable = true,
  action,
  onNewChat,
  onOpenAppearance,
  onRevealFolder,
  folderStatuses = {},
}: {
  space: SpaceSummary;
  identity: SpaceIdentity;
  spaces: SpaceSummary[];
  spaceCustomizations: SpaceCustomizationMap;
  /** One activity status per Folder id (2026-10-01): dots in the switcher and on the header. */
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  onSwitchSpace: (space: SpaceSummary) => void;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onManageSpaces: () => void;
  managingSpaces?: boolean;
  switchable?: boolean;
  action?: ReactNode;
  /** Right-click actions on the Folder header (2026-09-25). */
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherEnabled = switchable && Boolean(spaceCustomizations && onSwitchSpace);
  const switcherId = `space-header-switcher-${surfaceDomIdSuffix(space.id)}`;
  const detail = spaceHeaderSourceBadgeLabel(space);
  const ancestors = useMemo(() => folderAncestors(space, spaces), [space, spaces]);
  const breadcrumbIdentityFor = useSpaceIdentityResolver();
  const hiddenAncestors = ancestors.length > 2 ? ancestors.slice(0, -2) : [];
  const [breadcrumbMenuOpen, setBreadcrumbMenuOpen] = useState(false);
  const breadcrumbMoreRef = useRef<HTMLButtonElement>(null);
  const breadcrumbMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setBreadcrumbMenuOpen(false); }, [space.id]);
  useEffect(() => {
    if (!breadcrumbMenuOpen) return;
    window.requestAnimationFrame(() => breadcrumbMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function closeOnOutside(event: PointerEvent) {
      if (breadcrumbMenuRef.current?.contains(event.target as Node) || breadcrumbMoreRef.current?.contains(event.target as Node)) return;
      setBreadcrumbMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setBreadcrumbMenuOpen(false);
      breadcrumbMoreRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [breadcrumbMenuOpen]);

  function renderCrumb(item: SpaceSummary, role?: "menuitem") {
    // Each containing Folder is a small pill in its own icon and color.
    const crumbIdentity = breadcrumbIdentityFor(item, spaceCustomizations);
    return (
      <button
        className="space-pane-breadcrumb-link"
        type="button"
        role={role}
        tabIndex={role ? -1 : undefined}
        title={`Back to ${item.name}`}
        style={spaceIdentityStyle(crumbIdentity)}
        onClick={() => { setBreadcrumbMenuOpen(false); onSwitchSpace(item); }}
      >
        <span className="space-pane-breadcrumb-icon" aria-hidden="true"><SpaceIconGlyph icon={crumbIdentity.Icon} size={11} filled /></span>
        <span className="space-pane-breadcrumb-name">{item.name}</span>
      </button>
    );
  }
  // The header's dot speaks for the Folders inside this one: a parent shows
  // at a glance when one of its Workers is busy or has a reply waiting.
  const nestedStatus = useMemo(
    () => combineActivityStatuses(descendantFolders(space, spaces).map((item) => folderStatuses[item.id])),
    [folderStatuses, space, spaces],
  );
  const headerClassName = [
    "space-pane-current",
    "space-pane-header",
    "professional-pane-header",
    "space-banner-surface",
    "space-identity-header",
    `banner-${identity.bannerName}`,
    identity.bannerImage ? "has-banner-image" : "",
    switcherEnabled ? "has-switcher" : "",
    switcherOpen ? "switcher-open" : "",
    action ? "has-action" : "",
    ancestors.length ? "has-breadcrumb" : "",
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
    <span className="space-pane-current-copy space-identity-header-copy">
      <span className="space-pane-current-lockup">
        <strong>{space.name}</strong>
      </span>
      <span className="sr-only">{detail}</span>
    </span>
  );

  return (
    <div
      className="space-pane-header-wrap space-identity-header-wrap"
      ref={headerRef}
      onBlurCapture={(event) => {
        if (switcherOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSwitcherOpen(false);
      }}
    >
      <div
        className={headerClassName}
        style={spaceIdentityStyle(identity)}
        aria-label={switcherEnabled ? undefined : `Current work-folder: ${space.name}. ${detail}`}
        onContextMenu={(event) => {
          if (!onNewChat && !onOpenAppearance && !onRevealFolder) return;
          event.preventDefault();
          setSwitcherOpen(false);
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {identity.bannerImage ? (
          <span className={identity.bannerPreset ? "space-pane-banner-image has-banner-preset" : "space-pane-banner-image"} aria-hidden="true">
            <img src={identity.bannerImage} alt="" draggable={false} style={spaceBannerImageStyle(identity.bannerFraming)} />
            <span className="space-pane-banner-scrim" />
          </span>
        ) : null}
        {switcherEnabled ? (
          <button
            ref={switchTriggerRef}
            className="space-pane-switch-trigger"
            type="button"
            aria-label={`Current work-folder: ${space.name}. ${detail}. Switch work-folder`}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-controls={switcherId}
            onClick={toggleSwitcher}
            title="Switch work-folder"
          >
            {identityLockup}
            {nestedStatus ? <span className="space-pane-nested-activity"><ActivityDot status={nestedStatus} /></span> : null}
            <ChevronDown20Regular className="space-pane-switch-caret" aria-hidden="true" />
          </button>
        ) : identityLockup}
        {ancestors.length ? (
          // The way back up lives with the Folder's name (2026-10-01): the
          // nearest two containing Folders are links, and anything further
          // out folds into "…", which opens the full tree in the switcher.
          <nav className="space-pane-breadcrumb" aria-label="Containing work-folders">
            {hiddenAncestors.length ? (
              <>
                <button
                  ref={breadcrumbMoreRef}
                  className="space-pane-breadcrumb-more"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={breadcrumbMenuOpen}
                  aria-label={`${hiddenAncestors.length} more containing ${hiddenAncestors.length === 1 ? "work-folder" : "work-folders"}`}
                  title={hiddenAncestors.map((item) => item.name).join(" › ")}
                  onClick={() => setBreadcrumbMenuOpen((current) => !current)}
                >
                  …
                </button>
                <ChevronRight20Regular className="space-pane-breadcrumb-separator" aria-hidden="true" />
              </>
            ) : null}
            {ancestors.slice(-2).map((item, index, list) => (
              <Fragment key={item.id}>
                {renderCrumb(item)}
                {index < list.length - 1 ? <ChevronRight20Regular className="space-pane-breadcrumb-separator" aria-hidden="true" /> : null}
              </Fragment>
            ))}
          </nav>
        ) : null}
        {action ? (
          <span className="space-pane-header-action professional-header-action space-pane-action-group">
            {action}
          </span>
        ) : null}
      </div>
      {breadcrumbMenuOpen && hiddenAncestors.length ? (
        // The Folders "…" stands for, outermost first, as the same pills.
        <div
          ref={breadcrumbMenuRef}
          className="space-pane-breadcrumb-menu"
          role="menu"
          aria-label="More containing work-folders"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = Array.from(breadcrumbMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            const next = nextMenuItemIndex(items.findIndex((item) => item === document.activeElement), items.length, event.key as MenuNavigationKey);
            if (next === null) return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          {hiddenAncestors.map((item, index) => (
            <div className="space-pane-breadcrumb-menu-row" key={item.id} style={{ "--folder-depth": index } as CSSProperties}>
              {renderCrumb(item, "menuitem")}
            </div>
          ))}
        </div>
      ) : null}
      {switcherEnabled && switcherOpen ? (
        <SpaceHeaderSwitcher
          id={switcherId}
          currentSpace={space}
          spaces={spaces}
          spaceCustomizations={spaceCustomizations}
          onSwitchSpace={onSwitchSpace}
          onCreateSpace={onCreateSpace}
          onOpenFolder={onOpenFolder}
          onManageSpaces={onManageSpaces}
          managingSpaces={managingSpaces}
          folderStatuses={folderStatuses}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}
      {contextMenu ? (
        <FolderContextMenu
          anchor={headerRef.current}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => { setContextMenu(null); switchTriggerRef.current?.focus(); }}
          onNewChat={onNewChat}
          onOpenAppearance={onOpenAppearance}
          onRevealFolder={onRevealFolder}
          onManageSpaces={onManageSpaces}
        />
      ) : null}
    </div>
  );
}

/** The Folder header's right-click menu: the things a person does with this Folder most. */
function FolderContextMenu({ anchor, x, y, onClose, onNewChat, onOpenAppearance, onRevealFolder, onManageSpaces }: {
  anchor: HTMLElement | null;
  x: number;
  y: number;
  onClose: () => void;
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
  onManageSpaces: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function closeOnOutside(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  const run = (action: () => void) => { onClose(); action(); };
  const style: CSSProperties = { left: Math.max(8, Math.min(x, window.innerWidth - 226)), top: Math.max(8, Math.min(y, window.innerHeight - 196)) };
  return createPortal(
    <Fragment>
      <div className="context-menu-backdrop folder-context-menu-backdrop" aria-hidden="true" onContextMenu={(event) => event.preventDefault()} />
      <div ref={menuRef} className="context-menu folder-context-menu" style={style} role="menu" aria-label="work-folder actions" onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKeyDown} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(); }}>
        {onNewChat ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onNewChat)}><ChatAdd16Regular aria-hidden="true" />New Chat</button> : null}
        {onOpenAppearance ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onOpenAppearance)}><PaintBrush16Regular aria-hidden="true" />Customize work-folder</button> : null}
        {onRevealFolder ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onRevealFolder)}><FolderOpen16Regular aria-hidden="true" />{revealInFileManagerLabel()}</button> : null}
        <div className="context-menu-separator" role="separator" />
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onManageSpaces)}><Folder16Regular aria-hidden="true" />Manage work-folders</button>
      </div>
    </Fragment>,
    anchor?.closest(".app-shell") ?? document.body,
  );
}

function SpaceHeaderSwitcher({
  id,
  currentSpace,
  spaces,
  spaceCustomizations,
  onSwitchSpace,
  onCreateSpace,
  onOpenFolder,
  onManageSpaces,
  managingSpaces,
  folderStatuses = {},
  onClose,
}: {
  id: string;
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  currentSpace: SpaceSummary;
  spaces: SpaceSummary[];
  spaceCustomizations: SpaceCustomizationMap;
  onSwitchSpace: (space: SpaceSummary) => void;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onManageSpaces: () => void;
  managingSpaces: boolean;
  onClose: () => void;
}) {
  const spaceIdentityFor = useSpaceIdentityResolver();
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Rows are in tree order now, so start on the current Folder, not the first row.
    const current = switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"][aria-current="page"]')
      ?? switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    current?.focus();
    current?.scrollIntoView({ block: "nearest" });
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
    <div className="space-header-switcher professional-space-switcher" id={id} role="menu" aria-label="work-folder menu" data-native-view-occluder="true" ref={switcherRef} onKeyDown={handleMenuKeyDown}>
      <div className="space-header-switcher-list">
        {/* Folders inside Folders read as a tree (2026-10-01): indentation
            says who owns what, so no row needs to explain it. */}
        {folderTreeRows(spaces.some((item) => item.id === currentSpace.id) ? spaces : [currentSpace, ...spaces]).map(({ space: item, depth }) => {
          const active = item.id === currentSpace.id;
          const itemIdentity = spaceIdentityFor(item, spaceCustomizations);
          const status = folderStatuses[item.id];
          return (
            <button
              className={["space-header-switcher-row", active ? "active" : "", depth ? "nested" : ""].filter(Boolean).join(" ")}
              type="button"
              role="menuitem"
              key={item.id}
              aria-current={active ? "page" : undefined}
              style={{ ...spaceIdentityStyle(itemIdentity), "--folder-depth": depth } as CSSProperties}
              onClick={() => {
                onClose();
                if (!active) onSwitchSpace(item);
              }}
            >
              <span className="space-header-switcher-icon" aria-hidden="true" data-space-icon={itemIdentity.iconName}><SpaceIconGlyph icon={itemIdentity.Icon} size={17} filled /></span>
              <span className="space-header-switcher-copy"><strong>{item.name}</strong></span>
              {status ? <ActivityDot status={status} /> : <span aria-hidden="true" />}
              <span className="space-header-switcher-badge">{spaceHeaderSourceBadgeLabel(item)}</span>
              {active ? <Checkmark16Regular className="space-header-switcher-check" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="space-header-switcher-actions" aria-label="work-folder actions">
        <button
          className="space-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onOpenFolder();
          }}
        >
          <FolderOpen20Regular aria-hidden="true" />
          <span>Use Existing Folder</span>
        </button>
        <button
          className="space-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCreateSpace();
          }}
        >
          <FolderAdd20Regular aria-hidden="true" />
          <span>Create new work-folder</span>
        </button>
        <button
          className={managingSpaces ? "space-header-switcher-action space-header-switcher-manage active" : "space-header-switcher-action space-header-switcher-manage"}
          type="button"
          role="menuitem"
          aria-current={managingSpaces ? "true" : undefined}
          onClick={() => {
            onClose();
            onManageSpaces();
          }}
        >
          <Apps24Regular aria-hidden="true" />
          <span>Manage work-folders</span>
        </button>
      </div>
    </div>
  );
}

function SpaceNameEditor({
  space,
  onRenameSpace,
}: {
  space: SpaceSummary;
  onRenameSpace: (space: SpaceSummary, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(space.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(space.name);
    setSaving(false);
    setError(null);
  }, [space.id, space.name]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a work-folder name.");
      return;
    }
    if (nextName === space.name) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameSpace(space, nextName);
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || saving || name === space.name) return;
    event.preventDefault();
    setName(space.name);
    setError(null);
  }

  return (
    <div className="space-name-editor">
      <form className="space-name-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>Folder name</span>
          <input
            value={name}
            maxLength={80}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={`Folder name for ${space.name}`}
          />
        </label>
        <button className="space-name-save" type="submit" disabled={saving || !name.trim() || name.trim() === space.name} aria-label={saving ? "Saving name" : undefined}>
          {saving ? <ArrowClockwise20Regular className="spin" aria-hidden="true" /> : "Save"}
        </button>
      </form>
      {error ? <span className="space-name-error" role="alert">{error}</span> : null}
    </div>
  );
}

export const spaceIconPageSize = 96;

function SpaceAppearancePanel({
  activeSection,
  space,
  identity,
  customization,
  canUndo,
  onCustomizeSpace,
  onReplaceSpace,
  onUndoSpace,
  onResetSpace,
}: {
  activeSection: "banner" | "icon" | "color";
  space: SpaceSummary;
  identity: SpaceIdentity;
  customization?: SpaceCustomization;
  canUndo: boolean;
  onCustomizeSpace: (spaceId: string, patch: SpaceCustomizationPatch) => void;
  onReplaceSpace: (spaceId: string, customization: SpaceCustomization) => void;
  onUndoSpace: (spaceId: string) => void;
  onResetSpace: (spaceId: string) => void;
}) {
  const [iconGroup, setIconGroup] = useState<SpaceIconGroupId>("popular");
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [iconPage, setIconPage] = useState(0);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const previousIconSpaceRef = useRef(space.id);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const spaceId = space.id;
  const matchingSpaceIconOptions = useMemo(() => filterSpaceIconOptions(iconSearchQuery, iconGroup), [iconSearchQuery, iconGroup]);
  const iconPageCount = Math.max(1, Math.ceil(matchingSpaceIconOptions.length / spaceIconPageSize));
  const visibleSpaceIconOptions = matchingSpaceIconOptions.slice(iconPage * spaceIconPageSize, (iconPage + 1) * spaceIconPageSize);
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    const changedSpace = previousIconSpaceRef.current !== spaceId;
    previousIconSpaceRef.current = spaceId;
    const options = changedSpace ? spaceIconOptions : matchingSpaceIconOptions;
    const selectedIconIndex = options.findIndex((option) => option.name === identity.iconName);
    setIconPage(selectedIconIndex < 0 ? 0 : Math.floor(selectedIconIndex / spaceIconPageSize));
    if (!changedSpace) return;
    setIconSearchQuery("");
    setBannerUploadBusy(false);
    setBannerUploadError(null);
    setProposalImportError(null);
  }, [spaceId, identity.iconName]);

  const appearancePasses = identity.resolved.passes;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processSpaceBannerImageFile(file);
      onCustomizeSpace(spaceId, { bannerImage, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined });
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
      name: `${space.name} appearance`,
      description: "A safe, code-free Space appearance preset.",
      target: { spaceId: space.id, spaceName: space.name },
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
    anchor.download = `${space.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space"}-appearance.space.json`;
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
      const normalized = normalizeSpaceCustomizations(
        { [spaceId]: proposal.customization },
        new Set([spaceId]),
        new Set(spaceIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])])),
      )[spaceId];
      if (!normalized) throw new Error("The proposal does not contain a supported appearance.");
      onReplaceSpace(spaceId, normalized);
    } catch (caught) {
      setProposalImportError(errorText(caught));
    }
  }

  return (
    <div className="space-appearance-inner">
      <div className="space-appearance-toolbar">
        <button type="button" disabled={!canUndo} onClick={() => onUndoSpace(spaceId)} title="Undo the last appearance change"><ArrowUndo20Regular />Undo</button>
        <div className="space-appearance-toolbar-actions">
          <button type="button" disabled={!customized} onClick={() => onResetSpace(spaceId)}><ArrowReset20Regular />Reset</button>
          <details className="space-appearance-more">
            <summary aria-label="More appearance options">More<ChevronDown20Regular /></summary>
            <div>
              <button type="button" onClick={() => proposalFileInputRef.current?.click()}><ArrowUpload20Regular />Import</button>
              <button type="button" onClick={exportAppearanceProposal}><ArrowDownload20Regular />Export</button>
            </div>
          </details>
        </div>
      </div>
      <input ref={proposalFileInputRef} className="space-banner-file-input" type="file" accept=".json,application/json" onChange={(event) => void importAppearanceProposal(event)} tabIndex={-1} aria-hidden="true" />
      {proposalImportError ? <div className="space-appearance-import-error" role="alert">{proposalImportError}</div> : null}
      <SpaceBannerPreview identity={identity} name={space.name} editable={activeSection === "banner"} onFrame={(bannerFraming) => onCustomizeSpace(spaceId, { bannerFraming })} />
      {!appearancePasses ? <div className="space-appearance-audit warning" role="status"><Warning20Regular aria-hidden="true" /><span>Choose a higher-contrast accent.</span></div> : null}
      <div className="space-appearance-tab-panel" key={activeSection} role="tabpanel" id={`folder-appearance-panel-${activeSection}`} aria-labelledby={`folder-appearance-tab-${activeSection}`}>
        {activeSection === "banner" ? <>
          <div className="space-banner-section-heading"><strong>Images</strong><button className="space-banner-upload-button" type="button" onClick={() => bannerFileInputRef.current?.click()} disabled={bannerUploadBusy}><ImageAdd20Regular />{bannerUploadBusy ? "Uploading…" : "Upload"}</button></div>
          <div className="space-banner-image-gallery" role="group" aria-label="Built-in banner images">
            {spaceBannerPresets.map((preset) => <button key={preset.id} type="button" className={identity.bannerPreset === preset.id ? "active" : ""} aria-pressed={identity.bannerPreset === preset.id} aria-label={`Use ${preset.label} image`} onClick={() => onCustomizeSpace(spaceId, { bannerPreset: preset.id, bannerImage: undefined, bannerFraming: undefined, bannerImagePosition: undefined })}>
              <span><img src={preset.thumbnail} alt="" draggable={false} />{identity.bannerPreset === preset.id ? <Checkmark20Regular /> : null}</span><strong>{preset.label}</strong>
            </button>)}
            {customization?.bannerImage ? <button type="button" className={!identity.bannerPreset ? "active" : ""} aria-label="Replace custom banner image" onClick={() => bannerFileInputRef.current?.click()}><span><img src={customization.bannerImage} alt="" /></span><strong>Your image</strong></button> : null}
          </div>
          <input ref={bannerFileInputRef} className="space-banner-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={(event) => void handleBannerFileChange(event)} tabIndex={-1} aria-hidden="true" />
          {bannerUploadError ? <span className="space-banner-upload-error" role="alert">{bannerUploadError}</span> : null}
          <div className="space-banner-section-heading"><strong>Patterns</strong></div>
          <div className="space-banner-gallery" role="group" aria-label="work-folder banner styles">
            {spaceBannerOptions.map((option) => <button key={option.name} className={["space-banner-swatch", "space-banner-surface", `banner-${option.name}`, !identity.bannerImage && identity.bannerName === option.name ? "active" : ""].filter(Boolean).join(" ")} type="button" onClick={() => onCustomizeSpace(spaceId, { bannerName: option.name, bannerImage: undefined, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined })} aria-label={`Use ${option.label} banner`} aria-pressed={!identity.bannerImage && identity.bannerName === option.name}><span className="space-banner-swatch-name">{option.label}</span></button>)}
          </div>
          {!identity.bannerImage && identity.bannerName !== "none" ? <div className="space-pattern-colors">
            <strong>Pattern colors</strong>
            <div className="space-color-wheels">
              <label className="space-color-picker" style={spaceIdentityStyle(identity)} title="Accent color">
                <span className="space-color-wheel" aria-hidden="true"><span className="space-color-wheel-current" /></span>
                <input type="color" value={identity.color} onInput={(event) => onCustomizeSpace(spaceId, { color: normalizeSpaceColor(event.currentTarget.value) })} aria-label="Choose pattern accent color" />
                <span className="space-color-value"><small>Accent</small>{identity.color.toUpperCase()}</span>
              </label>
              <label
                className={identity.hasCustomSecondary ? "space-color-picker secondary" : "space-color-picker secondary matched"}
                style={{ ...spaceIdentityStyle(identity), "--space-picker-color": identity.secondaryColor } as CSSProperties}
                title="Second banner color"
              >
                <span className="space-color-wheel" aria-hidden="true">
                  <span className="space-color-wheel-current" />
                </span>
                <input
                  type="color"
                  value={identity.secondaryColor}
                  onInput={(event) => onCustomizeSpace(spaceId, { color2: normalizeSpaceColor(event.currentTarget.value) })}
                  aria-label="Choose second banner color"
                />
                <span className="space-color-value"><small>Second color</small>{identity.hasCustomSecondary ? identity.secondaryColor.toUpperCase() : "Match accent"}</span>
              </label>
              {identity.hasCustomSecondary ? (
                <button
                  className="space-color-pair-clear"
                  type="button"
                  onClick={() => onCustomizeSpace(spaceId, { color2: undefined })}
                  aria-label="Remove second banner color"
                  title="Match primary color"
                >
                  <Dismiss20Regular />
                </button>
              ) : null}
            </div>
          </div> : null}
        </> : activeSection === "color" ? <>
      <div className="space-appearance-row colors">
        <div className="space-color-section-heading"><strong>Accent</strong>
          <div className="space-color-wheels">
            <span className="space-custom-color-label">Custom color</span>
            <label className="space-color-picker" style={spaceIdentityStyle(identity)}>
              <span className="space-color-wheel" aria-hidden="true">
                <span className="space-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeSpace(spaceId, { color: normalizeSpaceColor(event.currentTarget.value) })}
                aria-label="Choose work-folder color"
              />
              <span className="space-color-value">{identity.color.toUpperCase()}</span>
            </label>
          </div>
        </div>
        <div className="space-color-controls">
          <div className="space-color-swatches" role="group" aria-label="work-folder color presets">
            {spaceColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "space-color-swatch active" : "space-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft, "--swatch-ink": readableTextColorOn(option.color) } as CSSProperties}
                onClick={() => onCustomizeSpace(spaceId, { color: option.color })}
                aria-label={`Use ${option.label} color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                <span className="space-color-dot" aria-hidden="true">{identity.color === option.color ? <Checkmark20Regular /> : null}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
        </> : <>
        <div className="space-icon-picker">
          <label className="space-icon-search">
            <Search20Regular aria-hidden="true" />
            <input
              type="search"
              value={iconSearchQuery}
              onChange={(event) => {
                setIconSearchQuery(event.currentTarget.value);
                setIconPage(0);
                if (event.currentTarget.value) setIconGroup("all");
              }}
              placeholder="Search icons"
              aria-label="Search work-folder icons"
            />
          </label>
          <div className="space-icon-categories" role="group" aria-label="Icon categories">
            {spaceIconGroups.map((group) => <button key={group.id} type="button" aria-pressed={iconGroup === group.id} onClick={() => { setIconGroup(group.id); setIconSearchQuery(""); setIconPage(0); }}>{group.label}</button>)}
          </div>
          <div className="space-icon-browser">
            <div className="space-icon-grid" aria-label="Folder icon">
              {visibleSpaceIconOptions.map((option) => {
                const Icon = option.Icon;
                return (
                  <button
                    className={identity.iconName === option.name ? "space-icon-option active" : "space-icon-option"}
                    key={option.name}
                    type="button"
                    onClick={() => onCustomizeSpace(spaceId, { iconName: option.name })}
                    aria-label={`Use ${option.label} icon`}
                    aria-pressed={identity.iconName === option.name}
                    title={option.label}
                  >
                    <SpaceIconGlyph icon={Icon} size={24} filled={identity.iconName === option.name} />
                  </button>
                );
              })}
              {!visibleSpaceIconOptions.length ? <span className="space-icon-empty">No icons found</span> : null}
            </div>
          </div>
          {iconPageCount > 1 ? (
            <div className="space-icon-pages" aria-label="Icon pages">
              <button type="button" onClick={() => setIconPage((current) => Math.max(0, current - 1))} disabled={iconPage === 0} aria-label="Previous icon page"><ChevronLeft20Regular /></button>
              <span className="space-icon-pager-status">{iconPage + 1} / {iconPageCount}</span>
              <button type="button" onClick={() => setIconPage((current) => Math.min(iconPageCount - 1, current + 1))} disabled={iconPage >= iconPageCount - 1} aria-label="Next icon page"><ChevronRight20Regular /></button>
            </div>
          ) : null}
        </div>        </>}
      </div>
    </div>
  );
}

export { SpaceAppearancePanel, SpaceHeaderSwitcher, SpaceModeRail, SpaceNameEditor, SpacePaneHeader };
