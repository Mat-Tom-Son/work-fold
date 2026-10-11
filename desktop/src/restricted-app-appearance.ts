import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shell's look, handed to every app view as CSS custom properties so an
 * app can match work-fold without copying colors (2026-10-11). The trusted
 * renderer reads these from its own live styles, so they follow the theme,
 * the work-folder's accent, and the person's appearance choices.
 */
export const restrictedAppAppearanceTokens = [
  "--wf-font",
  "--wf-font-size",
  "--wf-canvas",
  "--wf-surface",
  "--wf-surface-subtle",
  "--wf-surface-hover",
  "--wf-text",
  "--wf-text-muted",
  "--wf-text-subtle",
  "--wf-border",
  "--wf-border-strong",
  "--wf-accent",
  "--wf-on-accent",
  "--wf-accent-soft",
  "--wf-accent-text",
  "--wf-focus",
  "--wf-success",
  "--wf-danger",
  "--wf-attention",
  "--wf-radius-sm",
  "--wf-radius-md",
  "--wf-radius-lg",
  "--wf-shadow",
] as const;

export type RestrictedAppAppearanceToken = typeof restrictedAppAppearanceTokens[number];
export type RestrictedAppAppearance = Partial<Record<RestrictedAppAppearanceToken, string>>;

const tokenNames = new Set<string>(restrictedAppAppearanceTokens);
const maxTokenValueLength = 400;
// Colors (including color-mix and rgb), lengths, shadows, and font stacks.
// No braces, semicolons, angle brackets, escapes, at-rules, comments, or URLs.
const safeTokenValue = /^[\w \t#(),.%+\-/"']+$/;
const unsafeTokenFunction = /\b(?:url|image|image-set|element|cross-fade|env|attr)\s*\(/i;

/**
 * Keeps only known tokens with plain values. A token that fails is dropped,
 * not fatal: the app falls back to its own value for that one variable and
 * the view still mounts.
 */
export function parseRestrictedAppAppearance(value: unknown): RestrictedAppAppearance | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app appearance must be an object.");
  const appearance: RestrictedAppAppearance = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!tokenNames.has(name) || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > maxTokenValueLength || !safeTokenValue.test(trimmed) || unsafeTokenFunction.test(trimmed)
      || (trimmed.split('"').length - 1) % 2 !== 0 || (trimmed.split("'").length - 1) % 2 !== 0) continue;
    appearance[name as RestrictedAppAppearanceToken] = trimmed;
  }
  return appearance;
}

const interFace = (file: string, unicodeRange: string) => `@font-face{font-family:"work-fold Inter";font-style:normal;font-display:swap;font-weight:100 900;src:url("/__work-fold/fonts/${file}") format("woff2-variations");unicode-range:${unicodeRange};}`;

const fontFaces = [
  interFace("inter-latin-ext-wght-normal.woff2", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"),
  interFace("inter-latin-wght-normal.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"),
].join("");

/**
 * Variables only: nothing here restyles an app that does not use them. The
 * opt-in kit at /__work-fold/kit.css applies them to elements.
 */
export function restrictedAppAppearanceCss(theme: "light" | "dark", appearance: RestrictedAppAppearance | undefined): string {
  const declarations = [`--wf-theme:${theme};`, `--wf-color-scheme:${theme};`];
  for (const name of restrictedAppAppearanceTokens) {
    const value = appearance?.[name];
    if (value) declarations.push(`${name}:${value};`);
  }
  return `${fontFaces}:root{${declarations.join("")}}`;
}

export interface RestrictedAppKitAsset {
  bytes: Buffer;
  contentType: string;
}

/** Files served on every app view's own origin under /__work-fold/. */
const kitFiles: Record<string, string> = {
  "kit.css": "text/css; charset=utf-8",
  "fonts/inter-latin-wght-normal.woff2": "font/woff2",
  "fonts/inter-latin-ext-wght-normal.woff2": "font/woff2",
};

export function loadRestrictedAppKit(root: string | undefined): Map<string, RestrictedAppKitAsset> {
  const assets = new Map<string, RestrictedAppKitAsset>();
  if (!root) return assets;
  for (const [path, contentType] of Object.entries(kitFiles)) {
    try {
      assets.set(path, { bytes: readFileSync(join(root, path)), contentType });
    } catch {
      // A missing staged file is a 404 for that path, never a failed mount.
    }
  }
  return assets;
}
