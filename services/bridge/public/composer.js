export function shouldSubmitComposerKey(event, { coarsePointer = false } = {}) {
  // On touch devices the keyboard's return key writes a newline — there is no
  // Shift+Enter — and the visible send button sends. Hardware keyboards keep
  // Enter-to-send with Shift+Enter for a new line.
  if (coarsePointer) return false;
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
