const bridge = globalThis.workFoldRestrictedApp;
const root = document.querySelector("#app");
const automationRefreshKey = "last-automation-refresh";

const messages = [
  { id: "release", sender: "Mira Chen", subject: "Release checklist", preview: "The last two desktop checks are green…", time: "9:42", folder: "inbox", unread: true, body: "The last two desktop checks are green. I left the service smoke test assigned to you and added the updater notes to the release checklist." },
  { id: "design", sender: "Nolan", subject: "Extension host notes", preview: "The panel sizing pass looks right…", time: "8:18", folder: "inbox", unread: true, body: "The panel sizing pass looks right. Can we keep a navigator open while a detail tab is active? That would make the internal service tools much easier to use." },
  { id: "build", sender: "CI", subject: "Build #1842 passed", preview: "Windows smoke package completed…", time: "Yesterday", folder: "inbox", unread: false, body: "Windows smoke package completed successfully in 7m 12s. All required runtime assets were present." },
  { id: "draft", sender: "You", subject: "Draft: launch note", preview: "A small update to how Space apps…", time: "Mon", folder: "drafts", unread: false, body: "A small update to how Space apps work: they now get a real sandboxed interface and can open durable work tabs." },
];

let context = bridge.context.get();
let query = await bridge.storage.get("search-query").catch(() => "") || "";
let lastAutomationRefresh = await bridge.storage.get(automationRefreshKey).catch(() => null);
let lastAutomationStorageEvent = null;
bridge.context.onChanged((next) => {
  context = next;
  document.documentElement.dataset.theme = next.theme;
  render();
});
bridge.storage.onChanged((event) => {
  if (!event.reset && !event.keys.includes(automationRefreshKey)) return;
  void refreshAutomationStatus(event);
});
document.documentElement.dataset.theme = context.theme;

function render() {
  if (context.placement === "navigator") renderNavigator();
  else renderTab();
  updateAutomationStatus();
}

function renderNavigator() {
  const filtered = messages.filter((message) => message.folder === "inbox" && `${message.sender} ${message.subject} ${message.preview}`.toLowerCase().includes(query.toLowerCase()));
  root.innerHTML = `
    <section class="navigator-shell">
      <header class="navigator-header"><div><span class="eyebrow">CONNECTED INBOX</span><h1>Inbox</h1></div><button class="icon-button" data-open-compose title="Compose" aria-label="Compose">＋</button></header>
      <label class="search"><span>⌕</span><input type="search" value="${escapeAttribute(query)}" placeholder="Search mail"></label>
      <nav class="folder-list" aria-label="Mail folders">
        <button class="folder active" data-open-folder="inbox"><span>Inbox</span><strong>${messages.filter((item) => item.folder === "inbox" && item.unread).length}</strong></button>
        <button class="folder" data-open-folder="drafts"><span>Drafts</span><small>1</small></button>
        <button class="folder" data-open-service><span>Project service</span><i class="status-dot"></i></button>
      </nav>
      ${automationStatusMarkup()}
      <div class="section-heading"><span>Recent</span><button data-open-folder="inbox">View all</button></div>
      <div class="message-list">${filtered.map(messageRow).join("") || `<p class="empty">No matching messages</p>`}</div>
      <footer><button class="secondary" data-refresh>Refresh connection</button><span id="connection-state">Demo data</span></footer>
    </section>`;
  root.querySelector("input")?.addEventListener("input", (event) => { query = event.target.value; void bridge.storage.set("search-query", query); renderNavigator(); });
  wireOpenActions();
  root.querySelector("[data-refresh]")?.addEventListener("click", refreshMail);
}

function renderTab() {
  const route = new URL(context.route, "https://app.invalid");
  if (route.pathname.startsWith("/message/")) return renderMessage(route.pathname.slice("/message/".length));
  if (route.pathname === "/compose") return renderCompose();
  if (route.pathname === "/service") return renderService();
  renderInbox(route.searchParams.get("folder") || "inbox");
}

function renderInbox(folder) {
  const filtered = messages.filter((message) => message.folder === folder && `${message.sender} ${message.subject}`.toLowerCase().includes(query.toLowerCase()));
  root.innerHTML = `<section class="tab-shell"><header class="tab-header"><div><span class="eyebrow">CONNECTED INBOX</span><h1>${folder === "drafts" ? "Drafts" : "Inbox"}</h1><p>${filtered.length} messages in this Space</p></div><button class="primary" data-open-compose>Compose</button></header><div class="tab-toolbar"><label class="search"><span>⌕</span><input type="search" value="${escapeAttribute(query)}" placeholder="Filter messages"></label><button class="secondary" data-refresh>Sync</button></div>${automationStatusMarkup()}<div class="wide-message-list">${filtered.map(messageCard).join("") || `<p class="empty">Nothing here yet</p>`}</div><p id="connection-state" class="connection-state">Showing local demo data. Approve mail-api in Capabilities to connect.</p></section>`;
  root.querySelector("input")?.addEventListener("input", (event) => { query = event.target.value; void bridge.storage.set("search-query", query); renderInbox(folder); });
  wireOpenActions();
  root.querySelector("[data-refresh]")?.addEventListener("click", refreshMail);
}

function renderMessage(id) {
  const message = messages.find((item) => item.id === id);
  if (!message) {
    root.innerHTML = `<section class="tab-shell empty"><h1>Message unavailable</h1></section>`;
    return;
  }
  root.innerHTML = `<article class="message-detail"><header><div><span class="eyebrow">${escapeHtml(message.sender)}</span><h1>${escapeHtml(message.subject)}</h1><p>to you · ${escapeHtml(message.time)}</p></div><button class="secondary" data-close>Close tab</button></header><div class="message-body"><p>${escapeHtml(message.body)}</p></div><footer><button class="primary" data-reply>Reply</button><button class="secondary" data-service>Open service status</button></footer></article>`;
  root.querySelector("[data-close]")?.addEventListener("click", () => bridge.tabs.close());
  root.querySelector("[data-reply]")?.addEventListener("click", () => bridge.tabs.update({ title: `Reply: ${message.subject}`, route: "/compose", state: { replyTo: message.id } }));
  root.querySelector("[data-service]")?.addEventListener("click", openService);
}

function renderCompose() {
  const reply = messages.find((item) => item.id === context.state?.replyTo);
  root.innerHTML = `<section class="compose"><header><div><span class="eyebrow">NEW MESSAGE</span><h1>${reply ? `Reply to ${escapeHtml(reply.sender)}` : "Compose"}</h1></div><button class="secondary" data-close>Discard</button></header><form><label>To<input name="to" value="${reply ? escapeAttribute(reply.sender) : ""}" required></label><label>Subject<input name="subject" value="${reply ? escapeAttribute(`Re: ${reply.subject}`) : ""}" required></label><label class="body-field">Message<textarea name="body" required>${reply ? `\n\nOn ${reply.time}, ${reply.sender} wrote:\n${reply.body}` : ""}</textarea></label><div class="form-actions"><button class="primary" type="submit">Send through connection</button><span id="send-state">Not sent</span></div></form></section>`;
  root.querySelector("[data-close]")?.addEventListener("click", () => bridge.tabs.close());
  root.querySelector("form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = root.querySelector("#send-state");
    status.textContent = "Sending…";
    const data = Object.fromEntries(new FormData(event.target));
    try {
      await bridge.request({ destinationId: "mail-api", method: "POST", path: "/messages", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      status.textContent = "Sent";
    } catch (error) {
      status.textContent = friendlyConnectionError(error);
    }
  });
}

function renderService() {
  root.innerHTML = `<section class="service"><header><div><span class="eyebrow">LOCAL SERVICE · 127.0.0.1:4317</span><h1>Project service</h1><p>A tiny control panel for a process running beside this Space.</p></div><button class="secondary" data-close>Close</button></header><div class="metrics"><article><span>Status</span><strong id="service-status">Not checked</strong></article><article><span>Endpoint</span><strong>/health</strong></article><article><span>Transport</span><strong>Brokered HTTP</strong></article></div><div class="service-actions"><button class="primary" data-check>Check health</button><button class="secondary" data-run>Run refresh job</button><button class="secondary" data-export>Export status</button></div><pre id="service-output">Start the example service on port 4317, allow project-service in Capabilities, then check it here.</pre></section>`;
  root.querySelector("[data-close]")?.addEventListener("click", () => bridge.tabs.close());
  root.querySelector("[data-check]")?.addEventListener("click", () => callService("GET", "/health"));
  root.querySelector("[data-run]")?.addEventListener("click", () => callService("POST", "/jobs/refresh"));
  root.querySelector("[data-export]")?.addEventListener("click", exportServiceStatus);
}

async function exportServiceStatus() {
  const output = root.querySelector("#service-output");
  try {
    const listing = await bridge.files.list({ grantId: "exports", path: "." });
    const exists = listing.entries.some((entry) => entry.name === "service-status.json");
    await bridge.files.write({ grantId: "exports", path: "service-status.json", encoding: "utf8", data: JSON.stringify({ exportedAt: new Date().toISOString(), status: root.querySelector("#service-status")?.textContent }, null, 2), mode: exists ? "replace" : "create" });
    output.textContent = "Exported service-status.json through the Space file broker.";
  } catch (error) {
    output.textContent = error?.message || "Export unavailable";
  }
}

async function callService(method, path) {
  const status = root.querySelector("#service-status");
  const output = root.querySelector("#service-output");
  status.textContent = "Checking…";
  try {
    const response = await bridge.request({ destinationId: "project-service", method, path, headers: { accept: "application/json" } });
    status.textContent = response.status >= 200 && response.status < 300 ? "Available" : `HTTP ${response.status}`;
    output.textContent = response.body || "No response body";
  } catch (error) {
    status.textContent = "Unavailable";
    output.textContent = friendlyConnectionError(error);
  }
}

async function refreshMail() {
  const status = root.querySelector("#connection-state");
  if (status) status.textContent = "Connecting…";
  try {
    const response = await bridge.request({ destinationId: "mail-api", method: "GET", path: "/messages?limit=20", headers: { accept: "application/json" } });
    if (status) status.textContent = `Connected · HTTP ${response.status}`;
  } catch (error) {
    if (status) status.textContent = friendlyConnectionError(error);
  }
}

async function refreshAutomationStatus(event) {
  lastAutomationStorageEvent = event;
  lastAutomationRefresh = await bridge.storage.get(automationRefreshKey).catch(() => null);
  updateAutomationStatus();
}

function updateAutomationStatus() {
  const summary = summarizeAutomationRefresh();
  root.querySelectorAll("[data-automation-refresh]").forEach((element) => {
    element.dataset.state = summary.state;
    const title = element.querySelector("[data-automation-refresh-title]");
    const detail = element.querySelector("[data-automation-refresh-detail]");
    if (title) title.textContent = summary.title;
    if (detail) detail.textContent = summary.detail;
  });
}

function summarizeAutomationRefresh() {
  if (!lastAutomationRefresh || typeof lastAutomationRefresh !== "object") {
    const source = lastAutomationStorageEvent
      ? `Live storage ${lastAutomationStorageEvent.reset ? "reset" : "update"} · revision ${lastAutomationStorageEvent.revision}`
      : "Waiting for the first automation run";
    return { state: "idle", title: "Inbox refresh has not run", detail: `${source}. Use Run now in Capabilities.` };
  }

  const network = lastAutomationRefresh.network && typeof lastAutomationRefresh.network === "object" ? lastAutomationRefresh.network : {};
  const notification = lastAutomationRefresh.notification && typeof lastAutomationRefresh.notification === "object" ? lastAutomationRefresh.notification : {};
  let title = "Remote check result unavailable";
  let state = "warning";
  if (network.state === "connected") {
    title = `Remote check connected · HTTP ${safeStatus(network.status)}`;
    state = "success";
  } else if (network.state === "http-error") {
    title = `Remote check returned HTTP ${safeStatus(network.status)}`;
  } else if (network.code === "NETWORK_DENIED") {
    title = "Remote check blocked · mail-api access is off";
  } else if (network.code === "AUTH_REQUIRED") {
    title = "Remote check blocked · connection required";
  } else if (network.state === "unavailable") {
    title = "Remote check finished · fake endpoint unavailable";
  }

  const eventLabel = lastAutomationStorageEvent
    ? `Live storage ${lastAutomationStorageEvent.reset ? "reset" : "update"} · revision ${lastAutomationStorageEvent.revision}`
    : "Loaded from app storage";
  const completedLabel = formatAutomationTime(lastAutomationRefresh.completedAt);
  const notificationLabel = notification.state === "requested"
    ? "Windows notification requested"
    : notification.code === "NOTIFICATION_DENIED"
      ? "notification access is off"
      : "Windows notification unavailable";
  return { state, title, detail: `${eventLabel} · ${completedLabel} · ${notificationLabel}` };
}

function automationStatusMarkup() {
  return `<aside class="automation-status" data-automation-refresh data-state="idle" aria-live="polite"><span class="automation-status-dot" aria-hidden="true"></span><span><strong data-automation-refresh-title>Inbox refresh has not run</strong><small data-automation-refresh-detail>Use Run now in Capabilities.</small></span></aside>`;
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : "unknown";
}

function formatAutomationTime(value) {
  if (typeof value !== "string") return "time unavailable";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "time unavailable" : timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function wireOpenActions() {
  root.querySelectorAll("[data-message]").forEach((element) => element.addEventListener("click", () => openMessage(element.dataset.message)));
  root.querySelectorAll("[data-open-folder]").forEach((element) => element.addEventListener("click", () => openFolder(element.dataset.openFolder)));
  root.querySelectorAll("[data-open-compose]").forEach((element) => element.addEventListener("click", openCompose));
  root.querySelectorAll("[data-open-service]").forEach((element) => element.addEventListener("click", openService));
}

function openMessage(id) {
  const message = messages.find((item) => item.id === id);
  if (!message) return;
  return bridge.tabs.open({ tabId: `message:${message.id}`, title: message.subject, route: `/message/${message.id}`, state: { messageId: message.id } });
}
function openFolder(folder) { return bridge.tabs.open({ tabId: `folder:${folder}`, title: folder === "drafts" ? "Drafts" : "Inbox", route: `/inbox?folder=${folder}` }); }
function openCompose() { return bridge.tabs.open({ tabId: `compose:${Date.now()}`, title: "New message", route: "/compose" }); }
function openService() { return bridge.tabs.open({ tabId: "project-service", title: "Project service", route: "/service" }); }

function messageRow(message) { return `<button class="message-row ${message.unread ? "unread" : ""}" data-message="${message.id}"><span class="avatar">${escapeHtml(message.sender.slice(0, 1))}</span><span><strong>${escapeHtml(message.sender)}</strong><b>${escapeHtml(message.subject)}</b><small>${escapeHtml(message.preview)}</small></span><time>${escapeHtml(message.time)}</time></button>`; }
function messageCard(message) { return `<button class="message-card ${message.unread ? "unread" : ""}" data-message="${message.id}"><span class="avatar">${escapeHtml(message.sender.slice(0, 1))}</span><span><strong>${escapeHtml(message.sender)}</strong><b>${escapeHtml(message.subject)}</b><small>${escapeHtml(message.preview)}</small></span><time>${escapeHtml(message.time)}</time></button>`; }
function friendlyConnectionError(error) {
  if (error?.code === "NETWORK_DENIED") return "Access is off or this request was not declared · review it in Capabilities";
  if (error?.code === "AUTH_REQUIRED") return "Connection required · connect it in Capabilities";
  return error?.message || "Connection unavailable";
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

render();
