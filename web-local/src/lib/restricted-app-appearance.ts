import type { AppTheme } from "../types";

/**
 * The shell's own tokens, read where the app sits, so they carry the theme,
 * the work-folder's accent, and the person's appearance choices. Each app
 * token takes the first source the shell defines.
 */
const appearanceSources: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["--wf-canvas", ["--ui-canvas"]],
  ["--wf-surface", ["--ui-surface"]],
  ["--wf-surface-subtle", ["--ui-surface-subtle"]],
  ["--wf-surface-hover", ["--ui-surface-hover"]],
  ["--wf-text", ["--ui-text"]],
  ["--wf-text-muted", ["--ui-text-muted"]],
  ["--wf-text-subtle", ["--ui-text-subtle"]],
  ["--wf-border", ["--ui-border"]],
  ["--wf-border-strong", ["--ui-border-strong"]],
  ["--wf-accent", ["--work-folder-accent-solid", "--ui-accent"]],
  ["--wf-on-accent", ["--work-folder-on-accent-solid", "--ui-on-accent"]],
  ["--wf-accent-soft", ["--work-folder-accent-soft-fill", "--ui-accent-soft"]],
  ["--wf-accent-text", ["--work-folder-accent-text-ui", "--ui-accent"]],
  ["--wf-focus", ["--work-folder-accent-focus-ring", "--ui-focus", "--ui-accent"]],
  ["--wf-success", ["--ui-success"]],
  ["--wf-danger", ["--ui-danger"]],
  ["--wf-attention", ["--ui-attention"]],
  ["--wf-radius-sm", ["--ui-radius-sm"]],
  ["--wf-radius-md", ["--ui-radius-md"]],
  ["--wf-radius-lg", ["--ui-radius-lg"]],
  ["--wf-shadow", ["--ui-shadow-menu"]],
];

export function currentAppearance(element: HTMLElement, theme: AppTheme): Record<string, string> {
  const style = getComputedStyle(element);
  const appearance: Record<string, string> = {};
  for (const [token, sources] of appearanceSources) {
    for (const source of sources) {
      const value = style.getPropertyValue(source).trim();
      if (value) { appearance[token] = resolveLightDark(value, theme); break; }
    }
  }
  // Apps load Inter from their own origin under this name.
  if (style.fontFamily) appearance["--wf-font"] = style.fontFamily.replace(/"Inter Variable"|'Inter Variable'/g, '"work-fold Inter"');
  if (style.fontSize) appearance["--wf-font-size"] = style.fontSize;
  return appearance;
}

/**
 * The shell writes some colors as light-dark(a, b), which resolves by the
 * document's color scheme. An app sets its own (or none), so the pair is
 * settled here, for the theme the shell is actually showing.
 */
export function resolveLightDark(value: string, theme: AppTheme): string {
  let result = value;
  for (let start = result.indexOf("light-dark("); start >= 0; start = result.indexOf("light-dark(")) {
    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let index = start + "light-dark(".length; index < result.length; index += 1) {
      const character = result[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) { end = index; break; }
        depth -= 1;
      } else if (character === "," && depth === 0 && comma < 0) comma = index;
    }
    if (end < 0 || comma < 0) return value;
    const chosen = theme === "dark" ? result.slice(comma + 1, end) : result.slice(start + "light-dark(".length, comma);
    result = result.slice(0, start) + chosen.trim() + result.slice(end + 1);
  }
  return result;
}
