import { restrictedAppAutomationIntervalMinutes } from "./restricted-app-manifest.js";
import { restrictedAppStorageLimits } from "./restricted-app-storage.js";

/**
 * Every bound a restricted app can hit at runtime, in one place the app can
 * read before it acts.
 *
 * These values are not secret and do not change for the lifetime of a mount, so
 * they are delivered as a mount argument rather than an IPC round trip. The
 * point of publishing them is that an app — and the agent writing one — can
 * design to the budget instead of discovering it by crashing into it: paginate
 * below the response limit, spill to a granted directory instead of overrunning
 * the storage quota, and choose an automation interval the host will accept.
 *
 * Values are composed from the live broker instances rather than restated, so a
 * host that configures a non-default bound cannot report a stale one.
 */
export interface RestrictedAppLimits {
  network: {
    maxRequestBytes: number;
    maxResponseBytes: number;
    timeoutMs: number;
    maxRedirects: number;
  };
  storage: {
    quotaBytes: number;
    maxKeys: number;
    maxKeyBytes: number;
    maxValueBytes: number;
    maxTransactionBytes: number;
    maxTransactionOperations: number;
  };
  files: {
    maxReadBytes: number;
    maxWriteBytes: number;
  };
  automations: {
    minimumIntervalMinutes: number;
    maximumIntervalMinutes: number;
  };
}

export interface RestrictedAppLimitsSource {
  network: RestrictedAppLimits["network"];
  files: RestrictedAppLimits["files"];
}

/**
 * The renderer sends a JSON envelope rather than the request body directly.
 * JSON can expand one UTF-8 byte into a six-byte `\u00xx` escape, while the
 * remaining valid request fields fit inside this fixed allowance.
 */
export function restrictedAppNetworkEnvelopeBytes(maxRequestBytes: number): number {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error("Restricted app network request limit is invalid.");
  }
  return maxRequestBytes * 6 + 64 * 1024;
}

/**
 * Storage's transaction limit already measures serialized JSON bytes; this
 * allowance covers the bridge operation wrapper without making the published
 * transaction budget unreachable.
 */
export const restrictedAppStorageEnvelopeBytes =
  restrictedAppStorageLimits.transactionBytes + 64 * 1024;

export function buildRestrictedAppLimits(source: RestrictedAppLimitsSource): RestrictedAppLimits {
  return {
    network: { ...source.network },
    storage: {
      quotaBytes: restrictedAppStorageLimits.appBytes,
      maxKeys: restrictedAppStorageLimits.keys,
      maxKeyBytes: restrictedAppStorageLimits.keyBytes,
      maxValueBytes: restrictedAppStorageLimits.valueBytes,
      maxTransactionBytes: restrictedAppStorageLimits.transactionBytes,
      maxTransactionOperations: restrictedAppStorageLimits.transactionOperations,
    },
    files: { ...source.files },
    automations: {
      minimumIntervalMinutes: restrictedAppAutomationIntervalMinutes.minimum,
      maximumIntervalMinutes: restrictedAppAutomationIntervalMinutes.maximum,
    },
  };
}
