// The viewer shell for "pages your fold serves" (docs/fold-publishing.md,
// rung 2). It runs on the isolated pages-<slug> origin, holds no cookies and
// writes no storage, and reads exactly one thing: this page's typed state
// from /api/viewer/pages/<publicationId>. The decryption key rides only in
// the URL fragment and never leaves the browser; the bridge relays signed
// AES-GCM ciphertext it cannot read. Rendered documents are inert — the
// origin's CSP allows no inline or remote script, and PDF and image bytes
// render from local blob: URLs.

const envelopeType = "work-fold.viewer-page.v1";
const maximumPayloadBytes = 2 * 1024 * 1024;

/** Publication id and fragment key from one share link, or nulls. */
export function parseViewerLocation(pathname, hash) {
  const path = /^\/p\/([A-Za-z0-9._:-]{1,128})$/.exec(String(pathname ?? ""));
  const fragment = String(hash ?? "").replace(/^#/, "");
  return {
    publicationId: path ? path[1] : null,
    key: /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null,
  };
}

/**
 * The additional authenticated data both ends bind: the envelope type, the
 * publication, the rendered-content digest, and the serve timestamp. The
 * desktop encrypts with exactly this string; a payload that authenticates
 * under the link's key came from the desktop that holds it.
 */
export function viewerPageAad(publicationId, contentDigest, servedAt) {
  return JSON.stringify([envelopeType, publicationId, contentDigest, servedAt]);
}

/** The slug whose desktop serves this viewer origin, from a pages-<slug> host. */
export function viewerSlugFromHost(hostname) {
  const label = String(hostname ?? "").split(".")[0] ?? "";
  return label.startsWith("pages-") ? label.slice("pages-".length) : null;
}

export function base64UrlToBytes(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function decryptViewerPage({ key, publicationId, contentDigest, timestamp, iv, ciphertext }) {
  const cryptoKey = await crypto.subtle.importKey("raw", base64UrlToBytes(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(iv),
      additionalData: new TextEncoder().encode(viewerPageAad(publicationId, contentDigest, timestamp)),
    },
    cryptoKey,
    base64UrlToBytes(ciphertext),
  );
  if (plaintext.byteLength > maximumPayloadBytes) throw new Error("Page payload is too large.");
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload || typeof payload !== "object" || payload.v !== 1
    || typeof payload.mediaType !== "string" || typeof payload.body !== "string") {
    throw new Error("Page payload is invalid.");
  }
  return payload;
}

function showStatus(root, text) {
  root.replaceChildren();
  const status = document.createElement("p");
  status.className = "viewer-status";
  status.textContent = text;
  root.append(status);
}

function showBanner(text) {
  const banner = document.getElementById("viewer-banner");
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = false;
}

function renderPayload(root, payload) {
  if (typeof payload.title === "string" && payload.title.trim()) document.title = payload.title.trim();
  root.replaceChildren();
  if (payload.mediaType === "text/html") {
    const article = document.createElement("article");
    // Desktop-rendered, escape-first HTML for the closed Markdown/plain-text
    // set. The origin's CSP leaves any markup inert regardless.
    article.innerHTML = payload.body;
    root.append(article);
    return;
  }
  if (payload.mediaType === "image/png" || payload.mediaType === "image/jpeg") {
    const image = document.createElement("img");
    image.src = URL.createObjectURL(new Blob([base64UrlToBytes(payload.body)], { type: payload.mediaType }));
    image.alt = typeof payload.title === "string" ? payload.title : "Shared image";
    root.append(image);
    return;
  }
  if (payload.mediaType === "application/pdf") {
    const frame = document.createElement("iframe");
    frame.className = "viewer-pdf";
    frame.src = URL.createObjectURL(new Blob([base64UrlToBytes(payload.body)], { type: "application/pdf" }));
    frame.title = typeof payload.title === "string" ? payload.title : "Shared document";
    root.append(frame);
    return;
  }
  throw new Error("Page media type is not supported.");
}

async function main() {
  const root = document.getElementById("viewer-root");
  if (!root) return;
  const { publicationId, key } = parseViewerLocation(location.pathname, location.hash);
  if (!publicationId) return showStatus(root, "Nothing is published here.");
  if (!key) return showStatus(root, "This link is incomplete — it is missing its key. Ask the person who shared it for a fresh link.");

  let result;
  try {
    const response = await fetch(`/api/viewer/pages/${publicationId}`, { credentials: "omit", cache: "no-store" });
    result = await response.json();
  } catch {
    return showStatus(root, "This page could not be reached. Try again later.");
  }
  const state = result && typeof result === "object" ? result.state : null;
  const slug = viewerSlugFromHost(location.hostname);
  if (state === "nothing-here") return showStatus(root, "Nothing is published here.");
  if (state === "asleep") {
    return showStatus(root, `This page is served by ${slug ?? "its owner"}'s work-fold desktop, which is asleep right now. Try again later.`);
  }
  if (state === "resting") return showStatus(root, "This page has had a lot of visitors today. Try again later.");
  if (state === "not-available") return showStatus(root, "This page isn't available right now.");

  try {
    if (state === "live" && result.envelope && typeof result.envelope === "object") {
      const header = result.envelope.header ?? {};
      const payload = await decryptViewerPage({
        key,
        publicationId,
        contentDigest: header.contentDigest,
        timestamp: header.servedAt,
        iv: result.envelope.iv,
        ciphertext: result.envelope.ciphertext,
      });
      return renderPayload(root, payload);
    }
    if (state === "as-of" && result.page && typeof result.page === "object") {
      const payload = await decryptViewerPage({
        key,
        publicationId,
        contentDigest: result.page.contentDigest,
        timestamp: result.page.capturedAt,
        iv: result.page.iv,
        ciphertext: result.page.ciphertext,
      });
      const capturedAt = new Date(result.page.capturedAt);
      showBanner(`As of ${Number.isNaN(capturedAt.getTime()) ? result.page.capturedAt : capturedAt.toLocaleString()} — the desktop serving this page is asleep.`);
      return renderPayload(root, payload);
    }
  } catch {
    return showStatus(root, "This link can't open this page. Ask the person who shared it for a fresh link.");
  }
  return showStatus(root, "This page could not be reached. Try again later.");
}

if (typeof document !== "undefined") void main();
