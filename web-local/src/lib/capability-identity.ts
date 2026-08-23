/**
 * Network-free identity for catalog and installed tools. Catalog entries carry
 * no artwork and the renderer's CSP keeps remote images out, so a tool's tile
 * is its initials on a hue derived from its name.
 */

export function monogramInitials(name: string): string {
  const words = name.replace(/^@[^/]+\//, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) {
    const word = words[0]!;
    // Split camelCase and pi-prefixed names ("piReview", "pitutorial") less aggressively: first two letters.
    const camel = word.match(/^(\p{L})[^\p{Lu}]*(\p{Lu})/u);
    return (camel ? `${camel[1]}${camel[2]}` : word.slice(0, 2)).toLocaleUpperCase();
  }
  return `${words[0]![0]}${words[1]![0]}`.toLocaleUpperCase();
}

export function monogramHue(name: string): number {
  let hash = 0;
  for (const char of name.toLocaleLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) % 360_007;
  // Eight well-separated hues read as distinct on both themes.
  return [212, 262, 322, 12, 36, 150, 180, 95][hash % 8]!;
}

export function externalLinkHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
