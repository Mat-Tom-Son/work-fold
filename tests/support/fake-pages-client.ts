import type {
  PageCall,
  PageProblem,
  PageRow,
  PagesClient,
  PageTableData,
  PageViewer,
} from "../../web-local/src/lib/pages.js";

export interface FakePagesClient extends PagesClient {
  log: string[];
  calls: Array<{ viewer: PageViewer; call: PageCall }>;
  rows: PageRow[];
  deleted: PageRow[];
}

export interface FakePagesOptions {
  html?: string | null;
  problems?: Array<{ file: string; message: string; severity: string }>;
  rows?: PageRow[];
  lastSeen?: string | null;
  noTables?: boolean;
}

const columns = [{ name: "name", type: "text", required: true }, { name: "guests", type: "number" }, { name: "bringing", type: "choice", options: ["Salad", "Dessert", "Drinks"] }];

export function pageRow(id: string, name: string, guests: number, bringing: string | null, createdAt: string): PageRow {
  return { id, createdAt, updatedAt: createdAt, visitor: `v_${id}visitor`, deletedAt: null, name, guests, ...(bringing ? { bringing } : {}), phone: id === "r1" ? "555-0100" : null };
}

/** A pages client for renderer tests: one RSVP page and the entries made in its Preview. */
export function fakePagesClient(options: FakePagesOptions = {}): FakePagesClient {
  let visitors = 1;
  const lastSeen = options.lastSeen ?? null;
  const client: FakePagesClient = {
    log: [],
    calls: [],
    rows: options.rows ?? [],
    deleted: [],
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
    async tables() {
      client.log.push("tables");
      if (options.noTables) return [];
      return [{ name: "rsvps", retired: false, live: client.rows.length, deleted: client.deleted.length, newCount: 2, lastSeen }];
    },
    async data(_id, _page, table, deleted): Promise<PageTableData> {
      client.log.push(`data:${table}:${deleted}`);
      const rows = deleted ? client.deleted : client.rows;
      return { table, columns: [...columns, { name: "phone", type: "text", retired: true }], rows: [...rows], total: rows.length, lastSeen };
    },
    async update(_id, _page, table, id, values) {
      client.log.push(`update:${table}:${id}:${JSON.stringify(values)}`);
      const row = client.rows.find((item) => item.id === id)!;
      Object.assign(row, values);
      return row;
    },
    async remove(_id, _page, table, ids) {
      client.log.push(`remove:${table}:${ids.join(",")}`);
      client.deleted.push(...client.rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row, deletedAt: "2026-11-05T12:00:00.000Z" })));
      client.rows = client.rows.filter((row) => !ids.includes(row.id));
      return ids.length;
    },
    async restore(_id, _page, table, ids) {
      client.log.push(`restore:${table}:${ids.join(",")}`);
      client.rows.push(...client.deleted.filter((row) => ids.includes(row.id)));
      client.deleted = client.deleted.filter((row) => !ids.includes(row.id));
      return ids.length;
    },
    async seen(_id, _page, table) { client.log.push(`seen:${table}`); return "2026-11-05T13:00:00.000Z"; },
    async exportCsv(_id, _page, table) { client.log.push(`export:${table}`); return new Blob(["id,name\n"], { type: "text/csv" }); },
  };
  return client;
}
