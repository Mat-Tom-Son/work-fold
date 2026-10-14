/**
 * Any surface can ask for the Connect your AI dialog (2026-10-11): the
 * composer's Connect AI chip, a turn that stopped for lack of a model, or Set
 * up for me before any AI is connected. The app shell owns the one dialog and
 * listens here. `then` runs once a provider is connected, so the action that
 * needed AI can carry on.
 */
const connectAiEvent = "work-fold:connect-ai";

export function requestConnectAi(then?: () => void): void {
  window.dispatchEvent(new CustomEvent(connectAiEvent, { detail: { then } }));
}

export function onConnectAiRequested(listener: (then: (() => void) | undefined) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<{ then?: () => void }>).detail?.then);
  window.addEventListener(connectAiEvent, handle);
  return () => window.removeEventListener(connectAiEvent, handle);
}
