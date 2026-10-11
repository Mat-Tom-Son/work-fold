import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  restrictedAppNotificationRecordLimits,
  type RestrictedAppNotificationRecordEntry,
  type RestrictedAppNotificationRecordStatus,
} from "../../shared/restricted-app-notification-record.js";

export type RestrictedAppNotificationRecordLimits = typeof restrictedAppNotificationRecordLimits;

/** What the notification broker reports for one `notifications.show` call it answered. */
export interface RestrictedAppNotificationOutcome {
  at: string;
  workFolderId: string;
  appId: string;
  featureInstallationId: string | null;
  digest: string;
  permissionId: string;
  title: string;
  status: RestrictedAppNotificationRecordStatus;
}

export interface RestrictedAppNotificationRecordOptions {
  /** `restricted-apps/notification-receipts.jsonl` under the state root in production. */
  path: string;
  now?: () => Date;
  /** Tests run small bounds; production uses the published ones. */
  limits?: Partial<RestrictedAppNotificationRecordLimits>;
}

const statuses: readonly RestrictedAppNotificationRecordStatus[] = ["shown", "rate-limited", "unsupported"];
const entryKeys = ["v", "id", "at", "workFolderId", "appId", "featureInstallationId", "digest", "permissionId", "title", "status"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A bounded, machine-local record of each app notification outcome: when,
 * which app and installation, which reviewed category and its title, and
 * whether it was shown, held back by the spam guard, or could not be shown on
 * this computer. Like the inference receipts it lives outside every
 * work-folder. Recording never stands between an app and its notification: a
 * line that cannot be written is lost, and a damaged line is skipped on read.
 */
export class RestrictedAppNotificationRecord extends EventEmitter {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #limits: RestrictedAppNotificationRecordLimits;
  #entries: RestrictedAppNotificationRecordEntry[] = [];
  #bytes = 0;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: RestrictedAppNotificationRecordOptions) {
    super();
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...restrictedAppNotificationRecordLimits, ...options.limits };
  }

  static async open(options: RestrictedAppNotificationRecordOptions): Promise<RestrictedAppNotificationRecord> {
    const record = new RestrictedAppNotificationRecord(options);
    await mkdir(dirname(options.path), { recursive: true });
    await record.#load();
    return record;
  }

  /** Appends one outcome; resolves once it is written. Never throws for a write failure. */
  async record(outcome: RestrictedAppNotificationOutcome): Promise<void> {
    const entry = entryValue({ v: 1, id: randomUUID(), ...outcome });
    if (!entry) return;
    const write = this.#queue.catch(() => undefined).then(async () => {
      const line = `${JSON.stringify(entry)}\n`;
      try {
        await appendFile(this.#path, line, { mode: 0o600 });
      } catch {
        return;
      }
      this.#entries.push(entry);
      this.#bytes += Buffer.byteLength(line, "utf8");
      if (this.#entries.length > this.#limits.records + Math.ceil(this.#limits.records / 20) || this.#bytes > this.#limits.journalBytes) {
        await this.#compact().catch(() => undefined);
      }
      this.emit("changed", { workFolderId: entry.workFolderId, appId: entry.appId, featureInstallationId: entry.featureInstallationId });
    });
    this.#queue = write;
    await write;
  }

  /** One installation's outcomes, newest first, across its code changes. */
  async list(
    scope: { workFolderId: string; appId: string; featureInstallationId: string },
    limit: number = this.#limits.listLimit,
  ): Promise<RestrictedAppNotificationRecordEntry[]> {
    await this.#queue.catch(() => undefined);
    const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, this.#limits.listLimit));
    const cutoff = this.#cutoff();
    const found: RestrictedAppNotificationRecordEntry[] = [];
    for (let index = this.#entries.length - 1; index >= 0 && found.length < bounded; index -= 1) {
      const entry = this.#entries[index]!;
      if (entry.workFolderId !== scope.workFolderId || entry.appId !== scope.appId
        || entry.featureInstallationId !== scope.featureInstallationId || Date.parse(entry.at) < cutoff) continue;
      found.push(structuredClone(entry));
    }
    return found;
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // An unreadable record is set aside rather than blocking the app.
      await rename(this.#path, `${this.#path}.damaged-${this.#now().toISOString().replace(/[:.]/g, "-")}`).catch(() => undefined);
      return;
    }
    let skipped = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { skipped = true; continue; }
      const entry = entryValue(parsed);
      if (entry) this.#entries.push(entry);
      else skipped = true;
    }
    this.#bytes = Buffer.byteLength(text, "utf8");
    const kept = this.#bounded();
    if (skipped || kept.length !== this.#entries.length || this.#bytes > this.#limits.journalBytes) {
      await this.#compact().catch(() => undefined);
    }
  }

  /** What the bounds keep: nothing past the age limit, then the newest per installation and overall. */
  #bounded(): RestrictedAppNotificationRecordEntry[] {
    const cutoff = this.#cutoff();
    const perInstallation = new Map<string, number>();
    const kept: RestrictedAppNotificationRecordEntry[] = [];
    for (let index = this.#entries.length - 1; index >= 0 && kept.length < this.#limits.records; index -= 1) {
      const entry = this.#entries[index]!;
      if (Date.parse(entry.at) < cutoff) continue;
      const key = JSON.stringify([entry.workFolderId, entry.appId, entry.featureInstallationId]);
      const count = perInstallation.get(key) ?? 0;
      if (count >= this.#limits.perInstallation) continue;
      perInstallation.set(key, count + 1);
      kept.push(entry);
    }
    return kept.reverse();
  }

  async #compact(): Promise<void> {
    const kept = this.#bounded();
    const text = kept.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#path);
      this.#entries = kept;
      this.#bytes = Buffer.byteLength(text, "utf8");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #cutoff(): number {
    return this.#now().getTime() - this.#limits.maxAgeDays * 24 * 60 * 60 * 1000;
  }
}

function entryValue(value: unknown): RestrictedAppNotificationRecordEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !entryKeys.includes(key)) || entryKeys.some((key) => !Object.hasOwn(record, key))) return null;
  const text = (field: unknown, maximum: number) => typeof field === "string" && field.length > 0 && field.length <= maximum;
  if (record.v !== 1 || typeof record.id !== "string" || !uuid.test(record.id)
    || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))
    || !text(record.workFolderId, 200) || !text(record.appId, 64)
    || !(record.featureInstallationId === null || text(record.featureInstallationId, 200))
    || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/.test(record.digest)
    || typeof record.permissionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.permissionId)
    || !text(record.title, 200)
    || !statuses.includes(record.status as RestrictedAppNotificationRecordStatus)) {
    return null;
  }
  return {
    v: 1,
    id: record.id,
    at: new Date(record.at as string).toISOString(),
    workFolderId: record.workFolderId as string,
    appId: record.appId as string,
    featureInstallationId: record.featureInstallationId as string | null,
    digest: record.digest,
    permissionId: record.permissionId,
    title: record.title as string,
    status: record.status as RestrictedAppNotificationRecordStatus,
  };
}
