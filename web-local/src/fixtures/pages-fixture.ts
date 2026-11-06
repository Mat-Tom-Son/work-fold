import { ApiError } from "../lib/api";
import type { PageCall, PageCallError, PageDataColumn, PageEntriesClient, PageInspection, PagePublication, PageRow, PagesClient, PageTableData, PageTableSummary, PageViewer } from "../lib/pages";

/**
 * The browser preview's page (`?fixture=work-folder`): one RSVP page in
 * "Home projects", kept in memory so the page tab can be tried without the
 * local API. It is published, with entries real visitors made online next to
 * the test entries made in Preview, and Settings → Published lists it. The
 * rules here are a small stand-in for the real engine.
 */

export const fixturePagePath = "Garden Party RSVP";

const declaration = {
  rsvps: {
    columns: {
      name: { type: "text", required: true },
      email: { type: "email", required: true, unique: true },
      guests: { type: "number", min: 0, max: 10, integer: true },
      bringing: { type: "choice", options: ["Salad", "Dessert", "Drinks"] },
      notes: { type: "long-text" },
    },
    visitors: ["add", "see-own", "edit-own"],
    limit: 50,
  },
} as const;

const fixtureHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Garden Party RSVP</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; color: #2d3a2e; background: #f6f3ea; }
  main { max-width: 520px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 30px; margin: 0 0 4px; } p.lead { margin: 0 0 24px; color: #5b6b5c; }
  label { display: block; margin: 0 0 14px; font: 14px/1.4 system-ui, sans-serif; }
  input, select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px; border: 1px solid #c8c2b0; border-radius: 6px; font: inherit; background: #fff; }
  button { padding: 10px 18px; border: 0; border-radius: 6px; background: #4f7a45; color: #fff; font: 600 15px system-ui, sans-serif; }
  button:disabled { opacity: .6; }
  .thanks { display: none; padding: 12px 14px; border-radius: 6px; background: #e3eedf; }
  form[data-page-state="sent"] .thanks { display: block; }
  [data-page-message] { color: #a3361f; font: 14px system-ui, sans-serif; }
  #count { font: 14px system-ui, sans-serif; color: #5b6b5c; }
</style></head>
<body><main>
  <h1>Garden Party</h1>
  <p class="lead">Saturday, June 6 · 4 pm · the back garden. <a href="https://example.com/directions">Directions</a></p>
  <form data-page-table="rsvps">
    <label>Your name <input name="name" required></label>
    <label>Email <input name="email" type="email" required></label>
    <label>Guests besides you <input name="guests" type="number" min="0" max="10" value="0"></label>
    <label>Bringing <select name="bringing"><option value="">Nothing, just me</option><option>Salad</option><option>Dessert</option><option>Drinks</option></select></label>
    <button>Send RSVP</button>
    <p data-page-message></p>
    <p class="thanks">Thanks! See you in the garden.</p>
  </form>
  <p id="count"></p>
</main>
<script>
  async function refresh() {
    const count = await workFoldPage.count("rsvps");
    document.getElementById("count").textContent = count === 1 ? "1 person has replied." : count + " people have replied.";
  }
  workFoldPage.onChange(refresh);
  refresh();
</script>
</body></html>`;

interface StoredRow extends PageRow {
  _deleted: string | null;
}

/** One set of entries: the test entries from Preview, or the ones visitors made online. */
interface EntryStore {
  rows: StoredRow[];
  lastSeen: string | null;
}

const fixtureWorkFolderId = "fixture-home";
const fixtureWorkFolderName = "Home projects";
const fixturePageUrl = "https://pages.work-fold.com/p/pg_rhjvpnlqbuw5qowjscvk72pvha";
const fixturePageFiles = [
  { path: "index.html", bytes: 2_410 },
  { path: "page.json", bytes: 602 },
  { path: "notes.html", bytes: 1_800 },
];

export function createFixturePagesClient(): PagesClient {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const entry = (id: string, visitor: string, [name, email, guests, bringing, minutesAgo]: [string, string, number, string | null, number]): StoredRow => ({
    id, createdAt: at(minutesAgo), updatedAt: at(minutesAgo), visitor, name, email, guests, ...(bringing ? { bringing } : {}), _deleted: null,
  });
  const tryouts: Array<[string, string, number, string | null, number]> = [
    ["Maya Chen", "maya@example.com", 2, "Dessert", 60 * 26],
    ["Oliver Brooks", "oliver@example.com", 0, "Drinks", 60 * 25],
    ["Priya Natarajan", "priya@example.com", 3, "Salad", 60 * 20],
    ["Sam Ortega", "sam@example.com", 1, null, 60 * 3],
    ["Lena Fischer", "lena@example.com", 0, "Dessert", 45],
    ["Tom Abiola", "tom@example.com", 2, "Drinks", 12],
  ];
  const visitors = ["v_9a1b5211479cdd66e1058937c9151402", "v_06fd8d1915f638ff221e24a3077b76d1", "v_1507575bc1c458d4b1103572ce98f459", "v_3947c1c7cdeab6e7a5b158ec25329c22"];
  const replies: Array<[string, string, number, string | null, number]> = [
    ["Grace Okafor", "grace.okafor@example.org", 1, "Salad", 60 * 50],
    ["Daniel Reyes", "dreyes@example.net", 3, "Drinks", 60 * 47],
    ["Hannah Weiss", "hannah.w@example.com", 0, null, 60 * 40],
    ["Kenji Watanabe", "kenji@example.jp", 2, "Dessert", 60 * 31],
    ["Amara Singh", "amara.singh@example.com", 1, "Drinks", 60 * 22],
    ["Lucas Moreau", "lucas.moreau@example.fr", 0, "Salad", 60 * 9],
    ["Beatriz Costa", "bia.costa@example.com", 4, "Dessert", 60 * 3],
    ["Noah Fitzgerald", "noahfitz@example.com", 1, null, 70],
    ["Ines Haddad", "ines.h@example.com", 2, "Drinks", 18],
  ];
  const test: EntryStore = { rows: tryouts.map((person, index) => entry(`fixture-row-${index + 1}`, `visitor-${(index % 4) + 1}`, person)), lastSeen: at(60 * 4) };
  const online: EntryStore = { rows: replies.map((person, index) => entry(`fixture-online-${index + 1}`, visitors[index % visitors.length]!, person)), lastSeen: at(60 * 5) };
  let currentVisitor = "visitor-1";
  let visitorCount = 4;
  let nextRow = test.rows.length + 1;
  const requests = new Map<string, string>();
  const columns: PageDataColumn[] = Object.entries(declaration.rsvps.columns).map(([name, column]) => ({ name, retired: false, ...column } as PageDataColumn));
  let publication: PagePublication = {
    url: fixturePageUrl, status: "online", revision: 3, publishedAt: at(60 * 52), changesAvailable: true, lastCheckIn: at(0.5), dataRevision: 17,
  };

  const fail = (failure: PageCallError): never => { throw Object.assign(new Error(failure.message), { failure, name: "PageCallFailure" }); };
  const publicRow = (row: StoredRow, owner: boolean): PageRow => {
    const { _deleted: _ignored, visitor, ...rest } = row;
    return owner ? { ...rest, visitor } : rest;
  };
  const live = (store: EntryStore) => store.rows.filter((row) => !row._deleted);
  function check(store: EntryStore, values: Record<string, unknown>, existing?: StoredRow): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    const cleared = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      if (!(key in declaration.rsvps.columns)) fail({ code: "INVALID", message: `This page doesn't collect "${key}".`, field: key });
      if (value === "" || value === null || value === undefined) { cleared.add(key); continue; }
      clean[key] = key === "email" ? String(value).trim().toLowerCase() : value;
    }
    const merged: Record<string, unknown> = { ...(existing ?? {}), ...clean };
    for (const key of cleared) delete merged[key];
    for (const [key, column] of Object.entries(declaration.rsvps.columns)) {
      if ("required" in column && column.required && (merged[key] === undefined || merged[key] === "")) fail({ code: "INVALID", message: `Fill in ${key}.`, field: key });
    }
    if (clean.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(clean.email))) fail({ code: "INVALID", message: "Enter an email address.", field: "email" });
    if (clean.guests !== undefined && (typeof clean.guests !== "number" || clean.guests < 0 || clean.guests > 10)) fail({ code: "INVALID", message: "Guests must be a number from 0 to 10.", field: "guests" });
    if (clean.bringing !== undefined && !(declaration.rsvps.columns.bringing.options as readonly string[]).includes(String(clean.bringing))) fail({ code: "INVALID", message: "Choose Salad, Dessert, or Drinks.", field: "bringing" });
    if (clean.email !== undefined && live(store).some((row) => row.email === clean.email && row.id !== existing?.id)) fail({ code: "DUPLICATE", message: "Someone already replied with that email.", field: "email" });
    return clean;
  }
  const delay = <T,>(value: T, ms = 120) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));
  // work-fold checks in every minute while it runs.
  const checkedIn = () => {
    if (publication.lastCheckIn && Date.now() - Date.parse(publication.lastCheckIn) > 60_000) publication = { ...publication, lastCheckIn: new Date().toISOString() };
    return publication;
  };

  function entries(store: EntryStore, changed: () => void = () => undefined): PageEntriesClient {
    return {
      async tables(): Promise<PageTableSummary[]> {
        const current = live(store);
        const { lastSeen } = store;
        return delay([{ name: "rsvps", retired: false, live: current.length, deleted: store.rows.length - current.length, newCount: current.filter((row) => !lastSeen || row.createdAt > lastSeen).length, lastSeen }]);
      },
      async data(_workFolderId, _page, table, deleted): Promise<PageTableData> {
        const shown = store.rows.filter((row) => Boolean(row._deleted) === deleted);
        return delay({ table, columns, rows: shown.map((row) => ({ ...publicRow(row, true), ...(row._deleted ? { deletedAt: row._deleted } : {}) })), total: shown.length, lastSeen: store.lastSeen });
      },
      async update(_workFolderId, _page, _table, id, values) {
        const row = live(store).find((item) => item.id === id);
        if (!row) throw new Error("That entry isn't here any more.");
        const clean = check(store, values, row);
        for (const [key, value] of Object.entries(values)) if (value === "" || value === null) delete (row as Record<string, unknown>)[key];
        const next = { ...row, ...clean, updatedAt: new Date().toISOString() };
        store.rows = store.rows.map((item) => item.id === id ? next : item);
        changed();
        return delay(publicRow(next, true));
      },
      async remove(_workFolderId, _page, _table, ids) {
        const stamp = new Date().toISOString();
        store.rows = store.rows.map((row) => ids.includes(row.id) && !row._deleted ? { ...row, _deleted: stamp } : row);
        changed();
        return delay(ids.length);
      },
      async restore(_workFolderId, _page, _table, ids) {
        store.rows = store.rows.map((row) => ids.includes(row.id) ? { ...row, _deleted: null } : row);
        changed();
        return delay(ids.length);
      },
      async seen() {
        store.lastSeen = new Date().toISOString();
        return store.lastSeen;
      },
      async exportCsv() {
        const header = ["id", "createdAt", ...columns.map((column) => column.name)];
        const cell = (value: unknown) => value === undefined || value === null ? "" : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
        const lines = [header.join(","), ...live(store).map((row) => header.map((key) => cell(row[key])).join(","))];
        return new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
      },
    };
  }

  const known = (page: string) => { if (page !== fixturePagePath) throw new ApiError(404, "This folder isn't a page."); };

  const client: PagesClient = {
    async list(workFolderId) { return workFolderId === fixtureWorkFolderId ? [{ path: fixturePagePath, title: "Garden Party RSVP", problemCount: 0 }] : []; },
    async inspect(_workFolderId, page): Promise<PageInspection> {
      known(page);
      return {
        page: {
          path: page, title: "Garden Party RSVP", description: "RSVPs for the garden party.", entry: "index.html",
          tables: [{ name: "rsvps", columns: columns.map(({ retired: _retired, ...column }) => ({ ...column })), visitors: [...declaration.rsvps.visitors], limit: declaration.rsvps.limit }],
        },
        problems: [{ file: "notes.html", message: "Only the entry file is a page; notes.html isn't used.", severity: "warning" }],
        summary: { files: fixturePageFiles.length, bytes: fixturePageFiles.reduce((sum, file) => sum + file.bytes, 0) },
      };
    },
    async document() { return delay({ html: fixtureHtml, problems: [] }); },
    async visitor(_workFolderId, _page, fresh) {
      if (fresh) currentVisitor = `visitor-${++visitorCount}`;
      return currentVisitor;
    },
    async call(_workFolderId, _page, viewer: PageViewer, call: PageCall) {
      const owner = viewer.role === "owner";
      const visitor = viewer.role === "owner" ? "owner" : viewer.visitor;
      if (call.table !== "rsvps") return fail({ code: "NOT_FOUND", message: `This page has no table named "${call.table}".` });
      const mineOnly = (row: StoredRow) => owner || row.visitor === visitor;
      switch (call.op) {
        case "add": {
          const knownRow = call.requestId ? requests.get(call.requestId) : undefined;
          const existing = knownRow ? test.rows.find((row) => row.id === knownRow) : undefined;
          if (existing) return delay(publicRow(existing, owner));
          if (live(test).length >= declaration.rsvps.limit) return fail({ code: "LIMIT_REACHED", message: "This list is full." });
          const values = check(test, (call.values ?? {}) as Record<string, unknown>);
          const stamp = new Date().toISOString();
          const row: StoredRow = { id: `fixture-row-${nextRow++}`, createdAt: stamp, updatedAt: stamp, visitor, ...values, _deleted: null };
          test.rows = [...test.rows, row];
          if (call.requestId) requests.set(call.requestId, row.id);
          return delay(publicRow(row, owner));
        }
        case "mine": return delay(live(test).filter((row) => row.visitor === visitor).reverse().map((row) => publicRow(row, owner)));
        case "list": return owner ? delay(live(test).reverse().map((row) => publicRow(row, owner))) : fail({ code: "NOT_ALLOWED", message: "Visitors can't see everyone's replies on this page." });
        case "count": return delay(live(test).length);
        case "update": {
          const row = live(test).find((item) => item.id === call.id);
          if (!row || !mineOnly(row)) return fail({ code: "NOT_FOUND", message: "That entry isn't here." });
          const values = check(test, (call.values ?? {}) as Record<string, unknown>, row);
          const next = { ...row, ...values, updatedAt: new Date().toISOString() };
          test.rows = test.rows.map((item) => item.id === row.id ? next : item);
          return delay(publicRow(next, owner));
        }
        case "remove": {
          if (!owner) return fail({ code: "NOT_ALLOWED", message: "Visitors can't remove entries on this page." });
          test.rows = test.rows.map((item) => item.id === call.id ? { ...item, _deleted: new Date().toISOString() } : item);
          return delay(true);
        }
      }
    },
    ...entries(test),
    // A change to an online entry goes online, then work-fold checks in.
    online: entries(online, () => { publication = { ...publication, dataRevision: (publication.dataRevision ?? 0) + 1, lastCheckIn: new Date().toISOString() }; }),
    async publication(_workFolderId, page) {
      known(page);
      return delay({ available: true, unavailableReason: null, publication: checkedIn() });
    },
    async publish(_workFolderId, page) {
      known(page);
      const stamp = new Date().toISOString();
      publication = { ...publication, status: "online", revision: (publication.revision ?? 0) + 1, publishedAt: stamp, changesAvailable: false, lastCheckIn: stamp };
      return delay({ publication, uploaded: { files: fixturePageFiles.map((file) => ({ ...file })), count: fixturePageFiles.length, bytes: fixturePageFiles.reduce((sum, file) => sum + file.bytes, 0) } }, 900);
    },
    async unpublish(_workFolderId, page) {
      known(page);
      publication = { ...publication, status: "unpublished" };
      return delay(publication, 300);
    },
    async checkIn(_workFolderId, page) {
      known(page);
      publication = { ...publication, lastCheckIn: new Date().toISOString() };
      return delay(publication, 500);
    },
    async published() {
      return delay([{
        workFolderId: fixtureWorkFolderId, workFolderName: fixtureWorkFolderName, path: fixturePagePath, title: "Garden Party RSVP",
        url: publication.url, status: publication.status, publishedAt: publication.publishedAt, changesAvailable: publication.changesAvailable,
      }]);
    },
  };
  return client;
}
