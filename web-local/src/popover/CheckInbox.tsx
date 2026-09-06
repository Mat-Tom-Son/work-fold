import { useEffect, useState } from "react";
import { api, errorText } from "../lib/api";
import type { GlanceSnapshotView } from "./GlanceSection";

/** Passive aggregate projection. Opening it never starts a model or a Check. */
export function CheckInbox() {
  const [rows, setRows] = useState<GlanceSnapshotView["checks"]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const { glance } = await api<{ glance: GlanceSnapshotView }>("/api/management/glance");
        if (!disposed) { setRows(glance.checks); setError(null); }
      } catch (caught) { if (!disposed) { setRows([]); setError(errorText(caught)); } }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  if (!rows.length && !error) return null;
  const attention = rows.reduce((sum, row) => sum + row.needsAttention, 0);
  return <section className="fold-section">
    <button type="button" className="fold-strip" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{attention ? `Checks · ${attention} to review` : "Checks"}</span>
    </button>
    {open ? <div className="fold-drawer">
      {error ? <p role="alert">Check status is unavailable.</p> : rows.map((row) => <div className="check-inbox-row" key={row.spaceId}>
        <div><strong>{row.spaceName}</strong><p>{row.needsAttention ? `${row.needsAttention} finding${row.needsAttention === 1 ? "" : "s"}` : row.errors ? "Review Check health" : row.neverRun ? "Ready for a first run" : row.state === "not-configured" ? "Proposal ready for review" : row.state === "current-clear" ? "Current · no findings" : "Review Checks"}</p></div>
        <button type="button" onClick={() => { void window.workFoldDesktop?.management?.openChecks?.(row.spaceId).catch((caught) => setError(errorText(caught))); }}>Review</button>
      </div>)}
    </div> : null}
  </section>;
}
