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
  limitsAvailability: "not_provided";
  usageUrl: string;
}
