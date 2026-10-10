const bridge = globalThis.workFoldRestrictedApp;
const root = document.querySelector("#app");
const STORAGE_KEY = "applications";

// Bundled fictional sample data (from applications.csv). Not a job-site integration.
const SEED = [
  { id: "fieldwork-studio", company: "Fieldwork Studio", role: "Operations coordinator", status: "Interview", appliedDate: "2026-10-05", nextStep: "Interview on October 14", notes: "Review workshop coordination examples" },
  { id: "harbor-projects", company: "Harbor Projects", role: "Project assistant", status: "Applied", appliedDate: "2026-10-07", nextStep: "Follow up on October 16", notes: "Community projects and supplier support" },
  { id: "common-ground", company: "Common Ground", role: "Studio coordinator", status: "To apply", appliedDate: "", nextStep: "Tailor cover letter", notes: "Weekly events and room scheduling" },
  { id: "linden-events", company: "Linden Events", role: "Operations assistant", status: "Applied", appliedDate: "2026-10-03", nextStep: "Check application status", notes: "Operations and participant communication" },
  { id: "oak-street-arts", company: "Oak Street Arts", role: "Program assistant", status: "To apply", appliedDate: "", nextStep: "Review the job description", notes: "Weekend workshops" },
  { id: "northline-studio", company: "Northline Studio", role: "Office coordinator", status: "Closed", appliedDate: "2026-09-23", nextStep: "No further action", notes: "Role filled" }
];

const STATUS_ORDER = ["To apply", "Applied", "Interview", "Closed"];
const STATUS_META = {
  "To apply": { dot: "#b8893d" },
  "Applied": { dot: "#6a9a93" },
  "Interview": { dot: "#3f8a7e" },
  "Closed": { dot: "#a39d92" }
};

let context = bridge.context.get();
let applications = [];
let query = "";
const drafts = Object.create(null); // appId -> { status, nextStep, notes } (per-view unsaved edits)

document.documentElement.dataset.theme = context.theme;
bridge.context.onChanged((next) => {
  context = next;
  document.documentElement.dataset.theme = next.theme;
  render();
});
bridge.storage.onChanged(async (event) => {
  if (!event.reset && !event.keys.includes(STORAGE_KEY)) return;
  applications = await loadApplications();
  render();
});

async function loadApplications() {
  const stored = await bridge.storage.get(STORAGE_KEY);
  if (Array.isArray(stored) && stored.length) return stored;
  await bridge.storage.set(STORAGE_KEY, SEED);
  return SEED.slice();
}

function statusMeta(status) { return STATUS_META[status] || { dot: "#a39d92" }; }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function unslug(s) { return STATUS_ORDER.find((st) => slug(st) === s) || s; }
function groupCount(status) { return status ? applications.filter((a) => a.status === status).length : applications.length; }

function filteredList(status) {
  const q = query.trim().toLowerCase();
  let list = status ? applications.filter((a) => a.status === status) : applications.slice();
  if (q) list = list.filter((a) => `${a.company} ${a.role} ${a.nextStep} ${a.notes}`.toLowerCase().includes(q));
  return sortRecent(list);
}

function sortRecent(list) {
  return list.slice().sort((a, b) => {
    const da = a.appliedDate || "", db = b.appliedDate || "";
    if (da && db) return db.localeCompare(da);
    if (da) return -1;
    if (db) return 1;
    return a.company.localeCompare(b.company);
  });
}

function formatDate(value) {
  if (!value) return "Not applied yet";
  const d = new Date(value + "T00:00:00");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function sameDraft(draft, app) {
  return draft.status === app.status
    && (draft.nextStep || "") === (app.nextStep || "")
    && (draft.notes || "") === (app.notes || "");
}

function render() {
  if (context.placement === "navigator") renderNavigator();
  else renderTab();
}

function renderNavigator() {
  const recent = filteredList("").slice(0, 5);
  root.innerHTML = `
    <section class="navigator-shell">
      <header class="navigator-header">
        <div>
          <span class="eyebrow">Sample applications</span>
          <h1>Job applications</h1>
        </div>
      </header>
      <label class="search"><span aria-hidden="true">⌕</span><input type="search" value="${escapeAttribute(query)}" placeholder="Filter applications" aria-label="Filter applications"></label>
      <nav class="group-list" aria-label="Application groups">
        <button class="group active" data-open-list="all"><span>All applications</span><strong>${applications.length}</strong></button>
        ${STATUS_ORDER.map((s) => `<button class="group" data-open-list="${slug(s)}"><span class="dot" style="background:${statusMeta(s).dot}"></span><span>${escapeHtml(s)}</span><strong>${groupCount(s)}</strong></button>`).join("")}
      </nav>
      <div class="section-heading"><span>Recent</span></div>
      <div class="row-list">${recent.map(navigatorRow).join("") || `<p class="empty">No applications</p>`}</div>
      <footer><span class="quiet">Local tracker — edits save to this work-folder</span></footer>
    </section>`;
  wireSearch(renderNavigator);
  wireOpenActions();
}

function wireSearch(renderView) {
  root.querySelector('input[type="search"]')?.addEventListener("input", (event) => {
    const caret = event.target.selectionStart;
    query = event.target.value;
    renderView();
    const input = root.querySelector('input[type="search"]');
    input?.focus({ preventScroll: true });
    if (caret !== null) input?.setSelectionRange(caret, caret);
  });
}

function navigatorRow(app) {
  return `<button class="row" data-open-app="${escapeAttribute(app.id)}">
    <span class="row-main">
      <strong>${escapeHtml(app.company)}</strong>
      <small>${escapeHtml(app.role)}</small>
    </span>
    <span class="row-meta">
      <span class="status-dot" style="background:${statusMeta(app.status).dot}" title="${escapeAttribute(app.status)}"></span>
      <time>${app.appliedDate ? escapeHtml(formatDate(app.appliedDate)) : "Not applied"}</time>
    </span>
  </button>`;
}

function renderTab() {
  const path = new URL(context.route, "https://app.invalid").pathname;
  if (path.startsWith("/app/")) return renderDetail(decodeURIComponent(path.slice("/app/".length)));
  if (path.startsWith("/list/")) {
    const part = path.slice("/list/".length);
    return renderList(part === "all" ? "" : unslug(part));
  }
  renderList("");
}

function renderList(status) {
  const list = filteredList(status);
  const title = status || "All applications";
  root.innerHTML = `
    <section class="tab-shell">
      <header class="tab-header">
        <div>
          <span class="eyebrow">Applications</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${list.length} application${list.length === 1 ? "" : "s"} in this work-folder</p>
        </div>
      </header>
      <div class="tab-toolbar">
        <label class="search"><span aria-hidden="true">⌕</span><input type="search" value="${escapeAttribute(query)}" placeholder="Filter applications" aria-label="Filter applications"></label>
      </div>
      <div class="wide-row-list">
        ${list.map(listRow).join("") || `<p class="empty">No applications match.</p>`}
      </div>
      <p class="quiet footnote">Sample applications · local tracker, not a job-site integration.</p>
    </section>`;
  wireSearch(() => renderList(status));
  wireOpenActions();
}

function listRow(app) {
  return `<button class="wide-row" data-open-app="${escapeAttribute(app.id)}">
    <span class="wide-row-main">
      <strong>${escapeHtml(app.company)}</strong>
      <b>${escapeHtml(app.role)}</b>
      <small class="next">${escapeHtml(app.nextStep || "No next step")}</small>
    </span>
    <span class="wide-row-meta">
      <span class="badge" style="--dot:${statusMeta(app.status).dot}">${escapeHtml(app.status)}</span>
      <time>${app.appliedDate ? escapeHtml(formatDate(app.appliedDate)) : "Not applied yet"}</time>
    </span>
  </button>`;
}

function renderDetail(id) {
  const app = applications.find((a) => a.id === id);
  if (!app) {
    root.innerHTML = `<section class="tab-shell">
      <header class="tab-header"><div><span class="eyebrow">Application</span><h1>Application unavailable</h1></div><button class="secondary" data-close>Close tab</button></header>
      <p class="quiet footnote">This application is not in the local tracker.</p>
    </section>`;
    root.querySelector("[data-close]")?.addEventListener("click", () => bridge.tabs.close());
    return;
  }
  const draft = drafts[id] || { status: app.status, nextStep: app.nextStep || "", notes: app.notes || "" };
  const dirty = !sameDraft(draft, app);
  root.innerHTML = `
    <section class="tab-shell">
      <header class="tab-header">
        <div>
          <span class="eyebrow">${escapeHtml(app.company)}</span>
          <h1>${escapeHtml(app.role)}</h1>
          <p><span class="badge" style="--dot:${statusMeta(app.status).dot}">${escapeHtml(app.status)}</span><span class="sep">·</span><time>${app.appliedDate ? escapeHtml(formatDate(app.appliedDate)) : "Not applied yet"}</time></p>
        </div>
        <button class="secondary" data-close>Close tab</button>
      </header>
      <div class="detail-body">
        <div class="field">
          <label for="f-status">Status</label>
          <select id="f-status">
            ${STATUS_ORDER.map((s) => `<option value="${escapeHtml(s)}"${s === draft.status ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <span class="field-label">Applied</span>
          <span class="read-only">${escapeHtml(app.appliedDate ? formatDate(app.appliedDate) : "Not applied yet")}</span>
        </div>
        <div class="field">
          <label for="f-next">Next step</label>
          <input id="f-next" type="text" value="${escapeAttribute(draft.nextStep)}" placeholder="What happens next?">
        </div>
        <div class="field">
          <label for="f-notes">Notes</label>
          <textarea id="f-notes" rows="6" placeholder="Notes about this application">${escapeHtml(draft.notes)}</textarea>
        </div>
        <div class="form-actions">
          <button class="primary" data-save${dirty ? "" : " disabled"}>Save changes</button>
          <button class="link" data-revert${dirty ? "" : " disabled"}>Discard</button>
          <span class="quiet" id="save-state" data-dirty="${dirty ? 1 : 0}">${dirty ? "Unsaved changes" : "Saved"}</span>
        </div>
      </div>
      <p class="quiet footnote">Edits save to this work-folder's app storage. Sample applications — not a job-site integration.</p>
    </section>`;

  const statusEl = root.querySelector("#f-status");
  const nextEl = root.querySelector("#f-next");
  const notesEl = root.querySelector("#f-notes");
  const saveBtn = root.querySelector("[data-save]");
  const revertBtn = root.querySelector("[data-revert]");
  const stateEl = root.querySelector("#save-state");

  const capture = () => {
    drafts[id] = { status: statusEl.value, nextStep: nextEl.value, notes: notesEl.value };
    const d = !sameDraft(drafts[id], app);
    saveBtn.disabled = !d;
    revertBtn.disabled = !d;
    stateEl.textContent = d ? "Unsaved changes" : "Saved";
    stateEl.dataset.dirty = d ? "1" : "0";
  };
  statusEl.addEventListener("change", capture);
  nextEl.addEventListener("input", capture);
  notesEl.addEventListener("input", capture);
  root.querySelector("[data-close]")?.addEventListener("click", () => bridge.tabs.close());
  revertBtn?.addEventListener("click", () => { if (drafts[id]) { delete drafts[id]; renderDetail(id); } });
  saveBtn?.addEventListener("click", () => saveApp(id));
}

async function saveApp(id) {
  const draft = drafts[id];
  if (!draft) return;
  const app = applications.find((a) => a.id === id);
  if (!app) return;
  const saveBtn = root.querySelector("[data-save]");
  const stateEl = root.querySelector("#save-state");
  if (saveBtn) saveBtn.disabled = true;
  if (stateEl) { stateEl.textContent = "Saving…"; stateEl.dataset.dirty = "0"; }
  const updated = applications.map((a) => a.id === id ? { ...a, status: draft.status, nextStep: draft.nextStep, notes: draft.notes } : a);
  try {
    await bridge.storage.set(STORAGE_KEY, updated);
    applications = updated;
    delete drafts[id];
    renderDetail(id);
  } catch (error) {
    if (stateEl) { stateEl.textContent = "Could not save"; stateEl.dataset.dirty = "1"; }
    if (saveBtn) saveBtn.disabled = false;
  }
}

function wireOpenActions() {
  root.querySelectorAll("[data-open-app]").forEach((el) => el.addEventListener("click", () => openApp(el.dataset.openApp)));
  root.querySelectorAll("[data-open-list]").forEach((el) => el.addEventListener("click", () => openList(el.dataset.openList)));
}

function openApp(id) {
  const app = applications.find((a) => a.id === id);
  if (!app) return;
  return bridge.tabs.open({ tabId: `app:${id}`, title: `${app.company} · ${app.role}`, route: `/app/${id}`, state: { appId: id } });
}

function openList(group) {
  const status = group === "all" ? "" : unslug(group);
  return bridge.tabs.open({ tabId: `list:${group}`, title: status || "All applications", route: `/list/${group}` });
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

(async () => {
  applications = await loadApplications();
  render();
})();
