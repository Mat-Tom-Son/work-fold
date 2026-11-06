/**
 * Refusals a page call can end in (docs/pages.md, "What a page's code can
 * use"). `message` is plain English a page can show to its visitors; `field`
 * names the column an INVALID or DUPLICATE refusal is about.
 */
export const pageCallErrorCodes = [
  "NOT_ALLOWED",
  "INVALID",
  "DUPLICATE",
  "LIMIT_REACHED",
  "NOT_FOUND",
  "TOO_LARGE",
  "UNAVAILABLE",
] as const;
export type PageCallErrorCode = (typeof pageCallErrorCodes)[number];

export interface PageCallErrorShape {
  code: PageCallErrorCode;
  message: string;
  field?: string;
}

export class PageCallError extends Error {
  readonly code: PageCallErrorCode;
  readonly field?: string;

  constructor(code: PageCallErrorCode, message: string, field?: string) {
    super(message);
    this.name = "PageCallError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }

  toJSON(): PageCallErrorShape {
    return { code: this.code, message: this.message, ...(this.field !== undefined ? { field: this.field } : {}) };
  }
}

export function isPageCallError(value: unknown): value is PageCallError {
  return value instanceof PageCallError;
}
