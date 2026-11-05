/**
 * Pages (docs/pages.md): the page.json declaration, value checks, the rules
 * engine for page calls and the owner's Data view, and additive schema
 * updates over a small synchronous SQL interface. No Node imports, so the
 * desktop, the renderer, and the hosted service can share this code.
 */
export * from "./page-declaration.js";
export * from "./page-errors.js";
export * from "./page-values.js";
export * from "./page-sql.js";
export * from "./page-schema.js";
export * from "./page-data.js";
export { pageSha256Hex } from "./page-sha256.js";

/** One problem the page tab and `pages validate` show: the file it's in, and a plain message. */
export interface PageProblem {
  /** Page-folder-relative file (or folder) the problem is about; "" for the page folder itself. */
  file: string;
  message: string;
  severity: "error" | "warning";
}

/** What `GET …/pages/inspect` and `pages validate` report about one page folder. */
export interface PageInspection {
  page: {
    /** The page folder's work-folder-relative path. */
    path: string;
    title: string;
    description: string | null;
    entry: string;
    tables: import("./page-declaration.js").PageTableDeclaration[];
  };
  problems: PageProblem[];
  summary: { files: number; bytes: number };
}
