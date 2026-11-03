import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import type { ProviderAccountDetails } from "../../shared/provider-account.js";
import type { ResolvedPiRuntime } from "./pi-runtime-config.js";

// Published by https://auth.openai.com/.well-known/openid-configuration.
const userInfoUrl = "https://auth.openai.com/api/accounts/oauth/userinfo";
const maximumProfileBytes = 64 * 1024;

/** Explicit Settings read. Pi continues to own credentials, refresh locking and authentication. */
export async function readOpenAiAccount(runtime: Pick<ResolvedPiRuntime, "credentials" | "modelRuntime">, provider: ProviderAccountDetails["provider"]): Promise<ProviderAccountDetails> {
  const empty: ProviderAccountDetails = {
    provider, connected: false, email: null, workspaceName: null, workspaceId: null, plan: null,
    source: null, checkedAt: null, error: null, limitsAvailability: "not_provided", usageUrl: "https://chatgpt.com/settings/usage",
  };
  const initial = await runtime.credentials.read(provider);
  if (initial?.type !== "oauth") return empty;
  let credential = initial;
  let details = savedAccount(credential, provider);
  try {
    const signal = AbortSignal.timeout(10_000);
    const auth = await runtime.modelRuntime.getAuth(provider, { signal });
    const current = await runtime.credentials.read(provider);
    if (current?.type !== "oauth" || !sameRegistration(initial, current)) return changedAccount(empty, current);
    credential = current;
    details = savedAccount(credential, provider);
    // Do not forward provider-specific headers, endpoint overrides or a different auth method.
    if (!credential.access || auth?.auth.apiKey !== credential.access) throw new Error("Account authentication unavailable.");
    const response = await fetch(userInfoUrl, {
      headers: { authorization: `Bearer ${credential.access}`, accept: "application/json" },
      redirect: "error", signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Account profile unavailable.");
    }
    const profile = await readProfile(response);
    const claims = jwtClaims(credential.access);
    if (typeof profile.sub !== "string" || !profile.sub || claims.sub && claims.sub !== profile.sub) throw new Error("Account profile mismatch.");
    const authMetadata = record(profile["https://api.openai.com/auth"]);
    const workspace = record(profile.workspace);
    // A user/email, OAuth client registration, and API organization are not workspace identities.
    const profileWorkspaceId = field(workspace.id) ?? field(profile.workspace_id) ?? field(authMetadata.chatgpt_account_id);
    const workspaceId = details.workspaceId ?? profileWorkspaceId;
    const selectedWorkspace = !details.workspaceId || profileWorkspaceId === details.workspaceId;
    const organizations = Array.isArray(authMetadata.organizations) ? authMetadata.organizations : [];
    const selected = organizations.map(record).find(item => workspaceId && item.id === workspaceId);
    details = {
      email: field(profile.email, 320) ?? details.email,
      workspaceId,
      workspaceName: (selectedWorkspace ? field(workspace.name) ?? field(profile.workspace_name) ?? field(authMetadata.chatgpt_workspace_name) : null)
        ?? field(selected?.title) ?? details.workspaceName,
      plan: (selectedWorkspace ? field(profile.plan_type) ?? field(authMetadata.chatgpt_plan_type) : null) ?? details.plan,
    };
    // A reconnect or disconnect during this read must not return the previous account.
    const currentCredential = await runtime.credentials.read(provider);
    if (!sameCredential(credential, currentCredential)) return changedAccount(empty, currentCredential);
    return { ...empty, ...details, connected: true, source: "provider", checkedAt: new Date().toISOString() };
  } catch {
    const currentCredential = await runtime.credentials.read(provider);
    if (!sameCredential(credential, currentCredential)) return changedAccount(empty, currentCredential);
    // Errors/bodies may contain tokens or private account metadata. Never echo them to the renderer.
    return { ...empty, ...details, connected: true, source: details.email || details.workspaceId ? "saved_sign_in" : null,
      error: "OpenAI account details could not be refreshed. Your saved connection has been kept." };
  }
}

function changedAccount(empty: ProviderAccountDetails, current: Credential | undefined): ProviderAccountDetails {
  return current?.type === "oauth" ? { ...empty, connected: true,
    error: "The OpenAI connection changed while details were loading. Refresh account details to see the current account." } : empty;
}

function savedAccount(credential: OAuthCredential, provider: ProviderAccountDetails["provider"]) {
  // The current direct-token grant keeps its identity metadata opaque. Legacy
  // Codex sign-ins retain an explicit selected account id and profile claims.
  const claims = provider === "openai-codex" ? jwtClaims(credential.access) : {};
  const profile = record(claims["https://api.openai.com/profile"]);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspaceId = provider === "openai-codex" ? field(credential.accountId) : null;
  const selected = Array.isArray(auth.organizations) ? auth.organizations.map(record).find(item => workspaceId && item.id === workspaceId) : undefined;
  return { email: field(profile.email, 320) ?? field(claims.email, 320), workspaceId,
    workspaceName: field(selected?.title), plan: field(auth.chatgpt_plan_type) };
}

function sameRegistration(before: OAuthCredential, after: OAuthCredential): boolean {
  return before.clientId === after.clientId && before.accountId === after.accountId;
}
function sameCredential(before: OAuthCredential, after: Credential | undefined): boolean {
  return after?.type === "oauth" && before.access === after.access && before.refresh === after.refresh && sameRegistration(before, after);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function field(value: unknown, maximum = 256): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
}
function jwtClaims(token: string): Record<string, unknown> {
  if (token.length > maximumProfileBytes) return {};
  try { return record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))); } catch { return {}; }
}
async function readProfile(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Account profile unavailable.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumProfileBytes) throw new Error("Account profile too large.");
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { await reader.cancel().catch(() => undefined); }
}
