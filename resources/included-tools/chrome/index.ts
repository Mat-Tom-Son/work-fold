import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChromeExtension, probeChromeConnection } from "pi-chrome/extensions/chrome-profile-bridge/index.ts";
import { hostContext } from "../host.ts";

const require = createRequire(import.meta.url);
export type IncludedChromeConfig = { companionPath: string };
async function copyCompanion(source: string, target: string): Promise<void> {
  // Electron's fs.cp does not traverse ASAR directories. These native file
  // primitives do, and reject an unexpected link instead of following it.
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "host-config.json") continue;
    if (entry.isDirectory()) await copyCompanion(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name));
    else throw new Error("The included Chrome companion contains an unsupported file.");
  }
}
async function companionToken(config: IncludedChromeConfig): Promise<string | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(config.companionPath, "host-config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("The Chrome companion setup could not be read. Prepare the companion again."); }
  const record = value as { version?: unknown; mode?: unknown; token?: unknown } | null;
  return record?.version === 1 && record.mode === "embedded" && typeof record.token === "string" && /^[a-f0-9]{64}$/.test(record.token) ? record.token : undefined;
}

/** Explicit trusted setup. The reusable credential never enters an agent or renderer context. */
export async function prepareIncludedChromeCompanion(config: IncludedChromeConfig): Promise<{ path: string }> {
  const token = await companionToken(config).catch(() => undefined) ?? randomBytes(32).toString("hex");
  const source = join(dirname(require.resolve("pi-chrome/package.json")), "extensions", "chrome-profile-bridge", "browser-extension");
  await mkdir(config.companionPath, { recursive: true, mode: 0o700 });
  await chmod(config.companionPath, 0o700);
  await copyCompanion(source, config.companionPath);
  const temporary = join(config.companionPath, `host-config.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ version: 1, mode: "embedded", token })}\n`, { mode: 0o600 });
  await rename(temporary, join(config.companionPath, "host-config.json"));
  return { path: config.companionPath };
}

export async function probeIncludedChrome(config: IncludedChromeConfig) {
  if (!await companionToken(config)) return { state: "setup_required" as const, reason: "Prepare and load the Chrome companion to connect this profile." };
  // A disconnected companion retries after its 2s backoff and 1s poll timer.
  // Allow that normal retry window when Check setup starts the first listener.
  return probeChromeConnection({ timeoutMs: 5_000, getCompanionToken: () => companionToken(config) });
}

export default function chrome(pi: ExtensionAPI) {
  const host = hostContext(pi);
  return createChromeExtension(host ? {
    embedded: true, companionPath: host.companionPath,
    // Reading a credential happens only when a native tool acquires a connection.
    getCompanionToken: () => companionToken({ companionPath: host.companionPath }),
  } : {})(pi);
}
