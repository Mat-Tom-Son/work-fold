export const primaryNavigation = [
  { id: "files", label: "Files" },
  { id: "chats", label: "Chats" },
  { id: "history", label: "History" },
] as const;

export const welcomeActions = {
  create: "Create a Space",
  linkFolder: "Turn an existing folder into a Space",
} as const;

/**
 * Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
 * rung 2): the publications list with its budgets, tallies, and health
 * notes, the transient share-link reveal, and the narrowing controls —
 * stop sharing, cut budgets, snapshot off. Widening never happens here:
 * a new page, raised budgets, or snapshot caching on is a fresh `pages
 * stage` through the fold, receipted like every act. Copy never says host,
 * hosting, or website, and "publish" stays reserved for App Studio's local
 * Release transition.
 */
export const foldPublicationsSettings = {
  heading: "Pages your fold serves",
  intro: "Each page here is one file served live from this desktop at your fold's web address, for anyone holding its link. "
    + "Ask the fold to share a page; it appears here with its receipt. Here you can reveal a link, tighten budgets, or stop sharing.",
  linkMeaning: "Anyone with this link can read this page while your desktop is online. The link is the whole key — forwarding it forwards the access.",
  revealLink: "Show link",
  hideLink: "Hide link",
  copyLink: "Copy link",
  linkShownOnce: "Shown transiently — work-fold keeps no readable copy of this link outside secure settings.",
  noAddress: "Set up your fold on the web before revealing links; pages have no address without it.",
  snapshotLabel: "Keep an encrypted copy at the relay so this page stays readable while your desktop sleeps. "
    + "The relay stores it encrypted and cannot read it; anyone with the link still can.",
  snapshotOn: "Sleep copy on",
  snapshotOff: "Sleep copy off",
  turnSnapshotOff: "Turn off sleep copy",
  snapshotWidenHint: "Turning the sleep copy on widens exposure, so ask the fold to share the page again with it on.",
  narrowBudgets: "Tighten budgets",
  narrowHint: "Budgets can only shrink here. To raise one, ask the fold to share the page again.",
  stopSharing: "Stop sharing",
  stopSharingConfirm: "Stop sharing this page? Every copy of its link stops working, and sharing again mints a new link.",
  empty: "No pages are shared. Ask the fold to share a page.",
} as const;

/**
 * Settings → The fold → Web access: what pairing a browser means. Pairing is
 * an identity act on this desktop, never a gate on work; a paired browser
 * holds the fold's full authority (docs/receipts-not-gates.md).
 */
export const remoteAccessSettings = {
  pairedBrowserTrust: "Every new browser shows a six-digit code that you confirm on this desktop. Pairing is full trust: "
    + "that browser may ask work-fold to read or change accessible files and run local commands.",
} as const;
