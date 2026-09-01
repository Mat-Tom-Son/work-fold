import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pulse20Regular } from "@fluentui/react-icons";

import { GlanceSection, useGlance } from "../../popover/GlanceSection";

/**
 * The main window's glance (docs/fold-glance.md, surface `main-window`): the
 * same app-composed digest the popover renders, presented as a compact panel
 * reachable from the persistent Space-identity header region — deliberately
 * not a new rail destination, badge, or permanent navigation item. The digest
 * hook mounts only while the panel is open, so work-fold fetches nothing and
 * acknowledges nothing for a panel nobody is looking at; while open it
 * refreshes on the focus/visibility discipline Checks already use, and the
 * shared `useGlance` hook posts the rendered cursor as surface `main-window`
 * only after the digest has actually rendered.
 */
export function GlanceHeaderControl() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelOrigin, setPanelOrigin] = useState<{ top: number; left: number } | null>(null);

  function toggle(): void {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    // The header clips its own children, so the panel renders through a
    // portal at fixed coordinates measured from the trigger — the same
    // measured-anchor approach the chat actions popover uses.
    setPanelOrigin(rect ? { top: Math.round(rect.bottom + 8), left: Math.round(rect.left) } : null);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent): void {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => buttonRef.current?.focus());
    }
    // The portal panel sits at fixed coordinates measured from the trigger;
    // a window resize would strand it, so the panel closes instead.
    function closeFromResize(): void {
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromEscape, true);
    window.addEventListener("resize", closeFromResize);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromEscape, true);
      window.removeEventListener("resize", closeFromResize);
    };
  }, [open]);

  return (
    <span className="glance-header-anchor" ref={anchorRef}>
      <button
        ref={buttonRef}
        className="minimal-icon-button glance-header-button"
        type="button"
        onClick={toggle}
        aria-label="The glance"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="main-window-glance-panel"
        title="The glance"
      >
        <Pulse20Regular aria-hidden="true" />
      </button>
      {open
        ? createPortal(
          <div
            id="main-window-glance-panel"
            className="glance-panel"
            role="dialog"
            aria-label="The glance"
            data-native-view-occluder="true"
            ref={panelRef}
            style={panelOrigin ? { top: panelOrigin.top, left: panelOrigin.left } : undefined}
          >
            <GlancePanelBody />
          </div>,
          document.body,
        )
        : null}
    </span>
  );
}

/**
 * Mounted only while the panel is open: the initial fetch happens on open,
 * and the focus/visibility listeners below exist only for an open panel — no
 * background recomputation for nobody (docs/fold-glance.md non-goal 3).
 */
function GlancePanelBody() {
  const state = useGlance("main-window");
  const refresh = state.refresh;

  useEffect(() => {
    function refreshOnReturn(): void {
      if (document.visibilityState !== "visible") return;
      void refresh();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [refresh]);

  const snapshot = state.snapshot;
  if (!snapshot) {
    return <p className="glance-empty">Reading what work-fold has recorded…</p>;
  }
  // Pending decisions belong to the needs-you flyout's card stack, so they do
  // not make this section non-empty — mirror GlanceSection's own predicate.
  const questions = snapshot.needsYou.filter((item) => item.kind !== "pending-decision");
  const empty = !questions.length && !snapshot.running.length && !snapshot.changes.length
    && !snapshot.checks.length && !snapshot.unavailable.length;
  if (empty) {
    // An empty digest means nothing is recorded, not that nothing happened.
    return <p className="glance-empty">Nothing recorded right now.</p>;
  }
  return <GlanceSection state={state} surface="main-window" />;
}
