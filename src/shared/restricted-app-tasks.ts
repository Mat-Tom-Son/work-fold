/** Public projection of one app-requested, person-approved Space Assistant task. */
export interface RestrictedAppAssistantTask {
  id: string;
  requestId: string;
  actionId: string;
  title: string;
  status: "pending" | "dispatching" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "expired";
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  cancellationRequested?: true;
  /** Present only after a successful turn. No other Chat messages are exposed. */
  result?: { text: string; truncated: boolean };
}

export interface RestrictedAppTaskReview {
  task: RestrictedAppAssistantTask;
  instructions: string;
  inputJson: string;
  reviewDigest: string;
  conversationId: string | null;
}

/** These limits bound app input and delivery, not the ordinary Space Assistant's tools. */
export const restrictedAppAssistantLimits = Object.freeze({
  actions: 8,
  instructions: 4_096,
  inputBytes: 8_192,
  resultBytes: 32_768,
  records: 1_000,
  listItems: 50,
  pendingPerInstallation: 4,
  requestAgeMs: 15 * 60_000,
  reviewAgeMs: 24 * 60 * 60_000,
});
