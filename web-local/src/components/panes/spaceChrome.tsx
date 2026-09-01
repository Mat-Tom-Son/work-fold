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
  ChevronLeft20Regular,
  ChevronRight20Regular,
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
import { filterSpaceIconOptions, spaceIconOptionFor, spaceIconOptions } from "../../space-icons";
import { spaceBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { normalizeSpaceCustomizations } from "../../lib/space-customization";
import { normalizeSpaceColor, processSpaceBannerImageFile, spaceColorOptions, spaceIdentityFor, spaceIdentityStyle, type SpaceIdentity } from "../../lib/space-identity";
import { spaceLookOptions } from "../../lib/space-looks";
import { surfaceDomIdSuffix, spaceHeaderSourceBadgeLabel } from "../../lib/space-ui";
import type { AssistantToolsView, CapabilitySurface, RestrictedAppInstalled, SpaceCustomization, SpaceCustomizationMap, SpaceCustomizationPatch, SpaceRailMode, SpaceSummary } from "../../types";
import { SpaceIconGlyph } from "../chrome/common";

function SpaceModeRail({
  activeMode,
  space,
  surfaces,
  apps,
  onModeChange,
  onOpenLibrary,
  onOpenApps,
  onOpenAssistantTools,
  accountControl,
  onOpenKeyboardShortcuts,
  updateControl,
}: {
  activeMode: SpaceRailMode;
  space: SpaceSummary;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  onModeChange: (mode: SpaceRailMode) => void;
  onOpenLibrary: () => void;
  onOpenApps: () => void;
  onOpenAssistantTools: (view: AssistantToolsView) => void;
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
  const primaryItems: Array<{ mode: SpaceRailMode; label: string; ariaLabel: string; title: string; icon: ReactNode }> = [
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
    <nav ref={railRef} className="space-mode-rail professional-space-rail" aria-label="work-fold navigation">
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
            data-rail-tooltip={item.title}
          >
            <span className="space-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="space-rail-label">{item.label}</span>
          </button>
        ))}
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
              data-rail-tooltip={`${surface.title} · ${surface.scope === "project" ? "Pi Extension · This Space" : "Pi Extension · Everywhere"}`}
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
          const mode = `app:restricted:${space.id}:${app.manifest.id}` as const;
          const AppIcon = activeMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = app.manifest.ui.icon ? spaceIconOptionFor(app.manifest.ui.icon) : null;
          return (
            <button
              className={["space-rail-button", "space-rail-app", activeMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={`${app.manifest.id}:${app.digest}`}
              onClick={() => onModeChange(mode)}
              aria-label={app.manifest.title}
              aria-current={activeMode === mode ? "page" : undefined}
              data-rail-tooltip={`${app.manifest.title} · App · This Space`}
            >
              <span className="space-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <SpaceIconGlyph icon={contributedIcon.Icon} size={24} filled={activeMode === mode} className="fluent-rail-icon" />
                  : <AppIcon className="fluent-rail-icon" />}
              </span>
              <span className="space-rail-label">{app.manifest.title}</span>
            </button>
          );
        })}
      </div>
      <div className="space-rail-account">
        <div className="space-rail-tools">
          {updateControl ? <div className="space-rail-update">{updateControl}</div> : null}
          <div className="space-rail-add-anchor" ref={addAnchorRef} onBlurCapture={(event) => { if (addOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setAddOpen(false); }}>
            <button
              ref={addButtonRef}
              className="space-rail-quiet-button space-rail-add-button"
              type="button"
              onClick={() => setAddOpen((current) => !current)}
              aria-label="Add or manage"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              aria-controls="space-add-menu"
              data-rail-tooltip={addOpen ? undefined : "Add or manage"}
            >
              <Add24Regular aria-hidden="true" />
              <span>Add</span>
            </button>
            {addOpen ? (
              <div ref={addMenuRef} id="space-add-menu" className="space-rail-add-menu" role="menu" aria-label="Add or manage" onKeyDown={handleAddMenuKeyDown}>
                <span className="space-rail-add-menu-heading">Add or manage</span>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(onOpenLibrary)}><strong>Your Library</strong><span>Files you reuse across Spaces</span></button>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(() => onOpenAssistantTools("installed"))}><strong>Skills &amp; Extensions</strong><span>What the Assistant can use, here and everywhere</span></button>
                <button type="button" role="menuitem" onClick={() => chooseAddAction(onOpenApps)}><strong>Apps</strong><span>Visual tools built for this Space</span></button>
              </div>
            ) : null}
          </div>
          <button
            className="space-rail-quiet-button"
            type="button"
            onClick={onOpenKeyboardShortcuts}
            aria-label="Keyboard shortcuts"
            data-rail-tooltip="Keyboard shortcuts"
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

function useNativeRailTooltips(railRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const tooltip = window.workFoldDesktop?.window.railTooltip;
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
    ? target.closest<HTMLElement>(".professional-space-rail [data-rail-tooltip]")
    : null;
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
}: {
  space: SpaceSummary;
  identity: SpaceIdentity;
  spaces: SpaceSummary[];
  spaceCustomizations: SpaceCustomizationMap;
  onSwitchSpace: (space: SpaceSummary) => void;
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
  const switcherEnabled = switchable && Boolean(spaceCustomizations && onSwitchSpace);
  const switcherId = `space-header-switcher-${surfaceDomIdSuffix(space.id)}`;
  const detail = spaceHeaderSourceBadgeLabel(space);
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
        aria-label={switcherEnabled ? undefined : `Current Space: ${space.name}. ${detail}`}
      >
        {identity.bannerImage ? (
          <span className="space-pane-banner-image" aria-hidden="true">
            <img src={identity.bannerImage} alt="" draggable={false} style={{ objectPosition: `center ${identity.bannerImagePosition}` }} />
            <span className="space-pane-banner-scrim" />
          </span>
        ) : null}
        {switcherEnabled ? (
          <button
            ref={switchTriggerRef}
            className="space-pane-switch-trigger"
            type="button"
            aria-label={`Current Space: ${space.name}. ${detail}. Switch Space`}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-controls={switcherId}
            onClick={toggleSwitcher}
            title="Switch Space"
          >
            {identityLockup}
            <ChevronDown20Regular className="space-pane-switch-caret" aria-hidden="true" />
          </button>
        ) : identityLockup}
        {action ? (
          <span className="space-pane-header-action professional-header-action space-pane-action-group">
            {action}
          </span>
        ) : null}
      </div>
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
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}
    </div>
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
  onClose,
}: {
  id: string;
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
    <div className="space-header-switcher professional-space-switcher" id={id} role="menu" aria-label="Space menu" data-native-view-occluder="true" ref={switcherRef} onKeyDown={handleMenuKeyDown}>
      <div className="space-header-switcher-list">
        {[currentSpace, ...spaces
          .filter((item) => item.id !== currentSpace.id)
          .sort((left, right) => left.name.localeCompare(right.name))].map((item) => {
          const active = item.id === currentSpace.id;
          const itemIdentity = spaceIdentityFor(item, spaceCustomizations);
          return (
            <button
              className={active ? "space-header-switcher-row active" : "space-header-switcher-row"}
              type="button"
              role="menuitem"
              key={item.id}
              aria-current={active ? "page" : undefined}
              style={spaceIdentityStyle(itemIdentity)}
              onClick={() => {
                onClose();
                if (!active) onSwitchSpace(item);
              }}
            >
              <span className="space-header-switcher-icon" aria-hidden="true" data-space-icon={itemIdentity.iconName}><SpaceIconGlyph icon={itemIdentity.Icon} size={17} filled /></span>
              <span className="space-header-switcher-copy"><strong>{item.name}</strong></span>
              <span className="space-header-switcher-badge">{spaceHeaderSourceBadgeLabel(item)}</span>
              {active ? <Checkmark16Regular className="space-header-switcher-check" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="space-header-switcher-actions" aria-label="Space actions">
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
          <span>Use existing folder</span>
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
          <span>Create new Space</span>
        </button>
        <button
          className={managingSpaces ? "space-header-switcher-action space-header-switcher-manage active" : "space-header-switcher-action space-header-switcher-manage"}
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
      setError("Enter a Space name.");
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
          <span>Space name</span>
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
            aria-label={`Space name for ${space.name}`}
          />
        </label>
        <button className="space-name-save" type="submit" disabled={saving || !name.trim() || name.trim() === space.name}>
          {saving ? <ArrowClockwise20Regular className="spin" /> : "Save"}
        </button>
      </form>
      {error ? <span className="space-name-error" role="alert">{error}</span> : null}
    </div>
  );
}

export const spaceIconPageSize = 96;

function SpaceAppearancePanel({
  space,
  identity,
  customization,
  canUndo,
  onCustomizeSpace,
  onReplaceSpace,
  onUndoSpace,
  onResetSpace,
}: {
  space: SpaceSummary;
  identity: SpaceIdentity;
  customization?: SpaceCustomization;
  canUndo: boolean;
  onCustomizeSpace: (spaceId: string, patch: SpaceCustomizationPatch) => void;
  onReplaceSpace: (spaceId: string, customization: SpaceCustomization) => void;
  onUndoSpace: (spaceId: string) => void;
  onResetSpace: (spaceId: string) => void;
}) {
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [iconPage, setIconPage] = useState(0);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const previousIconSpaceRef = useRef(space.id);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const spaceId = space.id;
  const matchingSpaceIconOptions = useMemo(() => filterSpaceIconOptions(iconSearchQuery), [iconSearchQuery]);
  const iconPageCount = Math.max(1, Math.ceil(matchingSpaceIconOptions.length / spaceIconPageSize));
  const visibleSpaceIconOptions = matchingSpaceIconOptions.slice(iconPage * spaceIconPageSize, (iconPage + 1) * spaceIconPageSize);
  const looks = useMemo(() => spaceLookOptions.map((look) => ({
    ...look,
    identity: spaceIdentityFor(space, {
      [space.id]: { color: look.primary, color2: look.secondary, bannerName: look.bannerName },
    }),
  })), [space]);
  const activeLook = looks.find((look) => (
    !identity.bannerImage
    && identity.hasCustomSecondary
    && identity.color === look.primary
    && identity.secondaryColor === look.secondary
    && identity.bannerName === look.bannerName
  ));
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
  const uncertified = identity.resolved.uncertified.length > 0;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processSpaceBannerImageFile(file);
      onCustomizeSpace(spaceId, { bannerImage });
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
        <div>
          <strong>Space appearance</strong>
        </div>
        <div className="space-appearance-toolbar-actions">
          <button type="button" disabled={!canUndo} onClick={() => onUndoSpace(spaceId)} title="Undo the last appearance change">
            <ArrowUndo20Regular />
            Undo
          </button>
          <button type="button" onClick={() => proposalFileInputRef.current?.click()} title="Apply a work-fold appearance proposal">
            <ArrowUpload20Regular />
            Import
          </button>
          <button type="button" onClick={exportAppearanceProposal} title="Save a code-free appearance proposal">
            <ArrowDownload20Regular />
            Export
          </button>
          <button className="space-appearance-reset" type="button" disabled={!customized} onClick={() => onResetSpace(spaceId)}>
            <ArrowReset20Regular />
            Reset
          </button>
          <input
            ref={proposalFileInputRef}
            className="space-banner-file-input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => void importAppearanceProposal(event)}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
      </div>
      {proposalImportError ? <div className="space-appearance-import-error" role="alert"><Warning20Regular aria-hidden="true" /><span>{proposalImportError}</span></div> : null}
      <div className="space-appearance-previews" aria-label="Light and dark Space previews">
        {(["light", "dark"] as const).map((mode) => (
          <div
            className={["space-appearance-preview", "space-banner-surface", `preview-${mode}`, `banner-${identity.bannerName}`, identity.bannerImage ? "has-banner-image" : ""].filter(Boolean).join(" ")}
            style={{ ...spaceIdentityStyle(identity, mode), colorScheme: mode }}
            data-preview-mode={mode}
            key={mode}
          >
            {identity.bannerImage ? <span className="space-appearance-preview-image" aria-hidden="true"><img src={identity.bannerImage} alt="" draggable={false} style={{ objectPosition: `center ${identity.bannerImagePosition}` }} /><span /></span> : null}
            <span className="space-appearance-preview-copy"><strong>{space.name}</strong><small className="sr-only">{spaceHeaderSourceBadgeLabel(space)}</small></span>
            <span className="space-appearance-preview-label">{mode === "light" ? "Light" : "Dark"}</span>
          </div>
        ))}
      </div>
      <div className={appearancePasses ? "space-appearance-audit passes" : "space-appearance-audit warning"}>
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
      <div className="space-appearance-row looks">
        <span className="space-appearance-label">
          <strong>Looks</strong>
        </span>
        <div className="space-look-gallery" role="group" aria-label="Curated Space looks">
          {looks.map((look) => {
            const active = activeLook?.name === look.name;
            return (
              <button
                className={active ? "space-look-card active" : "space-look-card"}
                key={look.name}
                type="button"
                style={spaceIdentityStyle(look.identity)}
                onClick={() => onCustomizeSpace(spaceId, {
                  color: look.primary,
                  color2: look.secondary,
                  bannerName: look.bannerName,
                  bannerImage: undefined,
                })}
                aria-label={`Use ${look.name} look: ${look.hint}`}
                aria-pressed={active}
                title={`${look.name} · ${look.hint}`}
              >
                <span className={["space-look-swatch", "space-banner-surface", `banner-${look.bannerName}`].join(" ")} aria-hidden="true">
                  {active ? <Checkmark16Regular /> : null}
                </span>
                <span className="space-look-copy"><strong>{look.name}</strong><small>{look.hint}</small></span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-appearance-row colors">
        <span className="space-appearance-label"><strong>Accent</strong></span>
        <div className="space-color-controls">
          <div className="space-color-swatches" role="group" aria-label="Space color presets">
            {spaceColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "space-color-swatch active" : "space-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft } as CSSProperties}
                onClick={() => onCustomizeSpace(spaceId, { color: option.color })}
                aria-label={`Use ${option.label} color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                {identity.color === option.color ? <Checkmark20Regular /> : null}
              </button>
            ))}
          </div>
          <div className="space-color-wheels">
            <label className="space-color-picker" style={spaceIdentityStyle(identity)}>
              <span className="space-color-wheel" aria-hidden="true">
                <span className="space-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeSpace(spaceId, { color: normalizeSpaceColor(event.currentTarget.value) })}
                aria-label="Choose Space color"
              />
              <span className="space-color-value">{identity.color.toUpperCase()}</span>
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
              <span className="space-color-value">{identity.hasCustomSecondary ? identity.secondaryColor.toUpperCase() : "+ Pair"}</span>
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
        </div>
      </div>
      <div className="space-appearance-row banners">
        <span className="space-appearance-label"><strong>Banner</strong></span>
        <div className="space-banner-picker" style={spaceIdentityStyle(identity)}>
          <div className="space-banner-gallery" role="group" aria-label="Space banner styles">
            {spaceBannerOptions.map((option) => {
              const active = !identity.bannerImage && identity.bannerName === option.name;
              return (
                <button
                  className={[
                    "space-banner-swatch",
                    "space-banner-surface",
                    `banner-${option.name}`,
                    active ? "active" : "",
                  ].filter(Boolean).join(" ")}
                  key={option.name}
                  type="button"
                  onClick={() => onCustomizeSpace(spaceId, { bannerName: option.name, bannerImage: undefined })}
                  aria-label={`Use ${option.label} banner`}
                  aria-pressed={active}
                  title={option.label}
                >
                  <span className="space-banner-swatch-name">{option.label}</span>
                </button>
              );
            })}
            <button
              className={identity.bannerImage ? "space-banner-swatch upload has-image active" : "space-banner-swatch upload"}
              type="button"
              onClick={() => bannerFileInputRef.current?.click()}
              disabled={bannerUploadBusy}
              aria-label={identity.bannerImage ? "Replace custom banner image" : "Upload custom banner image"}
              aria-pressed={Boolean(identity.bannerImage)}
              title={identity.bannerImage ? "Replace image" : "Upload image"}
            >
              {identity.bannerImage ? <img src={identity.bannerImage} alt="" draggable={false} /> : null}
              <span className="space-banner-swatch-name">
                {bannerUploadBusy ? <ArrowClockwise20Regular className="spin" /> : <ImageAdd20Regular />}
                {identity.bannerImage ? "Replace" : "Upload"}
              </span>
            </button>
          </div>
          <input
            ref={bannerFileInputRef}
            className="space-banner-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            onChange={(event) => void handleBannerFileChange(event)}
            tabIndex={-1}
            aria-hidden="true"
          />
          {identity.bannerImage ? (
            <div className="space-banner-image-controls">
              <span>Image position</span>
              <div className="space-banner-position-control" role="radiogroup" aria-label="Banner image position">
                {(["top", "center", "bottom"] as const).map((position) => <button className={identity.bannerImagePosition === position ? "active" : ""} type="button" role="radio" aria-checked={identity.bannerImagePosition === position} key={position} onClick={() => onCustomizeSpace(spaceId, { bannerImagePosition: position })}>{position[0]!.toUpperCase() + position.slice(1)}</button>)}
              </div>
              <button
                className="space-banner-remove"
                type="button"
                onClick={() => {
                  setBannerUploadError(null);
                  onCustomizeSpace(spaceId, { bannerImage: undefined, bannerImagePosition: undefined });
                }}
                disabled={bannerUploadBusy}
              >
                <Dismiss20Regular />
                Remove image
              </button>
            </div>
          ) : null}
          {bannerUploadError ? <span className="space-banner-upload-error">{bannerUploadError}</span> : null}
        </div>
      </div>
      <div className="space-appearance-row icons">
        <span className="space-appearance-label"><strong>Icon</strong></span>
        <div className="space-icon-picker">
          <label className="space-icon-search">
            <Search20Regular aria-hidden="true" />
            <input
              type="search"
              value={iconSearchQuery}
              onChange={(event) => {
                setIconSearchQuery(event.currentTarget.value);
                setIconPage(0);
              }}
              placeholder="Search icons"
              aria-label="Search Space icons"
            />
          </label>
          <div className="space-icon-browser">
            <div className="space-icon-grid" aria-label="Space icon">
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
                    <SpaceIconGlyph icon={Icon} size={18} filled={identity.iconName === option.name} />
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
        </div>
      </div>
    </div>
  );
}

export { SpaceAppearancePanel, SpaceHeaderSwitcher, SpaceModeRail, SpaceNameEditor, SpacePaneHeader };
