import { accentIdentityFromHex, resolveAccent } from "./space-appearance.js";

export const applicationAppearanceKey = "work-fold.application-appearance.v1";
export const applicationPresetsKey = "work-fold.appearance-presets.v1";
export const appearancePresetKind = "work-fold.appearance-preset";
export const appearanceChoices = {
  mode: ["system", "light", "dark"],
  palette: ["original", "paper", "neutral", "slate", "ink"],
  font: ["default", "stable", "verdana", "aptos"],
  textSize: ["compact", "standard", "comfortable", "large"],
  readingFont: ["app", "serif", "system"],
  codeFont: ["system", "menlo", "consolas"],
  density: ["compact", "standard", "spacious"],
  measure: ["focused", "standard", "wide"],
  spacing: ["tight", "standard", "relaxed"],
  messages: ["tinted", "quiet"],
  contrast: ["system", "more"],
  motion: ["system", "reduce"],
  transparency: ["system", "opaque"],
} as const;
type Choice<K extends keyof typeof appearanceChoices> = typeof appearanceChoices[K][number];
export type ApplicationAppearance = { version: 1; accent: "system" | string; readingSize: number } & {
  [K in keyof typeof appearanceChoices]: Choice<K>;
};
export interface AppearancePreset { kind: typeof appearancePresetKind; version: 1; name: string; preferences: ApplicationAppearance }
export const defaultApplicationAppearance: ApplicationAppearance = {
  version: 1, mode: "dark", palette: "original", accent: "system", font: "default", textSize: "standard",
  readingFont: "app", readingSize: 15, codeFont: "system", density: "standard", measure: "standard",
  spacing: "standard", messages: "tinted", contrast: "system", motion: "system", transparency: "system",
};

/** Closed values only: proposals cannot introduce executable style or external resources. */
export function parseApplicationAppearance(raw: unknown): ApplicationAppearance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a work-fold appearance preset file.");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new Error("This appearance version is not supported by this build.");
  const allowed = new Set(["version", "accent", "readingSize", ...Object.keys(appearanceChoices)]);
  if (Object.keys(r).some((key) => !allowed.has(key))) throw new Error("This appearance file contains unknown settings.");
  for (const [key, values] of Object.entries(appearanceChoices)) {
    if (!(values as readonly unknown[]).includes(r[key])) throw new Error(`Invalid appearance setting: ${key}.`);
  }
  if (r.accent !== "system" && !(typeof r.accent === "string" && /^#[0-9a-f]{6}$/i.test(r.accent))) throw new Error("Choose an accent in #RRGGBB format.");
  if (!Number.isInteger(r.readingSize) || Number(r.readingSize) < 14 || Number(r.readingSize) > 22) throw new Error("Conversation text must be between 14 and 22 px.");
  return { ...r, accent: String(r.accent).toLowerCase() } as ApplicationAppearance;
}

export function parseAppearancePreset(raw: unknown): AppearancePreset {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a work-fold appearance preset file.");
  const r = raw as Record<string, unknown>;
  if (r.kind !== appearancePresetKind || r.version !== 1 || Object.keys(r).some((key) => !["kind", "version", "name", "preferences"].includes(key))) throw new Error("Choose a supported work-fold appearance preset file.");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.trim().length > 60 || /[\u0000-\u001f]/.test(r.name)) throw new Error("Give the preset a name of 1–60 characters.");
  return { kind: appearancePresetKind, version: 1, name: r.name.trim(), preferences: parseApplicationAppearance(r.preferences) };
}

export function migrateApplicationAppearance(theme: unknown, typography: unknown): ApplicationAppearance {
  const r = typography && typeof typography === "object" ? typography as Record<string, unknown> : {};
  return { ...defaultApplicationAppearance,
    mode: appearanceChoices.mode.includes(theme as Choice<"mode">) ? theme as Choice<"mode"> : defaultApplicationAppearance.mode,
    font: appearanceChoices.font.includes(r.font as Choice<"font">) ? r.font as Choice<"font"> : "default",
    textSize: appearanceChoices.textSize.includes(r.textSize as Choice<"textSize">) ? r.textSize as Choice<"textSize"> : "standard",
    readingSize: r.textSize === "compact" ? 14 : r.textSize === "comfortable" ? 16 : 15,
  };
}

// Each surface palette has an independently chosen light and dark counterpart.
type Ground = { canvas: string; surface: string; subtle: string; hover: string; border: string; strong: string; text: string; muted: string };
export const applicationPalettes: Record<Choice<"palette">, { name: string; light: Ground; dark: Ground; accent: string }> = {
  original: { name: "Original", accent: "#0b6fd6",
    light: { canvas: "#f2f4ef", surface: "#fbfcf9", subtle: "#e9ede3", hover: "#dfe5d9", border: "#d5dbd0", strong: "#bcc5b9", text: "#1c2530", muted: "#5b6472" },
    dark: { canvas: "#0f1622", surface: "#151f2e", subtle: "#1d2939", hover: "#26344a", border: "#33415a", strong: "#46567a", text: "#e9eef7", muted: "#a5b0c2" } },
  paper: { name: "Paper", accent: "#397451",
    light: { canvas: "#eeeae2", surface: "#faf7f0", subtle: "#f0ebe0", hover: "#e7e0d3", border: "#dcd4c6", strong: "#b9af9c", text: "#302d27", muted: "#696154" },
    dark: { canvas: "#1c1a17", surface: "#24211d", subtle: "#2c2822", hover: "#383229", border: "#494238", strong: "#726857", text: "#f1eade", muted: "#bcb19f" } },
  neutral: { name: "Neutral", accent: "#6662bb",
    light: { canvas: "#efefef", surface: "#fafafa", subtle: "#ededed", hover: "#e3e3e3", border: "#d8d8d8", strong: "#b7b7b7", text: "#252525", muted: "#616161" },
    dark: { canvas: "#171717", surface: "#202020", subtle: "#292929", hover: "#343434", border: "#404040", strong: "#686868", text: "#eeeeee", muted: "#b4b4b4" } },
  slate: { name: "Slate", accent: "#267994",
    light: { canvas: "#e9eef2", surface: "#f6f9fb", subtle: "#e7edf1", hover: "#dbe4eb", border: "#cdd8e0", strong: "#9badbc", text: "#243541", muted: "#536977" },
    dark: { canvas: "#121b21", surface: "#1a272f", subtle: "#22343e", hover: "#2b424e", border: "#354c5a", strong: "#577582", text: "#e5eff4", muted: "#a5bcc9" } },
  ink: { name: "Ink", accent: "#7772c3",
    light: { canvas: "#e9e9eb", surface: "#ffffff", subtle: "#ededf0", hover: "#e0e0e5", border: "#ceced5", strong: "#9e9eaa", text: "#18181c", muted: "#575762" },
    dark: { canvas: "#050507", surface: "#0e0e11", subtle: "#19191e", hover: "#25252d", border: "#35353f", strong: "#626273", text: "#f4f4f6", muted: "#b3b3c2" } },
};

export const builtInAppearancePresets = [
  { name: "Original", palette: "original", accent: "system", readingFont: "app", density: "standard" },
  { name: "Paper", palette: "paper", accent: "#397451", readingFont: "serif", density: "standard" },
  { name: "Neutral", palette: "neutral", accent: "#6662bb", readingFont: "app", density: "compact" },
  { name: "Slate", palette: "slate", accent: "#267994", readingFont: "system", density: "standard" },
  { name: "Ink", palette: "ink", accent: "#7772c3", readingFont: "app", density: "standard" },
] as const;

export function applicationAppearanceVariables(p: ApplicationAppearance, mode: "light" | "dark", systemAccent: string | null = null, moreContrast = false): Record<string, string> {
  const g = applicationPalettes[p.palette][mode];
  const color = p.accent === "system" ? systemAccent ?? (mode === "dark" ? "#1ea0ff" : "#0b6fd6") : p.accent;
  const a = resolveAccent(accentIdentityFromHex(color), { mode, surface: g.surface, canvas: g.canvas, softAlpha: 0.13 });
  const contrast = p.contrast === "more" || moreContrast;
  const font = { default: '"Inter Variable", Inter, system-ui, sans-serif', stable: '"Segoe UI", Tahoma, sans-serif', verdana: 'Verdana, sans-serif', aptos: 'Aptos, Arial, sans-serif' }[p.font];
  return {
    "--ui-canvas": g.canvas, "--ui-surface": g.surface, "--ui-surface-subtle": g.subtle, "--ui-surface-hover": g.hover,
    "--ui-border": contrast ? g.muted : g.border, "--ui-border-strong": contrast ? g.text : g.strong,
    "--ui-text": g.text, "--ui-text-muted": contrast ? g.text : g.muted, "--ui-text-subtle": g.muted,
    "--ui-accent": a.textUi, "--ui-accent-hover": a.textBody, "--ui-accent-soft": a.softFill,
    "--ui-accent-solid": a.solid, "--ui-on-accent": a.onSolid, "--ui-focus": a.borderState,
    "--work-fold-font-family": font, "--work-fold-ui-font": font,
    "--work-fold-font-size": `${{ compact: 14, standard: 15, comfortable: 16, large: 18 }[p.textSize]}px`,
    "--work-fold-reading-font": p.readingFont === "serif" ? 'Georgia, "Times New Roman", serif' : p.readingFont === "system" ? 'system-ui, sans-serif' : font,
    "--work-fold-reading-size": `${p.readingSize}px`,
    "--work-fold-monospace-font": p.codeFont === "menlo" ? 'Menlo, ui-monospace, monospace' : p.codeFont === "consolas" ? 'Consolas, "Liberation Mono", monospace' : 'ui-monospace, "SFMono-Regular", Consolas, monospace',
    "--work-fold-chat-measure": { focused: "600px", standard: "760px", wide: "1100px" }[p.measure],
    "--work-fold-reading-leading": { tight: "1.45", standard: "1.65", relaxed: "1.85" }[p.spacing],
    "--work-fold-paragraph-gap": { tight: "0.65em", standard: "0.9em", relaxed: "1.2em" }[p.spacing],
    "--work-fold-list-height": { compact: "32px", standard: "38px", spacious: "46px" }[p.density],
    "--work-fold-list-padding": { compact: "4px", standard: "7px", spacious: "11px" }[p.density],
  };
}
