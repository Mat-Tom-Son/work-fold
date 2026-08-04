export function shouldSubmitComposerKey(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
