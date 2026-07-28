export interface RailTooltipRequest {
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  theme: "light" | "dark";
}

export function parseRailTooltipRequest(value: unknown): RailTooltipRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rail tooltip request must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["text", "bounds", "theme"].includes(key))) throw new Error("Rail tooltip request has unsupported fields.");
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text || text.length > 300) throw new Error("Rail tooltip text is invalid.");
  if (record.theme !== "light" && record.theme !== "dark") throw new Error("Rail tooltip theme is invalid.");
  const bounds = parseBounds(record.bounds);
  return { text, bounds, theme: record.theme };
}

export function railTooltipNativeBounds(
  bounds: RailTooltipRequest["bounds"],
  contentSize: { width: number; height: number },
  zoomFactor: number,
): RailTooltipRequest["bounds"] {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.max(0, Math.round(bounds.x * scale));
  const y = Math.max(0, Math.round(bounds.y * scale));
  const right = Math.min(contentSize.width, Math.round((bounds.x + bounds.width) * scale));
  const bottom = Math.min(contentSize.height, Math.round((bounds.y + bounds.height) * scale));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function parseBounds(value: unknown): RailTooltipRequest["bounds"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rail tooltip bounds are invalid.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["x", "y", "width", "height"].includes(key))) throw new Error("Rail tooltip bounds have unsupported fields.");
  const x = boundedNumber(record.x, "x", 0, 20_000);
  const y = boundedNumber(record.y, "y", 0, 20_000);
  const width = boundedNumber(record.width, "width", 24, 280);
  const height = boundedNumber(record.height, "height", 24, 80);
  return { x, y, width, height };
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Rail tooltip ${label} is invalid.`);
  }
  return value;
}
