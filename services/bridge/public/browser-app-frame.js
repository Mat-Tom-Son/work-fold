// Trusted, sandboxed intermediary. Its child may navigate only to blob: URLs;
// app code never shares the management document or this frame's origin.
(() => {
  let frame;
  let channel;
  let objectUrl;
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === parent && data?.type === "work-fold.browser-app.init" && !frame) {
      if (typeof data.channel !== "string" || typeof data.html !== "string" || data.html.length > 1024 * 1024) return;
      channel = data.channel;
      const script = `<script>(${bootstrap.toString()})()</script>`;
      const doctype = data.html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "";
      const source = `${doctype}${script}${data.html.slice(doctype.length)}`;
      frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = "App content";
      objectUrl = URL.createObjectURL(new Blob([source], { type: "text/html" }));
      frame.src = objectUrl;
      document.body.append(frame);
      return;
    }
    if (!frame) return;
    if (event.source === frame.contentWindow && data?.type === "work-fold.browser-app.loaded") {
      parent.postMessage({ type: data.type, channel }, "*");
    } else if (event.source === frame.contentWindow && data?.type === "work-fold.browser-app.call") {
      parent.postMessage({ type: data.type, channel, callId: data.callId, call: data.call }, "*");
    } else if (event.source === parent && data?.type === "work-fold.browser-app.result" && data.channel === channel) {
      frame.contentWindow?.postMessage(data, "*");
    }
  });
  addEventListener("pagehide", () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
  addEventListener("securitypolicyviolation", (event) => {
    if (frame && event.violatedDirective === "frame-src") parent.postMessage({ type: "work-fold.browser-app.navigated", channel }, "*");
  });
  parent.postMessage({ type: "work-fold.browser-app.ready" }, "*");

  function bootstrap() {
    const pending = new Map();
    let nextId = 0;
    addEventListener("message", (event) => {
      const data = event.data;
      if (event.source !== parent || data?.type !== "work-fold.browser-app.result") return;
      const waiting = pending.get(data.callId);
      if (!waiting) return;
      clearTimeout(waiting.timer); pending.delete(data.callId);
      if (data.ok) waiting.resolve(data.result);
      else waiting.reject(Object.assign(new Error(data.message || "This app call is unavailable."), { code: data.code || "APP_UNAVAILABLE" }));
    });
    const call = (value) => new Promise((resolve, reject) => {
      if (pending.size >= 16) return reject(new Error("Too many app reads. Try again."));
      const callId = ++nextId;
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error("The desktop did not respond. Refresh the app to try again.")); }, 30_000);
      pending.set(callId, { resolve, reject, timer });
      parent.postMessage({ type: "work-fold.browser-app.call", callId, call: value }, "*");
    });
    const api = {
      async asset(path) {
        const value = await call({ kind: "asset", path: String(path) });
        const binary = atob(value.bytes.replace(/-/g, "+").replace(/_/g, "/"));
        return { path: value.path, mediaType: value.mediaType, bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
      },
      async assetUrl(path) { const asset = await api.asset(path); return URL.createObjectURL(new Blob([asset.bytes], { type: asset.mediaType })); },
      data: Object.freeze({
        async keys(prefix) { return (await call(prefix === undefined ? { kind: "data.keys" } : { kind: "data.keys", prefix: String(prefix) })).keys; },
        async get(key) { const value = await call({ kind: "data.get", key: String(key) }); return value.present ? value.value : undefined; },
      }),
    };
    Object.defineProperty(globalThis, "workFoldViewerApp", { value: Object.freeze(api), writable: false, configurable: false });
    addEventListener("DOMContentLoaded", () => parent.postMessage({ type: "work-fold.browser-app.loaded" }, "*"), { once: true });
  }
})();
