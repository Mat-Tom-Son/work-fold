import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { productIdentity } from "../../src/shared/product-identity.js";
import { outsideAgentSkill, outsideAgentSkillName } from "../../src/shared/outside-agent-skill.js";

/**
 * Letting other AI agents use this app (owner request, 2026-11-07): the app's
 * command on the Terminal's PATH, and its skill file in Claude Code's and
 * Codex's skills folders. Both happen only when the person clicks.
 *
 * The command goes on the PATH the way Postgres.app does it: one line in
 * `/etc/paths.d/<command>` naming the app's own `Contents/bin`, which every
 * login shell reads through path_helper. Writing there needs the person's
 * password once, through the standard macOS prompt. A symlink would not do:
 * the launcher in `Contents/bin` finds the app from its own folder.
 *
 * Every name comes from src/shared/product-identity.json, so a rename changes
 * the command, the PATH file, and the skill folder together.
 */

export type CommandLineSkillTarget = "claude" | "codex";

export interface CommandLineSkillStatus {
  /** The agent's own folder exists on this computer. */
  available: boolean;
  installed: "none" | "current" | "outdated";
  /** Where the skill file goes. */
  path: string;
}

export interface CommandLineStatus {
  command: string;
  path: {
    /** Only an installed Mac app in a fixed place can put its command on the PATH. */
    supported: boolean;
    /** Why not, in plain words, when it can't. */
    reason: string | null;
    state: "installed" | "missing" | "elsewhere";
    binDirectory: string | null;
    entryFile: string;
  };
  skills: Record<CommandLineSkillTarget, CommandLineSkillStatus>;
}

export interface CommandLineEnvironment {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** The app's executable (process.execPath). */
  executablePath: string;
  home: string;
  /** Directory that holds the PATH entry files; /etc/paths.d on a Mac. */
  pathsDirectory: string;
  /** Runs one shell command as an administrator, after the macOS password prompt. */
  runAsAdministrator(shellCommand: string, prompt: string): Promise<void>;
}

const command = productIdentity.cliCommand;
const product = productIdentity.productName;

export function defaultCommandLineEnvironment(options: { isPackaged: boolean }): CommandLineEnvironment {
  return {
    platform: process.platform,
    isPackaged: options.isPackaged,
    executablePath: process.execPath,
    home: homedir(),
    pathsDirectory: "/etc/paths.d",
    runAsAdministrator,
  };
}

/** `Contents/bin` beside the app's executable, which holds the launcher. */
export function commandBinDirectory(executablePath: string): string {
  return resolve(dirname(executablePath), "..", "bin");
}

export function pathEntryFile(pathsDirectory: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(command)) throw new Error("The command name in the identity file is not a plain name.");
  return join(pathsDirectory, command);
}

export function skillFile(home: string, target: CommandLineSkillTarget): string {
  return join(home, target === "claude" ? ".claude" : ".codex", "skills", outsideAgentSkillName(), "SKILL.md");
}

/** Why this build can't put its command on the PATH, or null when it can. */
export function pathUnsupportedReason(environment: Pick<CommandLineEnvironment, "platform" | "isPackaged" | "executablePath">): string | null {
  if (environment.platform !== "darwin") return `Adding ${command} to Terminal is available on a Mac.`;
  if (!environment.isPackaged) return `Only the installed ${product} app can add its command to Terminal.`;
  // Gatekeeper runs an app opened straight from a download from a temporary,
  // read-only copy; a PATH entry pointing there would break on the next launch.
  if (/\/AppTranslocation\//.test(environment.executablePath)) return `Move ${product} to your Applications folder and open it from there first.`;
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(environment.executablePath)) return `${product} isn't running from an app bundle.`;
  return null;
}

export async function commandLineStatus(environment: CommandLineEnvironment): Promise<CommandLineStatus> {
  const reason = pathUnsupportedReason(environment);
  const binDirectory = reason ? null : commandBinDirectory(environment.executablePath);
  const entryFile = pathEntryFile(environment.pathsDirectory);
  const entry = await readFile(entryFile, "utf8").then((text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), () => null);
  const state = !entry ? "missing" : binDirectory && entry.includes(binDirectory) ? "installed" : "elsewhere";
  const skills = {} as Record<CommandLineSkillTarget, CommandLineSkillStatus>;
  for (const target of ["claude", "codex"] as const) skills[target] = await skillStatus(environment.home, target);
  return { command, path: { supported: !reason, reason, state, binDirectory, entryFile }, skills };
}

async function skillStatus(home: string, target: CommandLineSkillTarget): Promise<CommandLineSkillStatus> {
  const path = skillFile(home, target);
  const available = existsSync(join(home, target === "claude" ? ".claude" : ".codex"));
  const text = await readFile(path, "utf8").catch(() => null);
  return { available, installed: text === null ? "none" : text === outsideAgentSkill() ? "current" : "outdated", path };
}

/** The shell command that writes the PATH entry; every value is quoted. */
export function pathInstallCommand(binDirectory: string, entryFile: string): string {
  assertPlainPath(binDirectory);
  assertPlainPath(entryFile);
  return `mkdir -p ${shellQuote(dirname(entryFile))} && printf '%s\\n' ${shellQuote(binDirectory)} > ${shellQuote(entryFile)} && chmod 644 ${shellQuote(entryFile)}`;
}

export function pathRemoveCommand(entryFile: string): string {
  assertPlainPath(entryFile);
  return `rm -f ${shellQuote(entryFile)}`;
}

export async function installCommandOnPath(environment: CommandLineEnvironment): Promise<CommandLineStatus> {
  const reason = pathUnsupportedReason(environment);
  if (reason) throw new Error(reason);
  const binDirectory = commandBinDirectory(environment.executablePath);
  if (!existsSync(join(binDirectory, command))) throw new Error(`This copy of ${product} has no ${command} command to add.`);
  await environment.runAsAdministrator(
    pathInstallCommand(binDirectory, pathEntryFile(environment.pathsDirectory)),
    `${product} wants to add the ${command} command to Terminal.`,
  );
  return commandLineStatus(environment);
}

export async function removeCommandFromPath(environment: CommandLineEnvironment): Promise<CommandLineStatus> {
  const entryFile = pathEntryFile(environment.pathsDirectory);
  if (existsSync(entryFile)) {
    await environment.runAsAdministrator(pathRemoveCommand(entryFile), `${product} wants to remove the ${command} command from Terminal.`);
  }
  return commandLineStatus(environment);
}

/** Writes (or refreshes) the skill in one agent's skills folder. */
export async function installSkill(environment: CommandLineEnvironment, target: CommandLineSkillTarget): Promise<CommandLineStatus> {
  const path = skillFile(environment.home, target);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, outsideAgentSkill(), "utf8");
  await rename(temporary, path);
  return commandLineStatus(environment);
}

/** Removes the skill folder this app wrote, and only when its SKILL.md names this skill. */
export async function removeSkill(environment: CommandLineEnvironment, target: CommandLineSkillTarget): Promise<CommandLineStatus> {
  const path = skillFile(environment.home, target);
  const text = await readFile(path, "utf8").catch(() => null);
  if (text !== null) {
    if (!skillNamesThisApp(text)) {
      throw new Error(`The skill at ${path} isn't the one ${product} wrote, so it was left alone.`);
    }
    await rm(dirname(path), { recursive: true, force: true });
  }
  return commandLineStatus(environment);
}

/** True when a SKILL.md's front matter names this app's skill. */
export function skillNamesThisApp(text: string): boolean {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return frontMatter.split(/\r?\n/).some((line) => line.trim() === `name: ${outsideAgentSkillName()}`);
}

export function isCommandLineSkillTarget(value: unknown): value is CommandLineSkillTarget {
  return value === "claude" || value === "codex";
}

function assertPlainPath(value: string): void {
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("That path can't be used.");
}

/** POSIX single quotes: nothing inside is special except the quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function runAsAdministrator(shellCommand: string, prompt: string): Promise<void> {
  const script = `do shell script ${appleScriptString(shellCommand)} with prompt ${appleScriptString(prompt)} with administrator privileges`;
  await new Promise<void>((resolvePromise, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5 * 60_000 }, (error, _stdout, stderr) => {
      if (!error) { resolvePromise(); return; }
      // -128 is "User canceled" from the password prompt.
      if (/-128\b/.test(String(stderr)) || /-128\b/.test(error.message)) { reject(new Error("Cancelled. Nothing was changed.")); return; }
      reject(new Error(`macOS didn't allow it: ${String(stderr).trim() || error.message}`));
    });
  });
}
