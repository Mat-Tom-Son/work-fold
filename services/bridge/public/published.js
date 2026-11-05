// The Published view (docs/pages.md, "Publishing (stage 2)"): the pages this
// address has put online, their entries, Export as spreadsheet, and Unpublish.
// It needs only the password session, so it opens before this browser is
// paired and while the desktop is off. Page code never runs here; entries are
// shown as plain text.

/** `pg_` plus 26 lowercase RFC 4648 base32 characters. */
export const pageIdPattern = /^pg_[a-z2-7]{26}$/;
/** Rows shown per table; Export as spreadsheet has all of them. */
export const publishedRowLimit = 200;

const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** The page's public link, or "" when the id or origin is not one the bridge would send. */
export function publishedPageLink(pagesOrigin, pageId) {
  if (typeof pageId !== "string" || !pageIdPattern.test(pageId)) return "";
  let origin;
  try { origin = new URL(String(pagesOrigin)); } catch { return ""; }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return "";
  return `${origin.origin}/p/${pageId}`;
}

export function humanizeName(name) {
  const text = String(name ?? "");
  return text.split(/[_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || text;
}

export function entriesLabel(count) {
  if (!Number.isInteger(count) || count < 0) return "";
  if (count === 0) return "No entries";
  return count === 1 ? "1 entry" : `${numberFormat.format(count)} entries`;
}

export function statusLabel(status) {
  if (status === "online") return "Online";
  if (status === "unpublished") return "Unpublished";
  return humanizeName(status || "unknown");
}

/** One stored value as the text a person reads. */
export function cellText(value, type) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? numberFormat.format(value) : "";
  if (type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(time) : value;
  }
  if (type === "timestamp" || type === "date") return formatTime(value);
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Rows newest first, whatever order they arrived in. */
export function newestFirst(rows) {
  const time = (row) => {
    const parsed = Date.parse(row?.createdAt ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => time(right) - time(left));
}

export function spreadsheetFileName(title, table) {
  const cleaned = `${title || "Page"} - ${humanizeName(table)}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${cleaned || "Page data"}.csv`;
}

/**
 * The dialog. `client` reaches the bridge (or the inert fixture):
 * list(), tables(pageId), table(pageId, name), exportTable(pageId, name) → Blob,
 * and unpublish(pageId).
 */
export function createPublishedView({ client, copyText = copyToClipboard, saveFile = saveBlob }) {
  const dialog = document.createElement("dialog");
  dialog.className = "published-dialog";
  dialog.setAttribute("aria-labelledby", "published-title");
  dialog.innerHTML = `
    <header>
      <button type="button" class="published-back" data-published-back aria-label="Back to Published" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
      </button>
      <h2 id="published-title" tabindex="-1">Published</h2>
      <button type="button" class="published-close" data-published-close aria-label="Close Published">✕</button>
    </header>
    <div class="published-content"></div>
    <footer><p class="published-status" role="status" aria-live="polite"></p><button type="button" class="quiet" data-published-refresh>Refresh</button></footer>`;
  document.body.append(dialog);
  const content = dialog.querySelector(".published-content");
  const title = dialog.querySelector("#published-title");
  const back = dialog.querySelector("[data-published-back]");
  const status = dialog.querySelector(".published-status");
  const refresh = dialog.querySelector("[data-published-refresh]");
  let generation = 0;
  let opener = null;
  let pages = [];
  let pagesOrigin = "";
  let selectedPageId = null;
  let notice = "";

  const say = (text) => { if (status.textContent !== text) status.textContent = text; };
  const current = () => pages.find((page) => page.pageId === selectedPageId) ?? null;

  async function showList({ focusPageId = null } = {}) {
    const run = ++generation;
    selectedPageId = null;
    notice = "";
    back.hidden = true;
    title.textContent = "Published";
    content.innerHTML = `<p class="published-loading">Loading…</p>`;
    refresh.disabled = true;
    try {
      const result = await client.list();
      if (run !== generation) return;
      pages = Array.isArray(result?.pages) ? result.pages.filter((page) => page && typeof page === "object") : [];
      pagesOrigin = typeof result?.pagesOrigin === "string" ? result.pagesOrigin : "";
      content.innerHTML = listMarkup();
      if (focusPageId) content.querySelector(`[data-open-page="${focusPageId}"]`)?.focus({ preventScroll: true });
    } catch (error) {
      if (run !== generation) return;
      content.innerHTML = failureMarkup(error, "Published pages couldn't be loaded.");
    } finally {
      if (run === generation) refresh.disabled = false;
    }
  }

  async function showPage(pageId, { focusHeading = true } = {}) {
    const run = ++generation;
    selectedPageId = pageId;
    const page = current();
    back.hidden = false;
    title.textContent = page?.title || "Page";
    content.innerHTML = `${pageSummaryMarkup()}<div class="published-tables"><p class="published-loading">Loading entries…</p></div>`;
    if (focusHeading) title.focus({ preventScroll: true });
    refresh.disabled = true;
    try {
      const summary = await client.tables(pageId);
      if (run !== generation) return;
      const tables = Array.isArray(summary?.tables) ? summary.tables : [];
      const views = await Promise.all(tables.map((table) => client.table(pageId, table.name).then(
        (view) => ({ table, view }),
        (error) => ({ table, error }),
      )));
      if (run !== generation) return;
      const target = content.querySelector(".published-tables");
      if (target) target.innerHTML = tables.length ? views.map(tableMarkup).join("") : `<p class="published-empty">This page doesn't collect entries.</p>`;
    } catch (error) {
      if (run !== generation) return;
      const target = content.querySelector(".published-tables");
      if (target) target.innerHTML = failureMarkup(error, "The entries couldn't be loaded.");
    } finally {
      if (run === generation) refresh.disabled = false;
    }
  }

  function pageSummaryMarkup() {
    const page = current();
    if (!page) return "";
    const online = page.status === "online";
    const link = online ? publishedPageLink(pagesOrigin, page.pageId) : "";
    const facts = [entriesLabel(page.entries), page.publishedAt ? `Published ${formatDate(page.publishedAt)}` : ""].filter(Boolean).join(" · ");
    return `<div class="published-summary" data-page-summary>
      <div class="published-summary-line">${statusPill(page.status)}${facts ? `<span class="published-meta">${escapeHtml(facts)}</span>` : ""}</div>
      ${link ? linkRowMarkup(page, link) : ""}
      ${notice ? `<p class="published-result" tabindex="-1">${notice}</p>` : ""}
      ${online
        ? `<div class="published-actions"><button type="button" class="published-button published-danger" data-unpublish>Unpublish</button></div>`
        : notice ? "" : `<p class="published-note">Its entries are kept. Publishing it again from <span class="nobr">work-fold</span> on your desktop brings back the same link.</p>`}
    </div>`;
  }

  function renderSummary() {
    const target = content.querySelector("[data-page-summary]");
    if (target) target.outerHTML = pageSummaryMarkup();
  }

  function listMarkup() {
    if (!pages.length) {
      return `<p class="published-empty">Nothing is published yet. Publish a page from its tab in <span class="nobr">work-fold</span> on your desktop.</p>`;
    }
    return `<ul class="published-list">${pages.map((page) => {
      const link = page.status === "online" ? publishedPageLink(pagesOrigin, page.pageId) : "";
      const id = pageIdPattern.test(page.pageId) ? page.pageId : "";
      return `<li class="published-item">
        <div class="published-item-head"><h3>${escapeHtml(page.title || "Untitled page")}</h3>${statusPill(page.status)}</div>
        ${link ? linkRowMarkup(page, link) : ""}
        <div class="published-item-foot">
          <span class="published-meta">${escapeHtml(entriesLabel(page.entries))}</span>
          ${id ? `<button type="button" class="published-button" data-open-page="${id}" aria-label="See entries for ${escapeAttribute(page.title || "this page")}">See entries</button>` : ""}
        </div>
      </li>`;
    }).join("")}</ul>`;
  }

  function linkRowMarkup(page, link) {
    return `<div class="published-link-row">
      <input class="published-link" type="text" readonly value="${escapeAttribute(link)}" aria-label="Link to ${escapeAttribute(page.title || "this page")}" />
      <button type="button" class="published-button" data-copy-link="${escapeAttribute(link)}">Copy</button>
      <a class="published-button" href="${escapeAttribute(link)}" target="_blank" rel="noopener noreferrer">Open</a>
    </div>`;
  }

  function tableMarkup({ table, view, error }, index) {
    const name = String(table?.name ?? "");
    const heading = humanizeName(name);
    const live = Number.isInteger(table?.live) ? table.live : Number.isInteger(view?.total) ? view.total : 0;
    const headingId = `published-table-${index}`;
    const head = `<div class="published-table-head">
      <div><h3 id="${headingId}">${escapeHtml(heading)}</h3><p class="published-meta">${escapeHtml([entriesLabel(live), table?.retired ? "No longer collected" : ""].filter(Boolean).join(" · "))}</p></div>
      <button type="button" class="published-button" data-export-table="${escapeAttribute(name)}"${live ? "" : " disabled"}>Export as spreadsheet</button>
    </div>`;
    if (error || !view || !Array.isArray(view.rows)) {
      return `<section class="published-table" aria-labelledby="${headingId}">${head}<p class="published-empty">${escapeHtml(errorText(error, "These entries couldn't be loaded."))}</p></section>`;
    }
    const columns = (Array.isArray(view.columns) ? view.columns : []).filter((column) => column && typeof column.name === "string" && !column.name.startsWith("_"));
    const rows = newestFirst(view.rows).slice(0, publishedRowLimit);
    if (!rows.length) return `<section class="published-table" aria-labelledby="${headingId}">${head}<p class="published-empty">No entries yet.</p></section>`;
    const total = Number.isInteger(view.total) ? view.total : view.rows.length;
    return `<section class="published-table" aria-labelledby="${headingId}">${head}
      <div class="published-grid" role="region" aria-labelledby="${headingId}" tabindex="0">
        <table>
          <thead><tr><th scope="col">Added</th>${columns.map((column) => `<th scope="col">${escapeHtml(humanizeName(column.name))}${column.retired ? ` <span class="published-retired">(no longer collected)</span>` : ""}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((row) => `<tr><td class="published-added">${escapeHtml(formatTime(row.createdAt))}</td>${columns.map((column) => `<td>${escapeHtml(cellText(row[column.name], column.type))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
      ${total > rows.length ? `<p class="published-meta">Showing the newest ${numberFormat.format(rows.length)} of ${numberFormat.format(total)}. Export as spreadsheet for all of them.</p>` : ""}
    </section>`;
  }

  async function unpublish(button) {
    const page = current();
    if (!page) return;
    const run = generation;
    button.disabled = true;
    button.textContent = "Unpublishing…";
    say("");
    try {
      const result = await client.unpublish(page.pageId);
      if (run !== generation || selectedPageId !== page.pageId) return;
      Object.assign(page, result?.page && typeof result.page === "object" ? result.page : { status: "unpublished" });
      if (page.status !== "online") {
        notice = `Unpublished. Anyone opening the link now sees “Nothing is published here.” The entries are kept, and publishing it again from <span class="nobr">work-fold</span> on your desktop brings back the same link.`;
      }
      renderSummary();
      // The result replaces the button that was focused; reading moves to it.
      content.querySelector(".published-result, [data-unpublish]")?.focus({ preventScroll: true });
    } catch (error) {
      if (run !== generation) return;
      button.disabled = false;
      button.textContent = "Unpublish";
      say(errorText(error, "The page couldn't be unpublished."));
    }
  }

  async function exportTable(button) {
    const page = current();
    const table = button.dataset.exportTable;
    if (!page || !table) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Exporting…";
    say("");
    try {
      const blob = await client.exportTable(page.pageId, table);
      saveFile(blob, spreadsheetFileName(page.title, table));
      say(`Exported ${humanizeName(table)}.`);
    } catch (error) {
      say(errorText(error, "The spreadsheet couldn't be exported."));
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  async function copy(button) {
    const link = button.dataset.copyLink;
    const field = button.parentElement?.querySelector(".published-link");
    try {
      await copyText(link);
      say("Link copied.");
    } catch {
      field?.focus();
      field?.select();
      say("Couldn't copy the link. It's selected so you can copy it yourself.");
    }
  }

  function failureMarkup(error, fallback) {
    return `<div class="published-failure"><p>${escapeHtml(errorText(error, fallback))}</p><button type="button" class="published-button" data-published-retry>Try again</button></div>`;
  }

  function close() {
    generation += 1;
    selectedPageId = null;
    content.replaceChildren();
    say("");
    if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  content.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const openPage = target?.closest("[data-open-page]");
    if (openPage) { say(""); return void showPage(openPage.dataset.openPage); }
    const copyButton = target?.closest("[data-copy-link]");
    if (copyButton) return void copy(copyButton);
    const unpublishButton = target?.closest("[data-unpublish]");
    if (unpublishButton) return void unpublish(unpublishButton);
    const exportButton = target?.closest("[data-export-table]");
    if (exportButton) return void exportTable(exportButton);
    if (target?.closest("[data-published-retry]")) return void (selectedPageId ? showPage(selectedPageId) : showList());
  });
  content.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.classList.contains("published-link")) event.target.select();
  });
  back.addEventListener("click", () => {
    const pageId = selectedPageId;
    say("");
    void showList({ focusPageId: pageId });
  });
  refresh.addEventListener("click", () => {
    say("");
    void (selectedPageId ? showPage(selectedPageId, { focusHeading: false }) : showList());
  });
  dialog.querySelector("[data-published-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });

  return {
    async open({ pageId, opener: from } = {}) {
      opener = from ?? document.activeElement;
      say("");
      if (!dialog.open) dialog.showModal();
      await showList();
      if (pageId && pages.some((page) => page.pageId === pageId)) await showPage(pageId);
    },
    close,
    isOpen: () => dialog.open,
    destroy() { close(); dialog.remove(); },
  };
}

function statusPill(status) {
  return `<span class="published-pill" data-status="${status === "online" ? "online" : "offline"}">${escapeHtml(statusLabel(status))}</span>`;
}

function formatDate(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? dateFormat.format(time) : "";
}

function formatTime(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? timeFormat.format(time) : String(value ?? "");
}

async function copyToClipboard(text) {
  if (!navigator.clipboard?.writeText) throw new Error("The clipboard is unavailable.");
  await navigator.clipboard.writeText(text);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function errorText(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
