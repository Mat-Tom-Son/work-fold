import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Add16Regular, ChevronDown16Regular, ChevronUp16Regular, FolderArrowRight16Regular, Sparkle16Regular, Grid20Regular, MoreHorizontal20Regular, PanelRight20Regular, TextBulletListLtr20Regular } from "@fluentui/react-icons";

import "./file-manager.css";
import "./file-manager-dialogs.css";
import { ChevronLeft, ChevronRight, Search, X } from "../chrome/icons";
import { FileContextMenu } from "../tree/FileContextMenu";
import { TextInputModal } from "../modals/TextInputModal";
import { NewFolderModal, type NewFolderTarget } from "../modals/NewFolderModal";
import { FileVersionHistoryModal } from "../modals/FileVersionHistoryModal";
import { SkillsExtensionsModal } from "../modals/SkillsExtensionsModal";
import { workFolderSetUpMessage, type WorkFolderSetUpMode } from "../../lib/work-folder-setup";
import { requestConnectAi } from "../../lib/connect-ai";
import { queueHistoryRequest } from "../../lib/history-queue";
import type { SettingsPage } from "../modals/DesktopSettingsModal";
import { api, apiForm, errorText } from "../../lib/api";
import { collectDroppedUploadFiles } from "../../lib/dropped-files";
import { copyToClipboard } from "../../lib/clipboard";
import { canOpenDirectly, nativeOpenLabel } from "../../lib/file-actions";
import { formatBytes, formatItemCount } from "../../lib/format";
import { untitledChatLabel } from "../../constants";
import { isMacOS, workFolderEntryNativePath } from "../../lib/platform";
import { deleteLocalFileRequest, deleteLocalFilesRequest, type PendingDelete } from "../../lib/pending-deletes";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import { combineActivityStatuses } from "../../lib/folder-nesting";
import { useWorkFolderCustomizations } from "../../hooks/useWorkFolderCustomizations";
import { WorkFolderAppearanceModal, type WorkFolderAppearanceSection } from "../modals/WorkFolderAppearanceModal";
import type { ModelScope } from "../panes/AiModelsPane";
import { appChangeDraft } from "../../lib/chat-context-request";
import { prepareRestrictedAppChange } from "../../lib/restricted-apps";
import { useWorkFolderIdentityResolver } from "../../lib/work-folder-appearance-context";
import { deleteFolderConfirm, deleteSelectionConfirm } from "../../ui-contract";
import { requestConfirm, showToast } from "../../ui/feedback";
import { fileSelectionLabel } from "../../../../src/shared/file-selection";
import type { WorkFolderAppearanceState } from "../../../../src/shared/work-folder-appearance";
import type { WorkFolderUiFixture } from "../../fixtures/work-folder-fixture";
import type { AgentStatus, ChatDraftRequest, ChatSendRequest, ConversationSummary, FileContextMenuState, RestrictedAppInstalled, TreeEntry, WorkFolderSummary } from "../../types";
import {
  closedSidebarParents,
  defaultFileManagerSort,
  fileKindLabel,
  fileManagerIcon,
  collapseCrumbs,
  fileManagerPathBar,
  historyTimeLabel,
  fileManagerSuggestions,
  fileManagerStatusText,
  formatFileManagerDate,
  nextFileManagerSort,
  normalizeFileManagerSort,
  normalizeFileManagerView,
  parentPath,
  rangeSelection,
  sortFileManagerEntries,
  typeSelectMatch,
  type FileManagerSort,
  type FileManagerSortKey,
  type FileManagerView as FileManagerViewMode,
  sidebarWorkFolderRows,
} from "./file-manager-model";
import {
  placeApiBase,
  placeKey,
  sameLocation,
  samePlace,
  sidebarStandardFolders,
  standardFolderNames,
  type FileManagerLocation,
  type FileManagerPlace,
  type StandardFolderSummary,
} from "./file-manager-places";
import { useFolderListing } from "./useFolderListing";
import { useFileManagerSearch, type FileManagerSearchResult, type FileManagerSearchScope } from "./useFileManagerSearch";
import { useStandardFolders } from "./useFileManagerPlaces";
import { useFileManagerActivity } from "./useFileManagerActivity";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { FileManagerComposer, FileManagerPanel } from "./FileManagerPanel";
import { ChatPanel, WorkerModelRow } from "../chat/ChatPanel";
import { PaneResizer, panelWidthSpec, sidebarWidthSpec, usePaneWidth } from "./PaneResizer";
import { GoToFolderSheet, type GoToFolderLookup } from "./GoToFolderSheet";
import { isMarkedPath, useWorkerChanges, workerChangesSummary } from "./useWorkerChanges";
import { useFolderSuggestions } from "./useFolderSuggestions";
import { StandardFolderGlyph } from "./file-manager-glyphs";
import { TintedFolder } from "./file-manager-folder";
import type { WorkFolderIconOption } from "../../work-folder-icons";
import { useFolderAutomations } from "../../hooks/useFolderAutomations";

const viewStorageKey = "work-fold.file-manager.view.v1";
const panelStorageKey = "work-fold.file-manager.panel.v1";
const sortStorageKey = "work-fold.file-manager.sort.v1";
/** work-folders whose sub work-folders are shown in the sidebar. */
const sidebarOpenStorageKey = "work-fold.file-manager.sidebar-open.v1";
const typeSelectResetMs = 900;

/** The desktop calls for one place's files. */
interface PlaceFileBridge {
  open: (path: string, action: "open" | "open-native" | "reveal") => Promise<void>;
  openWith: ((path: string) => Promise<{ opened: boolean; canceled: boolean; appName: string | null }>) | null;
  drag: (path: string) => Promise<unknown>;
  preview: (path: string) => Promise<boolean>;
}

/**
 * The file manager layout (docs/product-model.md, "2026-11-06 file manager
 * layout"): a Finder-style window over the same local API and desktop bridge
 * Files uses. The sidebar opens the Standard Folders and every work-folder.
 */
export function FileManagerView({ workFolder: activeWorkFolder, workFolders, appearance, agent, fixture, desktopAction, onSwitchWorkFolder, onOpenSettings, onRefreshBootstrap, onCreateWorkFolder, onOpenFolder, onError }: {
  workFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  agent: AgentStatus;
  /** Menu-bar commands meant for the window in front, and the buttons in Settings that open something here. */
  desktopAction?: { id: number; command: string; workFolderId?: string; conversationId?: string; path?: string; title?: string; app?: RestrictedAppInstalled } | null;
  appearance?: WorkFolderAppearanceState;
  fixture: WorkFolderUiFixture | null;
  onSwitchWorkFolder: (workFolder: WorkFolderSummary) => void;
  onOpenSettings: (page?: SettingsPage, modelScope?: ModelScope, focusAiModel?: boolean, workerWorkFolderId?: string, focusWorkerInstructions?: boolean, backToCustomization?: () => void) => void;
  onRefreshBootstrap: () => Promise<unknown>;
  /** The + beside work-folders: Create New work-folder and Use Existing Folder, as in the File menu. */
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onError: (message: string | null) => void;
}) {
  const fixtureMode = Boolean(fixture);
  const mac = isMacOS();
  const resolveIdentity = useWorkFolderIdentityResolver();
  // Each work-folder's name, colors, icon, and banner, edited in Customize work-folder.
  const workFolderCustomizations = useWorkFolderCustomizations({
    fixtureCustomizations: fixture ? fixture.customizations : null,
    appearance,
    workFolderIds: workFolders.map((item) => item.id).join("|"),
  });
  const { customizations } = workFolderCustomizations;
  const [customizing, setCustomizing] = useState<{ workFolderId: string; section: WorkFolderAppearanceSection } | null>(null);
  const customizingWorkFolder = customizing ? workFolders.find((item) => item.id === customizing.workFolderId) ?? null : null;
  const standard = useStandardFolders(fixtureMode);

  const [location, setLocation] = useState<FileManagerLocation>(() => ({ place: { kind: "work-folder", id: activeWorkFolder.id }, path: "" }));
  const [back, setBack] = useState<FileManagerLocation[]>([]);
  const [forward, setForward] = useState<FileManagerLocation[]>([]);
  const place = location.place;
  const workFolder = place.kind === "work-folder" ? workFolders.find((item) => item.id === place.id) ?? null : null;
  // Sub work-folders sit under their parent in the sidebar behind a caret
  // (owner request, 2026-11-07); the parent of one is the deepest work-folder
  // that contains it, as everywhere else (src/shared/folder-nesting.ts).
  const [sidebarOpen, setSidebarOpenState] = useState<string[]>(() => readStoredJsonValue(sidebarOpenStorageKey, (value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [], []));
  const setSidebarOpen = (next: string[]) => { setSidebarOpenState(next); writeStoredJsonValue(sidebarOpenStorageKey, next); };
  const toggleSidebarFolder = (id: string) => setSidebarOpen(sidebarOpen.includes(id) ? sidebarOpen.filter((item) => item !== id) : [...sidebarOpen, id]);
  // Going into a sub work-folder opens its parents, so where you are is always in view.
  useEffect(() => {
    if (!workFolder) return;
    const closed = closedSidebarParents(workFolder, workFolders, sidebarOpen);
    if (closed.length) setSidebarOpen([...sidebarOpen, ...closed]);
  }, [workFolder?.id, workFolders]); // eslint-disable-line react-hooks/exhaustive-deps
  const standardFolder = place.kind === "standard" ? standard.folders.find((item) => item.id === place.id) ?? null : null;
  const placeName = workFolder?.name
    ?? standardFolder?.name
    ?? standardFolderNames[place.id] ?? place.id;
  const placeRoot = workFolder?.workFolderRoot ?? standardFolder?.root ?? "";
  const apiBase = placeApiBase(place);
  const fixtureTree = fixture
    ? place.kind === "work-folder" ? fixture.trees[place.id] ?? [] : place.kind === "standard" ? standard.fixtureTrees?.[place.id] ?? [] : []
    : undefined;
  const listing = useFolderListing(place, location.path, fixtureTree);
  const bridge = useMemo(() => placeFileBridge(place), [placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setViewState] = useState<FileManagerViewMode>(() => readStoredJsonValue(viewStorageKey, normalizeFileManagerView, "list"));
  const [sort, setSortState] = useState<FileManagerSort>(() => readStoredJsonValue(sortStorageKey, normalizeFileManagerSort, defaultFileManagerSort));
  const setView = (next: FileManagerViewMode) => { setViewState(next); writeStoredJsonValue(viewStorageKey, next); };
  const setSort = (next: FileManagerSort) => { setSortState(next); writeStoredJsonValue(sortStorageKey, next); };
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => readStoredJsonValue(panelStorageKey, (value) => value !== false, true));
  const setPanelOpen = (next: boolean) => { setPanelOpenState(next); writeStoredJsonValue(panelStorageKey, next); };
  const folderAutomations = useFolderAutomations(workFolder?.id ?? activeWorkFolder.id, fixtureMode);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<FileManagerSearchScope>("here");
  const [searchSelection, setSearchSelection] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [hiddenPaths, setHiddenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchFieldRef = useRef<HTMLInputElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = usePaneWidth(sidebarWidthSpec);
  const [panelWidth, setPanelWidth] = usePaneWidth(panelWidthSpec);
  // Notices sit over the folder list, centered between the sidebar and the panel; they live outside this view, so the widths go on the page.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--fm-notice-left", `${sidebarWidth}px`);
    root.setProperty("--fm-notice-right", `${panelOpen ? panelWidth : 0}px`);
    return () => { root.removeProperty("--fm-notice-left"); root.removeProperty("--fm-notice-right"); };
  }, [sidebarWidth, panelWidth, panelOpen]);
  const typeSelectRef = useRef<{ text: string; timer: number | null }>({ text: "", timer: null });

  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<TreeEntry | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<NewFolderTarget | null>(null);
  const [newStandardFolderParent, setNewStandardFolderParent] = useState<string | null>(null);
  const [versionHistory, setVersionHistory] = useState<TreeEntry | null>(null);
  const [skillsFor, setSkillsFor] = useState<WorkFolderSummary | null>(null);
  const [actionMenu, setActionMenu] = useState<{ target: WorkFolderSummary | null; x: number; y: number } | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  // Recents (2026-11-07): files changed lately across the work-folders and the top of Desktop, Documents, and Downloads.
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [recents, setRecents] = useState<RecentItem[] | null>(null);
  const [recentSelection, setRecentSelection] = useState<string | null>(null);
  // The window's key handler is installed once; it reaches the current undo through this.
  const undoFileChangeRef = useRef<(redo: boolean) => Promise<void>>(async () => undefined);
  // Where a drag would land: "" for the folder shown, a folder row's path, or null.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The files dragged out of this list, so dropping them back on a folder row moves them rather than copying.
  const internalDragRef = useRef<{ place: FileManagerPlace; paths: string[]; at: number } | null>(null);
  // What ⌘C copied here: the items by place (so ⌥⌘V can move them) and as paths on the system pasteboard.
  const fileClipboardRef = useRef<{ place: FileManagerPlace; paths: string[]; nativePaths: string[] } | null>(null);
  // ⌘Z and ⇧⌘Z for file changes: each entry undoes one change and returns the entry that redoes it.
  const undoStackRef = useRef<FileUndo[]>([]);
  const redoStackRef = useRef<FileUndo[]>([]);
  // Files dropped onto the message box, referenced alongside the selection.
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  const [sidebarDrop, setSidebarDrop] = useState<string | null>(null);
  // Bumped when a Worker reply ends here, so the receipt reads what it changed.
  const [turnsSettled, setTurnsSettled] = useState(0);
  const [composerDrop, setComposerDrop] = useState(false);
  const [quickMenu, setQuickMenu] = useState<{ x: number; y: number; items: Array<{ label: string; command: string }>; run: (command: string | null) => void } | null>(null);
  // The Chat the panel holds (docs/product-model.md, 2026-11-06): one at a
  // time, in the work-folder it belongs to.
  // `conversationId` is the Chat opened from History; a new one from the
  // message box keeps it null (as a new Chat tab does) and learns `activeId`.
  const [panelChat, setPanelChat] = useState<{ key: number; workFolderId: string; conversationId: string | null; activeId: string | null; title: string; sendRequest: ChatSendRequest | null; draftRequest?: ChatDraftRequest | null; open: boolean } | null>(null);

  // Another part of the app (the menu bar, a notification) chose a different
  // work-folder: show its top level, as choosing it in the sidebar would.
  useEffect(() => {
    if (place.kind === "work-folder" && place.id === activeWorkFolder.id) return;
    navigate({ place: { kind: "work-folder", id: activeWorkFolder.id }, path: "" });
  }, [activeWorkFolder.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Files dropped on the message box belong to the folder shown.
  useEffect(() => { setAttachedPaths([]); }, [placeKey(place), location.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // A Chat belongs to its work-folder; leaving it for another place closes it.
  useEffect(() => {
    if (panelChat && panelChat.workFolderId !== workFolder?.id) setPanelChat(null);
  }, [placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps

  // A work-folder removed elsewhere leaves nothing to show; fall back to the active one.
  useEffect(() => {
    if (place.kind === "work-folder" && !workFolder) setLocation({ place: { kind: "work-folder", id: activeWorkFolder.id }, path: "" });
  }, [activeWorkFolder.id, place, workFolder]);

  const entries = listing.entries;
  const kindLabel = (entry: TreeEntry) => entry.nestedFolder ? "work-folder" : fileKindLabel(entry);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const shown = entries.filter((entry) => !hiddenPaths.has(hiddenKey(place, entry.path)) && (!needle || entry.name.toLocaleLowerCase().includes(needle)));
    return sortFileManagerEntries(shown, sort, kindLabel);
  }, [entries, hiddenPaths, query, sort, placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => visible.map((entry) => entry.path), [visible]);
  const byPath = useMemo(() => new Map(visible.map((entry) => [entry.path, entry])), [visible]);
  const selected = useMemo(() => new Set(selection.filter((path) => byPath.has(path))), [byPath, selection]);
  const focusPath = selection.length ? selection[selection.length - 1] ?? null : null;

  // Selection belongs to the folder shown; leaving it starts fresh.
  useEffect(() => { setSelection([]); anchorRef.current = null; setQuery(""); }, [placeKey(place), location.path]); // eslint-disable-line react-hooks/exhaustive-deps

  function navigate(next: FileManagerLocation, history: "push" | "back" | "forward" = "push", switchTo?: WorkFolderSummary) {
    setRecentsOpen(false);
    if (sameLocation(next, location)) return;
    if (history === "push") { setBack((items) => [...items, location]); setForward([]); }
    setLocation(next);
    if (next.place.kind === "work-folder" && next.place.id !== activeWorkFolder.id) {
      const nextId = next.place.id;
      const target = switchTo ?? workFolders.find((item) => item.id === nextId);
      if (target) onSwitchWorkFolder(target);
    }
  }
  function goBack() {
    const previous = back.at(-1);
    if (!previous) return;
    setBack((items) => items.slice(0, -1));
    setForward((items) => [location, ...items]);
    navigate(previous, "back");
  }
  function goForward() {
    const next = forward[0];
    if (!next) return;
    setForward((items) => items.slice(1));
    setBack((items) => [...items, location]);
    navigate(next, "forward");
  }
  function goToEnclosingFolder() {
    if (!location.path) return;
    const from = location.path;
    navigate({ place, path: parentPath(location.path) });
    window.setTimeout(() => select([from]), 0);
  }

  function select(paths: string[], anchor = paths.at(-1) ?? null) {
    setSelection(paths);
    anchorRef.current = anchor;
    const last = paths.at(-1);
    if (last) window.requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>(`[data-fm-path="${cssEscape(last)}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function clickEntry(entry: TreeEntry, event: MouseEvent<HTMLElement>) {
    contentRef.current?.focus({ preventScroll: true });
    const toggle = mac ? event.metaKey : event.ctrlKey;
    if (event.shiftKey) { select(rangeSelection(order, anchorRef.current, entry.path), anchorRef.current ?? entry.path); return; }
    if (toggle) {
      const next = selected.has(entry.path) ? selection.filter((path) => path !== entry.path) : [...selection, entry.path];
      select(next, entry.path);
      return;
    }
    select([entry.path]);
  }

  /** The registered work-folder a nested folder row stands for. */
  function nestedWorkFolder(entry: TreeEntry): WorkFolderSummary | undefined {
    if (!entry.nestedFolder || !placeRoot) return undefined;
    return workFolders.find((item) => sameFolder(item.workFolderRoot, joinNative(placeRoot, entry.path)));
  }

  async function openEntry(entry: TreeEntry) {
    if (entry.kind === "folder") {
      const nested = nestedWorkFolder(entry);
      if (nested) { navigate({ place: { kind: "work-folder", id: nested.id }, path: "" }); return; }
      navigate({ place, path: entry.path });
      return;
    }
    await openLocal(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
  }

  async function openLocal(path: string, action: "reveal" | "open" | "open-native" | "open-with") {
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    if (!bridge) { showToast({ text: "Opening files is available in the Mac app", tone: "info" }); return; }
    try {
      if (action === "open-with") {
        if (!bridge.openWith) return;
        const result = await bridge.openWith(path);
        if (result.opened && result.appName) showToast({ text: `Opened in ${result.appName}`, tone: "success" });
        return;
      }
      await bridge.open(path, action);
    } catch (caught) {
      onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    }
  }

  function quickLook(path: string | null) {
    const entry = path ? byPath.get(path) : null;
    if (!entry || entry.kind !== "file") return;
    if (!mac || !bridge) { showToast({ text: "Quick Look is available in the Mac app", tone: "info" }); return; }
    void bridge.preview(entry.path).catch((caught) => onError(errorText(caught)));
  }

  function startDrag(entry: TreeEntry, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (entry.kind !== "file" || !bridge) return;
    internalDragRef.current = { place, paths: [entry.path], at: Date.now() };
    void bridge.drag(entry.path).catch((caught) => onError(errorText(caught)));
  }

  /**
   * Dropping onto the list (owner request, 2026-11-07: find the friction):
   * files from Finder are added to the folder shown, or to the folder row they
   * land on; a file dragged out of this list onto a folder row moves there.
   * Both keep History, as every change here does. A Standard Folder is
   * changed in Finder, so a drop there says so.
   */
  function dropTargetFor(event: DragEvent<HTMLElement>): string {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-fm-path]");
    const entry = row ? byPath.get(row.dataset.fmPath ?? "") : undefined;
    return entry && entry.kind === "folder" && !entry.nestedFolder ? entry.path : location.path;
  }

  function internalDrag(event: DragEvent<HTMLElement>): string[] | null {
    const current = internalDragRef.current;
    if (!current || Date.now() - current.at > 60_000) return null;
    const names = Array.from(event.dataTransfer.files).map((file) => file.name);
    const dragged = current.paths.map((path) => path.slice(path.lastIndexOf("/") + 1));
    return names.length === dragged.length && names.every((name) => dragged.includes(name)) ? current.paths : null;
  }

  function dragOverList(event: DragEvent<HTMLDivElement>) {
    if (searchMode || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = workFolder ? (internalDragRef.current ? "move" : "copy") : "none";
    const target = workFolder ? dropTargetFor(event) : null;
    setDropTarget((current) => current === target ? current : target);
  }

  async function dropOnList(event: DragEvent<HTMLDivElement>) {
    if (searchMode || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const target = dropTargetFor(event);
    setDropTarget(null);
    await dropInto({ place, path: target }, event, target ? target.slice(target.lastIndexOf("/") + 1) : folderName);
  }

  /**
   * One drop, wherever it lands (the list, a folder row, a sidebar place): a
   * file dragged out of this list moves there; files from Finder are copied
   * in. Both go through the same transfer as paste, so ⌘Z undoes them.
   */
  async function dropInto(target: { place: FileManagerPlace; path: string }, event: DragEvent<HTMLElement>, targetName: string, options: { select?: boolean } = {}): Promise<string[]> {
    const moving = internalDrag(event);
    const movingPlace = internalDragRef.current?.place ?? null;
    internalDragRef.current = null;
    const getPath = window.workFoldDesktop?.agent?.getPathForFile;
    const nativePaths = moving || !getPath ? [] : Array.from(event.dataTransfer.files).map((file) => getPath(file)).filter(Boolean);
    // Collect before the first await: a dropped folder is readable only during the drop.
    const collected = moving || nativePaths.length ? null : collectDroppedUploadFiles(event.dataTransfer);
    if (fixtureMode) { showToast({ text: "Adding files is disabled in the preview", tone: "info" }); return []; }
    try {
      if (moving && movingPlace) {
        const sources = moving.filter((path) => !(samePlace(movingPlace, target.place) && (parentPath(path) === target.path || path === target.path)));
        if (!sources.length) return [];
        const result = await transfer({ mode: "move", sources: sources.map((path) => ({ place: movingPlace, path })), target });
        await afterTransfer(result, target, `Move ${transferLabel(sources)}`, options.select ?? samePlace(target.place, place));
        showToast({ text: result.copiedInstead ? `Copied ${transferLabel(sources)} to ${targetName}. The original stays where it was.` : `Moved ${transferLabel(sources)} to ${targetName}`, tone: "success" });
        return result.written;
      }
      if (nativePaths.length) {
        const result = await transfer({ mode: "copy", sources: nativePaths.map((nativePath) => ({ nativePath })), target });
        await afterTransfer(result, target, `Add ${transferLabel(nativePaths)}`, options.select ?? samePlace(target.place, place));
        showToast({ text: `Added ${transferLabel(nativePaths)} to ${targetName}`, tone: "success" });
        return result.written;
      }
      // A browser without file paths can still upload into a work-folder.
      const files = await collected!;
      if (!files.length) return [];
      if (target.place.kind !== "work-folder") { showToast({ text: `Add files to ${targetName} in Finder, or put it to work first.`, tone: "info" }); return []; }
      const form = new FormData();
      form.set("targetFolderPath", target.path);
      form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
      files.forEach((item) => form.append("files", item.file, item.file.name));
      const uploaded = await historyTurn([target.place.id], () => apiForm<{ uploaded: Array<{ path: string }>; safetyCheckpointId: string | null }>(`/api/work-folders/${encodeURIComponent(target.place.id)}/upload-local-files`, form));
      if (uploaded.safetyCheckpointId) recordUndo(restorePointsUndo(`Add ${formatItemCount(files.length, "file")}`, [{ workFolderId: target.place.id, checkpointId: uploaded.safetyCheckpointId }]));
      await listing.refresh();
      showToast({ text: `Added ${files.length === 1 ? files[0]!.file.name : formatItemCount(files.length, "file")} to ${targetName}`, tone: "success" });
      return uploaded.uploaded.map((item) => item.path);
    } catch (caught) {
      onError(errorText(caught));
      return [];
    }
  }

  // ---- Copy, paste, duplicate, compress, and ⌘Z (2026-11-07) ----
  undoFileChangeRef.current = (redo) => undoFileChange(redo);

  interface TransferResult { mode: string; written: string[]; restorePoints: Array<{ workFolderId: string; checkpointId: string }>; copiedInstead?: boolean; moves?: Array<{ from: string; to: string }> }

  function transfer(body: { mode: "copy" | "move" | "duplicate"; sources: Array<{ place: FileManagerPlace; path: string } | { nativePath: string }>; target: { place: FileManagerPlace; path: string } }): Promise<TransferResult> {
    const workFolderIds = [body.target.place, ...body.sources.map((source) => "place" in source ? source.place : null)]
      .flatMap((item) => item?.kind === "work-folder" ? [item.id] : []);
    return historyTurn(workFolderIds, () => api<TransferResult>("/api/file-transfer", { method: "POST", body }));
  }

  /**
   * A request that writes History waits its turn in every work-folder it
   * touches, the way the History list's requests do, so the host never turns
   * one away for overlapping another.
   */
  function historyTurn<T>(workFolderIds: readonly string[], request: () => Promise<T>): Promise<T> {
    const ids = [...new Set(workFolderIds)].sort();
    return ids.reduceRight<() => Promise<T>>((next, id) => () => queueHistoryRequest(id, next), request)();
  }

  function transferLabel(paths: readonly string[]): string {
    if (paths.length !== 1) return `${paths.length} items`;
    const only = paths[0]!;
    return only.slice(Math.max(only.lastIndexOf("/"), only.lastIndexOf("\\")) + 1);
  }

  /** After any transfer: its undo, a fresh listing, and the new items selected when they are in the folder shown. */
  async function afterTransfer(result: TransferResult, target: { place: FileManagerPlace; path: string }, label: string, selectWritten: boolean) {
    if (result.restorePoints.length) recordUndo(restorePointsUndo(label, result.restorePoints));
    else if (result.moves?.length && target.place.kind === "standard") recordUndo(standardMovesUndo(label, target.place, result.moves));
    await Promise.all([listing.refresh(), standard.refresh()]);
    if (selectWritten && samePlace(target.place, place) && target.path === location.path) select(result.written);
  }

  function recordUndo(entry: FileUndo) {
    undoStackRef.current = [...undoStackRef.current.slice(-49), entry];
    redoStackRef.current = [];
  }

  /** Undo through History: restore each point in turn; the safety points those restores leave are the redo. */
  function restorePointsUndo(label: string, points: Array<{ workFolderId: string; checkpointId: string }>): FileUndo {
    return {
      label,
      run: async () => {
        const redo: Array<{ workFolderId: string; checkpointId: string }> = [];
        for (const point of points) {
          const restored = await historyTurn([point.workFolderId], () => api<{ safetyCheckpointId: string }>(`/api/work-folders/${encodeURIComponent(point.workFolderId)}/history/checkpoints/${encodeURIComponent(point.checkpointId)}/restore`, { method: "POST", body: {} }));
          redo.unshift({ workFolderId: point.workFolderId, checkpointId: restored.safetyCheckpointId });
        }
        return restorePointsUndo(label, redo);
      },
    };
  }

  /** A Standard Folder has no History: undoing a move there moves each item back. */
  function standardMovesUndo(label: string, target: FileManagerPlace, moves: Array<{ from: string; to: string }>): FileUndo {
    return {
      label,
      run: async () => {
        const back: Array<{ from: string; to: string }> = [];
        for (const move of moves) {
          const result = await transfer({ mode: "move", sources: [{ place: target, path: move.to }], target: { place: target, path: parentPath(move.from) } });
          back.push({ from: move.to, to: result.written[0] ?? move.from });
        }
        return standardMovesUndo(label, target, back);
      },
    };
  }

  async function undoFileChange(redo = false) {
    const stack = redo ? redoStackRef : undoStackRef;
    const entry = stack.current.at(-1);
    if (!entry) { showToast({ text: redo ? "Nothing to redo" : "Nothing to undo", tone: "info" }); return; }
    stack.current = stack.current.slice(0, -1);
    try {
      const reverse = await entry.run();
      if (reverse) {
        if (redo) undoStackRef.current = [...undoStackRef.current.slice(-49), reverse];
        else redoStackRef.current = [...redoStackRef.current.slice(-49), reverse];
      }
      await Promise.all([listing.refresh(), standard.refresh()]);
      showToast({ text: `${redo ? "Redid" : "Undid"} ${entry.label}`, tone: "success" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  function selectedEntries(): TreeEntry[] {
    return selection.map((path) => byPath.get(path)).filter((entry): entry is TreeEntry => Boolean(entry) && !entry!.nestedFolder);
  }

  /** ⌘C: the selection, here and on the system pasteboard, so Finder can paste it too. */
  async function copySelection(entries = selectedEntries()) {
    if (!entries.length) return;
    const nativePaths = entries.map((entry) => workFolderEntryNativePath(placeRoot, entry.path));
    fileClipboardRef.current = { place, paths: entries.map((entry) => entry.path), nativePaths };
    await window.workFoldDesktop?.fileClipboard?.write(nativePaths).catch(() => false);
  }

  /**
   * ⌘V pastes what was copied (here or in Finder) into a folder; ⌥⌘V moves what
   * was copied here. The desktop process reads the pasteboard and pastes; the
   * window never reads it, and learns only what landed.
   */
  async function pasteInto(targetPath = location.path, mode: "copy" | "move" = "copy") {
    if (fixtureMode) { showToast({ text: "Pasting is disabled in the preview", tone: "info" }); return; }
    const internal = fileClipboardRef.current;
    const target = { place, path: targetPath };
    const paste = window.workFoldDesktop?.fileClipboard?.paste;
    try {
      let result: TransferResult & { nothing?: boolean; fromHere?: boolean; count?: number };
      if (paste) {
        const touched = [target.place, internal?.place].flatMap((item) => item?.kind === "work-folder" ? [item.id] : []);
        result = await historyTurn(touched, () => paste({ target, mode, internal: internal ? { place: internal.place, paths: internal.paths, nativePaths: internal.nativePaths } : null }));
      } else {
        if (!internal) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
        result = { ...(await transfer({ mode, sources: internal.paths.map((path) => ({ place: internal.place, path })), target })), fromHere: true, count: internal.paths.length };
      }
      if (result.nothing) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
      const moved = Boolean(result.fromHere) && mode === "move" && !result.copiedInstead;
      const label = result.fromHere && internal ? transferLabel(internal.paths) : result.count === 1 ? transferLabel(result.written) : `${result.count ?? result.written.length} items`;
      await afterTransfer(result, target, `${moved ? "Move" : "Paste"} ${label}`, true);
      if (moved) fileClipboardRef.current = null;
      if (result.copiedInstead) showToast({ text: `Copied ${label}. The original stays where it was.`, tone: "info" });
    } catch (caught) {
      onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    }
  }

  async function duplicateSelection(entries = selectedEntries()) {
    if (!entries.length) return;
    if (fixtureMode) { showToast({ text: "Duplicating is disabled in the preview", tone: "info" }); return; }
    const target = { place, path: parentPath(entries[0]!.path) };
    try {
      const result = await transfer({ mode: "duplicate", sources: entries.map((entry) => ({ place, path: entry.path })), target });
      await afterTransfer(result, target, `Duplicate ${transferLabel(entries.map((entry) => entry.path))}`, true);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  async function compressSelection(entries = selectedEntries()) {
    if (!entries.length) return;
    if (fixtureMode) { showToast({ text: "Compressing is disabled in the preview", tone: "info" }); return; }
    try {
      const result = await historyTurn(place.kind === "work-folder" ? [place.id] : [], () => api<{ path: string; restorePoints: Array<{ workFolderId: string; checkpointId: string }> }>("/api/file-transfer/compress", { method: "POST", body: { place, paths: entries.map((entry) => entry.path) } }));
      if (result.restorePoints.length) recordUndo(restorePointsUndo(`Compress ${transferLabel(entries.map((entry) => entry.path))}`, result.restorePoints));
      await listing.refresh();
      select([result.path]);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** New Folder with Selection: a folder beside the items, the items moved into it, and its name ready to type. */
  async function groupSelection(entries = selectedEntries()) {
    if (entries.length < 1) return;
    if (fixtureMode) { showToast({ text: "Making folders is disabled in the preview", tone: "info" }); return; }
    const parent = parentPath(entries[0]!.path);
    try {
      const created = place.kind === "work-folder"
        ? (await historyTurn([place.id], () => api<{ folder: { path: string; name: string }; safetyCheckpointId: string }>(`/api/work-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name: "New Folder With Items" } })))
        : { folder: await api<{ path: string }>(`/api/standard-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name: "New Folder With Items" } }), safetyCheckpointId: null };
      const folderPath = created.folder.path;
      const result = await transfer({ mode: "move", sources: entries.map((entry) => ({ place, path: entry.path })), target: { place, path: folderPath } });
      if (place.kind === "work-folder") {
        const points = [...result.restorePoints, ...(created.safetyCheckpointId ? [{ workFolderId: place.id, checkpointId: created.safetyCheckpointId }] : [])];
        recordUndo(restorePointsUndo("New Folder with Selection", points));
      }
      await listing.refresh();
      select([folderPath]);
      requestRename({ name: folderPath.slice(folderPath.lastIndexOf("/") + 1), path: folderPath, kind: "folder" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** Dropping onto a sidebar place: into the top of that work-folder or Standard Folder. */
  function sidebarDragOver(target: FileManagerPlace, event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = internalDragRef.current && target.kind === "work-folder" && internalDragRef.current.place.kind === "work-folder" ? "move" : "copy";
    const key = placeKey(target);
    setSidebarDrop((current) => current === key ? current : key);
  }

  async function sidebarDropInto(target: FileManagerPlace, name: string, event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setSidebarDrop(null);
    await dropInto({ place: target, path: "" }, event, name, { select: false });
  }

  /** Dropping onto the message box: the files join the message's references (from Finder, they are added to this folder first). */
  async function composerDropFiles(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files") || !workFolder) return;
    event.preventDefault();
    setComposerDrop(false);
    const internal = internalDrag(event);
    if (internal && internalDragRef.current && samePlace(internalDragRef.current.place, place)) {
      internalDragRef.current = null;
      setAttachedPaths((current) => [...new Set([...current, ...internal])]);
      return;
    }
    const written = await dropInto({ place, path: location.path }, event, folderName, { select: false });
    if (written.length) setAttachedPaths((current) => [...new Set([...current, ...written])]);
  }

  async function copyPaths(paths: readonly string[]) {
    await copyToClipboard({ text: paths.map((path) => workFolderEntryNativePath(placeRoot, path)).join("\n") });
    showToast({ text: paths.length === 1 ? "Path copied" : "Paths copied", tone: "success" });
  }

  async function deletePaths(paths: readonly string[]) {
    const entriesToDelete = paths.map((path) => byPath.get(path)).filter((entry): entry is TreeEntry => Boolean(entry) && !entry!.nestedFolder);
    if (!entriesToDelete.length) return;
    if (fixtureMode) { showToast({ text: "Deleting is disabled in the preview", tone: "info" }); return; }
    const trash = place.kind === "standard" ? window.workFoldDesktop?.standardFolder?.trash : null;
    if (place.kind === "standard" && !trash) { showToast({ text: "Move to Trash is available in the Mac app", tone: "info" }); return; }
    const files = entriesToDelete.filter((entry) => entry.kind === "file").length;
    if (place.kind === "work-folder" && entriesToDelete.some((entry) => entry.kind === "folder")) {
      const confirmed = entriesToDelete.length === 1
        ? await requestConfirm({ title: deleteFolderConfirm.title(entriesToDelete[0]!.name), body: deleteFolderConfirm.body, confirmLabel: deleteFolderConfirm.confirmLabel, tone: "danger" })
        : await requestConfirm({ title: deleteSelectionConfirm.title(fileSelectionLabel(files, entriesToDelete.length - files)), body: deleteSelectionConfirm.body, confirmLabel: deleteSelectionConfirm.confirmLabel(fileSelectionLabel(files, entriesToDelete.length - files)), tone: "danger" });
      if (!confirmed) return;
    }
    const target = place;
    const keys = entriesToDelete.map((entry) => hiddenKey(target, entry.path));
    setHiddenPaths((current) => new Set([...current, ...keys]));
    setSelection((current) => current.filter((path) => !paths.includes(path)));
    let cancelled = false;
    const unhide = () => { cancelled = true; setHiddenPaths((current) => new Set([...current].filter((key) => !keys.includes(key)))); };
    // ⌘Z while the notice is still up cancels the delete, as the notice's Undo does.
    recordUndo({ label: `Delete ${entriesToDelete.length === 1 ? entriesToDelete[0]!.name : `${entriesToDelete.length} items`}`, run: async () => { unhide(); return null; } });
    const commit = async () => {
      if (cancelled) return;
      try {
        if (target.kind === "standard") {
          const result = await trash!(target.id, entriesToDelete.map((entry) => entry.path));
          if (result.failed) onError(result.failed.error);
        } else if (target.kind === "work-folder" && entriesToDelete.length === 1) {
          const pending: PendingDelete = { workFolderId: target.id, path: entriesToDelete[0]!.path, name: entriesToDelete[0]!.name, selectedPath: null, deletedTabPaths: new Set() };
          const result = await deleteLocalFileRequest(pending) as { safetyCheckpointId?: string };
          // Once it has happened, ⌘Z brings it back through History.
          replaceDeleteUndo(entriesToDelete[0]!.name, target.id, result.safetyCheckpointId);
        } else if (target.kind === "work-folder") {
          const result = await deleteLocalFilesRequest(target.id, entriesToDelete.map((entry) => entry.path));
          if (result.failed) onError(result.failed.error);
          replaceDeleteUndo(`${entriesToDelete.length} items`, target.id, result.safetyCheckpointId);
        }
      } catch (caught) {
        onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
      } finally {
        await listing.refresh();
        unhide();
      }
    };
    const label = entriesToDelete.length === 1 ? entriesToDelete[0]!.name : formatItemCount(entriesToDelete.length, "item");
    showToast({
      text: target.kind === "standard" ? `Moved ${label} to the Trash` : `Removed ${label}`,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: unhide,
      onClose: (reason) => { if (reason !== "action") void commit(); },
    });
  }

  /** The pending delete's undo, swapped for History's once the delete has happened. */
  function replaceDeleteUndo(name: string, workFolderId: string, checkpointId: string | undefined) {
    const label = `Delete ${name}`;
    undoStackRef.current = undoStackRef.current.filter((entry) => entry.label !== label);
    if (checkpointId) undoStackRef.current = [...undoStackRef.current.slice(-49), restorePointsUndo(label, [{ workFolderId, checkpointId }])];
  }

  async function renameEntry(entry: TreeEntry, name: string) {
    if (name === entry.name || !apiBase) return;
    const result = await historyTurn(place.kind === "work-folder" ? [place.id] : [], () => api<{ safetyCheckpointId?: string; path?: string }>(`${apiBase}/rename-local-entry`, { method: "POST", body: { path: entry.path, newName: name } }));
    await listing.refresh();
    const renamed = [parentPath(entry.path), name].filter(Boolean).join("/");
    if (place.kind === "work-folder" && result.safetyCheckpointId) recordUndo(restorePointsUndo(`Rename ${entry.name}`, [{ workFolderId: place.id, checkpointId: result.safetyCheckpointId }]));
    else if (place.kind === "standard") recordUndo(standardRenameUndo(`Rename ${entry.name}`, apiBase, renamed, entry.name, entry.path));
    select([renamed]);
    showToast({ text: `Renamed ${entry.name}`, tone: "success" });
  }

  /** A Standard Folder rename is undone by renaming back. */
  function standardRenameUndo(label: string, base: string, currentPath: string, previousName: string, previousPath: string): FileUndo {
    return {
      label,
      run: async () => {
        await api(`${base}/rename-local-entry`, { method: "POST", body: { path: currentPath, newName: previousName } });
        return standardRenameUndo(label, base, previousPath, currentPath.slice(currentPath.lastIndexOf("/") + 1), currentPath);
      },
    };
  }

  async function createStandardFolder(parent: string, name: string) {
    if (place.kind !== "standard") return;
    const created = await api<{ path: string }>(`/api/standard-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name } });
    await listing.refresh();
    select([created.path]);
  }

  /** "Make a work-folder" inside a work-folder, or "Put This Folder to Work" in a standard folder. */
  async function putToWork(path: string, target: FileManagerPlace = place) {
    if (fixtureMode) { showToast({ text: "Making work-folders is disabled in the preview", tone: "info" }); return; }
    try {
      const url = target.kind === "work-folder"
        ? `/api/work-folders/${encodeURIComponent(target.id)}/nested-folders`
        : `/api/standard-folders/${encodeURIComponent(target.id)}/work-folders`;
      const { workFolder: created } = await api<{ workFolder: WorkFolderSummary }>(url, { method: "POST", body: { path } });
      await Promise.all([onRefreshBootstrap(), standard.refresh(), listing.refresh()]);
      const open = () => navigate({ place: { kind: "work-folder", id: created.id }, path: "" }, "push", created);
      if (target.kind === "standard" && !path) {
        // The folder itself is a work-folder now, and the sidebar lists it there.
        open();
        showToast({ text: `${created.name} is now a work-folder.`, tone: "success" });
        return;
      }
      showToast({ text: `${created.name} is now a work-folder.`, actionLabel: "Open", onAction: open });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /**
   * Remove work-folder: work-fold stops using the folder; a linked folder and
   * its files stay where they are, and a managed one moves to Recently Deleted.
   * The host refuses while that work-folder has work or apps that need it, and
   * its words say what to do.
   */
  async function removeWorkFolder(target: WorkFolderSummary) {
    if (fixtureMode) { showToast({ text: "Removing work-folders is disabled in the preview", tone: "info" }); return; }
    const linked = target.location.storage === "linked";
    const confirmed = await requestConfirm({
      title: linked ? `Remove ${target.name}?` : `Delete ${target.name}?`,
      body: linked
        ? "work-fold stops using this folder as a work-folder. The folder and its files stay where they are."
        : "Its folder moves to Recently Deleted, where you can restore it.",
      confirmLabel: linked ? "Remove" : "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api(`/api/work-folders/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      workFolderCustomizations.forget(target.id);
      const fallback = workFolders.find((item) => item.id !== target.id);
      if (place.kind === "work-folder" && place.id === target.id && fallback) navigate({ place: { kind: "work-folder", id: fallback.id }, path: "" }, "push", fallback);
      await Promise.all([onRefreshBootstrap(), standard.refresh()]);
      showToast({ text: linked ? `${target.name} was removed. The folder is still on your computer.` : `${target.name} moved to Recently Deleted.`, tone: "success" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** Before a message goes to a Worker, AI must be connected; Set Up AI comes first, then the message goes. */
  function withAi(send: () => void) {
    if (fixtureMode || agent?.configured) { send(); return; }
    requestConnectAi(send);
  }

  /** The message box: a new Chat in the panel, with the selection (or the folder shown) as references. */
  function startChat(text: string, references: readonly TreeEntry[]) {
    withAi(() => openNewChat(text, references));
  }

  function openNewChat(text: string, references: readonly TreeEntry[]) {
    if (!workFolder) return;
    setAttachedPaths([]);
    const paths = references.length ? references.map((entry) => entry.path) : location.path ? [location.path] : [];
    const id = Date.now();
    setPanelChat({ key: id, workFolderId: workFolder.id, conversationId: null, activeId: null, title: text.length > 42 ? `${text.slice(0, 40)}…` : text, sendRequest: { id, text, paths }, open: true });
  }

  function openChat(conversationId: string, title: string) {
    if (!workFolder) return;
    if (panelChat && (panelChat.activeId ?? panelChat.conversationId) === conversationId && panelChat.workFolderId === workFolder.id) { setPanelChat({ ...panelChat, open: true }); return; }
    setPanelChat({ key: Date.now(), workFolderId: workFolder.id, conversationId, activeId: conversationId, title, sendRequest: null, open: true });
  }

  // The menu bar's commands that mean something here: Skills & Extensions
  // (⌘⇧S) for the work-folder shown, New Chat (⌘⇧N) at the message box, and Refresh (⌘R).
  useEffect(() => {
    if (!desktopAction) return;
    const { command } = desktopAction;
    if (["open-capabilities", "open-skills", "open-extensions"].includes(command)) setSkillsFor(workFolder ?? activeWorkFolder);
    else if (command === "new-chat" && workFolder) {
      setPanelOpen(true);
      setPanelChat((current) => current ? { ...current, open: false } : current);
      window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".fm-comp .fm-field input")?.focus());
    } else if (command === "reload-work-folder-state") void Promise.all([onRefreshBootstrap(), standard.refresh(), listing.refresh()]);
    else if (command === "customize-work-folder" && desktopAction.workFolderId) setCustomizing({ workFolderId: desktopAction.workFolderId, section: "banner" });
    else if (command === "open-app-build-chat" && desktopAction.workFolderId && desktopAction.conversationId) {
      const target = workFolders.find((item) => item.id === desktopAction.workFolderId);
      if (target) openChatIn(target, desktopAction.conversationId, "Build Chat");
      else onError("The app's source work-folder is unavailable.");
    } else if (command === "open-app-result-file" && desktopAction.workFolderId && desktopAction.path) {
      // A result file is shown where it lives, selected.
      const target = workFolders.find((item) => item.id === desktopAction.workFolderId);
      if (target) revealIn(target, desktopAction.path);
      else onError("The result's work-folder is unavailable.");
    } else if (command === "app-change-chat" && desktopAction.app) void startAppChange(desktopAction.app);
    // Apps open only in the classic layout (owner decision 2026-11-06: the file manager leaves apps out).
    else if (command === "open-app-studio") showToast({ text: "App Studio opens in the Classic layout. Switch in Settings → Appearance → Layout.", tone: "info" });
  }, [desktopAction?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function renameWorkFolder(target: WorkFolderSummary, name: string) {
    if (fixtureMode) { showToast({ text: "work-folder rename is disabled in the preview", tone: "info" }); return; }
    try {
      await api(`/api/work-folders/${encodeURIComponent(target.id)}`, { method: "PATCH", body: { name } });
      await onRefreshBootstrap();
      showToast({ text: `Renamed work-folder to ${name}`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); throw caught; }
  }

  /** Go to Folder's lookup: the host's, or the preview's sample folders. */
  async function lookupPath(path: string): Promise<GoToFolderLookup> {
    if (fixtureMode) return fixtureLookup(path);
    return api<GoToFolderLookup>(`/api/go-to-folder?path=${encodeURIComponent(path)}`);
  }

  function fixtureLookup(typed: string): GoToFolderLookup {
    const home = "/Users/you";
    const full = typed === "~" ? home : typed.startsWith("~/") ? `${home}/${typed.slice(2)}` : typed;
    const endsWithSlash = full.endsWith("/");
    const clean = full.replace(/\/+$/, "") || "/";
    const places = [
      ...workFolders.map((item) => ({ place: { kind: "work-folder" as const, id: item.id }, root: item.workFolderRoot, tree: fixture?.trees[item.id] ?? [] })),
      ...standard.folders.filter((folder) => !folder.workFolderId).map((folder) => ({ place: { kind: "standard" as const, id: folder.id }, root: folder.root, tree: standard.fixtureTrees?.[folder.id] ?? [] })),
    ];
    const holder = (path: string) => places.filter((item) => path === item.root || path.startsWith(`${item.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
    const entriesAt = (entries: readonly TreeEntry[], relativePath: string): readonly TreeEntry[] => {
      let current = entries;
      for (const part of relativePath.split("/").filter(Boolean)) current = current.find((entry) => entry.name === part && entry.kind === "folder")?.children ?? [];
      return current;
    };
    const listed = endsWithSlash ? clean : clean.slice(0, clean.lastIndexOf("/")) || "/";
    const partial = endsWithSlash ? "" : clean.slice(clean.lastIndexOf("/") + 1).toLocaleLowerCase();
    const listedHolder = holder(listed);
    const suggestions = listedHolder
      ? entriesAt(listedHolder.tree, listed.slice(listedHolder.root.length + 1)).filter((entry) => entry.name.toLocaleLowerCase().startsWith(partial)).slice(0, 12)
        .map((entry) => ({ name: entry.name, kind: entry.kind, path: `${listed}/${entry.name}` }))
      : [];
    const target = holder(clean);
    if (!target) return { target: null, suggestions, message: "work-fold opens folders in your home folder, iCloud Drive, a work-folder, or a folder in the sidebar." };
    const relativePath = clean.slice(target.root.length + 1);
    if (!relativePath) return { target: { place: target.place, path: "", select: null }, suggestions, message: null };
    const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
    const found = entriesAt(target.tree, parent).find((entry) => entry.name === relativePath.slice(relativePath.lastIndexOf("/") + 1));
    if (!found) return { target: null, suggestions, message: suggestions.length ? null : "There’s no folder or file at that path." };
    return { target: { place: target.place, path: found.kind === "folder" ? relativePath : parent, select: found.kind === "folder" ? null : relativePath }, suggestions, message: null };
  }

  function goTo(target: NonNullable<GoToFolderLookup["target"]>) {
    setGoToOpen(false);
    setQuery("");
    const switchTo = target.place.kind === "work-folder" ? workFolders.find((item) => item.id === target.place.id) : undefined;
    navigate({ place: target.place, path: target.path }, "push", switchTo);
    if (target.select) window.setTimeout(() => select([target.select!]), 0);
    window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
  }

  /** Clicking a path bar item copies its path; the last item is the folder shown, or the item selected. */
  async function copyNativePath(nativePath: string) {
    if (!nativePath) return;
    await copyToClipboard({ text: nativePath });
    showToast({ text: "Path copied", tone: "success" });
  }

  /** Show a work-folder's file or folder where it lives, selected, as Finder's Show in Enclosing Folder does. */
  function revealIn(target: WorkFolderSummary, path: string) {
    setQuery("");
    navigate({ place: { kind: "work-folder", id: target.id }, path: parentPath(path) }, "push", target);
    window.setTimeout(() => select([path]), 0);
  }

  /** Open a Chat of any work-folder in the panel, going to that work-folder first. */
  function openChatIn(target: WorkFolderSummary, conversationId: string, title: string) {
    if (!(place.kind === "work-folder" && place.id === target.id)) navigate({ place: { kind: "work-folder", id: target.id }, path: "" }, "push", target);
    setPanelOpen(true);
    setPanelChat({ key: Date.now(), workFolderId: target.id, conversationId, activeId: conversationId, title, sendRequest: null, open: true });
  }

  /** Settings → Apps' Change: a new Chat in the app's work-folder with the change request drafted, as the classic layout does. */
  async function startAppChange(app: RestrictedAppInstalled) {
    const source = workFolders.find((item) => item.id === app.sourceWorkFolderId);
    if (!source) { onError("The app's source work-folder is unavailable. Refresh work-folders before changing it."); return; }
    try {
      const change = await prepareRestrictedAppChange(app, crypto.randomUUID());
      if (!(place.kind === "work-folder" && place.id === source.id)) navigate({ place: { kind: "work-folder", id: source.id }, path: "" }, "push", source);
      setPanelOpen(true);
      const key = Date.now();
      setPanelChat({ key, workFolderId: source.id, conversationId: null, activeId: null, title: `Change ${app.manifest.title}`, sendRequest: null, draftRequest: { id: key, text: appChangeDraft(change), workFolderId: source.id, surfaceTabId: `file-manager:${source.id}` }, open: true });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  // ⌘F searches names and contents, and ⇧⌘G goes to a folder by its path, as in Finder.
  useEffect(() => {
    function keydown(event: globalThis.KeyboardEvent) {
      const command = mac ? event.metaKey : event.ctrlKey;
      if (!command || event.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.shiftKey && (event.key === "g" || event.key === "G")) { event.preventDefault(); setGoToOpen(true); return; }
      // ⌘Z / ⇧⌘Z undo and redo file changes, except while typing, where they stay the text's own.
      if (event.code === "KeyZ") {
        const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
        if (typing) return;
        event.preventDefault();
        void undoFileChangeRef.current(event.shiftKey);
        return;
      }
      if (event.shiftKey || (event.key !== "f" && event.key !== "F")) return;
      event.preventDefault();
      searchFieldRef.current?.focus();
      searchFieldRef.current?.select();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mac]);

  /** A small menu at the pointer: the native one on the Mac, the in-window one elsewhere. */
  async function popupMenu(event: MouseEvent<HTMLElement>, actions: Partial<Record<"reveal" | "putToWork" | "removeFromSidebar" | "createWorkFolder" | "useExistingFolder", boolean>>, fallback: Array<{ label: string; command: string }>, run: (command: string | null) => void) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    const point = event.type === "contextmenu"
      ? { x: Math.round(event.clientX), y: Math.round(event.clientY) }
      : { x: Math.round(anchor.left), y: Math.round(anchor.bottom + 4) };
    const popup = window.workFoldDesktop?.workFolder.popupHeaderMenu;
    if (mac && popup) {
      try { run(await popup({ actions: { newChat: false, customize: false, setUp: false, reveal: false, manage: false, ...actions }, point })); }
      catch (caught) { onError(errorText(caught)); }
      return;
    }
    setQuickMenu({ x: Math.min(point.x, window.innerWidth - 240), y: Math.min(point.y, window.innerHeight - 160), items: fallback, run });
  }

  /** The + beside Standard Folders: the folder picker adds any folder to the sidebar. */
  async function addStandardFolder() {
    const add = window.workFoldDesktop?.standardFolder?.add;
    if (fixtureMode || !add) { showToast({ text: "Adding folders to the sidebar works in the Mac app", tone: "info" }); return; }
    try {
      const added = await add();
      if (!added) return;
      await standard.refresh();
      navigate({ place: { kind: "standard", id: added.id }, path: "" });
    } catch (caught) { onError(errorText(caught)); }
  }

  /** Right-clicking a Standard Folder: Show in Finder, Put This Folder to Work, and Remove from Sidebar for one added with +. */
  function openStandardFolderMenu(folder: StandardFolderSummary, event: MouseEvent<HTMLElement>) {
    const target: FileManagerPlace = { kind: "standard", id: folder.id };
    void popupMenu(event, { reveal: true, putToWork: true, removeFromSidebar: Boolean(folder.added) }, [
      { label: "Show in Finder", command: "reveal" },
      { label: "Put This Folder to Work", command: "put-to-work" },
      ...(folder.added ? [{ label: "Remove from Sidebar", command: "remove-from-sidebar" }] : []),
    ], (command) => {
      if (command === "reveal") void window.workFoldDesktop?.standardFolder?.openPath(folder.id, "", "reveal").catch((caught) => onError(errorText(caught)));
      else if (command === "put-to-work") void putToWork("", target);
      else if (command === "remove-from-sidebar") void removeStandardFolder(folder);
    });
  }

  async function removeStandardFolder(folder: StandardFolderSummary) {
    try {
      await api(`/api/standard-folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      if (place.kind === "standard" && place.id === folder.id) navigate({ place: { kind: "work-folder", id: activeWorkFolder.id }, path: "" });
      await standard.refresh();
      showToast({ text: `${folder.name} was removed from the sidebar. The folder is still on your computer.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
  }

  /** The + beside work-folders: Create New work-folder or Use Existing Folder. */
  function openAddWorkFolderMenu(event: MouseEvent<HTMLElement>) {
    void popupMenu(event, { createWorkFolder: true, useExistingFolder: true }, [
      { label: "Create New work-folder…", command: "create-work-folder" },
      { label: "Use Existing Folder…", command: "use-existing-folder" },
    ], (command) => {
      if (command === "create-work-folder") onCreateWorkFolder();
      else if (command === "use-existing-folder") onOpenFolder();
    });
  }

  /**
   * Finder's Action menu (the toolbar's ⋯, and right-clicking a work-folder in
   * the sidebar): the work-folder's own commands, then Settings.
   */
  async function openActionMenu(target: WorkFolderSummary | null, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    const point = event.type === "contextmenu"
      ? { x: Math.round(event.clientX), y: Math.round(event.clientY) }
      : { x: Math.round(anchor.left), y: Math.round(anchor.bottom + 4) };
    const popup = window.workFoldDesktop?.workFolder.popupHeaderMenu;
    if (mac && popup) {
      try {
        const command = await popup({
          actions: { newChat: false, customize: Boolean(target), setUp: Boolean(target) && !fixtureMode, reveal: Boolean(bridge) || Boolean(target), skills: Boolean(target), settings: true, manage: false, remove: Boolean(target) },
          point,
        });
        runActionCommand(command, target);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setActionMenu({ target, x: Math.min(point.x, window.innerWidth - 240), y: Math.min(point.y, window.innerHeight - 200) });
  }

  function runActionCommand(command: string | null, target: WorkFolderSummary | null) {
    if (command === "settings") onOpenSettings();
    else if (command === "customize" && target) setCustomizing({ workFolderId: target.id, section: "banner" });
    else if (command === "remove-work-folder" && target) void removeWorkFolder(target);
    else if (command === "skills" && target) setSkillsFor(target);
    else if ((command === "set-up" || command === "look") && target) setUp(target, command === "set-up" ? "full" : "look");
    else if (command === "reveal") {
      if (target) void window.workFoldDesktop?.workFolder.revealFolder(target.id).catch((caught) => onError(errorText(caught)));
      else void openLocal("", "reveal");
    }
  }

  /** Set Up for Me or Just the Look: a Chat in the panel whose first message the set-up Skill answers. */
  function setUp(target: WorkFolderSummary, mode: WorkFolderSetUpMode) {
    withAi(() => sendSetUp(target, mode));
  }

  function sendSetUp(target: WorkFolderSummary, mode: WorkFolderSetUpMode) {
    if (target.id !== workFolder?.id) navigate({ place: { kind: "work-folder", id: target.id }, path: "" }, "push", target);
    setPanelOpen(true);
    const id = Date.now();
    const text = workFolderSetUpMessage(mode);
    setPanelChat({ key: id, workFolderId: target.id, conversationId: null, activeId: null, title: mode === "full" ? "Set Up for Me" : "Just the Look", sendRequest: { id, text, paths: [] }, open: true });
  }

  /** A file a Chat names: show it here, selected, the way the design does. */
  function showChatFile(path: string) {
    if (!workFolder) return;
    const folder = parentPath(path);
    if (folder !== location.path) navigate({ place: { kind: "work-folder", id: workFolder.id }, path: folder });
    window.setTimeout(() => select([path]), folder !== location.path ? 300 : 0);
  }

  function requestRename(entry: TreeEntry | undefined) {
    if (!entry || entry.nestedFolder) return;
    if (fixtureMode) { showToast({ text: "Renaming is disabled in the preview", tone: "info" }); return; }
    setRenaming(entry);
  }

  function requestNewFolder(parent: string) {
    if (fixtureMode) { showToast({ text: "New folders are disabled in the preview", tone: "info" }); return; }
    if (workFolder) setNewFolderTarget({ workFolderId: workFolder.id, workFolderName: workFolder.name, parentPath: parent });
    else if (place.kind === "standard") setNewStandardFolderParent(parent);
  }

  async function openContextMenu(entry: TreeEntry | null, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    let paths = selection;
    if (entry && !selected.has(entry.path)) { paths = [entry.path]; select(paths); }
    if (!entry) { paths = []; select([]); }
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const target: TreeEntry = entry ?? { name: location.path.split("/").pop() || placeName, path: location.path, kind: "folder" };
    const several = entry && paths.length > 1 ? paths.map((path) => byPath.get(path)).filter((item): item is TreeEntry => Boolean(item)) : null;
    const owner = place.kind === "standard" ? { workFolderId: "", standardFolderId: place.id } : { workFolderId: place.id };
    const popupFileMenu = window.workFoldDesktop?.workFolder.popupFileMenu;
    if (mac && popupFileMenu) {
      try {
        if (several) {
          const files = several.filter((item) => item.kind === "file").length;
          const command = await popupFileMenu({ ...owner, path: target.path, kind: target.kind, capabilities: { open: false, attach: false, history: false, upload: false, rename: false, delete: !several.some((item) => item.nestedFolder), organize: !several.some((item) => item.nestedFolder) }, selection: { files, folders: several.length - files }, point });
          if (command === "copy-path") await copyPaths(several.map((item) => item.path));
          else if (command === "delete") await deletePaths(several.map((item) => item.path));
          else if (command === "copy") await copySelection(several);
          else if (command === "duplicate") await duplicateSelection(several);
          else if (command === "compress") await compressSelection(several);
          else if (command === "new-folder-with-selection") await groupSelection(several);
          return;
        }
        const command = await popupFileMenu({
          ...owner,
          path: target.path,
          kind: target.kind,
          capabilities: {
            open: target.kind === "folder" || canOpenDirectly(target.path),
            attach: false,
            history: place.kind === "work-folder" && target.kind === "file",
            upload: false,
            rename: Boolean(target.path) && !target.nestedFolder,
            delete: Boolean(entry) && !target.nestedFolder,
            worker: !fixtureMode && target.kind === "folder" && !target.nestedFolder && (place.kind === "standard" || Boolean(target.path)),
            organize: Boolean(entry) && !target.nestedFolder,
            paste: target.kind === "folder" && !target.nestedFolder && await canPaste(),
          },
          point,
        });
        await runMenuCommand(command, target);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setContextMenu({ entry: target, ...(several ? { selection: several } : {}), x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 380), returnFocusTarget: contentRef.current });
  }

  async function runMenuCommand(command: string | null, target: TreeEntry) {
    if (command === "open") await openEntry(target);
    else if (command === "open-with") await openLocal(target.path, "open-with");
    else if (command === "reveal") await openLocal(target.path, "reveal");
    else if (command === "copy-path") await copyPaths([target.path]);
    else if (command === "version-history" && workFolder) setVersionHistory(target);
    else if (command === "new-folder") requestNewFolder(target.kind === "folder" ? target.path : parentPath(target.path));
    else if (command === "refresh") await listing.refresh();
    else if (command === "give-worker") await putToWork(target.path);
    else if (command === "rename") requestRename(target);
    else if (command === "delete") await deletePaths([target.path]);
    else if (command === "copy") await copySelection([target]);
    else if (command === "paste") await pasteInto(target.kind === "folder" ? target.path : parentPath(target.path));
    else if (command === "duplicate") await duplicateSelection([target]);
    else if (command === "compress") await compressSelection([target]);
    else if (command === "new-folder-with-selection") await groupSelection([target]);
  }

  /** Paste Here is offered once something was copied here; ⌘V also pastes what Finder copied. */
  async function canPaste(): Promise<boolean> {
    return Boolean(fileClipboardRef.current);
  }

  function iconColumns(): number {
    const grid = contentRef.current?.querySelector<HTMLElement>(".fm-grid");
    if (!grid) return 1;
    return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
  }

  async function openRecents() {
    setQuery("");
    setRecentsOpen(true);
    setRecentSelection(null);
    if (fixtureMode) { setRecents(fixtureRecents()); return; }
    setRecents(null);
    try {
      setRecents((await api<{ recents: RecentItem[] }>("/api/recents")).recents);
    } catch (caught) {
      setRecents([]);
      onError(errorText(caught));
    }
  }

  function fixtureRecents(): RecentItem[] {
    const out: RecentItem[] = [];
    const walk = (placeRef: FileManagerPlace, where: string, entries: readonly TreeEntry[]) => {
      for (const entry of entries) {
        if (entry.children && !entry.nestedFolder) walk(placeRef, where, entry.children);
        if (entry.kind === "file" && entry.updatedAt) out.push({ place: placeRef, path: entry.path, name: entry.name, kind: "file", ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}), updatedAt: entry.updatedAt, where });
      }
    };
    for (const item of workFolders) walk({ kind: "work-folder", id: item.id }, item.name, fixture?.trees[item.id] ?? []);
    for (const folder of standard.folders) if (["desktop", "documents", "downloads"].includes(folder.id)) walk({ kind: "standard", id: folder.id }, folder.name, standard.fixtureTrees?.[folder.id] ?? []);
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 40);
  }

  function recentKey(item: RecentItem): string {
    return `${placeKey(item.place)}\0${item.path}`;
  }

  function recentRoot(item: RecentItem): string {
    if (item.place.kind === "work-folder") return workFolders.find((wf) => wf.id === item.place.id)?.workFolderRoot ?? "";
    return standard.folders.find((folder) => folder.id === item.place.id)?.root ?? "";
  }

  async function openRecent(item: RecentItem) {
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    try {
      const action = nativeOpenLabel({ name: item.name, path: item.path, kind: "file" }).office ? "open-native" : "open";
      if (item.place.kind === "work-folder") await window.workFoldDesktop?.workFolder.openPath(item.place.id, item.path, action);
      else await window.workFoldDesktop?.standardFolder?.openPath(item.place.id, item.path, action);
    } catch (caught) {
      onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    }
  }

  /** ⌘↑ from Recents: the file in its own folder, selected. */
  function showRecentInFolder(item: RecentItem) {
    const switchTo = item.place.kind === "work-folder" ? workFolders.find((wf) => wf.id === item.place.id) : undefined;
    navigate({ place: item.place, path: parentPath(item.path) }, "push", switchTo);
    window.setTimeout(() => select([item.path]), 0);
  }

  function handleRecentsKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = recents ?? [];
    const command = mac ? event.metaKey : event.ctrlKey;
    const index = recentSelection ? items.findIndex((item) => recentKey(item) === recentSelection) : -1;
    const chosen = index >= 0 ? items[index] : undefined;
    if (event.key === "ArrowDown" && !command || event.key === "ArrowUp" && !command) {
      event.preventDefault();
      if (!items.length) return;
      const next = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      setRecentSelection(recentKey(items[next]!));
      return;
    }
    if (chosen && (event.key === "Enter" || (command && event.key === "ArrowDown"))) { event.preventDefault(); void openRecent(chosen); return; }
    if (chosen && command && event.key === "ArrowUp") { event.preventDefault(); showRecentInFolder(chosen); return; }
  }

  /** The receipt's Undo: History puts back what the Worker's reply changed; ⇧⌘Z redoes it. */
  async function undoWorkerChanges() {
    if (!workFolder || !workerChanges) return;
    if (fixtureMode) { showToast({ text: "Restoring is disabled in the preview", tone: "info" }); return; }
    const entry = restorePointsUndo("the Worker’s changes", [{ workFolderId: workFolder.id, checkpointId: workerChanges.checkpointId }]);
    try {
      const redo = await entry.run();
      if (redo) redoStackRef.current = [...redoStackRef.current.slice(-49), redo];
      worker.done();
      await listing.refresh();
      showToast({ text: "Undid the Worker’s changes", tone: "success" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** The Worker that looks when search asks: the work-folder shown, else the one this window opened in. */
  const askWorkFolder = workFolder ?? activeWorkFolder;

  /** Ask in search: a Chat in the panel asking the Worker to find the file by what the person remembers. */
  function askToFind(text: string) {
    if (!askWorkFolder || !text) return;
    const everywhere = searchScope === "all";
    const message = everywhere
      ? `Find this for me: “${text}”. Look through the files here (names and contents, including subfolders) and tell me which files match, with their paths. If it might be in another work-folder, say which.`
      : `Find this for me: “${text}”. Look through the files ${location.path ? `in ${location.path}` : "here"} (names and contents, including subfolders) and tell me which files match, with their paths.`;
    setQuery("");
    if (askWorkFolder.id !== workFolder?.id) navigate({ place: { kind: "work-folder", id: askWorkFolder.id }, path: "" }, "push", askWorkFolder);
    setPanelOpen(true);
    withAi(() => {
      const id = Date.now();
      setPanelChat({ key: id, workFolderId: askWorkFolder.id, conversationId: null, activeId: null, title: `Find “${text.length > 30 ? `${text.slice(0, 28)}…` : text}”`, sendRequest: { id, text: message, paths: [] }, open: true });
    });
  }

  /** Open a search result: a folder here, a file in its default app. */
  async function openSearchResult(result: FileManagerSearchResult) {
    const target = workFolders.find((item) => item.id === result.workFolderId);
    if (!target) return;
    if (result.kind === "folder") {
      setQuery("");
      navigate({ place: { kind: "work-folder", id: target.id }, path: result.path });
      return;
    }
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const files = window.workFoldDesktop?.workFolder;
    if (!files) { showToast({ text: "Opening files is available in the Mac app", tone: "info" }); return; }
    try {
      await files.openPath(target.id, result.path, nativeOpenLabel({ name: result.name, path: result.path, kind: "file" }).office ? "open-native" : "open");
    } catch (caught) {
      onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    }
  }

  function handleSearchKey(event: KeyboardEvent<HTMLDivElement>) {
    const command = mac ? event.metaKey : event.ctrlKey;
    const keys = search.results.map((result) => result.key);
    const index = searchSelection ? keys.indexOf(searchSelection) : -1;
    const chosen = index >= 0 ? search.results[index] : undefined;
    if ((command && event.key === "ArrowDown") || event.key === "Enter") {
      event.preventDefault();
      if (chosen) void openSearchResult(chosen);
      // With nothing chosen, Return asks the Worker to find it.
      else if (event.key === "Enter" && askWorkFolder && query.trim()) askToFind(query.trim());
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!keys.length) return;
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      setSearchSelection(keys[next]!);
      window.requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>(`[data-fm-result="${cssEscape(keys[next]!)}"]`)?.scrollIntoView({ block: "nearest" }));
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); if (searchSelection) setSearchSelection(null); else setQuery(""); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (searchMode) { handleSearchKey(event); return; }
    if (recentsOpen) { handleRecentsKey(event); return; }
    const command = mac ? event.metaKey : event.ctrlKey;
    const current = focusPath ? order.indexOf(focusPath) : -1;
    const move = (step: number) => {
      event.preventDefault();
      if (!order.length) return;
      const next = current < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, current + step));
      const path = order[next]!;
      if (event.shiftKey) select(rangeSelection(order, anchorRef.current ?? focusPath ?? path, path), anchorRef.current ?? focusPath ?? path);
      else select([path]);
    };
    // Finder's Copy, Paste, Move Item Here (⌥⌘V), and Duplicate; codes, since ⌥ changes the letter.
    if (command && !event.shiftKey && event.code === "KeyC") { event.preventDefault(); void copySelection(); return; }
    if (command && !event.shiftKey && event.code === "KeyV") { event.preventDefault(); void pasteInto(location.path, event.altKey ? "move" : "copy"); return; }
    if (command && !event.shiftKey && event.code === "KeyD") { event.preventDefault(); void duplicateSelection(); return; }
    if (command && event.key === "ArrowDown") { event.preventDefault(); const entry = focusPath ? byPath.get(focusPath) : null; if (entry && selection.length === 1) void openEntry(entry); return; }
    if (command && event.key === "ArrowUp") { event.preventDefault(); goToEnclosingFolder(); return; }
    if (command && event.key === "[") { event.preventDefault(); goBack(); return; }
    if (command && event.key === "]") { event.preventDefault(); goForward(); return; }
    if (command && (event.key === "a" || event.key === "A")) { event.preventDefault(); select([...order], order[0] ?? null); return; }
    if (command && event.key === "Backspace") { event.preventDefault(); void deletePaths(selection.filter((path) => byPath.has(path))); return; }
    if (event.key === "ArrowDown") return move(view === "icons" ? iconColumns() : 1);
    if (event.key === "ArrowUp") return move(view === "icons" ? -iconColumns() : -1);
    if (event.key === "ArrowRight" && view === "icons") return move(1);
    if (event.key === "ArrowLeft" && view === "icons") return move(-1);
    if (event.key === " ") { event.preventDefault(); quickLook(focusPath); return; }
    if (event.key === "Enter" && selection.length === 1) { event.preventDefault(); requestRename(byPath.get(selection[0]!)); return; }
    if (event.key === "Escape") { if (selection.length) { event.preventDefault(); select([]); } return; }
    if (!command && !event.altKey && event.key.length === 1 && /\S/.test(event.key)) {
      const typed = typeSelectRef.current;
      typed.text += event.key;
      if (typed.timer !== null) window.clearTimeout(typed.timer);
      typed.timer = window.setTimeout(() => { typed.text = ""; typed.timer = null; }, typeSelectResetMs);
      const match = typeSelectMatch(visible, typed.text, focusPath);
      if (match) { event.preventDefault(); select([match]); }
    }
  }

  /** A work-folder's folder look: its color, and the icon chosen in Customize, if one was. */
  function folderLook(target: WorkFolderSummary): FolderLook {
    const identity = resolveIdentity(target, customizations);
    return { color: identity.color, symbol: customizations[target.id]?.iconName ? identity.Icon : null };
  }

  /** A nested work-folder's row is drawn as that work-folder's folder. */
  function nestedTint(entry: TreeEntry): FolderLook | undefined {
    const nested = nestedWorkFolder(entry);
    return nested ? folderLook(nested) : undefined;
  }

  const placeIdentity = workFolder ? resolveIdentity(workFolder, customizations) : null;
  const folderName = location.path ? location.path.split("/").pop() ?? placeName : placeName;
  const single = selected.size === 1 ? byPath.get([...selected][0]!) ?? null : null;
  // Search names and contents (the design's search): in the folder shown, or every work-folder.
  const searching = Boolean(query.trim());
  const searchMode = searching && (searchScope === "all" || place.kind === "work-folder");
  const search = useFileManagerSearch({ query, scope: searchScope, here: workFolder ? { workFolder, path: location.path } : null, workFolders, enabled: searchMode, fixture: fixture ? { trees: fixture.trees, fileContents: fixture.fileContents } : null });
  const searchChosen = searchMode && searchSelection ? search.results.find((result) => result.key === searchSelection) ?? null : null;
  const searchChosenWorkFolder = searchChosen ? workFolders.find((item) => item.id === searchChosen.workFolderId) ?? null : null;
  useEffect(() => { setSearchSelection(null); }, [query, searchScope]);
  const recentChosen = recentsOpen && recentSelection ? (recents ?? []).find((item) => recentKey(item) === recentSelection) ?? null : null;
  const crumbs = recentsOpen && !searchMode
    ? recentChosen
      ? fileManagerPathBar(recentRoot(recentChosen), parentPath(recentChosen.path), recentChosen.name).map((crumb) => ({ ...crumb, path: null }))
      : [{ label: "Recents", path: null, nativePath: "" }]
    : searchMode
    ? searchChosen && searchChosenWorkFolder
      ? fileManagerPathBar(searchChosenWorkFolder.workFolderRoot, parentPath(searchChosen.path), searchChosen.name).map((crumb) => ({ ...crumb, path: null }))
      : [{ label: searchScope === "here" ? `Searching “${folderName}”` : "Searching all work-folders", path: null, nativePath: "" }]
    : fileManagerPathBar(placeRoot, location.path, single?.name);
  const status = listing.status;
  const statusText = recentsOpen && !searchMode
    ? recents ? fileManagerStatusText(recents.length, recentChosen ? 1 : 0) : "Loading…"
    : searchMode
    ? search.status === "done" ? fileManagerStatusText(search.results.length, searchChosen ? 1 : 0) : "Searching…"
    : status === "ready" ? fileManagerStatusText(visible.length, selected.size) : "";
  const sidebarStandard = sidebarStandardFolders(standard.folders, workFolders);
  const columns: ReadonlyArray<{ key: FileManagerSortKey; label: string }> = [
    { key: "name", label: "Name" },
    { key: "modified", label: "Date Modified" },
    { key: "size", label: "Size" },
    { key: "kind", label: "Kind" },
  ];
  const isCurrent = (candidate: FileManagerPlace) => !recentsOpen && samePlace(candidate, place);
  const activity = useFileManagerActivity(workFolders, fixtureMode, panelChat?.open && panelChat.activeId ? chatActivityKey(panelChat.workFolderId, panelChat.activeId) : null);
  // Another work-folder's folder inside this one belongs to its own Worker.
  // A reply that ran in the background (an Automation, another window) settles here too.
  const runningHere = workFolder ? activity.folderStatuses[workFolder.id] === "running" : false;
  const worker = useWorkerChanges(workFolder, fixture, `${turnsSettled}:${runningHere}`);
  const workerChanges = runningHere ? null : worker.changes;
  const markedPaths = workerChanges?.paths ?? null;

  // Suggestions written from the folder, when AI is connected; the plain ones cover a selection and the wait.
  const folderSuggestions = useFolderSuggestions(workFolder?.id ?? null, location.path, Boolean(workFolder) && !fixtureMode && Boolean(agent?.configured) && panelOpen);

  const references = [
    ...visible.filter((entry) => selected.has(entry.path) && !entry.nestedFolder),
    ...attachedPaths.filter((path) => !selected.has(path)).map((path) => byPath.get(path) ?? { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "file" as const }),
  ];
  const composerPlaceholder = references.length === 1
    ? `Work on this ${references[0]!.kind === "folder" ? "folder" : "file"}`
    : references.length > 1 ? `Work on these ${references.length} items` : `Work in ${folderName}`;
  const chatWorkFolder = panelChat ? workFolders.find((item) => item.id === panelChat.workFolderId) ?? null : null;
  const panelChatId = panelChat ? panelChat.activeId ?? panelChat.conversationId : null;
  const chatKey = (conversationId: string) => panelChat ? chatActivityKey(panelChat.workFolderId, conversationId) : "";

  return <div className="fm-shell" data-view={view} ref={shellRef} style={{ [sidebarWidthSpec.property]: `${sidebarWidth}px`, [panelWidthSpec.property]: `${panelWidth}px` } as CSSProperties}>
    <nav className="fm-sidebar" aria-label="Sidebar">
      <div className="fm-sidebar-inset" aria-hidden="true" />
      <div className="fm-sidebar-scroll">
        <ul className="fm-sidebar-list fm-sidebar-top" aria-label="Recents">
          <li><button type="button" className={`fm-sidebar-item${recentsOpen ? " is-current" : ""}`} aria-current={recentsOpen ? "page" : undefined} onClick={() => void openRecents()}>
            <span className="fm-sidebar-icon"><RecentsGlyph /></span>
            <span className="fm-sidebar-name">Recents</span>
          </button></li>
        </ul>
        <div className="fm-sidebar-heading"><span id="fm-standard-heading">Standard Folders</span><button type="button" className="fm-heading-add" aria-label="Add a Folder to the Sidebar" title="Add a Folder" onClick={() => void addStandardFolder()}><Add16Regular /></button></div>
        {sidebarStandard.length ? <>
          <ul className="fm-sidebar-list" aria-labelledby="fm-standard-heading">
            {sidebarStandard.map((folder) => {
              const current = isCurrent({ kind: "standard", id: folder.id });
              return <li key={folder.id}>
                <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}${sidebarDrop === placeKey({ kind: "standard", id: folder.id }) ? " is-drop-target" : ""}`} aria-current={current ? "page" : undefined} onClick={() => navigate({ place: { kind: "standard", id: folder.id }, path: "" })} onContextMenu={(event) => openStandardFolderMenu(folder, event)}
                  onDragOver={(event) => sidebarDragOver({ kind: "standard", id: folder.id }, event)}
                  onDragLeave={() => setSidebarDrop(null)}
                  onDrop={(event) => void sidebarDropInto({ kind: "standard", id: folder.id }, folder.name, event)}>
                  <span className="fm-sidebar-icon"><StandardFolderGlyph id={folder.id} /></span>
                  <span className="fm-sidebar-name">{folder.name}</span>
                </button>
              </li>;
            })}
          </ul>
        </> : null}
        <div className="fm-sidebar-heading"><span id="fm-work-folders-heading">work-folders</span><button type="button" className="fm-heading-add" aria-label="Add a work-folder" title="Add a work-folder" aria-haspopup="menu" onClick={openAddWorkFolderMenu}><Add16Regular /></button></div>
        <ul className="fm-sidebar-list" aria-labelledby="fm-work-folders-heading">
          {sidebarWorkFolderRows(workFolders, sidebarOpen).map(({ workFolder: item, depth, inside, open }) => {
            const look = folderLook(item);
            const current = isCurrent({ kind: "work-folder", id: item.id });
            // A closed parent shows its sub work-folders' activity on its own row.
            const status = inside.length && !open ? combineActivityStatuses([activity.folderStatuses[item.id], ...inside.map((child) => activity.folderStatuses[child.id])]) ?? undefined : activity.folderStatuses[item.id];
            return <li key={item.id} className="fm-sidebar-node" style={{ "--fm-depth": depth } as CSSProperties}>
              {inside.length ? <button type="button" className={`fm-sidebar-caret${open ? " is-open" : ""}`} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} work-folders inside ${item.name}`} title={open ? "Hide work-folders inside" : "Show work-folders inside"} onClick={() => toggleSidebarFolder(item.id)}>
                <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3.5 3-3.5 3z" fill="currentColor" /></svg>
              </button> : null}
              <button type="button" className={`fm-sidebar-item${current ? " is-current" : ""}${sidebarDrop === placeKey({ kind: "work-folder", id: item.id }) ? " is-drop-target" : ""}`} aria-current={current ? "page" : undefined} onClick={() => navigate({ place: { kind: "work-folder", id: item.id }, path: "" })} onContextMenu={(event) => void openActionMenu(item, event)}
                onKeyDown={(event) => {
                  if (!inside.length) return;
                  if (event.key === "ArrowRight" && !open) { event.preventDefault(); toggleSidebarFolder(item.id); }
                  if (event.key === "ArrowLeft" && open) { event.preventDefault(); toggleSidebarFolder(item.id); }
                }}
                onDragOver={(event) => sidebarDragOver({ kind: "work-folder", id: item.id }, event)}
                onDragLeave={() => setSidebarDrop(null)}
                onDrop={(event) => void sidebarDropInto({ kind: "work-folder", id: item.id }, item.name, event)}>
                <span className="fm-sidebar-icon"><TintedFolder color={look.color} symbol={look.symbol} /></span>
                <span className="fm-sidebar-name">{item.name}</span>
                <ActivityDot status={status} />
              </button>
            </li>;
          })}
        </ul>
      </div>
    </nav>

    <PaneResizer spec={sidebarWidthSpec} side="left" width={sidebarWidth} label="Resize the sidebar" shellRef={shellRef} otherPaneWidth={panelOpen ? panelWidth : 0} onCommit={setSidebarWidth} />
    <section className="fm-main" aria-label={folderName}>
      <header className="fm-toolbar">
        <div className="fm-capsule">
          <button type="button" className="fm-tool" onClick={goBack} disabled={!back.length} aria-label="Back" title="Back"><ChevronLeft size={16} /></button>
          <button type="button" className="fm-tool" onClick={goForward} disabled={!forward.length} aria-label="Forward" title="Forward"><ChevronRight size={16} /></button>
        </div>
        <h1 className="fm-title">
          {recentsOpen ? <span className="fm-title-glyph" aria-hidden="true"><RecentsGlyph /></span> : !location.path && workFolder ? <TintedFolder {...folderLook(workFolder)} /> : <span className="fm-ic fm-ic-folder" aria-hidden="true" />}
          <span className="fm-title-text">{recentsOpen ? "Recents" : folderName}</span>
        </h1>
        <div className="fm-toolbar-space" />
        <div className="fm-capsule" role="group" aria-label="View">
          <button type="button" className={`fm-tool${view === "icons" ? " is-on" : ""}`} aria-pressed={view === "icons"} aria-label="Icons" title="Icons" onClick={() => setView("icons")}><Grid20Regular /></button>
          <button type="button" className={`fm-tool${view === "list" ? " is-on" : ""}`} aria-pressed={view === "list"} aria-label="List" title="List" onClick={() => setView("list")}><TextBulletListLtr20Regular /></button>
        </div>
        {workFolder && !location.path && !query.trim() && !recentsOpen ? <button type="button" className="fm-tool fm-tool-wide" title="Organize" onClick={() => { setPanelOpen(true); startChat("Organize this folder.", []); }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" /><path d="M2.5 9.5v3.25h11V9.5" /><path d="M4.5 6.5h7M5.75 3.75h4.5" /></svg>
          <span className="fm-tool-wide-t">Organize</span>
        </button> : null}
        <div className="fm-capsule">
          <button type="button" className="fm-tool" aria-label="Action" title="Action" aria-haspopup="menu" onClick={(event) => void openActionMenu(workFolder, event)}><MoreHorizontal20Regular /></button>
        </div>
        <div className="fm-capsule">
          <button type="button" className={`fm-tool${panelOpen ? " is-on" : ""}`} aria-pressed={panelOpen} aria-label="Show or hide the panel" title={panelOpen ? "Hide Panel" : "Show Panel"} onClick={() => setPanelOpen(!panelOpen)}><PanelRight20Regular /></button>
        </div>
        <label className="fm-search">
          <Search size={14} />
          <input ref={searchFieldRef} type="search" value={query} placeholder="Search names and contents" aria-label={`Search ${folderName}`} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); contentRef.current?.focus(); } }} />
          {query ? <button type="button" className="fm-search-clear" aria-label="Clear search" onClick={() => { setQuery(""); contentRef.current?.focus(); }}><X size={12} /></button> : null}
        </label>
      </header>
      {searching ? <div className="fm-scope" role="group" aria-label="Search">
        <span>Search:</span>
        <button type="button" className={`fm-pill${searchScope === "all" ? " is-on" : ""}`} aria-pressed={searchScope === "all"} onClick={() => setSearchScope("all")}>All work-folders</button>
        <button type="button" className={`fm-pill${searchScope === "here" ? " is-on" : ""}`} aria-pressed={searchScope === "here"} onClick={() => setSearchScope("here")} title={folderName}>“{folderName}”</button>
      </div> : null}

      <div
        className={`fm-content${searchMode ? " is-search" : ""}${dropTarget === location.path ? " is-drop-target" : ""}`}
        ref={contentRef}
        onDragOver={dragOverList}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
        onDrop={(event) => void dropOnList(event)}
        tabIndex={0}
        role="grid"
        aria-label={`${folderName} contents`}
        aria-multiselectable="true"
        aria-activedescendant={focusPath ? rowDomId(focusPath) : undefined}
        onKeyDown={handleKeyDown}
        onClick={(event) => { if (!(event.target as HTMLElement).closest("[data-fm-path]")) select([]); }}
        onContextMenu={(event) => { if (!(event.target as HTMLElement).closest("[data-fm-path]")) void openContextMenu(null, event); }}
      >
        {recentsOpen && !searchMode ? <>
          <div className="fm-list-head" role="row">
            <span role="columnheader" className="fm-col fm-col-name">Name</span>
            <span role="columnheader" className="fm-col fm-col-match">Date Modified</span>
            <span role="columnheader" className="fm-col fm-col-where">Where</span>
          </div>
          {recents === null ? <p className="fm-empty">Loading…</p> : !recents.length ? <p className="fm-empty">Nothing has changed in the last 30 days.</p> : null}
          <div className="fm-rows" role="rowgroup">
            {(recents ?? []).map((item, index) => {
              const key = recentKey(item);
              const entry: TreeEntry = { name: item.name, path: item.path, kind: "file", ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}) };
              return <div
                key={key}
                role="row"
                aria-selected={recentSelection === key}
                className={`fm-row${index % 2 ? " is-odd" : ""}${recentSelection === key ? " is-selected" : ""}`}
                title={`${item.where} › ${item.path}`}
                onClick={(event) => { event.stopPropagation(); contentRef.current?.focus({ preventScroll: true }); setRecentSelection(key); }}
                onDoubleClick={() => void openRecent(item)}
              >
                <span role="gridcell" className="fm-cell fm-col-name">
                  <span className="fm-row-icon"><EntryIcon entry={entry} /></span>
                  <span className="fm-row-name">{item.name}</span>
                </span>
                <span role="gridcell" className="fm-cell fm-col-match">{formatFileManagerDate(item.updatedAt)}</span>
                <span role="gridcell" className="fm-cell fm-col-where" title={item.where}>{item.where}</span>
              </div>;
            })}
          </div>
        </> : searchMode ? <>
          <div className="fm-list-head" role="row">
            <span role="columnheader" className="fm-col fm-col-name">Name</span>
            <span role="columnheader" className="fm-col fm-col-match">Match</span>
            <span role="columnheader" className="fm-col fm-col-where">work-folder</span>
          </div>
          {search.status === "done" && !search.results.length ? <p className="fm-empty">No names or text match “{query.trim()}”</p> : null}
          <div className="fm-rows" role="rowgroup">
            {search.results.map((result, index) => {
              const entry: TreeEntry = { name: result.name, path: result.path, kind: result.kind, ...(result.sizeBytes !== undefined ? { sizeBytes: result.sizeBytes } : {}) };
              const where = workFolders.find((item) => item.id === result.workFolderId);
              return <div
                key={result.key}
                role="row"
                aria-selected={searchSelection === result.key}
                data-fm-result={result.key}
                className={`fm-row${index % 2 ? " is-odd" : ""}${searchSelection === result.key ? " is-selected" : ""}`}
                onClick={(event) => { event.stopPropagation(); contentRef.current?.focus({ preventScroll: true }); setSearchSelection(result.key); }}
                onDoubleClick={() => void openSearchResult(result)}
              >
                <span role="gridcell" className="fm-cell fm-col-name">
                  <span className="fm-row-icon"><EntryIcon entry={entry} /></span>
                  <span className="fm-row-name" title={result.path}>{result.name}</span>
                </span>
                <span role="gridcell" className={`fm-cell fm-col-match${result.match.kind === "name" ? " is-name" : ""}`}>
                  {result.match.kind === "name" ? "Name" : <>{result.match.pre}{result.match.hit ? <mark>{result.match.hit}</mark> : null}{result.match.post}</>}
                </span>
                <span role="gridcell" className="fm-cell fm-col-where" title={where?.name}>{where?.name ?? ""}</span>
              </div>;
            })}
          </div>
          {/* Ask in search: the Worker looks for it by meaning, not only by name or text. */}
          {search.status === "done" && askWorkFolder ? <button type="button" className="fm-ask-row" onClick={() => askToFind(query.trim())}>
            <span className="fm-ask-icon" aria-hidden="true"><Sparkle16Regular /></span>
            <span className="fm-ask-text">Ask {askWorkFolder.name === folderName ? "the Worker" : `the ${askWorkFolder.name} Worker`} to find “{query.trim()}”</span>
            <span className="fm-ask-hint">Return</span>
          </button> : null}
        </> : <>
        {view === "list" ? <div className="fm-list-head" role="row">
          {columns.map((column) => <button
            key={column.key}
            type="button"
            role="columnheader"
            className={`fm-col fm-col-${column.key}${sort.key === column.key ? " is-sorted" : ""}`}
            aria-sort={sort.key === column.key ? (sort.ascending ? "ascending" : "descending") : "none"}
            onClick={() => setSort(nextFileManagerSort(sort, column.key))}
          >
            <span>{column.label}</span>
            {sort.key === column.key ? (sort.ascending ? <ChevronUp16Regular className="fm-sort-arrow" /> : <ChevronDown16Regular className="fm-sort-arrow" />) : null}
          </button>)}
        </div> : null}

        {status === "loading" && !visible.length ? <p className="fm-empty">Loading…</p> : null}
        {status === "error" ? <div className="fm-empty">
          <span className="fm-empty-text">{listing.error ?? "Couldn’t load this folder."}</span>
          <button type="button" className="fm-text-button" onClick={() => void listing.refresh()}>Try Again</button>
        </div> : null}
        {status === "ready" && !visible.length ? <p className="fm-empty">{query.trim() ? `No items match “${query.trim()}”` : "This folder is empty."}</p> : null}

        {view === "list" ? <div className="fm-rows" role="rowgroup">
          {visible.map((entry, index) => <div
            key={entry.path}
            id={rowDomId(entry.path)}
            role="row"
            aria-selected={selected.has(entry.path)}
            data-fm-path={entry.path}
            className={`fm-row${index % 2 ? " is-odd" : ""}${selected.has(entry.path) ? " is-selected" : ""}${entry.ignored ? " is-ignored" : ""}${dropTarget === entry.path && entry.path !== location.path ? " is-drop-target" : ""}`}
            draggable={entry.kind === "file"}
            onClick={(event) => clickEntry(entry, event)}
            onDoubleClick={() => void openEntry(entry)}
            onContextMenu={(event) => void openContextMenu(entry, event)}
            onDragStart={(event) => startDrag(entry, event)}
          >
            <span role="gridcell" className="fm-cell fm-col-name">
              <span className="fm-row-icon"><EntryIcon entry={entry} tint={nestedTint(entry)} /></span>
              <span className="fm-row-name" title={entry.name}>{entry.name}</span>
              {markedPaths && isMarkedPath(entry.path, markedPaths) ? <span className="fm-changed-dot" title="Changed by the Worker" aria-label="Changed by the Worker" role="img" /> : null}
            </span>
            <span role="gridcell" className="fm-cell fm-col-modified">{formatFileManagerDate(entry.updatedAt)}</span>
            <span role="gridcell" className="fm-cell fm-col-size">{sizeText(entry)}</span>
            <span role="gridcell" className="fm-cell fm-col-kind" title={kindLabel(entry)}>{kindLabel(entry)}</span>
          </div>)}
        </div> : <div className="fm-grid" role="rowgroup">
          {visible.map((entry) => <div
            key={entry.path}
            id={rowDomId(entry.path)}
            role="gridcell"
            aria-selected={selected.has(entry.path)}
            data-fm-path={entry.path}
            className={`fm-tile${selected.has(entry.path) ? " is-selected" : ""}${entry.ignored ? " is-ignored" : ""}${dropTarget === entry.path && entry.path !== location.path ? " is-drop-target" : ""}`}
            draggable={entry.kind === "file"}
            onClick={(event) => clickEntry(entry, event)}
            onDoubleClick={() => void openEntry(entry)}
            onContextMenu={(event) => void openContextMenu(entry, event)}
            onDragStart={(event) => startDrag(entry, event)}
          >
            <span className="fm-tile-icon"><EntryIcon entry={entry} tint={nestedTint(entry)} /></span>
            <span className="fm-tile-name" title={entry.name}>{markedPaths && isMarkedPath(entry.path, markedPaths) ? <span className="fm-changed-dot" title="Changed by the Worker" aria-label="Changed by the Worker" role="img" /> : null}{middleTruncate(entry.name)}</span>
          </div>)}
        </div>}
        </>}
        {listing.truncated ? <p className="fm-note">Some items are not shown. This folder holds more than work-fold lists at once.</p> : null}
      </div>

      {/* Finder's path bar: click an item to copy its path, double-click a folder to open it; ⇧⌘G goes anywhere by path. */}
      <footer className="fm-pathbar">
        <button type="button" className="fm-goto-button" title="Go to Folder… (⇧⌘G)" aria-label="Go to Folder" onClick={() => setGoToOpen(true)}><FolderArrowRight16Regular /></button>
        <nav className="fm-crumbs" aria-label="Path">
          {collapseCrumbs(crumbs).map((crumb, index, shown) => <span className={`fm-crumb-wrap${index === shown.length - 1 ? " is-last" : ""}`} key={`${index}:${crumb.label}`}>
            {index ? <ChevronRight size={10} className="fm-crumb-sep" aria-hidden="true" /> : null}
            <button
              type="button"
              className="fm-crumb"
              disabled={!crumb.nativePath}
              title={crumb.nativePath ? `${crumb.hidden ? crumb.hidden.join(" › ") : crumb.nativePath}\nClick to copy the path${crumb.path !== null && !searchMode ? " · Double-click to open" : ""}` : undefined}
              onClick={() => void copyNativePath(crumb.nativePath)}
              onDoubleClick={() => { if (crumb.path !== null && !searchMode) navigate({ place, path: crumb.path }); }}
            >{crumb.label}</button>
          </span>)}
        </nav>
        <span className="fm-status">{statusText}</span>
      </footer>
    </section>

    {panelOpen ? <PaneResizer spec={panelWidthSpec} side="right" width={panelWidth} label="Resize the panel" shellRef={shellRef} otherPaneWidth={sidebarWidth} onCommit={setPanelWidth} /> : null}
    {panelOpen ? <FileManagerPanel
      place={place}
      workFolder={workFolder}
      placeName={placeName}
      placeRoot={placeRoot}
      folderPath={location.path}
      folderName={folderName}
      folderColor={!location.path && placeIdentity ? placeIdentity.color : null}
      folderSymbol={!location.path && workFolder ? folderLook(workFolder).symbol : null}
      receipt={workerChanges && workFolder && !searchMode && !recentsOpen && !selection.length ? <WorkerReceipt
        changes={workerChanges}
        onShow={(path) => { const folder = parentPath(path); if (folder !== location.path) navigate({ place: { kind: "work-folder", id: workFolder.id }, path: folder }); window.setTimeout(() => select([path]), folder !== location.path ? 300 : 0); }}
        onUndo={() => void undoWorkerChanges()}
        onDone={worker.done}
      /> : null}
      itemCount={visible.length}
      selection={visible.filter((entry) => selected.has(entry.path))}
      automations={workFolder ? folderAutomations.byWorkFolder[workFolder.id] ?? [] : []}
      fixture={fixture}
      chat={panelChat && chatWorkFolder ? {
        open: panelChat.open,
        title: panelChat.title,
        onBack: () => setPanelChat({ ...panelChat, open: false }),
        content: <ChatPanel
          key={panelChat.key}
          surfaceTabId={`file-manager:${chatWorkFolder.id}`}
          workFolder={chatWorkFolder}
          workFolderCustomizations={customizations}
          // A new Chat hands its id back the way a Chat tab does, so ChatPanel
          // keeps it instead of starting over. The preview's sample Chats are
          // looked up by this id, so there a new one stays untargeted.
          targetConversationId={fixtureMode ? panelChat.conversationId : panelChat.activeId ?? panelChat.conversationId}
          contextPathRequest={null}
          sendRequest={panelChat.sendRequest}
          draftRequest={panelChat.draftRequest ?? null}
          variant="panel"
          fixtureMode={fixtureMode}
          fixtureConversations={panelChat.conversationId ? fixture?.conversations[chatWorkFolder.id] : undefined}
          fixtureTreeEntries={fixture?.trees[chatWorkFolder.id]}
          onOpenWorkFolderFile={showChatFile}
          onConversationActivated={(conversation: ConversationSummary | null) => {
            if (!conversation) return;
            setPanelChat((current) => current && current.key === panelChat.key
              ? { ...current, activeId: conversation.id, title: chatTitleOrNull(conversation.title) ?? current.title }
              : current);
          }}
          onRunningChange={(conversationId, running) => activity.setRunning(chatKey(conversationId), running)}
          onSettled={(conversationId, needsAttention) => { activity.setAttention(chatKey(conversationId), needsAttention && !(panelChat.open && conversationId === panelChatId)); setTurnsSettled((value) => value + 1); }}
          onViewed={(conversationId) => activity.setAttention(chatKey(conversationId), false)}
          onAgentFinished={() => listing.refresh()}
        />,
      } : null}
      searchItem={recentChosen && !searchMode ? {
        apiBase: recentChosen.place.kind === "work-folder" ? `/api/work-folders/${encodeURIComponent(recentChosen.place.id)}` : `/api/standard-folders/${encodeURIComponent(recentChosen.place.id)}`,
        entry: { name: recentChosen.name, path: recentChosen.path, kind: "file", ...(recentChosen.sizeBytes !== undefined ? { sizeBytes: recentChosen.sizeBytes } : {}), updatedAt: recentChosen.updatedAt },
        where: [recentChosen.where, ...recentChosen.path.split("/").slice(0, -1)].join(" › "),
      } : searchChosen && searchChosenWorkFolder ? {
        apiBase: `/api/work-folders/${encodeURIComponent(searchChosenWorkFolder.id)}`,
        entry: { name: searchChosen.name, path: searchChosen.path, kind: searchChosen.kind, ...(searchChosen.sizeBytes !== undefined ? { sizeBytes: searchChosen.sizeBytes } : {}), ...(searchChosen.updatedAt ? { updatedAt: searchChosen.updatedAt } : {}) },
        where: [searchChosenWorkFolder.name, ...searchChosen.path.split("/").slice(0, -1)].join(" › "),
      } : null}
      composer={workFolder ? ({ showSuggestions }) => <FileManagerComposer
        placeholder={composerPlaceholder}
        chips={references}
        suggestions={showSuggestions ? (() => {
          const automationsOn = (folderAutomations.byWorkFolder[workFolder.id] ?? []).some((automation) => automation.state === "on" || automation.state === "running");
          if (!references.length && folderSuggestions.length) return folderSuggestions.slice(0, automationsOn ? 2 : 4);
          return fileManagerSuggestions({ selection: references, inSubfolder: Boolean(location.path), automationsOn });
        })() : []}
        modelRow={<WorkerModelRow workFolder={workFolder} fixtureMode={fixtureMode} revision={agent?.configured ? 1 : 0} onOpenModelSettings={() => onOpenSettings("ai-models")} />}
        onRemoveChip={(path) => { setSelection((current) => current.filter((item) => item !== path)); setAttachedPaths((current) => current.filter((item) => item !== path)); }}
        dropActive={composerDrop}
        onDragOverBox={(event) => { if (!workFolder || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setComposerDrop(true); }}
        onDragLeaveBox={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerDrop(false); }}
        onDropBox={(event) => void composerDropFiles(event)}
        onSend={(text) => startChat(text, references)}
      /> : null}
      onPutToWork={() => void putToWork(location.path)}
      chatStatuses={activity.chatStatuses}
      historyRefreshKey={listing.changeCount}
      onOpenChat={openChat}
      onRestored={() => void listing.refresh()}
      onError={onError}
    /> : null}

    {actionMenu ? <>
      <div className="fm-menu-back" onClick={() => setActionMenu(null)} onContextMenu={(event) => { event.preventDefault(); setActionMenu(null); }} />
      <div className="fm-menu" role="menu" style={{ left: actionMenu.x, top: actionMenu.y }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setActionMenu(null); } }}>
        {actionMenu.target ? <>
          <button type="button" className="fm-menu-i" role="menuitem" autoFocus onClick={() => { const target = actionMenu.target; setActionMenu(null); runActionCommand("customize", target); }}>Customize work-folder</button>
          <button type="button" className="fm-menu-i" role="menuitem" onClick={() => { const target = actionMenu.target; setActionMenu(null); runActionCommand("set-up", target); }}>Set Up for Me</button>
          <button type="button" className="fm-menu-i" role="menuitem" onClick={() => { const target = actionMenu.target; setActionMenu(null); runActionCommand("look", target); }}>Just the Look</button>
          <button type="button" className="fm-menu-i" role="menuitem" onClick={() => { const target = actionMenu.target; setActionMenu(null); runActionCommand("skills", target); }}>Skills &amp; Extensions…</button>
          <div className="fm-menu-sep" />
          <button type="button" className="fm-menu-i" role="menuitem" onClick={() => { const target = actionMenu.target; setActionMenu(null); runActionCommand("remove-work-folder", target); }}>Remove work-folder…</button>
        </> : null}
        <button type="button" className="fm-menu-i" role="menuitem" autoFocus={!actionMenu.target} onClick={() => { setActionMenu(null); runActionCommand("settings", null); }}>Settings…</button>
      </div>
    </> : null}
    {customizing && customizingWorkFolder ? <WorkFolderAppearanceModal
      key={customizingWorkFolder.id}
      workFolder={customizingWorkFolder}
      initialSection={customizing.section}
      identity={resolveIdentity(customizingWorkFolder, customizations)}
      customization={customizations[customizingWorkFolder.id]}
      canUndo={workFolderCustomizations.canUndo(customizingWorkFolder.id)}
      onRenameWorkFolder={renameWorkFolder}
      onCustomizeWorkFolder={workFolderCustomizations.customize}
      onReplaceWorkFolder={workFolderCustomizations.replace}
      onUndoWorkFolder={workFolderCustomizations.undo}
      onResetWorkFolder={workFolderCustomizations.reset}
      // The file manager draws no banner: its work-folders are folders in their color, with their icon.
      bannerControls={false}
      preview={<div className="fm-customize-preview"><TintedFolder {...folderLook(customizingWorkFolder)} /><span title={customizingWorkFolder.name}>{customizingWorkFolder.name}</span></div>}
      onOpenWorkerSettings={(section, returnSection) => {
        const target = customizingWorkFolder;
        setCustomizing(null);
        onOpenSettings("ai-models", "work-folder", section === "model", target.id, section === "instructions", () => setCustomizing({ workFolderId: target.id, section: returnSection }));
      }}
      onClose={() => setCustomizing(null)}
    /> : null}
    {goToOpen ? <GoToFolderSheet
      initialPath={`${(location.path ? workFolderEntryNativePath(placeRoot, location.path) : placeRoot).replace(/[\\/]+$/, "")}/`}
      currentFolder={location.path ? workFolderEntryNativePath(placeRoot, location.path) : placeRoot}
      lookup={lookupPath}
      onGo={goTo}
      onClose={() => { setGoToOpen(false); window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true })); }}
    /> : null}
    {quickMenu ? <>
      <div className="fm-menu-back" onClick={() => { quickMenu.run(null); setQuickMenu(null); }} onContextMenu={(event) => { event.preventDefault(); setQuickMenu(null); }} />
      <div className="fm-menu" role="menu" style={{ left: quickMenu.x, top: quickMenu.y }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setQuickMenu(null); } }}>
        {quickMenu.items.map((item, index) => <button key={item.command} type="button" className="fm-menu-i" role="menuitem" autoFocus={index === 0} onClick={() => { const { run } = quickMenu; setQuickMenu(null); run(item.command); }}>{item.label}</button>)}
      </div>
    </> : null}
    {skillsFor ? <SkillsExtensionsModal workFolder={skillsFor} status={agent} initialView="installed" fixtureMode={fixtureMode} onError={onError} onClose={() => setSkillsFor(null)} /> : null}
    {contextMenu ? <FileContextMenu
      state={contextMenu}
      onSelect={(path) => select([path])}
      onOpenLocal={(path, action) => { const entry = byPath.get(path); if (action === "open" && entry) return openEntry(entry); return openLocal(path, action); }}
      canOpenWith={!fixtureMode && Boolean(bridge?.openWith)}
      onAddToChatContext={() => undefined}
      onCopyPath={(path) => copyPaths([path])}
      onCopyPaths={(paths) => copyPaths(paths)}
      onShowVersionHistory={(path) => { const entry = byPath.get(path); if (entry && workFolder) setVersionHistory(entry); }}
      onRename={(path) => requestRename(byPath.get(path))}
      onNewFolder={(parent) => requestNewFolder(parent)}
      onRefresh={() => void listing.refresh()}
      onGiveWorker={fixtureMode ? undefined : (path) => void putToWork(path)}
      onDelete={(path) => deletePaths([path])}
      onDeleteSelection={(paths) => deletePaths(paths)}
      canDelete={!contextMenu.entry.nestedFolder && Boolean(contextMenu.entry.path) && contextMenu.entry.path !== location.path}
      onClose={() => setContextMenu(null)}
    /> : null}
    {renaming ? <TextInputModal title="Rename" label="Name" initialValue={renaming.name} confirmLabel="Rename" onSubmit={(name) => renameEntry(renaming, name)} onClose={() => setRenaming(null)} /> : null}
    {newFolderTarget ? <NewFolderModal target={newFolderTarget} fixtureMode={fixtureMode} onCreated={(folder) => { setNewFolderTarget(null); void listing.refresh().then(() => select([folder.path])); }} onClose={() => setNewFolderTarget(null)} /> : null}
    {newStandardFolderParent !== null ? <TextInputModal title="New Folder" label="Name" initialValue="untitled folder" confirmLabel="Create" onSubmit={(name) => createStandardFolder(newStandardFolderParent, name)} onClose={() => setNewStandardFolderParent(null)} /> : null}
    {versionHistory && workFolder ? <FileVersionHistoryModal workFolder={workFolder} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void listing.refresh()} /> : null}
  </div>;
}

/**
 * The Worker's receipt at the top of Info: how many items its last reply
 * changed and how, the first few by name (each shows itself in the list), and
 * Undo or Done.
 */
function WorkerReceipt({ changes, onShow, onUndo, onDone }: {
  changes: NonNullable<ReturnType<typeof useWorkerChanges>["changes"]>;
  onShow: (path: string) => void;
  onUndo: () => void;
  onDone: () => void;
}) {
  const rows = [
    ...changes.added.map((path) => ({ path, verb: "Added" })),
    ...changes.moved.map((move) => ({ path: move.to, verb: "Moved" })),
    ...changes.changed.map((path) => ({ path, verb: "Changed" })),
  ];
  const total = rows.length;
  return <section className="fm-receipt" aria-label="What the Worker changed">
    <div className="fm-receipt-head">
      <span className="fm-dot is-done" aria-hidden="true" />
      <span className="fm-receipt-title">The Worker changed {total === 1 ? "1 item" : `${total} items`}</span>
      <span className="fm-receipt-time">{historyTimeLabel(changes.createdAt)}</span>
    </div>
    <div className="fm-receipt-sum">{workerChangesSummary(changes)}</div>
    <div className="fm-receipt-list">
      {rows.slice(0, 4).map((row) => <button type="button" key={`${row.verb}:${row.path}`} className="fm-receipt-row" title={row.path} onClick={() => onShow(row.path)}>
        <span className="fm-receipt-name">{row.path.slice(row.path.lastIndexOf("/") + 1)}</span>
        <span className="fm-receipt-verb">{row.verb}</span>
      </button>)}
      {total > 4 ? <div className="fm-receipt-more">and {total - 4} more, marked in the list</div> : null}
    </div>
    <div className="fm-receipt-actions">
      <button type="button" className="fm-btn is-small" onClick={onUndo}>Undo</button>
      <button type="button" className="fm-btn is-small" onClick={onDone}>Done</button>
    </div>
  </section>;
}

/** A file in Recents: where it lives, and when it last changed. */
interface RecentItem { place: FileManagerPlace; path: string; name: string; kind: "file"; sizeBytes?: number; updatedAt: string; where: string }

/** Recents' clock, drawn as the sidebar's other line glyphs are. */
function RecentsGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.5 1.5" /></svg>;
}

/** One file change ⌘Z can undo: running it undoes the change and returns the entry that redoes it. */
interface FileUndo { label: string; run: () => Promise<FileUndo | null> }

/** Titles a Chat carries before it has its own: the server's seed, the renderer's label, and an old default. */
const placeholderChatTitles = new Set([untitledChatLabel, "New Chat", "work-fold chat"].map((title) => title.toLocaleLowerCase()));

/** A Chat's own title once it has one; until then the panel keeps the person's words. */
function chatTitleOrNull(title: string | null | undefined): string | null {
  const trimmed = title?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed && !placeholderChatTitles.has(trimmed.toLocaleLowerCase()) ? trimmed : null;
}

function placeFileBridge(place: FileManagerPlace): PlaceFileBridge | null {
  const desktop = window.workFoldDesktop;
  if (place.kind === "work-folder" && desktop?.workFolder) {
    const files = desktop.workFolder;
    const openWith = files.openPathWith;
    return {
      open: (path, action) => path ? files.openPath(place.id, path, action) : files.revealFolder(place.id),
      openWith: openWith ? (path) => openWith(place.id, path) : null,
      drag: (path) => files.startDrag(place.id, path),
      preview: (path) => files.previewFile(place.id, path),
    };
  }
  if (place.kind === "standard" && desktop?.standardFolder) {
    const files = desktop.standardFolder;
    return {
      open: (path, action) => files.openPath(place.id, path, action),
      openWith: (path) => files.openPathWith(place.id, path),
      drag: (path) => files.startDrag(place.id, path),
      preview: (path) => files.previewFile(place.id, path),
    };
  }
  return null;
}

function sizeText(entry: TreeEntry): string {
  if (entry.kind === "folder") return "--";
  return typeof entry.sizeBytes === "number" ? formatBytes(entry.sizeBytes) : "--";
}

type FolderLook = { color: string; symbol: WorkFolderIconOption["Icon"] | null };

function EntryIcon({ entry, tint }: { entry: TreeEntry; tint?: FolderLook }) {
  if (entry.kind === "folder" && tint) return <TintedFolder color={tint.color} symbol={tint.symbol} />;
  const icon = fileManagerIcon(entry);
  return <span className={icon.className} data-label={icon.label} aria-hidden="true" />;
}

/** The design's activity dot: pulsing while a Worker runs, green for a reply nobody has read. */
function ActivityDot({ status }: { status?: "running" | "attention" }) {
  if (!status) return null;
  return <span className={`fm-dot ${status === "running" ? "is-run" : "is-done"}`} aria-label={status === "running" ? "Working" : "New reply"} role="img" />;
}


/** Finder keeps both ends of a long name in icon view so the extension stays visible. */
function middleTruncate(name: string, limit = 22): string {
  if (name.length <= limit) return name;
  const tail = Math.min(8, Math.floor(limit / 2) - 1);
  return `${name.slice(0, limit - tail - 1)}…${name.slice(-tail)}`;
}

function hiddenKey(place: FileManagerPlace, path: string): string {
  return `${placeKey(place)}\0${path}`;
}

function rowDomId(path: string): string {
  return `fm-item-${encodeURIComponent(path).replace(/%/g, "_")}`;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function joinNative(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

function sameFolder(first: string, second: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(first) === normalize(second);
}
