/**
 * The page sandbox intermediary (see docs/pages.md, "How a page runs").
 * Served by the local API at /page-frame.html and /page-frame.js.
 *
 * The page tab embeds /page-frame.html in an iframe with
 * `sandbox="allow-scripts allow-forms"` (never `allow-same-origin`), so the
 * intermediary has an opaque origin. The host hands it the assembled page
 * over a fresh per-view channel; the intermediary prepends a stricter
 * document policy and the page runtime, then loads the result as a blob
 * child with the same sandbox. The child inherits the intermediary's response
 * policy and adds its own, so page code is held to
 * PAGE_DOCUMENT_CONTENT_SECURITY_POLICY: no network, no forms leaving the
 * page, no frames, no navigation away.
 *
 * Messages. The host accepts only its exact intermediary window and the
 * channel; the intermediary accepts only its exact child window, or its
 * parent with the channel; the runtime accepts only its parent.
 *
 *   intermediary → host   work-fold.page.ready                     (before a channel exists)
 *   host → intermediary   work-fold.page.init  { channel, html, title, owner, tables }
 *   child → host          work-fold.page.loaded                    (+ channel on the way)
 *   child → host          work-fold.page.call  { callId, call }    (+ channel)
 *   child → host          work-fold.page.link  { href }            (+ channel)
 *   host → child          work-fold.page.result { callId, ok, result | error }  (channel checked, then dropped)
 *   host → child          work-fold.page.changed { table }         (channel checked, then dropped)
 *   intermediary → host   work-fold.page.navigated                 (the page tried to leave)
 *
 * The scripts are plain strings rather than stringified functions, so no
 * build step can rewrite them; tests run them in JSDOM.
 */

export const PAGE_FRAME_MESSAGE = {
  ready: "work-fold.page.ready",
  init: "work-fold.page.init",
  loaded: "work-fold.page.loaded",
  call: "work-fold.page.call",
  result: "work-fold.page.result",
  link: "work-fold.page.link",
  changed: "work-fold.page.changed",
  navigated: "work-fold.page.navigated",
} as const;

/** What page code itself runs under: a meta policy at the top of the blob document. */
export const PAGE_DOCUMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The response policy the intermediary is served with; blob page documents
 * inherit it. It adds only what the intermediary itself needs: its own script
 * (`'self'`, which a sandboxed document matches against its URL's origin) and
 * the blob child (`frame-src blob:`). That `frame-src` also confines the
 * child: navigating it to any non-blob address is refused and reported.
 */
export const PAGE_FRAME_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts allow-forms",
].join("; ");

export const PAGE_FRAME_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%;display:block;background:#fff}</style><script src="/page-frame.js" defer></script></head><body></body></html>\n';

/**
 * `window.workFoldPage`, the form helper, and link handling (docs/pages.md,
 * "What a page's code can use"). The intermediary replaces the placeholder
 * with this view's configuration: `{ owner, tables: { table: { column: type } } }`.
 */
export const PAGE_RUNTIME_SCRIPT = String.raw`(function () {
  "use strict";
  var config = __WORK_FOLD_PAGE_CONFIG__;
  var host = window.parent;
  var hasOwn = Object.prototype.hasOwnProperty;
  var pending = new Map();
  var listeners = new Set();
  var nextCallId = 0;
  var maximumPending = 32;
  var callTimeoutMs = 30000;
  var post = function (message) { host.postMessage(message, "*"); };

  function failure(code, message, field) {
    var error = { code: code, message: message };
    if (typeof field === "string" && field) error.field = field;
    return error;
  }

  function plain(value, label) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { throw failure("INVALID", "The " + label + " must be plain data, such as text, numbers, and true or false."); }
  }

  function requestId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === "function") window.crypto.getRandomValues(bytes);
    else for (var index = 0; index < 16; index++) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (byte) { return (byte + 256).toString(16).slice(1); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function call(op, table, extra) {
    return new Promise(function (resolve, reject) {
      if (typeof table !== "string" || !table) return reject(failure("INVALID", "Name the table, for example \"rsvps\"."));
      if (pending.size >= maximumPending) return reject(failure("UNAVAILABLE", "Too many requests at once. Try again in a moment."));
      var request = { op: op, table: table };
      try {
        for (var key in extra) if (hasOwn.call(extra, key) && extra[key] !== undefined) request[key] = plain(extra[key], key);
      } catch (error) { return reject(error); }
      var callId = ++nextCallId;
      var timer = setTimeout(function () {
        pending.delete(callId);
        reject(failure("UNAVAILABLE", "The page couldn't reach work-fold. Try again."));
      }, callTimeoutMs);
      pending.set(callId, { resolve: resolve, reject: reject, timer: timer });
      post({ type: "work-fold.page.call", callId: callId, call: request });
    });
  }

  function notify(detail) {
    listeners.forEach(function (listener) {
      try { listener(detail); } catch (error) { setTimeout(function () { throw error; }, 0); }
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "work-fold.page.result") {
      var waiting = pending.get(data.callId);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(data.callId);
      if (data.ok === true) waiting.resolve(data.result);
      else {
        var error = data.error && typeof data.error === "object" ? data.error : {};
        waiting.reject(failure(typeof error.code === "string" ? error.code : "UNAVAILABLE",
          typeof error.message === "string" && error.message ? error.message : "Something went wrong. Try again.", error.field));
      }
    } else if (data.type === "work-fold.page.changed") {
      notify({ table: typeof data.table === "string" ? data.table : null });
    }
  }, true);

  var api = {
    add: function (table, values, options) {
      var id = options && typeof options.requestId === "string" && options.requestId ? options.requestId : requestId();
      return call("add", table, { values: values == null ? {} : values, requestId: id });
    },
    mine: function (table) { return call("mine", table, {}); },
    list: function (table, options) { return call("list", table, { options: options == null ? {} : options }); },
    count: function (table, where) { return call("count", table, { where: where == null ? undefined : where }); },
    update: function (table, id, values) { return call("update", table, { id: id, values: values == null ? {} : values }); },
    remove: function (table, id) { return call("remove", table, { id: id }); },
    isOwner: function () { return Promise.resolve(config.owner === true); },
    onChange: function (callback) {
      if (typeof callback !== "function") throw new TypeError("workFoldPage.onChange needs a function.");
      var listener = function (detail) { callback(detail); };
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    },
  };
  Object.defineProperty(window, "workFoldPage", { value: Object.freeze(api), enumerable: true, configurable: false, writable: false });

  // The form helper: a form with data-page-table saves itself.
  var formRequests = new WeakMap();
  var tables = config.tables && typeof config.tables === "object" ? config.tables : {};

  function convert(value, type) {
    if (type === "number") {
      var number = Number(value.trim());
      return value.trim() !== "" && isFinite(number) ? number : value;
    }
    if (type === "boolean") {
      var word = value.trim().toLowerCase();
      if (word === "true" || word === "yes" || word === "on" || word === "1") return true;
      if (word === "false" || word === "no" || word === "off" || word === "0") return false;
    }
    return value;
  }

  function collect(form, table) {
    var columns = hasOwn.call(tables, table) && tables[table] && typeof tables[table] === "object" ? tables[table] : null;
    var values = {};
    Array.prototype.forEach.call(form.elements, function (element) {
      var name = element.name;
      if (!name || typeof name !== "string") return;
      if (typeof element.matches === "function" && element.matches(":disabled")) return;
      var tag = element.tagName;
      var type = String(element.type || "").toLowerCase();
      if (tag === "BUTTON" || tag === "FIELDSET" || tag === "OUTPUT" || tag === "OBJECT") return;
      if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file") return;
      // Fields that are not columns of the table stay with the page.
      if (columns && !hasOwn.call(columns, name)) return;
      var declared = columns ? columns[name] : null;
      if (type === "checkbox") {
        values[name] = values[name] === true || element.checked === true;
        return;
      }
      if (type === "radio") {
        if (element.checked) values[name] = convert(String(element.value), declared);
        return;
      }
      var raw = tag === "SELECT" && element.multiple
        ? (element.selectedOptions && element.selectedOptions[0] ? element.selectedOptions[0].value : "")
        : element.value;
      if (typeof raw !== "string" || raw.trim() === "") return;
      if (type === "number" || type === "range") {
        var number = Number(raw);
        values[name] = isFinite(number) ? number : raw;
        return;
      }
      values[name] = convert(raw, declared);
    });
    return values;
  }

  function submitButtons(form) {
    return Array.prototype.filter.call(form.elements, function (element) {
      var type = String(element.type || "").toLowerCase();
      return (element.tagName === "BUTTON" && type === "submit") || (element.tagName === "INPUT" && (type === "submit" || type === "image"));
    });
  }

  function setMessage(form, text) {
    Array.prototype.forEach.call(form.querySelectorAll("[data-page-message]"), function (element) { element.textContent = text; });
  }

  function dispatch(form, type, detail) {
    form.dispatchEvent(new CustomEvent(type, { detail: detail, bubbles: true }));
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || form.tagName !== "FORM" || event.defaultPrevented) return;
    var table = form.getAttribute("data-page-table");
    if (!table) return;
    event.preventDefault();
    if (form.getAttribute("data-page-state") === "sending") return;
    var values = collect(form, table);
    // One request id until the entry is saved, so sending again after a lost
    // answer returns the entry already made instead of adding another.
    var id = formRequests.get(form) || requestId();
    formRequests.set(form, id);
    var buttons = submitButtons(form).filter(function (button) { return !button.disabled; });
    buttons.forEach(function (button) { button.disabled = true; });
    setMessage(form, "");
    form.setAttribute("data-page-state", "sending");
    form.setAttribute("aria-busy", "true");
    var settle = function () {
      buttons.forEach(function (button) { button.disabled = false; });
      form.removeAttribute("aria-busy");
    };
    api.add(table, values, { requestId: id }).then(function (row) {
      formRequests.delete(form);
      settle();
      form.reset();
      setMessage(form, "");
      form.setAttribute("data-page-state", "sent");
      dispatch(form, "page:sent", row);
    }, function (error) {
      if (!error || error.code !== "UNAVAILABLE") formRequests.delete(form);
      settle();
      setMessage(form, error && typeof error.message === "string" && error.message ? error.message : "Something went wrong. Try again.");
      form.setAttribute("data-page-state", "error");
      dispatch(form, "page:error", error);
    });
  });

  // Links: a page never navigates; web and email links open outside it.
  function linkFor(node) {
    while (node && node !== document) {
      var name = String(node.nodeName || "").toUpperCase();
      if (name === "A" || name === "AREA") return node.hasAttribute("href") ? node : null;
      node = node.parentNode;
    }
    return null;
  }

  function followLink(event) {
    if (event.defaultPrevented) return;
    if (event.type === "auxclick" && event.button !== 1) return;
    var link = linkFor(event.target);
    if (!link) return;
    var href = String(link.getAttribute("href") || "").trim();
    if (href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
    event.preventDefault();
    var url;
    try { url = new URL(href); } catch (error) { return; }
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") post({ type: "work-fold.page.link", href: url.href });
  }
  document.addEventListener("click", followLink);
  document.addEventListener("auxclick", followLink);

  function loaded() { post({ type: "work-fold.page.loaded" }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loaded, { once: true });
  else loaded();
})();`;

const PAGE_FRAME_SCRIPT_BODY = String.raw`(function () {
  "use strict";
  var maximumHtmlLength = 48 * 1024 * 1024;
  var frame = null;
  var channel = null;
  var objectUrl = null;
  var send = function (message) { parent.postMessage(message, "*"); };

  function scriptJson(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  }

  // Only { table: { column: type } } with declared-looking names and type words.
  function columnTypes(value) {
    var tables = {};
    if (!value || typeof value !== "object") return tables;
    Object.keys(value).slice(0, 64).forEach(function (table) {
      var columns = value[table];
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(table) || !columns || typeof columns !== "object") return;
      var types = {};
      Object.keys(columns).slice(0, 128).forEach(function (column) {
        if (/^[a-z][a-z0-9_]{0,40}$/.test(column) && typeof columns[column] === "string" && /^[a-z-]{1,20}$/.test(columns[column])) types[column] = columns[column];
      });
      tables[table] = types;
    });
    return tables;
  }

  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (event.source === parent && data.type === "work-fold.page.init" && !frame) {
      if (typeof data.channel !== "string" || !data.channel || data.channel.length > 128) return;
      if (typeof data.html !== "string" || data.html.length > maximumHtmlLength) return;
      channel = data.channel;
      var config = { owner: data.owner === true, tables: columnTypes(data.tables) };
      var runtime = PAGE_RUNTIME.replace("__WORK_FOLD_PAGE_CONFIG__", function () { return scriptJson(config); });
      var doctype = (data.html.match(/^\s*<!doctype[^>]*>/i) || [""])[0];
      var source = doctype
        + '<meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">'
        + "<script>" + runtime + "</" + "script>"
        + data.html.slice(doctype.length);
      frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = typeof data.title === "string" && data.title ? data.title.slice(0, 200) : "Page";
      objectUrl = URL.createObjectURL(new Blob([source], { type: "text/html;charset=utf-8" }));
      frame.src = objectUrl;
      document.body.appendChild(frame);
      return;
    }
    if (!frame) return;
    if (event.source === frame.contentWindow) {
      if (data.type === "work-fold.page.loaded") send({ type: data.type, channel: channel });
      else if (data.type === "work-fold.page.call" && typeof data.callId === "number" && Number.isSafeInteger(data.callId)) send({ type: data.type, channel: channel, callId: data.callId, call: data.call });
      else if (data.type === "work-fold.page.link" && typeof data.href === "string" && data.href.length <= 8192) send({ type: data.type, channel: channel, href: data.href });
      return;
    }
    if (event.source === parent && data.channel === channel && frame.contentWindow) {
      if (data.type === "work-fold.page.result") {
        frame.contentWindow.postMessage({ type: data.type, callId: data.callId, ok: data.ok === true, result: data.result, error: data.error }, "*");
      } else if (data.type === "work-fold.page.changed") {
        frame.contentWindow.postMessage({ type: data.type, table: typeof data.table === "string" ? data.table : null }, "*");
      }
    }
  });
  addEventListener("pagehide", function () { if (objectUrl) URL.revokeObjectURL(objectUrl); });
  addEventListener("securitypolicyviolation", function (event) {
    var directive = String(event.effectiveDirective || event.violatedDirective || "");
    if (frame && directive.indexOf("frame-src") === 0) send({ type: "work-fold.page.navigated", channel: channel });
  });
  send({ type: "work-fold.page.ready" });
})();`;

export const PAGE_FRAME_SCRIPT = "// The page sandbox intermediary (docs/pages.md, \"How a page runs\").\n"
  + `var PAGE_RUNTIME = ${JSON.stringify(PAGE_RUNTIME_SCRIPT)};\n`
  + `var PAGE_POLICY = ${JSON.stringify(PAGE_DOCUMENT_CONTENT_SECURITY_POLICY)};\n`
  + `${PAGE_FRAME_SCRIPT_BODY}\n`;
