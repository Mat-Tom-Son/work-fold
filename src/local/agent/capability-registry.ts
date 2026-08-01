import JSZip from "jszip";

export type CapabilityType = "skill" | "extension";
export type CapabilitySourceKind = "npm" | "git" | "bundle" | "reference";
export type CapabilitySort = "official" | "downloads" | "recent" | "name";

export interface CapabilityRegistryItem {
  id: string;
  name: string;
  description: string;
  types: CapabilityType[];
  sourceKind: CapabilitySourceKind;
  installSource?: string;
  /** First-party or authoritative reference source; never a safety verdict. */
  official: boolean;
  author?: string;
  version?: string;
  downloads?: number;
  publishedAt?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  npmUrl?: string;
  license?: string;
}

export interface CapabilityInstallScript {
  name: "preinstall" | "install" | "postinstall";
  command: string;
}

export interface CapabilityRegistryDetails extends CapabilityRegistryItem {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: CapabilityInstallScript[];
  dependencyCount?: number;
}

export interface CapabilityRegistrySearchOptions {
  query?: string;
  type?: "all" | CapabilityType;
  sort?: CapabilitySort;
  offset?: number;
  limit?: number;
}

export interface CapabilityRegistrySearchResult {
  items: CapabilityRegistryItem[];
  total: number;
  offset: number;
  limit: number;
  /** True when npm reported more matches than the bounded registry window. */
  truncated: boolean;
  diagnostics: string[];
}

export interface OfficialSkillBundle {
  fileName: string;
  bytes: Uint8Array;
  item: CapabilityRegistryItem;
}

export interface CapabilityRegistryService {
  search(options?: CapabilityRegistrySearchOptions): Promise<CapabilityRegistrySearchResult>;
  details(id: string): Promise<CapabilityRegistryDetails>;
  buildOfficialSkillBundle(id: string): Promise<OfficialSkillBundle>;
}

export interface CapabilityRegistryOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

interface NpmSearchResult {
  items: CapabilityRegistryItem[];
  truncated: boolean;
}

interface GitTreeEntry {
  path: string;
  mode?: string;
  type: "blob" | "tree" | string;
  size?: number;
}

interface OfficialPiSkill extends CapabilityRegistryItem {
  root: string;
}

interface OfficialPiSkillIndex {
  commit: string;
  tree: string;
  entries: GitTreeEntry[];
  skills: OfficialPiSkill[];
}

const npmSearchPageSize = 250;
/**
 * Discovery returns one bounded npm window per normalized query. The public
 * catalog is large enough that crawling every page makes the first result take
 * many seconds. npm performs the broad text match; work-fold then applies its
 * type filter and exact sort within this stable, cached window. `truncated`
 * tells callers when narrowing the query can reveal matches beyond the window.
 */
const npmSearchAttempts = 3;
const npmSearchRequestIntervalMs = 175;
const npmSearchThrottledIntervalMs = 1_100;
const maxSearchOffset = 10_000;
const maxSearchLimit = 50;
const maxQueryLength = 160;
const maxOfficialSkillCount = 128;
const maxOfficialSkillFiles = 512;
const maxOfficialSkillFileBytes = 5 * 1024 * 1024;
const maxOfficialBundleBytes = 25 * 1024 * 1024;
const officialSkillPrefix = "official:pi-skill:";
const piSkillsCommitUrl = "https://api.github.com/repos/badlogic/pi-skills/commits/main";
const gitObjectShaPattern = /^[0-9a-f]{40}$/i;

const staticDetails: readonly CapabilityRegistryDetails[] = [
  {
    id: "official:earendil-works/pi-review",
    name: "Pi Review",
    description: "A practical code-review workflow for Pi with prioritized findings and actionable follow-ups.",
    types: ["extension"],
    sourceKind: "git",
    installSource: "git:github.com/earendil-works/pi-review",
    official: true,
    author: "Earendil Works",
    repositoryUrl: "https://github.com/earendil-works/pi-review",
    homepageUrl: "https://github.com/earendil-works/pi-review#readme",
    license: "MIT",
    extensions: ["review.ts"],
  },
  {
    id: "official:earendil-works/pi-tutorial",
    name: "Pi Tutorial",
    description: "The experimental interactive tutorial Extension maintained by the Pi project.",
    types: ["extension"],
    sourceKind: "git",
    installSource: "git:github.com/earendil-works/pi-tutorial",
    official: true,
    author: "Earendil Works",
    repositoryUrl: "https://github.com/earendil-works/pi-tutorial",
    homepageUrl: "https://github.com/earendil-works/pi-tutorial#readme",
    license: "Apache-2.0",
    extensions: ["pi-onboarding-guide.ts"],
  },
  {
    id: "official:anthropics/skills",
    name: "Anthropic Skills",
    description: "Anthropic's public Agent Skills collection, including document and example Skill packs.",
    types: ["skill"],
    sourceKind: "git",
    installSource: "git:github.com/anthropics/skills",
    official: true,
    author: "Anthropic",
    repositoryUrl: "https://github.com/anthropics/skills",
    homepageUrl: "https://github.com/anthropics/skills#readme",
    skills: [
      "algorithmic-art",
      "brand-guidelines",
      "canvas-design",
      "claude-api",
      "doc-coauthoring",
      "docx",
      "frontend-design",
      "internal-comms",
      "mcp-builder",
      "pdf",
      "pptx",
      "skill-creator",
      "slack-gif-creator",
      "theme-factory",
      "web-artifacts-builder",
      "webapp-testing",
      "xlsx",
    ],
  },
  {
    id: "official:earendil-works/pi-extension-examples",
    name: "Pi Extension Examples",
    description: "The Pi project's reference implementations for tools, commands, lifecycle hooks, UI, providers, and sandboxes.",
    types: ["extension"],
    sourceKind: "reference",
    official: true,
    author: "Earendil Works",
    repositoryUrl: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions",
    homepageUrl: "https://pi.dev/docs/latest/extensions#examples-reference",
    license: "MIT",
  },
];

/**
 * Backend-only remote catalog. All network requests are generated internally
 * and checked against a narrow source allowlist; callers cannot provide URLs.
 */
export class RemoteCapabilityRegistry implements CapabilityRegistryService {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxResponseBytes: number;
  readonly #cache: PromiseCache;
  readonly #npmScheduler: RequestStartLimiter;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, 8_000, 100, 30_000);
    this.#cacheTtlMs = boundedInteger(options.cacheTtlMs, 5 * 60_000, 1, 60 * 60_000);
    this.#maxResponseBytes = boundedInteger(options.maxResponseBytes, 4 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
    this.#cache = new PromiseCache(128, options.now ?? Date.now);
    this.#npmScheduler = createRequestStartLimiter(npmSearchRequestIntervalMs);
    if (typeof this.#fetch !== "function") throw new Error("A fetch implementation is required for the capability registry.");
  }

  async search(options: CapabilityRegistrySearchOptions = {}): Promise<CapabilityRegistrySearchResult> {
    const query = normalizeQuery(options.query);
    const type = options.type ?? "all";
    const sort = options.sort ?? "official";
    const offset = boundedInteger(options.offset, 0, 0, maxSearchOffset);
    const limit = boundedInteger(options.limit, 24, 1, maxSearchLimit);
    if (!(["all", "skill", "extension"] as const).includes(type)) throw new Error(`Unsupported capability type: ${type}`);
    if (!(["official", "downloads", "recent", "name"] as const).includes(sort)) throw new Error(`Unsupported capability sort: ${sort}`);

    const [npmResult, piSkillsResult] = await Promise.allSettled([
      this.#loadNpmSearch(query),
      this.#loadOfficialPiSkills(),
    ]);
    const diagnostics: string[] = [];
    const npm = settledValue(npmResult, "The npm Pi package catalog is unavailable.", diagnostics);
    const piSkills = settledValue(piSkillsResult, "The official Pi Skills catalog is unavailable.", diagnostics);
    const combined = deduplicateItems([
      ...staticDetails.map(toItem),
      ...(piSkills?.skills.map(toItem) ?? []),
      ...(npm?.items ?? []),
    ]).filter((item) => matchesQuery(item, query) && (type === "all" || item.types.includes(type)));

    combined.sort(sortComparator(sort));
    return {
      items: combined.slice(offset, offset + limit).map(copyItem),
      total: combined.length,
      offset,
      limit,
      truncated: npm?.truncated ?? false,
      diagnostics,
    };
  }

  async details(id: string): Promise<CapabilityRegistryDetails> {
    const staticItem = staticDetails.find((item) => item.id === id);
    if (staticItem) return copyDetails(staticItem);
    if (id.startsWith(officialSkillPrefix)) {
      const { skill } = await this.#resolveOfficialSkill(id);
      return {
        ...copyItem(skill),
        skills: [skill.name],
        extensions: [],
        prompts: [],
        themes: [],
      };
    }
    if (id.startsWith("npm:")) return this.#loadNpmDetails(packageNameFromId(id));
    throw new Error(`Unknown capability: ${id}`);
  }

  async buildOfficialSkillBundle(id: string): Promise<OfficialSkillBundle> {
    const { skill, index } = await this.#resolveOfficialSkill(id);
    const prefix = `${skill.root}/`;
    const files = index.entries.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix));
    if (!files.some((entry) => entry.path === `${skill.root}/SKILL.md`)) {
      throw new Error(`The official Skill no longer contains ${skill.root}/SKILL.md.`);
    }
    if (files.length > maxOfficialSkillFiles) throw new Error("The official Skill contains too many files to bundle safely.");
    if (files.some((entry) => entry.mode === "120000")) throw new Error("Official Skill bundles cannot contain symbolic links.");
    const declaredBytes = files.reduce((total, entry) => total + (entry.size ?? 0), 0);
    if (declaredBytes > maxOfficialBundleBytes) throw new Error("The official Skill exceeds the bundle size limit.");

    const zip = new JSZip();
    const bundleRoot = safeBundleRoot(skill.name);
    let actualBytes = 0;
    for (const entry of files) {
      const relativePath = entry.path.slice(prefix.length);
      assertSafeRepositoryPath(relativePath);
      const bytes = await this.#readOfficialPiSkillFile(index.commit, entry.path, maxOfficialSkillFileBytes);
      actualBytes += bytes.byteLength;
      if (actualBytes > maxOfficialBundleBytes) throw new Error("The official Skill exceeds the bundle size limit.");
      zip.file(`${bundleRoot}/${relativePath}`, bytes, { binary: true });
    }
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    if (bytes.byteLength > maxOfficialBundleBytes) throw new Error("The generated Skill bundle exceeds the size limit.");
    return {
      fileName: `${bundleRoot}.skill`,
      bytes,
      item: copyItem(skill),
    };
  }

  async #loadNpmSearch(query: string): Promise<NpmSearchResult> {
    return this.#cache.get(`npm-search:${query}`, this.#cacheTtlMs, async () => {
      const text = ["keywords:pi-package", query].filter(Boolean).join(" ");
      const firstPage = await this.#loadNpmSearchPage(text, 0, this.#npmScheduler);
      return {
        items: deduplicateItems(firstPage.items),
        truncated: firstPage.total > firstPage.items.length,
      };
    });
  }

  async #loadNpmSearchPage(
    text: string,
    offset: number,
    scheduler: RequestStartLimiter,
  ): Promise<{ items: CapabilityRegistryItem[]; total: number }> {
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", text);
    url.searchParams.set("size", String(npmSearchPageSize));
    url.searchParams.set("from", String(offset));
    for (let attempt = 0; attempt < npmSearchAttempts; attempt += 1) {
      try {
        await scheduler.wait();
        const payload = asRecord(await this.#fetchJson(url));
        const objects = Array.isArray(payload.objects) ? payload.objects : [];
        const items = objects.flatMap(parseNpmSearchObject);
        const total = Math.max(0, Math.trunc(numberValue(payload.total) ?? items.length));
        return { items, total };
      } catch (error) {
        if (attempt + 1 >= npmSearchAttempts || !isTransientNpmSearchError(error)) throw error;
        if (isNpmRateLimitError(error)) scheduler.throttle(npmSearchThrottledIntervalMs);
        await delay(300 * (2 ** attempt));
      }
    }
    throw new Error("The npm Pi package catalog could not be read.");
  }

  async #loadNpmDetails(packageName: string): Promise<CapabilityRegistryDetails> {
    return this.#cache.get(`npm-details:${packageName}`, this.#cacheTtlMs, async () => {
      const url = new URL(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
      const manifest = asRecord(await this.#fetchJson(url));
      const manifestName = stringValue(manifest.name);
      if (manifestName !== packageName) throw new Error(`npm returned a mismatched package manifest for ${packageName}.`);
      const version = validNpmVersion(stringValue(manifest.version));
      if (!version) throw new Error(`npm returned an invalid package version for ${packageName}.`);
      const description = stringValue(manifest.description) ?? "No package description provided.";
      const pi = asRecord(manifest.pi);
      const skills = resourcePaths(pi.skills);
      const extensions = resourcePaths(pi.extensions);
      const prompts = resourcePaths(pi.prompts);
      const themes = resourcePaths(pi.themes);
      const scripts = asRecord(manifest.scripts);
      const repositoryUrl = normalizeRepositoryUrl(repositoryValue(manifest.repository));
      const types = inferTypes(stringArray(manifest.keywords), description, { skills, extensions });
      const installScripts = (["preinstall", "install", "postinstall"] as const).flatMap((name) => {
        const command = stringValue(scripts[name]);
        return command ? [{ name, command: command.slice(0, 4_000) }] : [];
      });
      const runtimeDependencies = new Set([
        ...Object.keys(asRecord(manifest.dependencies)),
        ...Object.keys(asRecord(manifest.optionalDependencies)),
      ]);
      return {
        id: `npm:${packageName}`,
        name: manifestName,
        description,
        types,
        sourceKind: "npm",
        // The approval UI describes this exact manifest. Pin installation to
        // that immutable npm version so a newly-published `latest` cannot run
        // different code or lifecycle scripts after review.
        installSource: `npm:${packageName}@${version}`,
        official: isOfficialNpmPackage(packageName),
        ...(authorFromPackage(manifest) ? { author: authorFromPackage(manifest) } : {}),
        version,
        ...(validDate(stringValue(manifest.date)) ? { publishedAt: stringValue(manifest.date) } : {}),
        ...(repositoryUrl ? { repositoryUrl } : {}),
        ...(safeHttpUrl(stringValue(manifest.homepage)) ? { homepageUrl: safeHttpUrl(stringValue(manifest.homepage)) } : {}),
        npmUrl: npmPackageUrl(packageName),
        ...(licenseValue(manifest.license) ? { license: licenseValue(manifest.license) } : {}),
        skills,
        extensions,
        prompts,
        themes,
        installScripts,
        dependencyCount: runtimeDependencies.size,
      };
    });
  }

  async #loadOfficialPiSkills(): Promise<OfficialPiSkillIndex> {
    return this.#cache.get("official-pi-skills", this.#cacheTtlMs, async () => {
      const commitPayload = asRecord(await this.#fetchJson(new URL(piSkillsCommitUrl)));
      const commit = requiredGitObjectSha(commitPayload.sha, "official Pi Skills commit");
      const tree = requiredGitObjectSha(asRecord(asRecord(commitPayload.commit).tree).sha, "official Pi Skills tree");
      const treeUrl = new URL(`https://api.github.com/repos/badlogic/pi-skills/git/trees/${tree}`);
      treeUrl.searchParams.set("recursive", "1");
      const treePayload = asRecord(await this.#fetchJson(treeUrl));
      if (treePayload.truncated === true) throw new Error("The official Pi Skills tree was truncated by GitHub.");
      if (requiredGitObjectSha(treePayload.sha, "returned official Pi Skills tree") !== tree) {
        throw new Error("The official Pi Skills tree response did not match the requested immutable tree.");
      }
      const entries = (Array.isArray(treePayload.tree) ? treePayload.tree : []).flatMap((value) => {
        const entry = asRecord(value);
        const path = stringValue(entry.path);
        const type = stringValue(entry.type);
        if (!path || !type) return [];
        assertSafeRepositoryPath(path);
        const normalized: GitTreeEntry = {
          path,
          type,
          ...(stringValue(entry.mode) ? { mode: stringValue(entry.mode) } : {}),
          ...(numberValue(entry.size) !== undefined ? { size: numberValue(entry.size) } : {}),
        };
        return [normalized];
      });
      const roots = entries
        .filter((entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md"))
        .map((entry) => entry.path.slice(0, -"/SKILL.md".length));
      if (roots.length > maxOfficialSkillCount) throw new Error("The official Pi Skills catalog exceeds its safe entry limit.");
      const skills: OfficialPiSkill[] = [];
      let failedSkills = 0;
      for (const root of roots) {
        try {
          const markdown = new TextDecoder().decode(await this.#readOfficialPiSkillFile(commit, `${root}/SKILL.md`, 512 * 1024));
          const frontmatter = parseFrontmatter(markdown);
          const name = frontmatter.name || root.split("/").at(-1) || root;
          if (!frontmatter.description) continue;
          skills.push({
            id: `${officialSkillPrefix}${encodeURIComponent(root)}`,
            name,
            description: frontmatter.description,
            types: ["skill"],
            sourceKind: "bundle",
            official: true,
            author: "Mario Zechner",
            version: commit.slice(0, 12),
            repositoryUrl: `https://github.com/badlogic/pi-skills/tree/${commit}/${encodeRepositoryPath(root)}`,
            homepageUrl: "https://github.com/badlogic/pi-skills#readme",
            license: frontmatter.license || "MIT",
            root,
          });
        } catch {
          failedSkills += 1;
          // A single malformed or temporarily unavailable Skill must not hide
          // the rest of the first-party collection.
        }
      }
      if (roots.length > 0 && failedSkills === roots.length) {
        throw new Error("None of the official Pi Skill manifests could be read.");
      }
      return { commit, tree, entries, skills };
    });
  }

  async #resolveOfficialSkill(id: string): Promise<{ skill: OfficialPiSkill; index: OfficialPiSkillIndex }> {
    if (!id.startsWith(officialSkillPrefix)) throw new Error(`Not an official Pi Skill id: ${id}`);
    let root: string;
    try {
      root = decodeURIComponent(id.slice(officialSkillPrefix.length));
    } catch {
      throw new Error(`Invalid official Pi Skill id: ${id}`);
    }
    assertSafeRepositoryPath(root);
    const index = await this.#loadOfficialPiSkills();
    const item = index.skills.find((skill) => skill.root === root);
    if (!item) throw new Error(`Unknown official Pi Skill: ${root}`);
    return { skill: item, index };
  }

  async #readOfficialPiSkillFile(commit: string, path: string, maxBytes: number): Promise<Uint8Array> {
    requiredGitObjectSha(commit, "official Pi Skills commit");
    assertSafeRepositoryPath(path);
    const url = new URL(`https://raw.githubusercontent.com/badlogic/pi-skills/${commit}/${encodeRepositoryPath(path)}`);
    return this.#cache.get(`official-file:${commit}:${path}`, this.#cacheTtlMs, () => this.#fetchBytes(url, maxBytes));
  }

  async #fetchJson(url: URL): Promise<unknown> {
    const bytes = await this.#fetchBytes(url, this.#maxResponseBytes);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`Capability source returned invalid JSON: ${url.host}`);
    }
  }

  async #fetchBytes(url: URL, maxBytes: number): Promise<Uint8Array> {
    assertAllowedSource(url);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        // Never follow a primary source to a host outside the allowlist.
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: url.host === "registry.npmjs.org" ? "application/json" : "application/vnd.github+json, text/plain;q=0.9",
          "user-agent": "work-fold-Capability-Registry",
        },
      });
      if (!response.ok) throw new Error(`Capability source returned HTTP ${response.status}: ${url.host}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Capability source response exceeds the ${maxBytes}-byte limit.`);
      }
      return readBoundedResponse(response, maxBytes);
    } catch (error) {
      if (timedOut) throw new Error(`Capability source timed out after ${this.#timeoutMs} ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Capability source response exceeds the ${maxBytes}-byte limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded").catch(() => undefined);
        throw new Error(`Capability source response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createCapabilityRegistry(options: CapabilityRegistryOptions = {}): CapabilityRegistryService {
  return new RemoteCapabilityRegistry(options);
}

class PromiseCache {
  readonly #entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(
    readonly maxEntries: number,
    readonly now: () => number,
  ) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(key);
    if (existing && existing.expiresAt > this.now()) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing.value as Promise<T>;
    }
    if (existing) this.#entries.delete(key);
    const value = load();
    this.#entries.set(key, { expiresAt: this.now() + ttlMs, value });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return value;
  }
}

function toItem(details: CapabilityRegistryDetails): CapabilityRegistryItem {
  return copyItem(details);
}

function copyItem(item: CapabilityRegistryItem): CapabilityRegistryItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    types: [...item.types],
    sourceKind: item.sourceKind,
    ...(item.installSource ? { installSource: item.installSource } : {}),
    official: item.official,
    ...(item.author ? { author: item.author } : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.downloads !== undefined ? { downloads: item.downloads } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.repositoryUrl ? { repositoryUrl: item.repositoryUrl } : {}),
    ...(item.homepageUrl ? { homepageUrl: item.homepageUrl } : {}),
    ...(item.npmUrl ? { npmUrl: item.npmUrl } : {}),
    ...(item.license ? { license: item.license } : {}),
  };
}

function copyDetails(details: CapabilityRegistryDetails): CapabilityRegistryDetails {
  return {
    ...copyItem(details),
    ...(details.skills ? { skills: [...details.skills] } : {}),
    ...(details.extensions ? { extensions: [...details.extensions] } : {}),
    ...(details.prompts ? { prompts: [...details.prompts] } : {}),
    ...(details.themes ? { themes: [...details.themes] } : {}),
    ...(details.installScripts ? { installScripts: details.installScripts.map((script) => ({ ...script })) } : {}),
    ...(details.dependencyCount !== undefined ? { dependencyCount: details.dependencyCount } : {}),
  };
}

function deduplicateItems(items: CapabilityRegistryItem[]): CapabilityRegistryItem[] {
  const found = new Map<string, CapabilityRegistryItem>();
  for (const item of items) if (!found.has(item.id)) found.set(item.id, item);
  return [...found.values()];
}

function matchesQuery(item: CapabilityRegistryItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase("en-US");
  return [item.name, item.description, item.author, item.id]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase("en-US").includes(needle));
}

function sortComparator(sort: CapabilitySort): (left: CapabilityRegistryItem, right: CapabilityRegistryItem) => number {
  const byName = (left: CapabilityRegistryItem, right: CapabilityRegistryItem) => left.name.localeCompare(right.name, "en", { sensitivity: "base" });
  if (sort === "name") return byName;
  if (sort === "downloads") return (left, right) => (right.downloads ?? 0) - (left.downloads ?? 0) || byName(left, right);
  if (sort === "recent") return (left, right) => dateNumber(right.publishedAt) - dateNumber(left.publishedAt) || byName(left, right);
  return (left, right) => Number(right.official) - Number(left.official)
    || (right.downloads ?? 0) - (left.downloads ?? 0)
    || byName(left, right);
}

function normalizeQuery(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxQueryLength);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: string, diagnostics: string[]): T | undefined {
  if (result.status === "fulfilled") return result.value;
  diagnostics.push(result.reason instanceof Error ? `${fallback} ${result.reason.message}` : fallback);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function resourcePaths(value: unknown): string[] {
  return stringArray(value).map((entry) => entry.trim()).slice(0, 1_000);
}

function inferTypes(
  keywords: string[],
  description: string,
  resources?: { skills: string[]; extensions: string[] },
): CapabilityType[] {
  const normalized = keywords.map((keyword) => keyword.toLocaleLowerCase("en-US"));
  const types: CapabilityType[] = [];
  if ((resources?.skills.length ?? 0) > 0 || normalized.some((keyword) => keyword === "skill" || keyword.includes("agent-skill") || keyword.includes("pi-skill"))) {
    types.push("skill");
  }
  if ((resources?.extensions.length ?? 0) > 0 || normalized.some((keyword) => keyword === "extension" || keyword.includes("pi-extension"))) {
    types.push("extension");
  }
  if (!types.includes("skill") && /\bskills?\b/i.test(description)) types.push("skill");
  if (!types.includes("extension") && /\bextensions?\b/i.test(description)) types.push("extension");
  // Search results do not include the complete manifest. Retain ambiguous Pi
  // packages in both filters until the latest manifest is inspected.
  return types.length ? types : ["skill", "extension"];
}

function parseNpmSearchObject(value: unknown): CapabilityRegistryItem[] {
  const object = asRecord(value);
  const pkg = asRecord(object.package);
  const name = stringValue(pkg.name);
  if (!name || !validNpmPackageName(name)) return [];
  const description = stringValue(pkg.description) ?? "No package description provided.";
  const keywords = stringArray(pkg.keywords);
  const links = asRecord(pkg.links);
  const downloads = numberValue(asRecord(object.downloads).monthly);
  const author = authorFromPackage(pkg);
  const version = validNpmVersion(stringValue(pkg.version));
  const publishedAt = stringValue(pkg.date);
  const repositoryUrl = normalizeRepositoryUrl(stringValue(links.repository) ?? repositoryValue(pkg.repository));
  const homepageUrl = safeHttpUrl(stringValue(links.homepage) ?? stringValue(pkg.homepage));
  return [{
    id: `npm:${name}`,
    name,
    description,
    types: inferTypes(keywords, description),
    sourceKind: "npm",
    ...(version ? { installSource: `npm:${name}@${version}` } : {}),
    official: isOfficialNpmPackage(name),
    ...(author ? { author } : {}),
    ...(version ? { version } : {}),
    ...(downloads !== undefined ? { downloads } : {}),
    ...(validDate(publishedAt) ? { publishedAt } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(homepageUrl ? { homepageUrl } : {}),
    npmUrl: safeHttpUrl(stringValue(links.npm)) ?? npmPackageUrl(name),
    ...(stringValue(pkg.license) ? { license: stringValue(pkg.license) } : {}),
  }];
}

function isTransientNpmSearchError(error: unknown): boolean {
  return error instanceof Error && /HTTP (?:429|500|502|503|504)\b/.test(error.message);
}

function isNpmRateLimitError(error: unknown): boolean {
  return error instanceof Error && /HTTP 429\b/.test(error.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface RequestStartLimiter {
  wait(): Promise<void>;
  throttle(intervalMs: number): void;
}

function createRequestStartLimiter(initialIntervalMs: number): RequestStartLimiter {
  let nextStart = 0;
  let intervalMs = initialIntervalMs;
  let queue = Promise.resolve();
  return {
    wait() {
      const scheduled = queue.then(async () => {
        const waitMs = Math.max(0, nextStart - Date.now());
        if (waitMs > 0) await delay(waitMs);
        nextStart = Date.now() + intervalMs;
      });
      queue = scheduled.catch(() => undefined);
      return scheduled;
    },
    throttle(nextIntervalMs) {
      intervalMs = Math.max(intervalMs, nextIntervalMs);
      nextStart = Math.max(nextStart, Date.now() + intervalMs);
    },
  };
}

function authorFromPackage(pkg: Record<string, unknown>): string | undefined {
  const author = pkg.author;
  if (typeof author === "string") return stringValue(author);
  const authorRecord = asRecord(author);
  const publisher = asRecord(pkg.publisher);
  return stringValue(authorRecord.name) ?? stringValue(publisher.username) ?? stringValue(publisher.name);
}

function repositoryValue(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  return stringValue(asRecord(value).url);
}

function licenseValue(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  return stringValue(asRecord(value).type);
}

function normalizeRepositoryUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let normalized = value.trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git(?:#.*)?$/, "");
  if (/^github\.com\//i.test(normalized)) normalized = `https://${normalized}`;
  return safeHttpUrl(normalized);
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
}

function validNpmPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name) && name.length <= 214;
}

function validNpmVersion(value: string | undefined): string | undefined {
  return value && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : undefined;
}

function packageNameFromId(id: string): string {
  const packageName = id.slice("npm:".length);
  if (!validNpmPackageName(packageName)) throw new Error(`Invalid npm capability id: ${id}`);
  return packageName;
}

function isOfficialNpmPackage(name: string): boolean {
  return name.startsWith("@earendil-works/");
}

function validDate(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function dateNumber(value: string | undefined): number {
  return value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

function requiredGitObjectSha(value: unknown, label: string): string {
  const sha = stringValue(value);
  if (!sha || !gitObjectShaPattern.test(sha)) throw new Error(`GitHub returned an invalid ${label} SHA.`);
  return sha.toLocaleLowerCase("en-US");
}

function assertAllowedSource(url: URL): void {
  if (url.protocol !== "https:") throw new Error(`Capability source must use HTTPS: ${url.host}`);
  if (url.host === "registry.npmjs.org") {
    if (url.pathname === "/-/v1/search" || url.pathname.endsWith("/latest")) return;
  }
  if (url.host === "api.github.com" && url.pathname === "/repos/badlogic/pi-skills/commits/main") return;
  if (url.host === "api.github.com" && /^\/repos\/badlogic\/pi-skills\/git\/trees\/[0-9a-f]{40}$/i.test(url.pathname)) return;
  if (url.host === "raw.githubusercontent.com" && /^\/badlogic\/pi-skills\/[0-9a-f]{40}\//i.test(url.pathname)) return;
  throw new Error(`Capability source is not allowlisted: ${url.toString()}`);
}

function assertSafeRepositoryPath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("\\")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\u0000"))) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
}

function encodeRepositoryPath(path: string): string {
  assertSafeRepositoryPath(path);
  return path.split("/").map(encodeURIComponent).join("/");
}

function safeBundleRoot(name: string): string {
  const safe = name.toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return safe || "pi-skill";
}

function parseFrontmatter(markdown: string): { name?: string; description?: string; license?: string } {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    let value = field[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const continuations: string[] = [];
      while (index + 1 < lines.length && /^(?:\s+.*|\s*)$/.test(lines[index + 1]) && !/^\S/.test(lines[index + 1])) {
        index += 1;
        continuations.push(lines[index].trim());
      }
      value = folded ? continuations.filter(Boolean).join(" ") : continuations.join("\n").trim();
    }
    fields[key] = unquoteYamlScalar(value);
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.license ? { license: fields.license } : {}),
  };
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
