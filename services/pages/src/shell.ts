/**
 * The trusted shell visitors load at `/p/<pageId>` (docs/pages.md, "Public
 * routes"). It is plain HTML plus one small script served from this service,
 * and it runs a page exactly the way the desktop's Preview does
 * (web-local/src/lib/page-frame-host.ts): it embeds the sandbox intermediary
 * (`/page-frame.html`, src/local/pages/frame/page-frame-assets.ts) with
 * `sandbox="allow-scripts allow-forms"` and never `allow-same-origin`, hands
 * it the page over a fresh per-view channel, accepts messages only from that
 * exact intermediary window carrying that channel, lets through only the
 * documented calls with their documented fields, and sends them to
 * `POST /p/<pageId>/call`. The page is never the owner here. Web and email
 * links open in a new tab with `noopener`.
 *
 * The script is a plain string rather than compiled code, so no build step
 * rewrites it; tests run it in JSDOM.
 */
import { PAGE_FRAME_CONTENT_SECURITY_POLICY } from "../../../src/local/pages/frame/page-frame-assets.js";

export const PAGE_SHELL_SCRIPT_PATH = "/page-shell.js";
export const PAGE_SHELL_STYLE_PATH = "/page-shell.css";

/**
 * The shell's policy: its own script and stylesheet, its own API, and the
 * intermediary frame; nothing else, and it can't be framed.
 */
export const PAGE_SHELL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "img-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The intermediary's policy online: the desktop's, plus CSP's `webrtc
 * 'block'` for the WebRTC gap docs/pages.md names. The blob page document
 * inherits it. Browsers that implement the directive enforce it; Chrome
 * (checked 2026-11-05) reports it as unrecognized and ignores it, so there
 * the gap stays open.
 */
export const HOSTED_PAGE_FRAME_CONTENT_SECURITY_POLICY = `${PAGE_FRAME_CONTENT_SECURITY_POLICY}; webrtc 'block'`;

/** Features no page or shell uses; the frames inherit the refusal. */
export const PAGE_SHELL_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "display-capture=()",
  "publickey-credentials-get=()",
].join(", ");

export const NOT_PUBLISHED_TEXT = "Nothing is published here.";

/** One page for every unknown, malformed, or unpublished id, byte for byte. */
export const NOT_PUBLISHED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Nothing is published here</title>
<link rel="stylesheet" href="${PAGE_SHELL_STYLE_PATH}">
</head>
<body>
<main class="notice">
<h1>${NOT_PUBLISHED_TEXT}</h1>
<p>Check the link, or ask the person who shared it.</p>
</main>
</body>
</html>
`;

export function pageShellHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${PAGE_SHELL_STYLE_PATH}">
<script src="${PAGE_SHELL_SCRIPT_PATH}" defer></script>
</head>
<body>
<main id="page" class="page"></main>
<div id="notice" class="notice" role="alert" hidden><h1></h1><p></p><button type="button">Reload</button></div>
</body>
</html>
`;
}

export const PAGE_SHELL_CSS = `html,body{margin:0;width:100%;height:100%;background:#fff;color:#1d1d1f;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{position:fixed;inset:0}
.page iframe{border:0;width:100%;height:100%;display:block;background:#fff}
.notice{position:fixed;inset:0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;text-align:center;background:#fff}
.notice[hidden]{display:none}
.notice h1{margin:0 0 8px;font-size:1.25rem;font-weight:600}
.notice p{margin:0 0 16px;color:#5f5f66;max-width:32rem}
.notice p:empty{display:none}
.notice button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #c7c7cc;background:#f5f5f7;color:inherit;cursor:pointer}
.notice button[hidden]{display:none}
@media (prefers-color-scheme: dark){html,body,.notice{background:#161618;color:#f2f2f4}.notice p{color:#a1a1a8}.notice button{background:#26262a;border-color:#3a3a40}}
`;

/**
 * The shell's host script. Message protocol and rules:
 * src/local/pages/frame/page-frame-assets.ts and
 * web-local/src/lib/page-frame-host.ts.
 */
export const PAGE_SHELL_SCRIPT = String.raw`// The page shell (docs/pages.md, "Public routes").
(function () {
  "use strict";
  var message = {
    ready: "work-fold.page.ready",
    init: "work-fold.page.init",
    loaded: "work-fold.page.loaded",
    call: "work-fold.page.call",
    result: "work-fold.page.result",
    link: "work-fold.page.link",
    changed: "work-fold.page.changed",
    navigated: "work-fold.page.navigated"
  };
  var callOps = ["add", "mine", "list", "count", "update", "remove"];
  var errorCodes = ["NOT_ALLOWED", "INVALID", "DUPLICATE", "LIMIT_REACHED", "NOT_FOUND", "TOO_LARGE", "UNAVAILABLE"];
  var mutatingOps = ["add", "update", "remove"];
  var maximumCallsInFlight = 8;
  var maximumCallCharacters = 8 * 1024 * 1024;
  var loadTimeoutMs = 15000;
  var hasOwn = Object.prototype.hasOwnProperty;
  var main = document.getElementById("page");
  var notice = document.getElementById("notice");
  var matched = /^\/p\/(pg_[a-z2-7]{26})\/?$/.exec(location.pathname);

  function show(heading, text, reload) {
    if (!notice) return;
    notice.querySelector("h1").textContent = heading;
    notice.querySelector("p").textContent = text;
    notice.querySelector("button").hidden = !reload;
    notice.hidden = false;
  }
  function hide() { if (notice) notice.hidden = true; }
  if (notice) notice.querySelector("button").addEventListener("click", function () { location.reload(); });
  if (!matched || !main) { show("Nothing is published here.", "", false); return; }
  var base = "/p/" + matched[1];

  function failure(code, text, field) {
    var error = { code: errorCodes.indexOf(code) >= 0 ? code : "UNAVAILABLE", message: text };
    if (typeof field === "string" && field) error.field = field;
    return error;
  }

  // The same mapping the desktop uses when a refusal has no known code.
  function refusal(body, status) {
    var record = body && typeof body === "object" ? body : {};
    var nested = record.error && typeof record.error === "object" ? record.error : {};
    var code = typeof nested.code === "string" ? nested.code : typeof record.code === "string" ? record.code : "";
    var text = [nested.message, typeof record.error === "string" ? record.error : undefined, record.message]
      .filter(function (value) { return typeof value === "string" && value.length > 0; })[0];
    var field = [nested.field, record.field].filter(function (value) { return typeof value === "string" && value.length > 0; })[0];
    if (errorCodes.indexOf(code) < 0) {
      code = status === 403 ? "NOT_ALLOWED" : status === 404 ? "NOT_FOUND" : status === 409 ? "DUPLICATE"
        : status === 413 ? "TOO_LARGE" : status >= 400 && status < 500 && status !== 429 ? "INVALID" : "UNAVAILABLE";
    }
    return failure(code, text || "Something went wrong. Try again.", field);
  }

  // Only the documented calls, with their documented fields, leave the shell.
  function callFrom(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.op !== "string" || callOps.indexOf(value.op) < 0) return null;
    if (typeof value.table !== "string" || !value.table || value.table.length > 64) return null;
    var call = { op: value.op, table: value.table };
    ["values", "id", "where", "options"].forEach(function (key) { if (value[key] !== undefined) call[key] = value[key]; });
    if (value.requestId !== undefined) {
      if (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128) return null;
      call.requestId = value.requestId;
    }
    return call;
  }

  // Web and email addresses only.
  function externalLink(value) {
    if (typeof value !== "string" || value.length > 8192) return null;
    try {
      var url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null;
    } catch (error) {
      return null;
    }
  }

  function newChannel() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) { return (byte + 256).toString(16).slice(1); }).join("");
  }

  // The first call makes this browser's visitor cookie; calls made before it
  // answers wait for it, so one browser is always one visitor.
  var firstCall = null;
  function send(call) {
    var run = function () {
      return fetch(base + "/call", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ call: call })
      }).then(function (response) {
        return response.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (error) { body = null; }
          if (response.ok && body && typeof body === "object" && hasOwn.call(body, "result")) return body.result;
          throw refusal(body, response.status);
        });
      }, function () {
        throw failure("UNAVAILABLE", "The page couldn't be reached. Check your connection and try again.");
      });
    };
    if (!firstCall) {
      firstCall = run();
      return firstCall;
    }
    return firstCall.then(run, run);
  }

  function mount(page) {
    var channel = newChannel();
    var html = typeof page.html === "string" ? page.html : "";
    var title = typeof page.title === "string" && page.title ? page.title : document.title;
    var tables = page.tables && typeof page.tables === "object" && !Array.isArray(page.tables) ? page.tables : {};
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = title;
    frame.src = "/page-frame.html";
    var loaded = false;
    var inFlight = 0;
    var timer = setTimeout(function () {
      if (!loaded) show("The page didn't start.", "Reload to try again.", true);
    }, loadTimeoutMs);

    function post(data) {
      if (!frame.contentWindow) return;
      data.channel = channel;
      frame.contentWindow.postMessage(data, "*");
    }
    function respond(callId, payload) {
      post({ type: message.result, callId: callId, ok: payload.ok, result: payload.result, error: payload.error });
    }

    window.addEventListener("message", function (event) {
      if (event.source === null || event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === message.ready) {
        // One page per view: a second ready (the intermediary reloaded) gets nothing.
        if (html === null) return;
        frame.contentWindow.postMessage({ type: message.init, channel: channel, html: html, title: title, owner: false, tables: tables }, "*");
        html = null;
        return;
      }
      if (data.channel !== channel) return;
      if (data.type === message.loaded) {
        if (!loaded) { loaded = true; clearTimeout(timer); hide(); }
        return;
      }
      if (data.type === message.navigated) {
        show("The page tried to leave.", "A page stays on one screen; its web links open in a new tab. Reload to show it again.", true);
        return;
      }
      if (data.type === message.link) {
        var href = externalLink(data.href);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      if (data.type !== message.call) return;
      var callId = data.callId;
      if (typeof callId !== "number" || !Number.isSafeInteger(callId) || callId < 1) return;
      var call = callFrom(data.call);
      if (!call) return respond(callId, { ok: false, error: failure("INVALID", "That isn't something a page can ask for.") });
      var size = Infinity;
      try { size = JSON.stringify(call).length; } catch (error) { size = Infinity; }
      if (size > maximumCallCharacters) return respond(callId, { ok: false, error: failure("TOO_LARGE", "That's too much to save at once.") });
      if (inFlight >= maximumCallsInFlight) return respond(callId, { ok: false, error: failure("UNAVAILABLE", "The page is busy. Try again in a moment.") });
      inFlight++;
      send(call).then(function (result) {
        respond(callId, { ok: true, result: result === undefined ? null : result });
        if (mutatingOps.indexOf(call.op) >= 0) post({ type: message.changed, table: call.table });
      }, function (error) {
        respond(callId, { ok: false, error: error && typeof error === "object" && typeof error.code === "string" ? error : failure("UNAVAILABLE", "Something went wrong. Try again.") });
      }).then(function () { inFlight--; }, function () { inFlight--; });
    });
    main.appendChild(frame);
  }

  fetch(base + "/document", { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (response) {
    if (response.status === 404) { show("Nothing is published here.", "", false); return null; }
    if (!response.ok) throw new Error("The page couldn't load.");
    return response.json();
  }).then(function (page) {
    if (page && typeof page === "object") mount(page);
  }, function () {
    show("This page couldn't load.", "Check your connection, then reload to try again.", true);
  });
})();
`;

export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}
