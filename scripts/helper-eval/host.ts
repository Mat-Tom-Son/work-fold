#!/usr/bin/env tsx
/**
 * Evaluation host for the helper-tool experiment.
 *
 * Starts the local API in-process (dev mode, disposable state, an isolated Pi
 * agent folder) so `npm run work-fold:drive -- --attach <origin>` can drive real
 * Pi turns, and gives those turns a working `work-fold` CLI: the real macOS
 * shim on PATH, an act token for this run, and a stand-in "app" that forwards
 * each request id to `WorkFoldDesktopCliHost.processRequest` here. Every
 * provider call is tapped so total usage includes calls a session file never
 * records (Chat titles, and later the helper).
 *
 * The provider key is read from the environment (OPENROUTER_API_KEY) and
 * never written to disk; ~/.pi is never touched.
 *
 * Usage: OPENROUTER_API_KEY=... tsx scripts/helper-eval/host.ts --out <dir> [--model openrouter/openai/gpt-6-luna] [--thinking high]
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

const out = resolve(argument("--out"));
const [provider, ...modelParts] = argument("--model", "openrouter/openai/gpt-6-luna").split("/");
const modelId = modelParts.join("/");
const thinking = argument("--thinking", "high");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY must be set in the environment.");

const agentDir = join(out, "pi-agent");
const stateBase = join(out, "state");
const binDir = join(out, "bin");
const tapLog = join(out, "provider-calls.jsonl");
await mkdir(agentDir, { recursive: true });
await mkdir(stateBase, { recursive: true });
await mkdir(binDir, { recursive: true });
await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
  defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: thinking, enableInstallTelemetry: false,
}, null, 2)}\n`);
const catalogSource = join(homedir(), "Library", "Application Support", "work-fold", "model-catalogs", "openrouter.json");
const catalogPath = join(out, "openrouter-catalog.json");
if (existsSync(catalogSource)) await copyFile(catalogSource, catalogPath);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.WORKFOLD_AGENT_DIR;

// --- provider-call tap ------------------------------------------------------
let callCount = 0;
let inflight = 0;
let lastSettledAt = Date.now();
// Pi's transport setup installs undici's fetch as the global fetch on first
// use, replacing any earlier wrapper. Configure it first (same default idle
// timeout, so later sessions do not reconfigure), then wrap what it installed.
const { configurePiHttpDispatcher } = await import("../../src/local/agent/pi-http.js");
configurePiHttpDispatcher(undefined);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/openrouter\.ai/.test(url)) return originalFetch(input, init);
  const call = ++callCount;
  const startedAt = Date.now();
  let request: Record<string, unknown> = {};
  try { if (typeof init?.body === "string") request = JSON.parse(init.body) as Record<string, unknown>; } catch { /* not JSON */ }
  const messages = Array.isArray(request.messages) ? request.messages as Array<{ role?: string; content?: unknown }> : [];
  const system = messages.find((message) => message.role === "system" || message.role === "developer");
  const systemText = typeof system?.content === "string" ? system.content
    : Array.isArray(system?.content) ? (system!.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("") : "";
  const record = {
    call, url: url.replace(/\?.*$/, ""), startedAt: new Date(startedAt).toISOString(),
    model: request.model, messageCount: messages.length,
    toolNames: Array.isArray(request.tools) ? (request.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name ?? "?") : [],
    systemHead: systemText.slice(0, 120), systemChars: systemText.length,
    cacheKey: request.prompt_cache_key ?? request.session_id ?? request.user ?? null,
  };
  inflight += 1;
  let settled = false;
  const settle = (result: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    inflight -= 1;
    lastSettledAt = Date.now();
    appendFileSync(tapLog, `${JSON.stringify({ ...record, ...result, durationMs: Date.now() - startedAt })}\n`);
  };
  let response: Response;
  try {
    response = await originalFetch(input, init);
  } catch (error) {
    settle({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (!response.body) {
    settle({ status: response.status });
    return response;
  }
  const [forCaller, forTap] = response.body.tee();
  void (async () => {
    let usage: unknown = null;
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of forTap as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data: ") ? line.slice(6) : line.trim().startsWith("{") ? line.trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as { usage?: unknown };
            if (parsed.usage) usage = parsed.usage;
          } catch { /* partial line */ }
        }
      }
      if (buffer.trim().startsWith("{")) {
        try { const parsed = JSON.parse(buffer.trim()) as { usage?: unknown }; if (parsed.usage) usage = parsed.usage; } catch { /* ignore */ }
      }
      settle({ status: response.status, usage });
    } catch (error) {
      settle({ status: response.status, usage, streamError: error instanceof Error ? error.message : String(error) });
    }
  })();
  return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers });
};

// --- local API and CLI bridge ----------------------------------------------
const { PackagedPiRuntimeProvider } = await import("../../desktop/src/pi-runtime.js");
const { WorkFoldDesktopCliHost } = await import("../../desktop/src/work-fold-cli-host.js");
const { WorkFoldCliKernelAdapter } = await import("../../src/local/work-fold-cli-adapter.js");
const { writeWorkFoldCliActTokenFile } = await import("../../src/local/cli/act-token.js");
const { startLocalApi } = await import("../../src/local/server.js");

const runtime = new PackagedPiRuntimeProvider({
  agentDir,
  ...(existsSync(catalogPath) ? { openRouterCatalogPath: catalogPath } : {}),
  modelPreferencesPath: join(out, "model-preferences.json"),
  preferredModel: { provider: provider!, id: modelId },
});

let adapter: InstanceType<typeof WorkFoldCliKernelAdapter> | null = null;
const lazyKernel = new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => {
    if (!adapter) throw new Error("The local API is not ready.");
    return (adapter as unknown as Record<string | symbol, (...values: unknown[]) => unknown>)[property]!(...args);
  },
});
let actFacade: Awaited<ReturnType<typeof startLocalApi>>["actFacade"] | null = null;
const actToken = randomBytes(32).toString("hex");
let handle: Awaited<ReturnType<typeof startLocalApi>> | null = null;
const cli = new WorkFoldDesktopCliHost({
  stateRoot: stateBase,
  kernel: lazyKernel as never,
  version: "0.0.0-helper-eval",
  getActFacade: () => (actFacade ? { facade: actFacade, token: actToken } : null),
  resolveLineageParent: (taskId) => handle?.resolveWorkFoldAgentLineageParent(taskId) ?? null,
});
await cli.initialize();
handle = await startLocalApi({ port: 0, appMode: "dev", stateBase, piRuntimeProvider: runtime, actReceipts: cli.receipts });
adapter = new WorkFoldCliKernelAdapter(handle.kernel);
actFacade = handle.actFacade;
await writeWorkFoldCliActTokenFile(stateBase, actToken, "work-fold");

const bridge = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cliMatch = /^\/cli\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (cliMatch) {
    cli.processRequest(cliMatch[1]!).then(
      () => { res.writeHead(204); res.end(); },
      (error: unknown) => { res.writeHead(500); res.end(error instanceof Error ? error.message : String(error)); },
    );
    return;
  }
  if (url.pathname === "/tap") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ calls: callCount, inflight, quietMs: inflight ? 0 : Date.now() - lastSettledAt }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolvePromise) => bridge.listen(0, "127.0.0.1", resolvePromise));
const bridgePort = (bridge.address() as { port: number }).port;

const standIn = join(binDir, "app-standin.sh");
await writeFile(standIn, `#!/bin/sh\n# Invoked by the work-fold CLI shim as: <app> --work-fold-cli-request <id>\nexec /usr/bin/curl -fsS "http://127.0.0.1:${bridgePort}/cli/$2" >/dev/null\n`);
const shim = join(binDir, "work-fold");
await writeFile(shim, [
  "#!/bin/sh",
  `export WORKFOLD_CLI_APP="${standIn}"`,
  `export WORKFOLD_CLI_STATE_DIR="${stateBase}"`,
  `exec /usr/bin/osascript -l JavaScript "${join(repo, "desktop", "cli", "work-fold-cli.jxa.js")}" "${join(repo, "desktop", "cli")}" "$@"`,
  "",
].join("\n"));
await chmod(standIn, 0o755);
await chmod(shim, 0o755);
// Worker bash tools inherit this process's environment, exactly as packaged
// turns inherit the app bundle's bin directory.
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const info = {
  origin: handle.origin, bridge: `http://127.0.0.1:${bridgePort}`, stateBase, agentDir, binDir, tapLog,
  model: { provider, id: modelId, thinking }, helperTool: process.env.WORKFOLD_DEV_HELPER_TOOL === "1",
  pid: process.pid, startedAt: new Date().toISOString(),
};
await writeFile(join(out, "host.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info));

const shutdown = async () => {
  bridge.close();
  await handle?.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
