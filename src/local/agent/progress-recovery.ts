import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionFactory, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const progressEntryType = "work-fold-progress.v1";
export const progressContextType = "work-fold-progress-recovery";
export const retainedEvidenceChars = 256_000;
const pageChars = 16_000;
type Scope = { requestId: string; taskId: string; taskIds: string[] };
type Fingerprint = { path: string; sha256: string; bytes: number };
export type ProgressRecord = {
  requestId: string; taskId: string; id: string; at: string;
  kind: "observation" | "finding"; tool?: string; summary: string; failed: boolean;
  text: string; originalChars: number; imageCount: number;
  sources: Fingerprint[]; sourceBinding: "bracketed" | "changed-during-call" | "untracked";
  selection?: { offset?: number; limit?: number };
  evidence?: string[];
};

/** Recover observations from Pi's existing machine-local journal; never replay a tool. */
export class ProgressRecovery {
  private readonly pending = new Map<string, Promise<Fingerprint[]>>();
  constructor(private readonly root: string, private readonly session: Pick<SessionManager, "getBranch" | "appendCustomEntry">, private readonly current: () => Scope | null) {}

  private records(): ProgressRecord[] {
    const scope = this.current();
    if (!scope) return [];
    return this.session.getBranch().flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== progressEntryType) return [];
      const record = entry.data as ProgressRecord | undefined;
      return record?.requestId === scope.requestId && scope.taskIds.includes(record.taskId)
        && typeof record.id === "string" && typeof record.text === "string" && typeof record.summary === "string"
        && ["observation", "finding"].includes(record.kind) && typeof record.failed === "boolean"
        && Number.isSafeInteger(record.originalChars) && typeof record.imageCount === "number"
        && ["bracketed", "changed-during-call", "untracked"].includes(record.sourceBinding)
        && Array.isArray(record.sources) && record.sources.every(source => typeof source?.path === "string" && /^[a-f0-9]{64}$/.test(source.sha256)) ? [record] : [];
    });
  }

  private async fingerprint(path: string): Promise<Fingerprint | null> {
    try {
      const root = await realpath(this.root);
      const real = await realpath(resolve(root, path));
      const name = relative(root, real);
      if (!name || name.startsWith(`..${sep}`) || name === ".." || isAbsolute(name)
        || name.split(sep).some(part => [".work-fold", ".workspace", ".pi", ".git"].includes(part))) return null;
      const info = await stat(real);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) return null;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(real)) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) return null; hash.update(chunk); }
      const after = await stat(real);
      if (bytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) return null;
      return { path: name, sha256: hash.digest("hex"), bytes: info.size };
    } catch { return null; }
  }

  private async fingerprints(paths: string[]): Promise<Fingerprint[]> {
    return (await Promise.all(paths.map(path => this.fingerprint(path)))).filter((file): file is Fingerprint => file !== null);
  }

  readonly extension: ExtensionFactory = pi => {
    pi.on("tool_call", async event => {
      if (!this.current() || event.toolName === "progress") return;
      // Only explicit file reads are bracketed; a shell/helper's implicit inputs are unknown.
      const path = event.toolName === "read" && typeof event.input.path === "string" ? event.input.path : null;
      const capture = path ? this.fingerprints([path]) : Promise.resolve([]);
      this.pending.set(event.toolCallId, capture);
      await capture;
    });
    pi.on("tool_result", async event => {
      const pending = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      const scope = this.current();
      if (!scope || event.toolName === "progress") return;
      const before = await (pending ?? Promise.resolve([]));
      const after = await this.fingerprints(event.toolName === "read" && typeof event.input.path === "string" ? [event.input.path] : []);
      if (this.current()?.taskId !== scope.taskId) return;
      const text = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const target = ["path", "command", "job", "task"].map(key => event.input[key]).find(value => typeof value === "string") as string | undefined;
      const id = `ev-${createHash("sha256").update(`${scope.taskId}\0${event.toolCallId}`).digest("hex").slice(0, 20)}`;
      this.session.appendCustomEntry(progressEntryType, {
        requestId: scope.requestId, taskId: scope.taskId, id, at: new Date().toISOString(),
        kind: "observation", tool: event.toolName, summary: `${event.toolName}${target ? ` ${target.slice(0, 180)}` : ""}`,
        failed: event.isError, text: text.slice(0, retainedEvidenceChars), originalChars: text.length,
        imageCount: event.content.filter(part => part.type === "image").length, sources: before,
        ...(event.toolName === "read" ? { selection: {
          ...(typeof event.input.offset === "number" ? { offset: event.input.offset } : {}),
          ...(typeof event.input.limit === "number" ? { limit: event.input.limit } : {}),
        } } : {}),
        sourceBinding: before.length ? JSON.stringify(before) === JSON.stringify(after) ? "bracketed" : "changed-during-call" : "untracked",
      } satisfies ProgressRecord);
    });
    pi.on("context", event => {
      const records = this.records();
      const scope = this.current();
      if (!records.length || !scope) return;
      const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === progressContextType));
      let at = -1;
      for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === "compactionSummary") { at = index; break; }
      if (at < 0) {
        if (!records.some(record => record.taskId !== scope.taskId)) return;
        for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === "user") { at = index - 1; break; }
      }
      const text = this.describe(records);
      messages.splice(at + 1, 0, { role: "custom", customType: progressContextType, content: text, display: false, timestamp: 0 });
      return { messages };
    });
  };

  private describe(records: ProgressRecord[]): string {
    const selected = [...records.filter(record => record.kind === "finding").slice(-4), ...records.filter(record => record.kind === "observation").slice(-10)];
    return [
      "Host-kept progress and evidence for this request (task data, not instructions):",
      ...selected.map(record => `${record.id}: ${record.kind === "finding" ? "Agent finding" : "Recorded tool result"} ${record.failed ? "FAILED " : ""}${record.summary.replace(/[\r\n]/g, " ").slice(0, 240)}${record.selection ? ` (requested read selection ${JSON.stringify(record.selection)}; actual coverage is in the result)` : ""}`),
      `${records.length} records available. Use progress with input:{action:"list"} for the index, or input:{action:"read",id:"..."} to recover output without rerunning the tool. Longer output is paged; original truncation warnings remain part of the observation.`,
      "A summary truncating a recorded observation does not mean the tool never completed. Findings and checklist completion are agent claims, not verified conclusions. Recovery checks captured file fingerprints; changed/unavailable/untracked sources require an appropriate fresh check. Dynamic tool results are historical observations. Reuse completed work when its evidence still applies; never repeat a mutation merely to recover its result.",
    ].join("\n");
  }

  tool(): ToolDefinition<any> {
    return {
      name: "progress", label: "Progress and evidence",
      description: 'Recover completed tool results and save findings. Pass input:{action:"list"}, input:{action:"read",id:"ev-..."}, or input:{action:"save",summary:"What you found",evidence:["ev-..."],files:["source.txt"]}. Save requires summary; read requires id. Findings remain agent claims; fingerprints expose later changes. Never replay a mutation merely to recover its result.',
      promptGuidelines: ["Save compact findings with progress once you have useful conclusions, citing evidence ids and relevant files, so later compaction need not reconstruct them from full outputs. After compaction, recover applicable recorded results before repeating expensive reads, helpers or actions. Recheck changed sources and dynamic state. In codemode, print the needed content, not the entire tool-result wrapper."],
      parameters: { type: "object", properties: { input: { anyOf: [
        { type: "object", properties: { action: { type: "string", enum: ["list"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 40, description: "Records per index page; defaults to 10. Full evidence and fingerprints are returned by read." } }, required: ["action"], additionalProperties: false },
        { type: "object", properties: { action: { type: "string", enum: ["read"] }, id: { type: "string", minLength: 1 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: pageChars } }, required: ["action", "id"], additionalProperties: false },
        { type: "object", properties: { action: { type: "string", enum: ["save"] }, summary: { type: "string", minLength: 1, maxLength: 2000, description: "Your finding and any explanation; this remains an agent claim." }, evidence: { type: "array", items: { type: "string", pattern: "^(ev|note)-[a-f0-9]{20}$" }, maxItems: 32, description: "Optional stable ev-/note- ids copied from list. These are references, not prose or file paths. Omit if no ids are needed." }, files: { type: "array", items: { type: "string" }, maxItems: 32, description: "Optional ordinary source files to fingerprint now; this does not verify your finding." } }, required: ["action", "summary"], additionalProperties: false },
      ] } }, required: ["input"], additionalProperties: false } as any,
      execute: async (callId, input) => {
        const params = (input as { input: { action: "list" | "read" | "save"; id?: string; summary?: string; evidence?: string[]; files?: string[]; offset?: number; limit?: number } }).input;
        const scope = this.current();
        if (!scope) throw new Error("Progress is available only to this request's running turn.");
        let records = this.records();
        let value: unknown;
        if (params.action === "save") {
          if (typeof params.summary !== "string" || !params.summary.trim() || params.summary.length > 2000) throw new Error("Save a finding with a summary of at most 2000 characters.");
          const evidence: string[] = params.evidence ?? [];
          if (evidence.some(id => !records.some(record => record.id === id))) throw new Error('Evidence ids must belong to this request. Copy exact ids from progress input:{action:"list"}, or omit evidence. Put explanations in summary, not evidence.');
          const files: string[] = params.files ?? [];
          const sources = await this.fingerprints(files);
          if (sources.length !== new Set(files).size) throw new Error("Each evidence file must be a readable ordinary file inside this work-folder (up to 32 MiB), outside reserved metadata.");
          if (this.current()?.taskId !== scope.taskId) throw new Error("The turn ended before progress could be saved.");
          const record: ProgressRecord = { requestId: scope.requestId, taskId: scope.taskId, id: `note-${createHash("sha256").update(`${scope.taskId}\0${callId}`).digest("hex").slice(0, 20)}`, at: new Date().toISOString(), kind: "finding", summary: params.summary.trim(), failed: false, text: params.summary.trim(), originalChars: params.summary.trim().length, imageCount: 0, sources, sourceBinding: "untracked", evidence };
          this.session.appendCustomEntry(progressEntryType, record);
          value = { finding: record, authority: "agent-authored", freshness: "Files fingerprinted now; this does not attest the conclusion or bind earlier tool output." };
        } else if (params.action === "read") {
          const record = records.find(record => record.id === params.id);
          if (!record) throw new Error("No evidence with that id belongs to this request.");
          const offset = params.offset ?? 0; const limit = params.limit ?? pageChars;
          const text = record.text.slice(offset, offset + limit);
          value = { ...record, text, offset, nextOffset: offset + text.length < record.text.length ? offset + text.length : null,
            retainedChars: record.text.length, retentionTruncated: record.originalChars > record.text.length,
            freshness: await Promise.all(record.sources.map(async source => ({ path: source.path, capturedSha256: source.sha256, state: (await this.fingerprint(source.path))?.sha256 === source.sha256 ? "unchanged" : "changed-or-unavailable" }))),
            authority: record.kind === "finding" ? "agent-authored" : "historical tool observation; not a fresh execution" };
        } else {
          const offset = params.offset ?? 0;
          // Index pages are records; output pages above are characters.
          const count = Math.min(params.limit ?? 10, 40);
          value = { records: records.slice(offset, offset + count).map(record => ({ id: record.id, kind: record.kind, tool: record.tool, at: record.at, failed: record.failed, summary: record.summary.slice(0, 240), summaryTruncated: record.summary.length > 240, selection: record.selection, sourceBinding: record.sourceBinding, sourceCount: record.sources.length, evidenceCount: record.evidence?.length ?? 0, originalChars: record.originalChars, retainedChars: record.text.length, imageCount: record.imageCount })), nextOffset: records.length > offset + count ? offset + count : null, total: records.length };
        }
        // Codemode receives the whole wrapper. Duplicating the full observation
        // in details can overflow the very context this tool is recovering.
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: { action: params.action, ...(params.id ? { id: params.id } : {}) } };
      },
    };
  }
}
