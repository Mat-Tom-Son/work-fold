import { createBrowserAppActions } from "./browser-app-actions.js";
/** Private app views use approved-browser authority, never a public share link. */
export function createBrowserAppView({ read, online, resolve = async (app) => app, actions }) {
  const dialog = document.createElement("dialog");
  dialog.className = "browser-app-dialog";
  dialog.innerHTML = '<header><div><h2 id="browser-app-title"></h2><p></p></div><button type="button" data-close aria-label="Close app">✕</button></header><div class="browser-app-content" aria-live="polite"></div><footer><span>Read-only view</span><button type="button" class="quiet" data-refresh>Refresh</button></footer>';
  dialog.setAttribute("aria-labelledby", "browser-app-title");
  document.body.append(dialog);
  const content = dialog.querySelector(".browser-app-content");
  const refresh = dialog.querySelector("[data-refresh]");
  const actionRegion = document.createElement("section"); actionRegion.className = "browser-app-actions";
  actionRegion.setAttribute("aria-label", "App requests"); actionRegion.hidden = true;
  dialog.querySelector("footer").before(actionRegion);
  let selected;
  let opener;
  let frame;
  let generation = 0;
  let channel;
  let inFlight = 0;
  let entry;
  let loadTimer;
  let healthTimer;
  let checking = false;
  const actionPanel = createBrowserAppActions({ element: actionRegion, execute: actions,
    active: () => Boolean(frame && dialog.open && online() && selected?.actions === true && actions) });
  const clear = () => { clearTimeout(loadTimer); clearInterval(healthTimer); actionPanel.reset(); generation++; frame = null; entry = null; content.replaceChildren(); inFlight = 0; checking = false; };
  const unavailable = (message) => { clear(); content.textContent = message; refresh.disabled = !online(); };
  const close = () => { clear(); selected = null; if (dialog.open) dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  function label() { dialog.querySelector("h2").textContent = selected.title; dialog.querySelector("header p").textContent = `${selected.spaceName} · ${selected.version}${selected.preview ? " · Preview" : ""}${selected.sourceDigest && selected.sourceDigest !== selected.digest ? " · Updated since this task" : ""}`; }
  async function call(value, expectedGeneration) {
    let result;
    try { result = await read(selected, value); }
    catch (error) { if (generation === expectedGeneration) unavailable("This app could not be reached. Refresh to try again."); throw error; }
    if (generation !== expectedGeneration || !dialog.open || !online()) throw new Error("This app view is no longer active.");
    if (result?.state !== "served") {
      unavailable("This app changed or is unavailable. Refresh to try again.");
      throw new Error("This app view is unavailable.");
    }
    if (!result.result?.ok) throw Object.assign(new Error(result.result?.message || "This read is unavailable."), { code: result.result?.code });
    return result.result.result;
  }
  async function load() {
    clear();
    if (!selected) return;
    if (!online()) return unavailable("Desktop offline. Reconnect and refresh to open this app.");
    const current = generation;
    refresh.disabled = true;
    content.textContent = "Opening…";
    try {
      const target = selected;
      const fresh = await resolve({ ...target });
      if (current !== generation) return;
      if (!fresh || fresh.spaceId !== target.spaceId || fresh.featureInstallationId !== target.featureInstallationId || fresh.appId !== target.appId) throw new Error("This app is no longer installed. Open Apps again.");
      selected = { ...target, ...fresh }; label();
      dialog.querySelector("footer span").textContent = selected.actions && actions ? "Actions need your review" : "Read-only view";
      if (!selected.webView) return unavailable("This app has no web view yet. Open it on your desktop.");
      const result = await call({ kind: "entry" }, current);
      if (current !== generation) return;
      if (result.kind !== "entry" || typeof result.bytes !== "string" || result.bytes.length > 1_398_104) throw new Error("The app entry is invalid.");
      entry = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.bytes.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));
      channel = crypto.randomUUID();
      frame = document.createElement("iframe");
      // Both the static intermediary and its app child have opaque origins.
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = selected.title;
      frame.src = "/browser-app-frame.html";
      frame.style.visibility = "hidden";
      const loading = document.createElement("p");
      loading.className = "browser-app-loading";
      loading.textContent = "Opening…";
      content.replaceChildren(loading, frame);
      if (selected.actions && actions) void actionPanel.open(selected);
      loadTimer = setTimeout(() => { if (current === generation) unavailable("This browser could not open the app. Try another browser or open it on your desktop."); }, 10_000);
      healthTimer = setInterval(() => {
        if (checking || !online() || document.visibilityState === "hidden") return;
        checking = true;
        const shown = selected;
        void resolve({ ...shown }).then((fresh) => {
          if (current !== generation) return;
          if (!fresh || fresh.featureInstallationId !== shown.featureInstallationId || fresh.spaceId !== shown.spaceId || fresh.appId !== shown.appId || fresh.digest !== shown.digest || fresh.authorityDigest !== shown.authorityDigest) unavailable("This app changed. Refresh to open the current view.");
        }).catch(() => { if (current === generation) unavailable("This app could not be reached. Refresh to try again."); })
          .finally(() => { if (current === generation) checking = false; });
      }, 15_000);
    } catch (error) {
      if (current === generation) unavailable(error instanceof Error ? error.message : "This app is unavailable.");
    } finally { if (current === generation) refresh.disabled = !online(); }
  }
  function message(event) {
    if (!frame || event.source !== frame.contentWindow || !dialog.open || !online()) return;
    const data = event.data;
    if (data?.type === "work-fold.browser-app.loaded" && data.channel === channel) { clearTimeout(loadTimer); content.querySelector(".browser-app-loading")?.remove(); frame.style.visibility = "visible"; return; }
    if (data?.type === "work-fold.browser-app.navigated" && data.channel === channel) { unavailable("This app left its web view. Refresh to open it again."); return; }
    if (data?.type === "work-fold.browser-app.ready" && entry !== null) {
      frame.contentWindow.postMessage({ type: "work-fold.browser-app.init", channel, html: entry, actions: Boolean(selected.actions && actions) }, "*");
      entry = null;
      return;
    }
    if (data?.type !== "work-fold.browser-app.call" || data.channel !== channel || !Number.isSafeInteger(data.callId) || data.callId < 1) return;
    const target = frame.contentWindow;
    const current = generation;
    const respond = (payload) => { if (current === generation && dialog.open && online()) target.postMessage({ type: "work-fold.browser-app.result", channel, callId: data.callId, ...payload }, "*"); };
    const kinds = ["asset", "data.get", "data.keys"];
    const actionCall = selected.actions && actions && ["actions.request", "actions.get", "actions.list", "actions.cancel"].includes(data.call?.kind);
    let valid = false;
    try { valid = (kinds.includes(data.call?.kind) || actionCall) && JSON.stringify(data.call).length <= (actionCall ? 20 * 1024 : 1024); } catch {}
    if (!valid) return respond({ ok: false, code: "APP_DENIED", message: actionCall ? "This action request is invalid or too large." : "That operation is unavailable in this app view." });
    if (inFlight >= 4 || document.visibilityState === "hidden") return respond({ ok: false, code: "APP_BUSY", message: "The app is busy or inactive. Try again." });
    inFlight++;
    void (actionCall ? actionPanel.call(data.call) : call(data.call, current)).then((result) => respond({ ok: true, result })).catch((error) => {
      respond({ ok: false, code: error.code, message: error.message });
    }).finally(() => { if (current === generation) inFlight--; });
  }
  window.addEventListener("message", message);
  dialog.querySelector("[data-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  refresh.addEventListener("click", () => void load());
  return {
    async open(app) { opener = document.activeElement; selected = { ...app }; label(); if (!dialog.open) dialog.showModal(); await load(); },
    connectionChanged(connected) { if (selected) unavailable(connected ? "Desktop reconnected. Refresh to open the current app." : "Desktop offline. Reconnect and refresh to open this app."); refresh.disabled = !connected; },
    destroy() { close(); window.removeEventListener("message", message); dialog.remove(); },
  };
}
