# Routings: declared cross-Space glue

**Status: proposal.** Nothing in this document is implemented or decided.
[The work-fold management layer](management-layer.md) and
[the product model](product-model.md) remain the decision registers; when this
ships, decisions are promoted there and this document shrinks. Amendments this
design requires in canonical documents are collected as explicit before/after
blocks in [fold-integration.md](fold-integration.md).

A **routing** is a machine-local, inert-until-enabled declaration of
deterministic steps that move work between Spaces: start a Space Chat with a
fixed message, copy files from one Space into another with a History restore
point, run a Check. It is executed by app code on the shared scheduler
discipline, never by an open-ended Assistant conversation. Routings are the
only thing above Spaces that runs unattended; everything else
[the fold](fold.md) does is an interactive, receipted
[direct verb](fold-act-ledger.md) or a staged
[consecration](fold-consecrations.md).

A routing is not a workflow language. There are no conditions, no branching,
no retries, no loops, no expression templating, and no model call anywhere in
the executor. Agentic work happens only inside a Space Chat step, run by that
Space's own Assistant with that Space's own authority.

## The rule this design exists to enforce

Space Chat transcripts are portable: `.work-fold/conversations/` travels with
the folder wherever it is copied, synced, or shared. The management
conversation's transcript is deliberately machine-local for exactly this
reason — it describes this computer's Space registry
([management layer](management-layer.md)). Cross-Space work run inside a Space
Chat would therefore write cross-Space context — other Spaces' names, paths,
and contents — into a folder that travels. That is a leak, and no convenience
justifies it.

Routings enforce the boundary structurally:

- The declaration, enablement grant, cadence anchor, health state, and every
  run receipt are machine-local application state. Nothing routing-shaped is
  ever written under any Space's `.work-fold/`.
- A Chat step sends only the fixed message text the person reviewed at
  enablement, into a new conversation in that one Space. The executor appends
  no ambient context, no other Space's name, no trigger detail, no summary of
  another Space's content. The person approves that exact string knowing it
  becomes portable transcript content in that Space.
- The only cross-Space transfer is the files step: bytes copied through the
  same additive, restore-pointed path as `work-fold files add`. Transcript
  text is never relayed between Spaces by the executor.
- The portable traces a routing leaves are all single-Space ordinary records:
  a new Chat in Space A, copied files and a History restore point in Space B.
  Neither Space's folder learns the other exists.

The scheduled-agency corollary from the fold doctrine: agency on a schedule
always lives in Spaces. A routing may schedule *dispatch* — the fixed message,
the copy, the Check run — but the thinking happens inside the Space that owns
it. A single-Space routing (one scheduled Chat step) is legitimate for the
same reason, though the motivating cases span Spaces.

## What can trigger a routing

A routing has exactly one declared trigger; manual run-now is additionally
available for every enabled routing. Triggers are evaluated by app code from
state the product already records — there is no file watcher, no polling of
Space content, and no model involvement.

### Settle events that exist today

The on-settled trigger vocabulary must be grounded in settlement facts the
host actually records. Today there are five families:

| Settle family | Terminal states | Recorded where | Durability |
|---|---|---|---|
| Assistant turn (Space Chats and the management conversation) | `succeeded`, `failed`, `aborted` | `SettledTurnRecord` in `src/local/server.ts`; the kernel `assistant_turn` task finishes | In memory for the app run; the portable transcript stays the durable record |
| Chat compaction | none recorded | the kernel `compaction` task finishes | No outcome record |
| Check run | `succeeded`, `failed`, `aborted`, `interrupted` | `WorkFoldCheckRunState` in `src/local/checks/check-types.ts`, persisted in machine-local Check state by `src/local/checks/check-service.ts`; startup records `interrupted` for a crashed run | Durable |
| Restricted-app automation run | `success`, `failure`, `skipped`, `cancelled` | `WorkFoldAutomationRunResult` from `src/local/agent/work-fold-automation-service.ts`, persisted as digest-scoped run receipts by `src/local/agent/restricted-app-service.ts` | Durable |
| Management request | `done`, `failed`, `stopped` (after `working`, `needs_you`, `handed_off`) | `WorkFoldActManagementRequestPhase` in `src/local/cli/act-facade.ts` | In memory for the app run |

One structural fact matters for implementation: the kernel has no settle
stream. `WorkFoldKernel.finishTask` (`src/local/work-fold-kernel.ts`) deletes
the running record without an outcome; every settlement fact above lives at
the owning domain's own terminal funnel. The trigger seam therefore attaches
to those funnels, not to the kernel.

### Admitted trigger sources

Version 1 admits two on-settled sources, both durable and already receipted:

- **`check-run`**: a named Space's Check run reached a terminal state —
  optionally scoped to one Check id, filtered by outcome (default:
  `succeeded` only; `failed` and `aborted` may be named explicitly;
  `interrupted` is never admissible — it marks a crash, not a result).
- **`app-automation-run`**: a named Space's restricted-app named automation
  run settled — scoped to app id and automation id, filtered by outcome
  (default: `success` only; `failure` may be named explicitly; `skipped` and
  `cancelled` are never admissible — they are lifecycle artifacts of
  non-overlap, suspension, and revocation, and chaining on them oscillates).

Deliberately excluded as trigger sources:

- **Assistant-turn settles.** They fire on interactive human conversation —
  standing behavior keyed to a person finishing a chat is ambient watching of
  their conversation activity, which the explicit-context rail exists to
  prevent. They are also in-memory only. The real need — "after the Space
  Assistant finishes, move its output" — is served *inside* a run: the Chat
  step waits for its own turn to settle before the next hop runs.
- **Compaction settles.** Internal maintenance with no recorded outcome.
- **Management-request settles.** Fold-side, in-memory, and glue that fires
  from fold conversation activity would blur the line this design draws
  between interactive management and declared unattended behavior.

**Routing-caused settles never fire triggers.** A Check run or automation run
whose lineage records a routing hop is dropped at trigger evaluation. This
makes routing chains structurally impossible — no cycles, no fan-out, no
emergent multi-routing behavior that nobody declared. Composition happens
inside one routing, up to its step bound. If real use demands chains, that is
a separate register decision with its own depth budget, not a default.

### The schedule trigger

`{"kind": "interval", "intervalMinutes": N}` with the restricted-app
automation bounds reused as-is: 15 to 1440 minutes
(`restrictedAppAutomationIntervalMinutes` in
`src/local/agent/restricted-app-manifest.ts`). Cadence is durable: the routing
store persists a `lastScheduledAt` anchor exactly as restricted-app
automations do, so restarts resume the cadence rather than resetting it.
Catch-up is bounded to the existing `latest` policy: after downtime, at most
one make-up run for the most recent missed slot, staggered by the shared
deterministic 1–31 s jitter (`workFoldAutomationCatchUpStagger`). Missed
slots never queue. Time-of-day and calendar schedules are deliberately out of
version 1; the interval vocabulary matches what the scheduler already proves.

### Manual run-now

`work-fold routings run` is a [direct verb](fold-act-ledger.md): available for
every *enabled* routing, receipted, and never a schedule mutation — it does
not enable, shift, or reset the cadence, mirroring the shipped
run-app-automation-now semantics in [the product model](product-model.md).
Run-now on a merely proposed routing is refused: enablement is what binds the
person's review to the exact declaration digest, and the executor must never
run an unreviewed standing declaration, even once. The fold can still do
equivalent one-off work through ordinary direct verbs, so nothing is lost.

## The declaration

### Proposal shape

Authoring follows the Check-proposal pattern in
`src/local/management-instructions.ts`: the fold writes an inert, typed,
kind/version JSON file in its own management working folder — never inside a
Space folder, because the proposal names multiple Spaces and Space folders
travel. The proposal kind is `work-fold.routing-proposal`, version 1, with the
`.work-fold-routing.json` suffix convention:

```json
{
  "kind": "work-fold.routing-proposal",
  "version": 1,
  "name": "Weekly review handoff to Publisher",
  "createdBy": "assistant",
  "createdAt": "2026-08-10T17:00:00Z",
  "routing": {
    "title": "Move settled review notes to Publisher",
    "trigger": { "kind": "interval", "intervalMinutes": 1440 },
    "steps": [
      {
        "id": "review",
        "kind": "chat",
        "space": "<manuscript-space-id>",
        "message": "Review chapters/ for unresolved notes and write a summary to reports/weekly-review.md."
      },
      {
        "id": "handoff",
        "kind": "files",
        "fromSpace": "<manuscript-space-id>",
        "from": { "kind": "step-created-files", "step": "review", "extensions": ["md"], "maxFiles": 10, "maxTotalBytes": 10485760 },
        "toSpace": "<publisher-space-id>",
        "to": "Incoming/Manuscript"
      },
      {
        "id": "verify",
        "kind": "check",
        "space": "<publisher-space-id>",
        "check": "<check-id>"
      }
    ]
  }
}
```

An on-settled trigger names its source explicitly:

```json
"trigger": {
  "kind": "on-settled",
  "source": { "kind": "app-automation-run", "space": "<space-id>", "appId": "<app-id>", "automationId": "collect", "outcomes": ["success"] }
}
```

Spaces are pinned by stable Space id. A staging command may accept an exact
name for convenience, but the stored declaration and the enablement grant
record ids only — duplicate names are rejected as ambiguous, matching the act
lane's existing rule. The review surface resolves ids to current names and
folders so the person approves something readable.

Declarations are closed, typed data under the same discipline as Check
declarations: no prompts beyond the literal Chat-step message, no
instructions, no source code, no shell commands, no model names, no
credentials, no connection data, no expressions. The Chat-step `message` is
bounded (16 KiB) and is data addressed to one Space's Assistant, reviewed
verbatim at enablement.

### Steps

At most 8 steps, executed strictly in order. Three kinds:

- **`chat`** — start a **new** conversation in the named Space with the fixed
  message, through the same acceptance path as `work-fold chat send --new`:
  conflict checks, kernel `assistant_turn` task, pre/post-turn History
  checkpoints, portable transcript persistence. Always a new conversation:
  sending into an existing Chat can collide with a person's live turn (the
  409 conflict path), and standing behavior must not entangle itself with an
  interactive thread. The hop waits for exactly its own turn's task-scoped
  terminal outcome; `failed` or `aborted` fails the hop. The new conversation
  then lives in that Space's ordinary Chats list like any CLI-started
  conversation does today.
- **`files`** — copy from one Space's folder into another's through the same
  additive internals as `files add`: collision-rename on existing names, and
  a targeted restore point that succeeds or fails together with the placement
  (`checkpointAdditiveWritesOrUndo` in `src/local/server.ts`). Copy only —
  a routing never moves, renames, or deletes anything in the source Space.
  The source is one of:
  - an explicit list of exact Space-relative file paths (at most 25, the
    act lane's existing `files add` bound);
  - one bounded tree selector reusing the Check target contract and resolver
    discipline (`kind: "tree"`, bounded recursion, extension filters,
    resolved under the hard entry/depth/file/byte limits of
    `src/local/checks/target-resolver.ts`, which callers may tighten but
    never widen; symbolic links, `.work-fold/`, `.pi/`, preserved
    `.workspace/`, and nested registered Spaces are rejected);
  - the declared created-files handoff described below.

  Exact paths alone were rejected as the only form because recurring flows
  produce new filenames — a weekly export with a dated name would make every
  schedule useless. Free glob or regex patterns were rejected because the
  bounded tree selector is the already-hardened enumeration primitive this
  codebase trusts, with review semantics a person can actually read
  ("`reports/`, not recursive, `.md` only"). Reusing it adds no new
  filesystem authority model.
- **`check`** — run one named Check (or all enabled Checks) in the named
  Space through the same path as `work-fold checks run`: global run budget,
  reservations, evidence admission, run receipt. The hop succeeds when the
  run settles `succeeded` — **including when it admits findings**. Findings
  are content state for the person; glue is not a gate, and
  [Checks](checks.md) deliberately defers gates that block other work.
  `failed`, `aborted`, or `interrupted` fails the hop.

### Static parameters, and the one handoff

Every step parameter is a literal reviewed at enablement. There is no
step-output-to-step-input templating: model text never becomes glue input,
and a person can know at the consecration click exactly what the routing will
do on every future run.

The single exception is the **declared created-files handoff**: a `files`
step may name an earlier `chat` step in the same routing as its source
(`{"kind": "step-created-files", "step": "<id>"}` plus mandatory bounds —
extension filters optional, `maxFiles` and `maxTotalBytes` required). It
resolves host-side, deterministically: the Chat step's turn already produces
pre- and post-turn History checkpoints (`src/local/server.ts`), and each
checkpoint carries a full manifest of paths, content hashes, and sizes
(`SpaceCheckpoint.files` in `src/local/history.ts`). The handoff is the
manifest diff — paths added or content-changed between that turn's own pair —
filtered by the declared bounds. No model output is parsed; the file set
comes from host-recorded content-addressed identity.

Fail-closed edges: if either checkpoint of the pair is missing, or a file
matching the handoff's filters was skipped at capture (oversized or
unreadable, recorded in the checkpoint's skip lists), the hop fails with a
typed error naming the gap. A partial handoff is never silently delivered.

This handoff exists because the alternative — teaching the fixed message to
pin output paths and hoping the model obeyed — makes the glue quietly wrong
when the model writes elsewhere: an exact-path copy would ship a stale file
with no error. Host-computed created-files keeps determinism without
templating.

Determinism here covers **selection, not content**. The copied bytes are
whatever the chat step's turn wrote: model output, steered by the fixed
message and by whatever the source Space's folder contains at run time —
which, in a synced or shared Space, can include other people's content. An
enabled routing with this handoff is therefore a standing,
content-dependent channel from the source Space into the destination Space:
the file set is host-computed and bounded, but the payload cannot be
reviewed in advance. The enablement card states this in plain words. The
delivery constraints hold regardless — additive copy into the declared
destination folder, collision-renamed, restore-pointed, never executed and
never firing a trigger — and every delivery is inspectable after the fact:
the hop receipt lists the exact copied paths, and the glance's
routing-run-settled item names the destination Space and the delivered file
count, so what arrived is one look away.

### Storage split

| Record | Location | Reason |
|---|---|---|
| Inert routing proposal | Ordinary file in the fold's management working folder | Reviewable and revisable without authority; never placed in a Space folder it names |
| Enabled declaration, exact-digest grant, cadence anchor, health state | work-fold application state (new `routings/` state under `src/local/state-paths.ts` helpers) | References multiple Spaces; must never travel with any folder |
| Routing-run and hop receipts | work-fold application state, append-only journal with rotation | Contains Space names, paths, and ids across Spaces |
| Effects inside Spaces | Ordinary Space records: a new Chat transcript, copied files, a History restore point | The only portable traces are single-Space, ordinary, and restorable |

## The executor

A new routing service owns execution as app code. It creates its **own**
instance of the existing `WorkFoldAutomationService`
(`src/local/agent/work-fold-automation-service.ts`) — the same class, the
same discipline, a separate two-slot budget with `ownerId:
"work-fold.routing"` and the routing id as `jobId`. Sharing the restricted-app
service's instance was considered and rejected: it would let one Space app's
jobs starve cross-Space glue (and vice versa) and couple two different
authority domains to one suspend/resume/close lifecycle. The discipline is
shared; the budget is deliberately its own.

That buys, verbatim from the proven scheduler: FIFO admission, per-routing
non-overlap (an admission while the same routing is pending or active settles
`skipped` and is receipted as such), durable cadence from the persisted
anchor, bounded `latest` catch-up with deterministic stagger, suspension and
resumption across sleep and quit, and abort signals through every run.

### Runs, hops, receipts

Every run is journal-first, on the same discipline as the act lane's receipts
(`src/local/cli/act-receipts.ts`): an `accepted` record is appended to the
routing receipts journal **before** hop 1 executes — an unwritable journal
refuses the run — and a terminal record after. Each hop writes its own
`accepted` record before its mutation and a terminal record after, carrying
the underlying domain evidence:

- chat hop: Space id, conversation id, turn task id, terminal outcome,
  pre/post-turn checkpoint ids;
- files hop: source and destination Space ids, resolved source paths, copied
  destination paths (including collision renames), file and byte counts, the
  restore-point id;
- check hop: Space id, Check ids, run id, task id, terminal state, finding
  and admission counts.

The run's terminal record names the trigger cause exactly — the scheduled
slot time, the run-now request id, or the settled source (kind, Space, ids,
outcome) — plus the declaration digest that was in force. Run history is
bounded like automation results (500 records in memory; the journal rotates
on the act-receipts pattern).

**Failure semantics.** A failed hop fails the run. Later hops do not execute
and are recorded `skipped` with the failing hop named. There are no retries;
the next trigger occurrence is the retry, and the receipt trail makes the
failure inspectable rather than smoothed over. Infrastructure refusals inside
a hop — a capability mutation fence rejecting a turn start, a Check
reservation conflict — fail the hop with the typed reason; they are glue
health, never silently skipped work.

**Stop.** Stopping a running routing run is a direct verb and a desktop
control. It aborts the current hop through that domain's own abort path (the
Chat turn abort; the Check run abort; a files hop is not interruptible
mid-copy — the signal is honored at hop boundaries and the copy either
completes with its restore point or fails as one unit). Later hops are
recorded `skipped`; the run settles `stopped`; the receipt names every hop
task it aborted, exactly as `manage stop` names child turns.

**Disable.** Disabling a routing is revocation of standing behavior, and the
layered-authority rail requires revocation to stop stale work before the
authority change reads as complete. Disable therefore: journals the disable,
persists the disabled state, cancels pending admissions, and stops the active
run (if any) through the stop path above — then reports what it stopped. This
matches the restricted-app scheduler's disable semantics rather than letting
an already-launched run outlive its authority. Disable never destroys the
declaration, grants history, or receipts.

**Referenced Space removed.** The routing's referenced set is every Space any
step or trigger source names. Removing any of them revokes the enablement
grant — the same rule as Checks, where Space removal revokes all machine-local
Check authority — and the routing enters a durable `suspended` health state
with the missing Space id recorded. The active run, if any, is stopped. A
suspended routing never runs, never retargets to another Space, and never
resumes automatically — not even when a folder carrying the same portable
Space identity is re-registered, because registration must never silently
re-arm standing behavior. The health detail distinguishes "Space removed"
from "re-registered with preserved identity" in copy, so the person knows
which they are looking at; the semantics are deliberately identical.
Leaving suspension is a fresh enablement consecration over the unchanged
declaration.

**Crash mid-run.** Startup scans the journal for runs with an `accepted`
record and no terminal record and appends a terminal `interrupted` record —
the same honesty rule as the Check runner: record, never replay. The
interrupted run's completed hops keep their receipts; its in-flight hop
resolves through its own domain's crash semantics (an interrupted turn
appends its typed marker to the transcript; a files hop's placement and
restore point already succeed or fail together; a Check run records
`interrupted`). The schedule then resumes from the durable anchor; a `latest`
catch-up may run one fresh make-up run with a new run id and fresh hop
journal. Additive copy with collision-rename keeps that re-run
non-destructive by construction.

**Replay prevention.** Run ids are host-minted per admission. Trigger
evaluation is serialized in-process at the settlement funnels, and settles are
in-process facts, so no external channel can inject or repeat one. Scheduled
slots are computed from the durable anchor with missed slots collapsed to at
most one catch-up. Run-now arrives through the act lane, which already
provides request-id at-most-once handling backed by the accepted-record ledger
(`hasAccepted` in `src/local/cli/act-receipts.ts`). The journal-first
`accepted` gate plus startup `interrupted` recovery means a crash can
interrupt a run but can never cause it to execute twice under one run id.

### Trigger delivery

The two admitted settle families gain one narrow in-process seam: the Check
service's terminal-persistence funnel (`src/local/checks/check-service.ts`)
and the restricted-app service's `onResult` funnel
(`src/local/agent/restricted-app-service.ts`) publish typed settle records to
a small settle-signal module consumed only by the routing service. Publication
is after durable persistence, fire-and-forget, and failure-isolated — a
routing bug must never fail a Check run or an automation receipt. Settle
records carry lineage, so routing-caused runs are dropped at evaluation.
Settles that occur while the routing service is suspended are not queued; the
admission would settle `skipped` and is receipted as such.

Routing runs also register as an experimental kernel task kind
(`routing_run`), following the `check_run` precedent in
`src/local/work-fold-kernel.ts`: visible to internal surfaces and
[the glance](fold-glance.md), deliberately excluded from stable
`work-fold tasks` protocol v1 until its compatibility contract earns a
version decision.

## Lifecycle and authority

1. **Propose.** The fold (or a person, by hand) writes the inert typed
   proposal. Nothing is registered, armed, or scheduled. Proposals expire from
   nothing — they are ordinary files with no authority.
2. **Stage enablement.** A receipted act-lane command submits the proposal
   for enablement, producing a pending decision: fully prepared, inspectable,
   inert. Staged decisions expire; expiry is not approval; denial is recorded,
   not retried.
3. **Consecrate.** Enabling a routing is the second consecration — widening a
   power into standing behavior — and requires the unforgeable human click on
   a needs-you card, per [fold-consecrations.md](fold-consecrations.md); no
   standing policy can pre-approve it (`routing.enable` is not a
   policy-eligible kind there). The
   decision may be approved from the desktop or from an approved full-trust
   remote browser; the enablement receipt records the approving surface and
   browser identity, and revoking a browser cancels its pending decisions.
   The card shows the whole declaration in review form: every Space by
   current name and folder, the Chat step's message verbatim — labeled as
   text that will enter that Space's portable transcript — exact paths,
   selectors, filters and bounds, the Check by title, and the trigger. When
   a files step consumes a chat step's created files, the card states
   plainly that those files will be model output shaped by the source
   Space's content at each future run. Enablement records an
   exact-authority grant over the declaration digest. The digest pins the
   declaration, not the referenced Spaces' capabilities: a chat step runs
   with whatever Assistant authority its Space holds at run time, so a
   capability installed into that Space later (through its own
   consecration) widens what future runs can do without re-consecrating the
   routing — the card states this too, and the deliberate absence of
   re-review machinery is recorded below.
   The declaration write and the grant commit are one logical operation on
   the Checks atomicity rule: a failure may leave an inert declaration,
   never undeclared or digest-mismatched authority.
4. **Run.** Scheduled, on-settled, or run-now, as designed above. Any edit to
   the declaration changes its digest and returns the routing to
   proposed/blocked until a fresh consecration — an edited routing never
   coasts on a stale approval.
5. **Disable.** A direct verb (and a desktop control): narrowing authority
   never needs a click. Re-enable is a fresh consecration.
6. **Delete.** A direct verb on a disabled or suspended routing: removes the
   declaration, grant history pointer, and cadence anchor. The receipts
   journal is retained — audit records survive the object, as with Checks.

The five questions, per mutation:

| Mutation | Journaled by | Receipt contains | Revoked / undone by | Mid-act failure | Replay prevented by |
|---|---|---|---|---|---|
| Stage enablement | Act-lane journal (`accepted` before, terminal after) plus the pending-decision record | Proposal digest, routing summary, staging actor, parent-task lineage | Expiry, explicit denial, browser revocation cancelling its pending decisions | Staging is inert; a torn stage is an absent decision, refused at decision time | Act request-id at-most-once; single-use decision ids |
| Enable (the click) | Consecration decision record plus routing store commit | Routing id, declaration digest, approving surface/browser identity, timestamp | Disable; Space removal (automatic revocation to `suspended`) | Declaration-then-grant as one logical operation; failure leaves inert declaration, never digest-mismatched authority | Single-use decision id; expired stages cannot be approved |
| Run (scheduled / on-settled) | Routing receipts journal, run `accepted` before hop 1, per-hop accepted/terminal pairs | Trigger cause, digest, per-hop domain evidence (task ids, run ids, conversation id, restore-point id, copied paths) | Stop (active); files effects restorable via the hop's restore point; chat effects are an ordinary archivable Chat | Startup records `interrupted`; completed hops keep receipts; in-flight hop resolves by its domain's crash rule; never replayed | Host-minted run ids; journal-first accepted gate; serialized in-process trigger funnel; anchor-collapsed catch-up |
| Run-now | Act-lane journal plus the same run journal | As above, plus the act request id | Same as a run | Same as a run | Act request-id at-most-once plus run-id gate |
| Stop | Act-lane journal (or desktop action record) plus run terminal record | Run id, aborted hop task ids, skipped hops | Not applicable — stop is itself the revocation act | Abort signals are idempotent; a second stop finds a settled run | Act request-id at-most-once; a settled run refuses stop with its terminal state |
| Disable | Act-lane journal plus routing store | Prior state, stopped run id if one was aborted | Re-enable (fresh consecration) | Disabled intent persists first; startup refuses to arm a disabled routing; the active run at a crash is `interrupted` anyway | Act request-id at-most-once |
| Delete | Act-lane journal plus routing store | Routing id, digest, final health state | Not undoable; the declaration was inert data and receipts are retained | Grant removed before declaration so no window holds authority without a declaration | Act request-id at-most-once |

## Where routings live in the product

No new rail destination — the information architecture is fixed: Files,
Chats, History, with Add, Shortcuts, and Settings at the bottom. Placement
options, argued:

- **Assistant tools** is Space-owned. A routing is not one Space's object; a
  tab owned by Space A that manages standing writes into Space B misstates
  the authority relationship. Rejected.
- **A management work tab** would require explicitly amending the Space-bound
  tab contract, which [the product model](product-model.md) reserves as its
  own deliberate design. This proposal does not spend that decision. Rejected
  here.
- **Settings** already hosts exactly this shape of thing: standing,
  machine-local, above-Spaces authority with per-item records — Remote access
  with its per-browser approval and revocation is the precedent. Chosen.

Routings are therefore managed in **Settings → The fold** (decision F15 in
[the naming design](fold.md)): list with health states, full declaration
review, run history and receipts, run-now, stop, disable, delete. Pending
enablement decisions surface as needs-you cards through
[the glance](fold-glance.md) on the popover, the remote client's home, and
the main window; the fold narrates run history on demand, never on a
schedule. A routing's effects remain visible where they land: the copied
files and restore point in the destination Space's Files and History, the new
conversation in the source Space's Chats.

The CLI carries the act-lane group — `work-fold routings list`, `show`,
`stage`, `run`, `stop`, `disable`, `delete`, `receipts` — all requiring the
per-launch act token, all journal-first, none resolving anything from the
working directory (like the `manage` group, routings are above Spaces and
take no `--space`). The fold is taught to prefer these verbs. `routings
list`/`show`/`receipts` are content-bearing (Space names, paths, messages)
and therefore act-lane, matching the Checks rule that only aggregate
`checks status` lives in the content-free read lane; a content-free routing
status projection for read-lane protocol v1 is a separate deliberate
decision, not assumed here.

## Bounds

Everything is bounded, and every bound is enforced at declaration parse and
again at execution:

| Bound | Value | Source of the value |
|---|---|---|
| Routings per machine | 32 | New; small on purpose — this is glue, not a job system |
| Steps per routing | 8 | New; composition beyond this suggests a Space app or a human process |
| Triggers per routing | 1 (plus always-available run-now) | This design |
| Interval | 15–1440 minutes | `restrictedAppAutomationIntervalMinutes` |
| Catch-up | `latest` only (one make-up run) | `WorkFoldAutomationService` |
| Concurrent routing runs | 2, FIFO, machine-wide | Scheduler default (`defaultMaxConcurrency`) |
| Exact source paths per files step | 25 | `maxActFromPaths` in `src/local/cli/act-commands.ts` |
| Tree selector resolution | The Check target resolver's hard limits; tighten-only | `src/local/checks/target-resolver.ts` |
| Created-files handoff | `maxFiles` and `maxTotalBytes` mandatory in the declaration | This design |
| Chat step message | 16 KiB | New; a fixed dispatch message, not a document |
| Run history / journal | 500 recent results; journal rotation on the act-receipts pattern | `WorkFoldAutomationService` default; `src/local/cli/act-receipts.ts` |

## Decisions recorded at review

**Chat-step provenance (owner decision, 2026-08-10, F14 in
[the fold register](fold.md)).** The message a routing's chat step sends is
an **ordinary user-role message**, exactly as if the person had typed it into
that Space's composer. The portable transcript carries no automation marker,
and this document's earlier marker recommendation is superseded. The honest
consequence is accepted and stated plainly: someone reading the portable
`.work-fold/conversations/` log cannot distinguish a routing-sent message
from a person-sent one. Attribution lives entirely in machine-local records —
the routing run receipt and hop journal name the exact conversation and
message, run history shows every dispatch, and the glance lists routing runs
— and the fixed message text remains reviewed at enablement, so nothing
cross-Space can leak through it either way.

Two earlier open items are settled in this document rather than deferred: a
newer-than-last-successful-run filter for `files` steps is recorded under
"Deliberately not in this design" (recopying is safe by construction, and
dogfooding should prove the noise matters before machinery is added), and
suspension health detail distinguishes "Space removed" from "re-registered
with preserved identity" in copy only — the semantics are identical, and
resumption is a fresh consecration either way (recorded with the suspension
rules above).

## Implementation plan

Dependency-ordered work items; each lands with `npm run check` and
`npm test`, growing the named suites.

1. **Settle-signal seam.** New `src/local/routings/settle-signal.ts` (typed
   settle records with lineage). Publish from the Check service's terminal
   persistence funnel (`src/local/checks/check-service.ts`) and the
   restricted-app automation result funnel
   (`src/local/agent/restricted-app-service.ts`, `onResult` path), after
   durable persistence, failure-isolated. Tests: new
   `tests/work-fold-routing-settle-signal.test.ts`; extend
   `tests/work-fold-checks-service.test.ts` and
   `tests/restricted-app-service.test.ts` to prove publication ordering and
   isolation.
2. **Declaration and proposal schema.** New
   `src/local/routings/routing-declarations.ts` modeled on
   `src/local/checks/check-declarations.ts`: closed typed parse, digest,
   bounds, forbidden content, tree-selector reuse of the Check target types.
   Tests: new `tests/work-fold-routing-declarations.test.ts`.
3. **Routing store and receipts journal.** New
   `src/local/routings/routing-store.ts` plus state-path helpers in
   `src/local/state-paths.ts` (`routings/` under the app state root):
   declarations, exact-digest grants, cadence anchors, health states, and the
   journal-first receipts file on the `src/local/cli/act-receipts.ts`
   discipline (accepted-before-mutation, rotation, damaged-ledger
   fail-closed). Tests: new `tests/work-fold-routing-store.test.ts`.
4. **Executor service.** New `src/local/routings/routing-service.ts`: its own
   `WorkFoldAutomationService` instance; trigger evaluation; hop execution
   through the same in-process route internals the act facade uses in
   `src/local/server.ts` (turn acceptance, `addFiles`, Check runs);
   created-files handoff via checkpoint-manifest diff
   (`src/local/history.ts`); stop/disable/suspension; startup `interrupted`
   recovery; suspend/resume wiring beside the restricted-app service's
   lifecycle hooks in `startLocalApi`. Kernel gains the experimental
   `routing_run` task kind beside `check_run`
   (`src/local/work-fold-kernel.ts`), excluded from stable v1 task
   projections. Tests: new `tests/work-fold-routing-service.test.ts`; extend
   `tests/work-fold-kernel.test.ts` and `tests/work-fold-automation-service.test.ts`
   only if the shared class needs a new seam (none is currently expected).
5. **Space-removal revocation.** Hook the registry-removal path that already
   revokes Check authority so it also revokes routing enablements and stops
   active runs before removal completes. Tests: extend
   `tests/local-space.test.ts` and `tests/work-fold-routing-service.test.ts`.
6. **Act-lane verbs.** Extend `WorkFoldCliActCommandName` parsing in
   `src/local/cli/act-commands.ts`, the facade contract in
   `src/local/cli/act-facade.ts`, and the server's facade implementation;
   receipts and the broker need no protocol change (`src/local/cli/act-protocol.ts`
   stays at version 2). Tests: `tests/work-fold-cli-act-protocol.test.ts`,
   `tests/work-fold-act-facade.test.ts`,
   `tests/desktop-work-fold-cli-host.test.ts`.
7. **Consecration wiring.** Staged enablement enters the pending-decision and
   needs-you machinery defined in [fold-consecrations.md](fold-consecrations.md)
   (cross-thread dependency: that design's decision store, expiry, surface
   identity on receipts, and browser-revocation cancellation are consumed
   here, not redefined). Tests grow wherever that machinery lands, plus
   routing-specific approval/denial/expiry cases in
   `tests/work-fold-routing-service.test.ts`.
8. **Fold instruction teaching.** Extend the materialized management
   instructions and `manage-spaces` Skill in
   `src/local/management-instructions.ts`: author proposals in the management
   working folder, never enable, prefer the receipted `routings` verbs,
   durable-intent language mirroring the Checks guidance. Tests:
   `tests/work-fold-management-conversation.test.ts`.
9. **Settings surface, needs-you cards, glance projection.** Renderer work
   for the Settings section, run/receipt views, stop/disable controls, and
   the glance's routing rows. Tests: `tests/web-ui-contract.test.ts`,
   `tests/frontend-interaction-contract.test.ts`, and the popover/remote
   surfaces' suites (`tests/management-popover-refresh.test.ts`,
   `tests/desktop-remote-access.test.ts`) where cards appear.
10. **Docs promotion.** Register updates land through the amendment blocks in
    [fold-integration.md](fold-integration.md) after owner review;
    `tests/documentation-contract.test.ts` grows if routing claims join the
    cross-document contract set.

## Deliberately not in this design

- **Routing chains.** Routing-caused settles never fire triggers; multi-hop
  behavior across routings is excluded structurally, not merely bounded.
- **Assistant-turn, compaction, and management-request triggers**, for the
  reasons argued above.
- **File-change triggers.** That is a watcher; [Checks](checks.md) already
  rejects background watchers, and routings do not reintroduce one.
- **Templating, expressions, conditions, branching, retries, or any
  step-output piping** beyond the declared created-files handoff.
- **Cross-Space moves or deletions.** The files step only copies additively
  with restore points; destructive operations stay human, and irreversible
  destruction anywhere remains the third consecration.
- **Time-of-day and calendar schedules.** Interval-only in version 1;
  extending the trigger vocabulary is a later register decision.
- **A newer-than-last-successful-run filter on `files` steps.** Recopying
  unchanged selector matches is safe by construction (additive,
  collision-renamed, restore-pointed), just noisy; the filter is deferred
  until dogfooding shows the noise matters.
- **Re-consecration when a referenced Space's capabilities change.** The
  enablement digest pins the declaration; the Spaces it names govern their
  own capabilities through their own consecrations, and a routing's
  effective blast radius at run time follows them. This is disclosed on the
  enablement card as a residual rather than policed with re-review
  machinery; if dogfooding shows it bites, that machinery is a register
  decision of its own.
- **Portable or shared routings.** Declarations never enter `.work-fold/`,
  sync, export, or any distribution lane.
- **A routings rail destination, badge, or notification stream.** Settings
  owns management; the glance and receipts own visibility.
- **Read-lane routing status.** All routing commands are act-lane in
  version 1.
- **Hosted or remote execution.** Routings run only on this desktop while the
  app runs; an approved remote browser can approve an enablement and ask the
  fold to act, but the executor is local. Outward exposure of anything a
  routing produces stays in [the publishing ladder](fold-publishing.md) with
  its own grants.
- **A general job system.** Two slots, small bounds, three step kinds. If a
  flow does not fit, it belongs to a Space app's named automations, a Check,
  or a person.
