import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, SettingsManager, type PackageSource, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import type { IncludedToolDefinition } from "../../shared/included-tools.js";
import { resolvePiRuntime, type PiRuntimeProvider, type ResolvedPiRuntime } from "./pi-runtime-config.js";
import { resolveIncludedResources } from "./included-tools.js";

export type NativeResourceKind = "extensions" | "skills" | "prompts" | "themes";
export interface NativeResource extends ResolvedResource { kind: NativeResourceKind; included?: IncludedToolDefinition }
const resourceKinds: NativeResourceKind[] = ["extensions", "skills", "prompts", "themes"];

/** Resolve Pi's inventory without importing executable resources or installing missing sources. */
export async function listNativeResources(spaceRoot: string, provider?: PiRuntimeProvider): Promise<NativeResource[]> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  return resolveNativeResources(spaceRoot, runtime);
}

export async function resolveNativeResources(spaceRoot: string, runtime: ResolvedPiRuntime): Promise<NativeResource[]> {
  const manager = new DefaultPackageManager({ cwd: spaceRoot, agentDir: runtime.agentDir, settingsManager: runtime.settingsManager });
  const paths = await manager.resolve(async () => "skip");
  const resources = resourceKinds.flatMap((kind) => paths[kind].map((resource) => ({ ...resource, kind })));
  // autoload:false describes a delta: Pi normally omits everything not named by
  // that delta. Resolve an all-negative baseline with Pi itself to expose those
  // disabled entries without changing the actual loader's selections or scopes.
  const known = new Set(resources.map(resourceKey));
  const dormant = await resolveDormantPackageResources(spaceRoot, runtime);
  return [
    ...resources,
    ...dormant.filter((resource) => !known.has(resourceKey(resource))),
    ...await resolveIncludedResources(spaceRoot, runtime),
  ];
}

async function resolveDormantPackageResources(spaceRoot: string, runtime: ResolvedPiRuntime): Promise<NativeResource[]> {
  const global = runtime.settingsManager.getGlobalSettings();
  const project = runtime.settingsManager.getProjectSettings();
  const trusted = runtime.settingsManager.isProjectTrusted();
  const packages = [...(global.packages ?? []), ...(trusted ? project.packages ?? [] : [])];
  if (!packages.some((entry) => typeof entry !== "string" && entry.autoload === false)) return [];
  const inventoryFilter = (entry: PackageSource): PackageSource => typeof entry === "string" || entry.autoload !== false
    ? entry : { ...entry, ...Object.fromEntries(resourceKinds.map((kind) => [kind, ["!**/*", ...(entry[kind] ?? [])]])) };
  const settings = SettingsManager.inMemory({ ...global, packages: global.packages?.map(inventoryFilter) }, { projectTrusted: trusted });
  if (trusted) settings.setProjectPackages((project.packages ?? []).map(inventoryFilter));
  const manager = new DefaultPackageManager({ cwd: spaceRoot, agentDir: runtime.agentDir, settingsManager: settings });
  const paths = await manager.resolve(async () => "skip");
  return resourceKinds.flatMap((kind) => paths[kind]
    .filter((resource) => resource.metadata.origin === "package" && !resource.enabled)
    .map((resource) => ({ ...resource, kind })));
}

function resourceKey(resource: NativeResource): string {
  // Pi resolves precedence before returning resources. A project delta must not
  // add a disabled duplicate of an already resolved, enabled global resource.
  return `${resource.kind}:${resolve(resource.path)}`;
}

/** Change exactly one native Pi filter; unrelated package patterns and scopes survive. */
export async function setNativeResourceEnabled(spaceRoot: string, input: {
  path: string; kind: NativeResourceKind; enabled: boolean; scope: "user" | "project";
}, provider?: PiRuntimeProvider): Promise<void> {
  const runtime = await resolvePiRuntime(spaceRoot, provider, { requestProjectTrust: false });
  if (input.scope === "project" && !runtime.projectTrust.trusted) throw new Error("Register this Space before changing its resources.");
  const resolved = await resolveNativeResources(spaceRoot, runtime);
  const resource = resolved.find((entry) => entry.kind === input.kind && resolve(entry.path) === resolve(input.path) && entry.metadata.scope === input.scope);
  if (!resource) throw new Error("This resource is no longer present in the selected scope. Refresh Skills & Extensions.");
  const settings = input.scope === "project" ? runtime.settingsManager.getProjectSettings() : runtime.settingsManager.getGlobalSettings();
  if (resource.metadata.origin === "package") {
    const packages = settings.packages ?? [];
    const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === resource.metadata.source);
    if (index < 0 || !resource.metadata.baseDir) throw new Error("The resource's owning Pi package is no longer configured.");
    const entry = packages[index]!;
    const manager = new DefaultPackageManager({ cwd: spaceRoot, agentDir: runtime.agentDir, settingsManager: runtime.settingsManager });
    const installedPath = manager.getInstalledPath(resource.metadata.source, input.scope);
    if (installedPath && (await stat(installedPath)).isFile()) {
      if (resource.enabled === input.enabled) return;
      // Pi deliberately treats a file-valued package source as one unconditional
      // Extension. Package filters cannot disable it; do not write a fake toggle.
      throw new Error("Pi cannot turn off an Extension configured as a single-file package. Remove that package, or configure the file as an Extension path in Pi settings to use resource controls.");
    }
    const config = typeof entry === "string" ? { source: entry } : { ...entry };
    if (typeof entry === "string") await preserveManifestDefaults(config, resource.metadata.baseDir);
    const path = relative(resource.metadata.baseDir, resource.path).split(sep).join("/");
    const previous = config[input.kind];
    // Pi's explicit [] means none, while a nonempty force-include filter
    // normally starts from all manifest resources. Keep the empty baseline.
    const baseline = previous?.length === 0 && config.autoload !== false ? ["!**/*"] : previous ?? [];
    config[input.kind] = replaceExactFilter(baseline, path, input.enabled, resource.metadata.baseDir, input.kind);
    const next = packages.map((item, offset) => offset === index ? config : item);
    if (input.scope === "project") runtime.settingsManager.setProjectPackages(next);
    else runtime.settingsManager.setPackages(next);
  } else {
    const path = resolve(resource.path);
    const baseDir = resource.metadata.baseDir ?? (input.scope === "project" ? join(spaceRoot, ".pi") : runtime.agentDir);
    const siblings = resolved.filter((entry) => entry.kind === input.kind && entry.metadata.scope === input.scope
      && entry.metadata.origin !== "package" && resolve(entry.path) !== path);
    const next = replaceExactFilter(settings[input.kind] ?? [], path, input.enabled, baseDir, input.kind, siblings);
    const project = input.scope === "project";
    switch (input.kind) {
      case "extensions": project ? runtime.settingsManager.setProjectExtensionPaths(next) : runtime.settingsManager.setExtensionPaths(next); break;
      case "skills": project ? runtime.settingsManager.setProjectSkillPaths(next) : runtime.settingsManager.setSkillPaths(next); break;
      case "prompts": project ? runtime.settingsManager.setProjectPromptTemplatePaths(next) : runtime.settingsManager.setPromptTemplatePaths(next); break;
      case "themes": project ? runtime.settingsManager.setProjectThemePaths(next) : runtime.settingsManager.setThemePaths(next); break;
    }
  }
  await runtime.settingsManager.flush();
}

async function preserveManifestDefaults(config: Exclude<PackageSource, string>, baseDir: string): Promise<void> {
  let manifest: Record<string, unknown> | undefined;
  try { manifest = (JSON.parse(await readFile(join(baseDir, "package.json"), "utf8")) as { pi?: Record<string, unknown> }).pi; }
  catch { return; }
  if (!manifest) return;
  // A string package honors only declared manifest kinds. A filtered object
  // falls back to convention folders for absent kinds; pin those absences so
  // switching one Extension off cannot silently add bundled, undeclared Skills.
  for (const kind of resourceKinds) if (manifest[kind] == null) config[kind] = [];
}

function matchesExactAlias(pattern: string, path: string, baseDir: string, kind: NativeResourceKind): boolean {
  const absolute = resolve(baseDir, path);
  const aliases = new Set([absolute]);
  if (kind === "skills" && basename(absolute) === "SKILL.md") aliases.add(dirname(absolute));
  return aliases.has(resolve(baseDir, pattern.slice(1).replaceAll("\\", "/")));
}

function replaceExactFilter(patterns: string[], path: string, enabled: boolean, baseDir: string, kind: NativeResourceKind, siblings: NativeResource[] = []): string[] {
  const removed = patterns.filter((pattern) => (pattern.startsWith("+") || pattern.startsWith("-"))
    && matchesExactAlias(pattern, path, baseDir, kind));
  const next = patterns.filter((pattern) => !removed.includes(pattern));
  // One Pi settings field is applied to .pi and ancestor .agents roots. A
  // relative Skill filter can match different files in each root. Anchor any
  // affected sibling's existing choice before removing that shared alias.
  for (const sibling of siblings) {
    if (removed.some((pattern) => sibling.enabled === pattern.startsWith("+")
      && matchesExactAlias(pattern, sibling.path, sibling.metadata.baseDir ?? baseDir, kind))) {
      const anchored = `${sibling.enabled ? "+" : "-"}${resolve(sibling.path)}`;
      if (!next.includes(anchored)) next.push(anchored);
    }
  }
  return [...next, `${enabled ? "+" : "-"}${path}`];
}
