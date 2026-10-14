/** Identify an outbound capability source without loading remote artwork. */
export function externalLinkHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
