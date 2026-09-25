import {
  WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM,
  WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM,
  WORKFOLD_PUBLICATION_SHAREABLE_EXTENSIONS,
  WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH,
  isWorkFoldPublicationSourcePath,
  workFoldPublicationHealth,
  workFoldPublicationHealthWithConnection,
  type WorkFoldPublicationConnection,
  type WorkFoldPublicationHealth,
  type WorkFoldPublicationPageState,
} from "../../../src/shared/publications";

/**
 * Pages your fold serves, as the renderer sees them (docs/fold-publishing.md,
 * rung 2). The closed source set, the ceilings, and the page state come from
 * the shared module the desktop publication service enforces, so the file
 * tab never offers a share the host would refuse.
 */

export const shareableSourceExtensions: readonly string[] = WORKFOLD_PUBLICATION_SHAREABLE_EXTENSIONS;
export const pageServeRateMaximum = WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM;
export const pageByteBudgetMaximumMiB = WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM / (1024 * 1024);

export type { WorkFoldPublicationConnection as SharedPageConnection, WorkFoldPublicationHealth as SharedPageHealth, WorkFoldPublicationPageState as SharedPageState };

/** One publication as `GET /api/settings/publications` lists it. */
export interface SharedPageView {
  publicationId: string;
  kind: "page" | "app";
  spaceId: string;
  spaceName?: string;
  /** Page slots only: the one designated Space-relative file. */
  relativePath?: string;
  /** Hosted-app slots only: the pinned exposure binding. */
  app?: {
    appInstanceId: string;
    releaseDigest: string;
    viewerEntry: string;
    viewerSurface: string[];
  };
  title: string;
  state: "active" | "revoked" | "expired";
  live: boolean;
  serveRatePerMinute: number;
  byteBudgetPerDay: number;
  snapshotEnabled: boolean;
  createdAt: string;
  bridgeSlot: "pending" | "confirmed";
  bridgeCleanup?: "pending" | "ok";
  counters?: { served: number; servedBytes: number; lastServedAt: string };
  lastProblem?: { state: "not-available" | "resting"; reason: string; at: string };
  /** Present on current hosts; derived locally when an older host omits it. */
  health?: WorkFoldPublicationHealth;
  viewerPath: string;
}

export interface SharedPagesResponse {
  publications: SharedPageView[];
  status: { damaged: boolean; damageReason?: string; activeCount: number; pendingBridgeWork: number };
}

/** True for the file types a page can be made from. */
export function isShareablePath(path: string): boolean {
  return isWorkFoldPublicationSourcePath(path);
}

/** The page title a file-tab share uses: the file name without its extension, within the title bound. */
export function pageTitleFromFileName(fileName: string): string {
  const name = fileName.replace(/\\/g, "/").split("/").at(-1) ?? fileName;
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[\r\n]+/g, " ").trim();
  return (stem || name.trim() || "Page").slice(0, WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH).trim();
}

/** The active page slot backed by this exact Space file, if one exists. */
export function activeSharedPageFor(publications: readonly SharedPageView[] | null, spaceId: string, path: string): SharedPageView | null {
  if (!publications) return null;
  return publications.find((publication) => (
    publication.kind === "page"
    && publication.state === "active"
    && publication.spaceId === spaceId
    && publication.relativePath === path
  )) ?? null;
}

/** Every file in this Space backing an active page slot, for the Files mark and file tabs. */
export function sharedPathsForSpace(publications: readonly SharedPageView[] | null, spaceId: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const publication of publications ?? []) {
    if (publication.kind === "page" && publication.state === "active" && publication.spaceId === spaceId && publication.relativePath) {
      paths.add(publication.relativePath);
    }
  }
  return paths;
}

/**
 * The state word and its precise reason for one row: the record's own
 * health, then this desktop's relay connection on top of a live or asleep
 * page.
 */
export function sharedPageHealth(publication: SharedPageView, connection: WorkFoldPublicationConnection | null): WorkFoldPublicationHealth {
  const recorded = publication.health ?? workFoldPublicationHealth(publication);
  return workFoldPublicationHealthWithConnection(recorded, connection);
}

/** The share link, composed transiently from the viewer origin, the slot path, and the fragment key. */
export function sharedPageLink(viewerOrigin: string, viewerPath: string, key: string): string {
  return `${viewerOrigin}${viewerPath}#${key}`;
}

// --- The shared-pages list the file tab and the Files context menu read ---

let sharedPages: SharedPageView[] | null = null;
let sharedPagesRequest: Promise<void> | null = null;
let sharedPagesRevision = 0;
const sharedPagesListeners = new Set<() => void>();

export function subscribeSharedPages(listener: () => void): () => void {
  sharedPagesListeners.add(listener);
  return () => { sharedPagesListeners.delete(listener); };
}

export function sharedPagesSnapshot(): SharedPageView[] | null {
  return sharedPages;
}

export function setSharedPages(next: SharedPageView[] | null): void {
  // Settings may supply its own fresh post-action list while a file surface's
  // older read is still pending. That older response must not replace it.
  sharedPagesRevision += 1;
  sharedPages = next;
  for (const listener of sharedPagesListeners) listener();
}

/** Reloads once at a time; mutations require a read begun after their effect. */
export function refreshSharedPages(
  load: () => Promise<SharedPagesResponse>,
  options: { afterMutation?: boolean } = {},
): Promise<void> {
  if (options.afterMutation) {
    sharedPagesRevision += 1;
    if (sharedPagesRequest) return sharedPagesRequest.then(() => refreshSharedPages(load));
  }
  if (sharedPagesRequest) return sharedPagesRequest;
  const revision = sharedPagesRevision;
  sharedPagesRequest = load()
    .then((response) => {
      if (revision === sharedPagesRevision) setSharedPages(response.status.damaged ? [] : response.publications);
    })
    .catch(() => undefined)
    .finally(() => { sharedPagesRequest = null; });
  return sharedPagesRequest;
}
