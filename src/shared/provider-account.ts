/** Account metadata for trusted Settings only; credentials and raw claims stay in the host. */
export interface ProviderAccountDetails {
  provider: "openai" | "openai-codex";
  connected: boolean;
  email: string | null;
  workspaceName: string | null;
  workspaceId: string | null;
  plan: string | null;
  source: "provider" | "saved_sign_in" | null;
  checkedAt: string | null;
  error: string | null;
  identityNeedsReconnect?: boolean;
  limitsAvailability: "not_provided" | "unsupported" | "unavailable" | "available";
  limits?: ProviderUsageLimit[];
  availableResets?: number | null;
  applicableResets?: number | null;
  usageUrl: string;
}

export interface ProviderUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ProviderUsageLimit {
  id: string;
  name: string;
  primary: ProviderUsageWindow | null;
  secondary: ProviderUsageWindow | null;
}
