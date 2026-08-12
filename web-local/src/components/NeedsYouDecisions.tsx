import { useCallback, useEffect, useRef, useState } from "react";
import { Alert24Regular } from "@fluentui/react-icons";

import { api, errorText } from "../lib/api";
import { needsYouSurface } from "../ui-contract";

/**
 * The needs-you decision surface (docs/fold-consecrations.md): one pending
 * staged act, one card, decided alone. Every line of the card body arrives
 * host-composed from `/api/management/decisions` — this component renders the
 * typed projection and never composes copy from Assistant prose. The popover
 * stack and the main-window flyout share this exact component (fold
 * integration reconciliation 6), differing only in where the stack mounts,
 * in the recorded decision surface (`popover` vs `main-window`), and in the
 * presentation: the flyout keeps the full stack, while the popover shows one
 * card at a time with an advance affordance. Card content, wiring, and the
 * one-card decision contract are identical in both presentations.
 */

export interface DecisionCardFact {
  label: string;
  value: string;
}

/** Mirrors the server's host-composed FoldDecisionCard projection. */
export interface DecisionCardView {
  id: string;
  kind: string;
  category: "make-runnable" | "widen-power" | "destroy";
  state: string;
  categoryLine: string;
  title: string;
  facts: DecisionCardFact[];
  spaceId?: string;
  spaceName?: string;
  provenance: {
    stagedVia: "management-conversation" | "act-cli";
    stagedAt: string;
    conversationId?: string;
    parentTaskId?: string;
    requestId: string;
    browserId?: string;
    grantId?: string;
  };
  createdAt: string;
  expiresAt: string;
  priorDenialAt?: string;
  secondConfirmation: boolean;
  desktopOnly: boolean;
  /**
   * A rootless app.grant.files card: approval binds to a folder chosen in the
   * main window's needs-you flyout, so surfaces without the picker keep
   * Approve unavailable up front. Host-computed — never inferred from kind.
   */
  needsDesktopChosenFolder: boolean;
  stagedByGrantId?: string;
  decidedAt?: string;
  decision?: { decision: "approved" | "denied"; surface: string };
  execution?: { outcome: "executed" | "failed" | "interrupted"; errorDetail?: string };
  invalidationReason?: string;
  cancellationReason?: string;
}

export type DecisionSurface = "popover" | "main-window";

export interface NeedsYouDecisionsState {
  cards: DecisionCardView[];
  busyId: string | null;
  notice: string;
  refresh: () => Promise<void>;
  decide: (
    card: DecisionCardView,
    decision: "approved" | "denied",
    options?: { note?: string; fileGrantRoot?: string },
  ) => Promise<void>;
  dismissNotice: () => void;
}

/**
 * Fetches pending cards and performs decisions with the owning surface
 * recorded on every receipt. Refreshes happen on demand and — when
 * `listenForReturn` is set — on the existing focus/visibility discipline;
 * no background watcher is added.
 */
export function useNeedsYouDecisions(options: {
  surface: DecisionSurface;
  enabled?: boolean;
  listenForReturn?: boolean;
}): NeedsYouDecisionsState {
  const enabled = options.enabled !== false;
  const surface = options.surface;
  const listenForReturn = options.listenForReturn === true;
  const [cards, setCards] = useState<DecisionCardView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await api<{ decisions: DecisionCardView[] }>("/api/management/decisions");
      setCards(result.decisions);
    } catch {
      // The stack renders recorded state only. A failed refresh keeps the
      // last known cards instead of inventing an empty, clear-looking state.
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !listenForReturn) return;
    const refreshOnReturn = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [enabled, listenForReturn, refresh]);

  const decide = useCallback(async (
    card: DecisionCardView,
    decision: "approved" | "denied",
    options?: { note?: string; fileGrantRoot?: string },
  ) => {
    setBusyId(card.id);
    setNotice("");
    try {
      const result = await api<{ decision: DecisionCardView; receipted: boolean }>(
        `/api/management/decisions/${encodeURIComponent(card.id)}/decide`,
        {
          method: "POST",
          body: {
            decision,
            surface,
            ...(decision === "denied" && options?.note?.trim() ? { note: options.note } : {}),
            // The app.grant.files person-chosen root from the desktop folder
            // picker; approvals only, and only this renderer lane carries it.
            ...(decision === "approved" && options?.fileGrantRoot ? { fileGrantRoot: options.fileGrantRoot } : {}),
          },
        },
      );
      setNotice(decisionNotice(result.decision, result.receipted));
    } catch (error) {
      // Refusals arrive typed (settled elsewhere, expired, invalidated, not
      // eligible); the host's sentence is the honest story either way.
      setNotice(errorText(error));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }, [surface, refresh]);

  const dismissNotice = useCallback(() => setNotice(""), []);

  return { cards, busyId, notice, refresh, decide, dismissNotice };
}

function decisionNotice(card: DecisionCardView, receipted: boolean): string {
  const receiptWarning = receipted ? "" : " The receipt could not be written; the outcome above still stands.";
  if (card.decision?.decision === "denied") {
    return `Denied: ${card.title}. work-fold never retries a denied act.${receiptWarning}`;
  }
  if (card.execution?.outcome === "executed") return `Done: ${card.title}.${receiptWarning}`;
  if (card.execution?.outcome === "failed") {
    return `Approved, but it failed: ${card.execution.errorDetail ?? "the execution reported an error."} It will not be retried.${receiptWarning}`;
  }
  if (card.execution?.outcome === "interrupted") {
    return `Approved, but interrupted before it finished. It was not replayed.${receiptWarning}`;
  }
  return `Recorded: ${card.title}.${receiptWarning}`;
}

/**
 * One pending decision. Approve and Deny only — there is no approve-all
 * anywhere. Destroy-category cards demand a second explicit confirmation
 * inside the card; a denial takes one click, with a note offered and never
 * required. An `app.grant.files` card additionally binds to a person-chosen
 * folder before Approve: the picker exists only behind the main window's
 * preload (`workFoldDesktop.decisions`), so other surfaces state where the
 * choice happens instead of discovering the refusal at click time.
 */
export function NeedsYouCard({ card, busy, onDecide }: {
  card: DecisionCardView;
  busy: boolean;
  onDecide: (decision: "approved" | "denied", options?: { note?: string; fileGrantRoot?: string }) => void;
}) {
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const [note, setNote] = useState("");
  const [grantRoot, setGrantRoot] = useState<string | null>(null);
  const [grantRootError, setGrantRootError] = useState("");

  const grantRootPicker = window.workFoldDesktop?.decisions?.chooseFileGrantRoot;
  const needsGrantRoot = card.needsDesktopChosenFolder && card.state === "staged";
  const grantRootReady = !needsGrantRoot || grantRoot !== null;

  const chooseGrantRoot = async () => {
    if (!grantRootPicker || !card.spaceId) return;
    setGrantRootError("");
    try {
      const chosen = await grantRootPicker(card.spaceId);
      if (!chosen) return;
      if (chosen.error !== undefined) setGrantRootError(chosen.error);
      else if (chosen.root !== undefined) setGrantRoot(chosen.root);
    } catch {
      setGrantRootError("work-fold could not open the folder picker.");
    }
  };

  const approve = () => {
    if (needsGrantRoot && grantRoot === null) return;
    if (card.secondConfirmation && !confirmingDestroy) {
      setConfirmingDestroy(true);
      return;
    }
    setConfirmingDestroy(false);
    onDecide("approved", needsGrantRoot && grantRoot !== null ? { fileGrantRoot: grantRoot } : undefined);
  };

  return (
    <article className="needs-you-card" data-category={card.category}>
      <p className="needs-you-category">{card.categoryLine}</p>
      <h3 className="needs-you-title">{card.title}</h3>
      {card.facts.length ? (
        <dl className="needs-you-facts">
          {card.facts.map((fact) => (
            <div className="needs-you-fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {needsGrantRoot ? (
        <div className="needs-you-grant-root">
          <dl className="needs-you-facts">
            <div className="needs-you-fact">
              <dt>{needsYouSurface.grantRootLabel}</dt>
              <dd>
                {grantRoot === null
                  ? needsYouSurface.grantRootMissing
                  : grantRoot === "."
                    ? needsYouSurface.grantRootWholeSpace
                    : <code>{grantRoot}</code>}
              </dd>
            </div>
          </dl>
          {grantRootPicker && card.spaceId ? (
            <button type="button" className="needs-you-choose-root" disabled={busy} onClick={() => void chooseGrantRoot()}>
              {grantRoot === null ? needsYouSurface.grantRootChoose : needsYouSurface.grantRootChange}
            </button>
          ) : (
            <p className="needs-you-desktop-only">{needsYouSurface.grantRootMainWindowOnly}</p>
          )}
          {grantRootError ? <p className="needs-you-grant-root-error" role="alert">{grantRootError}</p> : null}
        </div>
      ) : null}
      <p className="needs-you-provenance">
        {card.provenance.stagedVia === "management-conversation" ? "Staged by your fold" : "Staged from the command lane"}
        {" · "}{formatCardTime(card.provenance.stagedAt)}
        {" · expires "}{formatCardTime(card.expiresAt)}
      </p>
      {card.priorDenialAt ? (
        <p className="needs-you-prior-denial">Denied before ({formatCardTime(card.priorDenialAt)}), now staged again.</p>
      ) : null}
      {card.desktopOnly ? (
        <p className="needs-you-desktop-only">Loads into the fold's own runtime, so only this desktop can decide it.</p>
      ) : null}
      {confirmingDestroy ? (
        <div className="needs-you-confirm" role="alert">
          <p>{needsYouSurface.confirmDestroy}</p>
          <div className="needs-you-actions">
            <button type="button" className="needs-you-approve needs-you-destroy" disabled={busy} onClick={approve}>
              {needsYouSurface.confirmDestroyAction}
            </button>
            <button type="button" className="needs-you-keep" disabled={busy} onClick={() => setConfirmingDestroy(false)}>
              {needsYouSurface.keepIt}
            </button>
          </div>
        </div>
      ) : (
        <>
          <details className="needs-you-note">
            <summary>{needsYouSurface.addNote}</summary>
            <input
              type="text"
              value={note}
              maxLength={512}
              placeholder={needsYouSurface.notePlaceholder}
              aria-label={needsYouSurface.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
            />
          </details>
          <div className="needs-you-actions">
            <button type="button" className="needs-you-approve" disabled={busy || !grantRootReady} onClick={approve}>
              {needsYouSurface.approve}
            </button>
            <button type="button" className="needs-you-deny" disabled={busy} onClick={() => onDecide("denied", { note })}>
              {needsYouSurface.deny}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * The card stack: present only while at least one decision pends (or a just-
 * settled outcome is still on screen). The default `"stack"` presentation
 * renders every pending card — the main-window flyout keeps it — while the
 * popover's `"single"` presentation shows the current card alone with an
 * "N more" advance affordance that cycles through the rest. Deciding a card
 * removes it on refresh, so the next pending card slides into the same slot;
 * the cursor clamps rather than dangling past the shrunken list.
 */
export function NeedsYouStack({ state, presentation = "stack" }: {
  state: NeedsYouDecisionsState;
  presentation?: "stack" | "single";
}) {
  const [cardCursor, setCardCursor] = useState(0);
  if (!state.cards.length && !state.notice) return null;
  const single = presentation === "single";
  const index = state.cards.length ? Math.min(cardCursor, state.cards.length - 1) : 0;
  const shown = single ? state.cards.slice(index, index + 1) : state.cards;
  const moreCount = single ? state.cards.length - 1 : 0;
  return (
    <section className="needs-you-stack" aria-label={needsYouSurface.heading}>
      {single ? null : (
        <header className="needs-you-heading">
          {needsYouSurface.heading}
          {state.cards.length > 1 ? ` (${state.cards.length})` : ""}
        </header>
      )}
      {state.notice ? (
        <p className="needs-you-notice" role="status">
          <span>{state.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={state.dismissNotice}>✕</button>
        </p>
      ) : null}
      {shown.map((card) => (
        <NeedsYouCard
          key={card.id}
          card={card}
          busy={state.busyId === card.id}
          onDecide={(decision, options) => void state.decide(card, decision, options)}
        />
      ))}
      {moreCount > 0 ? (
        <button
          type="button"
          className="needs-you-advance"
          aria-label={`Show the next decision (${moreCount} more)`}
          onClick={() => setCardCursor((index + 1) % state.cards.length)}
        >
          {moreCount} more
        </button>
      ) : null}
    </section>
  );
}

/**
 * The main window's conditional bottom-rail indicator with its anchored
 * flyout. No pending decisions, no control — an empty state adds nothing to
 * the shell — and the flyout is a small window-scope surface, deliberately
 * not a tab and not a fourth permanent rail destination.
 */
export function NeedsYouRailControl({ state }: { state: NeedsYouDecisionsState }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const count = state.cards.length;

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent): void {
      if (anchorRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => buttonRef.current?.focus());
    }
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [open]);

  // Conditional presence: the control exists only while decisions pend, and
  // lingers just long enough to show the final card's outcome in the open
  // flyout before disappearing with it.
  if (count === 0 && !(open && state.notice)) return null;

  const label = count === 1 ? `${needsYouSurface.heading} (1 decision)` : `${needsYouSurface.heading} (${count} decisions)`;
  return (
    <div
      className="space-rail-needs-you-anchor"
      ref={anchorRef}
      onBlurCapture={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        className="space-rail-quiet-button space-rail-needs-you-button"
        type="button"
        onClick={() => {
          setOpen((current) => !current);
          void state.refresh();
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="needs-you-flyout"
        data-rail-tooltip={label}
      >
        <Alert24Regular aria-hidden="true" />
        {count ? <span className="needs-you-count" aria-hidden="true">{count > 9 ? "9+" : count}</span> : null}
        <span>{needsYouSurface.heading}</span>
      </button>
      {open ? (
        <div id="needs-you-flyout" className="needs-you-flyout" role="dialog" aria-label={needsYouSurface.heading} data-native-view-occluder="true">
          <NeedsYouStack state={state} />
        </div>
      ) : null}
    </div>
  );
}

function formatCardTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
