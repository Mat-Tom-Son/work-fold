import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";

/**
 * The glance (docs/fold-glance.md): the app-composed digest rendered at the
 * top of the popover — and available to the main window — from
 * `GET /api/management/glance`. Every line is a deterministic host template
 * over recorded state; nothing here composes copy, and rendering never causes
 * a record to exist. The one mutation is the seen marker: a surface reports
 * the digest's cursor only after it has actually rendered on a visible
 * surface, fetching never advances it, and marking seen renders items quieter
 * without hiding anything — Show earlier reveals the bounded tail regardless.
 * A surface that folds the digest behind a collapsed strip passes
 * `acknowledge: false` while collapsed: fetching keeps the strip's unseen
 * count honest, and the marker advances only once the person expands the
 * strip and the digest actually renders.
 */

export interface GlanceItemView {
  id: string;
  at: string;
  kind: string;
  spaceId?: string;
  spaceName?: string;
  headline: string;
}

export interface GlanceCheckRowView {
  spaceId: string;
  spaceName: string;
  state: string;
  needsAttention: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  lastRunAt: string | null;
}

/** Mirrors the server's experimental glance snapshot projection. */
export interface GlanceSnapshotView {
  composedAt: string;
  cursor: string;
  running: GlanceItemView[];
  needsYou: GlanceItemView[];
  changes: GlanceItemView[];
  checks: GlanceCheckRowView[];
  seen: Record<string, string>;
  truncated: { running: boolean; needsYou: boolean; changes: boolean; checks: boolean };
  unavailable: string[];
}

export type GlanceSurface = "popover" | "main-window";

export interface GlanceState {
  snapshot: GlanceSnapshotView | null;
  refresh: () => Promise<void>;
}

export function useGlance(surface: GlanceSurface, options?: { acknowledge?: boolean }): GlanceState {
  const acknowledge = options?.acknowledge !== false;
  const [snapshot, setSnapshot] = useState<GlanceSnapshotView | null>(null);
  const acknowledgedRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ glance: GlanceSnapshotView }>("/api/management/glance");
      setSnapshot(result.glance);
    } catch {
      // The digest renders recorded state only. A failed refresh keeps the
      // last rendered snapshot instead of inventing an empty, clear one.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Acknowledge after render, never on fetch: this effect runs only once the
  // fetched snapshot has committed to the screen, skips hidden surfaces and
  // surfaces whose digest is folded behind a collapsed strip
  // (`acknowledge: false`), and posts each cursor at most once. The store is
  // monotonic either way — a replayed or backward advance is a no-op — and a
  // failed acknowledgement only leaves items rendering as new.
  useEffect(() => {
    if (!acknowledge) return;
    if (!snapshot?.cursor || document.visibilityState === "hidden") return;
    if (snapshot.seen[surface] === snapshot.cursor || acknowledgedRef.current === snapshot.cursor) return;
    acknowledgedRef.current = snapshot.cursor;
    void api("/api/management/glance/seen", {
      method: "POST",
      body: { surface, cursor: snapshot.cursor },
    }).catch(() => {
      acknowledgedRef.current = "";
    });
  }, [snapshot, surface, acknowledge]);

  return { snapshot, refresh };
}

/**
 * Unseen change items for a surface's collapsed strip label. Counting reads
 * the fetched snapshot only — it never advances the marker, exactly like the
 * fetch itself.
 */
export function glanceUnseenChangeCount(snapshot: GlanceSnapshotView | null, surface: GlanceSurface): number {
  if (!snapshot) return 0;
  const seenThrough = snapshot.seen[surface] ?? "";
  return snapshot.changes.filter((item) => glanceCursorIsNewer(`${item.at}/${item.id}`, seenThrough)).length;
}

/**
 * Distinct Space ids the digest mentions — checks rows plus Space-carrying
 * items. This is what the snapshot can honestly count; it is not a
 * registered-Spaces total, so callers fall back to a Space-free phrasing
 * when it is zero or one.
 */
export function glanceSpaceCount(snapshot: GlanceSnapshotView | null): number {
  if (!snapshot) return 0;
  const ids = new Set<string>();
  for (const row of snapshot.checks) ids.add(row.spaceId);
  for (const item of [...snapshot.running, ...snapshot.needsYou, ...snapshot.changes]) {
    if (item.spaceId) ids.add(item.spaceId);
  }
  return ids.size;
}

/**
 * True when the digest has nothing to render. Pending decisions are excluded
 * because they belong to the needs-you card surface; an empty digest means
 * nothing is recorded, never "all clear".
 */
export function glanceIsEmpty(snapshot: GlanceSnapshotView): boolean {
  const questions = snapshot.needsYou.filter((item) => item.kind !== "pending-decision");
  return !questions.length && !snapshot.running.length && !snapshot.changes.length
    && !snapshot.checks.length && !snapshot.unavailable.length;
}

/**
 * The digest's sections in the recorded order — Needs you (the glance's
 * conversational items; pending decisions render as their own interactive
 * card stack beside this section), Running now, a compact Since you last
 * looked, then the Checks rows. Bounds are disclosure: every truncation flag
 * and unavailable source is said out loud instead of rendered as quiet.
 */
export function GlanceSection({ state, surface }: { state: GlanceState; surface: GlanceSurface }) {
  const [showEarlier, setShowEarlier] = useState(false);
  // What counts as "new" freezes at the moment the digest opens: this
  // component mounts per look, and the acknowledgement that follows must not
  // grey out or collapse the very items the person just expanded to read.
  // The next look starts from the advanced marker.
  const openedSeenRef = useRef<string | null>(null);
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  if (openedSeenRef.current === null) openedSeenRef.current = snapshot.seen[surface] ?? "";
  const seenThrough = openedSeenRef.current;
  // Pending decisions are the card stack's job (one card contract, decided
  // there); the glance section renders the digest's other needs-you kinds.
  const questions = snapshot.needsYou.filter((item) => item.kind !== "pending-decision");
  const isNew = (item: GlanceItemView) => glanceCursorIsNewer(`${item.at}/${item.id}`, seenThrough);
  const fresh = snapshot.changes.filter(isNew);
  const shownChanges = showEarlier ? snapshot.changes : fresh;
  const earlierCount = snapshot.changes.length - fresh.length;
  if (glanceIsEmpty(snapshot)) return null;

  return (
    <section className="glance" aria-label="The glance">
      {questions.length ? (
        <>
          <h3 className="glance-heading">Needs you</h3>
          <ul className="glance-list">
            {questions.map((item) => <GlanceRow key={item.id} item={item} />)}
          </ul>
        </>
      ) : null}
      {snapshot.running.length ? (
        <>
          <h3 className="glance-heading">Running now</h3>
          <ul className="glance-list">
            {snapshot.running.map((item) => <GlanceRow key={item.id} item={item} />)}
          </ul>
          {snapshot.truncated.running ? <p className="glance-truncated">More is running than fits in this digest.</p> : null}
        </>
      ) : null}
      {snapshot.changes.length ? (
        <>
          <h3 className="glance-heading">Since you last looked</h3>
          {shownChanges.length ? (
            <ul className="glance-list">
              {shownChanges.map((item) => <GlanceRow key={item.id} item={item} quiet={!isNew(item)} />)}
            </ul>
          ) : (
            <p className="glance-empty">Nothing new since you last looked.</p>
          )}
          {!showEarlier && earlierCount ? (
            <button type="button" className="glance-show-earlier" onClick={() => setShowEarlier(true)}>
              Show earlier ({earlierCount})
            </button>
          ) : null}
          {snapshot.truncated.changes ? <p className="glance-truncated">Older changes are beyond this digest.</p> : null}
        </>
      ) : null}
      {snapshot.checks.length ? (
        <>
          <h3 className="glance-heading">Checks</h3>
          <ul className="glance-list">
            {snapshot.checks.map((row) => (
              <li className="glance-item" key={row.spaceId}>
                <strong>{row.spaceName}</strong> · {checkStateLabel(row.state)}
                {row.needsAttention ? ` · ${row.needsAttention} need${row.needsAttention === 1 ? "s" : ""} attention` : ""}
              </li>
            ))}
          </ul>
          {snapshot.truncated.checks ? <p className="glance-truncated">More Spaces have Checks than fit in this digest.</p> : null}
        </>
      ) : null}
      {snapshot.unavailable.length ? (
        <p className="glance-unavailable">
          Some records could not be read just now: {snapshot.unavailable.join(", ")}.
        </p>
      ) : null}
    </section>
  );
}

function GlanceRow({ item, quiet = false }: { item: GlanceItemView; quiet?: boolean }) {
  return (
    <li className={`glance-item${quiet ? " quiet" : ""}`}>
      {item.spaceName ? <><strong>{item.spaceName}</strong> · </> : null}
      {item.headline}
    </li>
  );
}

/** Mirrors the server's cursor order: timestamp first, then item id. */
function glanceCursorIsNewer(cursor: string, seenThrough: string): boolean {
  if (!seenThrough) return true;
  const parse = (value: string): { at: string; id: string } => {
    const separator = value.indexOf("/");
    return separator > 0 ? { at: value.slice(0, separator), id: value.slice(separator + 1) } : { at: value, id: "" };
  };
  const left = parse(cursor);
  const right = parse(seenThrough);
  const leftAt = Date.parse(left.at);
  const rightAt = Date.parse(right.at);
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt > rightAt;
  if (left.at !== right.at) return left.at > right.at;
  return left.id > right.id;
}

function checkStateLabel(value: string): string {
  switch (value) {
    case "current-clear": return "clear";
    case "needs-attention": return "needs attention";
    case "check-error": return "check error";
    case "blocked": return "blocked";
    case "stale": return "stale";
    case "never-run": return "never run";
    default: return value;
  }
}
