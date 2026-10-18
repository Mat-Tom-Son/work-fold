import { useState } from "react";
import { Check, Circle } from "lucide-react";
import type { DocumentEngineSetup, IncludedToolStatus } from "../../../../src/shared/included-tools";
import { copyToClipboard } from "../../lib/clipboard";

export const libreOfficeDownloadUrl = "https://www.libreoffice.org/download/download-libreoffice/";
export const tesseractInstallGuideUrl = "https://tesseract-ocr.github.io/tessdoc/Installation.html";

/** The install command a person can run themselves; work-fold never runs it (2026-10-18). */
export function documentEngineInstallCommand(engine: "libreoffice" | "tesseract", platform: string, homebrew: boolean): { label: string; command: string } | null {
  if (platform === "darwin" && homebrew) return { label: "Or in Terminal, with Homebrew:", command: engine === "libreoffice" ? "brew install --cask libreoffice" : "brew install tesseract" };
  if (platform === "linux") return { label: "On Debian or Ubuntu, in Terminal:", command: engine === "libreoffice" ? "sudo apt install libreoffice" : "sudo apt install tesseract-ocr" };
  return null;
}

function openPage(url: string) {
  const shell = window.workFoldDesktop?.shell;
  if (shell) void shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function InstallCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="setup-command">
    <span>{label}</span>
    <span className="setup-command-line"><code>{command}</code>
      <button type="button" className="ui-control" onClick={() => void copyToClipboard({ text: command }).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Copied" : "Copy"}</button>
    </span>
  </span>;
}

/** Where it is and which version a Check saw stay supporting detail, in the state's tooltip. */
function EngineRow({ name, engine, command, action, children }: { name: string; engine: DocumentEngineSetup; command: { label: string; command: string } | null; action: { label: string; url: string }; children: string }) {
  const working = engine.found && !engine.problem;
  return <li className={working ? "done" : ""}>
    {working ? <Check size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
    <span><strong>{name}</strong> {children}
      {engine.problem ? <span className="setup-command">It didn't start. {engine.problem}</span> : null}
      {!engine.found && command ? <InstallCommand {...command} /> : null}
    </span>
    {engine.found ? <span className={engine.problem ? "setup-checklist-state problem" : "setup-checklist-state"} title={[engine.path, engine.version].filter(Boolean).join(" · ")}>{engine.problem ? "Didn't start" : "Installed"}</span>
      : <button type="button" className="ui-control" onClick={() => openPage(action.url)}>{action.label}</button>}
  </li>;
}

/**
 * The two programs a Worker uses to check its documents. Status reads look for
 * them every few seconds, so a row ticks off soon after the person installs it.
 */
export function DocumentsEngineSetup({ status, enabled }: { status: IncludedToolStatus | null; enabled: boolean }) {
  const setup = status?.documentsSetup;
  if (!enabled || !setup) return null;
  const { platform, homebrew, libreoffice, tesseract } = setup;
  const libreOfficeCommand = documentEngineInstallCommand("libreoffice", platform, homebrew);
  const tesseractCommand = documentEngineInstallCommand("tesseract", platform, homebrew);
  const missing = !libreoffice.found || !tesseract.found;
  return <>
    <ul className="setup-checklist documents-engines" aria-label="Programs for checking documents">
      <EngineRow name="LibreOffice" engine={libreoffice} command={libreOfficeCommand} action={{ label: "Download", url: libreOfficeDownloadUrl }}>lets your Worker see Word and PowerPoint pages and calculate spreadsheet formulas.</EngineRow>
      <EngineRow name="Tesseract" engine={tesseract} command={tesseractCommand} action={{ label: "Install guide", url: tesseractInstallGuideUrl }}>(optional) lets your Worker read the text in scanned pages.</EngineRow>
    </ul>
    {missing ? <p className="setup-hint">Both are free.{platform === "darwin" && !libreoffice.found ? " After installing LibreOffice, open it once so macOS can approve it." : ""} This page updates by itself.</p> : null}
  </>;
}
