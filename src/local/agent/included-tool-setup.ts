import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createJiti } from "jiti";
import { resolvePiRuntime, type PiRuntimeProvider, type ResolvedPiRuntime } from "./pi-runtime-config.js";
import { includedToolDefinitions, type IncludedToolId, type IncludedToolStatus } from "../../shared/included-tools.js";

const jiti = createJiti(import.meta.url, { moduleCache: true });
const checks = new Map<string, { revision: number; status?: IncludedToolStatus }>();
const checkKey = (runtime: ResolvedPiRuntime, id: IncludedToolId) => `${runtime.config.includedTools?.stateRoot}:${id}`;

/** Catalog inspection never starts a helper, a browser connection, or an MCP server. */
export async function listIncludedToolStatus(cwd: string, provider?: PiRuntimeProvider): Promise<IncludedToolStatus[]> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  if (!runtime.config.includedTools) return [];
  return includedToolDefinitions.map(({ id }) => {
    const now = new Date().toISOString();
    if (id === "web") return runtime.authStorage.get("work-fold:web:brave")?.type === "api_key"
      ? { id, state: "unknown", detail: "Brave Search key saved. The connection is verified when you search. Public page reading is available.", checkedAt: now }
      : { id, state: "ready", detail: "DuckDuckGo search and public page reading are available without setup.", checkedAt: now };
    const checked = checks.get(checkKey(runtime, id))?.status;
    return checked && Date.now() - Date.parse(checked.checkedAt) < 5 * 60_000 ? checked
      : { id, state: "unknown", detail: id === "mcp" ? "Add a service connection to use its tools." : "Check setup to verify this tool on your computer.", checkedAt: now };
  });
}

export type IncludedSetupAction = "check" | "prepare-companion" | "request-permissions" | "accessibility" | "screen-recording" | "recheck" | "connect-brave" | "disconnect-brave";
export interface IncludedSetupResult { status: IncludedToolStatus; revealPath?: string; openUrl?: string }

/** Trusted local setup only. Secrets and permission prompts never enter an Assistant turn. */
export async function setupIncludedTool(cwd: string, id: IncludedToolId, action: IncludedSetupAction, input: { secret?: string }, provider?: PiRuntimeProvider, signal?: AbortSignal): Promise<IncludedSetupResult> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config) throw new Error("Included Assistant tools are unavailable in this host.");
  // Starting an explicit recheck invalidates earlier evidence even if this
  // attempt throws before it can produce a new structured result.
  const key = checkKey(runtime, id);
  const revision = (checks.get(key)?.revision ?? 0) + 1;
  checks.set(key, { revision });
  let status: IncludedToolStatus = { id, state: "unknown", detail: "Setup has not been checked.", checkedAt: new Date().toISOString() };
  let revealPath: string | undefined;
  let openUrl: string | undefined;
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
  } else if (id === "chrome") {
    const chrome = await jiti.import<{
      prepareIncludedChromeCompanion(config: { companionPath: string }): Promise<{ path: string }>;
      probeIncludedChrome(config: { companionPath: string }): Promise<{ state: "ready" | "setup_required"; reason: string; version?: string }>;
    }>(join(config.rootPath, "chrome", "index.ts"));
    const chromeConfig = { companionPath: join(config.stateRoot, "chrome-companion") };
    if (action === "prepare-companion") {
      const { path: target } = await chrome.prepareIncludedChromeCompanion(chromeConfig);
      // A stable directory preserves the unpacked companion's Chrome identity across app updates.
      revealPath = target;
      openUrl = "chrome://extensions";
      if (process.platform === "darwin") {
        await promisify(execFile)("/usr/bin/open", [target]);
        await promisify(execFile)("/usr/bin/open", ["-a", "Google Chrome", openUrl]);
      }
      status = { ...status, state: "setup_required", detail: "In Chrome, enable Developer mode, choose Load unpacked, and select the Chrome companion folder. After an update, choose Reload on the existing companion." };
    } else if (action === "check") {
      const result = await chrome.probeIncludedChrome(chromeConfig);
      status = { ...status, state: result.state, detail: result.reason, facts: { ...(result.version ? { version: result.version } : {}) } };
    } else throw new Error("Unknown Chrome setup action.");
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
  return { status, ...(revealPath ? { revealPath } : {}), ...(openUrl ? { openUrl } : {}) };
}

/** Host shutdown follows session disposal, so one Chat never stops a peer's helper. */
export async function shutdownIncludedToolHost(cwd: string, provider?: PiRuntimeProvider): Promise<void> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config?.helperAppPath) return;
  const computer = await jiti.import<{ shutdownIncludedComputer(config: unknown): Promise<void> }>(join(config.rootPath, "computer", "index.ts"));
  await computer.shutdownIncludedComputer(config);
}
