/** One existing publication, opened on its isolated viewer origin. */
export function sharedPageUrl(link, { publicationId, slug, managementOrigin, preview = false }) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(publicationId) || !/^[a-z0-9-]{1,63}$/.test(slug ?? "")) throw new Error("This page link is unavailable.");
  const origin = new URL(link?.viewerOrigin);
  const management = new URL(managementOrigin);
  const local = ["localhost", "127.0.0.1"].includes(management.hostname);
  const baseHost = local ? (preview ? "localhost" : management.hostname) : management.hostname.slice(`${slug}.`.length);
  if ((!local && !management.hostname.startsWith(`${slug}.`))
    || origin.origin !== link.viewerOrigin || origin.username || origin.password
    || origin.protocol !== management.protocol || origin.port !== management.port
    || origin.hostname !== `pages-${slug}.${baseHost}` || origin.origin === management.origin
    || !new RegExp(`^/[pa]/${publicationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(link.viewerPath)
    || !/^[A-Za-z0-9_-]{43}$/.test(link.key ?? "")) throw new Error("This page link is unavailable.");
  const url = new URL(link.viewerPath, origin);
  url.hash = link.key;
  if (preview && local) url.searchParams.set("fixture", "1");
  return url.href;
}

/** On-demand, in-memory navigation. No publication keys enter storage. */
export function createSharedPages({ button, popup, load, reveal, online, available, slug, preview = false, onOpened = () => {} }) {
  const list = popup.querySelector(".shared-pages-list");
  const refreshButton = popup.querySelector(".shared-pages-refresh");
  let pages = [], loading = false, error = "", opening = null, revision = 0, fallback = null, openingTab = null;
  const message = (text) => { const p = document.createElement("p"); p.className = "shared-pages-empty"; p.textContent = text; return p; };

  function draw() {
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.pageId : null;
    list.replaceChildren();
    refreshButton.disabled = loading || opening !== null || !online() || !available();
    popup.setAttribute("aria-busy", String(loading));
    if (!online()) list.append(message("Open work-fold on your desktop to see your shared pages."));
    else if (!available()) list.append(message("Update work-fold on your desktop to see shared pages here."));
    else if (loading) list.append(message("Loading pages…"));
    else if (!pages.length && !error) list.append(message("Share a page in work-fold to see it here."));
    else for (const page of pages) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "shared-page-row"; row.dataset.pageId = page.publicationId;
      row.disabled = opening !== null;
      row.setAttribute("aria-label", `Open ${page.title}`);
      row.setAttribute("aria-busy", String(opening === page.publicationId));
      row.innerHTML = '<svg class="shared-page-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6Z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/></svg><span class="shared-page-copy"></span><svg class="shared-page-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>';
      const copy = row.querySelector(".shared-page-copy");
      const title = document.createElement("span"); title.textContent = page.title; copy.append(title);
      if (page.health?.state && page.health.state !== "live") {
        const state = document.createElement("small");
        state.textContent = ({ asleep: "Desktop offline", resting: "Resting", "not-available": "Not available" })[page.health.state] ?? "Not available";
        copy.append(state);
      }
      row.addEventListener("click", () => void open(page)); list.append(row);
    }
    if (error) { const notice = message(error); notice.setAttribute("role", "alert"); list.append(notice); }
    if (fallback) {
      const link = document.createElement("a"); link.className = "shared-page-fallback";
      link.textContent = "Open page"; link.href = fallback; link.target = "_blank"; link.rel = "noopener noreferrer";
      list.append(link);
    }
    if (focusedId) [...list.querySelectorAll("[data-page-id]")].find((row) => row.dataset.pageId === focusedId)?.focus({ preventScroll: true });
  }

  async function reload({ focusFirst = false } = {}) {
    const current = ++revision;
    opening = null; openingTab?.close(); openingTab = null;
    error = ""; fallback = null;
    if (!online() || !available()) { loading = false; draw(); return; }
    loading = true; draw();
    try {
      const result = await load();
      if (current !== revision || popup.hidden || !online()) return;
      if (!Array.isArray(result?.pages)) throw new Error("Couldn’t load shared pages. Try Refresh.");
      pages = result.pages.slice(0, 32).filter((page) => /^[A-Za-z0-9._:-]{1,128}$/.test(page?.publicationId ?? "")
        && typeof page.title === "string" && page.title.trim() && page.title.length <= 80);
    } catch (caught) {
      if (current === revision) { pages = []; error = caught?.message || "Couldn’t load shared pages. Try Refresh."; }
    } finally {
      if (current === revision && !popup.hidden) {
        loading = false; draw();
        if (focusFirst && document.activeElement === button) list.querySelector("button")?.focus({ preventScroll: true });
      }
    }
  }

  async function open(page) {
    if (opening !== null || !online() || !available()) return;
    // Reserve the new tab during the click, before awaiting the desktop.
    // Its opener is severed before any viewer content can load.
    const tab = window.open("about:blank", "_blank");
    openingTab = tab;
    if (tab) {
      tab.opener = null;
      tab.document.title = "Shared page";
      tab.document.body.textContent = "Opening this page…";
      tab.document.body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui";
      const theme = getComputedStyle(popup);
      tab.document.body.style.background = theme.getPropertyValue("--surface").trim();
      tab.document.body.style.color = theme.getPropertyValue("--ink").trim();
    }
    const current = revision;
    opening = page.publicationId; error = ""; fallback = null; draw();
    try {
      const link = await reveal(page.publicationId);
      if (current !== revision || !online()) { tab?.close(); return; }
      const url = sharedPageUrl(link, { publicationId: page.publicationId, slug: slug(), managementOrigin: location.origin, preview });
      if (tab && !tab.closed) { tab.location.replace(url); openingTab = null; close(); onOpened(); }
      else { fallback = url; error = "Your browser blocked the page. Use the link below to open it."; }
    } catch (caught) {
      tab?.close();
      if (current === revision) error = caught?.message || "Couldn’t open this page. Try again.";
    } finally {
      if (current === revision) { opening = null; openingTab = null; if (!popup.hidden) draw(); }
    }
  }

  function close({ restoreFocus = false } = {}) {
    revision++; loading = false; fallback = null; opening = null;
    openingTab?.close(); openingTab = null;
    popup.hidden = true; button.setAttribute("aria-expanded", "false");
    list.replaceChildren();
    if (restoreFocus) button.focus({ preventScroll: true });
  }
  button.addEventListener("click", () => {
    if (!popup.hidden) return close();
    popup.hidden = false; button.setAttribute("aria-expanded", "true");
    void reload({ focusFirst: true });
  });
  refreshButton.addEventListener("click", () => void reload());
  // Rows redraw during a click; keep that click inside the popup even when
  // the original target has already left the DOM.
  popup.addEventListener("click", (event) => event.stopPropagation());
  return {
    close,
    connectionChanged() { revision++; loading = false; fallback = null; opening = null; openingTab?.close(); openingTab = null; if (!popup.hidden) void reload(); },
    capabilityChanged() { opening = null; openingTab?.close(); openingTab = null; if (!popup.hidden) void reload(); },
    destroy: close,
  };
}
