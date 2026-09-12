/** Machine-local diagnostics; these records never become Assistant context. */
export type ModelContextValue = null | boolean | number | string | ModelContextValue[] | { [key: string]: ModelContextValue };

export interface ModelContextOwner {
  spaceRoot: string;
  conversationId: string;
  sessionId: string;
  taskId?: string;
  purpose: string;
}

export interface ModelContextFilter {
  spaceRoot?: string;
  conversationId?: string;
}

export interface ModelContextInspectionLimits {
  records: number;
  recordBytes: number;
  totalBytes: number;
  retentionMs: number;
  payloadSamples: number;
  depth: number;
  nodes: number;
  digestBytes: number;
}

export interface ModelContextSnapshot {
  capturedAt: number;
  value: ModelContextValue;
  truncated: boolean;
  omissions: string[];
  bytes: number;
}

export interface ModelContextInspectionSummary {
  id: string;
  owner: ModelContextOwner;
  provider: string;
  model: string;
  api: string;
  createdAt: number;
  /** Observing a response does not establish completion or successful work. */
  status: "captured" | "response_received" | "dispatch_error";
  stage: "assembled" | "provider_payload";
  payloadSamples: number;
  truncated: boolean;
  bytes: number;
}

export interface ModelContextInspection extends ModelContextInspectionSummary {
  assembled: ModelContextSnapshot;
  /** Origins from the loaded runtime at dispatch; not reconstructed from later disk contents. */
  provenance?: ModelContextSnapshot;
  /** Native onPayload observations, not a count of HTTP attempts or retries. */
  payloads: ModelContextSnapshot[];
}

export interface ModelContextInspectionState {
  enabled: boolean;
  records: ModelContextInspectionSummary[];
  limits: ModelContextInspectionLimits;
}
