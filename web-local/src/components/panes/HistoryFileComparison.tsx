import { useEffect, useState } from "react";
import type { HistoryFileComparison as Comparison, HistoryFileObservation, HistoryFileReason } from "../../../../src/shared/history-review";
import { api, errorText } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";

const reasons: Record<HistoryFileReason, string> = {
  file_size_limit: "Too large for text comparison.", invalid_utf8: "Not valid UTF-8 text.", binary_content: "Binary content; text comparison is unavailable.",
  outside_capture: "This path was outside the restore point's coverage.", skipped_too_large: "History did not capture this oversized file.",
  skipped_unreadable: "History could not read this file during capture.", skipped_symbolic_link: "History did not follow this symbolic link.",
  skipped_excluded: "This path was excluded from capture.", not_regular_file: "This path is not an ordinary file.",
  missing_blob: "Saved content is no longer available.", corrupt_blob: "Saved content failed its integrity check.", unreadable: "This content could not be read.",
  changed_during_read: "The file changed while it was being read. Compare again for a fresh observation.", invalid_checkpoint: "This restore point could not be read.",
};
const changes: Record<Comparison["change"], string> = { unchanged: "No byte changes", added: "File added", deleted: "File deleted", modified: "File changed", unknown: "Comparison incomplete" };
const diffReasons = { content_unavailable: "Text is unavailable on one or both sides.", line_limit: "Too many lines for text comparison.", long_line: "A line exceeds the text comparison limit.", computation_limit: "These versions exceed the comparison work limit.", output_limit: "Only the beginning of the difference fits the display limit." };

function Observation({ title, value }: { title: string; value: HistoryFileObservation }) {
  return <div className="history-comparison-observation">
    <strong>{title}</strong>
    <span>{value.status === "absent" ? "Not present" : value.status === "text" ? "Text available" : value.status === "uncaptured" ? "Not captured" : value.status === "unavailable" ? "Unavailable" : value.status === "too_large" ? "Too large" : "Binary content"}{value.sizeBytes !== undefined ? ` · ${formatBytes(value.sizeBytes)}` : ""}</span>
    {value.reason ? <span>{reasons[value.reason]}</span> : null}
    {value.observedAt ? <small>Observed {formatDateTime(value.observedAt)}; the file can change afterward.</small> : null}
    {value.capturedAt ? <small>Captured {formatDateTime(value.capturedAt)}</small> : null}
    {value.hashSha256 ? <details><summary>Content identity</summary><code>SHA-256: {value.hashSha256}</code><small>{value.hashVerified ? "Verified against bytes read." : "Recorded identity; bytes were not verified by this read."}</small></details> : null}
  </div>;
}

/** Read-only, explicitly selected evidence. Changing the target invalidates late responses. */
export function HistoryFileComparison({ spaceId, path, fromCheckpointId, toCheckpointId, refreshRequest = 0 }: {
  spaceId: string; path: string; fromCheckpointId: string; toCheckpointId?: string; refreshRequest?: number;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setResult(null); setError("");
    const query = new URLSearchParams({ path, fromCheckpointId, ...(toCheckpointId ? { toCheckpointId } : {}) });
    void api<{ comparison: Comparison }>(`/api/spaces/${spaceId}/history/diff?${query}`, { signal: controller.signal }).then(({ comparison }) => {
      if (cancelled) return;
      if (comparison.path !== path || comparison.before.checkpointId !== fromCheckpointId ||
        (toCheckpointId ? comparison.after.checkpointId !== toCheckpointId : comparison.after.source !== "current")) {
        throw new Error("The comparison does not match the selected file and versions.");
      }
      setResult(comparison);
    }).catch((failure) => { if (!cancelled) setError(errorText(failure)); });
    return () => { cancelled = true; controller.abort(); };
  }, [spaceId, path, fromCheckpointId, toCheckpointId, refreshRequest, revision]);
  return <section className="history-file-comparison" aria-label={`Comparison for ${path}`}>
    <div className="history-comparison-heading"><strong>{path}</strong><button type="button" className="ui-control" onClick={() => setRevision((value) => value + 1)}>Compare again</button></div>
    <p>Saved content compared with {toCheckpointId ? "another saved version" : "the current file"}. This view does not change files. Changes describe this interval, regardless of who made them.</p>
    {error ? <p role="alert">{error}</p> : !result ? <p role="status">Reading comparison…</p> : <>
      <strong role="status">{changes[result.change]}</strong>
      <div className="history-comparison-observations"><Observation title="Saved version" value={result.before} /><Observation title={toCheckpointId ? "Other saved version" : "Current file"} value={result.after} /></div>
      {result.diff.reason ? <p>{diffReasons[result.diff.reason]}</p> : null}
      {result.diff.truncated ? <p role="status">The text difference is incomplete. Coverage and content limits apply.</p> : null}
      {result.diff.text ? <pre className="history-comparison-diff" tabIndex={0}>{result.diff.text}</pre> : null}
      <details><summary>Available text and limits</summary>
        <p>Text reads: {formatBytes(result.limits.maxFileBytes)} per file. Differences: {result.limits.maxDiffLines.toLocaleString()} lines, {formatBytes(result.limits.maxDiffBytes)}.</p>
        {result.before.text !== undefined ? <details><summary>Saved text</summary><pre tabIndex={0}>{result.before.text}</pre></details> : null}
        {result.after.text !== undefined ? <details><summary>{toCheckpointId ? "Other saved text" : "Current text"}</summary><pre tabIndex={0}>{result.after.text}</pre></details> : null}
      </details>
    </>}
  </section>;
}
