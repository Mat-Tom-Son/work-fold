import { WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE } from "../../src/shared/publications";

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
 * Settings → Shared pages (docs/fold-publishing.md, rung 2): the
 * publications list with its budgets, tallies, and page state, the
 * transient share-link reveal, stop sharing, and the in-place Budgets and
 * Sleep copy controls (amended 2026-09-24) that narrow or widen under a
 * receipt while the link stays the same. A new page starts from a file's
 * tab. Copy never says host, hosting, or website, and "publish" stays
 * reserved for App Studio's local Release transition.
 */
export const foldPublicationsSettings = {
  heading: "Pages Your Fold Serves",
  linkMeaning: "Anyone with the link can read this page.",
  revealLink: "Show Link",
  hideLink: "Hide Link",
  copyLink: "Copy Link",
  noAddress: "Set up web access to show links.",
  snapshotLabel: "An encrypted copy at the relay stays readable while your desktop sleeps.",
  sleepCopy: "Sleep Copy",
  budgets: "Budgets",
  servesPerMinute: "Serves per minute",
  mibPerDay: "MiB per day",
  saveBudgets: "Save",
  saved: "Saved",
  budgetRange: (serveRateMaximum: number, byteBudgetMaximumMiB: number) => `Choose 1 to ${serveRateMaximum} serves per minute and 1 to ${byteBudgetMaximumMiB} MiB per day.`,
  stopSharing: "Stop Sharing",
  stopSharingConfirm: "Stop sharing this page? Every copy of its link stops working, and sharing again mints a new link.",
  emptyNoAddress: "Set up web access to share pages.",
  webAccess: "Web Access",
  empty: "No pages are shared. Share a file from its tab.",
  previewDisabled: "Changing shared pages is disabled in the preview",
  states: {
    live: "Live",
    asleep: "Asleep",
    resting: "Resting",
    "not-available": "Not Available",
    stopped: "Stopped",
  },
} as const;

/**
 * Sharing a file from its tab or the Files menu (docs/fold-publishing.md,
 * amended 2026-09-24): the click shares and says so; the popover holds the
 * link. No confirmation — sharing is receipted and Stop sharing undoes it.
 */
export const fileSharing = {
  share: "Share",
  shared: "Shared",
  sharedToast: (title: string) => `Shared "${title}"`,
  stoppedToast: (title: string) => `Stopped sharing "${title}"`,
  linkCopied: "Link Copied",
  linkInSettings: "Show the link in Settings → Shared pages.",
  openSharedPages: "Open Shared Pages",
  noAddress: WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE,
  webAccess: "Web Access",
  previewDisabled: "Sharing is disabled in the preview",
  /** The at-a-glance mark on a shared file's Files row and tab. */
  sharedMarkLabel: "Shared as a Page",
  sharedMarkTooltip: "Shared as a page. Anyone with the link can read it.",
} as const;

/**
 * Settings → Recently deleted (docs/receipts-not-gates.md, F20).
 * Nothing work-fold deletes is gone at the moment it happens: History covers
 * what it can, and this is where the rest waits.
 */
export const recentlyDeletedSettings = {
  heading: "Recently Deleted",
  restore: "Restore",
  saveCopy: "Save a Copy",
  deleteNow: "Delete Now",
  deleteNowConfirm: "Delete this for good? It cannot be brought back afterwards.",
  retentionLabel: "Keep Deleted Items For",
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
  confirmLabel: "Delete Folder",
} as const;

/**
 * Settings → Automations → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates: they exist so a runaway stops and so
 * envelopes stay sane. Every message that names a limit names this section,
 * so every number an app or a routing can hit has a row here. The numbers are
 * read from the same frozen contracts the host enforces, never retyped.
 */
export const foldLimitsSettings = {
  heading: "Limits",
  assistantHeading: "App Requests",
  requestsHeading: "Requests",
  continuationsHeading: "Continuations",
  continuationsLabel: "Continue requests when their child results arrive",
  continuationsSaved: "Saved",
  continuationsUnavailable: "This setting needs the work-fold app running.",
  routingsHeading: "Routings",
  automationsHeading: "App Automations",
  deletedHeading: "Recently Deleted",
  deletedLink: "Open Recently Deleted",
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

/**
 * The Folder-owned Automations tab (docs/fold-routings.md, F15 as amended
 * 2026-09-24): a read-mostly window onto the automations whose trigger or
 * steps name this Folder. Settings → Automations stays the management home;
 * the rail entry exists only while at least one automation touches the Folder.
 */
export const folderAutomations = {
  rail: "Automations",
  tab: "Automations",
  heading: (folderName: string) => `Automations in ${folderName}`,
  states: {
    on: "On",
    off: "Off",
    running: "Running",
    suspended: "Suspended",
    completed: "Done",
  },
  roles: {
    watches: "Watches this folder",
    "copies-to": "Copies files here",
    "copies-from": "Copies files from here",
    "chats-here": "Starts a Chat here",
    "checks-here": "Runs a Check here",
  },
  runNow: "Run Now",
  turnOn: "Turn On",
  turnOff: "Turn Off",
  lastRun: (when: string) => `Last run ${when}`,
  notRunYet: "Not Run Yet",
  failed: "Failed",
  allAutomations: "All Automations",
  noneLeft: "No automations touch this folder.",
  runRequested: "Run Requested",
  turnedOn: "Automation turned on",
  turnedOff: "Automation turned off",
  previewDisabled: "Changing automations is disabled in the preview",
} as const;
