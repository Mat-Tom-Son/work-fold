import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";

/**
 * A model response that goes silent is sent again, not waited on for minutes.
 *
 * Pi's HTTP idle timeout only fires when no bytes arrive, and providers keep
 * a stalled stream open with keep-alive pings, so a response can sit silent
 * for ten minutes (measured in the 2026-10-21 evals). Asking the model again
 * changes nothing on the computer, so it is always safe to repeat (Pi
 * Durable's "an interrupted model request is resent", 2026-10-27).
 *
 * When one response produces no stream event for the configured time, this
 * ends it with a retryable "stream timeout" error, keeping whatever partial
 * response had arrived, and Pi's own retry sends the request again within its
 * usual retry budget. It never cuts off a response that is still producing
 * text, thinking, or tool input, however long it runs.
 */

export const defaultPiStreamStallMs = 180_000;

/** The silence that ends one response. `WORKFOLD_PI_STREAM_STALL_MS=0` turns the watchdog off. */
export function piStreamStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKFOLD_PI_STREAM_STALL_MS;
  if (raw === undefined || raw.trim() === "") return defaultPiStreamStallMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultPiStreamStallMs;
}

/** Pi retries errors whose text says "timeout", so this wording also reaches Pi's retry. */
export function stalledStreamMessage(stallMs: number): string {
  const seconds = Math.round(stallMs / 1000);
  return `The AI provider sent nothing for ${seconds} seconds, so work-fold ended this response (stream timeout) to send it again.`;
}

function emptyResponse(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  };
}

/**
 * Starts one model response with its own abort signal (linked to the caller's)
 * and forwards its events, ending it as a retryable error after `stallMs` of
 * silence. With `stallMs` 0 the response is returned untouched.
 */
export async function streamWithStallWatchdog(
  model: Model<Api>,
  signal: AbortSignal | undefined,
  stallMs: number,
  start: (signal: AbortSignal | undefined) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<AssistantMessageEventStream> {
  if (stallMs <= 0) return start(signal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  let upstream: AssistantMessageEventStream;
  try {
    upstream = await start(controller.signal);
  } catch (error) {
    signal?.removeEventListener("abort", forwardAbort);
    throw error;
  }
  const out = createAssistantMessageEventStream();
  let latest: AssistantMessage | undefined;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = () => {
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  };
  const stall = () => {
    // A caller's own abort is Pi's to report; only silence is turned into a retry.
    if (finished || signal?.aborted) return;
    finish();
    out.push({ type: "error", reason: "error", error: { ...(latest ?? emptyResponse(model)), stopReason: "error", errorMessage: stalledStreamMessage(stallMs) } });
    controller.abort(new Error("The model response stalled."));
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(stall, stallMs);
    timer.unref?.();
  };
  arm();
  void (async () => {
    try {
      for await (const event of upstream) {
        if (finished) return;
        if ("partial" in event) latest = event.partial;
        if (event.type === "done" || event.type === "error") {
          finish();
          out.push(event);
          return;
        }
        arm();
        out.push(event);
      }
      if (!finished) {
        finish();
        out.end();
      }
    } catch (error) {
      if (finished) return;
      finish();
      out.push({ type: "error", reason: signal?.aborted ? "aborted" : "error", error: { ...(latest ?? emptyResponse(model)), stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error) } });
    }
  })();
  return out;
}
