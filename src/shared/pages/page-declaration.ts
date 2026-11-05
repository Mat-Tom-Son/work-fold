/**
 * `page.json`: what a page is and what it collects (docs/pages.md, "page.json").
 * Parsing is strict: every field is checked and unknown fields anywhere are
 * errors that name the field's path, so a mistake is reported instead of being
 * silently ignored. Plain TypeScript with no Node imports, so the hosted
 * service can run the same code later.
 */
import { pageSha256Hex } from "./page-sha256.js";

export const pageFormat = "work-fold.page/1";

export const pageColumnTypes = ["text", "long-text", "number", "boolean", "date", "email", "url", "choice"] as const;
export type PageColumnType = (typeof pageColumnTypes)[number];

export const pageVisitorPermissions = ["add", "see-own", "see-all", "edit-own", "delete-own"] as const;
export type PageVisitorPermission = (typeof pageVisitorPermissions)[number];

/** Bounds from the contract, in one place for the parser, the validator, and docs. */
export const pageDeclarationLimits = Object.freeze({
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  maxEntryLength: 512,
  maxTables: 16,
  maxColumns: 64,
  minRowLimit: 1,
  maxRowLimit: 100_000,
  defaultRowLimit: 10_000,
  defaultTextMax: 500,
  maxTextMax: 10_000,
  defaultLongTextMax: 10_000,
  maxLongTextMax: 100_000,
  maxChoiceOptions: 100,
  maxChoiceOptionLength: 500,
});

/** Table and column names. Never starting with `_`: work-fold's own columns do. */
export const pageNamePattern = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * Column names a row already uses for itself: a row is
 * `{ id, createdAt, updatedAt, ...columns }`, and the owner also sees
 * `visitor`. `createdAt`/`updatedAt` cannot match the name pattern.
 */
export const reservedPageColumnNames: ReadonlySet<string> = new Set(["id", "visitor"]);

export interface PageColumnDeclaration {
  name: string;
  type: PageColumnType;
  required: boolean;
  unique: boolean;
  /** `text` and `long-text`: maximum length in characters (always set for those types). `number`: the largest allowed value. */
  max?: number;
  /** `number` only. */
  min?: number;
  /** `number` only: whole numbers only. */
  integer?: boolean;
  /** `choice` only. */
  options?: string[];
}

export interface PageTableDeclaration {
  name: string;
  columns: PageColumnDeclaration[];
  visitors: PageVisitorPermission[];
  limit: number;
}

/** A parsed, normalized `page.json`. Tables and columns keep their declared order. */
export interface PageDeclaration {
  format: typeof pageFormat;
  title: string;
  description?: string;
  entry: string;
  tables: PageTableDeclaration[];
}

/** One problem in `page.json`: the field's path (`tables.rsvps.columns.email.type`) and a plain message. */
export interface PageDeclarationProblem {
  path: string;
  message: string;
}

export type PageDeclarationParseResult =
  | { ok: true; declaration: PageDeclaration; problems: [] }
  | { ok: false; problems: PageDeclarationProblem[] };

/** Parses `page.json` text. A leading byte-order mark is allowed. */
export function parsePageDeclarationText(text: string): PageDeclarationParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [{ path: "", message: `page.json isn't valid JSON: ${detail}` }] };
  }
  return parsePageDeclaration(value);
}

/** Validates an already-parsed `page.json` value. */
export function parsePageDeclaration(value: unknown): PageDeclarationParseResult {
  const problems: PageDeclarationProblem[] = [];
  const problem = (path: string, message: string) => { problems.push({ path, message }); };
  if (!isPlainObject(value)) {
    return { ok: false, problems: [{ path: "", message: "page.json must be a JSON object." }] };
  }
  rejectUnknown(value, ["format", "title", "description", "entry", "tables"], "", problem);

  if (!("format" in value)) problem("format", `is required and must be "${pageFormat}".`);
  else if (value.format !== pageFormat) problem("format", `must be exactly "${pageFormat}".`);

  let title = "";
  if (!("title" in value)) problem("title", "is required.");
  else if (typeof value.title !== "string") problem("title", "must be text.");
  else {
    title = value.title.trim();
    if (!title) problem("title", "can't be empty.");
    else if (characterLength(title) > pageDeclarationLimits.maxTitleLength) {
      problem("title", `must be at most ${pageDeclarationLimits.maxTitleLength} characters.`);
    }
  }

  let description: string | undefined;
  if ("description" in value) {
    if (typeof value.description !== "string") problem("description", "must be text.");
    else if (characterLength(value.description) > pageDeclarationLimits.maxDescriptionLength) {
      problem("description", `must be at most ${pageDeclarationLimits.maxDescriptionLength} characters.`);
    } else if (value.description.trim()) description = value.description.trim();
  }

  let entry = "index.html";
  if ("entry" in value) {
    const entryProblem = pageEntryProblem(value.entry);
    if (entryProblem) problem("entry", entryProblem);
    else entry = value.entry as string;
  }

  const tables: PageTableDeclaration[] = [];
  if ("tables" in value) {
    if (!isPlainObject(value.tables)) problem("tables", "must be an object mapping table names to tables.");
    else {
      const names = Object.keys(value.tables);
      if (names.length > pageDeclarationLimits.maxTables) {
        problem("tables", `can have at most ${pageDeclarationLimits.maxTables} tables (found ${names.length}).`);
      }
      for (const name of names) {
        const table = parseTable(name, (value.tables as Record<string, unknown>)[name], `tables.${name}`, problem);
        if (table) tables.push(table);
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    declaration: { format: pageFormat, title, ...(description !== undefined ? { description } : {}), entry, tables },
    problems: [],
  };
}

function parseTable(
  name: string,
  value: unknown,
  path: string,
  problem: (path: string, message: string) => void,
): PageTableDeclaration | null {
  let ok = true;
  if (!pageNamePattern.test(name)) {
    problem(path, "table names use lowercase letters, digits, and underscores, start with a letter, and are at most 41 characters.");
    ok = false;
  } else if (name.startsWith("sqlite_")) {
    problem(path, "table names can't start with \"sqlite_\"; the database keeps those for itself.");
    ok = false;
  }
  if (!isPlainObject(value)) {
    problem(path, "must be an object with columns.");
    return null;
  }
  rejectUnknown(value, ["columns", "visitors", "limit"], path, problem);

  const columns: PageColumnDeclaration[] = [];
  if (!("columns" in value)) {
    problem(`${path}.columns`, "is required: a table needs at least one column.");
    ok = false;
  } else if (!isPlainObject(value.columns)) {
    problem(`${path}.columns`, "must be an object mapping column names to columns.");
    ok = false;
  } else {
    const names = Object.keys(value.columns);
    if (!names.length) {
      problem(`${path}.columns`, "needs at least one column.");
      ok = false;
    } else if (names.length > pageDeclarationLimits.maxColumns) {
      problem(`${path}.columns`, `can have at most ${pageDeclarationLimits.maxColumns} columns (found ${names.length}).`);
      ok = false;
    }
    for (const columnName of names) {
      const column = parseColumn(columnName, (value.columns as Record<string, unknown>)[columnName], `${path}.columns.${columnName}`, problem);
      if (column) columns.push(column);
      else ok = false;
    }
  }

  const visitors: PageVisitorPermission[] = [];
  if ("visitors" in value) {
    if (!Array.isArray(value.visitors)) {
      problem(`${path}.visitors`, `must be a list of: ${pageVisitorPermissions.join(", ")}.`);
      ok = false;
    } else {
      value.visitors.forEach((permission, index) => {
        if (typeof permission !== "string" || !(pageVisitorPermissions as readonly string[]).includes(permission)) {
          problem(`${path}.visitors[${index}]`, `must be one of: ${pageVisitorPermissions.join(", ")}.`);
          ok = false;
        } else if (visitors.includes(permission as PageVisitorPermission)) {
          problem(`${path}.visitors[${index}]`, `"${permission}" is listed twice.`);
          ok = false;
        } else {
          visitors.push(permission as PageVisitorPermission);
        }
      });
    }
  }

  let limit: number = pageDeclarationLimits.defaultRowLimit;
  if ("limit" in value) {
    if (!isWholeNumber(value.limit) || value.limit < pageDeclarationLimits.minRowLimit || value.limit > pageDeclarationLimits.maxRowLimit) {
      problem(`${path}.limit`, `must be a whole number from ${pageDeclarationLimits.minRowLimit} to ${pageDeclarationLimits.maxRowLimit.toLocaleString("en-US")}.`);
      ok = false;
    } else {
      limit = value.limit;
    }
  }
  return ok ? { name, columns, visitors, limit } : null;
}

const commonColumnFields = ["type", "required", "unique"];
const extraColumnFields: Record<PageColumnType, string[]> = {
  "text": ["max"],
  "long-text": ["max"],
  "number": ["min", "max", "integer"],
  "boolean": [],
  "date": [],
  "email": [],
  "url": [],
  "choice": ["options"],
};

function parseColumn(
  name: string,
  value: unknown,
  path: string,
  problem: (path: string, message: string) => void,
): PageColumnDeclaration | null {
  let ok = true;
  if (!pageNamePattern.test(name)) {
    problem(path, "column names use lowercase letters, digits, and underscores, start with a letter, and are at most 41 characters.");
    ok = false;
  } else if (reservedPageColumnNames.has(name)) {
    problem(path, `"${name}" is used by work-fold for every row; choose another column name.`);
    ok = false;
  }
  if (!isPlainObject(value)) {
    problem(path, `must be an object with a "type".`);
    return null;
  }
  if (!("type" in value)) {
    problem(`${path}.type`, `is required: one of ${pageColumnTypes.join(", ")}.`);
    rejectUnknown(value, [...commonColumnFields, ...new Set(Object.values(extraColumnFields).flat())], path, problem);
    return null;
  }
  if (typeof value.type !== "string" || !(pageColumnTypes as readonly string[]).includes(value.type)) {
    problem(`${path}.type`, `must be one of: ${pageColumnTypes.join(", ")}.`);
    return null;
  }
  const type = value.type as PageColumnType;
  const allowed = [...commonColumnFields, ...extraColumnFields[type]];
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const usedBy = pageColumnTypes.filter((candidate) => extraColumnFields[candidate].includes(key));
    problem(`${path}.${key}`, usedBy.length
      ? `isn't used by "${type}" columns (only by ${usedBy.map((candidate) => `"${candidate}"`).join(", ")}).`
      : "isn't a known field.");
    ok = false;
  }
  const column: PageColumnDeclaration = { name, type, required: false, unique: false };
  for (const flag of ["required", "unique"] as const) {
    if (!(flag in value)) continue;
    if (typeof value[flag] !== "boolean") {
      problem(`${path}.${flag}`, "must be true or false.");
      ok = false;
    } else {
      column[flag] = value[flag] as boolean;
    }
  }

  if (type === "text" || type === "long-text") {
    const fallback = type === "text" ? pageDeclarationLimits.defaultTextMax : pageDeclarationLimits.defaultLongTextMax;
    const ceiling = type === "text" ? pageDeclarationLimits.maxTextMax : pageDeclarationLimits.maxLongTextMax;
    column.max = fallback;
    if ("max" in value) {
      if (!isWholeNumber(value.max) || value.max < 1 || value.max > ceiling) {
        problem(`${path}.max`, `must be a whole number from 1 to ${ceiling.toLocaleString("en-US")}.`);
        ok = false;
      } else {
        column.max = value.max;
      }
    }
  }
  if (type === "number") {
    for (const bound of ["min", "max"] as const) {
      if (!(bound in value)) continue;
      const bound_ = value[bound];
      if (typeof bound_ !== "number" || !Number.isFinite(bound_)) {
        problem(`${path}.${bound}`, "must be a number.");
        ok = false;
      } else {
        column[bound] = bound_;
      }
    }
    if ("integer" in value) {
      if (typeof value.integer !== "boolean") {
        problem(`${path}.integer`, "must be true or false.");
        ok = false;
      } else if (value.integer) {
        column.integer = true;
      }
    }
    if (column.min !== undefined && column.max !== undefined && column.min > column.max) {
      problem(`${path}.min`, "can't be larger than max.");
      ok = false;
    }
  }
  if (type === "choice") {
    if (!("options" in value)) {
      problem(`${path}.options`, `is required for "choice" columns: a list of 1–${pageDeclarationLimits.maxChoiceOptions} distinct strings.`);
      ok = false;
    } else if (!Array.isArray(value.options) || !value.options.length || value.options.length > pageDeclarationLimits.maxChoiceOptions) {
      problem(`${path}.options`, `must be a list of 1–${pageDeclarationLimits.maxChoiceOptions} distinct strings.`);
      ok = false;
    } else {
      const options: string[] = [];
      value.options.forEach((option, index) => {
        if (typeof option !== "string" || !option.trim()) {
          problem(`${path}.options[${index}]`, "must be non-empty text.");
          ok = false;
        } else if (characterLength(option) > pageDeclarationLimits.maxChoiceOptionLength) {
          problem(`${path}.options[${index}]`, `must be at most ${pageDeclarationLimits.maxChoiceOptionLength} characters.`);
          ok = false;
        } else if (options.includes(option)) {
          problem(`${path}.options[${index}]`, `"${option}" is listed twice.`);
          ok = false;
        } else {
          options.push(option);
        }
      });
      column.options = options;
    }
  }
  return ok ? column : null;
}

/**
 * Why an `entry` value is unusable, or null: a relative `.html` path inside the
 * page folder, with no hidden, empty, `.`, or `..` segments.
 */
export function pageEntryProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "must be a relative path to an .html file in the page folder.";
  if (value.length > pageDeclarationLimits.maxEntryLength) return `must be at most ${pageDeclarationLimits.maxEntryLength} characters.`;
  if (/[\u0000-\u001f\u007f\\]/u.test(value) || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    return "must be a relative path to an .html file in the page folder.";
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    return "must stay inside the page folder and can't name hidden files.";
  }
  if (!/\.html$/iu.test(value)) return "must name an .html file.";
  return null;
}

/** The declaration as canonical JSON: fixed key order, so equal declarations hash equally. */
export function canonicalPageDeclaration(declaration: PageDeclaration): string {
  return JSON.stringify({
    format: declaration.format,
    title: declaration.title,
    description: declaration.description ?? null,
    entry: declaration.entry,
    tables: declaration.tables.map((table) => ({
      name: table.name,
      limit: table.limit,
      visitors: [...table.visitors].sort(),
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        required: column.required,
        unique: column.unique,
        max: column.max ?? null,
        min: column.min ?? null,
        integer: column.integer ?? false,
        options: column.options ?? null,
      })),
    })),
  });
}

/** The declaration back in page.json's own shape; `parsePageDeclaration` reads it back unchanged. */
export function pageDeclarationToJson(declaration: PageDeclaration): Record<string, unknown> {
  const tables: Record<string, unknown> = {};
  for (const table of declaration.tables) {
    const columns: Record<string, unknown> = {};
    for (const column of table.columns) {
      columns[column.name] = {
        type: column.type,
        ...(column.required ? { required: true } : {}),
        ...(column.unique ? { unique: true } : {}),
        ...(column.max !== undefined ? { max: column.max } : {}),
        ...(column.min !== undefined ? { min: column.min } : {}),
        ...(column.integer ? { integer: true } : {}),
        ...(column.options ? { options: [...column.options] } : {}),
      };
    }
    tables[table.name] = { columns, visitors: [...table.visitors], limit: table.limit };
  }
  return {
    format: declaration.format,
    title: declaration.title,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    entry: declaration.entry,
    tables,
  };
}

/** Lowercase hex SHA-256 of the canonical declaration; recorded in `_page_meta`. */
export function pageDeclarationDigest(declaration: PageDeclaration): string {
  return pageSha256Hex(canonicalPageDeclaration(declaration));
}

export function findPageTable(declaration: PageDeclaration, name: string): PageTableDeclaration | undefined {
  return declaration.tables.find((table) => table.name === name);
}

/** "tables.rsvps.columns.email.type: must be …", or just the message for the whole file. */
export function formatPageDeclarationProblem(problem: PageDeclarationProblem): string {
  return problem.path ? `${problem.path}: ${problem.message}` : problem.message;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problem: (path: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problem(path ? `${path}.${key}` : key, "isn't a known field.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Length in Unicode characters (code points), not UTF-16 units. */
export function characterLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}
