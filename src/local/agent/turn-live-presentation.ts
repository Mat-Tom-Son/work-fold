import { maxLiveTurnPresentationBytes, type ChatLiveTurnPresentation } from "../../shared/chat-presentation.js";

/** Keep reconnect frames finite without changing the live task or saved content. */
export function boundedLiveTurnPresentation(input: ChatLiveTurnPresentation): ChatLiveTurnPresentation {
  const result: ChatLiveTurnPresentation = {
    text: input.text,
    ...(input.assistantPresentation ? { assistantPresentation: { ...input.assistantPresentation, segments: input.assistantPresentation.segments.map((segment) => ({ ...segment })) } } : {}),
    workTrail: input.workTrail.slice(-64).map((entry) => ({ ...entry, ...(entry.edit ? { edit: { ...entry.edit } } : {}) })),
    truncated: input.truncated || input.workTrail.length > 64,
    ...(input.textTruncated ? { textTruncated: true } : {}),
  };
  // Reserve half the response for rows, especially the active one. Truncation
  // is an explicit display omission; it never truncates execution or storage.
  if (jsonBytes(result.text) > maxLiveTurnPresentationBytes / 2) {
    result.text = jsonPrefix(result.text, maxLiveTurnPresentationBytes / 2);
    result.textTruncated = true; result.truncated = true;
    delete result.assistantPresentation; // Its offsets describe the complete text.
  }
  while (jsonBytes(result) > maxLiveTurnPresentationBytes && result.workTrail.length) {
    const first = result.workTrail[0]!;
    if (result.workTrail.length > 1) result.workTrail.shift();
    else {
      // One exceptionally large row still keeps its identity, phase and timing.
      first.text = jsonPrefix(first.text, 16 * 1024);
      if (first.detail) first.detail = jsonPrefix(first.detail, 4 * 1024);
      if (first.edit) first.edit = { ...first.edit, diff: jsonPrefix(first.edit.diff, 8 * 1024), truncated: true };
      if (jsonBytes(result) > maxLiveTurnPresentationBytes) result.workTrail = [];
    }
    result.truncated = true;
  }
  return result;
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function jsonPrefix(text: string, bytes: number): string {
  let low = 0, high = Math.min(text.length, bytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, middle)) <= bytes) low = middle; else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}
