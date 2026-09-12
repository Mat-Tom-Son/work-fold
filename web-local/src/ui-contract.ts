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
 * Settings → Shared pages (docs/fold-publishing.md,
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
  linkMeaning: "Anyone with the link can read this page.",
  revealLink: "Show link",
  hideLink: "Hide link",
  copyLink: "Copy link",
  noAddress: "Set up web access to show links.",
  snapshotLabel: "An encrypted copy at the relay stays readable while your desktop sleeps.",
  snapshotOn: "Sleep copy on",
  snapshotOff: "Sleep copy off",
  turnSnapshotOff: "Turn off sleep copy",
  narrowBudgets: "Tighten budgets",
  narrowHint: "To raise budgets, ask the fold to share again.",
  stopSharing: "Stop sharing",
  stopSharingConfirm: "Stop sharing this page? Every copy of its link stops working, and sharing again mints a new link.",
  empty: "No pages are shared. Ask the fold to share a page.",
} as const;

/**
 * Settings → Desktop → Recently deleted (docs/receipts-not-gates.md, F20).
 * Nothing work-fold deletes is gone at the moment it happens: History covers
 * what it can, and this is where the rest waits.
 */
export const recentlyDeletedSettings = {
  heading: "Recently deleted",
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
  heldNote: "Held: contains legacy Workspace records. Cannot be deleted here.",
  damagedNote: "Some items could not be read.",
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
 * Settings → Desktop → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates: they exist so a runaway stops and so
 * envelopes stay sane. Every message that names a limit names this section,
 * so every number an app or a routing can hit has a row here. The numbers are
 * read from the same frozen contracts the host enforces, never retyped.
 */
export const foldLimitsSettings = {
  heading: "Limits",
  assistantHeading: "App requests",
  requestsHeading: "Requests",
  continuationsHeading: "Continuations",
  continuationsLabel: "Continue requests when their child results arrive",
  continuationsSaved: "Saved",
  continuationsUnavailable: "This setting needs the work-fold app running.",
  routingsHeading: "Routings",
  automationsHeading: "App automations",
  deletedHeading: "Recently deleted",
  deletedLink: "Open Recently deleted",
  frozenNote: "",
} as const;

/**
 * Settings → Web access: what pairing a browser means. Pairing is
 * an identity act on this desktop, never a gate on work; a paired browser
 * holds the fold's full authority (docs/receipts-not-gates.md).
 */
export const remoteAccessSettings = {
  pairedBrowserTrust: "Paired browsers can read or change accessible files and run local commands.",
} as const;
