import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";

const candidates = {
  libreoffice: ["soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"],
  tesseract: ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"],
};

export async function discoverDocumentEngines({ path = process.env.PATH ?? "" } = {}) {
  const found = {};
  for (const [name, entries] of Object.entries(candidates)) {
    let executable = null;
    for (const entry of entries.flatMap((entry) => entry.includes("/") ? [entry] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, entry)))) {
      try { await access(entry, constants.X_OK); if ((await stat(entry)).isFile()) { executable = entry; break; } } catch {}
    }
    found[name] = { available: !!executable, executable, operations: name === "libreoffice" ? ["render", "recalculate"] : ["ocr"],
      setup: executable ? null : name === "libreoffice" ? "Install LibreOffice, or supply its executable path. Existing Office apps remain usable through computer tools." : "Install Tesseract and the required language data, or supply its executable path. Render PDF pages to images first." };
  }
  return found;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Own the process group until it exits; logs stay readable even after Stop. */
async function execute(executable, args, { signal, cwd, logPath }) {
  if (signal?.aborted) throw new Error("Document engine stopped before execution.");
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  let preview = "", killTimer, processSettled = false;
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  const kill = (force = false) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => { try { child.kill(); } catch {} });
    } else { try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {} }
  };
  const abort = () => {
    kill(processSettled);
    if (!processSettled) killTimer ??= setTimeout(() => kill(true), 1000);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    if (!log.write(chunk)) { stream.pause(); log.once("drain", () => stream.resume()); }
    preview = (preview + chunk.toString("utf8")).slice(-16_384);
  });
  // A logging failure cancels owned execution instead of crashing the host.
  let logError;
  log.on("error", (error) => { logError = error; abort(); });
  try {
    const result = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
    if (signal?.aborted) throw new Error("Document engine stopped; inspect the output and retained log before deciding whether to retry.");
    if (logError) throw logError;
    if (result.code !== 0) throw new Error(`Document engine exited ${result.code ?? result.signal}. ${preview}`);
    return preview.trim();
  } finally {
    processSettled = true;
    signal?.removeEventListener("abort", abort);
    // A parent may exit on TERM while a descendant ignores it and has closed
    // its inherited pipes. Do not cancel escalation and leave that child alive.
    if (killTimer) { kill(true); clearTimeout(killTimer); }
    log.end(); await finished(log).catch(() => {});
  }
}

export async function runDocumentEngine({ operation, source, output, enginePath, language = "eng", timeoutMs, cwd = process.cwd(), stateRoot, signal }) {
  if (!["render", "recalculate", "ocr"].includes(operation)) throw new Error("Choose render, recalculate, or ocr.");
  if (!source || !output) throw new Error("Source and a new output file path are required.");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) throw new Error("timeoutMs must fit a positive Node timer (at most 2147483647 ms); omit for no deadline.");
  if (!/^[a-zA-Z0-9_+.-]+$/.test(language) || language.startsWith("-")) throw new Error("Use Tesseract language identifiers, such as eng or eng+deu.");
  const engineName = operation === "ocr" ? "tesseract" : "libreoffice";
  const engine = enginePath ? { executable: resolve(cwd, enginePath) } : (await discoverDocumentEngines())[engineName];
  if (!engine.executable) throw new Error(engine.setup);
  const from = resolve(cwd, source), to = resolve(cwd, output);
  const extension = extname(from).toLowerCase();
  if (from === to) throw new Error("Choose a separate output path; the source remains unchanged.");
  if (operation === "render" && extname(to).toLowerCase() !== ".pdf") throw new Error("Render output must be a PDF.");
  if (operation === "recalculate" && (extension !== ".xlsx" || extname(to).toLowerCase() !== ".xlsx")) throw new Error("Recalculation accepts an XLSX source and writes a separate XLSX result.");
  if (operation === "ocr" && extension === ".pdf") throw new Error("Render the selected PDF pages first; OCR accepts a page image.");
  if (operation === "ocr" && extname(to).toLowerCase() !== ".txt") throw new Error("OCR output must be a text file.");
  try { await stat(to); throw new Error("The output already exists. Choose a new path."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const parent = join(stateRoot ?? tmpdir(), "document-artifacts");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(parent, "engine-"));
  const scratch = join(run, "scratch"), logPath = join(run, "engine.log");
  await mkdir(join(scratch, "converted"), { recursive: true });
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const timer = timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
  let sourceIdentity;
  try {
    const before = await stat(from);
    if (!before.isFile()) throw new Error("The source must be an ordinary file.");
    const captured = join(scratch, `source${extension}`);
    await copyFile(from, captured, constants.COPYFILE_EXCL);
    const after = await stat(from);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Source changed while capturing it. Inspect the current file and retry deliberately.");
    sourceIdentity = { path: from, sha256: await digest(captured), sizeBytes: before.size };
    const version = await execute(engine.executable, ["--version"], { signal: controller.signal, cwd: scratch, logPath });
    let produced;
    if (operation === "ocr") {
      const base = join(scratch, "converted", "recognized");
      await execute(engine.executable, [captured, base, "-l", language], { signal: controller.signal, cwd: scratch, logPath });
      produced = base + ".txt";
    } else {
      const profile = join(scratch, "profile");
      await mkdir(join(profile, "user"), { recursive: true });
      await writeFile(join(profile, "user", "registrymodifications.xcu"), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>');
      const format = operation === "render" ? "pdf" : "xlsx:Calc MS Excel 2007 XML";
      await execute(engine.executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--norestore", "--convert-to", format, "--outdir", join(scratch, "converted"), captured],
        { signal: controller.signal, cwd: scratch, logPath });
      produced = join(scratch, "converted", operation === "render" ? "source.pdf" : "source.xlsx");
    }
    const info = await stat(produced);
    if (!info.isFile() || (operation !== "ocr" && !info.size)) throw new Error("The engine produced no usable output; inspect its log.");
    if (controller.signal.aborted) throw new Error("Document engine stopped before publishing its output.");
    await mkdir(dirname(to), { recursive: true });
    await copyFile(produced, to, constants.COPYFILE_EXCL);
    return { operation, source: sourceIdentity, output: { path: to, sha256: await digest(to), sizeBytes: info.size },
      engine: { name: engineName, executable: engine.executable, version }, logPath,
      note: operation === "recalculate" ? "Calculated and saved by LibreOffice Calc. Inspect formula results and compatibility with the intended spreadsheet app." : operation === "ocr" ? "OCR output can contain recognition errors. Compare important text with the source image." : "Rendered by LibreOffice. Inspect the resulting PDF; layout may differ from Microsoft Office.",
      retention: "The engine log is retained in machine-local document-artifacts until deliberately removed; temporary input and engine profile are removed." };
  } catch (error) {
    error.message += `\nRetained engine log: ${logPath}. No automatic replay. Output path to inspect: ${to}.`;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    await rm(scratch, { recursive: true, force: true });
  }
}

export function registerDocumentEngineTools(pi, host) {
  const active = new Set();
  let closing = false;
  pi.on("session_shutdown", async () => {
    closing = true;
    for (const entry of active) entry.controller.abort();
    await Promise.allSettled([...active].map((entry) => entry.done));
  });
  pi.registerTool({
    name: "document_engine", label: "Render, calculate, or recognize document text",
    description: "Use an installed document engine. status detects LibreOffice (Office-to-PDF rendering and XLSX recalculation) and Tesseract (OCR of selected page images) without starting them. Other operations write a new normal file, preserve source bytes, report engine/source/output identity, and support Stop. No default deadline. Engines are optional installed programs, not bundled or automatically installed. Use document_run to inspect the rendered PDF, calculated workbook, or page image.",
    parameters: { type: "object", properties: {
      operation: { type: "string", enum: ["status", "render", "recalculate", "ocr"] },
      source: { type: "string" }, output: { type: "string" }, enginePath: { type: "string" }, language: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    }, required: ["operation"] },
    async execute(_id, parameters, signal, _update, context) {
      if (closing) throw new Error("This document session has closed.");
      if (parameters.operation === "status") return { content: [{ type: "text", text: JSON.stringify(await discoverDocumentEngines()) }] };
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
      let settle;
      const entry = { controller, done: new Promise((resolve) => { settle = resolve; }) };
      active.add(entry);
      try {
        const result = await runDocumentEngine({ ...parameters, signal: controller.signal, cwd: context.cwd ?? host?.cwd, stateRoot: host?.stateRoot });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } finally { active.delete(entry); signal?.removeEventListener("abort", stop); settle(); }
    },
  });
}
