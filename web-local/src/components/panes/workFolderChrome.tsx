import { useWorkFolderIdentityResolver } from "../../lib/work-folder-appearance-context";
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
  Search20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import {
  accentIdentityFromHex,
  createWorkFolderAppearanceProposal,
  parseWorkFolderAppearanceProposal,
  upgradeWorkFolderAppearanceCustomization,
} from "../../../../src/shared/work-folder-appearance";
import { filterWorkFolderIconOptions, workFolderIconOptionFor, workFolderIconOptions, workFolderIconGroups, type WorkFolderIconGroupId } from "../../work-folder-icons";
import { workFolderBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { revealInFileManagerLabel } from "../../lib/file-actions";
import { normalizeWorkFolderCustomizations } from "../../lib/work-folder-customization";
import { normalizeWorkFolderColor, processWorkFolderBannerImageFile, workFolderColorOptions, workFolderIdentityStyle, workFolderBannerImageStyle, type WorkFolderIdentity } from "../../lib/work-folder-identity";
import { WorkFolderBannerPreview } from "../chrome/WorkFolderBannerPreview";
import { workFolderBannerPresets } from "../../lib/work-folder-banner-presets";
import { readableTextColorOn } from "../../lib/color-contrast";
import { surfaceDomIdSuffix, workFolderHeaderSourceBadgeLabel } from "../../lib/work-folder-ui";
import type { SkillsExtensionsView, CapabilitySurface, ChatActivityStatus, RestrictedAppInstalled, WorkFolderCustomization, WorkFolderCustomizationMap, WorkFolderCustomizationPatch, WorkFolderRailMode, WorkFolderSummary } from "../../types";
import { WorkFolderIconGlyph } from "../chrome/common";
import { ActivityDot } from "../chrome/ActivityDot";
import { combineActivityStatuses, descendantFolders, folderAncestors, folderTreeRows } from "../../lib/folder-nesting";

function WorkFolderModeRail({
  activeMode,
  workFolder,
  surfaces,
  apps,
  onModeChange,
  onOpenSkillsExtensions,
  accountControl,
  updateControl,
  automations = null,
}: {
  activeMode: WorkFolderRailMode;
  workFolder: WorkFolderSummary;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  onModeChange: (mode: WorkFolderRailMode) => void;
  /**
   * A work-folder's own Automations entry (docs/automations.md, F15 as
   * amended 2026-09-24), present only while an automation touches this
   * work-folder. `active` follows the Automations tab, not the navigator mode.
   */
  automations?: { active: boolean } | null;
  /** The rail's Add button opens the Skills & Extensions popup (2026-09-25: no Add menu, no Library, no Apps tab). */
  onOpenSkillsExtensions: (view: SkillsExtensionsView) => void;
  accountControl: ReactNode;
  updateControl?: ReactNode;
}) {
  const FilesIcon = activeMode === "files" ? DocumentFolder24Filled : DocumentFolder24Regular;
  const ChatsIcon = activeMode === "chats" ? ChatMultiple24Filled : ChatMultiple24Regular;
  const HistoryIcon = activeMode === "history" ? History24Filled : History24Regular;
  const primaryItems: Array<{ mode: WorkFolderRailMode; label: string; ariaLabel: string; icon: ReactNode }> = [
    { mode: "files", label: "Files", ariaLabel: "Files", icon: <FilesIcon className="fluent-rail-icon" /> },
    { mode: "chats", label: "Chats", ariaLabel: "Chats", icon: <ChatsIcon className="fluent-rail-icon" /> },
    { mode: "history", label: "History", ariaLabel: "History", icon: <HistoryIcon className="fluent-rail-icon" /> },
  ];

  return (
    <nav className="work-folder-mode-rail professional-work-folder-rail" aria-label="work-fold navigation">
      <div className="work-folder-rail-nav">
        {primaryItems.map((item) => (
          <button
            className={[
              "work-folder-rail-button",
              activeMode === item.mode ? "active" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            key={item.mode}
            onClick={() => onModeChange(item.mode)}
            aria-label={item.ariaLabel}
            aria-current={activeMode === item.mode ? "page" : undefined}
          >
            <span className="work-folder-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="work-folder-rail-label">{item.label}</span>
          </button>
        ))}
        {automations ? (
          <button
            className={["work-folder-rail-button", automations.active ? "active" : ""].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onModeChange("automations")}
            aria-label="Automations"
            aria-current={automations.active ? "page" : undefined}
          >
            <span className="work-folder-rail-icon" aria-hidden="true">
              {automations.active ? <Flash24Filled className="fluent-rail-icon" /> : <Flash24Regular className="fluent-rail-icon" />}
            </span>
            <span className="work-folder-rail-label">Automations</span>
          </button>
        ) : null}
        {surfaces.length || apps.length ? <span className="work-folder-rail-app-divider" aria-hidden="true" /> : null}
        {surfaces.map((surface) => {
          const mode = `app:${surface.key}` as const;
          const SurfaceIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = surface.icon ? workFolderIconOptionFor(surface.icon) : null;
          return (
            <button
              className={["work-folder-rail-button", "work-folder-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={surface.key}
              onClick={() => onModeChange(mode)}
              aria-label={surface.title}
              aria-current={activeMode === mode ? "page" : undefined}
            >
              <span className="work-folder-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <WorkFolderIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <SurfaceIcon className="fluent-rail-icon" />}
              </span>
              <span className="work-folder-rail-label">{surface.title}</span>
            </button>
          );
        })}
        {apps.map((app) => {
          const mode = restrictedAppRailMode(workFolder.id, app.manifest.id, app.featureInstallationId);
          const label = restrictedAppRailLabel(app, apps);
          const AppIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = app.manifest.ui.icon ? workFolderIconOptionFor(app.manifest.ui.icon) : null;
          return (
            <button
              className={["work-folder-rail-button", "work-folder-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={app.featureInstallationId}
              onClick={() => onModeChange(mode)}
              aria-label={label}
              aria-current={activeMode === mode ? "page" : undefined}
            >
              <span className="work-folder-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <WorkFolderIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <AppIcon className="fluent-rail-icon" />}
              </span>
              <span className="work-folder-rail-label">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="work-folder-rail-account">
        <div className="work-folder-rail-tools">
          {updateControl ? <div className="work-folder-rail-update">{updateControl}</div> : null}
          <button
            className="work-folder-rail-quiet-button work-folder-rail-add-button"
            type="button"
            onClick={() => onOpenSkillsExtensions("installed")}
            aria-label="Skills & Extensions"
          >
            <Blocks size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>
        <div className="work-folder-rail-settings-control">
          {accountControl}
        </div>
      </div>
    </nav>
  );
}

function WorkFolderPaneHeader({
  workFolder,
  identity,
  workFolders,
  workFolderCustomizations,
  onSwitchWorkFolder,
  onCreateWorkFolder,
  onOpenFolder,
  onManageWorkFolders,
  managingWorkFolders = false,
  switchable = true,
  action,
  onNewChat,
  onOpenAppearance,
  onRevealFolder,
  folderStatuses = {},
}: {
  workFolder: WorkFolderSummary;
  identity: WorkFolderIdentity;
  workFolders: WorkFolderSummary[];
  workFolderCustomizations: WorkFolderCustomizationMap;
  /** One activity status per work-folder id (2026-10-01): dots in the switcher and on the header. */
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  onSwitchWorkFolder: (workFolder: WorkFolderSummary) => void;
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onManageWorkFolders: () => void;
  managingWorkFolders?: boolean;
  switchable?: boolean;
  action?: ReactNode;
  /** Right-click actions on the work-folder header (2026-09-25). */
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherEnabled = switchable && Boolean(workFolderCustomizations && onSwitchWorkFolder);
  const switcherId = `work-folder-header-switcher-${surfaceDomIdSuffix(workFolder.id)}`;
  const detail = workFolderHeaderSourceBadgeLabel(workFolder);
  const ancestors = useMemo(() => folderAncestors(workFolder, workFolders), [workFolder, workFolders]);
  const breadcrumbIdentityFor = useWorkFolderIdentityResolver();
  const hiddenAncestors = ancestors.length > 2 ? ancestors.slice(0, -2) : [];
  const [breadcrumbMenuOpen, setBreadcrumbMenuOpen] = useState(false);
  const breadcrumbMoreRef = useRef<HTMLButtonElement>(null);
  const breadcrumbMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setBreadcrumbMenuOpen(false); }, [workFolder.id]);
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

  function renderCrumb(item: WorkFolderSummary, role?: "menuitem") {
    // Each containing work-folder is a small pill in its own icon and color.
    const crumbIdentity = breadcrumbIdentityFor(item, workFolderCustomizations);
    return (
      <button
        className="work-folder-pane-breadcrumb-link"
        type="button"
        role={role}
        tabIndex={role ? -1 : undefined}
        title={`Back to ${item.name}`}
        style={workFolderIdentityStyle(crumbIdentity)}
        onClick={() => { setBreadcrumbMenuOpen(false); onSwitchWorkFolder(item); }}
      >
        <span className="work-folder-pane-breadcrumb-icon" aria-hidden="true"><WorkFolderIconGlyph icon={crumbIdentity.Icon} size={11} filled /></span>
        <span className="work-folder-pane-breadcrumb-name">{item.name}</span>
      </button>
    );
  }
  // The header's dot speaks for the work-folders inside this one: a parent shows
  // at a glance when one of its Workers is busy or has a reply waiting.
  const nestedStatus = useMemo(
    () => combineActivityStatuses(descendantFolders(workFolder, workFolders).map((item) => folderStatuses[item.id])),
    [folderStatuses, workFolder, workFolders],
  );
  const headerClassName = [
    "work-folder-pane-current",
    "work-folder-pane-header",
    "professional-pane-header",
    "work-folder-banner-surface",
    "work-folder-identity-header",
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
    <span className="work-folder-pane-current-copy work-folder-identity-header-copy">
      <span className="work-folder-pane-current-lockup">
        <strong>{workFolder.name}</strong>
      </span>
      <span className="sr-only">{detail}</span>
    </span>
  );

  return (
    <div
      className="work-folder-pane-header-wrap work-folder-identity-header-wrap"
      ref={headerRef}
      onBlurCapture={(event) => {
        if (switcherOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSwitcherOpen(false);
      }}
    >
      <div
        className={headerClassName}
        style={workFolderIdentityStyle(identity)}
        aria-label={switcherEnabled ? undefined : `Current work-folder: ${workFolder.name}. ${detail}`}
        onContextMenu={(event) => {
          if (!onNewChat && !onOpenAppearance && !onRevealFolder) return;
          event.preventDefault();
          setSwitcherOpen(false);
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {identity.bannerImage ? (
          <span className={identity.bannerPreset ? "work-folder-pane-banner-image has-banner-preset" : "work-folder-pane-banner-image"} aria-hidden="true">
            <img src={identity.bannerImage} alt="" draggable={false} style={workFolderBannerImageStyle(identity.bannerFraming)} />
            <span className="work-folder-pane-banner-scrim" />
          </span>
        ) : null}
        {switcherEnabled ? (
          <button
            ref={switchTriggerRef}
            className="work-folder-pane-switch-trigger"
            type="button"
            aria-label={`Current work-folder: ${workFolder.name}. ${detail}. Switch work-folder`}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-controls={switcherId}
            onClick={toggleSwitcher}
            title="Switch work-folder"
          >
            {identityLockup}
            {nestedStatus ? <span className="work-folder-pane-nested-activity"><ActivityDot status={nestedStatus} /></span> : null}
            <ChevronDown20Regular className="work-folder-pane-switch-caret" aria-hidden="true" />
          </button>
        ) : identityLockup}
        {ancestors.length ? (
          // The way back up lives with the work-folder's name (2026-10-01): the
          // nearest two containing work-folders are links, and anything further
          // out folds into "…", which opens the full tree in the switcher.
          <nav className="work-folder-pane-breadcrumb" aria-label="Containing work-folders">
            {hiddenAncestors.length ? (
              <>
                <button
                  ref={breadcrumbMoreRef}
                  className="work-folder-pane-breadcrumb-more"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={breadcrumbMenuOpen}
                  aria-label={`${hiddenAncestors.length} more containing ${hiddenAncestors.length === 1 ? "work-folder" : "work-folders"}`}
                  title={hiddenAncestors.map((item) => item.name).join(" › ")}
                  onClick={() => setBreadcrumbMenuOpen((current) => !current)}
                >
                  …
                </button>
                <ChevronRight20Regular className="work-folder-pane-breadcrumb-separator" aria-hidden="true" />
              </>
            ) : null}
            {ancestors.slice(-2).map((item, index, list) => (
              <Fragment key={item.id}>
                {renderCrumb(item)}
                {index < list.length - 1 ? <ChevronRight20Regular className="work-folder-pane-breadcrumb-separator" aria-hidden="true" /> : null}
              </Fragment>
            ))}
          </nav>
        ) : null}
        {action ? (
          <span className="work-folder-pane-header-action professional-header-action work-folder-pane-action-group">
            {action}
          </span>
        ) : null}
      </div>
      {breadcrumbMenuOpen && hiddenAncestors.length ? (
        // The work-folders "…" stands for, outermost first, as the same pills.
        <div
          ref={breadcrumbMenuRef}
          className="work-folder-pane-breadcrumb-menu"
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
            <div className="work-folder-pane-breadcrumb-menu-row" key={item.id} style={{ "--folder-depth": index } as CSSProperties}>
              {renderCrumb(item, "menuitem")}
            </div>
          ))}
        </div>
      ) : null}
      {switcherEnabled && switcherOpen ? (
        <WorkFolderHeaderSwitcher
          id={switcherId}
          currentWorkFolder={workFolder}
          workFolders={workFolders}
          workFolderCustomizations={workFolderCustomizations}
          onSwitchWorkFolder={onSwitchWorkFolder}
          onCreateWorkFolder={onCreateWorkFolder}
          onOpenFolder={onOpenFolder}
          onManageWorkFolders={onManageWorkFolders}
          managingWorkFolders={managingWorkFolders}
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
          onManageWorkFolders={onManageWorkFolders}
        />
      ) : null}
    </div>
  );
}

/** The work-folder header's right-click menu: the things a person does with this work-folder most. */
function FolderContextMenu({ anchor, x, y, onClose, onNewChat, onOpenAppearance, onRevealFolder, onManageWorkFolders }: {
  anchor: HTMLElement | null;
  x: number;
  y: number;
  onClose: () => void;
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
  onManageWorkFolders: () => void;
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
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onManageWorkFolders)}><Folder16Regular aria-hidden="true" />Manage work-folders</button>
      </div>
    </Fragment>,
    anchor?.closest(".app-shell") ?? document.body,
  );
}

function WorkFolderHeaderSwitcher({
  id,
  currentWorkFolder,
  workFolders,
  workFolderCustomizations,
  onSwitchWorkFolder,
  onCreateWorkFolder,
  onOpenFolder,
  onManageWorkFolders,
  managingWorkFolders,
  folderStatuses = {},
  onClose,
}: {
  id: string;
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  currentWorkFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  workFolderCustomizations: WorkFolderCustomizationMap;
  onSwitchWorkFolder: (workFolder: WorkFolderSummary) => void;
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onManageWorkFolders: () => void;
  managingWorkFolders: boolean;
  onClose: () => void;
}) {
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Rows are in tree order now, so start on the current work-folder, not the first row.
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
    <div className="work-folder-header-switcher professional-work-folder-switcher" id={id} role="menu" aria-label="work-folder menu" data-native-view-occluder="true" ref={switcherRef} onKeyDown={handleMenuKeyDown}>
      <div className="work-folder-header-switcher-list">
        {/* work-folders inside work-folders read as a tree (2026-10-01): indentation
            says who owns what, so no row needs to explain it. */}
        {folderTreeRows(workFolders.some((item) => item.id === currentWorkFolder.id) ? workFolders : [currentWorkFolder, ...workFolders]).map(({ workFolder: item, depth }) => {
          const active = item.id === currentWorkFolder.id;
          const itemIdentity = workFolderIdentityFor(item, workFolderCustomizations);
          const status = folderStatuses[item.id];
          return (
            <button
              className={["work-folder-header-switcher-row", active ? "active" : "", depth ? "nested" : ""].filter(Boolean).join(" ")}
              type="button"
              role="menuitem"
              key={item.id}
              aria-current={active ? "page" : undefined}
              style={{ ...workFolderIdentityStyle(itemIdentity), "--folder-depth": depth } as CSSProperties}
              onClick={() => {
                onClose();
                if (!active) onSwitchWorkFolder(item);
              }}
            >
              <span className="work-folder-header-switcher-icon" aria-hidden="true" data-work-folder-icon={itemIdentity.iconName}><WorkFolderIconGlyph icon={itemIdentity.Icon} size={17} filled /></span>
              <span className="work-folder-header-switcher-copy"><strong>{item.name}</strong></span>
              {status ? <ActivityDot status={status} /> : <span aria-hidden="true" />}
              <span className="work-folder-header-switcher-badge">{workFolderHeaderSourceBadgeLabel(item)}</span>
              {active ? <Checkmark16Regular className="work-folder-header-switcher-check" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="work-folder-header-switcher-actions" aria-label="work-folder actions">
        <button
          className="work-folder-header-switcher-action"
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
          className="work-folder-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCreateWorkFolder();
          }}
        >
          <FolderAdd20Regular aria-hidden="true" />
          <span>Create new work-folder</span>
        </button>
        <button
          className={managingWorkFolders ? "work-folder-header-switcher-action work-folder-header-switcher-manage active" : "work-folder-header-switcher-action work-folder-header-switcher-manage"}
          type="button"
          role="menuitem"
          aria-current={managingWorkFolders ? "true" : undefined}
          onClick={() => {
            onClose();
            onManageWorkFolders();
          }}
        >
          <Apps24Regular aria-hidden="true" />
          <span>Manage work-folders</span>
        </button>
      </div>
    </div>
  );
}

function WorkFolderNameEditor({
  workFolder,
  onRenameWorkFolder,
}: {
  workFolder: WorkFolderSummary;
  onRenameWorkFolder: (workFolder: WorkFolderSummary, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(workFolder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(workFolder.name);
    setSaving(false);
    setError(null);
  }, [workFolder.id, workFolder.name]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a work-folder name.");
      return;
    }
    if (nextName === workFolder.name) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameWorkFolder(workFolder, nextName);
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || saving || name === workFolder.name) return;
    event.preventDefault();
    setName(workFolder.name);
    setError(null);
  }

  return (
    <div className="work-folder-name-editor">
      <form className="work-folder-name-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>work-folder name</span>
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
            aria-label={`work-folder name for ${workFolder.name}`}
          />
        </label>
        <button className="work-folder-name-save" type="submit" disabled={saving || !name.trim() || name.trim() === workFolder.name} aria-label={saving ? "Saving name" : undefined}>
          {saving ? <ArrowClockwise20Regular className="spin" aria-hidden="true" /> : "Save"}
        </button>
      </form>
      {error ? <span className="work-folder-name-error" role="alert">{error}</span> : null}
    </div>
  );
}

export const workFolderIconPageSize = 96;

function WorkFolderAppearancePanel({
  activeSection,
  workFolder,
  identity,
  customization,
  canUndo,
  onCustomizeWorkFolder,
  onReplaceWorkFolder,
  onUndoWorkFolder,
  onResetWorkFolder,
}: {
  activeSection: "banner" | "icon" | "color";
  workFolder: WorkFolderSummary;
  identity: WorkFolderIdentity;
  customization?: WorkFolderCustomization;
  canUndo: boolean;
  onCustomizeWorkFolder: (workFolderId: string, patch: WorkFolderCustomizationPatch) => void;
  onReplaceWorkFolder: (workFolderId: string, customization: WorkFolderCustomization) => void;
  onUndoWorkFolder: (workFolderId: string) => void;
  onResetWorkFolder: (workFolderId: string) => void;
}) {
  const [iconGroup, setIconGroup] = useState<WorkFolderIconGroupId>("popular");
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [iconPage, setIconPage] = useState(0);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const previousIconWorkFolderRef = useRef(workFolder.id);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const workFolderId = workFolder.id;
  const matchingWorkFolderIconOptions = useMemo(() => filterWorkFolderIconOptions(iconSearchQuery, iconGroup), [iconSearchQuery, iconGroup]);
  const iconPageCount = Math.max(1, Math.ceil(matchingWorkFolderIconOptions.length / workFolderIconPageSize));
  const visibleWorkFolderIconOptions = matchingWorkFolderIconOptions.slice(iconPage * workFolderIconPageSize, (iconPage + 1) * workFolderIconPageSize);
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    const changedWorkFolder = previousIconWorkFolderRef.current !== workFolderId;
    previousIconWorkFolderRef.current = workFolderId;
    const options = changedWorkFolder ? workFolderIconOptions : matchingWorkFolderIconOptions;
    const selectedIconIndex = options.findIndex((option) => option.name === identity.iconName);
    setIconPage(selectedIconIndex < 0 ? 0 : Math.floor(selectedIconIndex / workFolderIconPageSize));
    if (!changedWorkFolder) return;
    setIconSearchQuery("");
    setBannerUploadBusy(false);
    setBannerUploadError(null);
    setProposalImportError(null);
  }, [workFolderId, identity.iconName]);

  const appearancePasses = identity.resolved.passes;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processWorkFolderBannerImageFile(file);
      onCustomizeWorkFolder(workFolderId, { bannerImage, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined });
    } catch (uploadError) {
      setBannerUploadError(errorText(uploadError));
    } finally {
      setBannerUploadBusy(false);
    }
  }

  function exportAppearanceProposal() {
    setProposalImportError(null);
    const upgraded = upgradeWorkFolderAppearanceCustomization(customization ?? {});
    const proposal = createWorkFolderAppearanceProposal({
      name: `${workFolder.name} appearance`,
      description: "A safe, code-free work-folder appearance preset.",
      target: { workFolderId: workFolder.id, workFolderName: workFolder.name },
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
    anchor.download = `${workFolder.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work-folder"}-appearance.work-folder.json`;
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
      const proposal = parseWorkFolderAppearanceProposal(JSON.parse(await file.text()));
      const normalized = normalizeWorkFolderCustomizations(
        { [workFolderId]: proposal.customization },
        new Set([workFolderId]),
        new Set(workFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])])),
      )[workFolderId];
      if (!normalized) throw new Error("The proposal does not contain a supported appearance.");
      onReplaceWorkFolder(workFolderId, normalized);
    } catch (caught) {
      setProposalImportError(errorText(caught));
    }
  }

  return (
    <div className="work-folder-appearance-inner">
      <div className="work-folder-appearance-toolbar">
        <button type="button" disabled={!canUndo} onClick={() => onUndoWorkFolder(workFolderId)} title="Undo the last appearance change"><ArrowUndo20Regular />Undo</button>
        <div className="work-folder-appearance-toolbar-actions">
          <button type="button" disabled={!customized} onClick={() => onResetWorkFolder(workFolderId)}><ArrowReset20Regular />Reset</button>
          <details className="work-folder-appearance-more">
            <summary aria-label="More appearance options">More<ChevronDown20Regular /></summary>
            <div>
              <button type="button" onClick={() => proposalFileInputRef.current?.click()}><ArrowUpload20Regular />Import</button>
              <button type="button" onClick={exportAppearanceProposal}><ArrowDownload20Regular />Export</button>
            </div>
          </details>
        </div>
      </div>
      <input ref={proposalFileInputRef} className="work-folder-banner-file-input" type="file" accept=".json,application/json" onChange={(event) => void importAppearanceProposal(event)} tabIndex={-1} aria-hidden="true" />
      {proposalImportError ? <div className="work-folder-appearance-import-error" role="alert">{proposalImportError}</div> : null}
      <WorkFolderBannerPreview identity={identity} name={workFolder.name} editable={activeSection === "banner"} onFrame={(bannerFraming) => onCustomizeWorkFolder(workFolderId, { bannerFraming })} />
      {!appearancePasses ? <div className="work-folder-appearance-audit warning" role="status"><Warning20Regular aria-hidden="true" /><span>Choose a higher-contrast accent.</span></div> : null}
      <div className="work-folder-appearance-tab-panel" key={activeSection} role="tabpanel" id={`folder-appearance-panel-${activeSection}`} aria-labelledby={`folder-appearance-tab-${activeSection}`}>
        {activeSection === "banner" ? <>
          <div className="work-folder-banner-section-heading"><strong>Images</strong><button className="work-folder-banner-upload-button" type="button" onClick={() => bannerFileInputRef.current?.click()} disabled={bannerUploadBusy}><ImageAdd20Regular />{bannerUploadBusy ? "Uploading…" : "Upload"}</button></div>
          <div className="work-folder-banner-image-gallery" role="group" aria-label="Built-in banner images">
            {workFolderBannerPresets.map((preset) => <button key={preset.id} type="button" className={identity.bannerPreset === preset.id ? "active" : ""} aria-pressed={identity.bannerPreset === preset.id} aria-label={`Use ${preset.label} image`} onClick={() => onCustomizeWorkFolder(workFolderId, { bannerPreset: preset.id, bannerImage: undefined, bannerFraming: undefined, bannerImagePosition: undefined })}>
              <span><img src={preset.thumbnail} alt="" draggable={false} />{identity.bannerPreset === preset.id ? <Checkmark20Regular /> : null}</span><strong>{preset.label}</strong>
            </button>)}
            {customization?.bannerImage ? <button type="button" className={!identity.bannerPreset ? "active" : ""} aria-label="Replace custom banner image" onClick={() => bannerFileInputRef.current?.click()}><span><img src={customization.bannerImage} alt="" /></span><strong>Your image</strong></button> : null}
          </div>
          <input ref={bannerFileInputRef} className="work-folder-banner-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={(event) => void handleBannerFileChange(event)} tabIndex={-1} aria-hidden="true" />
          {bannerUploadError ? <span className="work-folder-banner-upload-error" role="alert">{bannerUploadError}</span> : null}
          <div className="work-folder-banner-section-heading"><strong>Patterns</strong></div>
          <div className="work-folder-banner-gallery" role="group" aria-label="work-folder banner styles">
            {workFolderBannerOptions.map((option) => <button key={option.name} className={["work-folder-banner-swatch", "work-folder-banner-surface", `banner-${option.name}`, !identity.bannerImage && identity.bannerName === option.name ? "active" : ""].filter(Boolean).join(" ")} type="button" onClick={() => onCustomizeWorkFolder(workFolderId, { bannerName: option.name, bannerImage: undefined, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined })} aria-label={`Use ${option.label} banner`} aria-pressed={!identity.bannerImage && identity.bannerName === option.name}><span className="work-folder-banner-swatch-name">{option.label}</span></button>)}
          </div>
          {!identity.bannerImage && identity.bannerName !== "none" ? <div className="work-folder-pattern-colors">
            <strong>Pattern colors</strong>
            <div className="work-folder-color-wheels">
              <label className="work-folder-color-picker" style={workFolderIdentityStyle(identity)} title="Accent color">
                <span className="work-folder-color-wheel" aria-hidden="true"><span className="work-folder-color-wheel-current" /></span>
                <input type="color" value={identity.color} onInput={(event) => onCustomizeWorkFolder(workFolderId, { color: normalizeWorkFolderColor(event.currentTarget.value) })} aria-label="Choose pattern accent color" />
                <span className="work-folder-color-value"><small>Accent</small>{identity.color.toUpperCase()}</span>
              </label>
              <label
                className={identity.hasCustomSecondary ? "work-folder-color-picker secondary" : "work-folder-color-picker secondary matched"}
                style={{ ...workFolderIdentityStyle(identity), "--work-folder-picker-color": identity.secondaryColor } as CSSProperties}
                title="Second banner color"
              >
                <span className="work-folder-color-wheel" aria-hidden="true">
                  <span className="work-folder-color-wheel-current" />
                </span>
                <input
                  type="color"
                  value={identity.secondaryColor}
                  onInput={(event) => onCustomizeWorkFolder(workFolderId, { color2: normalizeWorkFolderColor(event.currentTarget.value) })}
                  aria-label="Choose second banner color"
                />
                <span className="work-folder-color-value"><small>Second color</small>{identity.hasCustomSecondary ? identity.secondaryColor.toUpperCase() : "Match accent"}</span>
              </label>
              {identity.hasCustomSecondary ? (
                <button
                  className="work-folder-color-pair-clear"
                  type="button"
                  onClick={() => onCustomizeWorkFolder(workFolderId, { color2: undefined })}
                  aria-label="Remove second banner color"
                  title="Match primary color"
                >
                  <Dismiss20Regular />
                </button>
              ) : null}
            </div>
          </div> : null}
        </> : activeSection === "color" ? <>
      <div className="work-folder-appearance-row colors">
        <div className="work-folder-color-section-heading"><strong>Accent</strong>
          <div className="work-folder-color-wheels">
            <span className="work-folder-custom-color-label">Custom color</span>
            <label className="work-folder-color-picker" style={workFolderIdentityStyle(identity)}>
              <span className="work-folder-color-wheel" aria-hidden="true">
                <span className="work-folder-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeWorkFolder(workFolderId, { color: normalizeWorkFolderColor(event.currentTarget.value) })}
                aria-label="Choose work-folder color"
              />
              <span className="work-folder-color-value">{identity.color.toUpperCase()}</span>
            </label>
          </div>
        </div>
        <div className="work-folder-color-controls">
          <div className="work-folder-color-swatches" role="group" aria-label="work-folder color presets">
            {workFolderColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "work-folder-color-swatch active" : "work-folder-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft, "--swatch-ink": readableTextColorOn(option.color) } as CSSProperties}
                onClick={() => onCustomizeWorkFolder(workFolderId, { color: option.color })}
                aria-label={`Use ${option.label} color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                <span className="work-folder-color-dot" aria-hidden="true">{identity.color === option.color ? <Checkmark20Regular /> : null}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
        </> : <>
        <div className="work-folder-icon-picker">
          <label className="work-folder-icon-search">
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
          <div className="work-folder-icon-categories" role="group" aria-label="Icon categories">
            {workFolderIconGroups.map((group) => <button key={group.id} type="button" aria-pressed={iconGroup === group.id} onClick={() => { setIconGroup(group.id); setIconSearchQuery(""); setIconPage(0); }}>{group.label}</button>)}
          </div>
          <div className="work-folder-icon-browser">
            <div className="work-folder-icon-grid" aria-label="work-folder icon">
              {visibleWorkFolderIconOptions.map((option) => {
                const Icon = option.Icon;
                return (
                  <button
                    className={identity.iconName === option.name ? "work-folder-icon-option active" : "work-folder-icon-option"}
                    key={option.name}
                    type="button"
                    onClick={() => onCustomizeWorkFolder(workFolderId, { iconName: option.name })}
                    aria-label={`Use ${option.label} icon`}
                    aria-pressed={identity.iconName === option.name}
                    title={option.label}
                  >
                    <WorkFolderIconGlyph icon={Icon} size={24} filled={identity.iconName === option.name} />
                  </button>
                );
              })}
              {!visibleWorkFolderIconOptions.length ? <span className="work-folder-icon-empty">No icons found</span> : null}
            </div>
          </div>
          {iconPageCount > 1 ? (
            <div className="work-folder-icon-pages" aria-label="Icon pages">
              <button type="button" onClick={() => setIconPage((current) => Math.max(0, current - 1))} disabled={iconPage === 0} aria-label="Previous icon page"><ChevronLeft20Regular /></button>
              <span className="work-folder-icon-pager-status">{iconPage + 1} / {iconPageCount}</span>
              <button type="button" onClick={() => setIconPage((current) => Math.min(iconPageCount - 1, current + 1))} disabled={iconPage >= iconPageCount - 1} aria-label="Next icon page"><ChevronRight20Regular /></button>
            </div>
          ) : null}
        </div>        </>}
      </div>
    </div>
  );
}

export { WorkFolderAppearancePanel, WorkFolderHeaderSwitcher, WorkFolderModeRail, WorkFolderNameEditor, WorkFolderPaneHeader };
