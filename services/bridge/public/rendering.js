const renderedMarkup = new WeakMap();

/**
 * Keep background refreshes paint-free when their projection has not changed.
 * Returning whether a mutation happened lets callers preserve scroll and focus.
 */
export function replaceHtmlIfChanged(element, markup) {
  if (!element || renderedMarkup.get(element) === markup) return false;
  element.innerHTML = markup;
  renderedMarkup.set(element, markup);
  return true;
}

export function normalizeChatTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}
