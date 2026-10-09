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

/**
 * The sandbox for a person-authored HTML page (stripped desktop-side): no
 * allow-scripts, no allow-same-origin, no allow-forms. The document gets an
 * opaque origin with no reach back into this shell or its key; the only
 * power is that a link may open a new window.
 */
export const viewerDocumentSandbox = "allow-popups allow-popups-to-escape-sandbox";

// The shell needs same-origin scripts, styles, and its encrypted-page API.
// A decrypted document needs none of those permissions: in particular,
// inherited `style-src 'self'` would let CSS @import disclose plaintext in
// a request to the relay. This additional policy precedes all page content.
const viewerDocumentPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

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

export function renderPayload(root, payload) {
  if (typeof payload.title === "string" && payload.title.trim()) document.title = payload.title.trim();
  root.replaceChildren();
  if (payload.mediaType === "text/html" && payload.document === true) {
    // A whole person-authored document, stripped desktop-side, placed in a
    // script-less sandboxed srcdoc frame. WebKit does not render the same
    // opaque sandboxed document through a blob: URL under this shell's CSP.
    // srcdoc keeps the isolation and inherits this origin's CSP, with a
    // stricter document policy that blocks every load
    // except embedded data images while preserving authored inline styles.
    const frame = document.createElement("iframe");
    frame.className = "viewer-document";
    frame.setAttribute("sandbox", viewerDocumentSandbox);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Shared page";
    const documentPrefix = `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${viewerDocumentPolicy}">`;
    frame.srcdoc = documentPrefix + payload.body;
    root.classList.add("viewer-root-document");
    root.append(frame);
    return;
  }
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
  // Inert local previews use the real viewer shell, without relay requests.
  if (location.hostname.endsWith(".localhost") && new URL(location.href).searchParams.get("fixture") === "1") {
    const pages = {
      "fixture-quarterly": ["Quarterly overview", "<h1>Quarterly overview</h1><p>October 2026</p><h2>A strong quarter, with a few loose ends</h2><p>Revenue grew 12% this quarter. Returning customers accounted for most of the increase, while the new ordering flow reduced support requests.</p><h2>What we learned</h2><ul><li>Keep the purchase-order reference visible on every invoice.</li><li>Give returning customers a shorter checkout.</li><li>Set aside time each week to reconcile open balances.</li></ul><h2>Next quarter</h2><p>Focus on making the everyday experience easier: clearer invoices, faster ordering, and a reliable monthly close.</p>"],
      "fixture-trip": ["Montréal weekend", "<h1>A weekend in Montréal</h1><p>A relaxed plan for two days in the city.</p><h2>Saturday</h2><p>Start with coffee in Mile End, wander through the neighbourhood, and leave the afternoon open for the market.</p><h2>Sunday</h2><p>Walk up Mount Royal before lunch. Spend the afternoon in Old Montréal, with time to stop wherever looks interesting.</p><h2>Keep it easy</h2><p>One reservation each day is enough. The best part of this trip is having room to explore.</p>"],
      "fixture-reading": ["Reading notes", "<h1>Reading notes</h1><p>Passages and ideas to return to.</p><h2>On paying attention</h2><p>A useful practice: write down one thing you noticed today that you would usually pass by.</p><h2>Questions for next time</h2><ul><li>What makes a place feel familiar?</li><li>Which details change when you slow down?</li><li>What would you like to remember a year from now?</li></ul>"],
    };
    const page = pages[publicationId];
    if (!page) return showStatus(root, "Nothing is published here.");
    return renderPayload(root, { title: page[0], mediaType: "text/html", body: page[1] });
  }
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
    return showStatus(root, `This page is served by ${slug ?? "its owner"}'s work-fold desktop, which is offline right now. Try again later.`);
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
      showBanner(`As of ${Number.isNaN(capturedAt.getTime()) ? result.page.capturedAt : capturedAt.toLocaleString()} — the desktop serving this page is offline.`);
      return renderPayload(root, payload);
    }
  } catch {
    return showStatus(root, "This link can't open this page. Ask the person who shared it for a fresh link.");
  }
  return showStatus(root, "This page could not be reached. Try again later.");
}

if (typeof document !== "undefined") void main();
