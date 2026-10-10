/** Bounded, read-only observations of existing History evidence. */
export interface HistoryReviewLimits {
  maxFileBytes: number;
  maxDiffBytes: number;
  maxDiffLines: number;
  maxLineCharacters: number;
  maxDiffCells: number;
}

/**
 * Reads page through larger files, so the file bound is a page size. The diff
 * table costs four bytes per cell; the cell bound keeps one diff near 64 MB
 * of memory, after the common prefix and suffix are trimmed away.
 */
export const HISTORY_REVIEW_LIMITS: Readonly<HistoryReviewLimits> = Object.freeze({
  maxFileBytes: 4 * 1024 * 1024,
  maxDiffBytes: 4 * 1024 * 1024,
  maxDiffLines: 200_000,
  maxLineCharacters: 64 * 1024,
  maxDiffCells: 16_000_000,
});

export type HistoryFileStatus = "text" | "binary" | "too_large" | "absent" | "uncaptured" | "unavailable";
export type HistoryFileReason =
  | "file_size_limit" | "invalid_utf8" | "binary_content"
  | "outside_capture" | "skipped_too_large" | "skipped_unreadable" | "skipped_symbolic_link" | "skipped_excluded"
  | "not_regular_file" | "missing_blob" | "corrupt_blob" | "unreadable" | "changed_during_read" | "invalid_checkpoint";

export interface HistoryFileObservation {
  source: "checkpoint" | "current";
  checkpointId?: string;
  capturedAt?: string;
  /** A current-file observation is not a checkpoint or a transactional snapshot. */
  observedAt?: string;
  status: HistoryFileStatus;
  reason?: HistoryFileReason;
  sizeBytes?: number;
  hashSha256?: string;
  /** False means this is only the checkpoint's recorded digest (e.g. an oversized file). */
  hashVerified?: boolean;
  /** Complete UTF-8 content, present only for status=text; never a truncated prefix. */
  text?: string;
}

export interface HistoryFileRead {
  schemaVersion: 1;
  path: string;
  observation: HistoryFileObservation;
  limits: HistoryReviewLimits;
  /** Explicit byte-range read; observation.text retains its complete-file meaning. */
  range?: HistoryFileRange;
}

export interface HistoryFileReadOptions {
  path: string;
  checkpointId: string;
  offsetBytes?: number;
  lengthBytes?: number;
  expectedSha256?: string;
  signal?: AbortSignal;
}

export interface HistoryFileRange {
  status: "text" | "binary" | "unavailable";
  offsetBytes: number;
  lengthBytes: number;
  totalBytes: number;
  nextOffsetBytes: number | null;
  complete: boolean;
  hashSha256: string;
  hashVerified: boolean;
  text?: string;
  reason?: HistoryFileReason;
}

export interface HistoryPageOptions { cursor?: string; limit?: number; }
export interface HistoryPageInfo {
  total: number;
  nextCursor: string | null;
  sourceVersion: string;
}

export interface HistoryTextDiff {
  status: "available" | "not_needed" | "unsupported" | "limited";
  text?: string;
  reason?: "content_unavailable" | "line_limit" | "long_line" | "computation_limit" | "output_limit";
  /** True when limits prevented a complete diff; any returned text is a prefix only. */
  truncated: boolean;
}

export interface HistoryFileComparison {
  schemaVersion: 1;
  path: string;
  before: HistoryFileObservation;
  after: HistoryFileObservation;
  change: "unchanged" | "added" | "deleted" | "modified" | "unknown";
  diff: HistoryTextDiff;
  limits: HistoryReviewLimits;
}
