/**
 * Small shared motion: exits for elements React removes, glides between
 * layouts, and the moment a Worker's reply lands. Entrances live in
 * motion.css; everything here honours both reduce-motion switches.
 */

const ease = "cubic-bezier(.2,0,0,1)";

// CSS preference rules cannot cancel Web Animations API effects. Keep the
// scripted effects together so either preference also stops motion in flight.
const motionDocuments = new WeakMap<Document, { animations: Set<Animation>; clearExits: Set<() => void> }>();

function documentMotion(doc: Document) {
  let state = motionDocuments.get(doc);
  if (state) return state;
  state = { animations: new Set(), clearExits: new Set() };
  motionDocuments.set(doc, state);
  const current = state;
  const stopIfReduced = () => {
    if (!motionReduced(doc)) return;
    for (const animation of current.animations) animation.cancel();
    current.animations.clear();
    for (const clear of current.clearExits) clear();
  };
  const view = doc.defaultView;
  if (view) {
    new view.MutationObserver(stopIfReduced).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-appearance-motion"] });
    view.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener("change", stopIfReduced);
  }
  return state;
}

function animate(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
  const state = documentMotion(element.ownerDocument);
  const animation = element.animate(frames, options);
  state.animations.add(animation);
  const finished = () => state.animations.delete(animation);
  void animation.finished.then(finished, finished);
  return animation;
}

export function motionReduced(doc: Document = document): boolean {
  return doc.documentElement.dataset.appearanceMotion === "reduce"
    || Boolean(doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

type ExitKind = "dialog" | "menu" | "toast" | "collapse" | "collapse-inline";

// What leaves with an exit when React removes it. A component can name its
// own kind with data-exit-motion; only the removed element itself counts, so
// a pane that unmounts takes its open menus with it at once.
const exitSelectors: ReadonlyArray<readonly [ExitKind, string]> = [
  ["dialog", ".modal-backdrop, .publish-review-backdrop"],
  ["menu", [
    ".context-menu", ".composer-command-menu", ".chat-rename-popover",
    ".surface-tab-work-folder-menu", ".model-catalog-popover", ".work-folder-pane-breadcrumb-menu",
    ".browser-tab-site-menu", ".work-folder-header-switcher",
  ].join(", ")],
  ["toast", ".toast"],
];

// Hooks other code finds elements by; a leaving copy must not answer to them.
const ghostStrippedAttributes = ["id", "role", "aria-modal", "autofocus", "data-tab-id", "data-tree-row", "data-tree-path"];

function exitKindOf(element: HTMLElement): ExitKind | null {
  const named = element.dataset.exitMotion;
  if (named) return named as ExitKind;
  return exitSelectors.find(([, selector]) => element.matches(selector))?.[0] ?? null;
}

/**
 * Lets removed overlays, toasts, folders, and tabs leave the way they came: an
 * inert copy plays the exit where the element stood, then goes away. React
 * never sees the copy, so its state stays exactly as it was committed.
 */
export function startExitMotion(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view || typeof view.MutationObserver !== "function" || typeof doc.body?.animate !== "function") return () => {};
  // A detached element forgets its scroll position, so remember it while it is on screen.
  const scrolled = new WeakMap<Element, { top: number; left: number }>();
  const live = new Set<HTMLElement>();
  const clearExits = () => { for (const ghost of live) ghost.remove(); live.clear(); };
  const motion = documentMotion(doc);
  motion.clearExits.add(clearExits);
  const rememberScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Element) scrolled.set(target, { top: target.scrollTop, left: target.scrollLeft });
  };
  doc.addEventListener("scroll", rememberScroll, { capture: true, passive: true });

  const observer = new view.MutationObserver((records) => {
    // A replacement (the next confirmation, the palette handing over to
    // Settings, tabs regrouping) swaps at once instead of overlapping.
    const arriving = new Set<ExitKind>();
    const leaving: Array<{ kind: ExitKind; node: HTMLElement; parent: HTMLElement; next: Node | null }> = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || "exitGhost" in node.dataset) continue;
        const kind = exitKindOf(node);
        if (kind) arriving.add(kind);
      }
      const parent = record.target;
      if (!(parent instanceof HTMLElement) || !parent.isConnected) continue;
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || "exitGhost" in node.dataset || node.isConnected) continue;
        const kind = exitKindOf(node);
        if (kind) leaving.push({ kind, node, parent, next: record.nextSibling?.parentNode === parent ? record.nextSibling : null });
      }
    }
    for (const ghost of live) if (arriving.has(ghost.dataset.exitGhost as ExitKind)) { live.delete(ghost); ghost.remove(); }
    if (!leaving.length || doc.hidden || motionReduced(doc)) return;
    for (const { kind, node, parent, next } of leaving) {
      if (!arriving.has(kind) && !node.querySelector("iframe, webview, video")) leave(kind, node, parent, next);
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  function leave(kind: ExitKind, original: HTMLElement, parent: HTMLElement, next: Node | null): void {
    const ghost = original.cloneNode(true) as HTMLElement;
    const originals = [original, ...original.querySelectorAll<HTMLElement>("*")];
    const copies = [ghost, ...ghost.querySelectorAll<HTMLElement>("*")];
    copies.forEach((copy, index) => {
      const source = originals[index];
      if ((source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement || source instanceof HTMLSelectElement)
        && (copy instanceof HTMLInputElement || copy instanceof HTMLTextAreaElement || copy instanceof HTMLSelectElement)) {
        copy.value = source.value;
        if (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) copy.checked = source.checked;
      }
      for (const attribute of ghostStrippedAttributes) copy.removeAttribute(attribute);
    });
    ghost.dataset.exitGhost = kind;
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.pointerEvents = "none";
    parent.insertBefore(ghost, next);
    live.add(ghost);
    copies.forEach((copy, index) => {
      const position = scrolled.get(originals[index]!);
      if (position) { copy.scrollTop = position.top; copy.scrollLeft = position.left; }
    });

    const animations = exitAnimations(kind, ghost);
    const done = () => { live.delete(ghost); ghost.remove(); };
    if (!animations.length) { done(); return; }
    Promise.allSettled(animations.map((animation) => animation.finished)).then(done);
    // A window that stops drawing (minimized, hidden) also stops the exit; the copy still goes.
    view!.setTimeout(done, 1000);
  }

  return () => {
    observer.disconnect();
    doc.removeEventListener("scroll", rememberScroll, { capture: true });
    motion.clearExits.delete(clearExits);
    clearExits();
  };
}

function exitAnimations(kind: ExitKind, ghost: HTMLElement): Animation[] {
  switch (kind) {
    case "dialog":
      return [
        animate(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-out", fill: "forwards" }),
        ...[...ghost.children].map((panel) => animate(panel,
          [{ scale: "1", translate: "0 0" }, { scale: "0.98", translate: "0 4px" }],
          { duration: 150, easing: ease, fill: "forwards" },
        )),
      ];
    case "menu":
      return [animate(ghost,
        [{ opacity: 1, scale: "1" }, { opacity: 0, scale: "0.97" }],
        { duration: 110, easing: "ease-out", fill: "forwards" },
      )];
    case "toast":
      return collapse(ghost, "block", 220, [{ translate: "0 0", opacity: 1 }, { translate: "16px 0", opacity: 0, offset: 0.55 }, { translate: "16px 0", opacity: 0 }]);
    case "collapse":
      return collapse(ghost, "block", 180, [{ opacity: 1 }, { opacity: 0 }]);
    case "collapse-inline":
      return collapse(ghost, "inline", 170, [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }]);
  }
}

/** Shrinks a leaving copy to nothing so its neighbours close the gap as it goes. */
function collapse(ghost: HTMLElement, axis: "block" | "inline", duration: number, fade: Keyframe[]): Animation[] {
  const style = getComputedStyle(ghost);
  const box = ghost.getBoundingClientRect();
  const size = axis === "block" ? box.height : box.width;
  const side = axis === "block" ? ["Top", "Bottom"] as const : ["Left", "Right"] as const;
  const extent = axis === "block" ? "height" : "width";
  // In a flex or grid parent the gap beside the copy closes too, from the side it sits on.
  const parentStyle = ghost.parentElement ? getComputedStyle(ghost.parentElement) : null;
  const laidOut = parentStyle && /flex|grid/.test(parentStyle.display);
  const gap = laidOut ? Number.parseFloat(axis === "block" ? parentStyle.rowGap : parentStyle.columnGap) || 0 : 0;
  const inFlow = (element: Element | null) => element && !("exitGhost" in (element as HTMLElement).dataset) && !/absolute|fixed/.test(getComputedStyle(element).position);
  const hasNext = (() => { let next = ghost.nextElementSibling; while (next && !inFlow(next)) next = next.nextElementSibling; return Boolean(next); })();
  const hasPrevious = (() => { let previous = ghost.previousElementSibling; while (previous && !inFlow(previous)) previous = previous.previousElementSibling; return Boolean(previous); })();
  const closingMargin = `margin${hasNext ? side[1] : side[0]}`;
  Object.assign(ghost.style, { overflow: "hidden", boxSizing: "border-box", flex: "none", minWidth: "0", minHeight: "0", maxWidth: "none", maxHeight: "none" });
  const from: Keyframe = { [extent]: `${size}px` };
  const to: Keyframe = { [extent]: "0px" };
  for (const edge of side) {
    from[`padding${edge}`] = style.getPropertyValue(`padding-${edge.toLowerCase()}`);
    from[`border${edge}Width`] = style.getPropertyValue(`border-${edge.toLowerCase()}-width`);
    from[`margin${edge}`] = style.getPropertyValue(`margin-${edge.toLowerCase()}`);
    to[`padding${edge}`] = "0px";
    to[`border${edge}Width`] = "0px";
    to[`margin${edge}`] = "0px";
  }
  if (gap && (hasNext || hasPrevious)) to[closingMargin] = `${-gap}px`;
  return [
    animate(ghost, [from, to], { duration, easing: ease, fill: "forwards" }),
    animate(ghost, fade, { duration, easing: "ease-out", fill: "forwards" }),
  ];
}

/** Plays an element's move from where it was (`from`) to where layout put it now. */
export function glideFrom(element: HTMLElement | null, from: DOMRect | null, duration = 340): void {
  if (!element || !from || typeof element.animate !== "function" || motionReduced(element.ownerDocument)) return;
  const to = element.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  animate(element, [{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration, easing: ease });
}

/** A content swap in place (another work-folder) settles in rather than cutting. */
export function settleIn(elements: Iterable<Element | null | undefined>, duration = 220): void {
  for (const element of elements) {
    if (!element || typeof element.animate !== "function" || motionReduced(element.ownerDocument)) continue;
    animate(element, [{ opacity: 0.25, translate: "0 3px" }, { opacity: 1, translate: "0 0" }], { duration, easing: ease });
  }
}

/**
 * New content arriving from a side (2026-11-07): a folder opened deeper or
 * forward slides in from the right, one gone up or back from the left, and
 * anything else settles in place.
 */
export function slideIn(element: Element | null | undefined, from: "left" | "right" | "none", duration = 220): void {
  if (!element || typeof element.animate !== "function" || motionReduced(element.ownerDocument)) return;
  const offset = from === "right" ? "14px 0" : from === "left" ? "-14px 0" : "0 3px";
  animate(element, [{ opacity: 0.2, translate: offset }, { opacity: 1, translate: "0 0" }], { duration, easing: ease });
}

/** The dot's small moment when a Worker's reply lands: a pop and one ring. */
export function celebrateFinish(dot: HTMLElement | null): void {
  if (!dot || typeof dot.animate !== "function" || motionReduced(dot.ownerDocument)) return;
  animate(dot, [{ scale: "1" }, { scale: "1.6", offset: 0.35 }, { scale: "1" }], { duration: 460, easing: ease });
  animate(dot, [{ opacity: 0.8, scale: "1" }, { opacity: 0, scale: "3" }], { duration: 620, easing: ease, pseudoElement: "::after" });
}
