import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import type { ProviderAccountDetails, ProviderUsageLimit, ProviderUsageWindow } from "../../shared/provider-account.js";
import type { ResolvedPiRuntime } from "./pi-runtime-config.js";

const userInfoUrl = "https://auth.openai.com/api/accounts/oauth/userinfo";
// The read endpoints used by OpenAI's Codex account client. The direct-plan
// grant was live-tested and rejects both with 401; only a Codex grant uses them.
const codexAccountsUrl = "https://chatgpt.com/backend-api/wham/accounts/check";
const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const maximumProfileBytes = 64 * 1024;
type Runtime = Pick<ResolvedPiRuntime, "credentials" | "modelRuntime">;

/** Trusted Settings read; Pi owns credential storage and serialized refresh. */
export async function readOpenAiAccount(runtime: Runtime, provider: ProviderAccountDetails["provider"]): Promise<ProviderAccountDetails> {
  const empty: ProviderAccountDetails = {
    provider, connected: false, email: null, workspaceName: null, workspaceId: null, plan: null,
    source: null, checkedAt: null, error: null, limitsAvailability: provider === "openai" ? "unsupported" : "unavailable",
    limits: [], availableResets: null, applicableResets: null, usageUrl: provider === "openai" ? "https://chatgpt.com/settings/usage" : "https://chatgpt.com/codex/settings/usage",
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
    if (!credential.access || auth?.auth.apiKey !== credential.access) throw new Error("Account authentication unavailable.");
    const result = provider === "openai-codex"
      ? await readCodexAccount(empty, credential, details, signal)
      : await readDirectAccount(empty, credential, details, signal);
    const after = await runtime.credentials.read(provider);
    if (!sameCredential(credential, after)) return changedAccount(empty, after);
    return result;
  } catch {
    const current = await runtime.credentials.read(provider);
    if (!sameCredential(credential, current)) return changedAccount(empty, current);
    return { ...empty, ...details, connected: true, identityNeedsReconnect: provider === "openai" && !details.email,
      source: details.email || details.workspaceId ? "saved_sign_in" : null,
      error: "OpenAI account details could not be refreshed. Your saved connection has been kept." };
  }
}

async function readDirectAccount(empty: ProviderAccountDetails, credential: OAuthCredential, saved: ReturnType<typeof savedAccount>, signal: AbortSignal): Promise<ProviderAccountDetails> {
  const profile = await requestProfile(userInfoUrl, { authorization: `Bearer ${credential.access}`, accept: "application/json" }, signal);
  const subject = jwtClaims(credential.access).sub;
  if (typeof profile.sub !== "string" || !profile.sub || subject && subject !== profile.sub) throw new Error("Account profile mismatch.");
  const email = field(profile.email, 320) ?? saved.email;
  return { ...empty, ...saved, email, connected: true, identityNeedsReconnect: !email,
    source: field(profile.email, 320) ? "provider" : saved.email ? "saved_sign_in" : null, checkedAt: new Date().toISOString() };
}

async function readCodexAccount(empty: ProviderAccountDetails, credential: OAuthCredential, saved: ReturnType<typeof savedAccount>, signal: AbortSignal): Promise<ProviderAccountDetails> {
  if (!saved.workspaceId) throw new Error("Codex connection has no selected workspace.");
  const headers = { authorization: `Bearer ${credential.access}`, accept: "application/json", "chatgpt-account-id": saved.workspaceId };
  const [accounts, usage] = await Promise.allSettled([
    requestProfile(codexAccountsUrl, headers, signal), requestProfile(codexUsageUrl, headers, signal),
  ]);
  const result: ProviderAccountDetails = { ...empty, ...saved, connected: true,
    source: saved.email || saved.workspaceId ? "saved_sign_in" : null };
  const failures: string[] = [];
  if (accounts.status === "fulfilled") {
    const list = accounts.value.accounts;
    const selected = Array.isArray(list) ? list.map(record).find(item => item.id === saved.workspaceId)
      : Object.values(record(list)).map(item => record(record(item).account)).find(item => item.account_id === saved.workspaceId);
    if (selected && selected.is_deactivated !== true) {
      result.workspaceName = field(selected.name) ?? result.workspaceName;
      result.plan = field(selected.plan_type) ?? result.plan;
      result.source = "provider";
    } else failures.push("The selected workspace was not returned");
  } else failures.push("Workspace details could not be refreshed");
  if (usage.status === "fulfilled" && usage.value.account_id === saved.workspaceId) {
    result.plan = field(usage.value.plan_type) ?? result.plan;
    result.limits = usageLimits(usage.value);
    result.availableResets = positiveInteger(record(usage.value.rate_limit_reset_credits).available_count, true);
    result.applicableResets = positiveInteger(record(usage.value.rate_limit_reset_credits).applicable_available_count, true);
    result.limitsAvailability = result.limits.length ? "available" : "unavailable";
    if (!result.limits.length) failures.push("Usage windows were not returned");
    result.source = "provider";
  } else failures.push("Usage limits could not be refreshed");
  if (accounts.status === "fulfilled" || usage.status === "fulfilled") result.checkedAt = new Date().toISOString();
  result.error = failures.length ? `${failures.join(". ")}. Your saved connection has been kept.` : null;
  return result;
}

function usageLimits(profile: Record<string, unknown>): ProviderUsageLimit[] {
  const primary = { id: "codex", name: "Codex", rate: profile.rate_limit };
  const additional = Array.isArray(profile.additional_rate_limits) ? profile.additional_rate_limits.slice(0, 30).map(record)
    .map(item => ({ id: field(item.metered_feature), name: field(item.limit_name), rate: item.rate_limit })) : [];
  return [primary, ...additional].flatMap(item => {
    const rate = record(item.rate);
    const primary = usageWindow(rate.primary_window), secondary = usageWindow(rate.secondary_window);
    return item.id && (primary || secondary) ? [{ id: item.id, name: item.name ?? item.id, primary, secondary }] : [];
  });
}
function usageWindow(value: unknown): ProviderUsageWindow | null {
  const window = record(value);
  if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 10_000) return null;
  const seconds = positiveInteger(window.limit_window_seconds);
  const resetsAt = positiveInteger(window.reset_at);
  return { usedPercent: window.used_percent, windowDurationMins: seconds ? Math.ceil(seconds / 60) : null,
    resetsAt: resetsAt && resetsAt <= 253402300799 ? resetsAt : null };
}
function positiveInteger(value: unknown, allowZero = false): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) ? value : null;
}
function changedAccount(empty: ProviderAccountDetails, current: Credential | undefined): ProviderAccountDetails {
  return current?.type === "oauth" ? { ...empty, connected: true,
    error: "The OpenAI connection changed while details were loading. Refresh account details to see the current account." } : empty;
}
function savedAccount(credential: OAuthCredential, provider: ProviderAccountDetails["provider"]) {
  const identity = record(credential.identity);
  const accessClaims = jwtClaims(credential.access);
  const verified = provider === "openai" && identity.issuer === "https://auth.openai.com"
    && identity.clientId === credential.clientId && identity.subject === accessClaims.sub;
  const claims = provider === "openai-codex" ? accessClaims : {};
  const profile = record(claims["https://api.openai.com/profile"]);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspaceId = provider === "openai-codex" ? field(credential.accountId) : null;
  const selected = Array.isArray(auth.organizations) ? auth.organizations.map(record).find(item => workspaceId && item.id === workspaceId) : undefined;
  return { email: (verified ? field(identity.email, 320) : null) ?? field(profile.email, 320) ?? field(claims.email, 320), workspaceId,
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
async function requestProfile(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers, redirect: "error", signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Account profile unavailable."); }
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
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid profile.");
    return parsed;
  } finally { await reader.cancel().catch(() => undefined); }
}
