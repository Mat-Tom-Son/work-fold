import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostContext } from "../host.ts";
import { runDocumentScript, probeIncludedDocuments, DOCUMENT_LIMITS } from "./runtime.mjs";

export { probeIncludedDocuments };

export default function documents(pi: ExtensionAPI) {
  const host = hostContext(pi);
  const active = new Map<AbortController, Promise<void>>();
  let closing = false;
  pi.on("session_shutdown", async () => {
    closing = true;
    const runs = [...active];
    for (const [controller] of runs) controller.abort();
    await Promise.allSettled(runs.map(([, settled]) => settled));
  });
  pi.registerTool({
    name: "document_run",
    label: "Run document script",
    description: "Run an ordinary .mjs/.cjs/.js file using bundled DOCX, XLSX, PPTX and PDF libraries in a stoppable Node worker. No external Node/Python installation is needed. Export an async default function receiving {cwd,args,resolve,libraries,readPdf,renderPdf,emitImage}. Use absolute output paths or resolve(path); process.cwd() remains the app process directory. Selected PNGs from emitImage enter the model context. Read the included document-work skill for APIs and limits. This is full-trust code, not a sandbox. Stop ends this worker but does not undo files or external effects already made.",
    parameters: Type.Object({
      script: Type.String({ description: "Path to the ordinary JavaScript file, relative to this Chat's working folder or absolute." }),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000, description: "Default 60000; Stop also cancels the worker." })),
    }),
    async execute(_id, parameters, signal, _update, context) {
      if (closing) throw new Error("This document session has closed.");
      const controller = new AbortController();
      let markSettled!: () => void;
      const settled = new Promise<void>((resolve) => { markSettled = resolve; });
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) controller.abort();
      active.set(controller, settled);
      try {
        const result = await runDocumentScript({ ...parameters, cwd: context.cwd ?? host?.cwd ?? process.cwd(), stateRoot: host?.stateRoot, signal: controller.signal });
        const observations = result.images.map((image) => image.provenance);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ result: result.value, resultTruncated: result.valueTruncated, logs: result.logs, logsTruncated: result.logsTruncated, script: result.script, observations }) },
            ...result.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ],
          details: { script: result.script, cwd: result.cwd, libraries: result.versions, runtime: result.runtime, observations },
        };
      } catch (error) {
        // Native Pi marks thrown tool errors as failures and persists their
        // message. Keep engine diagnostics inspectable through that same lane.
        if (error instanceof Error && "diagnostic" in error) {
          const diagnostic = `\nDocument diagnostic: ${JSON.stringify(error.diagnostic)}`;
          error.message = Buffer.from(error.message).subarray(0, DOCUMENT_LIMITS.textBytes - Buffer.byteLength(diagnostic)).toString("utf8") + diagnostic;
        }
        throw error;
      } finally { active.delete(controller); signal?.removeEventListener("abort", stop); markSettled(); }
    },
  });
}
