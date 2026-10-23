/**
 * What the person allowed or blocked for each site in the built-in browser
 * (docs/built-in-browser.md): one small machine-local JSON file beside the
 * browser profile, written atomically. A decision applies to one origin and
 * one kind of access, and the person can forget it from the browser toolbar.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { browserSitePermissions, type BrowserSitePermission, type BrowserSiteDecision } from "../../src/shared/browser.js";

type Decisions = Map<string, Map<BrowserSitePermission, BrowserSiteDecision>>;

export class BrowserSitePermissionStore {
  readonly #path: string;
  readonly #decisions: Decisions;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#decisions = readDecisions(path);
  }

  get(origin: string, kind: BrowserSitePermission): BrowserSiteDecision | null {
    return this.#decisions.get(origin)?.get(kind) ?? null;
  }

  /** Every saved decision for one site, in a stable order. */
  forSite(origin: string): Array<{ kind: BrowserSitePermission; decision: BrowserSiteDecision }> {
    const site = this.#decisions.get(origin);
    if (!site) return [];
    return browserSitePermissions.flatMap((kind) => {
      const decision = site.get(kind);
      return decision ? [{ kind, decision }] : [];
    });
  }

  set(origin: string, kinds: BrowserSitePermission[], decision: BrowserSiteDecision): Promise<void> {
    if (!isSiteOrigin(origin) || !kinds.length) return this.#writing;
    const site = this.#decisions.get(origin) ?? new Map<BrowserSitePermission, BrowserSiteDecision>();
    for (const kind of kinds) site.set(kind, decision);
    this.#decisions.set(origin, site);
    return this.#save();
  }

  forget(origin: string, kind: BrowserSitePermission): Promise<void> {
    const site = this.#decisions.get(origin);
    if (!site?.delete(kind)) return this.#writing;
    if (!site.size) this.#decisions.delete(origin);
    return this.#save();
  }

  /** Writes are queued so the file always holds the latest decisions. */
  #save(): Promise<void> {
    const snapshot = {
      version: 1,
      sites: Object.fromEntries([...this.#decisions].map(([origin, site]) => [origin, Object.fromEntries(site)])),
    };
    const write = async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    };
    this.#writing = this.#writing.then(write, write);
    return this.#writing;
  }
}

/** A web origin decisions can belong to: http(s) only, never a file or a blank page. */
export function isSiteOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
  } catch {
    return false;
  }
}

function readDecisions(path: string): Decisions {
  const decisions: Decisions = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or unreadable: every site asks again, which is the safe default.
    return decisions;
  }
  const sites = (parsed as { version?: unknown; sites?: unknown } | null)?.version === 1 ? (parsed as { sites?: unknown }).sites : null;
  if (!sites || typeof sites !== "object" || Array.isArray(sites)) return decisions;
  for (const [origin, value] of Object.entries(sites as Record<string, unknown>)) {
    if (!isSiteOrigin(origin) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const site = new Map<BrowserSitePermission, BrowserSiteDecision>();
    for (const [kind, decision] of Object.entries(value as Record<string, unknown>)) {
      if ((browserSitePermissions as readonly string[]).includes(kind) && (decision === "allow" || decision === "block")) {
        site.set(kind as BrowserSitePermission, decision);
      }
    }
    if (site.size) decisions.set(origin, site);
  }
  return decisions;
}
