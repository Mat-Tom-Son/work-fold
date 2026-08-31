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
 * The needs-you decision surface (docs/fold-consecrations.md): one card
 * contract shared by the popover stack and the main-window flyout. The card
 * body (category line, title, facts) is host-composed by the local API;
 * these are the only renderer-owned words. Person-facing copy says
 * "Needs you" and never "consecration"; there is no approve-all control
 * anywhere — each card is decided alone.
 */
export const needsYouSurface = {
  heading: "Needs you",
  approve: "Approve",
  deny: "Deny",
  addNote: "Add a note",
  notePlaceholder: "Optional note, kept with a denial",
  confirmDestroy: "This deletes something for good. There is no undo.",
  confirmDestroyAction: "Yes, delete for good",
  keepIt: "Keep it",
  // app.grant.files decision-time supplement (docs/fold-consecrations.md):
  // the card pins the reviewed declaration; the person chooses the exact
  // folder here, and approval binds the grant to that root. The picker is a
  // main-window desktop act — the popover's narrow preload has no picker.
  grantRootLabel: "Folder to grant",
  grantRootChoose: "Choose folder…",
  grantRootChange: "Change folder…",
  grantRootMissing: "Choose the folder inside the Space this app may access before approving.",
  grantRootWholeSpace: "The whole Space folder",
  grantRootMainWindowOnly: "Approving this grant needs the folder picker in the main work-fold window.",
} as const;

/**
 * Settings → The fold → Standing policies (docs/fold-consecrations.md
 * §Standing policies): the friction dial. Policies are authored only on this
 * desktop Settings surface — never by the fold, never from the act lane or a
 * remote operation — and the kind pickers offer policy-eligible kinds only:
 * deleting for good and sharing a page always take a click. The
 * attestation-broken banner is the fail-closed recovery path: an out-of-band
 * store edit disables every policy until the person reviews and re-saves
 * them here.
 */
/**
 * Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
 * rung 2): the publications list with its budgets, tallies, and health
 * notes, the transient share-link reveal, and the narrowing controls —
 * stop sharing, cut budgets, snapshot off. Widening never happens here:
 * a new page, raised budgets, or snapshot caching on is staged through the
 * fold and decided on a needs-you card. Copy never says host, hosting, or
 * website, and "publish" stays reserved for App Studio's local Release
 * transition.
 */
export const foldPublicationsSettings = {
  heading: "Pages your fold serves",
  intro: "Each page here is one file served live from this desktop at your fold's web address, for anyone holding its link. "
    + "Sharing a new page starts in the fold and takes a click on a needs-you card; here you can reveal a link, "
    + "tighten budgets, or stop sharing.",
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
  snapshotWidenHint: "Turning the sleep copy on widens exposure, so it takes a fresh approval through the fold.",
  narrowBudgets: "Tighten budgets",
  narrowHint: "Budgets can only shrink here. Raising one widens exposure and takes a fresh approval through the fold.",
  stopSharing: "Stop sharing",
  stopSharingConfirm: "Stop sharing this page? Every copy of its link stops working, and sharing again mints a new link.",
  empty: "No pages are shared. Ask the fold to share a page, then approve it on the needs-you card.",
} as const;

export const foldPoliciesSettings = {
  heading: "Standing policies",
  intro: "Pre-approve one narrow kind of act you have decided to trust, so it does not wait on a needs-you card. "
    + "Every exercised policy still leaves a decision receipt. You write policies only here — the fold can cite them, "
    + "never write them. Policies apply in Reviewed mode.",
  attestationBroken: "Your standing policies were changed outside Settings, so every policy is off until you review and re-save them here.",
  reattest: "Review and re-save",
  addHeading: "Add a standing policy",
  create: "Add policy",
  // Label and matcher stay editable; a policy's kind never changes — delete
  // and create instead, which is the store's own refusal wording.
  edit: "Edit",
  editHeading: "Edit this policy",
  editSave: "Save changes",
  editCancel: "Cancel",
  enable: "Turn on",
  disable: "Turn off",
  remove: "Delete",
  removeConfirm: "Delete this standing policy? Acts it would have pre-approved will wait on a needs-you card instead.",
  empty: "No standing policies. Every act that needs approval waits on a needs-you card.",
} as const;

export const foldAuthoritySettings = {
  heading: "Operating mode",
  reviewed: "Reviewed",
  reviewedDetail: "Consequential acts wait for you or use a standing policy.",
  unrestricted: "Unrestricted",
  unrestrictedDetail: "Run every admitted act immediately, including permanent deletion.",
  unrestrictedConfirm: "Turn on Unrestricted mode? The fold and every approved browser can install code, grant whole-Space file access, share pages, enable routings, and permanently delete without another approval.",
  approvedBrowserInheritance: "Every new browser must show a six-digit code that you approve on this desktop. Approval is full trust: that browser may ask work-fold to read or change accessible files and run local commands, and it inherits the fold’s current authority mode.",
  damaged: "work-fold is using Reviewed mode because the authority setting is damaged. Recover the authority file outside the app before changing it here.",
  policiesPaused: "Saved policies are paused while Unrestricted mode is on. They resume if you return to Reviewed mode.",
} as const;
