/**
 * Checks and normalizes one column value against its declaration
 * (docs/pages.md, "Column types"). Empty strings count as missing. A value
 * comes back in the form it is stored in: text as given (one-line `text`
 * trimmed), emails trimmed and lower-cased, numbers as numbers, booleans as
 * true/false (the SQL layer binds them as 1/0), and missing as null.
 */
import type { PageColumnDeclaration, PageTableDeclaration } from "./page-declaration.js";
import { characterLength } from "./page-declaration.js";
import { PageCallError } from "./page-errors.js";

export type PageValue = string | number | boolean | null;

/** Size bound for one call's values, measured as UTF-8 JSON. */
export const pageCallLimits = Object.freeze({
  maxValuesBytes: 1024 * 1024,
  maxEmailLength: 254,
  maxUrlLength: 2_048,
  maxDateLength: 64,
});

const lineBreak = /[\r\n\u2028\u2029]/u;
const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u;
const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/u;
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const decimalNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** True when a value counts as missing: absent, null, or an empty (or blank) string. */
export function isMissingPageValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/**
 * Normalizes one value for `column`, or refuses with INVALID naming the column.
 * Missing values come back as null; whether they're allowed is the caller's
 * call (required columns on add and update).
 */
export function normalizePageValue(column: PageColumnDeclaration, value: unknown): PageValue {
  if (isMissingPageValue(value)) return null;
  const field = column.name;
  switch (column.type) {
    case "text":
    case "long-text": {
      if (typeof value !== "string") throw invalid(field, `${field} must be text.`);
      if (value.includes("\u0000")) throw invalid(field, `${field} contains characters that can't be saved.`);
      const text = column.type === "text" ? value.trim() : value;
      if (column.type === "text" && lineBreak.test(text)) throw invalid(field, `${field} must be a single line.`);
      const max = column.max ?? Number.POSITIVE_INFINITY;
      if (characterLength(text) > max) throw invalid(field, `${field} can be at most ${max.toLocaleString("en-US")} characters.`);
      return text;
    }
    case "number": {
      let number: number;
      if (typeof value === "number") number = value;
      else if (typeof value === "string" && decimalNumber.test(value.trim())) number = Number(value.trim());
      else throw invalid(field, `${field} must be a number.`);
      if (!Number.isFinite(number)) throw invalid(field, `${field} must be a number.`);
      if (column.integer && !Number.isInteger(number)) throw invalid(field, `${field} must be a whole number.`);
      if (column.min !== undefined && number < column.min) throw invalid(field, `${field} must be at least ${column.min}.`);
      if (column.max !== undefined && number > column.max) throw invalid(field, `${field} must be at most ${column.max}.`);
      return Object.is(number, -0) ? 0 : number;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw invalid(field, `${field} must be true or false.`);
    }
    case "date": {
      if (typeof value !== "string") throw invalid(field, `${field} must be a date.`);
      const text = value.trim();
      if (text.length > pageCallLimits.maxDateLength || !isValidPageDate(text)) {
        throw invalid(field, `${field} must be a date like 2026-11-05 or a date and time like 2026-11-05T18:30.`);
      }
      return text;
    }
    case "email": {
      if (typeof value !== "string") throw invalid(field, `${field} must be an email address.`);
      const email = value.trim().toLowerCase();
      if (email.length > pageCallLimits.maxEmailLength || !emailShape.test(email)) {
        throw invalid(field, `${field} must be an email address.`);
      }
      return email;
    }
    case "url": {
      if (typeof value !== "string") throw invalid(field, `${field} must be a web address.`);
      const text = value.trim();
      let parsed: URL | null = null;
      try { parsed = new URL(text); } catch { parsed = null; }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || text.length > pageCallLimits.maxUrlLength || /\s/u.test(text)) {
        throw invalid(field, `${field} must be a web address starting with http:// or https://.`);
      }
      return text;
    }
    case "choice": {
      if (typeof value !== "string") throw invalid(field, `${field} must be one of: ${(column.options ?? []).join(", ")}.`);
      const option = (column.options ?? []).find((candidate) => candidate === value || candidate === value.trim());
      if (option === undefined) throw invalid(field, `${field} must be one of: ${(column.options ?? []).join(", ")}.`);
      return option;
    }
  }
}

/** `YYYY-MM-DD` naming a real calendar day, or an ISO date-time on one. */
export function isValidPageDate(text: string): boolean {
  const day = isoDate.exec(text) ?? isoDateTime.exec(text);
  if (!day) return false;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const date = Number(day[3]);
  if (month < 1 || month > 12 || date < 1 || date > daysInMonth(year, month)) return false;
  if (day.length > 4 && day[4] !== undefined) {
    const hours = Number(day[4]);
    const minutes = Number(day[5]);
    const seconds = day[6] === undefined ? 0 : Number(day[6]);
    if (hours > 23 || minutes > 59 || seconds > 59) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Checks a whole `values` object for one table: undeclared columns are refused,
 * every given value is normalized, and (for a new row) every required column
 * must be present. Returns only the columns that were given, normalized.
 */
export function normalizePageValues(
  table: PageTableDeclaration,
  values: unknown,
  mode: "add" | "update",
): Map<string, PageValue> {
  if (values === undefined || values === null) values = {};
  if (typeof values !== "object" || Array.isArray(values)) throw invalid(undefined, "Values must be an object of column names and values.");
  const encodedLength = new TextEncoder().encode(JSON.stringify(values) ?? "").length;
  if (encodedLength > pageCallLimits.maxValuesBytes) {
    throw new PageCallError("TOO_LARGE", `This entry is too large: it can be at most ${pageCallLimits.maxValuesBytes / (1024 * 1024)} MiB.`);
  }
  const given = values as Record<string, unknown>;
  const normalized = new Map<string, PageValue>();
  for (const key of Object.keys(given)) {
    const column = table.columns.find((candidate) => candidate.name === key);
    if (!column) throw invalid(key, `This page doesn't collect "${key}".`);
    const value = normalizePageValue(column, given[key]);
    if (value === null && column.required) throw invalid(key, `${key} is required.`);
    normalized.set(key, value);
  }
  if (mode === "add") {
    for (const column of table.columns) {
      if (column.required && !normalized.has(column.name)) throw invalid(column.name, `${column.name} is required.`);
    }
  }
  return normalized;
}

function invalid(field: string | undefined, message: string): PageCallError {
  return new PageCallError("INVALID", message, field);
}
