/**
 * Bounded inference for Space apps: `assistant.infer` runs one model call on
 * the owning Space's configured model with no tools, no transcript, and an
 * optional schema-validated JSON result. This file is the contract shared by
 * the app bridge, the local API, and the desktop host; it carries no runtime
 * code and imports nothing from `src/local`.
 */

/**
 * Every bound an inference call can hit, in one place. Concurrency counts are
 * per installation unless named otherwise. Provider transport, cancellation,
 * and concurrency govern call duration; this lane has no host wall-clock cap.
 */
export const restrictedAppInferenceLimits = Object.freeze({
  instructionsBytes: 16 * 1024,
  inputBytes: 256 * 1024,
  schemaBytes: 32 * 1024,
  defaultOutputBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
  runningPerInstallation: 4,
  waitingPerInstallation: 12,
  runningMachineWide: 8,
  receipts: 2_000,
  listItems: 50,
});

/** Closed error vocabulary; every message names the bound or state it reports. */
export type RestrictedAppInferenceErrorCode =
  | "INFER_INVALID"
  | "INFER_INPUT_TOO_LARGE"
  | "INFER_MODEL_UNAVAILABLE"
  | "INFER_BUSY"
  | "INFER_OUTPUT_TOO_LARGE"
  | "INFER_OUTPUT_INVALID"
  | "INFER_INTERRUPTED"
  | "INFER_FAILED"
  | "INFER_UNAVAILABLE";

/** Exactly the bridge argument: `assistant.infer({ instructions, input, outputSchema?, maxOutputBytes? })`. */
export interface RestrictedAppInferenceRequest {
  instructions: string;
  /** Text, or any JSON value; the host serializes non-text input with two-space indentation before the call. */
  input: unknown;
  /** The closed JSON Schema subset app tools already use; parsed host-side. */
  outputSchema?: unknown;
  maxOutputBytes?: number;
}

export interface RestrictedAppInferenceModelRef {
  provider: string;
  id: string;
}

export interface RestrictedAppInferenceUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What the app receives: text when no schema was given, otherwise the validated
 * value. `receiptId` is the id of the journal line this call produced, so the
 * id a `bridge.tasks.onChanged` hint carries can be matched to the call the app
 * made without reading anything back.
 */
export type RestrictedAppInferenceResult =
  | { text: string; truncated: boolean; receiptId: string; model: RestrictedAppInferenceModelRef; usage: RestrictedAppInferenceUsage }
  | { json: unknown; receiptId: string; model: RestrictedAppInferenceModelRef; usage: RestrictedAppInferenceUsage };

/** One journal event; the Apps tab lists the latest event per owned invocation. */
export interface RestrictedAppInferenceReceipt {
  v: 1;
  id: string;
  at: string;
  spaceId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  surface: "view" | "worker";
  outcome: "accepted" | "ok" | "error";
  errorCode?: RestrictedAppInferenceErrorCode;
  inputBytes: number;
  outputBytes?: number;
  schema: boolean;
  model?: RestrictedAppInferenceModelRef;
  usage?: RestrictedAppInferenceUsage & { amountUsd?: number };
  durationMs?: number;
}
