import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { DocumentEngineSetup, DocumentsSetup, IncludedToolStatus } from "../../src/shared/included-tools.js";

/** Only the helper's actual Accessibility and capture checks establish readiness. */
export function includedComputerStatus(result: Record<string, any>): IncludedToolStatus {
  return { id: "computer", checkedAt: new Date().toISOString(),
    state: result.status === "ready" ? "ready" : result.status === "not_running" ? "unknown" : result.status === "unavailable" || result.status === "error" ? "unavailable" : "setup_required",
    detail: result.status === "not_running" ? "The computer helper is idle. It starts when you use Computer Control; an idle helper is not a lost connection." : result.reason ?? (result.status === "ready" ? "Computer control is ready." : "Allow work-fold Computer in Accessibility and Screen Recording."),
    // screenRecordingAllowed is macOS's answer; screenRecording is whether the running helper can capture,
    // which needs a helper restart after the person allows it.
    facts: { accessibility: result.accessibility === true, screenRecording: result.screenRecording === true,
      ...(result.screenRecordingPreflight !== undefined ? { screenRecordingAllowed: result.screenRecordingPreflight === true } : {}),
      ...(result.supportedOS === false ? { supportedOS: false } : {}),
      ...(result.helper?.bundleId ? { helper: String(result.helper.bundleId) } : {}), ...(result.helper?.appPath ? { path: String(result.helper.appPath) } : {}) },
  };
}

export type DocumentEngineName = "libreoffice" | "tesseract" | "quicklook";
/** Where to look for the optional document engines. Tests replace it; the defaults are this computer's usual install locations. */
export interface DocumentEngineSearch { path?: string; home?: string; platform?: string; candidates?: Partial<Record<DocumentEngineName | "homebrew", string[]>> }
export interface DocumentEngineDiscovery { available: boolean; executable: string | null; operations: string[]; setup: string | null }
export interface DocumentEnginesDiscovery { platform: string; homebrew: string | null; libreoffice: DocumentEngineDiscovery; tesseract: DocumentEngineDiscovery; quicklook: DocumentEngineDiscovery }

const setupPlace = "Skills & Extensions → Documents → Set Up";
const engineSetup: Record<DocumentEngineName, string> = {
  libreoffice: `LibreOffice isn't installed, so Word and PowerPoint files can't be rendered and workbook formulas can't be recalculated here. Say exactly what you couldn't check. The person can install it from ${setupPlace}; never install it unless they ask. Their own Office apps remain usable through computer tools.`,
  tesseract: `Tesseract isn't installed, so page images can't be recognized as text here. Read the rendered page images yourself, or tell the person they can install it from ${setupPlace}; never install it unless they ask.`,
  quicklook: "Quick Look previews are built into macOS and are not available on this computer.",
};
const engineOperations: Record<DocumentEngineName, string[]> = { libreoffice: ["render", "recalculate"], tesseract: ["ocr"], quicklook: ["preview"] };

/** A Finder or Dock launch can carry a short PATH, so the usual install locations are checked too. */
export function documentEngineCandidates(platform: string, home: string): Record<DocumentEngineName | "homebrew", string[]> {
  if (platform === "win32") return {
    libreoffice: ["soffice.exe", "C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"],
    tesseract: ["tesseract.exe", "C:\\Program Files\\Tesseract-OCR\\tesseract.exe", "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe"],
    quicklook: [],
    homebrew: [],
  };
  return {
    libreoffice: ["soffice", "libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", posix.join(home, "Applications/LibreOffice.app/Contents/MacOS/soffice"),
      "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice", "/opt/local/bin/soffice", "/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice", "/snap/bin/libreoffice"],
    tesseract: ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "/opt/local/bin/tesseract", "/usr/bin/tesseract"],
    // Quick Look's command-line tool ships with macOS at this path only.
    quicklook: platform === "darwin" ? ["/usr/bin/qlmanage"] : [],
    homebrew: ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"],
  };
}

/** File checks only: nothing is launched, so a status refresh can run this every few seconds. */
export async function discoverDocumentEngines(search: DocumentEngineSearch = {}): Promise<DocumentEnginesDiscovery> {
  const platform = search.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const candidates = { ...documentEngineCandidates(platform, search.home ?? homedir()), ...search.candidates };
  const directories = (search.path ?? process.env.PATH ?? "").split(paths.delimiter).filter(Boolean);
  const find = async (entries: string[]) => {
    for (const entry of entries.flatMap((name) => paths.isAbsolute(name) ? [name] : directories.map((directory) => paths.join(directory, name)))) {
      try { await access(entry, constants.X_OK); if ((await stat(entry)).isFile()) return entry; } catch { /* Try the next location. */ }
    }
    return null;
  };
  const [libreoffice, tesseract, quicklook, homebrew] = await Promise.all([find(candidates.libreoffice), find(candidates.tesseract), find(candidates.quicklook), find(candidates.homebrew)]);
  const engine = (name: DocumentEngineName, executable: string | null): DocumentEngineDiscovery => ({
    available: Boolean(executable), executable, operations: engineOperations[name], setup: executable ? null : engineSetup[name],
  });
  return { platform, homebrew, libreoffice: engine("libreoffice", libreoffice), tesseract: engine("tesseract", tesseract), quicklook: engine("quicklook", quicklook) };
}

/** An explicit Check starts each found engine once with --version, so a blocked or broken install shows as one. */
export async function verifyDocumentEngine(executable: string, { signal, timeoutMs = 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ version?: string; problem?: string }> {
  if (signal?.aborted) return { problem: "The check was stopped." };
  return new Promise((done) => {
    let output = "", settled = false;
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const kill = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already gone. */ }
    };
    const finish = (result: { version?: string; problem?: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", stopped);
      done(result);
    };
    const stopped = () => { kill(); finish({ problem: "The check was stopped." }); };
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const timer = setTimeout(() => { kill(); finish({ problem: `It didn't answer within ${seconds} second${seconds === 1 ? "" : "s"}.` }); }, timeoutMs);
    signal?.addEventListener("abort", stopped, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(0, 4096); });
    child.once("error", (error) => finish({ problem: error.message }));
    child.once("close", (code, exitSignal) => {
      const line = output.split(/\r?\n/).map((part) => part.trim()).find(Boolean)?.slice(0, 200);
      finish(code === 0 && line ? { version: line } : { problem: `It exited ${code ?? exitSignal}${line ? `: ${line}` : "."}` });
    });
  });
}

/** Discovery plus a --version run for each found engine; only an explicit Check calls this. */
export async function checkDocumentEngines(search: DocumentEngineSearch = {}, signal?: AbortSignal): Promise<DocumentsSetup> {
  const found = await discoverDocumentEngines(search);
  const engine = async (name: DocumentEngineName): Promise<DocumentEngineSetup> => {
    const executable = found[name].executable;
    return executable ? { found: true, path: executable, ...await verifyDocumentEngine(executable, { signal }) } : { found: false };
  };
  const [libreoffice, tesseract, quicklook] = await Promise.all([engine("libreoffice"), engine("tesseract"), engine("quicklook")]);
  return { platform: found.platform, homebrew: Boolean(found.homebrew), libreoffice, tesseract, ...(quicklook.found ? { quicklook } : {}) };
}

/**
 * The Documents status word (2026-10-18): the bundled libraries' evidence plus
 * the engines found right now. Without LibreOffice a Worker can make documents
 * but cannot see Word or PowerPoint pages or calculate formulas, so a person
 * has setup to do. Tesseract only reads scanned pages and never changes the word.
 */
export function includedDocumentsStatus(libraries: IncludedToolStatus | undefined, found: DocumentEnginesDiscovery): IncludedToolStatus {
  const earlier = libraries?.documentsSetup;
  const engine = (name: DocumentEngineName): DocumentEngineSetup => {
    const executable = found[name].executable;
    if (!executable) return { found: false };
    // A version or start problem belongs to the exact program the last Check ran.
    const checked = earlier?.[name]?.path === executable ? earlier[name] : undefined;
    return { found: true, path: executable, ...(checked?.version ? { version: checked.version } : {}), ...(checked?.problem ? { problem: checked.problem } : {}) };
  };
  const quicklook = engine("quicklook");
  const documentsSetup: DocumentsSetup = { platform: found.platform, homebrew: Boolean(found.homebrew), libreoffice: engine("libreoffice"), tesseract: engine("tesseract"), ...(quicklook.found ? { quicklook } : {}) };
  const base = { id: "documents" as const, checkedAt: libraries?.checkedAt ?? new Date().toISOString(), stale: false, ...(libraries?.facts ? { facts: libraries.facts } : {}), documentsSetup };
  if (libraries?.state === "unavailable") return { ...base, state: "unavailable", detail: libraries.detail };
  // On a Mac, Quick Look still lets a Worker see one page at a time, so the detail says what that covers (2026-10-18).
  if (!documentsSetup.libreoffice.found) return { ...base, state: "setup_required", detail: quicklook.found && !quicklook.problem
    ? "Your Worker can preview the first page of a Word file and each slide of a deck, but can't check every page or what spreadsheet formulas calculate. Install LibreOffice to turn that on."
    : "Your Worker can make documents but can't check how Word and PowerPoint files look or what spreadsheet formulas calculate. Install LibreOffice to turn that on." };
  if (documentsSetup.libreoffice.problem) return { ...base, state: "setup_required", detail: found.platform === "darwin"
    ? "LibreOffice is installed but didn't start. Open it once from Applications so macOS can approve it, then check again."
    : `LibreOffice is installed but didn't start. ${documentsSetup.libreoffice.problem}` };
  if (libraries?.state === "ready") return { ...base, state: "ready", detail: "Your Worker can make documents and check how they look and what their formulas calculate." };
  return { ...base, state: "unknown", detail: "LibreOffice is installed. Check to verify the document tools on this computer." };
}
