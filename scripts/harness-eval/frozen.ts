import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

export const frozenModels = ["openrouter/z-ai/glm-5.3", "openrouter/openai/gpt-6-luna"] as const;
export const frozenCases = ["research", "reconcile", "repair"] as const;
export const frozenContexts = { normal: [], stressed: ["--compact-at", "18000", "--keep-recent", "2000"] } as const;

/** Omission really means native Pi defaults, rather than the old hidden 40k trigger. */
export function autonomousHostArguments(args: string[]): string[] {
  const result: string[] = [];
  for (const flag of ["--compact-at", "--keep-recent", "--catalog-source"]) {
    const at = args.indexOf(flag);
    if (at >= 0) {
      const value = args[at + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      result.push(flag, value);
    }
  }
  if (result.includes("--keep-recent") && !result.includes("--compact-at")) throw new Error("--keep-recent requires --compact-at");
  return result;
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** These are repetition proxies, never proof that another read was unnecessary. */
export function summarizeAutonomousTrace(entries: any[], provider: any[], folder: string) {
  const results = entries.map(entry => entry.message).filter(message => message?.role === "toolResult");
  const calls = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall").map((call: any) => ({ ...call, failed: results.find(result => result.toolCallId === call.id)?.isError ?? true })) : []);
  calls.push(...results.flatMap(result => (result.nestedCalls?.calls ?? []).map((call: any) => ({ ...call, arguments: call.arguments ?? {}, failed: call.status !== "ok" }))));
  const observations = entries.filter(entry => entry.type === "custom" && entry.customType === "work-fold-progress.v1").map(entry => entry.data);
  const seenReads = new Set<string>(); const seenHelpers = new Set<string>();
  let repeatedUnchangedReads = 0; let readsWithFingerprints = 0; let repeatedHelperArguments = 0;
  for (const call of calls.filter(call => !call.failed)) {
    const args = { ...call.arguments };
    if (typeof args.path === "string" && isAbsolute(args.path)) args.path = relative(folder, args.path);
    if (call.name === "read") {
      const record = observations.find(item => item.kind === "observation" && item.tool === "read" && item.id === `ev-${sha256(`${item.taskId}\0${call.id}`).slice(0, 20)}`);
      if (record?.sourceBinding === "bracketed" && record.sources?.length) {
        readsWithFingerprints++;
        const key = stableJson({ args, sources: record.sources });
        if (seenReads.has(key)) repeatedUnchangedReads++;
        seenReads.add(key);
      }
    }
    if (call.name === "helper") {
      const key = stableJson(args);
      if (seenHelpers.has(key)) repeatedHelperArguments++;
      seenHelpers.add(key);
    }
  }
  return {
    repeatedUnchangedReads, readsWithFingerprints, repeatedHelperArguments,
    providerInputTokens: provider.reduce((n, call) => n + (call.usage?.prompt_tokens ?? 0), 0),
    providerOutputTokens: provider.reduce((n, call) => n + (call.usage?.completion_tokens ?? 0), 0),
    providerCachedTokens: provider.reduce((n, call) => n + (call.usage?.prompt_tokens_details?.cached_tokens ?? 0), 0),
    maxProviderInputTokens: Math.max(0, ...provider.map(call => call.usage?.prompt_tokens ?? 0)),
    providerFailures: provider.filter(call => call.error || call.streamError || call.status >= 400).length,
    providerCallsWithoutUsage: provider.filter(call => !call.usage).length,
  };
}

export interface FrozenTrial {
  id: string; model: string; scenario: string; context: keyof typeof frozenContexts; repetition: number;
}
export function frozenTrials(repetitions: number): FrozenTrial[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 2) throw new Error("Repeated evaluation requires at least two repetitions");
  const trials: FrozenTrial[] = [];
  // Interleave context/model/case rather than comparing one long block with another.
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const scenario of frozenCases) for (const context of Object.keys(frozenContexts) as Array<keyof typeof frozenContexts>) {
      for (const model of repetition % 2 ? frozenModels : [...frozenModels].reverse()) {
        trials.push({ id: `${scenario}-${context}-${model.includes("glm") ? "glm" : "luna"}-${repetition}`, model, scenario, context, repetition });
      }
    }
  }
  return trials;
}

export function aggregateFrozenTrials(rows: Array<FrozenTrial & { outcome: string; durationSeconds?: number; providerCost?: number; toolErrors?: number; compactions?: number; repeatedUnchangedReads?: number; settledDoneWithInvalidOutput?: boolean }>) {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) { const key = `${row.model}|${row.scenario}|${row.context}`; groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups].map(([key, trials]) => {
    const duration = trials.map(row => row.durationSeconds ?? 0).sort((a, b) => a - b);
    return { key, passed: trials.filter(row => row.outcome === "passed").length, total: trials.length,
      medianSeconds: duration.length % 2 ? duration[Math.floor(duration.length / 2)] : (duration[duration.length / 2 - 1]! + duration[duration.length / 2]!) / 2,
      maxSeconds: Math.max(...duration), providerCost: trials.reduce((n, row) => n + (row.providerCost ?? 0), 0),
      toolErrors: trials.reduce((n, row) => n + (row.toolErrors ?? 0), 0), compactions: trials.reduce((n, row) => n + (row.compactions ?? 0), 0),
      repeatedUnchangedReads: trials.reduce((n, row) => n + (row.repeatedUnchangedReads ?? 0), 0),
      settledDoneWithInvalidOutput: trials.filter(row => row.settledDoneWithInvalidOutput).length };
  });
}
