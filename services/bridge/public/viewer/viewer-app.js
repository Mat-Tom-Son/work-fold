// The viewer-app shell for "an app at your address" (docs/fold-publishing.md,
// rung 3). It runs on the isolated pages-<slug> origin with the same
// fragment-key rule as pages: the decryption key rides only in the URL
// fragment and never leaves this shell. The reviewed app renders inside a
// sandboxed blob: iframe WITHOUT allow-same-origin — an opaque origin with no
// storage, no cookies, and (because CSP 'self' never matches an opaque
// origin) no network of its own. Every read the app makes rides this shell's
// postMessage broker, which fetches only the closed viewer routes: the
// reviewed entry, exact staged assets, and manifest-declared viewer-readable
// data. The desktop refuses everything else; this shell holds no other
// capability to offer.

const envelopeType = "work-fold.viewer-app.v1";
const maximumPayloadBytes = 2 * 1024 * 1024;
const maximumConcurrentAppCalls = 8;
const callMessageType = "work-fold.viewer-app-call.v1";
const resultMessageType = "work-fold.viewer-app-result.v1";

/** Publication id and fragment key from one app share link, or nulls. */
export function parseViewerAppLocation(pathname, hash) {
  const path = /^\/a\/([A-Za-z0-9._:-]{1,128})$/.exec(String(pathname ?? ""));
  const fragment = String(hash ?? "").replace(/^#/, "");
  return {
    publicationId: path ? path[1] : null,
    key: /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null,
  };
}

/**
 * Canonical fingerprint of one viewer-app call: JSON with recursively sorted
 * object keys. Must produce byte-identical output to
 * `workFoldViewerAppCallFingerprint` in `src/local/publications.ts` — the
 * fingerprint is bound into the AES-GCM additional data, so a mismatch is an
 * authentication failure, not a soft error.
 */
export function viewerAppCallFingerprint(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const encoded = viewerAppCallFingerprint(item, depth + 1);
      if (encoded === null) return null;
      items.push(encoded);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      const encoded = viewerAppCallFingerprint(value[key], depth + 1);
      if (encoded === null) return null;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  }
  return null;
}

/** The additional authenticated data both ends bind for one app response. */
export function viewerAppAad(publicationId, callFingerprint, contentDigest, servedAt) {
  return JSON.stringify([envelopeType, publicationId, callFingerprint, contentDigest, servedAt]);
}

export function base64UrlToBytes(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** The API route for one typed viewer-app call, or null for anything else. */
export function viewerAppCallRoute(publicationId, call) {
  if (!call || typeof call !== "object") return null;
  const base = `/api/viewer/apps/${publicationId}`;
  if (call.kind === "entry") return `${base}/entry`;
  if (call.kind === "asset" && typeof call.path === "string") {
    return `${base}/asset?path=${encodeURIComponent(call.path)}`;
  }
  if (call.kind === "data.keys") {
    return call.prefix === undefined ? `${base}/data/keys` : `${base}/data/keys?prefix=${encodeURIComponent(String(call.prefix))}`;
  }
  if (call.kind === "data.get" && typeof call.key === "string") {
    return `${base}/data/get?key=${encodeURIComponent(call.key)}`;
  }
  return null;
}

export async function decryptViewerAppPayload({ key, publicationId, call, envelope }) {
  const header = envelope?.header ?? {};
  const fingerprint = viewerAppCallFingerprint(call);
  if (fingerprint === null) throw new Error("App call is invalid.");
  const cryptoKey = await crypto.subtle.importKey("raw", base64UrlToBytes(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.iv),
      additionalData: new TextEncoder().encode(viewerAppAad(publicationId, fingerprint, header.contentDigest, header.servedAt)),
    },
    cryptoKey,
    base64UrlToBytes(envelope.ciphertext),
  );
  if (plaintext.byteLength > maximumPayloadBytes) throw new Error("App payload is too large.");
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload || typeof payload !== "object" || payload.v !== 1 || typeof payload.ok !== "boolean") {
    throw new Error("App payload is invalid.");
  }
  return payload;
}

/**
 * The bootstrap script injected ahead of the reviewed entry document inside
 * the sandboxed frame. It defines the one viewer-side app API —
 * `workFoldViewerApp` — as promise-based reads over postMessage to this
 * shell. There is nothing else to call: no actions, no network, no
 * connections, no files, no notifications, no writes.
 */
const frameBootstrap = `<script>(() => {
  const pending = new Map();
  let nextCallId = 1;
  addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || data.type !== ${JSON.stringify(resultMessageType)} || typeof data.callId !== "number") return;
    const settle = pending.get(data.callId);
    if (!settle) return;
    pending.delete(data.callId);
    if (data.ok) settle.resolve(data.result);
    else settle.reject(new Error(typeof data.message === "string" ? data.message : "This call is not viewer-reachable."));
  });
  const call = (payload) => new Promise((resolve, reject) => {
    const callId = nextCallId;
    nextCallId += 1;
    pending.set(callId, { resolve, reject });
    parent.postMessage({ type: ${JSON.stringify(callMessageType)}, callId, call: payload }, "*");
  });
  const toBytes = (text) => {
    const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  };
  const api = {
    async asset(path) {
      const result = await call({ kind: "asset", path: String(path) });
      return { path: result.path, mediaType: result.mediaType, bytes: toBytes(result.bytes) };
    },
    async assetUrl(path) {
      const asset = await api.asset(path);
      return URL.createObjectURL(new Blob([asset.bytes], { type: asset.mediaType }));
    },
    data: {
      async keys(prefix) {
        const result = await call(prefix === undefined ? { kind: "data.keys" } : { kind: "data.keys", prefix: String(prefix) });
        return result.keys;
      },
      async get(key) {
        const result = await call({ kind: "data.get", key: String(key) });
        return result.present ? result.value : undefined;
      },
    },
  };
  Object.freeze(api.data);
  Object.freeze(api);
  globalThis.workFoldViewerApp = api;
})();</script>`;

/**
 * Compose the sandboxed frame document: the bootstrap runs before the
 * reviewed entry's own parser order. A leading doctype is preserved so the
 * app renders in standards mode.
 */
export function composeViewerAppDocument(entryHtml) {
  const source = String(entryHtml ?? "");
  const doctype = source.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) {
    const head = doctype[0];
    return `${head}${frameBootstrap}${source.slice(head.length)}`;
  }
  return `${frameBootstrap}${source}`;
}

function showStatus(root, text) {
  root.replaceChildren();
  const status = document.createElement("p");
  status.className = "viewer-status";
  status.textContent = text;
  root.append(status);
}

function stateMessage(state, slug) {
  if (state === "nothing-here") return "Nothing is published here.";
  if (state === "asleep") {
    return `The app this page belongs to is served by ${slug ?? "its owner"}'s work-fold desktop, which is asleep right now. Try again later.`;
  }
  if (state === "resting") return "This app has had a lot of visitors today. Try again later.";
  if (state === "not-available") return "This app isn't available right now.";
  return null;
}

async function fetchViewerAppResult(publicationId, call) {
  const route = viewerAppCallRoute(publicationId, call);
  if (!route) return { state: "not-available" };
  let response;
  try {
    response = await fetch(route, { credentials: "omit", cache: "no-store" });
  } catch {
    return { state: "unreachable" };
  }
  try {
    return await response.json();
  } catch {
    return { state: "unreachable" };
  }
}

async function main() {
  const root = document.getElementById("viewer-root");
  if (!root) return;
  const { publicationId, key } = parseViewerAppLocation(location.pathname, location.hash);
  const slug = (location.hostname.split(".")[0] ?? "").startsWith("pages-")
    ? location.hostname.split(".")[0].slice("pages-".length)
    : null;
  if (!publicationId) return showStatus(root, "Nothing is published here.");
  if (!key) return showStatus(root, "This link is incomplete — it is missing its key. Ask the person who shared it for a fresh link.");

  const entryCall = { kind: "entry" };
  const first = await fetchViewerAppResult(publicationId, entryCall);
  const firstState = first && typeof first === "object" ? first.state : null;
  if (firstState === "unreachable") return showStatus(root, "This app could not be reached. Try again later.");
  const message = stateMessage(firstState, slug);
  if (message) return showStatus(root, message);
  if (firstState !== "live" || !first.envelope || typeof first.envelope !== "object") {
    return showStatus(root, "This app could not be reached. Try again later.");
  }

  let entry;
  try {
    entry = await decryptViewerAppPayload({ key, publicationId, call: entryCall, envelope: first.envelope });
  } catch {
    return showStatus(root, "This link can't open this app. Ask the person who shared it for a fresh link.");
  }
  if (!entry.ok || !entry.result || entry.result.kind !== "entry") {
    return showStatus(root, "This app isn't available right now.");
  }

  const entryHtml = new TextDecoder().decode(base64UrlToBytes(entry.result.bytes));
  const frame = document.createElement("iframe");
  frame.className = "viewer-app-frame";
  // No allow-same-origin: the app document gets an opaque origin, no
  // storage, no cookies, and no reach back into this shell or its key.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = "Shared app";
  const documentBlob = new Blob([composeViewerAppDocument(entryHtml)], { type: "text/html" });
  frame.src = URL.createObjectURL(documentBlob);
  root.replaceChildren(frame);

  // The shell-side broker: bounded concurrent reads on the app's behalf.
  // The desktop's viewer adapter is the authority on what a call may reach;
  // this listener only relays typed results and typed refusals.
  let inFlight = 0;
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== callMessageType || typeof data.callId !== "number") return;
    const respond = (payload) => {
      frame.contentWindow?.postMessage({ type: resultMessageType, callId: data.callId, ...payload }, "*");
    };
    if (inFlight >= maximumConcurrentAppCalls) {
      respond({ ok: false, message: "Too many app calls are in flight. Try again." });
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        const result = await fetchViewerAppResult(publicationId, data.call);
        const state = result && typeof result === "object" ? result.state : null;
        if (state !== "live" || !result.envelope) {
          respond({ ok: false, message: stateMessage(state, slug) ?? "This app could not be reached. Try again later." });
          return;
        }
        const payload = await decryptViewerAppPayload({ key, publicationId, call: data.call, envelope: result.envelope });
        if (!payload.ok) {
          respond({ ok: false, message: typeof payload.message === "string" ? payload.message : "This call is not viewer-reachable." });
          return;
        }
        respond({ ok: true, result: payload.result });
      } catch {
        respond({ ok: false, message: "This call could not be completed." });
      } finally {
        inFlight -= 1;
      }
    })();
  });
}

if (typeof document !== "undefined") void main();
