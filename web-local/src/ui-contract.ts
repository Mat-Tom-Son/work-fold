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
 * Settings → The fold → Recently deleted (docs/receipts-not-gates.md, F20).
 * Nothing work-fold deletes is gone at the moment it happens: History covers
 * what it can, and this is where the rest waits.
 */
export const recentlyDeletedSettings = {
  heading: "Recently deleted",
  intro: "Deleted files History could not keep a copy of, deleted Space folders, and app data that was cleared or purged "
    + "wait here until the time below runs out. Everything here is on this computer only.",
  restore: "Restore",
  saveCopy: "Save a copy",
  deleteNow: "Delete now",
  deleteNowConfirm: "Delete this for good? It cannot be brought back afterwards.",
  retentionLabel: "Keep deleted items for",
  retentionUnit: "days",
  retentionSave: "Save",
  retentionSaved: "Saved",
  retentionRange: "Choose between 1 and 365 days.",
  empty: "Nothing here.",
  heldNote: "This folder holds records from the earlier Workspace product, which work-fold never erases. "
    + "It stays here until you handle the folder yourself.",
  damagedNote: "Some items could not be read. work-fold leaves them alone rather than removing them.",
} as const;

/**
 * Deleting a folder from Files (docs/receipts-not-gates.md, F20). The confirm
 * is the one moment the person decides, so it states what actually happens:
 * History keeps what it can, whatever History cannot keep moves into Recently
 * deleted, and both are recoverable. The word "removed" without that is a
 * promise of finality the product no longer makes.
 */
export const deleteFolderConfirm = {
  title: (name: string) => `Delete ${name}?`,
  body: "Everything in it goes to History, or to Recently deleted if History cannot keep a copy. You can bring it back for 30 days.",
  confirmLabel: "Delete folder",
} as const;

/**
 * Settings → The fold → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates: they exist so a runaway stops and so
 * envelopes stay sane. Every message that names a limit names this section,
 * so every number an app or a routing can hit has a row here. The numbers are
 * read from the same frozen contracts the host enforces, never retyped.
 */
export const foldLimitsSettings = {
  heading: "Limits",
  intro: "These are the sizes and counts work-fold stops at. Nothing here waits for you: when work reaches one of these "
    + "numbers, work-fold says which one it was. The counts and sizes below are fixed in this build.",
  assistantHeading: "What an app can ask the Assistant",
  assistantIntro: "An app in a Space can start a Chat with the full Assistant, and can ask for one short answer with no tools. "
    + "Both leave a record under the app in Apps.",
  requestsHeading: "Requests you start",
  requestsIntro: "When you ask the fold for something, work-fold keeps one record of that request and everything it hands to "
    + "a Space. These are the sizes and counts it stops at.",
  continuationsHeading: "When work you handed out finishes",
  continuationsIntro: "work-fold can return selected child results to the Assistant that asked, in the fold or a Space, "
    + "including work an app requested. Each batch can start one follow-up turn within the request limit. "
    + "Turn this off and results remain available in their request and Chat.",
  continuationsLabel: "Continue requests when their child results arrive",
  continuationsSaved: "Saved",
  continuationsUnavailable: "This setting needs the work-fold app running.",
  routingsHeading: "Routings",
  routingsIntro: "A routing is the deterministic glue that moves work between Spaces.",
  automationsHeading: "App automations",
  automationsIntro: "Named automations an app declares, running on their own cadence.",
  deletedHeading: "Recently deleted",
  deletedLink: "Open Recently deleted",
  deletedIntro: "How long a deleted item stays recoverable. Change it in Recently deleted.",
  frozenNote: "These numbers are fixed in this version.",
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
