/**
 * Identifiers the page service accepts (docs/pages.md, "Identity and links").
 * A page id is `pg_` plus 26 lowercase RFC 4648 base32 characters (130 random
 * bits); an account id is the bridge's account id, a lowercase UUID. Both are
 * checked strictly before they reach a path or a query.
 */
export const pageIdPattern = /^pg_[a-z2-7]{26}$/u;
export const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const visitorCookiePattern = /^v_[0-9a-f]{32}$/u;

export function isPageId(value: unknown): value is string {
  return typeof value === "string" && pageIdPattern.test(value);
}

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && accountIdPattern.test(value);
}

/** What logs show of a page id: its first 8 characters, never the whole link. */
export function shortPageId(pageId: string): string {
  return pageId.slice(0, 8);
}
