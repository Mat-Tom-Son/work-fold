import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowClockwise20Regular,
  ArrowReset20Regular,
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
  History24Filled,
  History24Regular,
  ImageAdd20Regular,
  Keyboard24Regular,
  Library24Filled,
  Library24Regular,
  Search20Regular,
} from "@fluentui/react-icons";
import { filterWorkspaceIconOptions, workspaceIconOptionFor, workspaceIconOptions } from "../../workspace-icons";
import { workspaceBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { normalizeWorkspaceColor, processWorkspaceBannerImageFile, workspaceColorOptions, workspaceIdentityFor, workspaceIdentityStyle, type WorkspaceIdentity } from "../../lib/workspace-identity";
import { surfaceDomIdSuffix, workspaceHeaderSourceBadgeLabel } from "../../lib/workspace-ui";
import type { AssistantToolsView, CapabilitySurface, RestrictedAppInstalled, WorkspaceCustomization, WorkspaceCustomizationMap, WorkspaceCustomizationPatch, WorkspaceRailMode, WorkspaceSummary } from "../../types";
import { WorkspaceIconGlyph } from "../chrome/common";

function WorkspaceModeRail({
  activeMode,
  workspace,
  workspaceIdentity,
  surfaces,
  apps,
  onModeChange,
  onOpenAssistantTools,
  onBuildApp,
  accountControl,
  onOpenKeyboardShortcuts,
  updateControl,
}: {
  activeMode: WorkspaceRailMode;
  workspace: WorkspaceSummary;
  workspaceIdentity: WorkspaceIdentity;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  onModeChange: (mode: WorkspaceRailMode) => void;
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
  const FilesIcon = activeMode === "files" ? DocumentFolder24Filled : DocumentFolder24Regular;
  const ChatsIcon = activeMode === "chats" ? ChatMultiple24Filled : ChatMultiple24Regular;
  const LibraryIcon = activeMode === "library" ? Library24Filled : Library24Regular;
  const HistoryIcon = activeMode === "history" ? History24Filled : History24Regular;
  const workspaceLabel = workspace.name.trim() || "Space";
  const primaryItems: Array<{ mode: WorkspaceRailMode; label: string; ariaLabel: string; title: string; icon: ReactNode }> = [
    { mode: "files", label: "Files", ariaLabel: "Files", title: "Files in this Space", icon: <FilesIcon className="fluent-rail-icon" /> },
    { mode: "chats", label: "Chats", ariaLabel: "Chats", title: "Chats", icon: <ChatsIcon className="fluent-rail-icon" /> },
    { mode: "library", label: "Library", ariaLabel: "Library", title: "Reusable files for any Space", icon: <LibraryIcon className="fluent-rail-icon" /> },
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
    <nav className="workspace-mode-rail professional-workspace-rail" aria-label="Workspace navigation">
      <div className="workspace-rail-nav">
        <button
          className={["workspace-rail-button", "workspace-rail-workspace", "workspace-rail-space-selector", activeMode === "workspaces" ? "active" : ""].filter(Boolean).join(" ")}
          type="button"
          onClick={() => onModeChange("workspaces")}
          aria-label={`Select or manage Space: ${workspaceLabel}`}
          aria-current={activeMode === "workspaces" ? "page" : undefined}
          data-rail-tooltip={`Select or manage Space: ${workspaceLabel}`}
        >
          <span className="workspace-rail-icon workspace-rail-space-avatar" aria-hidden="true" data-space-icon={workspaceIdentity.iconName} style={workspaceIdentityStyle(workspaceIdentity)}><WorkspaceIconGlyph icon={workspaceIdentity.Icon} size={26} filled /></span>
          <span className="workspace-rail-space-copy"><strong>{workspaceLabel}</strong></span>
        </button>
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
              aria-label="Add to Workspace"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              aria-controls="workspace-add-menu"
              data-rail-tooltip="Add or manage"
            >
              <Add24Regular aria-hidden="true" />
              <span>Add</span>
            </button>
            {addOpen ? (
              <div ref={addMenuRef} id="workspace-add-menu" className="workspace-rail-add-menu" role="menu" aria-label={`Add to ${workspaceLabel}`} onKeyDown={handleAddMenuKeyDown}>
                <span className="workspace-rail-add-menu-heading">Add to {workspaceLabel}</span>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(() => onModeChange("library"))}><strong>Library materials</strong><span>Copy reusable files into this Space</span></button>
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

function WorkspacePaneHeader({
  workspace,
  identity,
  workspaces,
  workspaceCustomizations,
  onSwitchWorkspace,
  switchable = true,
  action,
}: {
  workspace: WorkspaceSummary;
  identity: WorkspaceIdentity;
  workspaces: WorkspaceSummary[];
  workspaceCustomizations: WorkspaceCustomizationMap;
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  switchable?: boolean;
  action?: ReactNode;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherEnabled = switchable && Boolean(workspaces.length > 1 && workspaceCustomizations && onSwitchWorkspace);
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
      {switcherEnabled && switcherOpen ? <WorkspaceHeaderSwitcher id={switcherId} currentWorkspace={workspace} workspaces={workspaces} workspaceCustomizations={workspaceCustomizations} onSwitchWorkspace={onSwitchWorkspace} onClose={() => setSwitcherOpen(false)} /> : null}
    </div>
  );
}

function WorkspaceHeaderSwitcher({
  id,
  currentWorkspace,
  workspaces,
  workspaceCustomizations,
  onSwitchWorkspace,
  onClose,
}: {
  id: string;
  currentWorkspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  workspaceCustomizations: WorkspaceCustomizationMap;
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  onClose: () => void;
}) {
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  return (
    <div className="workspace-header-switcher professional-space-switcher" id={id} role="menu" aria-label="Switch Space" ref={switcherRef}>
      <div className="workspace-header-switcher-list">
        {workspaces.map((item) => {
          const active = item.id === currentWorkspace.id;
          const itemIdentity = workspaceIdentityFor(item, workspaceCustomizations);
          return (
            <button
              className={active ? "workspace-header-switcher-row active" : "workspace-header-switcher-row"}
              type="button"
              role="menuitem"
              key={item.id}
              disabled={active}
              aria-current={active ? "page" : undefined}
              style={workspaceIdentityStyle(itemIdentity)}
              onClick={() => {
                onClose();
                onSwitchWorkspace(item);
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
  onCustomizeWorkspace,
  onResetWorkspace,
}: {
  workspace: WorkspaceSummary;
  identity: WorkspaceIdentity;
  customization?: WorkspaceCustomization;
  onCustomizeWorkspace: (workspaceId: string, patch: WorkspaceCustomizationPatch) => void;
  onResetWorkspace: (workspaceId: string) => void;
}) {
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [showAllIcons, setShowAllIcons] = useState(false);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const workspaceId = workspace.id;
  const filteredWorkspaceIconOptions = useMemo(() => {
    const matches = filterWorkspaceIconOptions(iconSearchQuery);
    if (iconSearchQuery.trim() || showAllIcons) return matches;
    return matches.filter((option) => recommendedWorkspaceIconNames.has(option.name));
  }, [iconSearchQuery, showAllIcons]);
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    setIconSearchQuery("");
    setShowAllIcons(false);
    setBannerUploadBusy(false);
    setBannerUploadError(null);
  }, [workspaceId]);

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

  return (
    <div className="workspace-appearance-inner">
      <div className="workspace-appearance-toolbar">
        <div>
          <strong>Space appearance</strong>
          <span>Saved on this computer and applied anywhere this Space appears.</span>
        </div>
        <button className="workspace-appearance-reset" type="button" disabled={!customized} onClick={() => onResetWorkspace(workspaceId)}>
          <ArrowReset20Regular />
          Reset
        </button>
      </div>
      <div className={["workspace-appearance-preview", "workspace-banner-surface", `banner-${identity.bannerName}`, identity.bannerImage ? "has-banner-image" : ""].filter(Boolean).join(" ")} style={workspaceIdentityStyle(identity)} aria-label="Live Space banner preview">
        {identity.bannerImage ? <span className="workspace-appearance-preview-image" aria-hidden="true"><img src={identity.bannerImage} alt="" draggable={false} style={{ objectPosition: `center ${identity.bannerImagePosition}` }} /><span /></span> : null}
        <span className="workspace-appearance-preview-copy"><strong>{workspace.name}</strong><small className="sr-only">{workspaceHeaderSourceBadgeLabel(workspace)}</small></span>
        <span className="workspace-appearance-preview-label">Live preview</span>
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
              style={{ ...workspaceIdentityStyle(identity), "--workspace-custom-color": identity.secondaryColor } as CSSProperties}
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
        <span className="workspace-appearance-label"><strong>Icon</strong><small>Shown in the Space selector and tabs.</small></span>
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
