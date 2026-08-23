import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";

/**
 * Login-shell environment repair for GUI launches.
 *
 * When macOS (or a Linux desktop) launches work-fold from the Dock, Finder,
 * Spotlight, or `open`, the process inherits launchd's minimal environment:
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no shell startup files ever run.
 * Pi's bash tool spawns `/bin/bash -c` with this process environment, so the
 * Assistant cannot find Homebrew, nvm, pnpm, or anything else the person's
 * shell profile adds — even though the same prompt in a terminal `pi` session
 * would. A terminal launch already carries the shell environment and is left
 * alone.
 *
 * The repair asks the person's login shell for its environment once, exactly
 * the way a new terminal tab would produce it, and merges the result into
 * `process.env` before the first Pi session or shell tool can observe it.
 */

export interface LoginShellEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Shell to query; defaults to `$SHELL`, then the platform default. */
  shell?: string;
  timeoutMs?: number;
}

export interface LoginShellEnvironmentResult {
  status: "applied" | "skipped" | "failed";
  reason: string;
  shell?: string;
  importedKeys: string[];
  pathEntriesAdded: number;
  durationMs: number;
}

export interface MergedLoginShellEnvironment {
  env: Record<string, string>;
  importedKeys: string[];
  pathEntriesAdded: number;
}

/** Variables that describe the querying shell process itself, never the person's setup. */
const neverImportedKeys = new Set([
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "COLUMNS",
  "LINES",
  "DISABLE_AUTO_UPDATE",
  "NODE_OPTIONS",
  "NODE_CHANNEL_FD",
  "WORKFOLD_RESOLVING_LOGIN_SHELL",
]);

/** Prefixes whose process values are explicit product/runtime configuration and always win. */
const processWinsPrefixes = ["WORKFOLD_", "PI_", "ELECTRON_", "__CF", "XPC_", "MallocNanoZone", "OSLogRateLimit"];

export const loginShellEnvironmentMarkerEnv = "WORKFOLD_RESOLVING_LOGIN_SHELL";

/**
 * A launch from a terminal already carries that terminal's shell environment;
 * re-resolving it would only add startup time and let a profile override
 * explicit `FOO=1 npm run desktop:smoke` style values. Windows never runs a
 * POSIX login shell, and an explicit opt-out stays explicit.
 */
export function shouldResolveLoginShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { resolve: boolean; reason: string } {
  if (platform === "win32") return { resolve: false, reason: "Windows launches do not use a POSIX login shell." };
  if (env.WORKFOLD_DISABLE_LOGIN_SHELL_ENV === "1") return { resolve: false, reason: "WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1 opts out." };
  if (env[loginShellEnvironmentMarkerEnv] === "1") return { resolve: false, reason: "This process is itself a login-shell environment probe." };
  if (typeof env.TERM === "string" && env.TERM.trim()) {
    return { resolve: false, reason: "Launched from a terminal; its shell environment is already present." };
  }
  return { resolve: true, reason: "GUI launch without a terminal environment." };
}

export function defaultLoginShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const configured = env.SHELL?.trim();
  const candidates = [configured, platform === "darwin" ? "/bin/zsh" : "/bin/bash", "/bin/bash", "/bin/sh"]
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Argument shape per shell family. `-l` makes the shell read login files
 * (`.zprofile`, `.bash_profile`), `-i` makes it read interactive files
 * (`.zshrc`, `.bashrc`) — most PATH edits live in the interactive file, which
 * is why both are needed. csh-family shells reject `-l` combined with other
 * flags, so they run interactive-only.
 */
export function loginShellArguments(shell: string, command: string): string[] {
  const name = basename(shell);
  if (name === "csh" || name === "tcsh") return ["-ic", command];
  return ["-ilc", command];
}

export function loginShellProbeCommand(marker: string): string {
  // /usr/bin/env is addressed absolutely so a profile alias or function named
  // `env` cannot change the output; `-0` keeps multi-line values intact.
  return `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`;
}

/**
 * Extracts the NUL-separated `KEY=value` block between two marker copies. Any
 * profile chatter before the first marker or after the last is discarded.
 */
export function parseLoginShellEnvironment(output: string, marker: string): Record<string, string> | null {
  const start = output.indexOf(marker);
  if (start === -1) return null;
  const end = output.lastIndexOf(marker);
  if (end === -1 || end === start) return null;
  const block = output.slice(start + marker.length, end);
  const parsed: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parsed[key] = entry.slice(separator + 1);
  }
  return parsed;
}

/**
 * Merges a login-shell environment over the GUI launch environment.
 *
 * - `PATH` keeps the shell's order first, then appends any process-only
 *   entries so nothing the process already relied on disappears.
 * - Explicit product and Electron runtime variables keep their process values.
 * - Variables that only describe the probe shell are never imported.
 * - Everything else takes the shell's value, matching what a terminal `pi`
 *   session would see.
 */
export function mergeLoginShellEnvironment(
  processEnv: NodeJS.ProcessEnv,
  shellEnv: Record<string, string>,
): MergedLoginShellEnvironment {
  const pathKey = Object.keys(processEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const env: Record<string, string> = {};
  const importedKeys: string[] = [];
  for (const [key, value] of Object.entries(shellEnv)) {
    if (key.toLowerCase() === "path") continue;
    if (neverImportedKeys.has(key)) continue;
    if (processWinsPrefixes.some((prefix) => key.startsWith(prefix)) && processEnv[key] !== undefined) continue;
    if (processEnv[key] === value) continue;
    env[key] = value;
    importedKeys.push(key);
  }
  const shellPathKey = Object.keys(shellEnv).find((key) => key.toLowerCase() === "path");
  const shellPath = shellPathKey ? shellEnv[shellPathKey] ?? "" : "";
  const processPath = processEnv[pathKey] ?? "";
  const merged = mergePathLists(shellPath, processPath);
  const pathEntriesAdded = merged.entries.length - splitPath(processPath).length;
  if (merged.value !== processPath && merged.entries.length) {
    env[pathKey] = merged.value;
    importedKeys.push(pathKey);
  }
  importedKeys.sort((left, right) => left.localeCompare(right));
  return { env, importedKeys, pathEntriesAdded: Math.max(0, pathEntriesAdded) };
}

function mergePathLists(preferred: string, fallback: string): { value: string; entries: string[] } {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...splitPath(preferred), ...splitPath(fallback)]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return { value: entries.join(delimiter), entries };
}

function splitPath(value: string): string[] {
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export async function resolveLoginShellEnvironment(
  options: LoginShellEnvironmentOptions = {},
): Promise<{ shell: string; env: Record<string, string> } | { shell: string | null; error: string }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? defaultLoginShell(env, platform);
  if (!shell) return { shell: null, error: "No login shell is available." };
  if (!existsSync(shell)) return { shell, error: `Login shell not found: ${shell}` };
  const marker = `__work-fold-env-${randomUUID()}__`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { shell: string; env: Record<string, string> } | { shell: string | null; error: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, loginShellArguments(shell, loginShellProbeCommand(marker)), {
        // Profiles must see a quiet, non-interactive-looking stdin so an
        // `exec tmux`-style rc file cannot wait for a terminal.
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...env, [loginShellEnvironmentMarkerEnv]: "1", DISABLE_AUTO_UPDATE: "true" },
        // Own process group so a timed-out probe (and anything its profile
        // started) can be killed together instead of holding the pipe open.
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      finish({ shell, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const killProbe = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      child.stdout?.destroy();
    };
    timer = setTimeout(() => {
      killProbe();
      finish({ shell, error: `The login shell did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
    }, timeoutMs);
    const chunks: Buffer[] = [];
    let received = 0;
    const maxOutputBytes = 4 * 1024 * 1024;
    child.stdout?.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > maxOutputBytes) {
        killProbe();
        finish({ shell, error: "The login shell produced too much output." });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => finish({ shell, error: error.message }));
    child.on("close", (code) => {
      const parsed = parseLoginShellEnvironment(Buffer.concat(chunks).toString("utf8"), marker);
      if (!parsed) {
        finish({ shell, error: code === 0 ? "The login shell did not report its environment." : `The login shell exited with code ${code ?? "unknown"} before reporting its environment.` });
        return;
      }
      finish({ shell, env: parsed });
    });
  });
}

/**
 * Resolves and applies the login-shell environment to `target` (the live
 * `process.env` by default). Never throws: a profile that fails or hangs
 * leaves the launch environment untouched and reports why.
 */
export async function applyLoginShellEnvironment(
  options: LoginShellEnvironmentOptions & { target?: NodeJS.ProcessEnv } = {},
): Promise<LoginShellEnvironmentResult> {
  const startedAt = Date.now();
  const target = options.target ?? process.env;
  const env = options.env ?? target;
  const decision = shouldResolveLoginShellEnvironment(env, options.platform ?? process.platform);
  if (!decision.resolve) {
    return { status: "skipped", reason: decision.reason, importedKeys: [], pathEntriesAdded: 0, durationMs: Date.now() - startedAt };
  }
  const resolved = await resolveLoginShellEnvironment({ ...options, env });
  if ("error" in resolved) {
    return {
      status: "failed",
      reason: resolved.error,
      ...(resolved.shell ? { shell: resolved.shell } : {}),
      importedKeys: [],
      pathEntriesAdded: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  const merged = mergeLoginShellEnvironment(target, resolved.env);
  for (const [key, value] of Object.entries(merged.env)) target[key] = value;
  return {
    status: "applied",
    reason: merged.importedKeys.length
      ? `Imported ${merged.importedKeys.length} variable${merged.importedKeys.length === 1 ? "" : "s"} from ${resolved.shell}.`
      : `${resolved.shell} reported no additional environment.`,
    shell: resolved.shell,
    importedKeys: merged.importedKeys,
    pathEntriesAdded: merged.pathEntriesAdded,
    durationMs: Date.now() - startedAt,
  };
}

export function formatLoginShellEnvironmentResult(result: LoginShellEnvironmentResult): string {
  switch (result.status) {
    case "applied":
      return `Login shell environment ${result.pathEntriesAdded ? `added ${result.pathEntriesAdded} PATH entr${result.pathEntriesAdded === 1 ? "y" : "ies"} and ` : ""}${result.reason.charAt(0).toLowerCase()}${result.reason.slice(1)} (${result.durationMs} ms)`;
    case "skipped":
      return `Login shell environment not resolved: ${result.reason}`;
    case "failed":
      return `Login shell environment unavailable${result.shell ? ` from ${result.shell}` : ""}: ${result.reason} Shell tools keep the launch environment.`;
  }
}
