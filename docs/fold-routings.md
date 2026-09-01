# Routings: declared cross-Space glue

**Status: shipped contract reference.** Routings shipped with the fold build
— `src/local/routings/` (declarations, store, settle signal, executor) and
its suites are the implementation authority — and their decisions were
promoted on 2026-08-11 into [the fold](fold.md) decision register (F8, F9,
F14), [Product model](product-model.md) (the Routing noun, the
enable/run context rows, rail 11), `AGENTS.md` (the above-Space cadence
rail), [the management layer](management-layer.md) (the verification map),
`README.md`, `SECURITY.md`, and `PRIVACY.md`. This document retains what
canon does not carry: the trigger vocabulary and its exclusions, the
declaration and step contracts, the executor's failure semantics, the
lifecycle and five-questions record, and the bounds. The promotion record is
[Fold integration](fold-integration.md).

The first expansion shipped on 2026-09-01: the declaration contract now
accepts versions 1 and 2, version 2 adds a bounded one-time `at` trigger,
and Settings → The fold → Routings is the desktop management surface. The
store schema is version 2; version-1 records load and are rewritten as
version 2 on the next mutation, while newer schemas still fail closed.

A **routing** is a machine-local, inert-until-enabled declaration of
deterministic steps that move work between Spaces: start a Space Chat with a
fixed message, copy files from one Space into another with a History restore
point, run a Check. It is executed by app code on the shared scheduler
discipline, never by an open-ended Assistant conversation, and it is the
only thing above Spaces that runs unattended. A routing is not a workflow
language: no conditions, no branching, no retries, no loops, no expression
templating, and no model call anywhere in the executor. Agentic work happens
only inside a Space Chat step, run by that Space's own Assistant with that
Space's own authority.

## The rule this design enforces

Space Chat transcripts are portable: `.work-fold/conversations/` travels
with the folder. Cross-Space work run inside a Space Chat would write
cross-Space context into a folder that travels — a leak no convenience
justifies (decision F9). Routings enforce the boundary structurally:

- The declaration, enablement grant, cadence anchor, health state, and every
  run receipt are machine-local application state. Nothing routing-shaped is
  ever written under any Space's `.work-fold/`.
- A Chat step sends only the fixed message text the person reviewed at
  enablement, into a new conversation in that one Space. The executor
  appends no ambient context, no other Space's name, no trigger detail. The
  person approves that exact string knowing it becomes portable transcript
  content in that Space.
- The only cross-Space transfer is the files step: bytes copied through the
  same additive, restore-pointed path as `files add`. Transcript text is
  never relayed between Spaces by the executor.
- The portable traces a routing leaves are all single-Space ordinary
  records: a new Chat in Space A, copied files and a History restore point
  in Space B. Neither Space's folder learns the other exists.

Per decision F14, the message a routing's chat step sends is an **ordinary
user-role message** — the portable transcript carries no automation marker,
and someone reading it cannot distinguish a routing-sent message from a
person-sent one. Attribution lives entirely in machine-local records: the
routing run receipt and hop journal name the exact conversation and message,
run history shows every dispatch, and the glance lists routing runs.

## Triggers

A routing has exactly one declared trigger; manual run-now is additionally
available for every enabled routing. Triggers are evaluated by app code from
state the product already records — no file watcher, no polling of Space
content, no model involvement.

**Admitted on-settled sources** (both durable and already receipted):

- **`check-run`**: a named Space's Check run reached a terminal state —
  optionally scoped to one Check id, filtered by outcome (default
  `succeeded`; `failed` and `aborted` may be named explicitly;
  `interrupted` is never admissible — it marks a crash, not a result).
- **`app-automation-run`**: a named Space's restricted-app named automation
  run settled — scoped to app id and automation id, filtered by outcome
  (default `success`; `failure` may be named explicitly; `skipped` and
  `cancelled` are never admissible — they are lifecycle artifacts, and
  chaining on them oscillates).

**Deliberately excluded as trigger sources:** Assistant-turn settles
(standing behavior keyed to a person finishing a chat is ambient watching of
their conversation activity, and the records are in-memory only — the real
need, "after the Space Assistant finishes, move its output," is served
inside a run, where the Chat step waits for its own turn), compaction
settles (no recorded outcome), and management-request settles (fold-side,
in-memory, and glue firing from fold conversation activity would blur
interactive management into unattended behavior).

**Routing-caused settles never fire triggers.** A Check run or automation
run whose lineage records a routing hop is dropped at trigger evaluation,
making routing chains structurally impossible — no cycles, no fan-out.
Composition happens inside one routing, up to its step bound; chains would
be a separate register decision with its own depth budget.

**The recurring schedule trigger** is `{"kind": "interval", "intervalMinutes": N}`
with the restricted-app automation bounds reused as-is (15–1440 minutes).
Cadence is durable — a persisted `lastScheduledAt` anchor resumes across
restarts — and catch-up is bounded to the existing `latest` policy: at most
one make-up run for the most recent missed slot, staggered by the shared
deterministic jitter. Missed slots never queue.

**The one-time schedule trigger** is
`{"kind":"at","at":"2026-09-01T21:00:00-04:00","ifMissed":"run"}`
and requires declaration version 2. `at` must carry an explicit UTC offset;
normalization stores one UTC instant. Enablement rechecks that the instant is
at least 1 minute and no more than 366 days ahead. `ifMissed` is `run` or
`skip`: after launch or wake, `run` admits one bounded catch-up for the exact
slot while `skip` records that the occurrence did not run. Nothing runs while
work-fold is quit.

Sleep does not spend work that never launched. If a due `run` occurrence is
waiting for a scheduler slot when suspension cancels the admission, its
durable record remains enabled and the exact slot is admitted once on resume.
An `ifMissed: "skip"` occurrence instead records `run: skipped` followed by
the routing lifecycle `completed`, with no hop execution.

A scheduled one-time occurrence is consumed at most once. The executor
writes the strict run `accepted` receipt, then commits a deterministic
occurrence claim `{occurrenceId, slotAt, consumedAt, runId}`, then begins hop
1. That claim moves the routing to `completed`; success, failure, Stop, or
interruption do not re-arm it. Startup reconciles a crash between acceptance
and claim by consuming the same deterministic occurrence and recording the
run interrupted. Completed records remain visible until a person deletes
them and keep counting against the 32-routing bound.

**Manual run-now** (`work-fold routings run`) is a direct verb: available
for every *enabled* routing, receipted, never a schedule mutation. Run-now
on a merely proposed routing is refused: enablement is what binds the
person's review to the exact declaration digest, and the executor must never
run an unreviewed standing declaration, even once.
For a one-time routing, Run now executes an independent copy and leaves its
declared slot untouched. After the slot is consumed, completed health refuses
Run now; another occurrence is a new proposal and enablement.

## The declaration

Authoring follows the Check-proposal pattern: the fold writes an inert,
typed, kind/version JSON file (`work-fold.routing-proposal`, version 1 or 2,
`.work-fold-routing.json` suffix) in its own management working folder —
never inside a Space folder, because the proposal names multiple Spaces and
Space folders travel. `src/local/routings/routing-declarations.ts` is the
schema authority. Spaces are pinned by stable Space id; duplicate names are
rejected as ambiguous, and the review surface resolves ids to current names
and folders so the person approves something readable.

Declarations are closed, typed data under the same discipline as Check
declarations: no prompts beyond the literal Chat-step message, no
instructions, no source code, no shell commands, no model names, no
credentials, no connection data, no expressions. The Chat-step `message` is
bounded (16 KiB) and is data addressed to one Space's Assistant, reviewed
verbatim at enablement.

### Steps

At most 8 steps, executed strictly in order. Three kinds:

- **`chat`** — start a **new** conversation in the named Space with the
  fixed message, through the same acceptance path as
  `work-fold chat send --new`: conflict checks, kernel `assistant_turn`
  task, pre/post-turn History checkpoints, portable transcript persistence.
  Always a new conversation — sending into an existing Chat can collide
  with a person's live turn, and standing behavior must not entangle itself
  with an interactive thread. The hop waits for exactly its own turn's
  task-scoped terminal outcome; `failed` or `aborted` fails the hop.
- **`files`** — copy from one Space's folder into another's through the
  same additive internals as `files add`: collision-rename on existing
  names, and a targeted restore point that succeeds or fails together with
  the placement. Copy only — a routing never moves, renames, or deletes
  anything in the source Space. The source is an explicit list of exact
  Space-relative paths (at most 25), one bounded tree selector reusing the
  Check target contract and resolver discipline (tighten-only hard limits;
  symbolic links, `.work-fold/`, `.pi/`, preserved `.workspace/`, and
  nested registered Spaces rejected), or the declared created-files handoff
  below. Free glob or regex patterns were rejected: the bounded tree
  selector is the already-hardened enumeration primitive with review
  semantics a person can actually read.
- **`check`** — run one named Check (or all enabled Checks) in the named
  Space through the same path as `work-fold checks run`. The hop succeeds
  when the run settles `succeeded` — **including when it admits findings**:
  findings are content state for the person; glue is not a gate. `failed`,
  `aborted`, or `interrupted` fails the hop.

### Static parameters, and the one handoff

Every step parameter is a literal reviewed at enablement; there is no
step-output-to-step-input templating. The single exception is the
**declared created-files handoff**: a `files` step may name an earlier
`chat` step in the same routing as its source
(`{"kind": "step-created-files", "step": "<id>"}` plus mandatory bounds —
`maxFiles` and `maxTotalBytes` required, extension filters optional). It
resolves host-side and deterministically as the manifest diff between that
turn's own pre/post checkpoints, filtered by the declared bounds; no model
output is parsed. Fail-closed edges: a missing checkpoint of the pair, or a
filter-matching file the capture skipped (oversized or unreadable), fails
the hop with a typed error naming the gap — a partial handoff is never
silently delivered.

Determinism covers **selection, not content**. The copied bytes are whatever
the chat step's turn wrote — model output, steered by the fixed message and
by whatever the source Space's folder contains at run time. An enabled
routing with this handoff is a standing, content-dependent channel from the
source Space into the destination Space; the enablement card states this in
plain words. Every delivery is inspectable after the fact: the hop receipt
lists the exact copied paths, and the glance's routing-run-settled item
names the destination Space and the delivered file count.

### Storage split

| Record | Location | Reason |
|---|---|---|
| Inert routing proposal | Ordinary file in the fold's management working folder | Reviewable and revisable without authority; never placed in a Space folder it names |
| Enabled declaration, exact-digest grant, cadence/occurrence claim, health state | work-fold application state (`routings/` under the state root) | References multiple Spaces; must never travel with any folder |
| Routing-run and hop receipts | work-fold application state, append-only journal with rotation | Contains Space names, paths, and ids across Spaces |
| Effects inside Spaces | Ordinary Space records: a new Chat transcript, copied files, a History restore point | The only portable traces are single-Space, ordinary, and restorable |

## The executor

The routing service (`src/local/routings/routing-service.ts`) owns execution
as app code. It creates its **own** instance of the existing
`WorkFoldAutomationService` — the same class, the same discipline, a
separate two-slot budget with `ownerId: "work-fold.routing"`. Sharing the
restricted-app service's instance was rejected: it would let one Space
app's jobs starve cross-Space glue and couple two authority domains to one
lifecycle. That buys, verbatim from the proven scheduler: FIFO admission,
per-routing non-overlap (an overlapping admission settles `skipped` and is
receipted as such), interval and one-time schedules, durable cadence,
bounded catch-up with
deterministic stagger, suspension and resumption across sleep and quit, and
abort signals through every run.

Every run is journal-first on the act-receipts discipline: a run `accepted`
record before hop 1 — an unwritable journal refuses the run — and a
terminal record after; each hop writes its own accepted/terminal pair
carrying the underlying domain evidence (chat hop: conversation id, turn
task id, outcome, checkpoint ids; files hop: source and destination Space
ids, resolved and copied paths with collision renames, counts, restore-point
id; check hop: Check ids, run id, terminal state, finding counts). The run's
terminal record names the trigger cause exactly — scheduled slot, run-now
request id, or the settled source — plus the declaration digest in force.

**Failure.** A failed hop fails the run; later hops are recorded `skipped`
with the failing hop named. There are no retries — the next trigger
occurrence is the retry, and the receipt trail makes the failure
inspectable rather than smoothed over. Infrastructure refusals inside a hop
fail the hop with the typed reason; they are glue health, never silently
skipped work.

**Stop.** A direct verb and a desktop control. It aborts the current hop
through that domain's own abort path (a files hop is not interruptible
mid-copy — the copy either completes with its restore point or fails as one
unit); later hops are `skipped`, the run settles `stopped`, and the receipt
names every hop task it aborted, exactly as `manage stop` names child turns.

**Disable.** Revocation of standing behavior: it journals the disable,
persists the disabled state, cancels pending admissions, and stops the
active run through the stop path — then reports what it stopped. Disable
never destroys the declaration, grant history, or receipts.

**Referenced Space removed.** Removing any Space a step or trigger names
revokes the enablement grant and puts the routing in a durable `suspended`
health state with the missing Space id recorded; the active run, if any, is
stopped. A suspended routing never runs, never retargets, and never resumes
automatically — not even when a folder carrying the same portable Space
identity is re-registered, because registration must never silently re-arm
standing behavior. Copy distinguishes "Space removed" from "re-registered
with preserved identity"; the semantics are deliberately identical, and
leaving suspension is a fresh enablement consecration over the unchanged
declaration.

**Crash mid-run.** Startup scans the journal for runs with an `accepted`
record and no terminal record and appends `interrupted` — record, never
replay. Completed hops keep their receipts; the in-flight hop resolves
through its own domain's crash semantics. Before writing that terminal,
startup reconciles the accepted scheduled slot into the durable interval
anchor or one-time occurrence claim. The same slot is therefore never
replayed under a new run id, including a crash after acceptance but before
the original process committed the claim.

**Replay prevention.** Run ids are host-minted per admission; trigger
evaluation is serialized in-process at the settlement funnels; scheduled
slots are claimed durably after acceptance and before hop 1, with missed
interval slots collapsed and one-time occurrences deterministically named;
run-now rides the act lane's request-id at-most-once gate. The journal-first
`accepted` gate plus startup `interrupted` recovery means a crash can
interrupt a run but never execute it twice under one run id.

**Trigger delivery.** The two admitted settle families publish typed settle
records — after durable persistence, fire-and-forget, failure-isolated —
through the settle-signal seam (`src/local/routings/settle-signal.ts`)
attached at the Check service's terminal-persistence funnel and the
restricted-app `onResult` funnel; the seam has one owner (reconciliation 8
in [Fold integration](fold-integration.md)). Settle records carry lineage,
so routing-caused runs are dropped at evaluation; settles during suspension
are not queued. Routing runs register as the experimental kernel task kind
`routing_run`, excluded from stable protocol-v1 task projections like
`check_run`.

## Lifecycle and authority

1. **Propose.** The fold (or a person, by hand) writes the inert typed
   proposal. Nothing is registered, armed, or scheduled; proposals are
   ordinary files with no authority.
2. **Stage enablement.** A receipted act-lane command submits the proposal
   for enablement, producing a pending decision: fully prepared,
   inspectable, inert. Staged decisions expire; expiry is not approval;
   denial is recorded, not retried.
3. **Consecrate.** Enabling a routing is consecration 2 — widening a power
   into standing behavior — and no standing policy can pre-approve it. In
   Reviewed it requires the human click described by
   [fold-consecrations.md](fold-consecrations.md), from the desktop or an
   eligible approved browser. In Unrestricted the desktop host consumes a
   fresh admission automatically, including when the staging request came
   from an approved browser. The receipt records the decision surface and
   browser identity, and revoking a browser cancels its pending decisions.
   In Reviewed, the card shows the whole declaration in review form: every
   Space by current name and folder, the Chat step's message verbatim —
   labeled as text that will enter that Space's portable transcript — exact
   paths, selectors, filters and bounds, the Check by title, and the
   trigger; a created-files handoff is stated plainly as future model
   output shaped by the source Space's content. Enablement records an
   exact-authority grant over the declaration digest. The digest pins the
   declaration, not the referenced Spaces' capabilities: a chat step runs
   with whatever Assistant authority its Space holds at run time — stated
   on the card, with the deliberate absence of re-review machinery recorded
   below. The declaration write and the grant commit are one logical
   operation; a failure may leave an inert declaration, never undeclared or
   digest-mismatched authority.
4. **Run.** Scheduled, on-settled, or run-now. Any edit to the declaration
   changes its digest and returns the routing to proposed until a fresh
   consecration — an edited routing never coasts on a stale approval.
5. **Disable.** A direct verb (and a desktop control): narrowing authority
   is always direct. Re-enable is a fresh consecration governed by the mode
   active at that admission.
6. **Delete.** A direct verb on an inert disabled, suspended, or completed
   routing: removes the declaration, grant history pointer, and cadence
   anchor. An active or claimed-but-unfinished one-time run must settle or be
   stopped first. The receipts journal is retained — audit records survive
   the object, as with Checks.

The five questions, per mutation:

| Mutation | Journaled by | Receipt contains | Revoked / undone by | Mid-act failure | Replay prevented by |
|---|---|---|---|---|---|
| Stage enablement | Act-lane journal (`accepted` before, terminal after) plus the pending-decision record | Proposal digest, routing summary, staging actor, parent-task lineage | Expiry, explicit denial, browser revocation cancelling its pending decisions | Staging is inert; a torn stage is an absent decision, refused at decision time | Act request-id at-most-once; single-use decision ids |
| Enable | Consecration decision record plus routing store commit | Routing id, declaration digest, decision surface/browser identity, timestamp | Disable; Space removal (automatic revocation to `suspended`) | Declaration-then-grant as one logical operation; failure leaves inert declaration, never digest-mismatched authority | Single-use decision id; expired stages cannot be approved |
| Run (scheduled / on-settled) | Routing receipts journal, run `accepted` then durable schedule claim before hop 1, per-hop accepted/terminal pairs | Trigger cause, digest, occurrence id for one-time work, per-hop domain evidence (task ids, run ids, conversation id, restore-point id, counts) | Stop (active); files effects restorable via the hop's restore point; chat effects are an ordinary archivable Chat | Startup reconciles an accepted slot, records `interrupted`, and never replays it; completed hops keep receipts | Host-minted run ids; journal-first accepted gate; pre-hop interval/occurrence claim; serialized trigger funnel |
| Run-now | Act-lane journal plus the same run journal | As above, plus the act request id | Same as a run | Same as a run | Act request-id at-most-once plus run-id gate |
| Stop | Act-lane journal (or desktop action record) plus run terminal record | Run id, aborted hop task ids, skipped hops | Not applicable — stop is itself the revocation act | Abort signals are idempotent; a second stop finds a settled run | Act request-id at-most-once; a settled run refuses stop with its terminal state |
| Disable | Act-lane journal plus routing store | Prior state, stopped run id if one was aborted | Re-enable (fresh consecration) | Disabled intent persists first; startup refuses to arm a disabled routing; the active run at a crash is `interrupted` anyway | Act request-id at-most-once |
| Delete | Act-lane journal plus routing store | Routing id, digest, final health state | Not undoable; the declaration was inert data and receipts are retained | Active and claimed-but-unfinished occurrences are refused; grant is removed before declaration so no window holds authority without a declaration | Act request-id at-most-once |

## Where routings live in the product

Routings are managed in **Settings → The fold** (decision F15) — Assistant
tools was rejected because a routing is not one Space's object, and a
management work tab was rejected because it would spend the Space-bound tab
contract's own deliberate design. The Settings section carries the list,
state, declaration, bounded run history, and valid actions; pending enablement
decisions surface as needs-you cards. The fold narrates run history on demand,
never on a schedule. A routing's effects remain visible where they land: the copied
files and restore point in the destination Space's Files and History, the
new conversation in the source Space's Chats.

The CLI act-lane group is `work-fold routings list|show|stage|run|stop|
disable|delete|receipts` — per-launch token, journal-first, and like the
`manage` group routings are above Spaces and take no `--space`.
`list`/`show`/`receipts` are content-bearing (Space names, paths, messages)
and therefore act-lane, matching the Checks rule that only aggregate status
lives in the content-free read lane; a content-free routing status
projection for read-lane protocol v1 remains a separate deliberate
decision, not assumed.

## Bounds

Everything is bounded, enforced at declaration parse and again at
execution:

| Bound | Value | Source of the value |
|---|---|---|
| Routings per machine | 32 | Small on purpose — glue, not a job system |
| Steps per routing | 8 | Composition beyond this suggests a Space app or a human process |
| Triggers per routing | 1 (plus always-available run-now) | This design |
| Interval | 15–1440 minutes | `restrictedAppAutomationIntervalMinutes` |
| Catch-up | `latest` only (one make-up run) | `WorkFoldAutomationService` |
| One-time horizon | 1 minute–366 days ahead at enablement | Long enough for annual planning, bounded enough for intentional review |
| One-time missed policy | `run` or `skip` | One bounded catch-up or one recorded non-run |
| One-time occurrence | One scheduled/resume claim ever; completed retained until Delete | Durable completed health and deterministic occurrence id |
| Concurrent routing runs | 2, FIFO, machine-wide | Scheduler default |
| Exact source paths per files step | 25 | `maxActFromPaths` |
| Tree selector resolution | The Check target resolver's hard limits; tighten-only | `src/local/checks/target-resolver.ts` |
| Created-files handoff | `maxFiles` and `maxTotalBytes` mandatory in the declaration | This design |
| Chat step message | 16 KiB | A fixed dispatch message, not a document |
| Run history / journal | 500 recent results; journal rotation on the act-receipts pattern | Scheduler default; `src/local/cli/act-receipts.ts` |

## Implementation record

The plan items shipped as follows:

1. Settle-signal seam — `src/local/routings/settle-signal.ts`; `tests/work-fold-routing-settle-signal.test.ts`.
2. Declaration and proposal schema — `src/local/routings/routing-declarations.ts`; `tests/work-fold-routing-declarations.test.ts`.
3. Routing store and receipts journal — `src/local/routings/routing-store.ts`; `tests/work-fold-routing-store.test.ts`.
4. Executor service and the `routing_run` kernel kind — `src/local/routings/routing-service.ts`, `src/local/work-fold-kernel.ts`; `tests/work-fold-routing-service.test.ts`, `tests/work-fold-kernel.test.ts`.
5. Space-removal revocation — `src/local/space.ts`; `tests/local-space.test.ts`.
6. Act-lane verbs — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/work-fold-cli-act-protocol.test.ts`, `tests/work-fold-act-facade.test.ts`.
7. Consecration wiring — staged enablement through [fold-consecrations.md](fold-consecrations.md)'s machinery; `tests/fold-decisions.test.ts`, `tests/work-fold-routing-service.test.ts`.
8. Fold instruction teaching — `src/local/management-instructions.ts`; `tests/work-fold-management-conversation.test.ts`.
9. Settings surface, needs-you cards, glance projection — `web-local/`; `tests/routings-settings-ui.test.ts`, `tests/fold-routing-settings.test.ts`, `tests/web-ui-contract.test.ts`, `tests/frontend-interaction-contract.test.ts`.
10. Docs promotion — recorded in [Fold integration](fold-integration.md).
11. Version-2 one-time scheduling and schema migration — `src/local/agent/work-fold-automation-service.ts`, `src/local/routings/`; `tests/work-fold-automation-service.test.ts`, `tests/work-fold-routing-declarations.test.ts`, `tests/work-fold-routing-store.test.ts`, `tests/work-fold-routing-service.test.ts`.

## Deliberately not in this design

- **Routing chains.** Routing-caused settles never fire triggers; multi-hop
  behavior across routings is excluded structurally, not merely bounded.
- **Assistant-turn, compaction, and management-request triggers**, for the
  reasons recorded under Triggers.
- **File-change triggers.** That is a watcher; [Checks](checks.md) already
  rejects background watchers, and routings do not reintroduce one.
- **Templating, expressions, conditions, branching, retries, or any
  step-output piping** beyond the declared created-files handoff.
- **Cross-Space moves or deletions.** The files step only copies additively
  with restore points; destructive operations stay human, and irreversible
  destruction anywhere remains the third consecration.
- **Recurring time-of-day and calendar schedules.** One-time absolute
  instants are admitted in version 2; daily, weekday, monthly, and
  RRULE-shaped recurrence remain later register decisions.
- **A newer-than-last-successful-run filter on `files` steps.** Recopying
  unchanged selector matches is safe by construction (additive,
  collision-renamed, restore-pointed), just noisy; the filter is deferred
  until dogfooding shows the noise matters.
- **Re-consecration when a referenced Space's capabilities change.** The
  enablement digest pins the declaration; the Spaces it names govern their
  own capabilities through their own consecrations. Disclosed on the
  enablement card as a residual rather than policed with re-review
  machinery; if dogfooding shows it bites, that machinery is a register
  decision of its own.
- **Portable or shared routings.** Declarations never enter `.work-fold/`,
  sync, export, or any distribution lane.
- **A routings rail destination, badge, or notification stream.** Settings
  owns management; the glance and receipts own visibility.
- **Read-lane routing status.** All routing commands remain act-lane.
- **Hosted or remote execution.** Routings run only on this desktop while
  the app runs; outward exposure of anything a routing produces stays in
  [the publishing ladder](fold-publishing.md) with its own grants, and no
  routing step may create or widen viewer exposure.
- **A general job system.** Two slots, small bounds, three step kinds. If a
  flow does not fit, it belongs to a Space app's named automations, a
  Check, or a person.
