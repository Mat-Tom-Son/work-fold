import { useEffect, useState } from "react";
import { Checkmark16Regular } from "@fluentui/react-icons";

import { api, errorText } from "../../lib/api";
import { recentlyDeletedSettings } from "../../ui-contract";

/**
 * Settings → General → Recently deleted (docs/receipts-not-gates.md, F20).
 * Nothing work-fold destroys is gone at the moment it happens: History covers
 * ordinary deletion, and whatever it could not keep a copy of waits here until
 * its time runs out. This pane lists what is waiting, puts an item back, saves
 * app data whose app is gone as a plain file, removes one item early, and sets
 * how long items are kept. Nothing here empties the whole store.
 */

export type RecentlyDeletedKind = "file" | "folder" | "space" | "app-storage" | "app-retained";

export interface RecentlyDeletedEntry {
  id: string;
  kind: RecentlyDeletedKind;
  reason:
    | "files.delete"
    | "spaces.delete"
    | "apps.remove"
    | "apps.space.removed"
    | "apps.storage.clear"
    | "apps.retained.purge"
    | "apps.uninstall.purge";
  spaceId: string;
  spaceName?: string;
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: Array<{ path: string; reason: "too_large" | "unreadable" | "symbolic_link" | "excluded" }>;
  held?: { reason: "legacy-metadata" | "unreadable"; noticedAt: string };
  restorable: "in-place" | "save-only" | "blocked";
  note?: string;
}

export interface RecentlyDeletedResponse {
  entries: RecentlyDeletedEntry[];
  damaged: Array<{ id: string; error: string }>;
  retentionDays: number;
}

const kindLabels: Record<RecentlyDeletedKind, string> = {
  file: "File",
  folder: "Folder",
  space: "Folder",
  "app-storage": "App data",
  "app-retained": "App data",
};

const uncoveredLabels: Record<"too_large" | "unreadable" | "symbolic_link" | "excluded", string> = {
  too_large: "too large",
  unreadable: "unreadable",
  symbolic_link: "a link",
  excluded: "kept out of History",
};

export function formatDeletedSize(bytes: number, approximate?: boolean): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${approximate ? "at least " : ""}${rounded} ${units[unit]}`;
}

export function describeUncovered(entry: RecentlyDeletedEntry): string | null {
  const uncovered = entry.uncovered ?? [];
  if (!uncovered.length) return null;
  const named = uncovered.slice(0, 3).map((file) => `${file.path} (${uncoveredLabels[file.reason]})`).join(", ");
  const more = uncovered.length > 3 ? `, and ${uncovered.length - 3} more` : "";
  return `History could not keep a copy of ${uncovered.length} file${uncovered.length === 1 ? "" : "s"}: ${named}${more}.`;
}

export function FoldRecentlyDeletedPane() {
  const [data, setData] = useState<RecentlyDeletedResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);

  async function reload(): Promise<void> {
    const next = await api<RecentlyDeletedResponse>("/api/settings/trash");
    setData(next);
    setRetentionDraft(null);
    setLoadError(null);
  }

  useEffect(() => {
    let cancelled = false;
    api<RecentlyDeletedResponse>("/api/settings/trash")
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    return () => { cancelled = true; };
  }, []);

  async function run(key: string, operation: () => Promise<string | null>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const done = await operation();
      await reload();
      if (done) setNotice(done);
    } catch (caught) {
      setActionError(errorText(caught));
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function restore(entry: RecentlyDeletedEntry): Promise<void> {
    await run(`restore-${entry.id}`, async () => {
      await api(`/api/settings/trash/${entry.id}/restore`, { method: "POST", body: {} });
      return `${entry.name} is back`;
    });
  }

  async function saveCopy(entry: RecentlyDeletedEntry): Promise<void> {
    await run(`save-${entry.id}`, async () => {
      const response = await api<{ backup: unknown }>(`/api/settings/trash/${entry.id}/export`);
      const blob = new Blob([JSON.stringify(response.backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${entry.name.replace(/[^A-Za-z0-9._-]+/g, "-")}-data.json`;
      link.click();
      URL.revokeObjectURL(url);
      return "Copy saved";
    });
  }

  async function deleteNow(entry: RecentlyDeletedEntry): Promise<void> {
    if (!window.confirm(recentlyDeletedSettings.deleteNowConfirm)) return;
    await run(`delete-${entry.id}`, async () => {
      await api(`/api/settings/trash/${entry.id}`, { method: "DELETE" });
      return `${entry.name} is gone`;
    });
  }

  async function saveRetention(): Promise<void> {
    const days = Number(retentionDraft);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setActionError(recentlyDeletedSettings.retentionRange);
      return;
    }
    await run("retention", async () => {
      await api("/api/settings/trash/retention", { method: "PUT", body: { retentionDays: days } });
      return recentlyDeletedSettings.retentionSaved;
    });
  }

  const entries = data?.entries ?? [];
  const retentionValue = retentionDraft ?? String(data?.retentionDays ?? 30);

  return (
    <section className="settings-section" aria-labelledby="fold-recently-deleted-title">
      <div className="settings-section-heading">
        <h3 id="fold-recently-deleted-title">{recentlyDeletedSettings.heading}</h3>
        {data ? <span>{entries.length} waiting</span> : null}
      </div>
      <div className="settings-actions">
        <label htmlFor="fold-recently-deleted-retention">{recentlyDeletedSettings.retentionLabel}</label>
        <input
          id="fold-recently-deleted-retention"
          type="number"
          min={1}
          max={365}
          value={retentionValue}
          disabled={!data || Boolean(busy)}
          onChange={(event) => setRetentionDraft(event.target.value)}
        />
        <span>{recentlyDeletedSettings.retentionUnit}</span>
        <button
          className="secondary-button"
          type="button"
          disabled={!data || Boolean(busy) || retentionDraft === null || retentionDraft === String(data?.retentionDays)}
          onClick={() => { void saveRetention(); }}
        >
          {recentlyDeletedSettings.retentionSave}
        </button>
      </div>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {data?.damaged.length ? (
        <span className="settings-inline-error" role="alert">
          {recentlyDeletedSettings.damagedNote} ({data.damaged.map((item) => item.id).join(", ")})
        </span>
      ) : null}
      {data && !entries.length ? <div className="remote-browser-empty">{recentlyDeletedSettings.empty}</div> : null}
      {entries.length ? (
        <div className="remote-browser-list">
          {entries.map((entry) => {
            const uncovered = describeUncovered(entry);
            return (
              <div className="remote-browser-row" key={entry.id}>
                <div>
                  <strong>{entry.name}</strong>
                  <small>
                    {kindLabels[entry.kind]} from {entry.spaceName ?? entry.spaceId} · {formatDeletedSize(entry.sizeBytes, entry.sizeApproximate)}
                  </small>
                  <small>
                    Deleted {new Date(entry.deletedAt).toLocaleString()} · Kept until {new Date(entry.restoreBy).toLocaleDateString()}
                  </small>
                  {uncovered ? <small>{uncovered}</small> : null}
                  {entry.note ? <small>{entry.note}</small> : null}
                  {entry.held ? <small>{recentlyDeletedSettings.heldNote}</small> : null}
                </div>
                <div className="settings-actions">
                  {entry.restorable === "in-place" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => { void restore(entry); }}
                    >
                      {recentlyDeletedSettings.restore}
                    </button>
                  ) : entry.restorable === "save-only" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => { void saveCopy(entry); }}
                    >
                      {recentlyDeletedSettings.saveCopy}
                    </button>
                  ) : null}
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(busy) || Boolean(entry.held)}
                    title={entry.held ? recentlyDeletedSettings.heldNote : undefined}
                    onClick={() => { void deleteNow(entry); }}
                  >
                    {recentlyDeletedSettings.deleteNow}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
