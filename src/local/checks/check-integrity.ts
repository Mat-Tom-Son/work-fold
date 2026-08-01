import { createHash } from "node:crypto";

export function workspaceCheckDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function workspaceCheckFingerprint(value: unknown): string {
  return `finding-${workspaceCheckDigest(value).slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Check fingerprint input contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Check fingerprint input is not JSON-compatible.");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
