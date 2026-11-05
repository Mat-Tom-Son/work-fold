/**
 * Backups to an S3-compatible bucket (docs/pages.md, "Page service"). Every
 * five minutes, each page database whose data revision moved since its last
 * backup is snapshotted and uploaded, and so is the registry when it changed.
 * A page's active document is uploaded once per revision, so a lost volume
 * can be restored without asking every owner to publish again. Each object
 * key holds the latest copy; keeping older copies is the bucket's job
 * (versioning or lifecycle rules).
 *
 *   <prefix>registry.sqlite
 *   <prefix>pages/<pageId>/data.sqlite
 *   <prefix>pages/<pageId>/rev-<n>.html
 */
import { rm } from "node:fs/promises";

import { shortPageId } from "./ids.js";
import type { S3Settings } from "./s3.js";
import { putObjectFile } from "./s3.js";
import type { PageStore } from "./store.js";

export interface BackupSettings extends S3Settings {
  /** Prepended to every key, e.g. `work-fold-pages/`. */
  prefix: string;
}

export interface BackupStatus {
  enabled: boolean;
  /** Set when some backup settings are present but not all of them. */
  problem?: string;
  intervalSeconds?: number;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  /** Uploads that failed in the last run; they are retried in the next. */
  failed?: number;
}

export interface BackupRunResult {
  uploaded: string[];
  failed: number;
}

export type Upload = (settings: BackupSettings, key: string, filePath: string, contentType: string) => Promise<void>;

const defaultUpload: Upload = (settings, key, filePath, contentType) => putObjectFile(settings, key, filePath, { contentType });

export class PageBackups {
  private running: Promise<BackupRunResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private failed = 0;

  constructor(
    private readonly store: PageStore,
    private readonly settings: BackupSettings | null,
    private readonly options: {
      intervalMs: number;
      problem?: string;
      upload?: Upload;
      now?: () => Date;
      log?: (record: Record<string, unknown>) => void;
    },
  ) {}

  get enabled(): boolean {
    return this.settings !== null;
  }

  start(): void {
    if (!this.settings || this.timer) return;
    this.timer = setInterval(() => { void this.run(); }, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  status(): BackupStatus {
    if (!this.settings) return { enabled: false, ...(this.options.problem ? { problem: this.options.problem } : {}) };
    return {
      enabled: true,
      intervalSeconds: Math.round(this.options.intervalMs / 1000),
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      failed: this.failed,
    };
  }

  /** One backup pass. Overlapping calls share the pass already running. */
  run(): Promise<BackupRunResult> {
    if (!this.settings) return Promise.resolve({ uploaded: [], failed: 0 });
    this.running ??= this.pass(this.settings).finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(settings: BackupSettings): Promise<BackupRunResult> {
    const upload = this.options.upload ?? defaultUpload;
    const now = this.options.now ?? (() => new Date());
    this.lastRunAt = now().toISOString();
    const uploaded: string[] = [];
    let failed = 0;
    let lastError: string | null = null;
    const attempt = async (key: string, label: string, snapshot: () => Promise<{ path: string; temporary: boolean }>, done: () => void) => {
      let file: { path: string; temporary: boolean } | null = null;
      try {
        file = await snapshot();
        await upload(settings, `${settings.prefix}${key}`, file.path, key.endsWith(".html") ? "text/html; charset=utf-8" : "application/vnd.sqlite3");
        done();
        uploaded.push(key);
      } catch (error) {
        failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        // /health is public: it says what failed, never where the bucket is.
        lastError = /^The (?:bucket|upload)\b/u.test(detail) ? detail : "The bucket couldn't be reached.";
        this.options.log?.({ event: "backup.failed", object: label, error: detail });
      } finally {
        if (file?.temporary) await rm(file.path, { force: true });
      }
    };

    for (const pageId of this.store.allPageIds()) {
      const page = this.store.getPage(pageId);
      if (!page) continue;
      const label = `pages/${shortPageId(pageId)}`;
      if (page.backupDataRevision !== page.dataRevision) {
        let dataRevision = page.dataRevision;
        await attempt(`pages/${pageId}/data.sqlite`, `${label}/data.sqlite`, async () => {
          const snapshot = this.store.snapshotPageData(pageId);
          dataRevision = snapshot.dataRevision;
          return { path: snapshot.path, temporary: true };
        }, () => this.store.markDataBackedUp(pageId, dataRevision));
      }
      if (page.backupRevision !== page.revision) {
        await attempt(`pages/${pageId}/rev-${page.revision}.html`, `${label}/rev-${page.revision}.html`, async () => (
          { path: this.store.documentPath(pageId, page.revision), temporary: false }
        ), () => this.store.markRevisionBackedUp(pageId, page.revision));
      }
    }
    if (this.store.backedUpRegistryRevision() !== this.store.registryRevision()) {
      let registryRevision = this.store.registryRevision();
      await attempt("registry.sqlite", "registry.sqlite", async () => {
        const snapshot = this.store.snapshotRegistry();
        registryRevision = snapshot.registryRevision;
        return { path: snapshot.path, temporary: true };
      }, () => this.store.markRegistryBackedUp(registryRevision));
    }
    this.failed = failed;
    this.lastError = lastError;
    if (!failed) this.lastSuccessAt = now().toISOString();
    return { uploaded, failed };
  }
}

/**
 * Backup settings from `WORKFOLD_PAGES_BACKUP_*`. All of endpoint, bucket,
 * access key id, and secret are needed; with none, backups are off; with only
 * some, they are off and `/health` says why.
 */
export function backupSettingsFromEnv(env: NodeJS.ProcessEnv): { settings: BackupSettings | null; problem?: string } {
  const read = (name: string) => env[`WORKFOLD_PAGES_BACKUP_${name}`]?.trim() ?? "";
  const required = {
    ENDPOINT: read("ENDPOINT"),
    BUCKET: read("BUCKET"),
    ACCESS_KEY_ID: read("ACCESS_KEY_ID"),
    SECRET_ACCESS_KEY: read("SECRET_ACCESS_KEY"),
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => `WORKFOLD_PAGES_BACKUP_${name}`);
  if (missing.length === Object.keys(required).length) return { settings: null };
  if (missing.length) return { settings: null, problem: `Backups are off: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.` };
  let endpoint: URL;
  try {
    endpoint = new URL(required.ENDPOINT);
  } catch {
    return { settings: null, problem: "Backups are off: WORKFOLD_PAGES_BACKUP_ENDPOINT isn't a URL." };
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return { settings: null, problem: "Backups are off: WORKFOLD_PAGES_BACKUP_ENDPOINT must be an http(s) URL." };
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/u.test(required.BUCKET)) return { settings: null, problem: "Backups are off: WORKFOLD_PAGES_BACKUP_BUCKET isn't a bucket name." };
  const prefix = read("PREFIX") || "work-fold-pages/";
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/u.test(prefix) || prefix.includes("..") || prefix.includes("//")) {
    return { settings: null, problem: "Backups are off: WORKFOLD_PAGES_BACKUP_PREFIX may hold only letters, digits, and / _ . -" };
  }
  return {
    settings: {
      endpoint: endpoint.origin,
      region: read("REGION") || "auto",
      bucket: required.BUCKET,
      accessKeyId: required.ACCESS_KEY_ID,
      secretAccessKey: required.SECRET_ACCESS_KEY,
      pathStyle: /^(?:1|true|yes)$/iu.test(read("PATH_STYLE")),
      prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
    },
  };
}
