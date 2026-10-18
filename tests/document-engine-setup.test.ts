import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore } from "@earendil-works/pi-coding-agent";
import { checkDocumentEngines, discoverDocumentEngines, documentEngineCandidates, includedDocumentsStatus, verifyDocumentEngine, type DocumentEnginesDiscovery } from "../resources/included-tools/readiness.js";
import { listIncludedToolStatus, setupIncludedTool } from "../src/local/agent/included-tool-setup.js";
import type { IncludedToolStatus } from "../src/shared/included-tools.js";
import { includedToolReadiness } from "../web-local/src/lib/included-tool-readiness.js";
import { documentEngineInstallCommand } from "../web-local/src/components/panes/IncludedDocumentsSetup.js";

const posixOnly = { skip: process.platform === "win32" };

function found(libreoffice: string | null, tesseract: string | null = null, platform = "darwin", quicklook: string | null = null): DocumentEnginesDiscovery {
  const engine = (executable: string | null, operations: string[]) => ({ available: Boolean(executable), executable, operations, setup: executable ? null : "Install it." });
  return { platform, homebrew: "/opt/homebrew/bin/brew", libreoffice: engine(libreoffice, ["render", "recalculate"]), tesseract: engine(tesseract, ["ocr"]), quicklook: engine(quicklook, ["preview"]) };
}
const libraries = (state: IncludedToolStatus["state"], extra: Partial<IncludedToolStatus> = {}): IncludedToolStatus =>
  ({ id: "documents", state, detail: state === "unavailable" ? "The bundled PDF renderer failed to load." : "Document libraries and PDF rendering are ready.", checkedAt: "2026-10-18T12:00:00.000Z", ...extra });

test("the Documents word asks for setup only when LibreOffice is missing, never for Tesseract", () => {
  const missing = includedDocumentsStatus(libraries("ready"), found(null, "/opt/homebrew/bin/tesseract"));
  assert.equal(missing.state, "setup_required");
  assert.match(missing.detail, /can make documents but can't check how Word and PowerPoint files look or what spreadsheet formulas calculate/);
  assert.deepEqual(includedToolReadiness(missing), { label: "Setup Needed", tone: "", setup: true });
  assert.equal(includedDocumentsStatus(undefined, found(null)).state, "setup_required", "a known gap needs no earlier check");

  const ready = includedDocumentsStatus(libraries("ready"), found("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
  assert.equal(ready.state, "ready", "Tesseract is optional; its absence never changes the word");
  assert.equal(ready.documentsSetup?.tesseract.found, false);
  assert.equal(ready.checkedAt, "2026-10-18T12:00:00.000Z", "the evidence keeps its own timestamp");
  assert.equal(ready.stale, false);

  assert.equal(includedDocumentsStatus(undefined, found("/usr/bin/soffice")).state, "unknown", "a found engine is not proof the bundled libraries work");
  const mac = includedDocumentsStatus(libraries("ready"), found(null, null, "darwin", "/usr/bin/qlmanage"));
  assert.equal(mac.state, "setup_required", "a one-page preview is not the check LibreOffice gives");
  assert.equal(mac.detail, "Your Worker can preview the first page of a Word file and each slide of a deck, but can't check every page or what spreadsheet formulas calculate. Install LibreOffice to turn that on.");
  assert.deepEqual(mac.documentsSetup?.quicklook, { found: true, path: "/usr/bin/qlmanage" });
  const brokenPreview = libraries("ready", { documentsSetup: { platform: "darwin", homebrew: false, libreoffice: { found: false }, tesseract: { found: false }, quicklook: { found: true, path: "/usr/bin/qlmanage", problem: "It exited 1." } } });
  assert.match(includedDocumentsStatus(brokenPreview, found(null, null, "darwin", "/usr/bin/qlmanage")).detail, /can make documents but can't check/, "a previewer that failed its Check is not offered");
  const broken = includedDocumentsStatus(libraries("unavailable"), found(null));
  assert.equal(broken.state, "unavailable", "bundled libraries that fail are not something an install fixes");
  assert.match(broken.detail, /bundled PDF renderer/);
});

test("a start problem belongs to the exact engine Check ran, and a reinstall clears it", () => {
  const path = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  const checked = libraries("ready", { documentsSetup: { platform: "darwin", homebrew: false, libreoffice: { found: true, path, problem: "It didn't answer within 60 seconds." }, tesseract: { found: false } } });
  const blocked = includedDocumentsStatus(checked, found(path));
  assert.equal(blocked.state, "setup_required");
  assert.match(blocked.detail, /open it once from Applications so macOS can approve it/i);
  const linux = includedDocumentsStatus({ ...checked, documentsSetup: { ...checked.documentsSetup!, platform: "linux" } }, found(path, null, "linux"));
  assert.match(linux.detail, /didn't start\. It didn't answer within 60 seconds\./);
  const elsewhere = includedDocumentsStatus(checked, found("/opt/homebrew/bin/soffice"));
  assert.equal(elsewhere.state, "ready", "evidence about another program never sticks to a new install");
  assert.deepEqual(elsewhere.documentsSetup?.libreoffice, { found: true, path: "/opt/homebrew/bin/soffice" });
});

test("discovery looks on PATH and in the usual install folders without starting anything", posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = join(root, "started");
  const bin = join(root, "bin"), app = join(root, "Applications", "LibreOffice.app", "Contents", "MacOS");
  await mkdir(bin, { recursive: true }); await mkdir(app, { recursive: true });
  const executable = `#!/bin/sh\ntouch ${JSON.stringify(started)}\n`;
  await writeFile(join(app, "soffice"), executable, { mode: 0o700 });
  await writeFile(join(bin, "tesseract"), executable, { mode: 0o700 });
  await writeFile(join(bin, "brew"), "not executable", { mode: 0o600 });
  // The personal Applications folder counts, so a person without admin rights can install LibreOffice too.
  // Only the defaults that live under this test's home or on its PATH, never the test computer's own installs.
  const local = (entries: string[]) => entries.filter((entry) => !entry.startsWith("/") || entry.startsWith(root));
  const defaults = documentEngineCandidates("darwin", root);
  assert.ok(defaults.libreoffice.includes("/Applications/LibreOffice.app/Contents/MacOS/soffice") && defaults.tesseract.includes("/opt/homebrew/bin/tesseract"));
  const discovered = await discoverDocumentEngines({ path: bin, home: root, platform: "darwin", candidates: { libreoffice: local(defaults.libreoffice), tesseract: local(defaults.tesseract), homebrew: ["brew"] } });
  assert.equal(discovered.libreoffice.executable, join(app, "soffice"));
  assert.equal(discovered.tesseract.executable, join(bin, "tesseract"));
  assert.equal(discovered.homebrew, null, "a file that cannot run is not Homebrew");
  await assert.rejects(import("node:fs/promises").then(({ readFile }) => readFile(started)), { code: "ENOENT" });

  const empty = await discoverDocumentEngines({ path: "", home: root, platform: "linux", candidates: { libreoffice: [], tesseract: [], homebrew: [] } });
  assert.equal(empty.libreoffice.available, false);
  assert.match(empty.libreoffice.setup!, /Skills & Extensions → Documents → Set Up/);
  assert.match(empty.libreoffice.setup!, /never install it unless they ask/);
  assert.match(empty.tesseract.setup!, /Skills & Extensions → Documents → Set Up/);
});

test("an explicit Check starts each engine once and reports a version, a failure, or a hang", posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = join(root, "good"), failing = join(root, "failing"), hanging = join(root, "hanging");
  await writeFile(good, "#!/bin/sh\necho\necho 'tesseract 5.5.1'\necho ' leptonica-1.85.0'\n", { mode: 0o700 });
  await writeFile(failing, "#!/bin/sh\necho 'dyld: Library not loaded' >&2\nexit 3\n", { mode: 0o700 });
  await writeFile(hanging, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
  assert.deepEqual(await verifyDocumentEngine(good), { version: "tesseract 5.5.1" });
  assert.deepEqual(await verifyDocumentEngine(failing), { problem: "It exited 3: dyld: Library not loaded" });
  const started = Date.now();
  assert.deepEqual(await verifyDocumentEngine(hanging, { timeoutMs: 200 }), { problem: "It didn't answer within 1 second." });
  assert.ok(Date.now() - started < 5_000, "a hung engine is killed at the deadline");
  const controller = new AbortController();
  const stopping = verifyDocumentEngine(hanging, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await stopping, { problem: "The check was stopped." });
  assert.deepEqual(await checkDocumentEngines({ path: "", home: root, platform: "darwin", candidates: { libreoffice: [failing], tesseract: [good], quicklook: [], homebrew: [] } }), {
    platform: "darwin", homebrew: false,
    libreoffice: { found: true, path: failing, problem: "It exited 3: dyld: Library not loaded" },
    tesseract: { found: true, path: good, version: "tesseract 5.5.1" },
  });
});

test("Set up rechecks by itself: installing and removing LibreOffice changes the word on the next read", posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-engine-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = join(root, "included"), engines = join(root, "engines");
  await mkdir(join(included, "documents"), { recursive: true });
  await writeFile(join(included, "documents", "runtime.mjs"), "export async function probeIncludedDocuments() { return { state: 'ready', reason: 'Document libraries and PDF rendering are ready.', versions: { docx: '9.5.1' }, runtime: 'test' }; }");
  const documentEngineSearch = { path: "", home: root, platform: "darwin", candidates: { libreoffice: [join(engines, "soffice")], tesseract: [join(engines, "tesseract")], quicklook: [], homebrew: [] } };
  const provider = { resolveRuntime: async () => ({ agentDir: join(root, "pi"), credentials: FileCredentialStore.inMemory(), includedTools: { rootPath: included, stateRoot: join(root, "state"), documentEngineSearch } }) };
  const documents = async () => (await listIncludedToolStatus(root, provider)).find(({ id }) => id === "documents")!;

  const checked = await setupIncludedTool(root, "documents", "check", {}, provider);
  assert.equal(checked.status.state, "setup_required", "working libraries without LibreOffice still leave setup to do");
  assert.deepEqual(checked.status.facts, { docx: "9.5.1" });
  assert.equal((await documents()).state, "setup_required");

  await mkdir(engines);
  await writeFile(join(engines, "soffice"), "#!/bin/sh\necho 'LibreOffice 26.8.1.1 synthetic'\n", { mode: 0o700 });
  const installed = await documents();
  assert.equal(installed.state, "ready", "the person's install shows on the next status read, with no further click");
  assert.deepEqual(installed.documentsSetup?.libreoffice, { found: true, path: join(engines, "soffice") });
  const rechecked = await setupIncludedTool(root, "documents", "check", {}, provider);
  assert.equal(rechecked.status.documentsSetup?.libreoffice.version, "LibreOffice 26.8.1.1 synthetic");
  assert.equal((await documents()).documentsSetup?.libreoffice.version, "LibreOffice 26.8.1.1 synthetic");

  await writeFile(join(engines, "soffice"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  assert.equal((await setupIncludedTool(root, "documents", "check", {}, provider)).status.state, "setup_required", "an engine that cannot start is not Ready");
  await rm(join(engines, "soffice"));
  const removed = await documents();
  assert.equal(removed.state, "setup_required");
  assert.match(removed.detail, /Install LibreOffice/);
  await assert.rejects(setupIncludedTool(root, "documents", "install" as never, {}, provider), /Unknown document setup action/, "work-fold never installs an engine itself");
});

test("Set up shows only commands a person runs themselves, matched to their computer", () => {
  assert.deepEqual(documentEngineInstallCommand("libreoffice", "darwin", true), { label: "Or in Terminal, with Homebrew:", command: "brew install --cask libreoffice" });
  assert.deepEqual(documentEngineInstallCommand("tesseract", "darwin", true), { label: "Or in Terminal, with Homebrew:", command: "brew install tesseract" });
  assert.equal(documentEngineInstallCommand("libreoffice", "darwin", false), null, "no Homebrew, no Homebrew command");
  assert.deepEqual(documentEngineInstallCommand("tesseract", "linux", false), { label: "On Debian or Ubuntu, in Terminal:", command: "sudo apt install tesseract-ocr" });
  assert.equal(documentEngineInstallCommand("libreoffice", "win32", false), null);
});
