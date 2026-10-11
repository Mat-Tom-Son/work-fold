/** A window event the main window's work-fold agent panel answers. */
export const workFoldAgentDraftEvent = "work-fold:agent-draft";

export interface WorkFoldAgentDraftDetail { text: string }

/**
 * Puts a draft in front of the work-fold agent: in this window's agent panel
 * when it has one, otherwise in the menu-bar popover.
 */
export async function openWorkFoldAgentDraft(text: string): Promise<void> {
  const event = new CustomEvent<WorkFoldAgentDraftDetail>(workFoldAgentDraftEvent, { detail: { text }, cancelable: true });
  // The panel cancels the event once it has taken the draft.
  if (!window.dispatchEvent(event)) return;
  const openInPopover = window.workFoldDesktop?.agent?.openWorkFoldAgentDraft;
  if (!openInPopover) throw new Error("Open the work-fold agent to continue.");
  await openInPopover(text);
}
