import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

export const DOCUMENT_LIMITS = Object.freeze({
  timeoutMs: 60_000, maxTimeoutMs: 120_000, scriptBytes: 1024 * 1024,
  textBytes: 64 * 1024, imageBytes: 2 * 1024 * 1024, totalImageBytes: 8 * 1024 * 1024,
  images: 4, pdfBytes: 64 * 1024 * 1024, pdfPages: 8, pagePixels: 4_000_000,
  workerHeapMb: 512,
});

async function scriptSnapshot(script, cwd) {
  const path = await realpath(resolve(cwd, script));
  if (![".js", ".mjs", ".cjs"].includes(extname(path))) throw new Error("Use an ordinary .js, .mjs or .cjs script file.");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("The script must be a file.");
    const bytes = Buffer.alloc(DOCUMENT_LIMITS.scriptBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > DOCUMENT_LIMITS.scriptBytes) throw new Error("The document script exceeds the 1 MiB limit.");
    const snapshot = bytes.subarray(0, bytesRead);
    return { path, source: snapshot.toString("utf8"), sha256: createHash("sha256").update(snapshot).digest("hex") };
  } finally { await handle.close(); }
}

/** A full-trust worker is a cancellable lifecycle boundary, not a sandbox. */
function runWorker(data, { signal, timeoutMs = DOCUMENT_LIMITS.timeoutMs } = {}) {
  if (signal?.aborted) return Promise.reject(new Error("Document run stopped before execution."));
  return new Promise((resolveResult, reject) => {
    // Start from the deliberately unpacked worker entrypoint. Native bindings
    // are also real files; ordinary JS libraries and PDF assets stay archived.
    const workerUrl = new URL("./worker.mjs", import.meta.url);
    workerUrl.pathname = workerUrl.pathname.replace(/\.asar\//, ".asar.unpacked/");
    const worker = new Worker(workerUrl, {
      workerData: { ...data, limits: DOCUMENT_LIMITS }, stdout: true, stderr: true, execArgv: [],
      // Keep an accidental allocation loop in one script from exhausting the
      // interactive host before its timer or Stop can complete. This bounds
      // V8's heap, not native/external allocations, and is not a sandbox.
      resourceLimits: { maxOldGenerationSizeMb: DOCUMENT_LIMITS.workerHeapMb },
    });
    let settled = false;
    let logs = "";
    let logBytes = 0;
    let truncated = false;
    const capture = (chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = DOCUMENT_LIMITS.textBytes - logBytes;
      if (remaining > 0) { logs += bytes.subarray(0, remaining).toString("utf8"); logBytes += Math.min(remaining, bytes.length); }
      if (bytes.length > remaining) truncated = true;
    };
    worker.stdout.on("data", capture);
    worker.stderr.on("data", capture);
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      try { await worker.terminate(); }
      catch (cleanupError) {
        error ??= new Error(`Document worker cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Inspect output files before retrying.`);
      }
      if (error) reject(error);
      else resolveResult({ ...result, logs, logsTruncated: truncated });
    };
    const stop = () => void finish(new Error("Document run stopped. Files already written may remain; inspect them before retrying."));
    const timer = setTimeout(() => void finish(new Error(`Document run exceeded ${timeoutMs} ms and was stopped. Files already written may remain; inspect them before retrying.`)), timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (message) => {
      let error;
      if (message.error) {
        error = new Error(message.error.message ?? String(message.error));
        if (message.error.diagnostic) {
          error.diagnostic = message.error.diagnostic;
          error.name = error.diagnostic.name;
          if (error.diagnostic.code) error.code = error.diagnostic.code;
          error.stack = `${error.name}: ${error.message}\n${error.diagnostic.frames.join("\n")}`;
        }
      }
      void finish(error, message.result);
    });
    worker.once("error", (error) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
        error.message = `Document script exceeded its ${DOCUMENT_LIMITS.workerHeapMb} MiB JavaScript heap limit. This run stopped; files already written may remain. Inspect them and reduce the script's retained data before retrying.`;
      }
      void finish(error);
    });
    worker.once("exit", (code) => { if (!settled) void finish(new Error(`Document worker exited (${code}) without a result. Inspect output files before retrying.`)); });
    if (signal?.aborted) stop();
  });
}

export async function runDocumentScript({ script, cwd, stateRoot, args = [], timeoutMs = DOCUMENT_LIMITS.timeoutMs, signal }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DOCUMENT_LIMITS.maxTimeoutMs) throw new Error("timeoutMs must be between 1 and 120000.");
  const snapshot = await scriptSnapshot(script, cwd);
  const temporaryBase = stateRoot ? join(resolve(stateRoot), "document-runs") : tmpdir();
  await mkdir(temporaryBase, { recursive: true });
  const reviewRoot = await mkdtemp(join(temporaryBase, "document-run-"));
  try {
    return await runWorker({ mode: "run", cwd: resolve(cwd), args, script: snapshot, reviewRoot }, { signal, timeoutMs });
  } finally {
    // Result image bytes are captured before settlement. These are only the
    // host-owned scratch renders; explicit deliverable paths are never removed.
    await rm(reviewRoot, { recursive: true, force: true });
  }
}

/** Imports the actual bundled libraries and encodes a canvas in memory. No model or user-file writes. */
export async function probeIncludedDocuments({ signal } = {}) {
  try {
    const result = await runWorker({ mode: "probe" }, { signal, timeoutMs: 20_000 });
    return { state: "ready", reason: "Document libraries and PDF rendering are ready.", versions: result.versions, runtime: result.runtime };
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error), ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  }
}
