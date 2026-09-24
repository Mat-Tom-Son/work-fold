const thinkingLevelLabels: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

/** Plain-word label for a Pi reasoning level id; unknown ids keep their text with a capital first letter. */
export function thinkingLevelLabel(level: string): string {
  const known = thinkingLevelLabels[level.trim().toLowerCase()];
  if (known) return known;
  const text = level.trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}
