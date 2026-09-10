# Receipts, not gates

> **Status:** Accepted product direction, 2026-09-10 (owner decision). This
> record supersedes the fold's authority decisions F3–F7 and F17 and narrows
> F8, F9, and F18. It is the specification for the `receipts-not-gates`
> build and for the collaboration primitives that follow it. Until the build
> ships, the canonical documents still describe the gated product; every
> contradiction between them and this record is resolved in favor of this
> record, and the build rewrites those documents.

## The principle

work-fold is a single-user, local product whose Assistants already hold the
person's full local authority: every Pi session has read, bash, edit, and
write tools that reach whatever the person can reach. The staged-act
ceremony never prevented anything those tools could do; it only routed a
subset of actions through approval cards. That ceremony was friction on the
everyday path without being a security boundary.

The replacement principle is **receipts, not gates**:

1. **Every verb executes immediately.** There is one authority mode. No
   action a person or an Assistant asks for waits on a card, a policy, a
   toggle, or a second click.
2. **Every effect leaves a receipt.** The journal-first, at-most-once,
   identity-pinned act path stays. It is attribution and recovery
   machinery, not a gate.
3. **Every destruction is reversible.** Nothing the product does is
   permanent at the moment it happens. Ordinary deletion is covered by
   History; everything History cannot cover goes to a machine-local trash
   with a retention window. Outward exposure is revocable. Grants are
   revocable.
4. **Disclosure is after the fact.** The glance, receipts, and the Apps tab
   tell the person what happened. "Needs you" means an Assistant asked a
   question, never that an action is waiting for approval.
5. **The only human-only surfaces are not work.** Entering a secret,
   pairing a browser, and enrolling a remote address establish identity or
   secrets. No task ever needs them mid-flight, so they never block a task.
6. **Bounds are defaults, not caps.** Limits exist so a runaway stops and so
   envelopes stay sane. They are generous, visible in Settings where a
   person might want to raise them, and every limit hit names the limit.
7. **One shape for everyone.** The fold, a Space Assistant, an app, a
   routing, and an outside harness on the CLI use the same verbs, the same
   receipts, the same result and question shapes. A feature that needs its
   own lifecycle or its own grant kind is a smell.

## Decision register additions

These entries join the register in [fold.md](fold.md). F3–F7 and F17 are
retained there as history with a "superseded by F19" note.

| # | Decision (2026-09-10) | What it does not change |
|---|---|---|
| F19 | **One authority mode.** The Reviewed/Unrestricted selector, standing policies, decision cards, the pending-decision store, remote `decisions.*` operations, and the `staged` CLI family are removed. The fifteen formerly staged verbs plus `apps uninstall --purge-data` are direct receipted verbs that run through the existing prepare, pin, journal-first, fenced execution path immediately. | Receipts, identity pins, effect-time rechecks, at-most-once execution, failure-without-auto-retry, capability-mutation fences, and turn-conflict rejection all stay. |
| F20 | **Reversible destruction.** `files delete` always succeeds: History covers what it can, and every path the safety checkpoint cannot cover is moved into the machine-local trash. `files destroy` is removed. `spaces delete` moves the managed folder into the trash and unregisters it. App storage clear, retained-data purge, and uninstall-with-purge write a recovery export into the trash before removing live data. Trash entries are restorable from Settings → Recently deleted and from `work-fold trash list|restore`, and are purged only by retention (default 30 days, adjustable). | The clean-break rule for legacy `.workspace/` trees, History's own capture limits, and the rule that `.work-fold/`, `.pi/`, and `.workspace/` are never valid file endpoints. |
| F21 | **Apps come up able to work.** Installing a preview or a release grants every declared network destination, file permission (a directory permission binds to the whole Space), notification category, and Check-result slot, and enables every declared automation. A code change carries forward connections whose destination declaration is byte-identical, automation enabled states by id, and run receipts. Proposing an app from a Space Chat installs its local preview immediately; the proposal record is the receipt. `apps grant`, `apps revoke`, `apps disconnect`, and `apps automation disable` remain as the person's narrowing controls. | Secrets stay person-entered on the trusted surface, once per destination. The sandbox, brokers, declared destinations, and credential isolation of app code are unchanged: they bound generated code, not the Assistant. |
| F22 | **Apps use the AI runtime without a click.** `assistant.request` dispatches a fresh full-tools Chat in the owning Space immediately and is available to active views, workers, and named automations. A new `assistant.infer` operation performs a bounded model call on the Space's configured model with no tools, no transcript, and optional schema-validated JSON output, available to views and workers. Neither needs a grant beyond installation. Both leave receipts with the effective model and usage. Viewers and remote app views get neither. | Full Assistant work and bounded inference stay distinct operations with distinct powers. Model selection stays with the person per Space and for the fold. |
| F23 | **Cross-Space glue runs on request, not on ceremony.** `routings stage` becomes `routings enable`, a direct receipted verb that pins the declaration digest. Chat-step messages accept a closed set of host-resolved placeholders for the triggering event and earlier steps' created files. A `fold` step kind sends a message into the management conversation, so a person can put the fold on a cadence deliberately. Run slots and step counts are raised to generous defaults. | Routing-caused settles still never fire triggers, observers still pause during routing work, and the files step is still additive and restore-pointed. Those are loop guards and recovery, not gates. |
| F24 | **Needs-you means questions.** The glance's needs-you section carries Assistant questions, due snoozes, and requests waiting on a person's answer. Nothing there is an approval. Approved browsers see the same. | The glance stays a deterministic digest with no model call. |

Narrowed earlier decisions:

- **F8** keeps its ban on ambient or arbitrary event-driven fold turns. It
  now permits a routing's declared `fold` step and, in the collaboration
  work, bounded continuations of a person-initiated request.
- **F9** becomes a payload-admission rule rather than a transport rule: what
  may enter a Space Chat from above is its assignment, explicitly released
  payloads, and answers to its own questions. The fold transcript, the
  Space registry, and other Spaces' results never enter a Space Chat.
- **F18**'s text-review Check keeps its evidence admission; it is no longer
  the only bounded model lane, and `assistant.infer` reuses its transport.

## What changes in the shipped product

### The fold's authority surfaces

- Settings → The fold loses the Authority selector and the Standing policies
  section. It gains Recently deleted (trash) and a Limits section for the
  defaults named in this record.
- The Needs-you surfaces (main window, popover, web client) render questions
  and due snoozes only. Decision cards, approve/deny controls, and the
  no-self-approval and Personal-scope-desktop-only rules are deleted.
- The remote operation vocabulary drops `decisions.list` and
  `decisions.decide`. The web client stops rendering decision cards and
  tolerates a desktop that no longer advertises them.
- `src/local/fold-authority.ts`, `fold-policies.ts`, `fold-decisions.ts`,
  and `fold-decision-cards.ts` are removed along with their tests and
  Settings routes. `fold-staged-acts.ts` is reduced to the prepare-pin-
  journal-execute path that every formerly staged verb now takes; naming
  may change to "prepared acts" if that reads more honestly.
- Act responses for those verbs return the receipt like any direct verb. No
  `decisionId`, `state: staged`, `autoApproval`, expiry, or denial fields.
  The act protocol version advances; old receipts stay readable, and
  receipts no longer carry `policy` or `unrestricted` surfaces.
- The `staged list|show|cancel` commands and `help staged` are removed.

### Trash

- New machine-local store under the state root (`trash/`), with a manifest
  per entry: source Space id, original Space-relative path or folder, kind
  (file, folder, space, app-storage, app-retained), size, deleted-at,
  restore-by, and the receipt id that produced it.
- Producers: `files delete` for uncoverable paths, `spaces delete`,
  `apps storage clear`, `apps retained purge`, `apps uninstall --purge-data`.
  The desktop's Delete action and Undo toast keep working; Undo restores from
  History or trash as appropriate.
- Consumers: Settings → Recently deleted (list, Restore, Delete now), and
  act verbs `trash list --json` and `trash restore --entry <id>`. Retention
  purge runs on app start and daily while awake. No verb empties the trash;
  nothing a task needs is behind that.

### Space apps

- Install and update defaults per F21, including the carry-forward rules on
  a changed digest and idempotent identical-digest installs.
- `propose_space_app` installs the local preview immediately with all
  declared grants and reports what it installed and which destinations
  still need a person to connect a secret. The tool's model-facing guide
  documents `assistantActions`, `assistant.request`, `assistant.infer`,
  `permissions.checks`, and the new defaults.
- Assistant requests: no review state. Journal, dispatch, and expose status,
  result, and Open Chat and Stop in the Apps tab. Bounds raised to 64 KiB
  input and 256 KiB result; up to four running per installation. Available
  to the worker bridge.
- `assistant.infer({ instructions, input, outputSchema?, maxOutputBytes? })`
  returns `{ text }` or `{ json }` validated against the closed schema
  subset already used for app tools. Input up to 256 KiB. Up to four
  concurrent per installation. Reuses the bounded transport that the Check
  reviewer and title generation already use. Receipts record the effective
  model and usage.
- The fold gains `apps list --space <id> --json` (installed apps, their
  tools, actions, grants, connections, automations) and
  `apps invoke --space <id> --app <id> --tool <name> --input <json>`
  through `RestrictedAppService.invoke`, with lineage and receipts.

### Routings

- `routings enable --proposal <path>` replaces `routings stage`. Everything
  else in the family keeps its name.
- Chat-step and fold-step messages accept a closed placeholder set resolved
  host-side: `{{trigger.summary}}`, `{{trigger.changedFiles}}`,
  `{{trigger.findings}}`, `{{steps.<id>.createdFiles}}`. Unknown
  placeholders are a declaration error at enable time; resolved text is
  bounded and recorded on the hop receipt.
- New step kind `fold` with a message, sent into the management
  conversation as a new thread through the same acceptance path.
- Defaults: 16 steps, 8 concurrent runs. `help routings` and the fold's
  instructions are updated.

### The fold's taught behavior

- `management-instructions.ts` loses the "Authority follows local Settings"
  section and every mention of staging, cards, policies, denial, expiry, or
  Unrestricted. It gains trash, app defaults, `apps list|invoke`,
  `routings enable`, placeholders, and the `fold` step. The report section
  describes receipts and restore paths instead of decision states.
- Delegation guidance stays; the non-blocking wait arrives with the
  collaboration work.

### Documents and copy

Rewrite to promise receipts and undo instead of gates: `AGENTS.md` (Product
rails, act-lane paragraph, harness parity), `docs/product-model.md`,
`docs/fold.md` (register and one-sentence definitions),
`docs/fold-consecrations.md` (shrink to a superseded note plus the
threat-model residuals that still apply), `docs/fold-act-ledger.md`
(reclassify every consecration row), `docs/fold-routings.md`,
`docs/fold-glance.md`, `docs/fold-publishing.md`, `docs/management-layer.md`,
`docs/app-assistant-tasks.md`, `docs/restricted-app-runtime.md`,
`docs/restricted-app-authoring.md`, `docs/ui-parity.md`, `SECURITY.md`,
`PRIVACY.md`, `README.md`, `docs/README.md`, the shared Skills under
`.agents/skills/`, and the web client and bridge copy. User-facing copy
never says staged, card, approve, policy, or mode.

## What does not change

- Secrets, pairing, and remote enrollment stay desktop-human-only.
- History, restore points, the Undo toast, and the explicit-context rail.
- Portable `.work-fold/` records, `.pi/` as executable configuration, and
  registration as the authorization for a folder's Pi resources.
- The app sandbox, brokers, credential isolation, digest pinning, and the
  rule that apps never enter Pi's package manager.
- Capability-mutation fences and turn-conflict rejection. Where a fence
  would refuse a short wait, prefer queueing.
- Content-free protocol v1 and the per-launch act token.
- Native Pi compatibility and the absence of any harness-specific policy.

## The collaboration primitives, amended

[assistant-collaboration-plan.md](assistant-collaboration-plan.md) remains the
design for durable requests, typed results, questions, and declared
actions. Under this record it is amended as follows and built as the second
wave:

- **No per-action grants for app AI.** F22 replaces the plan's bounded-
  inference grant with installation-level availability.
- **Questions need no schema.** A free-text answer that continues the
  waiting task is the common case; a schema is an optional upgrade.
- **Budgets are settings.** Deadline, depth, child count, and provider
  budget are generous defaults in Settings → The fold → Limits. Hitting one
  stops the request visibly and names the setting.
- **Waiting is a host state.** `chat wait` and the fold's own turn never
  block on a child that is waiting for input; the child's task waits, the
  parent's turn yields, and one accepted answer continues exactly once.
- **The CLI harness is a participant.** Report, question, result, and
  handoff verbs are act-lane verbs first, so Claude Code, Codex, or any
  shell-capable agent gets them on the same terms as a Space Assistant.
- **Host-routed handoffs.** A result released to a destination already
  named by the request is delivered by the host without a fold model turn.
- **Space turns get their own context.** Task id, an opaque parent handle,
  and a compact operations guide, never the fold transcript or registry.

## Build plan

Two waves, each a gated workflow of agents on the `receipts-not-gates`
branch, with checkpoint commits at wave boundaries.

**Wave A (this record):** survey → disjoint foundations (trash store,
inference transport, register and contract docs) → gate removal → app
defaults and AI lanes → trash wiring → routings → taught behavior, copy,
and remaining docs → full gates (`npm run check`, `npm test`,
`npm run desktop:prepare`, bridge suite) → adversarial review and fix.

**Wave B (collaboration):** durable request record → Space turn context and
guide → report, question, continuation, and non-blocking wait → result
envelope and resource references → host-routed handoff and fold-side
declared actions → owned-id subscriptions → docs → gates → review.

Acceptance for wave A, in the running app and the CLI:

- No surface offers an authority mode, a policy, or a decision card.
- Every formerly staged verb executes on first call and returns a receipt.
- Deleting an uncoverable file, deleting a managed Space, and clearing app
  storage each produce a restorable trash entry, and restore works.
- A newly installed app can reach its destinations, files, notifications,
  and Checks, and its automations run, without any grant click.
- An app's `assistant.request` starts a Chat immediately; `assistant.infer`
  returns validated JSON; both appear as receipts.
- The fold can list and invoke an app's tools.
- A routing enables on one call, resolves placeholders, and can message the
  fold.
- `grep` finds no user-facing copy containing "staged", "approve",
  "policy", "Reviewed", or "Unrestricted" outside history notes.
