import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { utf8Prefix } from "./output.mjs";

export const DOCUMENT_LIMITS = Object.freeze({
  scriptBytes: 1024 * 1024, textBytes: 64 * 1024, pdfTextBytes: 32 * 1024,
  imageBytes: 2 * 1024 * 1024, totalImageBytes: 8 * 1024 * 1024,
  pngBytes: 20 * 1024 * 1024, pdfBytes: 64 * 1024 * 1024, pagePixels: 4_000_000,
  canvasDimension: 32767, workerHeapMb: 512,
});

async function scriptSnapshot(script, cwd) {
  const path = await realpath(resolve(cwd, script));
  if (![".js", ".mjs", ".cjs"].includes(extname(path))) throw new Error("Use an ordinary .js, .mjs or .cjs script file.");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("The script must be a file.");
    const bytes = Buffer.alloc(DOCUMENT_LIMITS.scriptBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const part = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > DOCUMENT_LIMITS.scriptBytes) throw new Error("The document script exceeds the 1 MiB limit.");
    const snapshot = bytes.subarray(0, bytesRead);
    return { path, source: snapshot.toString("utf8"), sha256: createHash("sha256").update(snapshot).digest("hex") };
  } finally { await handle.close(); }
}

/** A full-trust worker is a cancellable lifecycle boundary, not a sandbox. */
function runWorker(data, { signal, timeoutMs, onUpdate } = {}) {
  if (signal?.aborted) return Promise.reject(new Error("Document run stopped before execution."));
  return new Promise((resolveResult, reject) => {
    const workerUrl = new URL("./worker.mjs", import.meta.url);
    workerUrl.pathname = workerUrl.pathname.replace(/\.asar\//, ".asar.unpacked/");
    const worker = new Worker(workerUrl, {
      workerData: { ...data, limits: DOCUMENT_LIMITS }, stdout: true, stderr: true, execArgv: [],
      // Bounds V8's heap, not native/external allocations; this is not a sandbox.
      resourceLimits: { maxOldGenerationSizeMb: DOCUMENT_LIMITS.workerHeapMb },
    });
    let settled = false, logs = "", logBytes = 0, logsTruncated = false;
    let metadata = {}, progress, observationBytes = 0, observationsTruncated = false;
    const images = [], observations = [];
    const logsPath = data.artifactsRoot && join(data.artifactsRoot, "logs.txt");
    const logStream = logsPath && createWriteStream(logsPath, { flags: "wx" });
    // Pipe with backpressure; full logs do not accumulate in the host heap.
    if (logStream) { worker.stdout.pipe(logStream, { end: false }); worker.stderr.pipe(logStream, { end: false }); }
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const capture = (text) => {
      const admitted = utf8Prefix(text, DOCUMENT_LIMITS.textBytes - logBytes);
      logs += admitted; logBytes += Buffer.byteLength(admitted);
      if (Buffer.byteLength(admitted) < Buffer.byteLength(text)) logsTruncated = true;
    };
    worker.stdout.on("data", (chunk) => capture(decoders[0].write(chunk)));
    worker.stderr.on("data", (chunk) => capture(decoders[1].write(chunk)));
    let timer;
    const finish = async (error, result, outcome = error ? "failed" : "succeeded") => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", stop);
      try { await worker.terminate(); }
      catch (cleanupError) { error ??= new Error(`Document worker cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Inspect output files before retrying.`); outcome = "failed"; }
      if (logStream) {
        await Promise.allSettled([finished(worker.stdout), finished(worker.stderr)]);
        for (const decoder of decoders) capture(decoder.end());
        worker.stdout.unpipe(logStream); worker.stderr.unpipe(logStream); logStream.end();
        try { await finished(logStream); } catch (logError) { error ??= logError; outcome = "failed"; }
      }
      const envelope = {
        ...metadata, ...(progress ? { ...progress, valueIsProgress: !result } : { value: "", valueFormat: "text", valueTruncated: false }), ...result,
        script: data.script && { path: data.script.path, sha256: data.script.sha256 }, cwd: data.cwd,
        outcome, images, logs, logsTruncated, observations, observationsTruncated,
        ...(data.artifactsRoot ? { artifacts: { directory: data.artifactsRoot, owner: "This document_run", retention: "Retained until deliberately removed; no automatic replay or deletion.", logs: logsPath, observations: join(data.artifactsRoot, "observations.ndjson"), manifest: join(data.artifactsRoot, "run.json") } } : {}),
        ...(error ? { failure: { message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}), effects: "Files or external effects may already exist. Inspect the retained observations and outputs before deciding what to do next; this script was not replayed." } } : {}),
      };
      if (data.artifactsRoot) {
        try { await writeFile(join(data.artifactsRoot, "run.json"), JSON.stringify({ ...envelope, images: images.map(({ provenance }) => provenance) }, null, 2), { flag: "wx" }); }
        catch (manifestError) {
          error ??= manifestError;
          envelope.outcome = "failed";
          envelope.failure ??= { message: error.message, effects: "The run manifest could not be saved. Inspect the other retained files before deciding what to do next; no work was replayed." };
        }
      }
      if (error) { error.partialResult = envelope; reject(error); } else resolveResult(envelope);
    };
    logStream?.on("error", (error) => void finish(error));
    const stop = () => void finish(new Error("Document run stopped. Files already written may remain; inspect them before retrying."), undefined, "stopped");
    // Chunk long deadlines to avoid Node's signed 32-bit timer overflow. No
    // default deadline: like native Pi bash, Stop remains available throughout.
    if (timeoutMs !== undefined) {
      const started = performance.now();
      const arm = () => {
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining <= 0) void finish(new Error(`Document run exceeded ${timeoutMs} ms and was stopped. Files already written may remain; inspect them before retrying.`), undefined, "timed_out");
        else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    }
    signal?.addEventListener("abort", stop, { once: true });
    let lastUpdate = 0;
    worker.on("message", (message) => {
      if (settled) return;
      if (message.metadata) { metadata = message.metadata; return; }
      if (message.image) { images.push(message.image); return; }
      if (message.observation) {
        const size = Buffer.byteLength(JSON.stringify(message.observation));
        if (observationBytes + size <= DOCUMENT_LIMITS.textBytes) { observations.push(message.observation); observationBytes += size; }
        else observationsTruncated = true;
        return;
      }
      if (message.progress) {
        progress = message.progress;
        if (onUpdate && performance.now() - lastUpdate >= 250) {
          lastUpdate = performance.now();
          try { Promise.resolve(onUpdate({ ...progress, artifactsDirectory: data.artifactsRoot })).catch(() => {}); } catch { /* UI progress must not fail a user's script. */ }
        }
        return;
      }
      let error;
      if (message.error) {
        error = new Error(message.error.message ?? String(message.error));
        if (message.error.diagnostic) {
          error.diagnostic = message.error.diagnostic; error.name = error.diagnostic.name;
          if (error.diagnostic.code) error.code = error.diagnostic.code;
          error.stack = `${error.name}: ${error.message}\n${error.diagnostic.frames.join("\n")}`;
        }
      }
      void finish(error, message.result);
    });
    worker.once("error", (error) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") error.message = `Document script exceeded its ${DOCUMENT_LIMITS.workerHeapMb} MiB JavaScript heap limit. This run stopped; files already written may remain. Inspect them and reduce the script's retained data before retrying.`;
      void finish(error);
    });
    worker.once("exit", (code) => { if (!settled) void finish(new Error(`Document worker exited (${code}) without a result. Inspect output files before retrying.`)); });
    if (signal?.aborted) stop();
  });
}

export async function runDocumentScript({ script, cwd, stateRoot, artifactsDir, args = [], timeoutMs, signal, onUpdate }) {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("timeoutMs must be a positive safe integer, or omitted for no deadline.");
  if (signal?.aborted) throw new Error("Document run stopped before execution.");
  const snapshot = await scriptSnapshot(script, cwd);
  const temporaryBase = stateRoot ? join(resolve(stateRoot), "document-runs") : tmpdir();
  const artifactsBase = artifactsDir ? resolve(cwd, artifactsDir) : join(stateRoot ? resolve(stateRoot) : tmpdir(), "document-artifacts");
  await mkdir(temporaryBase, { recursive: true }); await mkdir(artifactsBase, { recursive: true });
  const reviewRoot = await mkdtemp(join(temporaryBase, "document-run-"));
  try {
    const artifactsRoot = await mkdtemp(join(artifactsBase, "run-"));
    await writeFile(join(artifactsRoot, "observations.ndjson"), "", { flag: "wx" });
    return await runWorker({ mode: "run", cwd: resolve(cwd), args, script: snapshot, reviewRoot, artifactsRoot }, { signal, timeoutMs, onUpdate });
  } finally { await rm(reviewRoot, { recursive: true, force: true }); }
}

/** Imports actual bundled libraries and encodes a canvas in memory. No model or user-file writes. */
export async function probeIncludedDocuments({ signal } = {}) {
  try {
    const result = await runWorker({ mode: "probe" }, { signal, timeoutMs: 20_000 });
    return { state: "ready", reason: "Document libraries and PDF rendering are ready.", versions: result.versions, runtime: result.runtime };
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error), ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  }
}
