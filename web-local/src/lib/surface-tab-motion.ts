/** Move only the connected tab chrome; labels and mounted work surfaces stay still. */
export function createSurfaceTabMotion(strip: HTMLElement, chrome: HTMLElement) {
  const view = strip.ownerDocument.defaultView!;
  const root = strip.ownerDocument.documentElement;
  const systemMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  let selected: HTMLElement | null = null;
  let geometry: { left: number; top: number; width: number; height: number } | null = null;
  let animation: Animation | null = null;

  function reduceMotion(): boolean {
    const preference = root.dataset.appearanceMotion;
    return preference === "reduce" || systemMotion.matches;
  }

  function settle(): void {
    animation?.cancel();
    animation = null;
  }

  function position(animate: boolean): void {
    if (!selected?.isConnected || !strip.contains(selected)) {
      settle();
      geometry = null;
      chrome.style.visibility = "hidden";
      delete strip.dataset.activeChrome;
      return;
    }
    const stripBox = strip.getBoundingClientRect();
    const tabBox = selected.getBoundingClientRect();
    const next = {
      left: tabBox.left - stripBox.left + strip.scrollLeft,
      top: tabBox.top - stripBox.top + strip.scrollTop,
      width: tabBox.width,
      height: tabBox.height,
    };
    if (geometry && Object.entries(next).every(([key, value]) => Math.abs(value - geometry![key as keyof typeof next]) < 0.1)) return;
    // Read the interpolated position before cancelling, so quick clicks retarget
    // from the visible shape instead of snapping back to the previous tab.
    const previous = geometry ? chrome.getBoundingClientRect() : null;
    settle();
    Object.assign(chrome.style, {
      left: `${next.left}px`, top: `${next.top}px`,
      width: `${next.width}px`, height: `${next.height}px`, visibility: "visible",
    });
    strip.dataset.activeChrome = "ready";
    geometry = next;
    if (!animate || !previous || reduceMotion() || typeof chrome.animate !== "function") return;
    animation = chrome.animate([
      { transform: `translateX(${previous.left - tabBox.left}px)`, width: `${previous.width}px` },
      { transform: "translateX(0px)", width: `${next.width}px` },
    ], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => position(false));
  resize?.observe(strip);
  const preferenceObserver = new MutationObserver(() => { if (reduceMotion()) settle(); });
  preferenceObserver.observe(root, { attributes: true, attributeFilter: ["data-appearance-motion"] });
  const onSystemMotionChange = () => { if (reduceMotion()) settle(); };
  systemMotion.addEventListener("change", onSystemMotionChange);

  return {
    select(tab: HTMLElement | null, animate = false): void {
      if (!animate) settle();
      if (selected !== tab) {
        if (selected) resize?.unobserve(selected);
        selected = tab;
        if (selected) resize?.observe(selected);
      }
      position(animate);
    },
    dispose(): void {
      settle();
      resize?.disconnect();
      preferenceObserver.disconnect();
      systemMotion.removeEventListener("change", onSystemMotionChange);
    },
  };
}
