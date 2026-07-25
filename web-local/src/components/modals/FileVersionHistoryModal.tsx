import { useCallback, useEffect, useRef, useState } from "react";
import { History, Loader2, Undo2, X } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { formatBytes, formatDateTime, formatTimeAgo, splitConfirmMessage } from "../../lib/format";
import { useModalDialog } from "../../hooks/useModalDialog";
import { requestConfirm, showToast } from "../../ui/feedback";
import type { FileVersionEntry, FileVersionRestoreOutcome, WorkspaceSummary } from "../../types";

function fileVersionSourceLabel(source: FileVersionEntry["source"]): string {
  return source === "edit" ? "Saved during an edit" : "From a restore point";
}

function FileVersionHistoryModal({
  workspace,
  filePath,
  fileName,
  onClose,
  onRestored,
}: {
  workspace: WorkspaceSummary;
  filePath: string;
  fileName: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<FileVersionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringHash, setRestoringHash] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoRestorePointId, setUndoRestorePointId] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const busy = restoringHash !== null || undoing;
  const dialogRef = useModalDialog({ onClose, blocked: busy, initialFocusRef: closeButtonRef });

  const loadVersions = useCallback(async (): Promise<void> => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setError(null);
    try {
      const body = await api<{ path: string; versions: FileVersionEntry[] }>(
        `/api/workspaces/${workspace.id}/history/file-versions?path=${encodeURIComponent(filePath)}`,
      );
      if (loadRequestRef.current !== requestId) return;
      setVersions(body.versions);
    } catch (loadError) {
      if (loadRequestRef.current !== requestId) return;
      setError(errorText(loadError));
      setVersions([]);
    }
  }, [workspace.id, filePath]);

  useEffect(() => {
    setVersions(null);
    setNotice(null);
    setUndoRestorePointId(null);
    void loadVersions();
  }, [loadVersions]);

  async function restoreVersion(version: FileVersionEntry): Promise<void> {
    const restoreConfirm = splitConfirmMessage(
      `Restore "${fileName}" to the version from ${formatDateTime(version.capturedAt)}? Workspace saves a restore point first, so you can undo this.`,
    );
    const confirmed = await requestConfirm({
      ...restoreConfirm,
      confirmLabel: "Restore",
      tone: "danger",
    });
    if (!confirmed) return;
    setRestoringHash(version.hashSha256);
    setError(null);
    setNotice(null);
    try {
      const body = await api<{ result: FileVersionRestoreOutcome }>(
        `/api/workspaces/${workspace.id}/history/file-versions`,
        { method: "POST", body: { path: filePath, hashSha256: version.hashSha256 } },
      );
      setUndoRestorePointId(body.result.safetyCheckpointId);
      setNotice(`Restored "${fileName}" to the version from ${formatDateTime(version.capturedAt)}.`);
      showToast({ text: "Version restored", tone: "success" });
      onRestored();
      await loadVersions();
    } catch (restoreError) {
      setError(errorText(restoreError));
    } finally {
      setRestoringHash(null);
    }
  }

  async function undoRestore(): Promise<void> {
    if (!undoRestorePointId) return;
    setUndoing(true);
    setError(null);
    try {
      await api(`/api/workspaces/${workspace.id}/history/checkpoints/${undoRestorePointId}/restore`, { method: "POST" });
      setUndoRestorePointId(null);
      setNotice(`Undo complete — "${fileName}" is back to how it was.`);
      onRestored();
      await loadVersions();
    } catch (undoError) {
      setError(errorText(undoError));
    } finally {
      setUndoing(false);
    }
  }

  return (
    <div
      className="publish-review-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="publish-review-modal file-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-history-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="publish-review-heading">
          <span className="publish-review-icon"><History size={15} /></span>
          <span>
            <strong id="file-history-title">Version history</strong>
            <small>{filePath}</small>
          </span>
          <button ref={closeButtonRef} className="minimal-icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close version history">
            <X size={15} />
          </button>
        </div>
        {error ? <div className="publish-review-alert error">{error}</div> : null}
        {notice ? (
          <div className="publish-review-alert info file-history-notice">
            <span>{notice}</span>
            {undoRestorePointId ? (
              <button className="history-undo-button" type="button" disabled={busy} onClick={() => void undoRestore()}>
                {undoing ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Undo2 size={14} aria-hidden="true" />}
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="file-history-list">
          {versions === null ? (
            <div className="readiness-rail-empty"><Loader2 size={16} className="spin" aria-hidden="true" /> Loading versions</div>
          ) : versions.length ? (
            versions.map((version, index) => (
              <div className="file-history-row" key={version.hashSha256}>
                <span className="file-history-copy">
                  <strong>{formatTimeAgo(version.capturedAt)} · {formatDateTime(version.capturedAt)}</strong>
                  <small>
                    {formatBytes(version.sizeBytes)} · {fileVersionSourceLabel(version.source)}
                    {index === 0 ? " · newest saved version" : ""}
                  </small>
                </span>
                <button
                  className="readiness-run-button history-restore-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void restoreVersion(version)}
                >
                  {restoringHash === version.hashSha256 ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Undo2 size={14} aria-hidden="true" />}
                  Restore this version
                </button>
              </div>
            ))
          ) : (
            <div className="readiness-rail-empty">
              No saved versions of this file yet. Versions are saved when the Assistant edits a file and whenever a restore point is created.
            </div>
          )}
        </div>
        <p className="file-history-footnote">
          Restoring writes the older contents back to this file. If it is open in Word, Excel, or PowerPoint, close and reopen it to see the restored version.
        </p>
      </section>
    </div>
  );
}

export { FileVersionHistoryModal };
