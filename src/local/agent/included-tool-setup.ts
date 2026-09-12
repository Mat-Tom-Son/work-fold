import { join } from "node:path";
import { createJiti } from "jiti";
import { resolvePiRuntime, type PiRuntimeProvider, type ResolvedPiRuntime } from "./pi-runtime-config.js";
import type { ChromeConnectionState, ChromeConnectionSummary, ChromeSetupAction } from "../../shared/chrome-connection.js";
import { includedToolDefinitions, type IncludedToolId, type IncludedToolStatus } from "../../shared/included-tools.js";

const jiti = createJiti(import.meta.url, { moduleCache: true });
const checks = new Map<string, { revision: number; status?: IncludedToolStatus }>();
const checkKey = (runtime: ResolvedPiRuntime, id: IncludedToolId) => `${runtime.config.includedTools?.stateRoot}:${id}`;

/** Explicit projection: native leases, profile identities and bootstrap proofs stay in the host. */
function chromeStatus(summary?: ChromeConnectionSummary): IncludedToolStatus {
  const source = summary ?? { state: "native_host_missing", checkedAt: new Date().toISOString() };
  const chrome: ChromeConnectionSummary = {
    state: source.state, checkedAt: source.checkedAt,
    ...(source.extensionVersion ? { extensionVersion: source.extensionVersion } : {}),
    ...(typeof source.hasSelection === "boolean" ? { hasSelection: source.hasSelection } : {}),
  };
  const details: Record<ChromeConnectionState, string> = {
    not_connected: "Chrome is not connected.", connecting: "Connecting to Chrome.", connected: "Chrome is connected.",
    app_not_running: "Open work-fold.", native_host_missing: "Chrome setup requires the desktop app.",
    update_app: "Update work-fold.", update_extension: "Update the Chrome extension.",
    profile_conflict: "Another Chrome profile is connected.", busy: "Chrome is in use. Stop its work before changing the connection.",
    store_unavailable: "The Chrome extension is not available yet.", connection_error: "The Chrome connection could not be verified.",
  };
  return {
    id: "chrome", state: !summary ? "unavailable" : chrome.state === "connected" ? "ready"
      : ["app_not_running", "update_app", "update_extension", "store_unavailable", "connection_error"].includes(chrome.state) ? "unavailable" : "setup_required",
    detail: details[chrome.state], checkedAt: chrome.checkedAt, chrome,
  };
}

/** Catalog inspection never starts a helper, a browser connection, or an MCP server. */
export async function listIncludedToolStatus(cwd: string, provider?: PiRuntimeProvider): Promise<IncludedToolStatus[]> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  if (!runtime.config.includedTools) return [];
  return includedToolDefinitions.map(({ id }) => {
    if (id === "chrome") return chromeStatus(runtime.config.includedTools?.chromeConnection?.status());
    const now = new Date().toISOString();
    if (id === "web") return runtime.authStorage.get("work-fold:web:brave")?.type === "api_key"
      ? { id, state: "unknown", detail: "Brave Search key saved. The connection is verified when you search. Public page reading is available.", checkedAt: now }
      : { id, state: "ready", detail: "DuckDuckGo search and public page reading are available without setup.", checkedAt: now };
    const checked = checks.get(checkKey(runtime, id))?.status;
    return checked && Date.now() - Date.parse(checked.checkedAt) < 5 * 60_000 ? checked
      : { id, state: "unknown", detail: id === "mcp" ? "Add a service connection to use its tools." : "Check setup to verify this tool on your computer.", checkedAt: now };
  });
}

export type IncludedSetupAction = ChromeSetupAction | "request-permissions" | "accessibility" | "screen-recording" | "recheck" | "connect-brave" | "disconnect-brave";
export interface IncludedSetupResult { status: IncludedToolStatus }

/** Trusted local setup only. Secrets and permission prompts never enter an Assistant turn. */
export async function setupIncludedTool(cwd: string, id: IncludedToolId, action: IncludedSetupAction, input: { secret?: string }, provider?: PiRuntimeProvider, signal?: AbortSignal): Promise<IncludedSetupResult> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config) throw new Error("Included Assistant tools are unavailable in this host.");
  if (id === "chrome") {
    if (!["connect-chrome", "disconnect-chrome", "change-chrome-profile", "check"].includes(action)) throw new Error("Unknown Chrome setup action.");
    const service = config.chromeConnection;
    if (!service) throw new Error("Chrome setup requires the desktop app.");
    let summary: ChromeConnectionSummary;
    switch (action) {
      case "connect-chrome": summary = await service.prepare(); break;
      case "disconnect-chrome": summary = await service.disconnect(); break;
      case "change-chrome-profile": summary = await service.changeProfile(); break;
      case "check": summary = await service.check(); break;
      default: throw new Error("Unknown Chrome setup action.");
    }
    // Its app-owned observation already accounts for profile generation and
    // handshake freshness. Never retain a second five-minute Ready cache.
    return { status: chromeStatus(summary) };
  }
  // Starting an explicit recheck invalidates earlier evidence even if this
  // attempt throws before it can produce a new structured result.
  const key = checkKey(runtime, id);
  const revision = (checks.get(key)?.revision ?? 0) + 1;
  checks.set(key, { revision });
  let status: IncludedToolStatus = { id, state: "unknown", detail: "Setup has not been checked.", checkedAt: new Date().toISOString() };
  if (id === "web") {
    if (action === "connect-brave") {
      const secret = input.secret?.trim();
      if (!secret || secret.length > 4096) throw new Error("Enter a valid Brave Search API key.");
      runtime.authStorage.set("work-fold:web:brave", { type: "api_key", key: secret });
      await runtime.flushAuthStorage();
    } else if (action === "disconnect-brave") {
      runtime.authStorage.logout("work-fold:web:brave");
      await runtime.flushAuthStorage();
    } else if (action !== "check") throw new Error("Unknown web setup action.");
    status = (await listIncludedToolStatus(cwd, provider)).find((item) => item.id === id)!;
  } else if (id === "computer") {
    const computer = await jiti.import<{
      probeIncludedComputer(config: unknown, options: unknown): Promise<Record<string, any>>;
      setupIncludedComputer(config: unknown, action: string, signal?: AbortSignal): Promise<Record<string, any>>;
    }>(join(config.rootPath, "computer", "index.ts"));
    if (!["check", "request-permissions", "accessibility", "screen-recording", "recheck"].includes(action)) throw new Error("Unknown computer setup action.");
    const result = action === "check" ? await computer.probeIncludedComputer(config, { launch: true, signal }) : await computer.setupIncludedComputer(config, action, signal);
    status = { ...status, state: result.status === "ready" ? "ready" : result.status === "unavailable" || result.status === "error" ? "unavailable" : "setup_required",
      detail: result.reason ?? (result.status === "ready" ? "Computer control is ready." : "Allow work-fold Computer in Accessibility and Screen Recording, then recheck."),
      facts: { accessibility: result.accessibility === true, screenRecording: result.screenRecording === true, ...(result.helper?.bundleId ? { helper: String(result.helper.bundleId) } : {}), ...(result.helper?.appPath ? { path: String(result.helper.appPath) } : {}) },
    };
  } else if (id === "documents") {
    if (action !== "check") throw new Error("Unknown document setup action.");
    const documents = await jiti.import<{ probeIncludedDocuments(): Promise<{ state: "ready" | "unavailable"; reason: string; versions: Record<string, string>; runtime: string }> }>(join(config.rootPath, "documents", "runtime.mjs"));
    const result = await documents.probeIncludedDocuments();
    status = { ...status, state: result.state, detail: result.reason, facts: result.versions };
  } else throw new Error("Use service connection setup to configure MCP.");
  if (checks.get(key)?.revision === revision) {
    status = { ...status, checkedAt: new Date().toISOString() };
    checks.set(key, { revision, status });
  } else {
    status = checks.get(key)?.status ?? { id, state: "unknown", detail: "A newer setup check started.", checkedAt: new Date().toISOString() };
  }
  return { status };
}

/** Host shutdown follows session disposal, so one Chat never stops a peer's helper. */
export async function shutdownIncludedToolHost(cwd: string, provider?: PiRuntimeProvider): Promise<void> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config?.helperAppPath) return;
  const computer = await jiti.import<{ shutdownIncludedComputer(config: unknown): Promise<void> }>(join(config.rootPath, "computer", "index.ts"));
  await computer.shutdownIncludedComputer(config);
}
