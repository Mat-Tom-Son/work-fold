export const primaryNavigation = [
  { id: "files", label: "Files" },
  { id: "chats", label: "Chats" },
  { id: "history", label: "History" },
] as const;

export const welcomeActions = {
  create: "Create New work-folder",
  linkFolder: "Use Existing Folder",
} as const;

/**
 * Settings → Recently Deleted (docs/receipts-not-gates.md, F20).
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
  previewDisabled: "Changing Recently Deleted is disabled in the preview",
} as const;

/**
 * Deleting a folder from Files (docs/receipts-not-gates.md, F20). The confirm
 * is the one moment the person decides, so it states what actually happens:
 * History keeps what it can, whatever History cannot keep moves into Recently
 * Deleted, and both are recoverable. The word "removed" without that is a
 * promise of finality the product no longer makes.
 */
export const deleteFolderConfirm = {
  title: (name: string) => `Delete ${name}?`,
  body: "Everything in it goes to History, or to Recently Deleted if History cannot keep a copy. You can bring it back for 30 days.",
  confirmLabel: "Delete Folder",
} as const;

/** Several Files rows deleted together when a folder is among them; `label` reads "3 Items" or "2 Folders". */
export const deleteSelectionConfirm = {
  title: (label: string) => `Delete ${label}?`,
  body: "Everything in them goes to History, or to Recently Deleted if History cannot keep a copy. You can bring them back for 30 days.",
  confirmLabel: (label: string) => `Delete ${label}`,
} as const;

/**
 * Settings → Automations → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates: they exist so a runaway stops and so
 * envelopes stay sane. Every message that names a limit names this section,
 * so every number an app or an automation can hit has a row here. The numbers are
 * read from the same frozen contracts the host enforces, never retyped.
 */
export const workFoldLimitsSettings = {
  heading: "Limits",
  appRequestsHeading: "Worker Requests",
  requestsHeading: "Requests",
  continuationsHeading: "Continuations",
  continuationsLabel: "Continue requests when handed-out work or background jobs finish",
  jobsHeading: "Background Jobs",
  continuationsSaved: "Saved",
  continuationsUnavailable: "This setting needs the work-fold app running.",
  previewDisabled: "Changing limits is disabled in the preview",
  automationsHeading: "Automations",
  appAutomationsHeading: "App Automations",
  deletedHeading: "Recently Deleted",
  deletedLink: "Open Recently Deleted",
  frozenNote: "",
} as const;

/**
 * Settings → Web Access: what pairing a browser means. Pairing is
 * an identity act on this desktop, never a gate on work; a paired browser
 * holds the work-fold agent's full authority (docs/receipts-not-gates.md).
 */
export const remoteAccessSettings = {
  pairedBrowserTrust: "Paired browsers can read or change accessible files and run local commands.",
  previewDisabled: "Changing web access is disabled in the preview",
} as const;

/**
 * A work-folder's own Automations tab (docs/automations.md, F15 as amended
 * 2026-09-24): a read-mostly window onto the automations whose trigger or
 * steps name this work-folder. Settings → Automations stays the place to manage
 * them; the rail entry exists only while at least one automation touches the
 * work-folder.
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
    watches: "Watches this work-folder",
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
  partlyDone: "Partly Done",
  allAutomations: "All Automations",
  noneLeft: "No automations touch this work-folder.",
  goneHere: "This automation no longer touches this work-folder.",
  count: (count: number) => count === 1 ? "1 automation" : `${count} automations`,
  open: (title: string) => `Open ${title}`,
  runRequested: "Run Requested",
  turnedOn: "Automation turned on",
  turnedOff: "Automation turned off",
  previewDisabled: "Changing automations is disabled in the preview",
} as const;
