/** Pointer reordering moves only tab chrome; work surfaces stay mounted. */
export function createSurfaceTabReorder(strip: HTMLElement, options: {
  grouped: () => boolean;
  commit: (ids: string[]) => void;
  announce: (id: string, position: number, count: number) => void;
}) {
  const doc = strip.ownerDocument;
  const view = doc.defaultView!;
  const media = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  const animations = new Map<HTMLElement, Animation>();
  let pendingLayout: Map<HTMLElement, number> | null = null;
  let suppressClick = false;
  let frame = 0;
  let generation = 0;
  let drag: {
    id: string; pointerId: number; startX: number; x: number; scroll: number;
    active: boolean; element: HTMLElement; capture: HTMLElement;
    all: HTMLElement[]; peers: HTMLElement[]; slots: number[]; order: HTMLElement[];
  } | null = null;

  const reduced = () => doc.documentElement.dataset.appearanceMotion === "reduce" || Boolean(media?.matches);
  function cancelAnimations() {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  }
  function slide(element: HTMLElement, from: number, to: number) {
    animations.get(element)?.cancel(); animations.delete(element);
    element.style.transform = to ? `translateX(${to}px)` : "";
    if (reduced() || !element.animate || Math.abs(from - to) < 0.5) return;
    const animation = element.animate([
      { transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` },
    ], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    animations.set(element, animation);
    animation.finished.then(() => { if (animations.get(element) === animation) animations.delete(element); }, () => {});
  }
  function move() {
    if (!drag?.active) return;
    const delta = drag.x - drag.startX + strip.scrollLeft - drag.scroll;
    const original = drag.peers.indexOf(drag.element);
    const left = Math.max(drag.slots[0]!, Math.min(drag.slots.at(-1)!, drag.slots[original]! + delta));
    drag.element.style.transform = `translateX(${left - drag.slots[original]!}px)`;
    // Fixed layout slots avoid oscillation while neighbours are in flight.
    const target = drag.slots.reduce((nearest, slot, index) => Math.abs(slot - left) < Math.abs(drag!.slots[nearest]! - left) ? index : nearest, 0);
    const order = drag.peers.filter((peer) => peer !== drag!.element);
    order.splice(target, 0, drag.element);
    if (order.every((peer, index) => peer === drag!.order[index])) return;
    const visible = new Map(drag.peers.map((peer) => [peer, peer.getBoundingClientRect().left]));
    drag.order = order;
    for (const peer of drag.peers) {
      if (peer === drag.element) continue;
      const index = drag.peers.indexOf(peer);
      const offset = drag.slots[order.indexOf(peer)]! - drag.slots[index]!;
      const base = strip.getBoundingClientRect().left + drag.slots[index]! - strip.scrollLeft;
      slide(peer, visible.get(peer)! - base, offset);
    }
  }
  function autoScroll() {
    if (!drag?.active) return;
    const box = strip.getBoundingClientRect();
    const speed = drag.x < box.left + 40 ? -Math.min(12, (box.left + 40 - drag.x) / 4)
      : drag.x > box.right - 40 ? Math.min(12, (drag.x - box.right + 40) / 4) : 0;
    if (speed) strip.scrollLeft += speed;
    move();
    frame = view.requestAnimationFrame(autoScroll);
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    if (!drag.active && Math.abs(drag.x - drag.startX) < 6) return;
    event.preventDefault();
    if (!drag.active) {
      drag.active = true; suppressClick = true;
      strip.dataset.reordering = "dragging";
      drag.element.dataset.dragging = "true";
      try { drag.capture.setPointerCapture?.(drag.pointerId); } catch { /* Pointer may have ended before capture. */ }
      frame = view.requestAnimationFrame(autoScroll);
    }
    move();
  }
  function finish(commit: boolean) {
    if (!drag) return;
    const current = drag; drag = null;
    view.cancelAnimationFrame(frame);
    doc.removeEventListener("pointermove", pointerMove);
    doc.removeEventListener("pointerup", pointerUp);
    doc.removeEventListener("pointercancel", pointerCancel);
    doc.removeEventListener("keydown", keyDown, true);
    view.removeEventListener("blur", pointerCancel);
    if (current.capture.hasPointerCapture?.(current.pointerId)) current.capture.releasePointerCapture(current.pointerId);
    if (!current.active) return;
    const positions = new Map(current.all.map((peer) => [peer, peer.getBoundingClientRect().left]));
    cancelAnimations();
    for (const peer of current.all) { peer.style.transform = ""; delete peer.dataset.dragging; }
    strip.dataset.reordering = "settling";
    if (commit && current.order.some((peer, index) => peer !== current.peers[index])) {
      const reordered = [...current.order];
      const ids = current.all.map((peer) => (current.peers.includes(peer) ? reordered.shift()! : peer).dataset.tabId!);
      pendingLayout = positions;
      options.commit(ids);
      options.announce(current.id, current.order.indexOf(current.element) + 1, current.peers.length);
    } else settle(positions);
  }
  function settle(positions: Map<HTMLElement, number>) {
    const settledGeneration = ++generation;
    const elements = [...strip.querySelectorAll<HTMLElement>(".surface-tab[data-tab-id]")];
    for (const peer of elements) slide(peer, (positions.get(peer) ?? peer.getBoundingClientRect().left) - peer.getBoundingClientRect().left, 0);
    Promise.allSettled([...animations.values()].map((animation) => animation.finished)).then(() => {
      if (settledGeneration === generation && !drag && !pendingLayout) delete strip.dataset.reordering;
    });
  }
  function pointerUp(event: PointerEvent) { if (event.pointerId === drag?.pointerId) finish(true); }
  function pointerCancel(event?: Event) {
    if (event && "pointerId" in event && event.pointerId !== drag?.pointerId) return;
    finish(false);
  }
  function keyDown(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); } }
  function preferenceChanged() { if (reduced()) cancelAnimations(); }
  const preferences = new view.MutationObserver(preferenceChanged);
  preferences.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-appearance-motion"] });
  media?.addEventListener("change", preferenceChanged);
  return {
    begin(event: PointerEvent, id: string, capture: HTMLElement) {
      if (event.button !== 0 || event.isPrimary === false || drag || pendingLayout) return;
      generation++;
      cancelAnimations(); delete strip.dataset.reordering;
      const all = [...strip.querySelectorAll<HTMLElement>(".surface-tab[data-tab-id]")];
      const element = all.find((peer) => peer.dataset.tabId === id);
      if (!element) return;
      const peers = options.grouped() ? all.filter((peer) => peer.dataset.workFolderId === element.dataset.workFolderId) : all;
      if (peers.length < 2) return;
      suppressClick = false;
      drag = { id, pointerId: event.pointerId, startX: event.clientX, x: event.clientX, scroll: strip.scrollLeft,
        active: false, element, capture,
        all, peers, slots: peers.map((peer) => peer.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft), order: peers };
      doc.addEventListener("pointermove", pointerMove, { passive: false });
      doc.addEventListener("pointerup", pointerUp);
      doc.addEventListener("pointercancel", pointerCancel);
      doc.addEventListener("keydown", keyDown, true);
      view.addEventListener("blur", pointerCancel);
    },
    consumeClick() { const suppressed = suppressClick; suppressClick = false; return suppressed; },
    reorder(ids: string[]) {
      generation++;
      finish(false); cancelAnimations();
      pendingLayout = new Map([...strip.querySelectorAll<HTMLElement>(".surface-tab[data-tab-id]")].map((peer) => [peer, peer.getBoundingClientRect().left]));
      strip.dataset.reordering = "settling";
      options.commit(ids);
    },
    layout() {
      if (pendingLayout) { const positions = pendingLayout; pendingLayout = null; settle(positions); }
      else if (drag) finish(false);
    },
    dispose() { finish(false); cancelAnimations(); preferences.disconnect(); media?.removeEventListener("change", preferenceChanged); delete strip.dataset.reordering; },
  };
}
