import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RestrictedAppViewerExposurePins, RestrictedAppViewerServeOutcome } from "./agent/restricted-app-viewer.js";
import type { WorkFoldCliActReceiptV2 } from "./cli/act-receipts.js";
import { resolveSpacePath } from "./space.js";
import { workFoldStateRoot } from "./state-paths.js";

export const WORKFOLD_PUBLICATION_SCHEMA_VERSION = 1;

/** The signed response frame the desktop returns for a relay `viewer.fetch`. */
export const WORKFOLD_VIEWER_PAGE_ENVELOPE_TYPE = "work-fold.viewer-page.v1";

/** The signed response frame the desktop returns for a relay `viewer.app.fetch` (rung 3). */
export const WORKFOLD_VIEWER_APP_ENVELOPE_TYPE = "work-fold.viewer-app.v1";

/** Desktop-side pre-render bound on the designated source file. */
export const WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Hard bound on one rendered page ciphertext (plaintext + AES-GCM tag). */
export const WORKFOLD_PUBLICATION_MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;

/** Budget defaults and ceilings, mirroring the bridge's admission bounds. */
export const WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT = 60;
export const WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM = 600;
export const WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT = 256 * 1024 * 1024;
export const WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM = 1024 * 1024 * 1024;

/** One address holds at most this many publication slots, live or pending. */
export const WORKFOLD_PUBLICATION_ACTIVE_CAP = 32;

/** Bounded retention of revoked records once their bridge cleanup confirmed. */
export const WORKFOLD_PUBLICATION_SETTLED_RETENTION = 100;

export const WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH = 80;

/**
 * The closed first-slice source set: Markdown and plain text render
 * desktop-side into one inert HTML body; PNG, JPEG, and PDF ship as bytes the
 * shell renders from local blob URLs. Person-authored HTML and SVG are
 * deliberately absent — an app (rung 3) is the vehicle for script.
 */
export const WORKFOLD_PUBLICATION_SOURCE_TYPES: Readonly<Record<string, WorkFoldPublicationMediaType>> = Object.freeze({
  ".md": "text/html",
  ".markdown": "text/html",
  ".txt": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
});

export type WorkFoldPublicationMediaType = "text/html" | "image/png" | "image/jpeg" | "application/pdf";

export type WorkFoldPublicationKind = "page" | "app";

export type WorkFoldPublicationState = "active" | "revoked";

/** Effective state adds expiry, which is evaluated lazily at read time. */
export type WorkFoldPublicationEffectiveState = WorkFoldPublicationState | "expired";

/**
 * Aggregate serve tallies for one publication. Serving is a read: it is
 * counted here — bounded, per-publication, no per-request journal — so the
 * Settings list and the glance can show "how much" without a receipt stream
 * (docs/fold-publishing.md: counted, never journaled per-request). Live
 * serves from this desktop only; snapshot serves happen at the relay while
 * this desktop sleeps and are visible in the relay's aggregate metrics.
 */
export interface WorkFoldPublicationServeCounters {
  served: number;
  servedBytes: number;
  lastServedAt: string;
}

/**
 * The publisher-facing health note behind the viewer's deliberately vague
 * states: `not-available` records the precise desktop-side serve problem the
 * audience never sees, and `resting` records the relay's budget-exhaustion
 * notice. One bounded note per publication — set on transition, cleared by
 * the next successful serve — so the glance renders the page's problem as a
 * change item without inventing an event store.
 */
export interface WorkFoldPublicationProblem {
  state: "not-available" | "resting";
  reason: string;
  at: string;
}

export const WORKFOLD_PUBLICATION_PROBLEM_REASON_MAX_LENGTH = 200;

export type WorkFoldPublicationRestingReason = "serve-rate" | "byte-budget";

/**
 * The hosted-app exposure binding (docs/fold-publishing.md, rung 3): the
 * `publish.viewer.expose` pins carried into the grant record — App Instance
 * id, exact Release digest at consecration, viewer entry, and the complete
 * viewer-readable surface. The serve path re-verifies the surface against
 * the live installed manifest on every call.
 */
export interface WorkFoldPublicationAppBinding {
  appInstanceId: string;
  releaseDigest: string;
  viewerEntry: string;
  viewerSurface: string[];
}

export interface WorkFoldPublicationRecord {
  schemaVersion: typeof WORKFOLD_PUBLICATION_SCHEMA_VERSION;
  publicationId: string;
  kind: WorkFoldPublicationKind;
  spaceId: string;
  /** Page slots only: the one designated Space-relative file. */
  relativePath?: string;
  /** Hosted-app slots only: the consecrated exposure binding. */
  app?: WorkFoldPublicationAppBinding;
  title: string;
  state: WorkFoldPublicationState;
  serveRatePerMinute: number;
  byteBudgetPerDay: number;
  snapshotEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  expiresAt?: string;
  /** Idempotence key for the bridge slot sync that last mutated this record. */
  operationId: string;
  /** Two-phase slot sync: the page is not presented as live until confirmed. */
  bridgeSlot: "pending" | "confirmed";
  /** Present on revoked records until bridge deletion is confirmed. */
  bridgeCleanup?: "pending" | "ok";
  /** Bookkeeping, not authority: tolerated leniently at load, never poisoning the store. */
  counters?: WorkFoldPublicationServeCounters;
  lastProblem?: WorkFoldPublicationProblem;
}

export interface WorkFoldPublicationView {
  publicationId: string;
  kind: WorkFoldPublicationKind;
  spaceId: string;
  /** Page slots only. */
  relativePath?: string;
  /** Hosted-app slots only. */
  app?: WorkFoldPublicationAppBinding;
  title: string;
  state: WorkFoldPublicationEffectiveState;
  live: boolean;
  serveRatePerMinute: number;
  byteBudgetPerDay: number;
  snapshotEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  expiresAt?: string;
  bridgeSlot: "pending" | "confirmed";
  bridgeCleanup?: "pending" | "ok";
  /** Aggregate live-serve tallies from this desktop; absent until the first serve. */
  counters?: WorkFoldPublicationServeCounters;
  /** The precise publisher-facing state behind a vague viewer refusal, until the next successful serve. */
  lastProblem?: WorkFoldPublicationProblem;
  /** Share-link path on the viewer origin. The origin belongs to Remote access settings; the key is never here. */
  viewerPath: string;
}

/**
 * Provenance for one receipted publication act. `requestId` is the act-lane
 * replay boundary; the remaining fields ride into the receipt so a decision
 * or a remote surface stays attributable.
 */
export interface WorkFoldPublicationActContext {
  requestId: string;
  surface?: WorkFoldCliActReceiptV2["surface"];
  decisionId?: string;
  parentTaskId?: string;
  browserId?: string;
  grantId?: string;
}

export interface WorkFoldPublicationActivateInput {
  spaceId: string;
  relativePath: string;
  title: string;
  serveRatePerMinute?: number;
  byteBudgetPerDay?: number;
  snapshotEnabled?: boolean;
  expiresAt?: string;
}

export type WorkFoldViewerPageServeResult =
  | {
    state: "served";
    publicationId: string;
    ciphertext: string;
    iv: string;
    contentDigest: string;
    servedAt: string;
    byteSize: number;
    snapshotEnabled: boolean;
  }
  | { state: "nothing-here"; publicationId: string }
  | { state: "not-available"; publicationId: string };

/**
 * One relayed viewer-app answer (rung 3). `callDigest` is the id-safe digest
 * of the canonical call fingerprint — it rides in the signed envelope header
 * for the bridge's admission hygiene, while the fingerprint itself is bound
 * into the AES-GCM additional data that only the link-key holder can verify.
 */
export type WorkFoldViewerAppServeResult =
  | {
    state: "served";
    publicationId: string;
    ciphertext: string;
    iv: string;
    contentDigest: string;
    callDigest: string;
    servedAt: string;
    byteSize: number;
  }
  | { state: "nothing-here"; publicationId: string }
  | { state: "not-available"; publicationId: string };

export interface WorkFoldPublicationActivateAppInput {
  spaceId: string;
  title: string;
  app: WorkFoldPublicationAppBinding;
  serveRatePerMinute?: number;
  byteBudgetPerDay?: number;
  expiresAt?: string;
}

/**
 * Publication keys are Remote access material: operating-system-encrypted
 * secure settings, never the publication store, never a Space folder. The
 * desktop wiring backs this with `desktop/src/settings.ts`.
 */
export interface WorkFoldPublicationKeyStore {
  get(publicationId: string): Promise<string | null>;
  set(publicationId: string, keyBase64Url: string): Promise<void>;
  remove(publicationId: string): Promise<void>;
}

/**
 * The bridge's idempotent, content-free slot sync surface, implemented over
 * the device-authenticated HTTP routes by `desktop/src/remote-access.ts`.
 * Every call may reject; the store keeps the durable pending marker and the
 * redrive lane retries on startup and reconnect.
 */
export interface WorkFoldPublicationBridgeSync {
  upsertSlot(input: {
    publicationId: string;
    operationId: string;
    kind: WorkFoldPublicationKind;
    state: WorkFoldPublicationState;
    serveRatePerMinute: number;
    byteBudgetPerDay: number;
    snapshotEnabled: boolean;
    expiresAt?: string;
  }): Promise<void>;
  deleteSlot(publicationId: string): Promise<void>;
  /**
   * Seeds or refreshes the relay's one bounded ciphertext row for an opted-in
   * publication, so the page survives desktop sleep from the moment of
   * activation instead of only after the first live viewer fetch. The relay
   * owns opt-in, bounds, and newest-wins; a refused push is not an error
   * lane. Like the serve-time refresh, this is a counter-tracked sync, never
   * a receipted act.
   */
  putSnapshot(input: {
    publicationId: string;
    ciphertext: string;
    iv: string;
    contentDigest: string;
    capturedAt: string;
  }): Promise<void>;
  deleteSnapshot(publicationId: string): Promise<void>;
}

export interface WorkFoldPublicationReceiptWriter {
  append(entry: Omit<WorkFoldCliActReceiptV2, "v" | "at">): Promise<boolean>;
}

export type WorkFoldPublicationErrorCode =
  | "STORE_DAMAGED"
  | "JOURNAL_UNAVAILABLE"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "ALREADY_REVOKED"
  | "SPACE_NOT_REGISTERED"
  | "SOURCE_INVALID"
  | "WIDEN_REFUSED"
  | "PUBLICATION_CAP"
  | "STORE_IO";

export class WorkFoldPublicationError extends Error {
  readonly code: WorkFoldPublicationErrorCode;

  constructor(code: WorkFoldPublicationErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkFoldPublicationError";
    this.code = code;
  }
}

/**
 * The desktop viewer adapter for hosted apps
 * (src/local/agent/restricted-app-viewer.ts): the viewer-safe broker subset
 * is enforced there, at effect time; this service adds the grant recheck,
 * the budgets, the encryption, and the counters. Absent — an app slot can
 * still be listed and revoked, but every serve is honestly `not-available`.
 */
export interface WorkFoldPublicationAppServing {
  serve(pins: RestrictedAppViewerExposurePins, call: unknown): Promise<RestrictedAppViewerServeOutcome>;
}

export interface WorkFoldPublicationServiceOptions {
  /** Defaults to `fold/publications.json` under the work-fold state root — the location the glance reads. */
  path?: string;
  now?: () => Date;
  keys: WorkFoldPublicationKeyStore;
  receipts: WorkFoldPublicationReceiptWriter;
  resolveSpaceRoot: (spaceId: string) => Promise<string | null>;
  /** Absent while Remote access is unconfigured: every sync stays honestly pending. */
  bridge?: WorkFoldPublicationBridgeSync | null;
  /** Hosted-app viewer serving (rung 3); absent app serves are `not-available`. */
  apps?: WorkFoldPublicationAppServing | null;
}

export interface WorkFoldPublicationServiceStatus {
  damaged: boolean;
  damageReason?: string;
  activeCount: number;
  pendingBridgeWork: number;
}

export function workFoldPublicationsFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "publications.json");
}

/**
 * The additional authenticated data both the desktop and the viewer shell
 * bind: envelope type, publication, rendered-content digest, and the serve
 * timestamp. Must match `services/bridge/public/viewer/viewer.js`.
 */
export function workFoldViewerPageAad(publicationId: string, contentDigest: string, servedAt: string): Buffer {
  return Buffer.from(JSON.stringify([WORKFOLD_VIEWER_PAGE_ENVELOPE_TYPE, publicationId, contentDigest, servedAt]), "utf8");
}

export const WORKFOLD_VIEWER_APP_CALL_FINGERPRINT_MAX_LENGTH = 2_048;

/**
 * Canonical fingerprint of one viewer-app call: JSON with recursively sorted
 * object keys, so the desktop and the viewer shell derive the identical
 * string from the identical call. Returns null for values that are not plain
 * bounded JSON — the serve path refuses those before any adapter runs.
 */
export function workFoldViewerAppCallFingerprint(value: unknown): string | null {
  const canonical = canonicalJson(value, 0);
  if (canonical === null || canonical.length > WORKFOLD_VIEWER_APP_CALL_FINGERPRINT_MAX_LENGTH) return null;
  return canonical;
}

function canonicalJson(value: unknown, depth: number): string | null {
  if (depth > 4) return null;
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const encoded = canonicalJson(item, depth + 1);
      if (encoded === null) return null;
      items.push(encoded);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      const encoded = canonicalJson(item, depth + 1);
      if (encoded === null) return null;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  }
  return null;
}

/**
 * The additional authenticated data for one viewer-app response: envelope
 * type, publication, the canonical call fingerprint, the payload digest, and
 * the serve timestamp. Must match
 * `services/bridge/public/viewer/viewer-app.js`.
 */
export function workFoldViewerAppAad(
  publicationId: string,
  callFingerprint: string,
  contentDigest: string,
  servedAt: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([WORKFOLD_VIEWER_APP_ENVELOPE_TYPE, publicationId, callFingerprint, contentDigest, servedAt]),
    "utf8",
  );
}

interface PublicationsFileShape {
  schemaVersion: typeof WORKFOLD_PUBLICATION_SCHEMA_VERSION;
  publications: WorkFoldPublicationRecord[];
}

/** One render attempt plus the publisher-facing reason behind a vague refusal. */
interface ServeOutcome {
  result: WorkFoldViewerPageServeResult;
  reason?: string;
}

/** One viewer-app serve attempt plus the publisher-facing reason behind a vague refusal. */
interface AppServeOutcome {
  result: WorkFoldViewerAppServeResult;
  reason?: string;
}

/**
 * The encrypted viewer-app payload: either the adapter's served read or its
 * typed viewer-visible refusal. The shell verifies `v` and forwards the rest
 * to the sandboxed app frame. Must match
 * `services/bridge/public/viewer/viewer-app.js`.
 */
interface ViewerAppPayload {
  v: 1;
  ok: boolean;
  result?: unknown;
  code?: string;
  message?: string;
}

/**
 * The desktop authority behind "pages your fold serves"
 * (docs/fold-publishing.md, rung 2). It owns the machine-local publication
 * grant records, the source binding and its identity checks, the bounded
 * closed-set renderer, the effect-time recheck before every serve, and the
 * revocation-first ordering. Records are machine-local application state:
 * nothing about a publication is ever written into the Space folder, and the
 * share link's key lives only in the injected secure key store. Every
 * mutation is journaled through the injected act-receipt writer before it
 * runs — a mutation that cannot be journaled is refused — and finishes with a
 * terminal receipt naming its bridge-sync outcome. Serving is a read: it is
 * counted upstream, never journaled per-request.
 */
export class WorkFoldPublicationService {
  readonly path: string;
  readonly #now: () => Date;
  readonly #keys: WorkFoldPublicationKeyStore;
  readonly #receipts: WorkFoldPublicationReceiptWriter;
  readonly #resolveSpaceRoot: (spaceId: string) => Promise<string | null>;
  readonly #bridge: WorkFoldPublicationBridgeSync | null;
  readonly #apps: WorkFoldPublicationAppServing | null;
  readonly #damageReason: string | null;
  #file: PublicationsFileShape;
  #queue: Promise<unknown> = Promise.resolve();
  #serving = new Map<string, Promise<WorkFoldViewerPageServeResult>>();
  #servingAppCalls = new Map<string, Promise<WorkFoldViewerAppServeResult>>();

  private constructor(
    options: WorkFoldPublicationServiceOptions,
    path: string,
    file: PublicationsFileShape,
    damageReason: string | null,
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#keys = options.keys;
    this.#receipts = options.receipts;
    this.#resolveSpaceRoot = options.resolveSpaceRoot;
    this.#bridge = options.bridge ?? null;
    this.#apps = options.apps ?? null;
    this.#file = file;
    this.#damageReason = damageReason;
  }

  static async create(options: WorkFoldPublicationServiceOptions): Promise<WorkFoldPublicationService> {
    const path = resolve(options.path ?? workFoldPublicationsFile());
    const loaded = await loadPublicationsFile(path);
    return new WorkFoldPublicationService(options, path, loaded.file, loaded.damageReason);
  }

  status(): WorkFoldPublicationServiceStatus {
    if (this.#damageReason !== null) {
      return { damaged: true, damageReason: this.#damageReason, activeCount: 0, pendingBridgeWork: 0 };
    }
    return {
      damaged: false,
      activeCount: this.#file.publications.filter((record) => this.#effectiveState(record) === "active").length,
      pendingBridgeWork: this.#file.publications.filter((record) => recordHasPendingBridgeWork(record)).length,
    };
  }

  async list(): Promise<WorkFoldPublicationView[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      return this.#file.publications
        .map((record) => this.#view(record))
        .sort((left, right) => compareStrings(right.createdAt, left.createdAt) || compareStrings(right.publicationId, left.publicationId));
    });
  }

  async get(publicationId: string): Promise<WorkFoldPublicationView | undefined> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      return record ? this.#view(record) : undefined;
    });
  }

  /**
   * Active publications backed by this Space. Unregistering or deleting a
   * Space is blocked until these are revoked; the removal flow names them.
   */
  async activePublicationsForSpace(spaceId: string): Promise<WorkFoldPublicationView[]> {
    return await this.#mutate(async () => {
      // A damaged store cannot prove a Space is unpublished, so removal
      // callers see every stored claim fail closed.
      if (this.#damageReason !== null) {
        throw new WorkFoldPublicationError(
          "STORE_DAMAGED",
          `work-fold cannot verify this Space's publications: ${this.#damageReason}`,
        );
      }
      return this.#file.publications
        .filter((record) => record.spaceId === spaceId && this.#effectiveState(record) === "active")
        .map((record) => this.#view(record));
    });
  }

  /**
   * Activation, after its consecration decision: journal first, then the
   * durable intent record, then the key mint, then the bridge slot sync. A
   * crash or offline bridge leaves an inspectable pending record that the
   * redrive lane completes; the page is not presented as live until the
   * bridge slot is confirmed.
   */
  async activate(input: WorkFoldPublicationActivateInput, context: WorkFoldPublicationActContext): Promise<WorkFoldPublicationView> {
    const activated = await this.#mutate(async () => {
      this.#assertOperational();
      assertActContext(context);
      const title = normalizeTitle(input.title);
      const serveRatePerMinute = boundedInteger(
        input.serveRatePerMinute ?? WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
        1,
        WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM,
        "serve-rate budget",
      );
      const byteBudgetPerDay = boundedInteger(
        input.byteBudgetPerDay ?? WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
        1,
        WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM,
        "byte budget",
      );
      const expiresAt = normalizeExpiry(input.expiresAt, this.#now());
      if (typeof input.spaceId !== "string" || !input.spaceId) {
        throw new WorkFoldPublicationError("INPUT_INVALID", "A Space id is required to share a page.");
      }
      const active = this.#file.publications.filter((record) => this.#effectiveState(record) === "active");
      if (active.length >= WORKFOLD_PUBLICATION_ACTIVE_CAP) {
        throw new WorkFoldPublicationError(
          "PUBLICATION_CAP",
          `${WORKFOLD_PUBLICATION_ACTIVE_CAP} pages are already shared; stop sharing one first.`,
        );
      }
      const root = await this.#resolveSpaceRoot(input.spaceId);
      if (!root) throw new WorkFoldPublicationError("SPACE_NOT_REGISTERED", "That Space is not registered on this machine.");
      const source = await inspectSource(root, input.relativePath);

      const publicationId = randomBytes(18).toString("base64url");
      const operationId = randomUUID();
      await this.#journal(context, "pages activate", input.spaceId, async () => {
        const created = this.#now().toISOString();
        const record: WorkFoldPublicationRecord = {
          schemaVersion: WORKFOLD_PUBLICATION_SCHEMA_VERSION,
          publicationId,
          kind: "page",
          spaceId: input.spaceId,
          relativePath: source.relativePath,
          title,
          state: "active",
          serveRatePerMinute,
          byteBudgetPerDay,
          snapshotEnabled: input.snapshotEnabled === true,
          createdAt: created,
          updatedAt: created,
          ...(expiresAt ? { expiresAt } : {}),
          operationId,
          bridgeSlot: "pending",
        };
        const draft = structuredClone(this.#file);
        draft.publications.push(record);
        prunePublications(draft);
        await this.#commit(draft);
        // The durable intent exists; key mint and bridge sync now converge
        // onto it and are re-driven at startup or reconnect if interrupted.
        await this.#keys.set(publicationId, randomBytes(32).toString("base64url"));
        const synced = await this.#syncSlot(publicationId);
        return {
          detail: `publicationId=${publicationId} source=${input.spaceId}:${source.relativePath} viewerPath=/p/${publicationId} `
            + `serveRatePerMinute=${serveRatePerMinute} byteBudgetPerDay=${byteBudgetPerDay} `
            + `snapshot=${input.snapshotEnabled === true ? "on" : "off"} bridgeSync=${synced ? "confirmed" : "pending"}`,
          undoRef: { kind: "publicationId", value: publicationId },
        };
      });
      return { publicationId, snapshotEnabled: input.snapshotEnabled === true };
    });
    // Seed the relay snapshot outside the store's serialized section so the
    // opted-in page survives desktop sleep from the first moment, not only
    // after the first live viewer fetch. Best-effort: a refused or offline
    // push leaves the serve-time refresh and the redrive lane to converge.
    if (activated.snapshotEnabled) await this.#pushSnapshot(activated.publicationId);
    return this.#view(this.#record(activated.publicationId));
  }

  /**
   * Hosted-app exposure activation (docs/fold-publishing.md, rung 3), after
   * its `publish.viewer.expose` decision: the same journal-first two-phase
   * shape as page activation — durable intent, key mint, bridge slot sync
   * with kind `app` — carrying the consecrated pins into the grant record.
   * Snapshot caching does not exist for apps: an offline desktop is an
   * honestly asleep app, so the flag is structurally false.
   */
  async activateApp(input: WorkFoldPublicationActivateAppInput, context: WorkFoldPublicationActContext): Promise<WorkFoldPublicationView> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      assertActContext(context);
      const title = normalizeTitle(input.title);
      const serveRatePerMinute = boundedInteger(
        input.serveRatePerMinute ?? WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
        1,
        WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM,
        "serve-rate budget",
      );
      const byteBudgetPerDay = boundedInteger(
        input.byteBudgetPerDay ?? WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
        1,
        WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM,
        "byte budget",
      );
      const expiresAt = normalizeExpiry(input.expiresAt, this.#now());
      if (typeof input.spaceId !== "string" || !input.spaceId) {
        throw new WorkFoldPublicationError("INPUT_INVALID", "A Space id is required to put an app at your address.");
      }
      const app = normalizeAppBinding(input.app);
      const active = this.#file.publications.filter((record) => this.#effectiveState(record) === "active");
      if (active.length >= WORKFOLD_PUBLICATION_ACTIVE_CAP) {
        throw new WorkFoldPublicationError(
          "PUBLICATION_CAP",
          `${WORKFOLD_PUBLICATION_ACTIVE_CAP} pages are already shared; stop sharing one first.`,
        );
      }
      if (active.some((record) => record.kind === "app" && record.app?.appInstanceId === app.appInstanceId)) {
        throw new WorkFoldPublicationError(
          "INPUT_INVALID",
          "This App Instance is already at your address; stop sharing it before exposing it again.",
        );
      }
      const root = await this.#resolveSpaceRoot(input.spaceId);
      if (!root) throw new WorkFoldPublicationError("SPACE_NOT_REGISTERED", "That Space is not registered on this machine.");

      const publicationId = randomBytes(18).toString("base64url");
      const operationId = randomUUID();
      await this.#journal(context, "pages activate-app", input.spaceId, async () => {
        const created = this.#now().toISOString();
        const record: WorkFoldPublicationRecord = {
          schemaVersion: WORKFOLD_PUBLICATION_SCHEMA_VERSION,
          publicationId,
          kind: "app",
          spaceId: input.spaceId,
          app,
          title,
          state: "active",
          serveRatePerMinute,
          byteBudgetPerDay,
          snapshotEnabled: false,
          createdAt: created,
          updatedAt: created,
          ...(expiresAt ? { expiresAt } : {}),
          operationId,
          bridgeSlot: "pending",
        };
        const draft = structuredClone(this.#file);
        draft.publications.push(record);
        prunePublications(draft);
        await this.#commit(draft);
        await this.#keys.set(publicationId, randomBytes(32).toString("base64url"));
        const synced = await this.#syncSlot(publicationId);
        return {
          detail: `publicationId=${publicationId} appInstanceId=${app.appInstanceId} releaseDigest=${app.releaseDigest} `
            + `viewerEntry=${app.viewerEntry} viewerSurface=${app.viewerSurface.join(",")} viewerPath=/a/${publicationId} `
            + `serveRatePerMinute=${serveRatePerMinute} byteBudgetPerDay=${byteBudgetPerDay} `
            + `bridgeSync=${synced ? "confirmed" : "pending"}`,
          undoRef: { kind: "publicationId", value: publicationId },
        };
      });
      return this.#view(this.#record(publicationId));
    });
  }

  /**
   * Revocation-first ordering: the desktop grant dies before any bridge
   * cleanup is attempted, so the effect-time recheck refuses new serves from
   * this instant regardless of bridge state. Unconfirmed bridge cleanup is
   * named in the receipt — the one case where relayed bytes could outlive
   * desktop authority — and retried on startup and reconnect.
   */
  async revoke(publicationId: string, context: WorkFoldPublicationActContext): Promise<WorkFoldPublicationView> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      assertActContext(context);
      const existing = this.#record(publicationId);
      await this.#journal(context, "pages revoke", existing.spaceId, async () => {
        if (existing.state === "revoked") {
          return { detail: `publicationId=${publicationId} alreadyRevoked=true bridgeCleanup=${existing.bridgeCleanup ?? "ok"}` };
        }
        const draft = structuredClone(this.#file);
        const record = draftRecord(draft, publicationId);
        const nowIso = this.#now().toISOString();
        record.state = "revoked";
        record.revokedAt = nowIso;
        record.updatedAt = nowIso;
        record.bridgeCleanup = "pending";
        record.operationId = randomUUID();
        await this.#commit(draft);
        const cleaned = await this.#cleanupSlot(publicationId);
        return {
          detail: `publicationId=${publicationId} bridgeCleanup=${cleaned ? "ok" : "pending"}`,
          undoRef: { kind: "publicationId", value: publicationId },
        };
      });
      return this.#view(this.#record(publicationId));
    });
  }

  /**
   * Narrowing is a direct verb: budgets may only shrink here. Raising either
   * budget is widening and belongs to a fresh consecration, so it is refused
   * with a typed error instead of silently staged.
   */
  async narrowBudgets(
    publicationId: string,
    input: { serveRatePerMinute?: number; byteBudgetPerDay?: number },
    context: WorkFoldPublicationActContext,
  ): Promise<WorkFoldPublicationView> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      assertActContext(context);
      const existing = this.#activeRecord(publicationId);
      const serveRatePerMinute = input.serveRatePerMinute === undefined
        ? existing.serveRatePerMinute
        : boundedInteger(input.serveRatePerMinute, 1, WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM, "serve-rate budget");
      const byteBudgetPerDay = input.byteBudgetPerDay === undefined
        ? existing.byteBudgetPerDay
        : boundedInteger(input.byteBudgetPerDay, 1, WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM, "byte budget");
      if (serveRatePerMinute > existing.serveRatePerMinute || byteBudgetPerDay > existing.byteBudgetPerDay) {
        throw new WorkFoldPublicationError(
          "WIDEN_REFUSED",
          "Raising a publication budget widens exposure and needs a fresh approval; only narrowing is a direct verb.",
        );
      }
      await this.#journal(context, "pages narrow-budgets", existing.spaceId, async () => {
        const draft = structuredClone(this.#file);
        const record = draftRecord(draft, publicationId);
        const previous = { serveRatePerMinute: record.serveRatePerMinute, byteBudgetPerDay: record.byteBudgetPerDay };
        record.serveRatePerMinute = serveRatePerMinute;
        record.byteBudgetPerDay = byteBudgetPerDay;
        record.updatedAt = this.#now().toISOString();
        record.operationId = randomUUID();
        record.bridgeSlot = "pending";
        await this.#commit(draft);
        const synced = await this.#syncSlot(publicationId);
        return {
          detail: `publicationId=${publicationId} serveRatePerMinute=${previous.serveRatePerMinute}->${serveRatePerMinute} `
            + `byteBudgetPerDay=${previous.byteBudgetPerDay}->${byteBudgetPerDay} bridgeSync=${synced ? "confirmed" : "pending"}`,
          undoRef: { kind: "publicationId", value: publicationId },
        };
      });
      return this.#view(this.#record(publicationId));
    });
  }

  /**
   * Snapshot off is narrowing: local flag first, then the bridge slot sync,
   * which deletes the stored ciphertext row server-side. The receipt names
   * the deletion outcome because a pending one means relayed ciphertext may
   * briefly outlive the opt-in.
   */
  async disableSnapshot(publicationId: string, context: WorkFoldPublicationActContext): Promise<WorkFoldPublicationView> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      assertActContext(context);
      const existing = this.#activeRecord(publicationId);
      await this.#journal(context, "pages snapshot-off", existing.spaceId, async () => {
        const draft = structuredClone(this.#file);
        const record = draftRecord(draft, publicationId);
        record.snapshotEnabled = false;
        record.updatedAt = this.#now().toISOString();
        record.operationId = randomUUID();
        record.bridgeSlot = "pending";
        await this.#commit(draft);
        const synced = await this.#syncSlot(publicationId);
        return {
          detail: `publicationId=${publicationId} snapshot=off snapshotDeletion=${synced ? "confirmed" : "pending"}`,
          undoRef: { kind: "publicationId", value: publicationId },
        };
      });
      return this.#view(this.#record(publicationId));
    });
  }

  /**
   * Re-drives unconfirmed bridge work — slot syncs for active records and
   * slot deletion for revoked ones. Called at startup and on device
   * reconnect. Never journaled: it completes already-receipted acts.
   */
  async redriveBridgeSync(): Promise<{ confirmed: number; pending: number }> {
    const result = await this.#mutate(async () => {
      if (this.#damageReason !== null) return { confirmed: 0, pending: 0, seed: [] as string[] };
      let confirmed = 0;
      let pending = 0;
      const seed: string[] = [];
      for (const record of [...this.#file.publications]) {
        if (!recordHasPendingBridgeWork(record)) continue;
        if (record.state === "active" && await this.#keys.get(record.publicationId) === null) {
          // An interrupted activation may have committed intent before the
          // key mint; converge that first so a confirmed slot always has a
          // servable key behind it.
          await this.#keys.set(record.publicationId, randomBytes(32).toString("base64url")).catch(() => undefined);
        }
        const done = record.state === "revoked"
          ? await this.#cleanupSlot(record.publicationId)
          : await this.#syncSlot(record.publicationId);
        if (done) confirmed += 1;
        else pending += 1;
        // A just-confirmed slot for an opted-in page gets its snapshot seeded
        // once the queue is released, completing an activation the bridge
        // missed.
        if (done && record.state === "active" && record.snapshotEnabled) seed.push(record.publicationId);
      }
      return { confirmed, pending, seed };
    });
    for (const publicationId of result.seed) await this.#pushSnapshot(publicationId);
    return { confirmed: result.confirmed, pending: result.pending };
  }

  /**
   * Records the relay's budget-exhaustion notice for one active publication.
   * The viewer already saw the vague "resting" page at the bridge; this is
   * the publisher's precise side of it, kept as the record's one bounded
   * health note until the next successful serve clears it. A health note is
   * bookkeeping, never a receipted act.
   */
  async noteViewerResting(publicationId: string, reason: WorkFoldPublicationRestingReason): Promise<void> {
    if (typeof publicationId !== "string" || !publicationId || publicationId.length > 128) return;
    const label = reason === "byte-budget"
      ? "its daily byte budget at the relay is used up"
      : reason === "serve-rate"
        ? "it hit its serves-per-minute budget at the relay"
        : null;
    if (!label) return;
    await this.#recordProblem(publicationId, "resting", label);
  }

  /**
   * The serve path behind `viewer.fetch`: recheck the local grant immediately
   * before serving, re-read the designated file under the ordinary
   * no-follow/identity checks, render within hard bounds, and encrypt with
   * the publication key binding publication id, content digest, and serve
   * timestamp. Refusals are typed and content-free — `nothing-here` for a
   * grant this desktop no longer serves, `not-available` for a source
   * problem whose precise reason belongs to the publisher, not the audience.
   * Concurrent fetches for one slot coalesce onto one render.
   */
  async serveViewerPage(publicationId: string): Promise<WorkFoldViewerPageServeResult> {
    if (typeof publicationId !== "string" || !publicationId || publicationId.length > 128) {
      return { state: "nothing-here", publicationId: typeof publicationId === "string" ? publicationId.slice(0, 128) : "" };
    }
    const inFlight = this.#serving.get(publicationId);
    if (inFlight) return inFlight;
    const serving = this.#serveOnce(publicationId).then(async (outcome) => {
      // Serving is a read, counted rather than journaled: a success clears
      // any recorded problem and adds to the aggregate tallies; the vague
      // not-available refusal records its precise publisher-facing reason.
      await this.#recordServeOutcome(publicationId, outcome).catch(() => undefined);
      return outcome.result;
    });
    this.#serving.set(publicationId, serving);
    try {
      return await serving;
    } finally {
      if (this.#serving.get(publicationId) === serving) this.#serving.delete(publicationId);
    }
  }

  /**
   * The serve path behind `viewer.app.fetch` (rung 3): the same effect-time
   * grant recheck as pages, then the restricted-app viewer adapter enforcing
   * the viewer-safe broker subset against live installed state, then AES-GCM
   * under the publication key with the canonical call fingerprint bound into
   * the additional data. Refusals stay typed and content-free; concurrent
   * identical calls coalesce onto one serve.
   */
  async serveViewerAppCall(publicationId: string, callValue: unknown): Promise<WorkFoldViewerAppServeResult> {
    if (typeof publicationId !== "string" || !publicationId || publicationId.length > 128) {
      return { state: "nothing-here", publicationId: typeof publicationId === "string" ? publicationId.slice(0, 128) : "" };
    }
    const fingerprint = workFoldViewerAppCallFingerprint(callValue);
    if (fingerprint === null) return { state: "not-available", publicationId };
    const coalesceKey = `${publicationId} ${fingerprint}`;
    const inFlight = this.#servingAppCalls.get(coalesceKey);
    if (inFlight) return inFlight;
    const serving = this.#serveAppCallOnce(publicationId, fingerprint, callValue).then(async (outcome) => {
      await this.#recordAppServeOutcome(publicationId, outcome).catch(() => undefined);
      return outcome.result;
    });
    this.#servingAppCalls.set(coalesceKey, serving);
    try {
      return await serving;
    } finally {
      if (this.#servingAppCalls.get(coalesceKey) === serving) this.#servingAppCalls.delete(coalesceKey);
    }
  }

  async #serveAppCallOnce(publicationId: string, fingerprint: string, callValue: unknown): Promise<AppServeOutcome> {
    const rechecked = await this.#mutate(async (): Promise<
      | { refusal: WorkFoldViewerAppServeResult }
      | { record: WorkFoldPublicationRecord }
    > => {
      if (this.#damageReason !== null) return { refusal: { state: "nothing-here", publicationId } };
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      if (!record || record.kind !== "app" || this.#effectiveState(record) !== "active") {
        return { refusal: { state: "nothing-here", publicationId } };
      }
      return { record: structuredClone(record) };
    });
    if ("refusal" in rechecked) return { result: rechecked.refusal };
    const record = rechecked.record;
    const unavailable = (reason: string): AppServeOutcome => ({
      result: { state: "not-available", publicationId },
      reason,
    });
    try {
      const binding = record.app;
      if (!binding) return unavailable("its exposure record carries no app binding");
      if (!this.#apps) return unavailable("this desktop build cannot serve apps to viewers");
      const outcome = await this.#apps.serve({
        appInstanceId: binding.appInstanceId,
        releaseDigest: binding.releaseDigest,
        viewerEntry: binding.viewerEntry,
        viewerSurface: [...binding.viewerSurface],
      }, callValue);
      if (outcome.state === "not-available") return unavailable(outcome.reason);
      const keyBase64Url = await this.#keys.get(publicationId);
      if (!keyBase64Url) return unavailable("its page key is missing from this desktop's secure settings");
      const key = Buffer.from(keyBase64Url, "base64url");
      if (key.length !== 32) return unavailable("its page key is missing from this desktop's secure settings");
      const payload: ViewerAppPayload = outcome.result.ok
        ? { v: 1, ok: true, result: outcome.result.result }
        : { v: 1, ok: false, code: outcome.result.code, message: outcome.result.message };
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      if (plaintext.length + 16 > WORKFOLD_PUBLICATION_MAX_CIPHERTEXT_BYTES) {
        return unavailable("the served app response is larger than the 2 MiB serving bound");
      }
      const servedAt = this.#now().toISOString();
      const contentDigest = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
      const callDigest = `sha256:${createHash("sha256").update(fingerprint, "utf8").digest("hex")}`;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(workFoldViewerAppAad(publicationId, fingerprint, contentDigest, servedAt));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return {
        result: {
          state: "served",
          publicationId,
          ciphertext: ciphertext.toString("base64url"),
          iv: iv.toString("base64url"),
          contentDigest,
          callDigest,
          servedAt,
          byteSize: ciphertext.length,
        },
      };
    } catch {
      return unavailable("the app this page belongs to could not be served");
    }
  }

  /** Mirrors the page bookkeeping: successes count and clear, refusals record their publisher-facing reason. */
  async #recordAppServeOutcome(publicationId: string, outcome: AppServeOutcome): Promise<void> {
    if (outcome.result.state === "nothing-here") return;
    if (outcome.result.state === "not-available") {
      await this.#recordProblem(publicationId, "not-available", outcome.reason ?? "the app this page belongs to could not be served");
      return;
    }
    const served = outcome.result;
    await this.#mutate(async () => {
      if (this.#damageReason !== null) return;
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      if (!record || record.state !== "active") return;
      const draft = structuredClone(this.#file);
      const target = draftRecord(draft, publicationId);
      const counters = target.counters ?? { served: 0, servedBytes: 0, lastServedAt: served.servedAt };
      target.counters = {
        served: counters.served + 1,
        servedBytes: counters.servedBytes + served.byteSize,
        lastServedAt: served.servedAt,
      };
      delete target.lastProblem;
      await this.#commit(draft).catch(() => undefined);
    });
  }

  async #serveOnce(publicationId: string): Promise<ServeOutcome> {
    // Effect-time recheck inside the store's serialized section, so a revoke
    // committed before this line always wins. The bounded render and
    // encryption then run outside it: an in-flight render may complete its
    // already bounded response, mirroring the late-signed-result rule.
    const rechecked = await this.#mutate(async (): Promise<
      | { refusal: WorkFoldViewerPageServeResult }
      | { record: WorkFoldPublicationRecord }
    > => {
      if (this.#damageReason !== null) return { refusal: { state: "nothing-here", publicationId } };
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      if (!record || record.kind !== "page" || this.#effectiveState(record) !== "active") {
        return { refusal: { state: "nothing-here", publicationId } };
      }
      return { record: structuredClone(record) };
    });
    if ("refusal" in rechecked) return { result: rechecked.refusal };
    const record = rechecked.record;
    const unavailable = (reason: string): ServeOutcome => ({
      result: { state: "not-available", publicationId },
      reason,
    });
    try {
      const root = await this.#resolveSpaceRoot(record.spaceId);
      if (!root) return unavailable("its Space is no longer registered on this machine");
      let source: InspectedSource;
      try {
        source = await inspectSource(root, record.relativePath ?? "");
      } catch (error) {
        return unavailable(error instanceof WorkFoldPublicationError ? error.message : "the designated file could not be read");
      }
      const keyBase64Url = await this.#keys.get(publicationId);
      if (!keyBase64Url) return unavailable("its page key is missing from this desktop's secure settings");
      const bytes = await readFile(source.path);
      if (bytes.length > WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES) {
        return unavailable("the designated file is larger than a shareable page (8 MiB)");
      }
      const servedAt = this.#now().toISOString();
      const payload = renderPublicationPayload(record.title, source.mediaType, source.extension, bytes, servedAt);
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      if (plaintext.length + 16 > WORKFOLD_PUBLICATION_MAX_CIPHERTEXT_BYTES) {
        return unavailable("the rendered page is larger than the 2 MiB serving bound");
      }
      const contentDigest = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
      const key = Buffer.from(keyBase64Url, "base64url");
      if (key.length !== 32) return unavailable("its page key is missing from this desktop's secure settings");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(workFoldViewerPageAad(publicationId, contentDigest, servedAt));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return {
        result: {
          state: "served",
          publicationId,
          ciphertext: ciphertext.toString("base64url"),
          iv: iv.toString("base64url"),
          contentDigest,
          servedAt,
          byteSize: ciphertext.length,
          snapshotEnabled: record.snapshotEnabled,
        },
      };
    } catch {
      // Identity-check refusals, unreadable files, and render failures are
      // all one vague viewer state; the precise reason is the publisher's
      // information and surfaces through the glance, not the audience.
      return unavailable("the designated file could not be read");
    }
  }

  /**
   * Post-serve bookkeeping, serialized with the store: a success clears the
   * recorded problem and grows the aggregate tallies; a not-available refusal
   * records its precise reason on transition. Nothing-here records nothing —
   * a grant this desktop no longer holds has no publisher to inform.
   */
  async #recordServeOutcome(publicationId: string, outcome: ServeOutcome): Promise<void> {
    if (outcome.result.state === "nothing-here") return;
    if (outcome.result.state === "not-available") {
      await this.#recordProblem(publicationId, "not-available", outcome.reason ?? "the designated file could not be read");
      return;
    }
    const served = outcome.result;
    await this.#mutate(async () => {
      if (this.#damageReason !== null) return;
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      if (!record || record.state !== "active") return;
      const draft = structuredClone(this.#file);
      const target = draftRecord(draft, publicationId);
      const counters = target.counters ?? { served: 0, servedBytes: 0, lastServedAt: served.servedAt };
      target.counters = {
        served: counters.served + 1,
        servedBytes: counters.servedBytes + served.byteSize,
        lastServedAt: served.servedAt,
      };
      delete target.lastProblem;
      await this.#commit(draft).catch(() => undefined);
    });
  }

  /** Sets the one bounded health note on transition; identical notes are not rewritten. */
  async #recordProblem(publicationId: string, state: WorkFoldPublicationProblem["state"], reason: string): Promise<void> {
    const bounded = reason.length > WORKFOLD_PUBLICATION_PROBLEM_REASON_MAX_LENGTH
      ? `${reason.slice(0, WORKFOLD_PUBLICATION_PROBLEM_REASON_MAX_LENGTH - 1)}…`
      : reason;
    await this.#mutate(async () => {
      if (this.#damageReason !== null) return;
      const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
      if (!record || this.#effectiveState(record) !== "active") return;
      if (record.lastProblem && record.lastProblem.state === state && record.lastProblem.reason === bounded) return;
      const draft = structuredClone(this.#file);
      draftRecord(draft, publicationId).lastProblem = { state, reason: bounded, at: this.#now().toISOString() };
      await this.#commit(draft).catch(() => undefined);
    });
  }

  /**
   * Renders once outside the serialized section and pushes the ciphertext to
   * the relay's snapshot row over the device-authenticated route. A seed is
   * not a viewer serve, so it bypasses the coalescing map and the counters;
   * the relay enforces opt-in, bounds, and newest-wins, and every failure is
   * silent — the serve-time refresh and the redrive lane converge later.
   */
  async #pushSnapshot(publicationId: string): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge) return;
    try {
      const outcome = await this.#serveOnce(publicationId);
      if (outcome.result.state !== "served" || !outcome.result.snapshotEnabled) return;
      await bridge.putSnapshot({
        publicationId,
        ciphertext: outcome.result.ciphertext,
        iv: outcome.result.iv,
        contentDigest: outcome.result.contentDigest,
        capturedAt: outcome.result.servedAt,
      });
    } catch {
      // Best-effort by design.
    }
  }

  /**
   * Journal-first execution of one receipted mutation: an `accepted` line
   * must land before anything runs, and a terminal `ok`/`error` line follows.
   * Terminal appends stay best-effort — an applied mutation is never failed
   * retroactively — but the opening line is load-bearing and refusal-worthy.
   */
  async #journal(
    context: WorkFoldPublicationActContext,
    command: string,
    spaceId: string | undefined,
    operation: () => Promise<{ detail: string; undoRef?: { kind: string; value: string } }>,
  ): Promise<void> {
    const base = {
      requestId: context.requestId,
      command,
      ...(spaceId ? { spaceId } : {}),
      ...(context.surface !== undefined ? { surface: context.surface } : {}),
      ...(context.decisionId !== undefined ? { decisionId: context.decisionId } : {}),
      ...(context.parentTaskId !== undefined ? { parentTaskId: context.parentTaskId } : {}),
      ...(context.browserId !== undefined ? { browserId: context.browserId } : {}),
      ...(context.grantId !== undefined ? { grantId: context.grantId } : {}),
    };
    const journaled = await this.#receipts.append({ ...base, outcome: "accepted" }).catch(() => false);
    if (!journaled) {
      throw new WorkFoldPublicationError(
        "JOURNAL_UNAVAILABLE",
        "work-fold could not journal this publication act, so nothing was changed.",
      );
    }
    try {
      const result = await operation();
      await this.#receipts.append({
        ...base,
        outcome: "ok",
        detail: result.detail,
        ...(result.undoRef ? { undoRef: result.undoRef } : {}),
      }).catch(() => false);
    } catch (error) {
      await this.#receipts.append({
        ...base,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      }).catch(() => false);
      throw error;
    }
  }

  async #syncSlot(publicationId: string): Promise<boolean> {
    const record = this.#record(publicationId);
    if (!this.#bridge) return false;
    try {
      await this.#bridge.upsertSlot({
        publicationId: record.publicationId,
        operationId: record.operationId,
        kind: record.kind,
        state: record.state,
        serveRatePerMinute: record.serveRatePerMinute,
        byteBudgetPerDay: record.byteBudgetPerDay,
        snapshotEnabled: record.snapshotEnabled,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      });
    } catch {
      return false;
    }
    const draft = structuredClone(this.#file);
    draftRecord(draft, publicationId).bridgeSlot = "confirmed";
    await this.#commit(draft).catch(() => undefined);
    return true;
  }

  async #cleanupSlot(publicationId: string): Promise<boolean> {
    if (!this.#bridge) return false;
    try {
      await this.#bridge.deleteSlot(publicationId);
      await this.#bridge.deleteSnapshot(publicationId).catch(() => undefined);
    } catch {
      return false;
    }
    await this.#keys.remove(publicationId).catch(() => undefined);
    const draft = structuredClone(this.#file);
    const record = draft.publications.find((candidate) => candidate.publicationId === publicationId);
    if (record) {
      record.bridgeCleanup = "ok";
      prunePublications(draft);
      await this.#commit(draft).catch(() => undefined);
    }
    return true;
  }

  #record(publicationId: string): WorkFoldPublicationRecord {
    const record = this.#file.publications.find((candidate) => candidate.publicationId === publicationId);
    if (!record) throw new WorkFoldPublicationError("NOT_FOUND", "No publication has this id.");
    return record;
  }

  #activeRecord(publicationId: string): WorkFoldPublicationRecord {
    const record = this.#record(publicationId);
    if (record.state === "revoked") {
      throw new WorkFoldPublicationError("ALREADY_REVOKED", "This page is no longer shared.");
    }
    return record;
  }

  #effectiveState(record: WorkFoldPublicationRecord): WorkFoldPublicationEffectiveState {
    if (record.state === "revoked") return "revoked";
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.#now().getTime()) return "expired";
    return "active";
  }

  #view(record: WorkFoldPublicationRecord): WorkFoldPublicationView {
    const state = this.#effectiveState(record);
    return {
      publicationId: record.publicationId,
      kind: record.kind,
      spaceId: record.spaceId,
      ...(record.relativePath !== undefined ? { relativePath: record.relativePath } : {}),
      ...(record.app ? { app: structuredClone(record.app) } : {}),
      title: record.title,
      state,
      live: state === "active" && record.bridgeSlot === "confirmed",
      serveRatePerMinute: record.serveRatePerMinute,
      byteBudgetPerDay: record.byteBudgetPerDay,
      snapshotEnabled: record.snapshotEnabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      bridgeSlot: record.bridgeSlot,
      ...(record.bridgeCleanup ? { bridgeCleanup: record.bridgeCleanup } : {}),
      ...(record.counters ? { counters: { ...record.counters } } : {}),
      ...(record.lastProblem ? { lastProblem: { ...record.lastProblem } } : {}),
      viewerPath: `${record.kind === "app" ? "/a/" : "/p/"}${record.publicationId}`,
    };
  }

  #assertOperational(): void {
    if (this.#damageReason !== null) {
      throw new WorkFoldPublicationError(
        "STORE_DAMAGED",
        `work-fold is not changing publications because its records could not be read: ${this.#damageReason}`,
      );
    }
  }

  async #commit(draft: PublicationsFileShape): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      throw new WorkFoldPublicationError("STORE_IO", "work-fold could not save its publication records.", { cause: error });
    }
    this.#file = draft;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

// --- Source binding and identity checks ---

interface InspectedSource {
  path: string;
  relativePath: string;
  extension: string;
  mediaType: WorkFoldPublicationMediaType;
  byteSize: number;
}

/**
 * One exact Space-relative file: containment, reserved-segment and
 * no-follow discipline via `resolveSpacePath`, a regular file at the end,
 * a closed-set type, and the pre-render size bound.
 */
async function inspectSource(spaceRoot: string, relativePath: string): Promise<InspectedSource> {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new WorkFoldPublicationError("SOURCE_INVALID", "A Space-relative file path is required.");
  }
  let path: string;
  try {
    path = resolveSpacePath(spaceRoot, relativePath);
  } catch (error) {
    throw new WorkFoldPublicationError(
      "SOURCE_INVALID",
      error instanceof Error ? error.message : "The designated file is outside this Space.",
      { cause: error },
    );
  }
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const extension = extensionOf(normalized);
  const mediaType = WORKFOLD_PUBLICATION_SOURCE_TYPES[extension];
  if (!mediaType) {
    throw new WorkFoldPublicationError(
      "SOURCE_INVALID",
      "Only Markdown, plain text, PNG, JPEG, and PDF files can be shared as a page in this slice.",
    );
  }
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile()) {
    throw new WorkFoldPublicationError("SOURCE_INVALID", "The designated file does not exist as a regular file.");
  }
  if (info.size > WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES) {
    throw new WorkFoldPublicationError("SOURCE_INVALID", "The designated file is larger than a shareable page (8 MiB).");
  }
  return { path, relativePath: normalized, extension, mediaType, byteSize: info.size };
}

function extensionOf(relativePath: string): string {
  const name = relativePath.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// --- The bounded closed-set renderer ---

interface PublicationPayload {
  v: 1;
  title: string;
  mediaType: WorkFoldPublicationMediaType;
  body: string;
  renderedAt: string;
}

function renderPublicationPayload(
  title: string,
  mediaType: WorkFoldPublicationMediaType,
  extension: string,
  bytes: Buffer,
  renderedAt: string,
): PublicationPayload {
  if (mediaType !== "text/html") {
    return { v: 1, title, mediaType, body: bytes.toString("base64url"), renderedAt };
  }
  const text = bytes.toString("utf8");
  const body = extension === ".txt"
    ? `<pre class="plain-text">${escapeHtml(text)}</pre>`
    : renderInertMarkdown(text);
  return { v: 1, title, mediaType: "text/html", body, renderedAt };
}

/**
 * Escape-first Markdown for rung-2 pages, matching the sanitization
 * properties of the bridge client's renderer: raw HTML is always escaped,
 * only http(s) links survive, and no event-handler or script vector exists
 * in the output. The viewer origin's CSP independently leaves any markup
 * inert; this renderer is the belt to that suspender.
 */
export function renderInertMarkdown(source: string): string {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1]!.trim().match(/^[A-Za-z0-9_+-]+$/)?.[0];
      blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTable(lines, index)) {
      const headers = tableCells(lines[index]!);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) {
        rows.push(tableCells(lines[index]!));
        index += 1;
      }
      const width = headers.length;
      blocks.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, column) => `<td>${renderInline(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInline(heading[2]!.replace(/\s+#+\s*$/, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      while (index < lines.length) {
        const match = tag === "ol"
          ? lines[index]!.match(/^\s{0,3}\d+[.)]\s+(.+)$/)
          : lines[index]!.match(/^\s{0,3}[-+*]\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${renderInline(match[1]!)}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = lines[index]!.match(/^\s{0,3}>\s?(.*)$/);
        if (!match) break;
        quoted.push(match[1]!);
        index += 1;
      }
      blocks.push(`<blockquote><p>${renderInline(quoted.join("\n"), true)}</p></blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join("\n"), true)}</p>`);
  }

  return blocks.join("");
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}[-+*]\s+/.test(line)
    || /^\s{0,3}\d+[.)]\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || isTable(lines, index);
}

function isTable(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !lines[index]!.includes("|")) return false;
  const headers = tableCells(lines[index]!);
  const delimiters = tableCells(lines[index + 1]!);
  return headers.length > 0
    && headers.length === delimiters.length
    && delimiters.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const tokenOpen = "\u0001";
const tokenClose = "\u0002";

function renderInline(source: string, preserveBreaks = false): string {
  const tokens: string[] = [];
  const stash = (html: string): string => `${tokenOpen}${tokens.push(html) - 1}${tokenClose}`;
  let text = String(source).replaceAll(tokenOpen, "").replaceAll(tokenClose, "");

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safeHref = safeWebUrl(href);
    if (!safeHref) return stash(escapeHtml(match));
    return stash(`<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, "$1<em>$2</em>");

  if (preserveBreaks) text = text.replace(/\n/g, "<br />");
  return text.replace(new RegExp(`${tokenOpen}(\\d+)${tokenClose}`, "g"), (_match, index: string) => tokens[Number(index)] ?? "");
}

function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- Store load, normalization, and bounds ---

async function loadPublicationsFile(path: string): Promise<{ file: PublicationsFileShape; damageReason: string | null }> {
  const empty: PublicationsFileShape = { schemaVersion: WORKFOLD_PUBLICATION_SCHEMA_VERSION, publications: [] };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: empty, damageReason: null };
    return { file: empty, damageReason: "the publication store could not be read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file: empty, damageReason: "the publication store is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file: empty, damageReason: "the publication store has an unexpected shape" };
  }
  const record = parsed as { schemaVersion?: unknown; publications?: unknown };
  if (record.schemaVersion !== WORKFOLD_PUBLICATION_SCHEMA_VERSION) {
    return { file: empty, damageReason: `the publication store has unsupported schema version ${String(record.schemaVersion)}` };
  }
  if (!Array.isArray(record.publications)) {
    return { file: empty, damageReason: "the publication store has an unexpected shape" };
  }
  const publications: WorkFoldPublicationRecord[] = [];
  for (const entry of record.publications) {
    const normalized = normalizeRecord(entry);
    // One unreadable record poisons the whole store: partially honoring a
    // damaged authority file could serve a page whose revocation was in the
    // part that no longer parses.
    if (!normalized) return { file: empty, damageReason: "the publication store contains an unreadable record" };
    publications.push(normalized);
  }
  return { file: { schemaVersion: WORKFOLD_PUBLICATION_SCHEMA_VERSION, publications }, damageReason: null };
}

function normalizeRecord(entry: unknown): WorkFoldPublicationRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Partial<WorkFoldPublicationRecord>;
  if (record.schemaVersion !== WORKFOLD_PUBLICATION_SCHEMA_VERSION) return null;
  if (!stableId(record.publicationId) || !stableText(record.spaceId, 160)) return null;
  if (record.kind === "page") {
    if (!stableText(record.relativePath, 1_024) || record.app !== undefined) return null;
  } else if (record.kind === "app") {
    // Hosted-app authority (rung 3): the binding pins are authority fields —
    // an unreadable binding poisons the store exactly as a damaged page
    // source would, and snapshot caching is structurally off for apps.
    if (record.relativePath !== undefined || !isAppBinding(record.app) || record.snapshotEnabled !== false) return null;
  } else {
    return null;
  }
  if (typeof record.title !== "string" || record.title.length > WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH) return null;
  if (record.state !== "active" && record.state !== "revoked") return null;
  if (!Number.isInteger(record.serveRatePerMinute) || !Number.isInteger(record.byteBudgetPerDay)) return null;
  if (typeof record.snapshotEnabled !== "boolean" || !isoTimestamp(record.createdAt) || !isoTimestamp(record.updatedAt)) return null;
  if (record.revokedAt !== undefined && !isoTimestamp(record.revokedAt)) return null;
  if (record.expiresAt !== undefined && !isoTimestamp(record.expiresAt)) return null;
  if (!stableId(record.operationId)) return null;
  if (record.bridgeSlot !== "pending" && record.bridgeSlot !== "confirmed") return null;
  if (record.bridgeCleanup !== undefined && record.bridgeCleanup !== "pending" && record.bridgeCleanup !== "ok") return null;
  const normalized = structuredClone(record) as WorkFoldPublicationRecord;
  // Counters and health notes are bookkeeping, not authority: an invalid
  // shape is dropped rather than poisoning the store the way a damaged
  // authority field must.
  const counters = normalized.counters as unknown;
  if (!isServeCounters(counters)) delete normalized.counters;
  const problem = normalized.lastProblem as unknown;
  if (!isPublicationProblem(problem)) delete normalized.lastProblem;
  return normalized;
}

const viewerSurfacePinPattern = /^[\x20-\x7e]{1,160}$/;

function isAppBinding(value: unknown): value is WorkFoldPublicationAppBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<WorkFoldPublicationAppBinding>;
  return stableId(binding.appInstanceId)
    && stableId(binding.releaseDigest)
    && stableText(binding.viewerEntry, 240)
    && Array.isArray(binding.viewerSurface)
    && binding.viewerSurface.length >= 1
    && binding.viewerSurface.length <= 32
    && binding.viewerSurface.every((pin) => typeof pin === "string" && viewerSurfacePinPattern.test(pin));
}

/** Activation-time validation of the consecrated binding, with typed refusals. */
function normalizeAppBinding(value: unknown): WorkFoldPublicationAppBinding {
  if (!isAppBinding(value)) {
    throw new WorkFoldPublicationError(
      "INPUT_INVALID",
      "A hosted-app exposure requires the pinned App Instance id, Release digest, viewer entry, and viewer surface.",
    );
  }
  return {
    appInstanceId: value.appInstanceId,
    releaseDigest: value.releaseDigest,
    viewerEntry: value.viewerEntry,
    viewerSurface: [...value.viewerSurface],
  };
}

function isServeCounters(value: unknown): value is WorkFoldPublicationServeCounters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counters = value as Partial<WorkFoldPublicationServeCounters>;
  return Number.isInteger(counters.served) && (counters.served as number) >= 0
    && Number.isInteger(counters.servedBytes) && (counters.servedBytes as number) >= 0
    && isoTimestamp(counters.lastServedAt);
}

function isPublicationProblem(value: unknown): value is WorkFoldPublicationProblem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const problem = value as Partial<WorkFoldPublicationProblem>;
  return (problem.state === "not-available" || problem.state === "resting")
    && typeof problem.reason === "string"
    && problem.reason.length > 0
    && problem.reason.length <= WORKFOLD_PUBLICATION_PROBLEM_REASON_MAX_LENGTH
    && isoTimestamp(problem.at);
}

function prunePublications(draft: PublicationsFileShape): void {
  const settled = draft.publications
    .filter((record) => record.state === "revoked" && record.bridgeCleanup === "ok")
    .sort((left, right) => compareStrings(left.revokedAt ?? left.updatedAt, right.revokedAt ?? right.updatedAt));
  const excess = settled.length - WORKFOLD_PUBLICATION_SETTLED_RETENTION;
  if (excess <= 0) return;
  const dropped = new Set(settled.slice(0, excess).map((record) => record.publicationId));
  draft.publications = draft.publications.filter((record) => !dropped.has(record.publicationId));
}

function recordHasPendingBridgeWork(record: WorkFoldPublicationRecord): boolean {
  if (record.state === "revoked") return record.bridgeCleanup !== "ok";
  return record.bridgeSlot !== "confirmed";
}

function draftRecord(draft: PublicationsFileShape, publicationId: string): WorkFoldPublicationRecord {
  const record = draft.publications.find((candidate) => candidate.publicationId === publicationId);
  if (!record) throw new WorkFoldPublicationError("NOT_FOUND", "No publication has this id.");
  return record;
}

function assertActContext(context: WorkFoldPublicationActContext): void {
  if (!context || typeof context.requestId !== "string" || !context.requestId.trim()) {
    throw new WorkFoldPublicationError("INPUT_INVALID", "A request id is required for a receipted publication act.");
  }
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH || /[\r\n]/.test(value)) {
    throw new WorkFoldPublicationError(
      "INPUT_INVALID",
      `A page title of 1 through ${WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH} characters is required.`,
    );
  }
  return value.trim();
}

function normalizeExpiry(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) return undefined;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) throw new WorkFoldPublicationError("INPUT_INVALID", "The publication expiry is not a valid timestamp.");
  if (time <= now.getTime()) throw new WorkFoldPublicationError("INPUT_INVALID", "The publication expiry is already in the past.");
  return new Date(time).toISOString();
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkFoldPublicationError("INPUT_INVALID", `A ${label} from ${minimum} through ${maximum} is required.`);
  }
  return value;
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function stableText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
