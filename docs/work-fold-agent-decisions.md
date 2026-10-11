# work-fold agent decision register

> **Current presentation language.** The **work-fold agent** is the Worker
> above all Folders. This decision register retains *the work-fold agent* where it names
> its historical technical contract, routes, storage, CLI, and identifiers.
> **Automations** is the visible name for the deterministic automation feature.

> Request lifecycle consolidation: the [collaboration contract](collaboration-contract.md#completion-delivery-and-recovery)
> governs completion across turns. Questions use `chat ask|answer` or `agent
> ask|answer`; an accepted answer remains outstanding until linked. The work-fold agent,
> work-folder and app owners receive bounded, recorded child-result deliveries.
> App status/stop/usage follow the owned request, and task result reads expose
> its selected envelope. Transport fields and concurrent execution remain
> bounded; requests and automations have no lifetime or declaration-count quota.


In the development desktop, installed-app catalogs receive content-free host
invalidation while visible, so a CLI act appears without restarting;
reconnecting re-reads current records, and these hints carry no grant and
replay no action.

The **work-fold agent** is the one user-facing name for work-fold's one management
surface in three coats: the **work-fold agent** above all work-folders, its
**menu-bar/tray popover** ("Your fold"), and the **Remote access web client**
("Your fold on the web"). It is the one door to all work-folders: things come in
through it (drops, attachments, uploads, `files add`) and go out through it
(the publishing ladder). work-folders are the rooms; the work-fold agent is the door.

> **The work-fold agent is the one door to all your work-folders: what you hand it gets put
> where it belongs, what you ask for gets done with a receipt, and nothing it
> does is permanent at the moment it happens.**

This document records the decisions the work-fold agent's implementation and product
surfaces must preserve, alongside the canonical registers that absorbed the
work-fold agent's rails, nouns, and contract text on 2026-08-11:
[Product model](product-model.md) (nouns, explicit-context rows, rails 9–11,
the roadmap direction), `AGENTS.md` (contributor rails, act-lane families),
[the work-fold agent layer](work-fold-agent-and-cli.md) (receipts, prepared acts,
remote operations, the verification map), `README.md`, `SECURITY.md`,
`PRIVACY.md`, [Desktop parity](ui-parity.md), and
[the visual system](visual-design.md). The sibling documents are shipped
contract references retaining the detail canon does not carry:

- [Receipts, not gates](receipts-not-gates.md) — the 2026-09-10 decisions F19–F24, the trash, app defaults, app AI lanes, and automation changes.
- [The collaboration contract](collaboration-contract.md) — the 2026-09-11 decisions F25–F30: durable requests, work-folder turn context, report/ask/answer/handoff, one result shape, app change hints.
- [The verb ledger](act-ledger.md) — every product verb's classification, command shape, receipt additions, undo path, and conflict rules.
- [Consecrations](archive/fold-consecrations.md) — superseded 2026-09-10; retained for the threat-model residuals that still apply.
- [Automations](automations.md) — declared deterministic cross-work-folder glue: triggers, declarations, the executor, and bounds.
- [The overview](work-fold-agent-overview.md) — the deterministic digest: sources, sections, markers, surfaces, and non-goals.
- [The publishing ladder](shared-pages.md) — the viewer audience class, rungs 1–3, origin isolation, and the bridge's viewer plane.
- [Integration](archive/fold-integration.md) — the promotion record: applied amendment blocks, cross-thread reconciliations, and the items still held with their gates.

## The doctrine in one paragraph

The work-fold agent has a ledger: every product verb executes on the call
that asks for it, pinned, journaled before execution, and receipted after.
There is one authority mode; nothing waits on a card, a standing rule, or a
second click. Every destruction is reversible — History covers what it can
and Recently deleted holds the rest for a retention window — and every
exposure and grant is revocable. Disclosure is after the fact: the overview,
receipts, and Settings → Apps say what happened, and needs-you means an
Assistant asked a question. Setup that establishes identity or secrets —
pairing, provider secrets, remote enrollment — stays outside the act
vocabulary and never blocks a task. Bounds are generous defaults in
Settings, and every limit hit names the limit. A person's ask is a durable
request: the work-fold agent and Workers divide it into child turns, hand each
other one result shape, ask each other and the person questions, and continue
exactly once when an answer arrives. Waiting is a host state, so no turn sits
on a child that is waiting. Above work-folders, only declared deterministic
automations run unattended. The overview is the app-composed digest
of recorded state; narration of it is interactive, never scheduled. Outward,
the publishing ladder serves "pages your fold serves" to link-scoped viewers
who never touch the management lane.

What the work-fold agent is **not**:

- Not a work-folder. Its transcript is machine-local application state and never
  travels with a folder.
- Not a second Assistant, persona, or brand voice. Replies stay labeled
  work-fold; the work-fold agent is where you meet it and what the conversation is
  called.
- Not a rename of anything else. **work-folder**, **Library**, **Assistant
  tools**, **Chats**, and **History** are untouched; there is no "foldr".
  (The desktop Library and the Skills & Extensions tab were retired on 2026-09-25
  by the information-architecture amendment in [the product model](product-model.md);
  that was a separate decision, not a fold rename.)
- Not a new technical contract. `work-fold agent …`, the
  `work-fold-agent` scope id, the `/api/management/*` routes, the
  `management.*` remote-facade methods, the `management/` application-state
  root, and "work-fold agent" as a contract term all stay exactly as
  documented in [the work-fold agent layer](work-fold-agent-and-cli.md).

## Decision register

Recorded from the product owner on **2026-08-10**; promoted into the
canonical documents on 2026-08-11 through the amendment blocks recorded in
[Integration](archive/fold-integration.md). The siblings design within these
decisions, not around them. Rows without an inline date were recorded on
2026-08-10. F3–F7 and F17 are retained as history and superseded by F19
(2026-09-10); F8, F9, and F18 are narrowed as noted in their rows. The
2026-09-10 decisions F19–F24 are recorded here verbatim from
[Receipts, not gates](receipts-not-gates.md), which remains their
specification. The 2026-09-11 decisions F25–F30 are recorded here verbatim
from [the collaboration contract](collaboration-contract.md), which remains
their specification; F8 and F9 keep the narrowings that record relies on.

| # | Decision (dated) | What it does not change |
|---|---|---|
| F1 | One thing, one name: the work-fold agent, the menu-bar/tray popover, and the Remote access web client are one product surface named **the work-fold agent** — the one door to all work-folders, capture in and publish out. | No new runtime, transcript store, or Assistant; the three surfaces keep their existing machinery. |
| F2 | Scope: one complete effort, no phases. Four threads — verb ledger, automations + overview, naming and copy, publishing ladder — delivered as proposal documents; implementation follows owner review. | Nothing in this set is implemented before that review. |
| F3 | **Superseded by F19 (2026-09-10).** The work-fold agent becomes able to do anything a person can do in the app, with a receipt for everything — except the consecrations and the never-list. | The click remains the product's definition of authorization; receipts are added, trust prompts are not. |
| F4 | **Superseded by F19 (2026-09-10).** Tier model: exactly two tiers (direct receipted verbs; consecrations) plus a never-list. There is no general "co-sign everything big" tier. | Standing policies narrow consecrations; they do not create a third tier. |
| F5 | **Superseded by F19 (2026-09-10).** Remote consecration clicks: a consecration decision may be approved from the desktop **or** from any approved full-trust remote browser. Compensating controls: every decision receipt names the approving surface and exact browser identity/grant; revoking a browser cancels that browser's pending decisions; a staged act is never decidable from the same remote grant whose request staged it; make-runnable at Personal scope (code loading into the work-fold agent's own runtime) is decided on the desktop only; the never-list is untouched. | The never-list is not weakened to match; Remote access administration itself stays desktop-human-only. |
| F6 | **Superseded by F19 (2026-09-10).** The three consecrations are **make bytes runnable**, **widen a power**, and **destroy irreversibly**; the work-fold agent may stage all three, and only a human click completes them. Staged acts expire; expiry is not approval; denial is recorded, not retried. | Existing individual grants (destinations, file roots, notification categories, connections, named automations) stay separate acts; consecration is their shared ceremony, not a merge. |
| F7 | **Superseded by F19 (2026-09-10).** Standing policies are person-authored outside any assistant turn, host-evaluated at decision time, inspectable, revocable, and receipted when exercised. The work-fold agent may cite policies, never write them. | No model-authored policy, ever; policy evaluation never moves into the model. |
| F8 | Agency on a schedule always lives in work-folders. Above work-folders, only declared deterministic glue (automations) runs unattended; enabling an automation is a consecration. *Narrowed 2026-09-10:* keeps its ban on ambient or arbitrary event-driven fold turns; now permits an automation's declared `fold` step and, in the collaboration work, bounded continuations of a person-initiated request. Enabling an automation is one receipted call (F23). | Only a declared automation step starts a scheduled work-fold agent turn; the overview's narration stays on-demand. |
| F9 | Management-scope and cross-work-folder work never runs inside a work-folder chat, because work-folder transcripts are portable (`.work-fold/conversations/` travels with the folder) and cross-work-folder context in a work-folder transcript is a leak. *Narrowed 2026-09-10:* a payload-admission rule rather than a transport rule — what may enter a work-folder Chat from above is its assignment, explicitly released payloads, and answers to its own questions; the work-fold agent transcript, the work-folder registry, and other work-folders' results never enter a work-folder Chat. | Delegated in-work-folder work continues to run in work-folder chats with that work-folder's Assistant. |
| F10 | The overview is a deterministic digest composed by app code from kernel-recorded state only — no model call, no file scanning, no ambient watching. | Nothing new is recorded to feed it; it reads state the product already keeps. |
| F11 | Publishing introduces the **viewer**: per-artifact, read-only, link-scoped, revocable, receipted. Viewers are not paired browsers and never touch the management lane. Out of scope: public discovery, an App Store, uptime promises. | Paired-browser trust and the bridge's content-free default are not redefined by viewer traffic. |
| F12 | Naming depth: user-facing copy and docs only. The CLI keeps `work-fold agent …`; internal types, protocol identifiers, scope ids, routes, provenance values, and "work-fold agent" as a contract term stay. | Brand word and contract words do not have to match; no compatibility break is spent on a rename. |
| F13 | Copy specifics: **"Fold it in"** is the capture verb; Settings → Remote access becomes **"Your fold on the web"** without renaming technical contracts; the word work-folder stays; no "foldr"; work-folders are never renamed to folds. | work-folder, Library, Skills & Extensions, Chats, History vocabulary is untouched. |
| F14 | Automation chat-step provenance: the message an automation sends into a work-folder chat is an **ordinary user-role message** — the portable transcript carries no automation marker. Attribution is machine-local: automation run receipts, hop journals, run history, and the overview. *Narrowed 2026-09-10 (F23):* the reviewed message is a template; the closed set of host-resolved placeholders is the only substitution, and the resolved text is bounded and recorded on the hop receipt. | The interruption-marker semantics of work-folder chats and the F9 leak rule are untouched; the message is still reviewed at enablement and names nothing cross-work-folder beyond what the declared placeholders carry. |
| F15 | The work-fold agent's Settings surface is one section named **Settings → The work-fold agent**, hosting **Your fold on the web** (web access) as a subsection alongside standing policies, automation management, and publication controls. *Narrowed 2026-09-10 (F19, F20):* the section hosts Your fold on the web, Recently deleted, Limits, automation management, and publication controls; it has no standing-rules or authority subsection. | Page ids and routes stay technical per F12; "Remote access" survives in contract and security prose. |
| F16 | At promotion, [fold.md](work-fold-agent-decisions.md) shrinks into a compact fold decision register named by AGENTS.md's required reading (the Checks precedent); the siblings shrink into it as their sections ship. | product-model.md remains the constitution; the amendment blocks in [Integration](archive/fold-integration.md) still apply exactly as written. |
| F17 | **Superseded by F19 (2026-09-10).** **Authority modes** (2026-08-31): Settings → The work-fold agent → Authority offers **Reviewed** and **Unrestricted**. Reviewed preserves host-composed cards and standing policies. Unrestricted executes every newly admitted staged act, including irreversible destruction, viewer exposure, automation enablement, and whole-work-folder file grants. Approved browsers inherit it structurally through the desktop host. Mode changes, pairing, and credential entry remain local setup surfaces with no Assistant/CLI/remote verb. Existing pending cards are not drained when the mode changes. | Pins, eligibility, effect-time rechecks, journal-first consumption, receipts, fences, at-most-once execution, and failure-without-auto-retry remain intact. The five setup-only families are boundaries of identity and secret handling, not recurring approvals. |
| F18 | **Explicit folder observation and text review** (2026-09-05): version-3 automations may watch one bounded folder with explicit types, debounce, and cooldown. Watchers baseline on startup/wake and pause during automation work, without catch-up, to prevent file feedback loops. Cross-work-folder composition remains one ordered automation. The built-in text-review Check uses the work-fold agent's selected model with only designated text and criteria, no conversation or general tools, and quote/digest admission. *Narrowed 2026-09-10:* the text-review Check keeps its evidence admission; it is no longer the only bounded model lane, and `assistant.infer` reuses its transport. | Observation is an exact standing grant, never inferred from opening a work-folder. Model findings are suggestions; provider charges and target limits are disclosed at enablement. |
| F19 | **One authority mode** (2026-09-10). The Reviewed/Unrestricted selector, standing policies, decision cards, the pending-decision store, remote `decisions.*` operations, and the `staged` CLI family are removed. The fifteen formerly staged verbs plus `apps uninstall --purge-data` are direct receipted verbs that run through the existing prepare, pin, journal-first, fenced execution path immediately. | Receipts, identity pins, effect-time rechecks, at-most-once execution, failure-without-auto-retry, capability-mutation fences, and turn-conflict rejection all stay. |
| F20 | **Reversible destruction** (2026-09-10). `files delete` always succeeds: History covers what it can, and every path the safety checkpoint cannot cover is moved into the machine-local trash. `files destroy` is removed. `work-folders delete` moves the managed folder into the trash and unregisters it. App storage clear, retained-data purge, and uninstall-with-purge write a recovery export into the trash before removing live data. Trash entries are restorable from Settings → Recently deleted and from `work-fold recently-deleted list|restore`, and are purged only by retention (default 30 days, adjustable). | The clean-break rule for legacy `.workspace/` trees, History's own capture limits, and the rule that `.work-fold/`, `.pi/`, and `.workspace/` are never valid file endpoints. |
| F21 | **Apps come up able to work** (2026-09-10). Installing a preview or a release grants every declared network destination, file permission (a directory permission binds to the whole work-folder), notification category, and Check-result slot, and enables every declared automation. A code change carries forward connections whose destination declaration is byte-identical, automation enabled states by id, and run receipts. Proposing an app from a work-folder Chat installs its local preview immediately; the proposal record is the receipt. `apps grant`, `apps revoke`, `apps disconnect`, and `apps automation disable` remain as the person's narrowing controls. | Secrets stay person-entered on the trusted surface, once per destination. The sandbox, brokers, declared destinations, and credential isolation of app code are unchanged: they bound generated code, not the Assistant. |
| F22 | **Apps use the AI runtime without a click** (2026-09-10). `assistant.request` dispatches a fresh full-tools Chat in the owning work-folder immediately and is available to active views, workers, and named automations. A new `assistant.infer` operation performs a bounded model call on the work-folder's configured model with no tools, no transcript, and optional schema-validated JSON output, available to views and workers. Neither needs a grant beyond installation. Both leave receipts with the effective model and usage. Viewers and remote app views get neither. | Full Assistant work and bounded inference stay distinct operations with distinct powers. Model selection stays with the person per work-folder and for the work-fold agent. |
| F23 | **Cross-work-folder glue runs on request, not on ceremony** (2026-09-10). `automations stage` becomes `automations enable`, a direct receipted verb that pins the declaration digest. Chat-step messages accept a closed set of host-resolved placeholders for the triggering event and earlier steps' created files. A `fold` step kind sends a message into the work-fold agent, so a person can put the work-fold agent on a cadence deliberately. Run slots and step counts are raised to generous defaults. | Automation-caused settles still never fire triggers, observers still pause during automation work, and the files step is still additive and restore-pointed. Those are loop guards and recovery, not gates. |
| F24 | **Needs-you means questions** (2026-09-10). The overview's needs-you section carries Assistant questions, due snoozes, and requests waiting on a person's answer. Nothing there is an approval. Paired browsers see the same. | The overview stays a deterministic digest with no model call. |
| F25 | **Durable requests** (2026-09-11). Every accepted Assistant turn belongs to a machine-local request record. A work-fold agent turn creates a root request; a `chat send --parent-task` creates a child request under it; a work-folder turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory work-fold agent request registry is replaced by this store; `agent status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. work-folder transcripts carry nothing new. |
| F26 | **work-folder turns get their own context** (2026-09-11). Every work-folder turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way work-folder instructions are, describing the verbs below and the rule that cross-work-folder work goes through them. The work-fold agent transcript, the work-folder registry, and unselected results from other work-folders never enter a work-folder turn. | Nothing is written into the work-folder's folder. `.pi/` and `.work-fold/` are untouched. |
| F27 | **Report, ask, answer, handoff.** work-folder-scoped collaboration verbs and management-scoped `agent ask|answer`, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` and `agent answer` durably reserve one answer delivery and start exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another work-folder with a message and copies of named files. Delivery is host-side: no work-fold agent model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Automations remain the only unattended cross-work-folder glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `agent wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When an owning Chat is idle and its children have settled or asked questions, the host can start one continuation carrying undelivered direct-child reports. This applies to the work-fold agent, work-folder, app, CLI and automation requests. Delivery is recorded by child turn identity, never inferred from relative settle times. | No arbitrary event-driven fold turns. A continuation belongs to an explicit request; declared automation agent steps remain the only trigger-driven entry. |
| F29 | **One result shape** (2026-09-11). A result envelope is `summary` (text, at most 4 MiB since 2026-10-10), optional `data` (JSON, at most 16 MiB, validated against a schema when the request declared one), optional `files` (work-folder-relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and automation chat hops all produce it. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the Assistant chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Active views subscribe; workers receive task/file hints during an operation, while Check access and hints remain view-only. Viewers do not subscribe. A hint carries ids and revisions, never content; the app re-reads. | Hints never start a model turn. The internal settle signal stays private. |

## One-sentence definitions

2026-10-08 deletion amendment: F20 guarantees recovery coverage after a
deletion can run; it does not override busy-work conflicts. Files, Chats,
and work-folders cannot be deleted while their affected request work is
unfinished or still draining after Stop. Managed parent deletion also
requires removing nested registrations first. See [Trash recovery](receipts-not-gates.md#trash)
for interruption-safe folder and History moves.

- **The verb ledger:** every product verb is a receipted act-lane verb —
  explicit selection, journal-first receipt, at-most-once execution, desktop
  conflict rules — except the setup-only boundary.
- **A prepared act:** the execution shape formerly gated verbs still take —
  host-prepared typed facts, identity pins, effect-time recheck,
  journal-first consumption, fenced execution, at most once, never
  auto-retried — run immediately on the call that asks for it and answered
  with a receipt.
- **Recently deleted (the trash):** the machine-local store under the state
  root where every deletion History cannot cover goes — files, folders, a
  managed work-folder's folder, app storage and retained-data exports — with a
  manifest per entry, restorable from Settings → Recently deleted and
  `work-fold recently-deleted list|restore`, purged only by retention (default 30
  days).
- **Setup-only authority:** the three families with no model/CLI/remote
  verb: Remote access administration, act-token and pairing machinery,
  provider credentials — identity and secrets, never a mid-task wait.
- **An automation:** a machine-local, inert-until-enabled declaration of
  deterministic steps (`chat`, `files`, `check`, `fold`) on one
  reviewed trigger, executed by app code with per-hop receipts; enabling it
  is one receipted call that pins the declaration digest.
- **A request:** the machine-local record that owns one outcome — who asked,
  the turns and work-folders it spans, its questions, its results, and its usage —
  living under the state root's `requests/` directory,
  reconciled against the turn journal after a restart and never replayed.
- **A question:** a durable record of one Assistant asking the person or its
  parent for something. One accepted answer delivers exactly one
  continuation turn in the asking Chat; a second answer, an answer after
  Stop, and an answer from a work-folder that does not own the
  question are refused.
- **A result envelope:** the one shape every report, app assistant task,
  handoff outcome, and automation chat hop produces — a summary, optional
  structured data, optional chosen files, and an outcome of succeeded,
  partial, or failed.
- **Waiting:** a host state, not a blocked process. `chat wait` and
  `agent wait` return when the task they follow settles or starts waiting
  and say which; a parent turn finishes rather than sitting on a waiting
  child; and one continuation turn per settle batch carries the collected
  reports back.
- **The overview:** a deterministic digest — running work, needs-you questions
  and due snoozes, what changed since the person last looked, Check status —
  composed by app code from recorded state only.
- **A viewer:** anyone holding a share link to one published page or hosted
  app; read-only, link-scoped, revocable, receipted, never a paired
  browser, never a Principal.

## Naming and copy rules

1. **the work-fold agent** is written lowercase like the work-fold wordmark, always
   with an article or possessive: "the work-fold agent", "your fold". It names the one
   door — the conversation and every surface that opens it. Never "Fold" as
   a capitalized proper noun, never "a fold", never plural.
2. **work-fold stays the actor.** The person tells work-fold what to do and
   replies stay labeled "work-fold". The work-fold agent is the place and the
   conversation's name, not a second persona — so imperative strings
   ("Tell work-fold what to do", "Message work-fold") keep the product as
   addressee.
3. **"Fold it in"** is the popover composer's capture verb, shown exactly
   when material is being handed over (reference chips present). A
   message without material is just "Send". The web client does not carry
   the two-state label: its send button is always "Send message". The
   popover has no permanent drop-zone instruction; its whole surface shows a
   drop affordance only while files, folders, or links are being dragged over
   it. While a request runs, the same aligned composer action reads **Stop**;
   it does not create a second action row.
4. **"Your fold on the web"** is the user-facing name of the web-access
   area inside **Settings → Web access**. "Web access" is the
   short operational form inside that area (toggle, danger actions, errors).
   "Remote access" survives wherever a document speaks contract or security
   posture.
5. **Contract terms are frozen** (decision F12): `work-fold agent …`, the
   `work-fold-agent` scope id, `/api/management/*`, `management.*`
   remote-facade methods, the `management/` application-state root, the
   `remote_web` provenance value, and the `remote` settings page id. A
   document's first user-facing use binds the vocabularies once — "the work-fold agent
   (technically: the work-fold agent)" — then each section speaks
   its own language.
6. **Publishing copy** says "pages your fold serves", never "host your
   website". Honest absence states stay honest: an offline desktop is
   "asleep", not an error page pretending otherwise.
7. work-folder, Library, Skills & Extensions, Chats, and History copy is untouched.
   *(2026-09-25: the desktop Library and the Skills & Extensions tab were retired
   separately; Skills & Extensions is the surface's only name.)*
8. **Receipts, not gates, in copy.** Person-facing strings never say staged,
   card, approve, policy, mode, Reviewed, or Unrestricted. Needs you names
   questions and due snoozes. Recently deleted is the trash's name; Restore
   and Delete now are its actions; a limit that stops work names the setting
   in Settings → Automations → Limits.

The shipped copy inventory is pinned by `tests/work-fold-brand.test.ts`
(popover title, tray entry, two-state send button),
`tests/onboarding-welcome.test.ts`, the bridge package's
`services/bridge/copy.test.mjs`, and
`tests/work-fold-agent-conversation.test.ts` (the model-facing identity
line keeps the phrase "work-fold agent").

## Where the work-fold agent lives in code

The [work-fold agent layer](work-fold-agent-and-cli.md)'s implementation and verification
map is the authority; in brief: prepared acts in
`src/local/prepared-acts.ts`, the Recently deleted store under the state
root's `recently-deleted/` directory with its module in `src/local/recently-deleted-store.ts`,
automations under `src/local/automations/`, the overview in `src/local/overview.ts` and
`src/local/overview-seen-store.ts`, publications in `src/local/publications.ts`
with the bridge's viewer plane in `services/bridge/`, the verb families in
`src/local/cli/act-commands.ts` and `src/local/cli/act-facade.ts`, and the
taught behavior in `src/local/work-fold-agent-instructions.ts`.

## Deliberately not

- **No localization pass.** The product is English-only today; the copy
  rules above are English rules and would need their own decision before
  translation.
- **No marketing surface.** The bridge landing page keeps its factual
  register; no taglines beyond the shipped copy, no "host your website"
  framing anywhere (rule 6).
- **No enforced tool restriction of the work-fold agent.** It remains full-trust and
  taught, per [the work-fold agent layer](work-fold-agent-and-cli.md) and the residual
  risks restated in [Consecrations (superseded)](archive/fold-consecrations.md);
  changing that is a separate deliberate design.
- **No gate reintroduced as a convenience.** A confirmation, hold, or
  approval state on any verb is a register decision, not a UI tweak.
- **No fold on a cadence.** A continuation turn belongs to a
  person-initiated request and happens once per settle batch, within that
  request's limits. It is not a schedule, a watcher, or an event bus, and
  F8's ban on ambient fold turns is unchanged.

## Fold-led Checks

Checks authoring uses the work-fold agent, with an unsent draft from the work-folder-owned Checks tab. `checks propose` and `checks propose-fix` are authenticated, receipted, explicitly work-folder-scoped inert proposal operations; neither enables a Check nor edits a target. Trials and human-reviewed corrections use the same Check service and reservations. The work-fold agent popover stays focused on conversations and has no separate Checks disclosure. Findings prepare unsent help drafts in fresh work-folder Chats; no model turn starts merely because a finding appears. See [Checks](checks.md) for the exact review, History, freshness, and trial-isolation contract.
