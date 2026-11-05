import { useEffect, useState } from "react";
import type { HistoryFileComparison as Comparison, HistoryFileObservation, HistoryFileReason } from "../../../../src/shared/history-review";
import { api, errorText } from "../../lib/api";
import { queueHistoryRequest } from "../../lib/history-queue";
import { formatBytes, formatDateTime } from "../../lib/format";

const reasons: Record<HistoryFileReason, string> = {
  file_size_limit: "Too large for text comparison.", invalid_utf8: "Not valid UTF-8 text.", binary_content: "Binary content; text comparison is unavailable.",
  outside_capture: "This path was outside the restore point's coverage.", skipped_too_large: "History did not capture this oversized file.",
  skipped_unreadable: "History could not read this file during capture.", skipped_symbolic_link: "History did not follow this symbolic link.",
  skipped_excluded: "This path was excluded from capture.", not_regular_file: "This path is not an ordinary file.",
  missing_blob: "Saved content is no longer available.", corrupt_blob: "Saved content failed its integrity check.", unreadable: "This content could not be read.",
  changed_during_read: "The file changed while it was being read. Compare again for a fresh observation.", invalid_checkpoint: "This restore point could not be read.",
};
const changes: Record<Comparison["change"], string> = { unchanged: "No Changes", added: "File Added", deleted: "File Deleted", modified: "File Changed", unknown: "Comparison Incomplete" };
const diffReasons = { content_unavailable: "Text is unavailable on one or both sides.", line_limit: "Too many lines for text comparison.", long_line: "A line exceeds the text comparison limit.", computation_limit: "These versions exceed the comparison work limit.", output_limit: "Only the beginning of the difference fits the display limit." };

function Observation({ title, value }: { title: string; value: HistoryFileObservation }) {
  return <div className="history-comparison-observation">
    <strong>{title}</strong>
    <span>{value.status === "absent" ? "Not present" : value.status === "text" ? "Text available" : value.status === "uncaptured" ? "Not captured" : value.status === "unavailable" ? "Unavailable" : value.status === "too_large" ? "Too large" : "Binary content"}{value.sizeBytes !== undefined ? ` · ${formatBytes(value.sizeBytes)}` : ""}</span>
    {value.reason ? <span>{reasons[value.reason]}</span> : null}
    {value.observedAt ? <small>Read {formatDateTime(value.observedAt)}; the file can change afterward.</small> : null}
    {value.capturedAt ? <small>Saved {formatDateTime(value.capturedAt)}</small> : null}
    {value.hashSha256 ? <small className="history-comparison-hash">SHA-256 {value.hashSha256}{value.hashVerified ? " (checked against the bytes read)" : " (as recorded)"}</small> : null}
  </div>;
}

/** Only an unusual side (not plain text, or with a reason) needs explaining up front. */
function unusual(value: HistoryFileObservation): boolean {
  return Boolean(value.reason) || (value.status !== "text" && value.status !== "absent");
}

type DiffRow = { kind: "add" | "remove" | "same" | "gap" | "note"; text: string; line?: number };

/**
 * The host's unified diff as rows a person can read: file headers dropped,
 * hunk markers turned into "Line N" breaks, and each line marked added,
 * removed, or unchanged. Text stays literal; nothing is parsed as markup.
 */
function diffRows(text: string): { rows: DiffRow[]; added: number; removed: number } {
  const rows: DiffRow[] = [];
  let added = 0; let removed = 0; let newLine = 0; let inHunk = false;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { inHunk = true; newLine = Number(hunk[1]); rows.push({ kind: "gap", text: `Line ${newLine}` }); continue; }
    if (line.startsWith("\\")) { rows.push({ kind: "note", text: "No newline at the end of the file" }); continue; }
    const sign = line[0]; const body = line.slice(1);
    if (sign === "+") { added++; rows.push({ kind: "add", text: body, line: newLine || undefined }); if (newLine) newLine++; }
    else if (sign === "-") { removed++; rows.push({ kind: "remove", text: body }); }
    else { rows.push({ kind: "same", text: sign === " " ? body : line, line: newLine || undefined }); if (newLine) newLine++; }
  }
  return { rows, added, removed };
}

function DiffView({ text }: { text: string }) {
  const { rows } = diffRows(text);
  return <div className="history-diff" tabIndex={0} role="group" aria-label="Line changes">
    {rows.map((row, index) => row.kind === "gap"
      ? <div className="history-diff-gap" key={index}>{row.text}</div>
      : row.kind === "note"
        ? <div className="history-diff-note" key={index}>{row.text}</div>
        : <div className={`history-diff-row ${row.kind}`} key={index}>
          <span className="history-diff-sign" aria-label={row.kind === "add" ? "Added" : row.kind === "remove" ? "Removed" : undefined}>{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span>
          <span className="history-diff-text">{row.text || " "}</span>
        </div>)}
  </div>;
}

function lineCount(count: number, word: string): string {
  return `${count} ${count === 1 ? "line" : "lines"} ${word}`;
}

/** Read-only, explicitly selected evidence. Changing the target invalidates late responses. */
export function HistoryFileComparison({ workFolderId, path, fromCheckpointId, toCheckpointId, refreshRequest = 0, fixtureComparison }: {
  workFolderId: string; path: string; fromCheckpointId: string; toCheckpointId?: string; refreshRequest?: number;
  /** The preview's comparison, shown instead of asking the host. */
  fixtureComparison?: Comparison;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setResult(null); setError("");
    if (fixtureComparison) { setResult(fixtureComparison); return; }
    const query = new URLSearchParams({ path, fromCheckpointId, ...(toCheckpointId ? { toCheckpointId } : {}) });
    // A comparison already sent is never aborted: the host keeps reading, and
    // holding its History lock, after the app stops listening. It finishes in
    // its turn and an obsolete result is dropped; one still waiting is skipped.
    void queueHistoryRequest(workFolderId, async () => cancelled ? null : api<{ comparison: Comparison }>(`/api/work-folders/${workFolderId}/history/diff?${query}`)).then((body) => {
      if (!body || cancelled) return;
      const { comparison } = body;
      if (comparison.path !== path || comparison.before.checkpointId !== fromCheckpointId ||
        (toCheckpointId ? comparison.after.checkpointId !== toCheckpointId : comparison.after.source !== "current")) {
        throw new Error("The comparison does not match the selected file and versions.");
      }
      setResult(comparison);
    }).catch((failure) => { if (!cancelled) setError(errorText(failure)); });
    return () => { cancelled = true; };
  }, [workFolderId, path, fromCheckpointId, toCheckpointId, refreshRequest, revision, fixtureComparison]);
  const counts = result?.diff.text ? diffRows(result.diff.text) : null;
  const summary = result ? [
    result.before.capturedAt ? `Since ${formatDateTime(result.before.capturedAt)}` : null,
    counts && (counts.added || counts.removed) ? [counts.added ? lineCount(counts.added, "added") : null, counts.removed ? lineCount(counts.removed, "removed") : null].filter(Boolean).join(", ") : null,
  ].filter(Boolean).join(" · ") : "";
  return <section className="history-file-comparison" aria-label={`Comparison for ${path}`}>
    <div className="history-comparison-heading">
      <div className="history-comparison-title">
        {error ? <strong>Comparison</strong> : !result ? <strong>Comparing…</strong> : <strong role="status">{changes[result.change]}</strong>}
        {summary ? <span>{summary}</span> : null}
      </div>
      <button type="button" className="ui-control" onClick={() => setRevision((value) => value + 1)}>Compare Again</button>
    </div>
    {error ? <p role="alert">{error}</p> : !result ? <p role="status">Reading both versions…</p> : <>
      {unusual(result.before) || unusual(result.after) ? <div className="history-comparison-observations"><Observation title="Saved Version" value={result.before} /><Observation title={toCheckpointId ? "Other Saved Version" : "Current File"} value={result.after} /></div> : null}
      {result.diff.reason ? <p>{diffReasons[result.diff.reason]}</p> : null}
      {result.diff.truncated ? <p role="status">The text difference is incomplete. Coverage and content limits apply.</p> : null}
      {result.diff.text ? <DiffView text={result.diff.text} /> : null}
      <details><summary>Technical Details</summary>
        <p className="history-comparison-path">{path}</p>
        <div className="history-comparison-observations"><Observation title="Saved Version" value={result.before} /><Observation title={toCheckpointId ? "Other Saved Version" : "Current File"} value={result.after} /></div>
        <p>Text reads: {formatBytes(result.limits.maxFileBytes)} per file. Differences: {result.limits.maxDiffLines.toLocaleString()} lines, {formatBytes(result.limits.maxDiffBytes)}.</p>
        {result.before.text !== undefined ? <details><summary>Saved Text</summary><pre tabIndex={0}>{result.before.text}</pre></details> : null}
        {result.after.text !== undefined ? <details><summary>{toCheckpointId ? "Other Saved Text" : "Current Text"}</summary><pre tabIndex={0}>{result.after.text}</pre></details> : null}
        {result.diff.text ? <details><summary>Raw Difference</summary><pre tabIndex={0}>{result.diff.text}</pre></details> : null}
      </details>
    </>}
  </section>;
}
