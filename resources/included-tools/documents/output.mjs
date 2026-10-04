import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function utf8Prefix(text, budget) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, Math.max(0, budget));
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Budget the complete model-facing text, including envelope overhead. */
export function documentResultText(result, budget) {
  const { images, value, valueTruncated, ...envelope } = result;
  const text = JSON.stringify({ ...envelope, result: value, resultTruncated: valueTruncated });
  if (Buffer.byteLength(text) <= budget) return text;
  return JSON.stringify({
    outcome: result.outcome, script: result.script,
    envelopeTruncated: true, resultTruncated: true,
    result: JSON.stringify({ overflow: true, artifact: { path: result.artifacts.manifest, mediaType: "application/json" }, field: "value" }),
    artifacts: result.artifacts,
    ...(result.failure ? { failure: { message: utf8Prefix(result.failure.message, 4096), effects: result.failure.effects } } : {}),
    continuation: "Read the retained run manifest for the complete result envelope and observation/log paths. Selected images remain in this tool result. Do not rerun the producing script to retrieve its output.",
  });
}

/** These files belong to this run, persist after settlement, and are never replay instructions. */
export function createOutput({ root, limits, post }) {
  let serial = 0;
  const artifact = async (name, bytes, mediaType) => {
    const path = join(root, `${++serial}-${name}`);
    await writeFile(path, bytes, { flag: "wx" });
    return { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes), mediaType };
  };
  const observe = async (observation) => {
    await appendFile(join(root, "observations.ndjson"), JSON.stringify(observation) + "\n");
    post({ observation });
  };
  const result = async (value, name = "result") => {
    const format = typeof value === "string" ? "text" : "json";
    const serialized = value === undefined ? "" : format === "text" ? value : JSON.stringify(value);
    const bytes = Buffer.from(serialized ?? "");
    if (bytes.length <= limits.textBytes) return { value: bytes.toString("utf8"), valueTruncated: false, valueFormat: format };
    const file = await artifact(`${name}.${format === "json" ? "json" : "txt"}`, bytes, format === "json" ? "application/json" : "text/plain");
    // Never truncate serialized JSON in the middle of a value. The envelope is
    // parseable, and an ordinary file carries the complete original result.
    return { value: JSON.stringify({ overflow: true, artifact: file, originalFormat: format }), valueFormat: "json", valueTruncated: true, resultArtifact: file };
  };
  return { artifact, observe, result };
}
