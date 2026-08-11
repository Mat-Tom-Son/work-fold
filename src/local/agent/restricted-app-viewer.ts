import { posix } from "node:path";

import { parseAppPlatformArtifactDigest } from "./app-platform-artifact.js";
import {
  restrictedAppViewerSurfacePins,
  type RestrictedAppManifest,
} from "./restricted-app-manifest.js";
import { snapshotRestrictedAppPackage } from "./restricted-app-package.js";
import type { RestrictedAppStorageJsonValue, RestrictedAppStorageOwner } from "./restricted-app-storage.js";

/**
 * The desktop viewer adapter for "an app at your address"
 * (docs/fold-publishing.md, rung 3). A viewer is an unauthenticated audience,
 * never a Principal: this adapter enforces the viewer-safe broker table
 * desktop-side, at effect time, over the same installed-instance authority
 * records the sandboxed desktop host uses — never in app code, never at the
 * relay. The closed call vocabulary is the entire reachable surface:
 *
 * - `entry` / `asset`: exact staged bytes of the installed Release revision,
 *   re-hashed against the install receipt on every serve, nothing else.
 * - `data.keys` / `data.get`: reads of instance-owned storage, and only under
 *   the key prefixes the reviewed manifest marks viewer-readable.
 *
 * Everything else is refused with a typed viewer-scope denial: storage
 * writes, Assistant actions and tool invocations, network egress,
 * connections and credentials, Space files, notifications, automations and
 * jobs, OAuth, and host-UI powers. Principal- and role-owned data is
 * structurally unreachable — the adapter builds only the instance-owned
 * storage owner and exposes no owner parameter (the host-derived-Principal
 * rule of src/local/agent/private-hosted-app-service.ts stays untouched).
 */

/** The closed, viewer-reachable call vocabulary. Nothing else exists. */
export type RestrictedAppViewerCall =
  | { kind: "entry" }
  | { kind: "asset"; path: string }
  | { kind: "data.keys"; prefix?: string }
  | { kind: "data.get"; key: string };

export const RESTRICTED_APP_VIEWER_CALL_KINDS = ["entry", "asset", "data.keys", "data.get"] as const;

/**
 * Broker families that exist for the person's own use of an installed app and
 * are never viewer-reachable. Named so refusals can say what was asked for
 * instead of pretending the call was malformed. The mapping is deliberately
 * broad: any spelling that resembles one of these families gets its family
 * denial, and every remaining unknown kind gets the generic viewer-scope
 * denial. Either way nothing executes.
 */
const VIEWER_DENIED_FAMILIES: ReadonlyArray<{ pattern: RegExp; denied: string }> = [
  { pattern: /^(data\.(set|delete|clear|transaction)|storage\.(set|delete|clear|transaction|write))$/, denied: "Viewers mutate nothing; storage writes are not viewer-reachable." },
  { pattern: /^(action|actions|invoke|tool|tools)([./].*)?$/, denied: "Assistant actions are mutations executed with the person's runtime; they are not viewer-reachable." },
  { pattern: /^(network|fetch|request|egress)([./].*)?$/, denied: "A viewer cannot make this desktop send requests anywhere; network egress is not viewer-reachable." },
  { pattern: /^(connection|connections|credential|credentials|oauth)([./].*)?$/, denied: "A viewer can never cause this desktop to spend a saved credential; connections are not viewer-reachable." },
  { pattern: /^(file|files)([./].*)?$/, denied: "Space file grants exist for the person's own use of the app; files are not viewer-reachable." },
  { pattern: /^(notification|notifications)([./].*)?$/, denied: "Notifications are not viewer-reachable." },
  { pattern: /^(automation|automations|job|jobs)([./].*)?$/, denied: "Viewers cannot run, schedule, or observe jobs." },
  { pattern: /^(tab|tabs|ui|window)([./].*)?$/, denied: "Host UI powers are meaningless outside the desktop shell and are not viewer-reachable." },
];

export type RestrictedAppViewerDenialCode = "viewer-scope" | "not-found" | "too-large";

/**
 * One served viewer answer: either the successful read, or a typed refusal
 * the audience may see. Refusals here are viewer-visible by design — they
 * ride inside the encrypted payload, so the relay stays content-free while
 * the app (and its author) gets an honest typed answer instead of a vague
 * page state.
 */
export type RestrictedAppViewerCallResult =
  | { ok: true; result: RestrictedAppViewerServedResult }
  | { ok: false; code: RestrictedAppViewerDenialCode; message: string };

export type RestrictedAppViewerServedResult =
  | { kind: "entry"; mediaType: "text/html"; bytes: string }
  | { kind: "asset"; path: string; mediaType: string; bytes: string }
  | { kind: "data.keys"; prefix: string; keys: string[] }
  | { kind: "data.get"; key: string; present: boolean; value?: RestrictedAppStorageJsonValue };

/**
 * A serve outcome distinguishes what the audience may know (`served`, with a
 * possibly-refusing payload) from what only the publisher may know
 * (`not-available` and its precise reason, surfaced through the glance).
 */
export type RestrictedAppViewerServeOutcome =
  | { state: "served"; result: RestrictedAppViewerCallResult }
  | { state: "not-available"; reason: string };

/**
 * The exposure identity pinned by the `publish.viewer.expose` consecration
 * (hosted-app shape): App Instance id, exact Release digest, viewer entry,
 * and the complete viewer-readable surface. The serve path re-verifies the
 * *surface* on every call — an update that kept the reviewed viewer surface
 * identical rides the normal update-review lane and keeps serving, while any
 * widened or moved surface stops serving until a fresh consecration.
 */
export interface RestrictedAppViewerExposurePins {
  appInstanceId: string;
  releaseDigest: string;
  viewerEntry: string;
  viewerSurface: string[];
}

/**
 * The installed-instance projection the adapter enforces over: the same
 * fields `RestrictedAppService.runtimeDescriptor` returns. The staged root
 * is re-hashed byte-exactly against the install receipt before any asset
 * leaves the desktop.
 */
export interface RestrictedAppViewerInstanceProjection {
  spaceId: string;
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: string;
  releaseDigest: string | null;
  runtimeInstanceKind: "development" | "app";
  manifest: RestrictedAppManifest;
  tenantId: string;
  runtimeInstanceId: string;
  featureInstallationId: string;
  dataNamespaceId: string;
  fileCount: number;
  totalBytes: number;
  stagedRoot: string;
}

/** Read-only storage seam; `FileRestrictedAppStorage` satisfies it. */
export interface RestrictedAppViewerStorageReads {
  keys(owner: RestrictedAppStorageOwner, prefix?: string): Promise<string[]>;
  get(owner: RestrictedAppStorageOwner, key: string): Promise<RestrictedAppStorageJsonValue | undefined>;
}

export interface RestrictedAppViewerAdapterOptions {
  /**
   * Resolves one installed App Instance by its machine-unique
   * `featureInstallationId`, across every registered Space. Absent means not
   * installed anywhere on this machine.
   */
  resolveInstance(appInstanceId: string): Promise<RestrictedAppViewerInstanceProjection | null>;
  storage: RestrictedAppViewerStorageReads;
  /** Per-asset plaintext bound; the publication service's ciphertext bound still applies after encryption. */
  maximumAssetBytes?: number;
}

export const RESTRICTED_APP_VIEWER_MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** What staging and decision-time recheck need to know about one exposable instance. */
export type RestrictedAppViewerExposure =
  | {
    eligible: true;
    spaceId: string;
    title: string;
    appId: string;
    pins: RestrictedAppViewerExposurePins;
  }
  | { eligible: false; issue: string };

export interface RestrictedAppViewerAdapter {
  /** Resolves the exposure identity for staging and for decision-time pin recheck. */
  resolveExposure(appInstanceId: string): Promise<RestrictedAppViewerExposure>;
  /** Serves one viewer call under the pinned surface, at effect time. */
  serve(pins: RestrictedAppViewerExposurePins, call: unknown): Promise<RestrictedAppViewerServeOutcome>;
}

const viewerAssetMediaTypes: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".pdf": "application/pdf",
});

/**
 * Fail-closed parse of one viewer call. Unknown shapes and kinds become
 * viewer-scope denials, with family-specific wording for the broker domains
 * the table explicitly forbids, so a probing app hears "never" instead of
 * "malformed".
 */
export function parseRestrictedAppViewerCall(value: unknown):
  | { call: RestrictedAppViewerCall }
  | { denial: { code: RestrictedAppViewerDenialCode; message: string } } {
  const denial = (message: string) => ({ denial: { code: "viewer-scope" as const, message } });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return denial("Viewer calls are typed objects from the closed viewer vocabulary (entry, asset, data.keys, data.get).");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || kind.length > 64) {
    return denial("Viewer calls name one kind from the closed viewer vocabulary (entry, asset, data.keys, data.get).");
  }
  for (const family of VIEWER_DENIED_FAMILIES) {
    if (family.pattern.test(kind)) return denial(family.denied);
  }
  if (kind === "entry") {
    if (Object.keys(record).length !== 1) return denial("A viewer entry call carries no further fields.");
    return { call: { kind: "entry" } };
  }
  if (kind === "asset") {
    if (Object.keys(record).some((key) => key !== "kind" && key !== "path")) {
      return denial("A viewer asset call carries only its packaged path.");
    }
    if (typeof record.path !== "string" || !record.path || record.path.length > 240) {
      return denial("A viewer asset call names one packaged file path.");
    }
    return { call: { kind: "asset", path: record.path } };
  }
  if (kind === "data.keys") {
    if (Object.keys(record).some((key) => key !== "kind" && key !== "prefix")) {
      return denial("A viewer data.keys call carries only an optional prefix.");
    }
    if (record.prefix !== undefined && (typeof record.prefix !== "string" || record.prefix.length > 256)) {
      return denial("A viewer data.keys prefix must be bounded text.");
    }
    return { call: { kind: "data.keys", ...(record.prefix !== undefined ? { prefix: record.prefix } : {}) } };
  }
  if (kind === "data.get") {
    if (Object.keys(record).some((key) => key !== "kind" && key !== "key")) {
      return denial("A viewer data.get call carries only its key.");
    }
    if (typeof record.key !== "string" || !record.key || record.key.length > 256) {
      return denial("A viewer data.get call names one storage key.");
    }
    return { call: { kind: "data.get", key: record.key } };
  }
  return denial(`"${kind}" is not viewer-reachable. Viewers may read the app's reviewed entry, its staged assets, and its viewer-readable data — nothing else.`);
}

export function createRestrictedAppViewerAdapter(options: RestrictedAppViewerAdapterOptions): RestrictedAppViewerAdapter {
  const maximumAssetBytes = options.maximumAssetBytes ?? RESTRICTED_APP_VIEWER_MAX_ASSET_BYTES;

  const resolveExposure = async (appInstanceId: string): Promise<RestrictedAppViewerExposure> => {
    if (typeof appInstanceId !== "string" || !appInstanceId.trim()) {
      return { eligible: false, issue: "An App Instance id is required." };
    }
    const instance = await options.resolveInstance(appInstanceId.trim());
    if (!instance) return { eligible: false, issue: "No installed App Instance has this id on this machine." };
    if (instance.runtimeInstanceKind !== "app" || instance.releaseDigest === null) {
      return { eligible: false, issue: "Only an installed App Instance of a prepared Release can be put at your address; local development previews cannot." };
    }
    const viewer = instance.manifest.viewer;
    if (!viewer) {
      return { eligible: false, issue: "This app's reviewed manifest declares no viewer surface, so it has nothing to serve to viewers." };
    }
    return {
      eligible: true,
      spaceId: instance.spaceId,
      title: instance.manifest.title,
      appId: instance.manifest.id,
      pins: {
        appInstanceId: instance.featureInstallationId,
        releaseDigest: instance.releaseDigest,
        viewerEntry: viewer.entry,
        viewerSurface: restrictedAppViewerSurfacePins(viewer),
      },
    };
  };

  const serve = async (pins: RestrictedAppViewerExposurePins, callValue: unknown): Promise<RestrictedAppViewerServeOutcome> => {
    // Parse first: a forbidden or malformed call is a viewer-visible typed
    // refusal even when the app behind it currently has a serve problem —
    // the denial matrix must not leak instance state.
    const parsed = parseRestrictedAppViewerCall(callValue);
    if ("denial" in parsed) {
      return { state: "served", result: { ok: false, ...parsed.denial } };
    }
    const call = parsed.call;
    const refused = (code: RestrictedAppViewerDenialCode, message: string): RestrictedAppViewerServeOutcome => (
      { state: "served", result: { ok: false, code, message } }
    );

    const instance = await options.resolveInstance(pins.appInstanceId);
    if (!instance) return { state: "not-available", reason: "its App Instance is no longer installed on this machine" };
    if (instance.runtimeInstanceKind !== "app" || instance.releaseDigest === null) {
      return { state: "not-available", reason: "its App Instance is no longer an installed Release" };
    }
    const viewer = instance.manifest.viewer;
    if (!viewer) {
      return { state: "not-available", reason: "the installed app no longer declares a viewer surface; put it at your address again after review" };
    }
    // Effect-time surface recheck: the reviewed viewer surface must equal the
    // consecrated pins exactly. An unchanged-surface update (new digest, same
    // surface) keeps serving; a widened or moved surface stops until a fresh
    // outward-exposure consecration approves it.
    if (viewer.entry !== pins.viewerEntry || !sameStringList(restrictedAppViewerSurfacePins(viewer), pins.viewerSurface)) {
      return {
        state: "not-available",
        reason: "the installed app's viewer surface changed after approval; approving the update's exposure is required",
      };
    }

    if (call.kind === "entry" || call.kind === "asset") {
      // Exact staged bytes of the installed Release revision: the snapshot
      // re-reads and re-hashes every staged byte against the install receipt,
      // so a tampered staging area refuses instead of serving.
      let files: ReadonlyMap<string, Uint8Array>;
      try {
        const snapshot = await snapshotRestrictedAppPackage({
          id: instance.manifest.id,
          packageName: instance.packageName,
          version: instance.version,
          digest: instance.digest,
          artifactDigest: parseAppPlatformArtifactDigest(instance.artifactDigest),
          stagedRoot: instance.stagedRoot,
          fileCount: instance.fileCount,
          totalBytes: instance.totalBytes,
          manifest: structuredClone(instance.manifest),
        });
        files = snapshot.files;
      } catch {
        return { state: "not-available", reason: "the installed app's staged bytes no longer match its install receipt" };
      }
      const path = call.kind === "entry" ? viewer.entry : normalizeViewerAssetPath(call.path);
      if (path === null) return refused("not-found", "No packaged file has this path.");
      const bytes = files.get(path);
      if (!bytes) return refused("not-found", "No packaged file has this path.");
      if (bytes.byteLength > maximumAssetBytes) {
        return refused("too-large", "This packaged file is larger than the viewer serving bound.");
      }
      const mediaType = viewerAssetMediaTypes[posix.extname(path).toLowerCase()] ?? "application/octet-stream";
      const encoded = Buffer.from(bytes).toString("base64url");
      return {
        state: "served",
        result: call.kind === "entry"
          ? { ok: true, result: { kind: "entry", mediaType: "text/html", bytes: encoded } }
          : { ok: true, result: { kind: "asset", path, mediaType, bytes: encoded } },
      };
    }

    // Instance-owned data only, and only under reviewed viewer-readable
    // prefixes. The owner is derived from the live install record; no call
    // field can name another owner class, tenant, or namespace.
    const owner: RestrictedAppStorageOwner = {
      ownerClass: "instance",
      tenantId: instance.tenantId as RestrictedAppStorageOwner["tenantId"],
      runtimeInstanceId: instance.runtimeInstanceId as RestrictedAppStorageOwner["runtimeInstanceId"],
      featureInstallationId: instance.featureInstallationId as RestrictedAppStorageOwner["featureInstallationId"],
      dataNamespaceId: instance.dataNamespaceId as RestrictedAppStorageOwner["dataNamespaceId"],
    };
    const readable = viewer.readable;
    if (call.kind === "data.get") {
      if (!readable.some((prefix) => call.key.startsWith(prefix))) {
        return refused("viewer-scope", "This key is outside the app's viewer-readable collections.");
      }
      try {
        const value = await options.storage.get(owner, call.key);
        return {
          state: "served",
          result: {
            ok: true,
            result: { kind: "data.get", key: call.key, present: value !== undefined, ...(value !== undefined ? { value } : {}) },
          },
        };
      } catch {
        return { state: "not-available", reason: "the app's viewer-readable data could not be read" };
      }
    }
    const prefix = call.prefix ?? "";
    try {
      const keys = (await options.storage.keys(owner, prefix))
        .filter((key) => readable.some((candidate) => key.startsWith(candidate)));
      return { state: "served", result: { ok: true, result: { kind: "data.keys", prefix, keys } } };
    } catch {
      return { state: "not-available", reason: "the app's viewer-readable data could not be read" };
    }
  };

  return { resolveExposure, serve };
}

/** Portable relative packaged path or null; mirrors the manifest's path rules without throwing. */
function normalizeViewerAssetPath(value: string): string | null {
  if (value.includes("\\") || value.includes(":") || value.includes("\0") || value.startsWith("/") || posix.isAbsolute(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
