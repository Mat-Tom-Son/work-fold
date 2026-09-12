import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { McpConfig, ServerEntry } from "pi-mcp-adapter/types";

export type IncludedMcpScope = "global" | "project";
export type IncludedMcpDefinition = ServerEntry;
export interface IncludedMcpPaths { agentDir: string; cwd?: string; }
export interface IncludedMcpSelection { scope: IncludedMcpScope; name: string; expectedRevision?: string; }
export interface IncludedMcpServer extends IncludedMcpSelection {
  path: string;
  transport: "stdio" | "http" | "socket";
  endpoint: string;
  disabled: boolean;
  auth: "none" | "oauth" | "bearer" | "automatic";
  credential: "not_checked" | "present" | "expired" | "missing" | "unavailable";
  /** Configuration identities and names only; no arguments, headers or env values. */
  revision: string;
  environmentKeys: string[];
  headerKeys: string[];
}
export interface IncludedMcpOAuthJob {
  id: string;
  state: "running" | "connected" | "cancelled" | "failed";
  message?: string;
}
export interface IncludedMcpProbe {
  state: "ready" | "setup_required" | "empty" | "error" | "cancelled";
  detail: string;
  checkedAt: string;
  tools: number;
  resources: number;
  prompts: number;
}
export interface IncludedMcpSetupOptions extends IncludedMcpPaths {
  openAuthorizationUrl(url: string): void | Promise<void>;
  /** The host fences active native sessions before changing a connection. */
  withMutation?<T>(selection: IncludedMcpSelection, operation: () => Promise<T>): Promise<T>;
}
interface OAuthRuntime { readonly signal: AbortSignal }
interface CredentialStatus { status: "present" | "expired" | "missing" | "url-mismatch" | "unavailable"; message?: string; }
interface SetupApi {
  McpServerManager: new(cwd?: string) => {
    setRuntimeSignal(signal: AbortSignal): void;
    setDefaultRequestTimeoutMs(timeout: number): void;
    setAuthStorageOptions(options: { baseDir: string }): void;
    setOAuthRuntime(runtime: OAuthRuntime): void;
    connect(name: string, definition: ServerEntry, signal: AbortSignal): Promise<{ status: string; tools: unknown[]; resources: unknown[]; prompts: unknown[] }>;
    closeAll(): Promise<void>;
  };
  loadMcpConfigFromFiles(paths: readonly string[]): McpConfig;
  mergeMcpConfigs(base: McpConfig, next: McpConfig): McpConfig;
  writeSharedServerEntry(path: string, name: string, definition: ServerEntry): string;
  removeSharedServerEntry(path: string, name: string): string;
  withAgentDir<T>(agentDir: string, action: () => T): T;
  createOAuthRuntime(signal?: AbortSignal): OAuthRuntime;
  shutdownOAuth(runtime: OAuthRuntime): Promise<void>;
  authenticate(name: string, url: string, definition: ServerEntry, options: { runtime: OAuthRuntime; signal: AbortSignal; authStorageOptions: { baseDir: string }; openAuthorizationUrl(url: string): void | Promise<void>; withSaveTokens(persist: () => void): Promise<void> }): Promise<string>;
  inspectOAuthForUrl(name: string, url: string, options: { baseDir: string }): CredentialStatus;
  inspectBearerTokenForUrl(name: string, url: string): CredentialStatus;
  saveBearerTokenForUrl(name: string, token: string, url: string): void;
  removeBearerToken(name: string): void;
  removeAuth(name: string, options: { runtime: OAuthRuntime; authStorageOptions: { baseDir: string } }): Promise<void>;
}
// The adapter is a native Pi TypeScript Extension. Use Pi's existing loader
// dependency at this trusted host seam too; compiled Electron never imports TS
// directly from node_modules and no second adapter implementation is bundled.
let setupApi: Promise<SetupApi> | undefined;
async function upstream(): Promise<SetupApi> {
  return setupApi ??= (async () => {
    const require = createRequire(import.meta.url);
    const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = piRequire("jiti") as { createJiti(path: string, options: object): { import<T>(path: string): Promise<T> } };
    return createJiti(import.meta.url, { interopDefault: false }).import<SetupApi>(require.resolve("pi-mcp-adapter/setup"));
  })();
}
function readConfig(api: SetupApi, paths: readonly string[]): McpConfig {
  try { return api.loadMcpConfigFromFiles(paths); }
  catch { throw new Error("The native MCP configuration could not be read. Check the mcp.json file's JSON format and file permissions."); }
}
function writeEntry(api: SetupApi, path: string, name: string, definition: ServerEntry): void {
  try { api.writeSharedServerEntry(path, name, definition); }
  catch { throw new Error("The native MCP configuration could not be saved. Check its JSON format and file permissions."); }
}
function removeEntry(api: SetupApi, path: string, name: string): void {
  try { api.removeSharedServerEntry(path, name); }
  catch { throw new Error("The native MCP configuration could not be updated. Check its JSON format and file permissions."); }
}
export function includedMcpConfigPath(paths: IncludedMcpPaths, scope: IncludedMcpScope): string {
  if (scope === "global") return join(resolve(paths.agentDir), "mcp.json");
  if (scope !== "project" || !paths.cwd) throw new Error("Choose a registered Space for a Space-only connection.");
  return join(resolve(paths.cwd), ".pi", "mcp.json");
}
export async function loadIncludedMcpConfig(paths: IncludedMcpPaths): Promise<McpConfig> {
  const api = await upstream();
  let config: McpConfig = { mcpServers: {} };
  for (const scope of ["global", ...(paths.cwd ? ["project"] : [])] as IncludedMcpScope[]) {
    const path = includedMcpConfigPath(paths, scope);
    const local = readConfig(api, [path]);
    const mcpServers = Object.fromEntries(Object.entries(local.mcpServers).map(([name, definition]) => [name, {
      ...definition, ...(definition.url ? { credentialId: credentialId(path, name, definition) } : {}),
    }]));
    config = api.mergeMcpConfigs(config, { ...local, mcpServers });
  }
  return {
    mcpServers: config.mcpServers,
    settings: {
      ...config.settings,
      autoAuth: false,
      // Pi 0.80.6 has no ModelRegistry.complete transport used by this upstream
      // sampling implementation. Never advertise an unverified model bridge.
      sampling: false,
      oauthDir: join(resolve(paths.agentDir), "mcp-oauth"),
      notifyOnStartupConnect: false,
      hostConfigDiscovery: "off",
    },
  };
}
function validateName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || name === "constructor" || name === "prototype") throw new Error("Use a service name starting with a letter, containing up to 64 letters, digits, underscores or hyphens.");
}
function validateDefinition(value: ServerEntry): ServerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a standard MCP server definition.");
  const definition = structuredClone(value);
  const endpoints = [definition.command, definition.url, definition.socket].filter((item) => typeof item === "string" && item.trim());
  if (endpoints.length !== 1) throw new Error("Choose one MCP transport: a command, HTTP URL, or socket.");
  if (definition.url) {
    const url = new URL(definition.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) service URL without an embedded username or password.");
  }
  if (definition.args && (!Array.isArray(definition.args) || definition.args.some((value) => typeof value !== "string"))) throw new Error("Command arguments must be a list of strings.");
  for (const values of [definition.env, definition.headers]) if (values && (typeof values !== "object" || Array.isArray(values) || Object.values(values).some((value) => typeof value !== "string"))) throw new Error("Environment and header values must be strings.");
  if (definition.bearerToken !== undefined) throw new Error("Use Connect with a token to save bearer credentials in the secure store.");
  return definition;
}
function credentialId(path: string, name: string, definition: ServerEntry): string {
  return "work-fold-" + createHash("sha256").update(JSON.stringify([resolve(path), name, definition.url ?? ""])).digest("hex").slice(0, 40);
}
function revision(definition: ServerEntry): string { return createHash("sha256").update(JSON.stringify(definition)).digest("hex"); }
function displayEndpoint(definition: ServerEntry): string {
  if (!definition.url) return definition.command ?? definition.socket ?? "Unconfigured";
  try { const url = new URL(definition.url); url.username = ""; url.password = ""; if (url.search) url.search = "?…"; url.hash = ""; return url.href; } catch { return "Invalid service URL"; }
}

/** Trusted, local setup service. No operation or secret is an Assistant tool. */
export function createIncludedMcpSetup(options: IncludedMcpSetupOptions) {
  const paths = { agentDir: resolve(options.agentDir), ...(options.cwd ? { cwd: resolve(options.cwd) } : {}) };
  const authStorageOptions = { baseDir: join(paths.agentDir, "mcp-oauth") };
  const jobs = new Map<string, { public: IncludedMcpOAuthJob; selection: IncludedMcpSelection; controller: AbortController; runtime: OAuthRuntime; settled: Promise<void> }>();
  const probes = new Map<AbortController, Promise<void>>();
  let disposed = false;
  function assertOpen() { if (disposed) throw new Error("This connection setup has closed."); }
  async function selected(selection: IncludedMcpSelection) {
    assertOpen(); validateName(selection.name);
    const api = await upstream(); assertOpen();
    const path = includedMcpConfigPath(paths, selection.scope);
    const definition = readConfig(api, [path]).mcpServers[selection.name];
    if (!definition) throw new Error("This service definition no longer exists. Refresh connections.");
    if (selection.expectedRevision !== undefined && selection.expectedRevision !== revision(definition)) throw new Error("This service changed. Refresh connections before continuing.");
    return { api, path, definition };
  }
  async function cancelFor(selection: IncludedMcpSelection) {
    for (const job of jobs.values()) if (job.selection.scope === selection.scope && job.selection.name === selection.name && job.public.state === "running") {
      job.public.state = "cancelled"; job.controller.abort(); await job.settled;
    }
  }
  async function mutate<T>(selection: IncludedMcpSelection, operation: () => Promise<T>): Promise<T> {
    assertOpen(); if (selection.expectedRevision !== undefined) await selected(selection); await cancelFor(selection);
    const run = async () => { assertOpen(); return operation(); };
    return options.withMutation ? options.withMutation(selection, run) : run();
  }
  return {
    async list({ inspectCredentials = false }: { inspectCredentials?: boolean } = {}): Promise<IncludedMcpServer[]> {
      assertOpen(); const api = await upstream(); const results: IncludedMcpServer[] = [];
      for (const scope of ["global", ...(paths.cwd ? ["project"] : [])] as IncludedMcpScope[]) {
        const path = includedMcpConfigPath(paths, scope);
        for (const [name, definition] of Object.entries(readConfig(api, [path]).mcpServers)) {
          const auth = definition.auth === false || definition.oauth === false ? "none" : definition.auth ?? (definition.command || definition.socket ? "none" : "automatic");
          let credential: IncludedMcpServer["credential"] = "not_checked";
          if (inspectCredentials && definition.url && auth !== "none") {
            const status = api.withAgentDir(paths.agentDir, () => auth === "bearer" ? api.inspectBearerTokenForUrl(credentialId(path, name, definition), definition.url!) : api.inspectOAuthForUrl(credentialId(path, name, definition), definition.url!, authStorageOptions));
            credential = status.status === "url-mismatch" ? "missing" : status.status;
          }
          results.push({ scope, name, path, transport: definition.url ? "http" : definition.socket ? "socket" : "stdio", endpoint: displayEndpoint(definition), disabled: definition.disabled === true, auth, credential, revision: revision(definition), environmentKeys: Object.keys(definition.env ?? {}), headerKeys: Object.keys(definition.headers ?? {}) });
        }
      }
      return results;
    },
    async probe(selection: IncludedMcpSelection, { signal }: { signal?: AbortSignal } = {}): Promise<IncludedMcpProbe> {
      const { api, path, definition } = await selected(selection);
      const empty = { checkedAt: new Date().toISOString(), tools: 0, resources: 0, prompts: 0 };
      if (definition.disabled) return { ...empty, state: "setup_required", detail: "Enable this service to check its connection." };
      const controller = new AbortController();
      let finished!: () => void;
      probes.set(controller, new Promise<void>((resolve) => { finished = resolve; }));
      const owned = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
      const runtime = api.createOAuthRuntime(owned);
      const manager = new api.McpServerManager(paths.cwd ?? paths.agentDir);
      manager.setRuntimeSignal(owned); manager.setDefaultRequestTimeoutMs(15_000);
      manager.setAuthStorageOptions(authStorageOptions); manager.setOAuthRuntime(runtime);
      try {
        return await api.withAgentDir(paths.agentDir, async () => {
          const connection = await manager.connect(selection.name, { ...definition, requestTimeoutMs: 15_000,
            ...(definition.url ? { credentialId: credentialId(path, selection.name, definition) } : {}),
          }, owned);
          owned.throwIfAborted();
          const current = await selected(selection);
          if (revision(current.definition) !== revision(definition)) return { ...empty, state: "error", detail: "This service changed while it was being checked. Check it again." };
          if (connection.status === "needs-auth") return { ...empty, state: "setup_required", detail: "Sign in to this service, then check it again." };
          const counts = { tools: connection.tools.length, resources: connection.resources.length, prompts: connection.prompts.length };
          const usable = counts.tools + counts.resources + counts.prompts > 0;
          return { ...empty, ...counts, state: usable ? "ready" : "empty", detail: usable ? "The service initialized successfully and its capabilities are available." : "The service connected but did not advertise tools, resources, or prompts." };
        });
      } catch {
        return { ...empty, state: controller.signal.aborted || signal?.aborted ? "cancelled" : "error", detail: controller.signal.aborted || signal?.aborted ? "Connection check cancelled." : owned.aborted ? "The service did not respond within 15 seconds." : "The service could not complete MCP initialization. Check its command or URL and sign-in settings." };
      } finally { controller.abort(); try { await manager.closeAll(); } finally { try { await api.shutdownOAuth(runtime); } finally { probes.delete(controller); finished(); } } }
    },
    async saveServer(input: IncludedMcpSelection & { definition: ServerEntry }): Promise<void> {
      validateName(input.name); const definition = validateDefinition(input.definition);
      await mutate(input, async () => {
        const api = await upstream(); const path = includedMcpConfigPath(paths, input.scope);
        await withFileMutationQueue(path, async () => {
          assertOpen();
          const existing = readConfig(api, [path]).mcpServers[input.name];
          if (existing && input.expectedRevision === undefined) throw new Error("A service with this name already exists in that location. Choose another name.");
          if (input.expectedRevision !== undefined) await selected(input);
          writeEntry(api, path, input.name, definition);
        });
      });
    },
    async removeServer(selection: IncludedMcpSelection): Promise<void> {
      await mutate(selection, async () => {
        const { api, path } = await selected(selection);
        await withFileMutationQueue(path, async () => { await selected(selection); removeEntry(api, path, selection.name); });
      });
    },
    async setEnabled(selection: IncludedMcpSelection, enabled: boolean): Promise<void> {
      await mutate(selection, async () => {
        const { api, path } = await selected(selection);
        await withFileMutationQueue(path, async () => {
          const { definition } = await selected(selection);
          writeEntry(api, path, selection.name, { ...definition, disabled: !enabled });
        });
      });
    },
    async saveBearer(input: IncludedMcpSelection & { token: string }): Promise<void> {
      if (typeof input.token !== "string" || !input.token.trim() || input.token.length > 65_536 || /[\r\n]/.test(input.token)) throw new Error("Enter a bearer token on one line.");
      await mutate(input, async () => {
        const { api, path } = await selected(input);
        await withFileMutationQueue(path, async () => {
          const { definition } = await selected(input);
          if (!definition.url) throw new Error("Bearer authentication requires an HTTP service.");
          api.withAgentDir(paths.agentDir, () => api.saveBearerTokenForUrl(credentialId(path, input.name, definition), input.token, definition.url!));
          const next = { ...definition, auth: "bearer" as const, bearerTokenStore: true as const };
          delete next.bearerToken; delete next.bearerTokenEnv;
          writeEntry(api, path, input.name, next);
        });
      });
    },
    async disconnect(selection: IncludedMcpSelection): Promise<void> {
      await mutate(selection, async () => {
        const { api, path, definition } = await selected(selection); const runtime = api.createOAuthRuntime();
        const id = credentialId(path, selection.name, definition);
        try { await api.withAgentDir(paths.agentDir, async () => { api.removeBearerToken(id); await api.removeAuth(id, { runtime, authStorageOptions }); }); }
        finally { await api.shutdownOAuth(runtime); }
      });
    },
    async startOAuth(selection: IncludedMcpSelection): Promise<IncludedMcpOAuthJob> {
      await cancelFor(selection); const { api, path, definition } = await selected(selection);
      if (!definition.url || definition.disabled) throw new Error("Enable an HTTP service before connecting it.");
      if (definition.oauth && definition.oauth.redirectUri && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/])/.test(definition.oauth.redirectUri)) throw new Error("This service uses a manual callback. Configure a loopback redirect for desktop connection setup.");
      const pin = revision(definition); const controller = new AbortController(); const runtime = api.createOAuthRuntime(controller.signal);
      const job = { public: { id: randomUUID(), state: "running" } as IncludedMcpOAuthJob, selection, controller, runtime, settled: Promise.resolve() };
      jobs.set(job.public.id, job);
      job.settled = api.withAgentDir(paths.agentDir, async () => {
        try {
          const state = await api.authenticate(credentialId(path, selection.name, definition), definition.url!, definition, { runtime, signal: controller.signal, authStorageOptions,
            withSaveTokens: async (persist) => {
              const commit = async () => {
                await withFileMutationQueue(path, async () => {
                  controller.signal.throwIfAborted();
                  const current = await selected(selection);
                  if (revision(current.definition) !== pin) throw new Error("Service configuration changed.");
                  persist();
                });
              };
              if (options.withMutation) await options.withMutation(selection, commit); else await commit();
            },
            openAuthorizationUrl: async (url) => { controller.signal.throwIfAborted(); const current = await selected(selection); if (revision(current.definition) !== pin) throw new Error("Service configuration changed."); await options.openAuthorizationUrl(url); },
          });
          const current = await selected(selection);
          if (revision(current.definition) !== pin) throw new Error("Service configuration changed.");
          if (!controller.signal.aborted) job.public = { id: job.public.id, state: state === "authenticated" ? "connected" : "failed", ...(state === "authenticated" ? {} : { message: "The service did not complete authorization. Try connecting again." }) };
        } catch {
          job.public = { id: job.public.id, state: controller.signal.aborted ? "cancelled" : "failed", ...(controller.signal.aborted ? {} : { message: "The service could not complete authorization. Check its URL and OAuth configuration, then try again." }) };
        } finally { await api.shutdownOAuth(runtime); }
      });
      return { ...job.public };
    },
    oauthStatus(id: string): IncludedMcpOAuthJob { const job = jobs.get(id); if (!job) throw new Error("This connection attempt no longer exists."); return { ...job.public }; },
    async cancelOAuth(id: string): Promise<void> { const job = jobs.get(id); if (!job || job.public.state !== "running") return; job.public.state = "cancelled"; job.controller.abort(); await job.settled; },
    async dispose(): Promise<void> { disposed = true; for (const probe of probes.keys()) probe.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...probes.values(), ...[...jobs.values()].map((job) => job.settled)]); jobs.clear(); },
  };
}
