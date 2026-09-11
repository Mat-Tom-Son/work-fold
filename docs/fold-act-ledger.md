# The fold act ledger

**Status: shipped contract reference.** The verb ledger shipped with the fold
build, and its decisions were promoted on 2026-08-11 into
[the fold](fold.md) decision register, [the management layer](management-layer.md)
(receipts, the act-lane scope and prepared-acts bullets, the
verification map), [the product model](product-model.md) (the act-lane
sentence), `AGENTS.md` (the family list and the appearance bullet),
`README.md`, `SECURITY.md`, and `PRIVACY.md`, with
[Space customization](space-customization.md) acknowledging the receipted
appearance path. `src/local/cli/act-commands.ts`,
`src/local/cli/act-facade.ts`, and their suites are the implementation
authority. This document retains what canon does not carry: the per-verb
classification tables, the consolidated conflict rules, the receipt schema
record, and the deliberate absences. The 2026-09-10 supersession is recorded
in [Receipts, not gates](receipts-not-gates.md);
[Consecrations](fold-consecrations.md) is retained only for threat-model
residuals. Routing, glance, and publishing verbs are owned by
[Routings](fold-routings.md), [the glance](fold-glance.md), and
[Publishing](fold-publishing.md); the promotion record by
[Fold integration](fold-integration.md).

The doctrine, in one paragraph: every product verb is a receipted act-lane
verb except the setup-only boundary, which the fold can neither do nor
request. Verbs that make bytes runnable, widen a standing power, or delete
are **prepared verbs**: the host prepares typed facts, pins exact
identities, journals first, rechecks at effect time, executes at most once
through a fenced task, never auto-retries, and returns the receipt like any
other verb — immediately. Deletion is reversible through History or Recently
deleted.

## Terms the ledger uses

| Target | Meaning |
|---|---|
| **direct verb** | The fold performs it through the act lane: explicit selection, journal-first receipt, at-most-once execution, desktop conflict rules. |
| **prepared verb** | A direct verb whose execution shape is prepare → pin → journal-first → fenced execute → receipt, run on the call that asks. Covers app install/update, Pi package and skill-bundle install/update, app grants and automation enablement, routing enablement, outward viewer exposure, managed-Space deletion, app storage clear and retained-data purge. |
| **reversible deletion** | A delete whose undo is a History restore point or a Recently-deleted entry (`trash restore`). No product verb destroys permanently; retention does. |
| **setup-only boundary** | The fold can neither perform nor request it: Remote access administration, act-token and pairing machinery, provider credentials, and anything that widens the set of principals controlling the fold. |
| **deliberately absent** | Not a product verb — desktop-session mechanics, machine-local UI preference, or a surface whose meaning does not survive leaving the desktop. Listed so absence is a decision, not a gap. |

The tables' "Fold today" column is historical: it records what the act lane
had before the fold shipped (`act`/`read`/`none`, audited 2026-08-10). Every
row's target class and command shape is now shipped behavior; rows marked
`<!-- verify -->` name the record's spelling where the build has not yet
landed the token.

## Rules every verb inherits

Every mutation answers the same five questions the same way, so the tables
record only per-verb additions.

1. **Who journals it.** The act executor
   (`src/local/cli/act-commands.ts`) appends an `accepted` line to
   `cli/receipts/act.jsonl` (`src/local/cli/act-receipts.ts`) **before** the
   mutation runs; an unwritable journal refuses the command. The owning
   domain service then keeps its own durable records exactly as it does for
   the renderer (History checkpoints, transcript lifecycle events, App
   Studio operation records, automation run receipts).
2. **What the receipt contains.** Baseline: version, timestamp, request id,
   command, outcome (`accepted`/`ok`/`error`/`rejected`), error code,
   Space/conversation ids, checkpoint id, kernel task id, and management
   `parentTaskId` lineage — plus the fields under
   [Receipt schema](#receipt-schema). Receipts stay content-light:
   identifiers, digests, and names, never file contents, message text,
   search queries, or credentials.
3. **How it is revoked or undone.** Per verb, in the tables. The general
   shapes: in-Space file mutations are undone through the safety restore
   point every mutation already records; lifecycle and naming verbs are
   undone by the inverse verb using the prior state captured in the receipt;
   authority verbs are revoked by their narrow-direction twin (revoke,
   disable, disconnect, stop sharing), which is always direct; deletions are
   undone through the restore point or `trash restore --entry <id>`.
4. **What happens on failure mid-act.** The domain service's existing
   atomicity applies unchanged — placement and restore point succeed or fail
   together, prepared App operations recheck at activation, Space removal
   uses the durable cleanup outbox. The executor appends a terminal `error`
   receipt; a crash between `accepted` and the terminal line is itself the
   honest signal that the outcome was interrupted. A failed or interrupted
   prepared verb is never auto-retried; another attempt is a fresh call.
5. **How replay is prevented.** The broker's freshness window and pending
   response dedup, then the journal's `accepted` records as the durable
   at-most-once ledger: a duplicated request id is refused outright, and a
   damaged journal fails closed rather than risk re-execution. Journal
   rotation holds entries at least as long as the freshness window.

Act-protocol conventions carry over unchanged: the current act-protocol
envelope (version advanced 2026-09-10; see `src/local/cli/act-protocol.ts`
for the number), per-launch act token, explicit `--space` on every
Space-scoped write (never working-directory resolution), `--parent-task`
lineage validated against an active management request, and `--json`
output. Prepared verbs use the same grammar and return the receipt of their
immediate execution.

## The ledger

Columns: the verb; where a human performs it; what the fold had before the
build (`act`/`read`/`none`); the target class; the command shape; what the
receipt adds beyond baseline; the undo or revocation path; and the conflict
rules, which mirror the desktop's.

### Space lifecycle

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Create Space | Header menu, palette, onboarding | act | direct verb | `spaces create --name <n>` | spaceId | `spaces unregister` (folder remains) | name collision rejected |
| Register folder | Header menu, native picker | act | direct verb | `spaces register --path <abs>` | spaceId | `spaces unregister` revokes runtime authorization | already-registered path rejected |
| Rename Space | Manage Spaces pane | none | direct verb | `spaces rename --space <id> --name <n>` | prior name | rename back (prior name in receipt) | duplicate exact name rejected as ambiguous-making |
| Unregister Space | Manage Spaces → Remove (linked) | none | direct verb | `spaces unregister --space <id>` | storage kind | re-register the folder; `.work-fold/` identity persists | refused while a release-backed App Instance is sourced by or installed in it, or its Project owns retained data — same App Studio impact checks as the desktop; refused while live publications are backed by it, named in the refusal ([Publishing](fold-publishing.md)); on success, routings referencing it suspend with active runs stopped ([Routings](fold-routings.md)) |
| Delete managed Space folder | Manage Spaces → Delete (managed) | none | **prepared verb** | `spaces delete --space <id>` | trash entry id, canonical root | `trash restore --entry <id>` re-registers the Space from Recently deleted | same impact checks as unregister, including the live-publication block; fails closed if the claimed tree contains `.workspace/` |
| Apply appearance | Customize Space → Import proposal | none | direct verb (argued below) | `spaces appearance apply --space <id> --proposal <path>` | prior customization ref | `spaces appearance undo --space <id>` | proposal must parse as the typed `space-appearance` proposal; nothing else is accepted |
| Reset appearance | Customize Space → Reset | none | direct verb | `spaces appearance reset --space <id>` | prior customization ref | `spaces appearance undo` | — |
| Undo appearance | — (the desktop re-imports or resets instead) | none | direct verb | `spaces appearance undo --space <id>` | restored and displaced customization refs | apply the displaced ref again — undo is its own inverse | refused with a typed error when the receipt chain records no prior customization ref for that Space, including when the current appearance was last changed on the desktop rather than through a receipted act |
| Inspect Space Assistant preferences | Settings → Assistant | none | direct verb (content-bearing act read) | `spaces assistant show --space <id>` | — | n/a | returns only connected model choices plus the current model and instruction text; provider credentials never enter the result |
| Set the default model for new Chats | Settings → Assistant | none | direct verb | `spaces assistant model --space <id> --provider <id> --model <id>` | provider and model ids | choose the prior model again | selected model must exist and already have configured auth; fenced against active Assistant, compaction, or Check work; existing Chat sessions keep their session model |
| Set or clear Space instructions | Settings → Assistant | none | direct verb | `spaces assistant instructions --space <id> (--instructions <text> \| --clear)` | updated character count or cleared marker — never text | set the prior text again or clear | bounded validated text; fenced against active Assistant, compaction, or Check work; applies to subsequent turns after scoped client invalidation |

The desktop couples managed-Space removal with folder deletion in one
confirm dialog; the ledger splits them. Unregistration is recoverable and
authority-narrowing (a direct verb, valid for both storage kinds, per the
contributor contract's "registration removal remains available without
folder deletion"), while deleting the managed folder is a prepared verb that
moves it into Recently deleted.

**The appearance argument** (recorded verdict: direct verb). Appearance is
cosmetic, machine-local, authority-free, and already has an inert typed
proposal format; requiring a human import click through the fold would spend
attention on the lowest-stakes mutation in the product. The honest
counterargument is impersonation — a prompt-injected fold restyling one
Space to resemble another — and the mitigations are structural: the verb
accepts only the typed proposal file, the receipt captures the prior
customization for one-act undo, the change surfaces in
[the glance](fold-glance.md)'s "what changed" list, and appearance cannot
touch the fold's own chrome, Settings, or any trust surface. If dogfooding
shows appearance changes used to confuse, the escalation path is a register
decision about this one row — never a gate reintroduced elsewhere as a
convenience.

### Chats

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Create Chat | New Chat button, palette | act | direct verb | `chat create --space <id>` | conversationId | archive it | — |
| Send message | Composer | act | direct verb | `chat send …` | taskId | `chat abort` while running | send into running work rejected; archived → "Restore this Chat before sending"; snoozed likewise |
| Abort turn | Stop button | act | direct verb | `chat abort …` | — | n/a | no active turn → honest no-op |
| Status / result / list | Chat UI, navigator | act | direct verb (content-bearing act reads) | shipped | — | n/a | — |
| Rename Chat | Chat actions popover | none | direct verb | `chat rename --space <id> --conversation <id> --title <t>` | prior title | rename back; person-authored rename still always wins over generated titles | refused while that Chat's turn or compaction runs (409) |
| Snooze Chat | Chat actions popover presets | none | direct verb | `chat snooze --space <id> --conversation <id> --until <ISO>` | prior lifecycle state | `chat resume` | future time required; one lifecycle change per act; refused while turn/compaction runs; closes the open tab but never rewrites the transcript |
| Archive Chat | Chat actions popover | none | direct verb | `chat archive --space <id> --conversation <id>` | prior lifecycle state | `chat resume` | same as snooze |
| Resume Chat | Popover "Resume now" / "Restore to Active", read-only banner | none | direct verb | `chat resume --space <id> --conversation <id>` | prior lifecycle state | re-archive or re-snooze | refused while turn/compaction runs |
| Compact Chat | Composer `/compact` | none | direct verb | `chat compact --space <id> --conversation <id>` | kernel task id | none — compaction is additive summarization, not deletion | refused while a turn runs; registers the same kernel `compaction` task and capability-mutation fencing as the renderer |

Lifecycle events are append-only entries in the Chat's portable
`.work-fold/conversations/` log, exactly as on the desktop; the act lane
adds receipts, not a second lifecycle store. The desktop's snooze presets
stay renderer conveniences — the verb takes an explicit `--until`.

### History

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List restore points | History pane | none | direct verb (content-bearing act read) | `history list --space <id>` | — | n/a | — |
| Save restore point | History pane, palette | none | direct verb | `history save --space <id> [--label <t>]` | checkpointId, `created` flag | none needed (additive) | unchanged files → honest "already matches" result, not a new checkpoint |
| Restore a restore point | History pane → Restore | none | direct verb | `history restore --space <id> --checkpoint <id>` | restored checkpointId + pre-restore safety checkpointId | restore the safety checkpoint the act itself recorded | **refused while any Assistant turn, compaction, or Check run is active in that Space, while a restricted-app automation run whose app holds a file grant into that Space is active, or while a routing run with a files hop targeting that Space is active** — shared with desktop recovery |
| List file versions | File version history modal | none | direct verb (content-bearing act read) | `history versions --space <id> --path <p>` | — | n/a | — |
| Restore file version | File version history modal | none | direct verb | `history restore-file --space <id> --path <p> --version <sha256>` | safety checkpointId | restore the safety checkpoint (the modal's own Undo does the same) | missing version → not-found; folder at path → refused |

Whole-Space restore records a `pre_restore` safety checkpoint and
file-version restore records a mutation checkpoint (`src/local/history.ts`),
so every History verb is recoverable through History itself. Because a
restore replaces the working set a running turn may be reading, the act verb
refuses concurrency instead of trusting a confirm dialog the fold has no way
to honestly present.

### Files in a Space

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Add outside material | Upload button, drag-drop, chat drop | act | direct verb | `files add --space <id> --from <p>… [--to <folder>]` | checkpointId, copied paths count | restore the checkpoint | copy and restore point succeed or fail together |
| Move entry | Drag in tree, context menu | none | direct verb | `files move --space <id> --from <space-path> --to <space-folder>` | safety checkpointId, moved path | restore the safety checkpoint | into-own-subtree refused; `.work-fold/`, `.pi/`, `.workspace/` never valid endpoints (same path policy as the renderer) |
| Rename entry | Context menu → Rename | none | direct verb | `files rename --space <id> --path <p> --name <n>` | safety checkpointId, prior name | restore the safety checkpoint or rename back | same path policy |
| Delete entry | Context menu → Delete (+ Undo toast) | none | direct verb | `files delete --space <id> --path <p>` | safety checkpointId; Recently-deleted entry ids for any path the checkpoint could not cover | restore the safety checkpoint, or `trash restore` for the uncoverable paths — the durable form of the desktop's Undo toast | never refuses for coverage reasons; `.work-fold/`, `.pi/`, `.workspace/` remain invalid endpoints |
| New folder | Context menu → New folder here | none | direct verb | `files mkdir --space <id> --path <folder>` | created path — no safety checkpoint, stated deliberately: creation is additive and destroys nothing | `files delete` (an empty folder is fully checkpoint-coverable) | existing name refused; same `.work-fold/`/`.pi/`/`.workspace/` path policy |
| New empty file | Context menu → New file here | none | direct verb | `files create --space <id> --path <p>` | created path — same no-checkpoint note as `files mkdir` | `files delete` | existing name refused; same path policy |
| Content search | Files search field, Chats search | none | direct verb (content-bearing act read) | `search --space <id> --query <q> [--scope files\|chats\|all]` | scope only — **not** the query text | n/a | honours ignore rules, skips binary/oversized files, and reports when a bound stopped the search rather than implying completeness — same contract as `/api/spaces/:id/search` |

The file verbs use the renderer's own mutation paths and add receipts.
Desktop and CLI delete both succeed on every coverable or uncoverable path:
what the safety checkpoint cannot capture (oversized, unreadable, symlink —
the checkpoint's own skip rules) is moved into Recently deleted with a
manifest. History recovery still refuses overlapping uncovered content,
protects registered child Spaces and excluded descendants, and reserves
affected work against concurrent launches and ownership changes.

### Recently deleted

The machine-local trash under the state root (`trash/`) is Space-free: each
entry records its source Space, so the family takes no `--space`.
<!-- verify against act-commands.ts: `trash` family tokens -->

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List Recently deleted | Settings → The fold → Recently deleted | none | direct verb (content-bearing act read) | `trash list --json` | — | n/a | entries carry source Space id, original Space-relative path or folder, kind (`file`, `folder`, `space`, `app-storage`, `app-retained`), size, deleted-at, restore-by, and the producing receipt id |
| Restore an entry | Recently deleted → Restore; the Undo toast | none | direct verb | `trash restore --entry <id>` | restored path or Space id | delete it again | refused when the destination path is occupied (the collision is named) or the source Space is unregistered and the entry is not itself a Space |

No verb empties Recently deleted. **Delete now** is a Settings-only action;
retention (default 30 days, adjustable in Settings → The fold → Limits) is
the only automatic purge, run on app start and daily while awake. The
producers are `files delete` for uncoverable paths, `spaces delete`,
`apps storage clear`, `apps retained purge`, and `apps uninstall
--purge-data`; the last three write a recovery export into the trash before
removing live data.

### Library

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List Library | Library tab | none | direct verb (content-bearing act read) | `library list` | — | n/a | — |
| Add to Library | "Add files to Library" | none | direct verb | `library add --from <path>… [--to <library-folder>]` | added paths count | none in-product today: no removal verb exists on any surface, the Library is an ordinary folder, and removal is a filesystem action outside the product's receipts; a receipted `library remove` lands only after the roadmap's desktop organization controls exist, desktop first | Library is personal and Space-free: no `--space`, no restore point (History is a Space concept) |
| New Library folder | "New Library folder" | none | direct verb | `library folder create --name <n>` | folder path | none in-product today — removal is a filesystem action; same roadmap note as `library add` | — |
| Copy into a Space | "Add to <Space>" with destination selector | none | direct verb | `library copy --item <library-path> --space <id>` | checkpointId, copied path | restore the destination checkpoint; the Library original is untouched | copy lands under `From Library`; independent copy, never a link; restore point in the destination Space |

### Checks

Previously shipped act-lane family, unchanged by the fold:
`checks status` (read lane), `checks enable|disable|run|task|result|abort|problems|decide`
(act lane). Check enablement was always direct and stays so: the shipped
trigger is `manual`, so enablement creates no standing or scheduled
behavior, and `checks decide` is a fingerprint-scoped finding decision, not
an authority act.

### Assistant tools

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List capabilities | Assistant tools → Installed | read | unchanged | `capabilities list --space <id>` | — | n/a | — |
| Import skill bundle | Add → Skill files | none | **prepared verb** | `tools import-skill --scope personal\|space [--space <id>] --from <path>` | source path, scope, content digest, enumerated skill names | `tools remove` | executable content is named in the receipt; blocked while affected work is active (capability-mutation fencing) |
| Install catalog capability | Discover → install | none | **prepared verb** | `tools install --id <catalog-id> --scope … [--space <id>]` | catalog id, scope, content digest | `tools remove` | the receipt embeds the inspected resource summary the person would see in Skills & Extensions |
| Install Pi package | Add → package source | none | **prepared verb** | `tools install --source <pkg> --scope … [--space <id>]` | source, scope, content digest | `tools remove` | a package with Extensions or install scripts is a code-execution act and the receipt names it, exactly as the desktop review does |
| Update Pi package | Installed → Update | none | **prepared verb** | `tools update --source <pkg> --scope … [--space <id>]` | source, scope, prior and new content digests | reinstall the prior pinned version | updates change runnable bytes; pinned versions stay pinned |
| Remove Pi package | Installed → Remove | none | direct verb | `tools remove --source <pkg> --scope … [--space <id>]` | source, scope | reinstall is a fresh prepared verb | blocked while affected work is active — the kernel's capability-mutation fencing, unchanged |

Scope is authority: `--scope personal` makes bytes runnable inside the fold's
own runtime on next start; the receipt names that scope for what it is.

### Space app authority

Restricted Space apps keep their separate reviewed-web lane; nothing here
touches Pi's package manager or loaded catalog. Installation grants every
declared power (F21); the grant, connection, and automation rows below are
the person's narrowing and re-allowing controls.

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List proposals | Chat proposal | none | direct verb (act read) | `apps proposals list --space <id> --conversation <id>` | — | n/a | — |
| Dismiss proposal | Chat proposal → dismiss | none | direct verb | `apps proposals dismiss --space <id> --conversation <id> --proposal <id>` | proposal id | the Assistant may propose again; the preview it installed is removed with `apps remove` | — |
| List installed apps | Apps tab | none | direct verb (content-bearing act read) | `apps list --space <id> --json` | app count | n/a | returns installed apps with their tools, actions, grants, connections, and automations |
| Install proposal as local preview | Chat proposal (installed at once when proposed; this verb re-installs the same inspected digest) | none | **prepared verb** | `apps install-proposal --space <id> --conversation <id> --proposal <id>` | digest, granted declarations, enabled automations, destinations still needing a secret | `apps remove` | digest-pinned; desktop refuses install while an Assistant turn runs; an identical digest is idempotent |
| Add / update local preview | Chat proposal (the Apps tab has no manual add path) | none | **prepared verb** | `apps install-preview --space <id> --package <space-path>` | digest, granted declarations, enabled automations, destinations still needing a secret | `apps remove` | digest-pinned; a changed digest carries forward connections whose destination declaration is byte-identical, automation enabled states by id, and run receipts; grants follow the new declarations; an identical digest is idempotent |
| Remove app | App details → Remove | none | direct verb | `apps remove --space <id> --app <id>` | app id, digest | reinstall is a fresh prepared verb | fenced against running automation jobs |
| Re-allow network / file / notification | App details toggles | none | direct verb | `apps grant --space <id> --app <id> --digest <sha> --kind network\|files\|notifications --declaration <id>` | exact declaration | `apps revoke` (direct) | declared powers are on from install, so this re-allows after a revoke; grants bind to the exact digest and single declaration; nothing is batched |
| Revoke grant | App details toggles | none | direct verb | `apps revoke --space <id> --app <id> --digest <sha> --kind … --declaration <id>` | declaration id | re-allow with `apps grant` | revocation stops stale launches before authority changes take effect |
| Save connection | App details → Connect | none | direct verb <!-- verify: `apps connect` retained on the branch --> | `apps connect --space <id> --app <id> --destination <id>` | destination, adapter kind, `needs-secret` marker | `apps disconnect` (direct); deleting the local record does not revoke the credential at its provider — the receipt says so | the verb records the destination shape and reports that a secret is still needed; **the secret is entered by the person in the Apps tab, once per destination** — credentials never ride argv, payloads, or the journal |
| Remove connection | App details → Disconnect | none | direct verb | `apps disconnect --space <id> --app <id> --destination <id>` | destination id | reconnect by entering the secret again in the Apps tab | — |
| Re-enable automation | App details → automation toggle | none | direct verb | `apps automation enable --space <id> --app <id> --automation <id>` | job id | `apps automation disable` (direct) | declared automations are enabled at install, so this re-enables one after a disable; runs receive only the intersection of current grants and the job's reviewed permission subset |
| Disable automation | App details toggle | none | direct verb | `apps automation disable --space <id> --app <id> --automation <id>` | job id | re-enable with `apps automation enable` | — |
| Run automation now | App details → Run now | none | direct verb | `apps automation run --space <id> --app <id> --automation <id>` | run receipt id | n/a — the run already produces a durable, authority-captured receipt | scheduler admission rules apply (two slots, same-job non-overlap); a disabled job still has no notification authority |
| Invoke an app tool from the fold | — (the fold's verb; a Space Assistant calls tools in its own Space) | none | direct verb | `apps invoke --space <id> --app <id> --tool <name> --input <json>` | app id, tool name, result bytes, lineage | n/a — the tool's own effects follow their domain undo | schema and current-grant checks by `RestrictedAppService.invoke`; fenced like an app action |
| Clear app storage | App details → storage | none | **prepared verb** | `apps storage clear --space <id> --app <id>` | recovery-export entry id, byte count | `trash restore --entry <id>` | the recovery export is written into Recently deleted before live data is removed |

### App Studio

The authority-neutral spine of the App platform: everything below changes
which *local records* exist, never what may run with which powers — powers
arrive with installation and are narrowed through the rows above.

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Declare / edit presentation | App Studio form | none | direct verb | `apps project declare --space <id> --presentation <json-path>` | prior presentation ref | re-declare with prior values | typed presentation file, same validation as the pane; machine-local application state, no `.work-fold/` write |
| Prepare Release | App Studio → Prepare | none | direct verb | `apps release prepare --space <id> --version <display>` | releaseDigest | `apps release delete` while unused | snapshots current reviewed previews into one immutable content-addressed Release; later source edits cannot alter its bytes |
| Publish Release | App Studio → Publish | none | direct verb | `apps release publish --space <id> --release <digest>` | releaseDigest | delete while unused; publication records are lifecycle state, not exposure | rechecks that reviewed previews are still exact; **local state transition only** — nothing is uploaded, hosted, listed, or granted. Outward viewer exposure of a hosted Instance is the separate `pages` share verb in [Publishing](fold-publishing.md) |
| Delete unused Release | App Studio → Delete | none | direct verb | `apps release delete --space <id> --release <digest>` | releaseDigest | re-prepare from unchanged source; the record itself is gone | service guard refuses while any App Instance, either side of a prepared operation, or retained data references it — deletion destroys only a machine-local lifecycle record plus an unreferenced immutable object, never user content, which is why it needs no Recently-deleted entry |
| Prepare install | App Studio → Install | none | direct verb | `apps install prepare --space <id> --release <digest> --target-space <id>` | operationId | `apps operation cancel` | one instance per (projectId, target Space); Feature-id collisions rejected |
| Prepare update / rollback | App Studio instance actions | none | direct verb | `apps update prepare --space <id> --instance <id> --release <digest>` | operationId, direction | `apps operation cancel`; a completed update is undone by preparing the rollback | deterministic plan recorded now, rechecked at activation |
| Activate operation | App Studio → Activate | none | direct verb | `apps operation activate --space <id> --operation <id>` | operationId, resulting release | rollback is a new prepared operation | activation rechecks the plan, fences the old runtime, changes Release and authority atomically; declared powers are granted and declared automations enabled on install; a changed digest carries forward byte-identical connections, automation enabled states by id, and run receipts |
| Cancel prepared operation | App Studio → Cancel | none | direct verb | `apps operation cancel --space <id> --operation <id>` | operationId | prepare again | — |
| Uninstall with retain | Uninstall dialog → retain | none | direct verb | `apps uninstall --space <id> --instance <id> --retain-data` | instance id, retained namespace ids | reinstall creates a **new** Instance; retained namespaces do not remain runnable | fences the whole release-backed runtime; cleanup is the durable restart-retried outbox |
| Uninstall with purge / purge retained data | Uninstall dialog → purge; retained-data list | none | **prepared verb** | `apps uninstall … --purge-data` / `apps retained purge --space <id> --retained <id>` | recovery-export entry id | `trash restore --entry <id>` | `apps uninstall` without a disposition flag is refused — the choice is never defaulted; the recovery export lands in Recently deleted before live data is removed |

### The fold itself

`manage send|status|result|wait|stop|abort|list` are shipped direct verbs,
joined by `manage glance` ([the glance](fold-glance.md)). The CLI group
keeps the contract name `manage`; "the fold" is user-facing copy per
[The fold](fold.md). Routing verbs are in [Routings](fold-routings.md)
(`routings enable` is the prepared verb that pins a declaration digest);
publication verbs in [Publishing](fold-publishing.md); Recently deleted
above.

### Settings and fold administration — the setup-only boundary

No command shapes. The fold can neither perform nor request these; the act
lane never grows a verb for them, and a request that would amount to one is
refused at parse time.

| Verb | Human surface | Target |
|---|---|---|
| Configure a provider connection, API key, or provider OAuth | Settings → Assistant | **setup-only** (provider credentials) |
| Remove or replace stored provider credential | Settings → Assistant | **setup-only** |
| Remote access: create/change address, password, approve or revoke a browser, revoke generations, disable, delete | Settings → The fold ("Your fold on the web") | **setup-only** (fold-authority surface) |
| Act-token and pairing machinery: minting, scope, lifetime | none (app-owned) | **setup-only** |
| Delete now (purge one Recently-deleted entry early) or change Limits | Settings → The fold | **desktop-only** (no act verb; nothing a task needs is behind it) |

Approved remote browsers use the same verbs and receipts as the desktop;
each remote-originated receipt records the browser and grant. They cannot
touch this table.

### Deliberately absent

Absences that are decisions, not gaps:

- **Desktop-session verbs** — reveal in OS, open with native app, Quick
  Look preview, copy native path, native drag out. They act on this
  desktop's windowing session; a fold verb would be meaningless from a
  phone and a lie in a receipt.
- **Navigation and workspace state** — switching Spaces, opening tabs,
  selecting files, rail modes, pane sizes. Space-bound tabs are a desktop
  contract; the fold reads state through [the glance](fold-glance.md)
  instead of driving the person's screen.
- **UI preferences** — theme, typography, text size, collapsed folders.
  Machine-local preferences with no product meaning.
- **work-fold self-update** — check, download, install. The updater changes
  the code that enforces everything in this document; it stays a
  desktop-human action and gains no fold verb.
- **Answering extension-UI and permission prompts inside a running turn** —
  these render inside the Chat surface and can carry permission semantics;
  the fold answering them programmatically would be an answer the person
  did not give. They surface as needs-you questions in the glance and are
  answered on a chat surface by the person.
- **Composer slash commands as a fold surface** — `/compact` graduated to a
  real verb above; the rest remain conversational conveniences inside a
  turn, not product verbs.

## Conflict rules mirrored from the desktop

Consolidated, so implementations and tests can point at one list:

1. A Chat's rename, snooze, archive, resume, and compact are refused while
   that Chat's Assistant turn or Chat compaction is active (the routes'
   existing 409s). One lifecycle change per act.
2. A send into an archived or future-snoozed Chat is refused until the Chat
   is resumed — resuming is its own receipted act, never a side effect.
3. Capability mutations (`tools …`, and Check enablement's fencing) are
   blocked while affected work is active; a catalog reload can never
   silently terminate a background turn.
4. Space unregistration and managed-folder deletion run the App Studio
   impact checks: active source/target Instances block, retained data
   blocks, and incoming prepared operations are named in the refusal. Live
   publications backed by the Space block too, and are named in the refusal
   ([Publishing](fold-publishing.md)). A removal that proceeds suspends
   routings referencing that Space, stopping any active run
   ([Routings](fold-routings.md)).
5. Managed recursive deletion fails closed when the claimed tree contains
   preserved `.workspace/` data.
6. App Studio guards hold: referenced Releases cannot be deleted, prepared
   operations recheck at activation, digest identity beats display
   versions, uninstall requires an explicit retain-or-purge disposition.
7. Whole-Space History restore is refused while any Assistant turn,
   compaction, or Check run is active in that Space, while a restricted-app
   automation run whose app holds a file grant into that Space is active,
   or while a routing run with a files hop targeting that Space is active
   (the desktop uses the same reservation and refusal).
8. Restricted-app proposal execution inherits the desktop's
   no-active-turn install rule; automation runs obey the machine-wide
   scheduler's admission and non-overlap rules.
9. `files delete` never refuses for coverage reasons; paths the safety
   checkpoint cannot cover (oversized, unreadable, symlink) move into
   Recently deleted, and `.work-fold/`, `.pi/`, `.workspace/` stay invalid
   endpoints.

## Receipt schema

`WorkFoldCliActReceiptV1` (`src/local/cli/act-receipts.ts`) carries these
optional fields beyond the baseline; readers accept every prior version:

- `surface` — the authenticated surface that initiated the act, from the
  closed vocabulary `cli`, `popover`, `main-window`, `remote_web`, plus
  browser and grant ids when remote. This is the attribution control for
  remote-originated acts.
- `undoRef` — a typed reference to the prior state an undo verb needs:
  prior title or name, prior lifecycle state, prior appearance
  customization ref, safety checkpoint id, Recently-deleted entry id
  <!-- verify: undoRef kind for trash entries -->. Identifiers and digests
  only; receipts never grow file contents, message text, queries, or
  secrets.

The act protocol version advanced on 2026-09-10; readers accept every prior
version, and receipts written before that date may still carry the retired
`decisionId` and `policyId` fields and the retired `policy` and
`unrestricted` surfaces. New receipts never do.

The journal keeps its existing properties: append-only, journal-first,
rotation that never drops an entry younger than the broker freshness
window, fail-closed duplicate detection.

## Implementation record

The ledger's plan items shipped as follows (suites named in
[the management layer](management-layer.md)'s verification map):

1. Receipt schema v2 — `src/local/cli/act-receipts.ts`; `tests/work-fold-cli-act-receipts.test.ts`.
2. Act argv and command table, with parse-time setup-only refusal — `src/local/cli/act-commands.ts`; `tests/work-fold-cli-act-protocol.test.ts`.
3. Facade growth over the exact route internals — `src/local/cli/act-facade.ts`, `src/local/server.ts`; `tests/work-fold-act-facade.test.ts` plus the owning domain suites.
4. History-restore fencing and `chat compact` — `src/local/work-fold-kernel.ts`; `tests/work-fold-kernel.test.ts`.
5. Prepared verbs returning receipts — `src/local/fold-staged-acts.ts` (or its renamed successor) and the suite the verification map names <!-- verify: prepared-act module and suite names -->.
6. Surface attribution — `src/local/management-requests.ts`; `tests/management-requests.test.ts`, `tests/work-fold-management-api.test.ts`.
7. Desktop host and shims — `desktop/src/work-fold-cli-host.ts`, `desktop/cli/`; `tests/desktop-work-fold-cli-host.test.ts`, `tests/desktop-cli-packaging.test.ts`.
8. Help and read-lane text — `src/local/cli/commands.ts`; `tests/work-fold-cli-protocol.test.ts`.
9. Management-instruction teaching — `src/local/management-instructions.ts`; `tests/work-fold-management-conversation.test.ts`.
10. Documentation promotion — recorded in [Fold integration](fold-integration.md).
11. Receipts, not gates (2026-09-10) — reclassification of every formerly gated row to a prepared or direct verb, `files destroy` removed, the `trash` family, `apps list|invoke`, and `routings enable`; recorded in [Receipts, not gates](receipts-not-gates.md).

## Deliberately not in this design

- **Gate machinery.** No pending store, cards, expiry, denial memory,
  standing rules, or authority mode — removed 2026-09-10 and not to be
  reintroduced as a convenience.
- **A headless act lane.** Every verb still requires the running
  interactive app; "Open work-fold…" with exit code 6 stays the honest
  failure.
- **Caller-authentication changes.** The per-launch act token keeps its
  documented same-user posture; the ledger added attribution and lineage,
  not a new principal model.
- **Batch or transactional multi-verb acts.** One request id, one verb,
  one receipt. Composition lives in the fold's conversation or in a
  declared routing, never in the protocol.
- **Library organization controls** (rename, move, delete, reveal, bulk
  operations) — a roadmap item; until it exists on the desktop, the fold
  does not get ahead of the human surface.
- **Driving the desktop UI** — tabs, selection, navigation, preferences,
  and the updater remain outside the act lane, as listed under deliberately
  absent.
- **Renaming CLI contracts.** `work-fold manage …`, command tokens,
  protocol identifiers, and `management conversation` as a contract term
  all stay; "the fold" is user-facing copy only, per [The fold](fold.md).
