/**
 * The machine-local record of what each app's notifications did
 * (docs/restricted-app-runtime.md, Worker host): one line per
 * `notifications.show` outcome, kept outside every work-folder. It names the
 * reviewed category and never the route or state the app attached.
 */
export type RestrictedAppNotificationRecordStatus = "shown" | "rate-limited" | "unsupported";

export interface RestrictedAppNotificationRecordEntry {
  v: 1;
  id: string;
  /** ISO time the host answered the call. */
  at: string;
  workFolderId: string;
  appId: string;
  /** The exact installation; null only for an owner recorded without one. */
  featureInstallationId: string | null;
  /** The revision that asked. */
  digest: string;
  /** The reviewed category id and its static title. */
  permissionId: string;
  title: string;
  status: RestrictedAppNotificationRecordStatus;
}

/**
 * Generous but bounded: a chatty app keeps its newest thousand, the whole
 * record keeps its newest twenty thousand, and nothing is kept past ninety
 * days.
 */
export const restrictedAppNotificationRecordLimits = Object.freeze({
  perInstallation: 1_000,
  records: 20_000,
  maxAgeDays: 90,
  /** Rewrites the file once it grows past this, keeping what the bounds allow. */
  journalBytes: 8 * 1024 * 1024,
  /** The most one read returns. */
  listLimit: 200,
});
