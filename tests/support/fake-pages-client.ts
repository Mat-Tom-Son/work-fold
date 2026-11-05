import type {
  PageCall,
  PageEntriesClient,
  PageProblem,
  PagePublication,
  PagePublicationState,
  PagePublishResult,
  PageRow,
  PagesClient,
  PageTableData,
  PageViewer,
  PublishedPage,
} from "../../web-local/src/lib/pages.js";

/** In-memory entries for the Data view: test entries, or online entries. */
export interface FakeEntries extends PageEntriesClient {
  log: string[];
  rows: PageRow[];
  deleted: PageRow[];
}

export interface FakePagesClient extends PagesClient {
  log: string[];
  calls: Array<{ viewer: PageViewer; call: PageCall }>;
  rows: PageRow[];
  deleted: PageRow[];
  online: FakeEntries;
  /** What the publication route answers; tests change it between reads. */
  state: PagePublicationState;
  publishLog: string[];
  published(): Promise<PublishedPage[]>;
}

export interface FakePagesOptions {
  html?: string | null;
  problems?: Array<{ file: string; message: string; severity: string }>;
  rows?: PageRow[];
  lastSeen?: string | null;
  noTables?: boolean;
  /** Online entries; with none and no publication the page has never been online. */
  onlineRows?: PageRow[];
  onlineLastSeen?: string | null;
  onlineNewCount?: number;
  publication?: PagePublication | null;
  available?: boolean;
  unavailableReason?: string | null;
  /** Replaces the publish answer, for refusals and slow uploads. */
  publish?: (client: FakePagesClient) => Promise<PagePublishResult>;
  publishedPages?: PublishedPage[];
}

const columns = [{ name: "name", type: "text", required: true }, { name: "guests", type: "number" }, { name: "bringing", type: "choice", options: ["Salad", "Dessert", "Drinks"] }];

export function pageRow(id: string, name: string, guests: number, bringing: string | null, createdAt: string): PageRow {
  return { id, createdAt, updatedAt: createdAt, visitor: `v_${id}visitor`, deletedAt: null, name, guests, ...(bringing ? { bringing } : {}), phone: id === "r1" ? "555-0100" : null };
}

export const onlinePublication: PagePublication = {
  url: "https://pages.work-fold.com/p/pg_rhjvpnlqbuw5qowjscvk72pvha",
  status: "online",
  revision: 2,
  publishedAt: "2026-11-04T09:00:00.000Z",
  changesAvailable: false,
  lastCheckIn: new Date(Date.now() - 2 * 60_000).toISOString(),
  dataRevision: 5,
};

function fakeEntries(options: { rows: PageRow[]; lastSeen: string | null; newCount: number; withPhone: boolean; noTables?: boolean }): FakeEntries {
  const entries: FakeEntries = {
    log: [],
    rows: options.rows,
    deleted: [],
    async tables() {
      entries.log.push("tables");
      if (options.noTables) return [];
      return [{ name: "rsvps", retired: false, live: entries.rows.length, deleted: entries.deleted.length, newCount: options.newCount, lastSeen: options.lastSeen }];
    },
    async data(_id, _page, table, deleted): Promise<PageTableData> {
      entries.log.push(`data:${table}:${deleted}`);
      const rows = deleted ? entries.deleted : entries.rows;
      return { table, columns: [...columns, ...(options.withPhone ? [{ name: "phone", type: "text", retired: true }] : [])], rows: [...rows], total: rows.length, lastSeen: options.lastSeen };
    },
    async update(_id, _page, table, id, values) {
      entries.log.push(`update:${table}:${id}:${JSON.stringify(values)}`);
      const row = entries.rows.find((item) => item.id === id)!;
      Object.assign(row, values);
      return row;
    },
    async remove(_id, _page, table, ids) {
      entries.log.push(`remove:${table}:${ids.join(",")}`);
      entries.deleted.push(...entries.rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row, deletedAt: "2026-11-05T12:00:00.000Z" })));
      entries.rows = entries.rows.filter((row) => !ids.includes(row.id));
      return ids.length;
    },
    async restore(_id, _page, table, ids) {
      entries.log.push(`restore:${table}:${ids.join(",")}`);
      entries.rows.push(...entries.deleted.filter((row) => ids.includes(row.id)));
      entries.deleted = entries.deleted.filter((row) => !ids.includes(row.id));
      return ids.length;
    },
    async seen(_id, _page, table) { entries.log.push(`seen:${table}`); return "2026-11-05T13:00:00.000Z"; },
    async exportCsv(_id, _page, table) { entries.log.push(`export:${table}`); return new Blob(["id,name\n"], { type: "text/csv" }); },
  };
  return entries;
}

/** A pages client for renderer tests: one RSVP page, its test entries, and its life online. */
export function fakePagesClient(options: FakePagesOptions = {}): FakePagesClient {
  let visitors = 1;
  const test = fakeEntries({ rows: options.rows ?? [], lastSeen: options.lastSeen ?? null, newCount: 2, withPhone: true, noTables: options.noTables });
  // A page never put online has no data.sqlite, so no online tables either.
  const online = fakeEntries({ rows: options.onlineRows ?? [], lastSeen: options.onlineLastSeen ?? null, newCount: options.onlineNewCount ?? 0, withPhone: false, noTables: options.noTables || (options.onlineRows === undefined && !options.publication) });
  const client: FakePagesClient = {
    log: test.log,
    calls: [],
    get rows() { return test.rows; },
    set rows(value) { test.rows = value; },
    get deleted() { return test.deleted; },
    set deleted(value) { test.deleted = value; },
    online,
    state: { available: options.available ?? true, unavailableReason: options.unavailableReason ?? null, publication: options.publication ?? null },
    publishLog: [],
    async list() { return []; },
    async inspect(_id, page) {
      client.log.push("inspect");
      return {
        page: { path: page, title: "Garden Party RSVP", description: null, entry: "index.html", tables: options.noTables ? [] : [{ name: "rsvps", columns: [{ name: "name", type: "text", required: true }, { name: "guests", type: "number" }, { name: "bringing", type: "choice", options: ["Salad", "Dessert", "Drinks"] }], visitors: ["add"], limit: 50 }] },
        problems: (options.problems ?? []) as PageProblem[],
        summary: { files: 2, bytes: 100 },
      };
    },
    async document() { client.log.push("document"); return { html: options.html === undefined ? "<!doctype html><p>RSVP</p>" : options.html, problems: options.problems ?? [] }; },
    async visitor(_id, _page, fresh) { client.log.push(`visitor:${fresh}`); if (fresh) visitors++; return `v_visitor${String(visitors).padStart(8, "0")}`; },
    async call(_id, _page, viewer, call) { client.calls.push({ viewer, call }); return null; },
    tables: test.tables,
    data: test.data,
    update: test.update,
    remove: test.remove,
    restore: test.restore,
    seen: test.seen,
    exportCsv: test.exportCsv,
    async publication() {
      client.publishLog.push("publication");
      return { ...client.state, publication: client.state.publication ? { ...client.state.publication } : null };
    },
    async publish(_id, page) {
      client.publishLog.push(`publish:${page}`);
      if (options.publish) return options.publish(client);
      const publication: PagePublication = { ...(client.state.publication ?? onlinePublication), status: "online", changesAvailable: false, revision: (client.state.publication?.revision ?? 0) + 1, publishedAt: "2026-11-05T14:00:00.000Z" };
      client.state = { ...client.state, publication };
      return { publication, uploaded: { files: [{ path: "index.html", bytes: 2_410 }, { path: "images/cake.png", bytes: 48_200 }], count: 2, bytes: 50_610 } };
    },
    async unpublish(_id, page) {
      client.publishLog.push(`unpublish:${page}`);
      const publication: PagePublication = { ...(client.state.publication ?? onlinePublication), status: "unpublished" };
      client.state = { ...client.state, publication };
      return publication;
    },
    async checkIn(_id, page) {
      client.publishLog.push(`check-in:${page}`);
      const publication: PagePublication = { ...(client.state.publication ?? onlinePublication), lastCheckIn: new Date().toISOString() };
      client.state = { ...client.state, publication };
      return publication;
    },
    async published() {
      client.publishLog.push("published");
      return options.publishedPages ?? [];
    },
  };
  return client;
}
