/** Loopback development uses a query-selected account; production uses its host. */
export function browserApiPath(path, href) {
  const page = new URL(href);
  const slug = page.searchParams.get("slug");
  if (!slug || !["localhost", "127.0.0.1"].includes(page.hostname)) return path;
  const target = new URL(path, page);
  if (target.origin !== page.origin || !target.pathname.startsWith("/api/")) return path;
  target.searchParams.set("slug", slug);
  return target.pathname + target.search;
}
