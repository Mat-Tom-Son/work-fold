#!/usr/bin/env tsx
/**
 * Evaluation host for document checking (2026-10-18).
 *
 * Starts the local API in-process with the included tools (Documents and its
 * document-work Skill), an isolated Pi agent folder, and disposable app state,
 * so `npm run work-fold:drive -- --attach <origin>` drives real Worker turns
 * with the same tools a packaged app has. Computer Control and Chrome load but
 * cannot act: no helper is permitted and no browser is attached.
 *
 * Run it under `sandbox-exec -f scripts/document-eval/no-engines.sb` to hide
 * LibreOffice, Tesseract and Microsoft Office from the host and every tool it
 * starts, which is how a typical Mac without those programs looks.
 *
 * The provider key comes from the environment (OPENROUTER_API_KEY) and is never
 * written to disk; ~/.pi is never touched.
 *
 * Usage: OPENROUTER_API_KEY=... tsx scripts/document-eval/host.ts --out <dir> [--model openrouter/openai/gpt-6-luna] [--thinking high]
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
await mkdir(agentDir, { recursive: true });
await mkdir(stateBase, { recursive: true });
await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
  defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: thinking, enableInstallTelemetry: false,
}, null, 2)}\n`);
// Pi's built-in catalog may not list the newest OpenRouter models; reuse the app's cached copy.
const catalogSource = join(homedir(), "Library", "Application Support", "work-fold", "model-catalogs", "openrouter.json");
const catalogPath = join(out, "openrouter-catalog.json");
if (existsSync(catalogSource)) await copyFile(catalogSource, catalogPath);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.WORKFOLD_AGENT_DIR;

const { PackagedPiRuntimeProvider } = await import("../../desktop/src/pi-runtime.js");
const { includedToolsRoot } = await import("../../src/local/agent/included-tools.js");
const { startLocalApi } = await import("../../src/local/server.js");

const runtime = new PackagedPiRuntimeProvider({
  agentDir,
  // The same configuration as the dev server. No helper is built or permitted here, so Computer Control stays unusable.
  includedTools: { rootPath: includedToolsRoot(), stateRoot: join(stateBase, "assistant-tools"),
    helperAppPath: join(includedToolsRoot(), "..", "..", "out", "included-tools", "computer-helper", "work-fold Computer.app") },
  ...(existsSync(catalogPath) ? { openRouterCatalogPath: catalogPath } : {}),
  modelPreferencesPath: join(out, "model-preferences.json"),
  preferredModel: { provider: provider!, id: modelId },
});
const handle = await startLocalApi({ port: 0, appMode: "dev", stateBase, piRuntimeProvider: runtime });

const info = { origin: handle.origin, stateBase, agentDir, includedTools: includedToolsRoot(), model: { provider, id: modelId, thinking }, pid: process.pid, startedAt: new Date().toISOString() };
await writeFile(join(out, "host.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info));

const shutdown = async () => {
  await handle.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
