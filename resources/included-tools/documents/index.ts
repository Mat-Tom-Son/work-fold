import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostContext } from "../host.ts";
import { runDocumentScript, probeIncludedDocuments, DOCUMENT_LIMITS } from "./runtime.mjs";
import { registerDocumentEngineTools } from "./engines.mjs";
import { documentResultText } from "./output.mjs";

export { probeIncludedDocuments };

export default function documents(pi: ExtensionAPI) {
  const host = hostContext(pi);
  registerDocumentEngineTools(pi, host);
  const active = new Map<AbortController, Promise<void>>();
  let closing = false;
  pi.on("session_shutdown", async () => {
    closing = true;
    const runs = [...active];
    for (const [controller] of runs) controller.abort();
    await Promise.allSettled(runs.map(([, settled]) => settled));
  });
  // Only our explicit envelope changes error status; other tools and native
  // preflight exceptions keep Pi's ordinary handling.
  pi.on("tool_result", (event) => {
    if (event.toolName === "document_run" && event.details && typeof event.details === "object" && "documentRunOutcome" in event.details && event.details.documentRunOutcome !== "succeeded") return { isError: true };
  });
  pi.registerTool({
    name: "document_run",
    label: "Run document script",
    description: "Run an ordinary .mjs/.cjs/.js file using bundled DOCX, XLSX, PPTX and PDF libraries in a stoppable Node worker. No external Node/Python installation is needed. Export an async default function receiving {cwd,args,resolve,libraries,openPdf,readPdf,renderPdf,emitImage,progress}. Use absolute output paths or resolve(path); process.cwd() remains the app process directory. Selected PNGs from emitImage enter the model context. Read the included document-work skill for APIs and limits. This is full-trust code, not a sandbox. Stop ends this worker but does not undo files or external effects already made.",
    parameters: Type.Object({
      script: Type.String({ description: "Path to the ordinary JavaScript file, relative to this Chat's working folder or absolute." }),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional deadline in milliseconds; omitted means no deadline. Stop always cancels the worker." })),
      artifactsDir: Type.Optional(Type.String({ description: "Parent directory for retained run evidence; relative to cwd or absolute. Default: machine-local document-artifacts. Each run creates its own subdirectory, retained until deliberately removed." })),
    }),
    async execute(_id, parameters, signal, update, context) {
      if (closing) throw new Error("This document session has closed.");
      signal?.throwIfAborted();
      const controller = new AbortController();
      let markSettled!: () => void;
      const settled = new Promise<void>((resolve) => { markSettled = resolve; });
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) controller.abort();
      active.set(controller, settled);
      try {
        let result;
        try {
          result = await runDocumentScript({ ...parameters, cwd: context.cwd ?? host?.cwd ?? process.cwd(), stateRoot: host?.stateRoot, signal: controller.signal,
            onLibrariesReady: ({ versions }: { versions: Record<string, string> }) => {
              if (!controller.signal.aborted && !closing) host?.beginIncludedToolObservation?.("documents")?.({ id: "documents", state: "ready", detail: "Document libraries and PDF rendering are ready.", checkedAt: new Date().toISOString(), facts: versions });
            },
            onUpdate: (progress) => update?.({ content: [{ type: "text", text: JSON.stringify({ progress }) }], details: { documentRunProgress: true } }),
          });
        } catch (error) {
          if (error instanceof Error && "partialResult" in error) result = error.partialResult;
          else {
            if (error instanceof Error && "diagnostic" in error) {
              const diagnostic = `\nDocument diagnostic: ${JSON.stringify(error.diagnostic)}`;
              error.message = Buffer.from(error.message).subarray(0, DOCUMENT_LIMITS.textBytes - Buffer.byteLength(diagnostic)).toString("utf8") + diagnostic;
            }
            throw error;
          }
        }
        return {
          content: [
            { type: "text" as const, text: documentResultText(result, DOCUMENT_LIMITS.textBytes) },
            ...result.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ],
          details: { documentRunOutcome: result.outcome, script: result.script, cwd: result.cwd, libraries: result.versions, runtime: result.runtime, artifacts: result.artifacts },
        };
      } finally { active.delete(controller); signal?.removeEventListener("abort", stop); markSettled(); }
    },
  });
}
