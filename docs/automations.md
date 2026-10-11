# Automations: declared cross-work-folder glue

**Status: shipped contract reference.** An **Automation** is fixed,
deterministic app work on a reviewed trigger; it is not an agent scheduler
and does not create a second kind of Worker. Code, CLI verbs, routes, and
storage say `automation`/`automations` too. Before the 2026-10-10 vocabulary
migration they said `routing`/`routings`; that one-time migration moved the
stored records to the new names.

The automation feature shipped with the work-fold agent build
— `src/local/automations/` (declarations, store, settle signal, executor) and
its suites are the implementation authority — and its decisions were
promoted on 2026-08-11 into [the work-fold agent decision register](work-fold-agent-decisions.md) (F8, F9,
F14), [Product model](product-model.md) (the Automation noun, the
enable/run context rows, rail 11), `AGENTS.md` (the above-work-folder cadence
rail), [the work-fold agent and CLI](work-fold-agent-and-cli.md) (the verification map),
`README.md`, `SECURITY.md`, and `PRIVACY.md`. This document retains what
canon does not carry: the trigger vocabulary and its exclusions, the
declaration and step contracts, the executor's failure semantics, the
lifecycle and five-questions record, and the bounds. The promotion record is
[Fold integration](archive/fold-integration.md).

**Amended 2026-09-10** by [Receipts, not gates](receipts-not-gates.md) (F23):
enablement is one receipted call, `chat` and `fold` messages accept a closed
set of host-resolved placeholders, a `fold` step kind exists, and the bounds
kept eight concurrent runs. Current behavior removes the former declaration,
step, and exact-path count quotas.

**Amended 2026-10-10:** the vocabulary migration renamed the `fold` step to
the `agent` step (`"kind": "agent"`), and the limits lift widened the
interval, one-time, folder-change, observer, and concurrency bounds to the
values under [Bounds](#bounds).

The declaration contract accepts versions 1, 2, 3, and 4. Version 2 added a
bounded one-time `at` trigger on 2026-09-01; version 3 adds explicit folder
observation, shipped in September 2026; version 4 adds the closed placeholder
set and the `agent` step (then named `fold`), shipped with the
receipts-not-gates build.
**Settings → Automations** is the desktop management surface. The
store schema is version 3; version-1 and version-2 records load and are
rewritten as version 3 on the next mutation, converting the grants an older
build wrote, while newer schemas still fail closed.

An **Automation** is a machine-local, inert-until-enabled declaration of
deterministic steps that move work between work-folders: start a Worker Chat
with a fixed message, copy files from one work-folder into another with a
History restore point, run a Check, or message the work-fold agent. It is
executed by app code on the shared scheduler discipline, never by an
open-ended Worker conversation, and it is the only thing above work-folders
that runs unattended. An
Automation is not a workflow
language: no conditions, no branching, no retries, no loops, no expression
templating, and no model deciding which step runs next. Agentic work happens
inside a Chat step, run by that work-folder's own Worker with that
work-folder's own authority. A Check step may separately use the bounded text reviewer
through the Check service; the executor itself remains deterministic.

## The rule this design enforces

work-folder Chat transcripts are portable: `.work-fold/conversations/` travels
with the folder. Cross-work-folder work run inside a work-folder Chat would write
cross-work-folder context into a folder that travels — a leak no convenience
justifies (decision F9). Automations enforce the boundary structurally:

- The declaration, enablement grant, cadence anchor, health state, and every
  run receipt are machine-local application state. Nothing automation-shaped is
  ever written under any work-folder's `.work-fold/`.
- A Chat step sends only the declared message text, with the closed
  placeholder set filled in host-side, into a new conversation in that one
  work-folder. The executor appends no ambient context and no other work-folder's name.
  The declaration says exactly what becomes portable transcript content in
  that work-folder, and the hop receipt records the text work-fold filled in.
- The only cross-work-folder transfer is the files step: bytes copied through the
  same additive, restore-pointed path as `files add`. Transcript text is
  never relayed between work-folders by the executor.
- The portable traces an automation leaves are all single-work-folder ordinary
  records: a new Chat in work-folder A, copied files and a History restore point
  in work-folder B. Neither folder learns the other exists.

Per decision F14, the message an automation's chat step sends is an **ordinary
user-role message** — the portable transcript carries no automation marker,
and someone reading it cannot distinguish an automation-sent message from a
person-sent one. Attribution lives entirely in machine-local records: the
automation run receipt and hop journal name the exact conversation and message,
run history shows every dispatch, and the overview lists automation runs.

## Triggers

An automation has exactly one declared trigger; manual run-now is additionally
available for every enabled automation. Triggers are evaluated by app code from
recorded settle/schedule state, or explicitly granted bounded folder metadata observation. Trigger evaluation never calls a model or reads file contents.

**Manual only** is `{"kind":"manual"}` (any version): the automation never fires
on its own and runs only through run-now below.

**work-folder changes (version 3)** use `{"kind":"files-changed","workFolder":"<work-folder id>","watch":{"kind":"tree","path":"Incoming","recursive":true,"extensions":[".md",".txt"]},"debounceSeconds":5,"cooldownMinutes":1}`. The exact named folder must exist at enablement. The host observes matching ordinary files every two seconds, within 50,000 files, 200,000 visited entries, and depth 256; it reads metadata only, so no byte bound applies. Metadata identities include size, nanosecond modification/change times, and inode; file contents are not read or sent anywhere by the observer. Symlinks and overlap with separately registered work-folders fail closed. The extension list and recursion are explicit; reserved metadata stays excluded.

A fresh enable, restart, wake, or recovered observer error first establishes a baseline without firing. Changes must settle for the declared 1–3600 seconds, with 0–10080 minutes between firings. Bursts coalesce into the latest snapshot, not a queue of events. An accepted run records its source work-folder, snapshot digest, and change count before any hop. Every launch rechecks the exact declaration grant; revocation invalidates in-flight scans. The observer reports starting/watching/paused/error state and errors in Settings → Automations.

All folder observers pause while any automation executes and establish fresh baselines afterward. This deliberately absorbs automation-generated edits and prevents cross-automation file loops. Changes made during that pause, while asleep, or while quit are **not replayed**. This is an awake-app convenience trigger, not a durable filesystem event bus. Keep a complete cross-work-folder sequence in one automation: wait for A's Chat, copy its created files, then run B's Chat or Check. There is no transcript relay or ambient context injection. Stop, disable, removal, shutdown, journaling, non-overlap, and FIFO limits use the existing executor paths.

**Admitted on-settled sources** (both durable and already receipted):

- **`check-run`**: a named work-folder's Check run reached a terminal state —
  optionally scoped to one Check id, filtered by outcome (default
  `succeeded`; `failed` and `aborted` may be named explicitly;
  `interrupted` is never admissible — it marks a crash, not a result).
- **`app-automation-run`**: a named work-folder's restricted-app named automation
  run settled — scoped to app id and automation id, filtered by outcome
  (default `success`; `failure` may be named explicitly; `skipped` and
  `cancelled` are never admissible — they are lifecycle artifacts, and
  chaining on them oscillates).

**Deliberately excluded as trigger sources:** Worker-turn settles
(standing behavior keyed to a person finishing a chat is ambient watching of
their conversation activity, and the records are in-memory only — the real
need, "after the Worker finishes, move its output," is served
inside a run, where the Chat step waits for its own turn), compaction
settles (no recorded outcome), and work-fold agent request settles (on the
work-fold agent's side, in-memory, and glue firing from work-fold agent chat
activity would blur interactive work with the agent into unattended behavior).

**Automation-caused settles never fire triggers.** A Check run or automation
run whose lineage records an automation hop is dropped at trigger evaluation,
making automation chains structurally impossible — no cycles, no fan-out.
Composition happens inside one automation's ordered steps; chains would
be a separate register decision with its own depth budget.

**The recurring schedule trigger** is `{"kind": "interval", "intervalMinutes": N}`
with the restricted-app automation bounds reused as-is (1 minute to 366 days,
that is 1–527,040 minutes).
Cadence is durable — a persisted `lastScheduledAt` anchor resumes across
restarts — and catch-up is bounded to the existing `latest` policy: at most
one make-up run for the most recent missed slot, staggered by the shared
deterministic jitter. Missed slots never queue.

**The one-time schedule trigger** is
`{"kind":"at","at":"2026-09-01T21:00:00-04:00","ifMissed":"run"}`
and requires declaration version 2. `at` must carry an explicit UTC offset;
normalization stores one UTC instant. Enablement rechecks that the instant is
in the future and no more than ten years ahead. `ifMissed` is `run` or
`skip`: after launch or wake,
`run` admits one bounded catch-up for the exact slot while `skip` records that
the occurrence did not run. Nothing runs while work-fold is quit.

Sleep does not spend work that never launched. If a due `run` occurrence is
waiting for a scheduler slot when suspension cancels the admission, its
durable record remains enabled and the exact slot is admitted once on resume.
An `ifMissed: "skip"` occurrence instead records `run: skipped` followed by
the automation lifecycle `completed`, with no hop execution.

A scheduled one-time occurrence is consumed at most once. The executor
writes the strict run `accepted` receipt, then commits a deterministic
occurrence claim `{occurrenceId, slotAt, consumedAt, runId}`, then begins hop
1. That claim moves the automation to `completed`; success, failure, Stop, or
interruption do not re-arm it. Startup reconciles a crash between acceptance
and claim by consuming the same deterministic occurrence and recording the
run interrupted. Completed records remain visible until a person deletes them.

**Manual run-now** (`work-fold automations run`) is a direct verb: available
for every *enabled* automation, receipted, never a schedule mutation. Run-now
on a merely proposed automation is refused: enablement is what binds the
person's review to the exact declaration digest, and the executor must never
run an unreviewed standing declaration, even once.
For a one-time automation, Run now executes an independent copy and leaves its
declared slot untouched. If that copy is still running when the slot becomes
due, the exact slot waits behind the copy and launches once it settles; the
overlap receipt does not claim or complete the occurrence. After the slot is
consumed, completed health refuses Run now; another occurrence is a new
proposal and enablement.

## The declaration

Authoring follows the Check-proposal pattern: the work-fold agent writes an inert,
typed, kind/version JSON file (`work-fold.automation-proposal`, version 1, 2, 3,
or 4, `.work-fold-automation.json` suffix) at the top level of its own
working folder —
never inside a work-folder, because the proposal names multiple work-folders and
their folders travel. `src/local/automations/automation-declarations.ts` is the
schema authority. work-folders are pinned by stable work-folder id; duplicate names are
rejected as ambiguous, and `automations show` resolves ids to current names and
folders so the declaration reads as something a person can check.

Declarations are closed, typed data under the same discipline as Check
declarations: no prompts beyond the literal Chat- and agent-step message plus
the closed placeholder set below, no instructions, no source code, no shell
commands, no model names, no credentials, no connection data, no expressions.
The Chat- and agent-step `message` is bounded (4 MiB) and is data addressed to
one work-folder's Worker or to the work-fold agent; in version 4 it may carry the closed
placeholder set.

### Steps

Steps execute strictly in declaration order. Four kinds:

- **`chat`** — start a **new** conversation in the named work-folder with the
  fixed message, through the same acceptance path as
  `work-fold chat send --new`: conflict checks, kernel `assistant_turn`
  task, pre/post-turn History checkpoints, portable transcript persistence.
  Always a new conversation — sending into an existing Chat can collide
  with a person's live turn, and standing behavior must not entangle itself
  with an interactive thread. The hop waits for exactly its own turn's
  task-scoped terminal outcome; `failed` or `aborted` fails the hop.
- **`files`** — copy from one work-folder's folder into another's through the
  same additive internals as `files add`: collision-rename on existing
  names, and a targeted restore point that succeeds or fails together with
  the placement. Copy only — an automation never moves, renames, or deletes
  anything in the source work-folder. The source is an explicit list of exact
  work-folder-relative paths, one bounded tree selector reusing the
  Check target contract and resolver discipline (tighten-only hard limits;
  symbolic links, `.work-fold/`, `.pi/`, preserved `.workspace/`, and
  nested registered work-folders rejected), or the declared created-files handoff
  below. Free glob or regex patterns were rejected: the bounded tree
  selector is the already-hardened enumeration primitive with review
  semantics a person can actually read.
- **`check`** — run one named Check (or all enabled Checks) in the named
  work-folder through the same path as `work-fold checks run`. The hop succeeds
  when the run settles `succeeded` — **including when it admits findings**:
  findings are content state for the person; glue is not a gate. `failed`,
  `aborted`, or `interrupted` fails the hop.
- **`agent`** (version 4; named `fold` before 2026-10-10) — start a **new**
  work-fold agent chat with the message, through the same acceptance path as
  `work-fold agent send --new`. It names no work-folder: the work-fold agent sits above
  them. Always a new chat, so standing behavior never entangles a live
  work-fold agent chat and turn-conflict rejection stays exact. The hop waits
  for its own turn's terminal outcome and `automations stop` aborts it like a
  Chat hop. This is the one admitted way the work-fold agent runs unattended (F8,
  narrowed by [Receipts, not gates](receipts-not-gates.md)), so a person
  can put the work-fold agent on a cadence deliberately. An agent hop records no History
  checkpoints and is never a created-files source.

### Placeholders and the created-files handoff

Every step parameter is a literal in the declaration; there is no
step-output-to-step-input templating and nothing evaluates model output.
Version 4 admits exactly one narrow addition: a **closed set of host-filled
placeholders** in a `chat` or `agent` message. Nothing else inside `{{ }}` is
accepted — an unknown placeholder is a declaration error refused when the
automation is enabled, so it can never appear as an empty sentence in a message
a Worker already received.

| Placeholder | Filled in from | Declaration rule |
|---|---|---|
| `{{trigger.summary}}` | The run's own cause, in one sentence | Valid with every trigger |
| `{{trigger.changedFiles}}` | The changed paths the folder observer recorded | Requires a folder-change trigger |
| `{{trigger.findings}}` | The settled Check run's active findings, read back from the host | Requires a Check-run `on-settled` trigger |
| `{{steps.<id>.createdFiles}}` | The manifest diff of that chat hop's own pre/post checkpoints | Must name an earlier `chat` step in the same automation |

Resolution happens in the executor, after the hop's `accepted` receipt and
before the port is called, and it reads the **run's cause**, never the
declared trigger. A run-now on a folder-change automation therefore says
`(no changed files: this run was started by hand)` instead of pretending
files changed. A resolution that cannot be proven — a Check run whose
findings cannot be read, a created-files gap — fails the hop closed with a
typed reason and skips the later hops; nothing is sent.

Bounds, each named in the text it produces: 1 MiB per filled-in placeholder,
10,000 items per filled-in list, and 8 MiB for the whole message after
substitution (exceeding it fails the hop). The hop's terminal receipt records
`placeholders[]` — each name, the bounded text, its byte length, and whether
it was cut — plus `messageBytes`. That is the one place the receipts journal
carries message text, and it carries only the part work-fold itself wrote.

The other declared exception is the **declared created-files handoff**: a
`files` step may name an earlier
`chat` step in the same automation as its source
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
by whatever the source work-folder's folder contains at run time. An enabled
automation with this handoff is a standing, content-dependent channel from the
source work-folder into the destination work-folder; `automations show` and the desktop
Automations pane both state this under "While this automation is on". Every delivery is inspectable after the fact: the hop receipt
lists the exact copied paths, and the overview's automation-run-settled item
names the destination work-folder and the delivered file count.

### Storage split

| Record | Location | Reason |
|---|---|---|
| Inert automation proposal | Ordinary file in the work-fold agent's working folder | Reviewable and revisable without authority; never placed in the folder of a work-folder it names |
| Enabled declaration, exact-digest grant, cadence/occurrence claim, health state | work-fold application state (`automations/` under the state root) | References multiple work-folders; must never travel with any folder |
| Automation-run and hop receipts | work-fold application state, append-only journal with rotation | Contains work-folder names, paths, and ids across work-folders |
| Effects inside work-folders | Ordinary work-folder records: a new Chat transcript, copied files, a History restore point | The only portable traces are single-work-folder, ordinary, and restorable |

## The executor

The automation service (`src/local/automations/automation-service.ts`) owns execution
as app code. It creates its **own** instance of the existing
`WorkFoldSchedulerService` — the same class, the same discipline, a
separate 64-slot default budget with `ownerId: "work-fold.automation"`. Sharing the
restricted-app service's instance was rejected: it would let one work-folder
app's jobs starve cross-work-folder glue and couple two authority domains to one
lifecycle. That buys, verbatim from the proven scheduler: FIFO admission,
per-automation non-overlap (an overlapping admission settles `skipped` and is
receipted as such; a one-time slot overlapping its own run-now copy remains
pending), interval and one-time schedules, durable cadence,
bounded catch-up with
deterministic stagger, suspension and resumption across sleep and quit, and
abort signals through every run.

Every run is journal-first on the act-receipts discipline: a run `accepted`
record before hop 1 — an unwritable journal refuses the run — and a
terminal record after; each hop writes its own accepted/terminal pair
carrying the underlying domain evidence (chat hop: conversation id, turn
task id, outcome, checkpoint ids; files hop: source and destination work-folder
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
names every hop task it aborted, exactly as `agent stop` names child turns.

**Disable.** Revocation of standing behavior: it journals the disable,
persists the disabled state, cancels pending admissions, and stops the
active run through the stop path — then reports what it stopped. Disable
never destroys the declaration, grant history, or receipts.

**Referenced work-folder removed.** Removing any work-folder a step or trigger names
revokes the enablement grant and puts the automation in a durable `suspended`
health state with the missing work-folder id recorded; the active run, if any, is
stopped. A suspended automation never runs, never retargets, and never resumes
automatically — not even when a folder carrying the same portable work-folder
identity is re-registered, because registration must never silently re-arm
standing behavior. Copy distinguishes "work-folder removed" from "re-registered
with preserved identity"; the semantics are deliberately identical, and
leaving suspension is a fresh enablement over the unchanged declaration.

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
through the settle-signal seam (`src/local/automations/settle-signal.ts`)
attached at the Check service's terminal-persistence funnel and the
restricted-app `onResult` funnel; the seam has one owner (reconciliation 8
in [Fold integration](archive/fold-integration.md)). Settle records carry lineage,
so automation-caused runs are dropped at evaluation; settles during suspension
are not queued. Automation runs register as the experimental kernel task kind
`automation_run`, excluded from stable protocol-v1 task projections like
`check_run`.

## Lifecycle and authority

1. **Propose.** The work-fold agent (or a person, by hand) writes the inert typed
   proposal. Nothing is registered, armed, or scheduled; proposals are
   ordinary files with no authority.
2. **Enable.** `work-fold automations enable --proposal <path>` — or **Turn on**
   beside a pending file in Settings → Automations — is a direct
   receipted verb (docs/receipts-not-gates.md, F23). It normalizes the
   declaration, rechecks the one-time horizon, requires every referenced
   work-folder to be registered, and commits the enablement through the same
   prepare-pin-journal-execute path every act verb takes — immediately, on
   the first call. The receipt pins the declaration digest and records the
   surface and request id. Enabling a declaration that is already on at the
   same digest is a no-op: no fresh receipt, no journal line, and an active
   run is left alone. Enabling a *changed* declaration is a fresh receipt
   that first stops any run still executing the previous one, because
   revocation must stop stale work before the change reads as complete.
   The digest pins the declaration, not the referenced work-folders'
   capabilities: a chat step runs with whatever Worker authority its
   work-folder holds at run time — the deliberate absence of re-review machinery
   is recorded below. The declaration write and the enablement commit are
   one logical operation; a failure may leave an inert declaration, never
   undeclared or digest-mismatched authority.
3. **Run.** Scheduled, on-settled, or run-now. Any edit to the declaration
   changes its digest, and a run admitted under the old digest is refused at
   the launch boundary — an edited automation never coasts on a stale
   enablement.
4. **Disable.** Narrowing is always direct: it journals the disable,
   persists it, cancels pending admissions, and stops the active run.
5. **Delete.** A direct verb on an inert disabled, suspended, or completed
   automation: removes the declaration, enablement history, and cadence
   anchor. An active or claimed-but-unfinished one-time run must settle or be
   stopped first. The receipts journal is retained — audit records survive
   the object, as with Checks.

The five questions, per mutation:

| Mutation | Journaled by | Receipt contains | Revoked / undone by | Mid-act failure | Replay prevented by |
|---|---|---|---|---|---|
| Enable | Act-lane journal plus automation store commit (`automation/enabled` with digest, surface, request id) | Automation id, declaration digest, surface and browser identity, timestamp | Disable; work-folder removal (automatic revocation to `suspended`) | Declaration-then-receipt as one logical operation; failure leaves inert declaration, never digest-mismatched authority | Act request-id at-most-once; an identical already-enabled digest is a no-op |
| Run (scheduled / on-settled) | Automation receipts journal, run `accepted` then durable schedule claim before hop 1, per-hop accepted/terminal pairs | Trigger cause, digest, occurrence id for one-time work, per-hop domain evidence (task ids, run ids, conversation id, restore-point id, counts) | Stop (active); files effects restorable via the hop's restore point; chat effects are an ordinary archivable Chat | Startup reconciles an accepted slot, records `interrupted`, and never replays it; completed hops keep receipts | Host-minted run ids; journal-first accepted gate; pre-hop interval/occurrence claim; serialized trigger funnel |
| Run-now | Act-lane journal plus the same run journal | As above, plus the act request id | Same as a run | Same as a run | Act request-id at-most-once plus run-id gate |
| Stop | Act-lane journal (or desktop action record) plus run terminal record | Run id, aborted hop task ids, skipped hops | Not applicable — stop is itself the revocation act | Abort signals are idempotent; a second stop finds a settled run | Act request-id at-most-once; a settled run refuses stop with its terminal state |
| Disable | Act-lane journal plus automation store | Prior state, stopped run id if one was aborted | Enable again (a fresh receipt) | Disabled intent persists first; startup refuses to arm a disabled automation; the active run at a crash is `interrupted` anyway | Act request-id at-most-once |
| Delete | Act-lane journal plus automation store | Automation id, digest, final health state | Not undoable; the declaration was inert data and receipts are retained | Active and claimed-but-unfinished occurrences are refused; grant is removed before declaration so no window holds authority without a declaration | Act request-id at-most-once |

## Where automations live in the product

Automations are managed in **Settings → Automations** (decision F15) — the
former Agent tools surface was rejected because an automation is not one
work-folder's object, and a work-fold agent work tab was rejected because it
would spend the work-folder-bound tab contract's own deliberate design. The
Settings section carries the list, state, declaration, bounded run history,
and valid actions; **Turn on** is one
click that enables the automation and writes its receipt.

Pending proposal files appear there too (2026-09-24). Settings scans the top
level of the work-fold agent's working folder — no subfolders, at
most 1,000 `*.work-fold-automation.json` files of at most 64 MiB each — validates
each with the proposal schema, and lists the ones not already stored at the
same digest under **Ready to turn on**, each with its title, trigger, and a
**Turn on** button. A file that does not validate, names an unregistered
work-folder, or has a one-time instant outside the enablement horizon shows only
its file name, with the problem as a tooltip and no button; when every file
is invalid the section is titled **Automation files** so the repair reason
remains visible. Turn on re-reads
that exact file — the path must resolve directly inside the work-fold agent's
working folder. Reads reject symbolic links and files that change while
being read, and never admit more than 64 MiB. The action takes the same
enable path as `automations enable
--proposal` (content-derived id, digest pinned at that moment, journaled
prepared act), with the receipt's surface recorded as `main-window`. The
automation then appears once, in the main list. The agent is taught to write the
file and tell the person it is there, and to enable it itself only when asked.
The scan is a read of inert files, so the section is absent in the browser
lane, where the desktop bridge is missing.

When more than one automation names more than one work-folder, a compact **All** /
per-work-folder chip row filters the list client-side by the work-folders each
automation's trigger and steps name. It is a view over the one list, not a
per-work-folder place: automations stay above work-folders.

*Amended 2026-09-24 (owner decision, revising F15):* Settings → Automations
stays the management home, and a work-folder also gets a read-mostly window onto
the automations that touch it. The rail shows an **Automations** entry
(between History and the contributed apps) only while at least one
automation's trigger or step names that work-folder; the renderer reads
`GET /api/work-folders/:id/automations` when the work-folder changes and when the
window regains focus, and caches the list per work-folder. Actions in Settings or
a work-folder's Automations tab refresh the cached work-folder views immediately, so
the rail does not wait for a window switch to show a newly enabled proposal
or remove a deleted declaration. The entry opens one
work-folder-owned **Automations** tab (`work-folder-automations`) under the
work-folder-bound-tab rules. Each row carries the title, one state word (On, Off,
Running, Suspended, or Done), the trigger summary Settings shows, what the
automation does in this work-folder (Watches this work-folder, Copies files here,
Copies files from here, Starts a Chat here, Runs a Check here), and the last
run time, with **Run now** (only while On), **Turn on**, and **Turn off**.
Those three call `POST /api/work-folders/:id/automations/:automationId/(run|enable|disable)`,
which runs the exact Settings facade methods — same prepared-act path, same
`main-window` receipts — and refuses an automation that does not name the work-folder.
Nothing is edited or deleted there, and **All automations** opens Settings →
Automations. Unlike Settings, the view is not desktop-only: it is served by
the session-authenticated local API, so it also works in the browser lane.
Automations are still declared, stored, and receipted above work-folders; the
work-folder view never becomes a second place to author one.

The work-fold agent narrates run
history on demand, and only an automation's own `agent` step ever puts it on a
cadence. An automation's effects remain visible where they land: the copied
files and restore point in the destination work-folder's Files and History, the
new conversation in the source work-folder's Chats.

The CLI act-lane group is `work-fold automations enable|list|show|run|stop|
disable|delete|receipts` — per-launch token, journal-first, and like the
`agent` group automations are above work-folders and take no `--work-folder`.
`list`/`show`/`receipts` are content-bearing (work-folder names, paths, messages)
and therefore act-lane, matching the Checks rule that only aggregate status
lives in the content-free read lane; a content-free automation status
projection for read-lane protocol v1 remains a separate deliberate
decision, not assumed.

## Bounds

Declaration structure is validated at parse and execution. Transport,
selection, and concurrent execution remain bounded; declarations have no
machine-wide count, step-count, or exact-path-count quota.

| Bound | Value | Source of the value |
|---|---|---|
| Triggers per automation | 1 (plus always-available run-now) | This design |
| Interval | 1 minute to 366 days (1–527,040 minutes) | `restrictedAppAutomationIntervalMinutes` |
| Catch-up | `latest` only (one make-up run) | `WorkFoldSchedulerService` |
| One-time horizon | at least one second in the future, up to ten years ahead, at enablement | `minAtAdvanceMs`/`maxAtAdvanceMs` in `src/shared/work-fold-limits.ts` |
| One-time missed policy | `run` or `skip` | One bounded catch-up or one recorded non-run |
| One-time occurrence | One scheduled/resume claim ever; completed retained until Delete | Durable completed health and deterministic occurrence id |
| work-folder-change debounce / cooldown | 1–3600 seconds / 0–10080 minutes | `src/local/automations/automation-declarations.ts` |
| work-folder observer | Metadata only, no byte bound; 50,000 files, 200,000 visited entries, depth 256 | `src/local/automations/automation-file-observer.ts` |
| Changed paths recorded per run cause | 10,000 (the count stays exact) | `workFoldAutomationDeclarationBounds` |
| Concurrent automation runs | 64, FIFO, machine-wide | `workFoldAutomationMaxConcurrentRuns`; a generous default, not a cap |
| Tree selector resolution | The Check target resolver's hard limits; tighten-only | `src/local/checks/target-resolver.ts` |
| Created-files handoff | `maxFiles` and `maxTotalBytes` mandatory in the declaration, at most 100,000 files and 64 GiB | `workFoldAutomationBounds` |
| Chat and agent step message | 4 MiB | The model's context window is the practical bound |
| One filled-in placeholder | 1 MiB | A resource guard; the cut names the limit |
| Items in one filled-in list | 10,000 | Same |
| Whole message after substitution | 8 MiB | Exceeding it fails the hop and names the limit |
| Declaration or proposal file | 64 MiB; Settings scans at most 1,000 proposal files | `workFoldAutomationDocumentMaxBytes`, `workFoldAutomationProposalScanBounds` |
| Run history / journal | 500 recent results; a 16 MiB receipts file rotated on the act-receipts pattern | Scheduler default; `WORKFOLD_AUTOMATION_RECEIPTS_MAX_BYTES`, `src/local/cli/act-receipts.ts` |

## Implementation record

The plan items shipped as follows:

1. Settle-signal seam — `src/local/automations/settle-signal.ts`; `tests/work-fold-automation-settle-signal.test.ts`.
2. Declaration and proposal schema — `src/local/automations/automation-declarations.ts`; `tests/work-fold-automation-declarations.test.ts`.
3. Automation store and receipts journal — `src/local/automations/automation-store.ts`; `tests/work-fold-automation-store.test.ts`.
4. Executor service and the `automation_run` kernel kind — `src/local/automations/automation-service.ts`, `src/local/work-fold-kernel.ts`; `tests/work-fold-automation-service.test.ts`, `tests/work-fold-kernel.test.ts`.
5. work-folder-removal revocation — `src/local/work-folder.ts`; `tests/local-work-folder.test.ts`.
6. Act-lane verbs — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/work-fold-cli-act-protocol.test.ts`, `tests/work-fold-act-facade.test.ts`.
7. Enablement wiring (superseded by 12) — the original gated enablement path; `tests/work-fold-automation-service.test.ts`.
8. work-fold agent instruction teaching — `src/local/work-fold-agent-instructions.ts`; `tests/work-fold-agent-conversation.test.ts`.
9. Settings surface and overview projection — `web-local/`; `tests/automations-settings-ui.test.ts`, `tests/automations-settings-api.test.ts`, `tests/web-ui-contract.test.ts`, `tests/frontend-interaction-contract.test.ts`.
10. Docs promotion — recorded in [Fold integration](archive/fold-integration.md).
11. Version-2 one-time scheduling and schema migration — `src/local/agent/work-fold-scheduler-service.ts`, `src/local/automations/`; `tests/work-fold-scheduler-service.test.ts`, `tests/work-fold-automation-declarations.test.ts`, `tests/work-fold-automation-store.test.ts`, `tests/work-fold-automation-service.test.ts`.
12. Receipts-not-gates: direct `automations enable`, version-4 placeholders and the `fold` step (now `agent`), raised defaults — `src/local/automations/`, `src/local/server.ts`; `tests/work-fold-automation-*.test.ts`, `tests/automations-settings-api.test.ts`, `tests/automations-settings-ui.test.ts`.
13. Pending proposals in Settings and the work-folder filter (2026-09-24) — `src/local/automations/automation-proposal-scan.ts`, the `automationSettings` facade in `src/local/server.ts`, `work-fold:automations:proposals` and `work-fold:automations:enable-proposal` in `desktop/src/`, `web-local/src/components/modals/AutomationsPane.tsx`; `tests/work-fold-automation-proposal-scan.test.ts`, `tests/automations-settings-api.test.ts`, `tests/automations-settings-ui.test.ts`.
14. work-folder-owned Automations view (2026-09-24, F15 amended) — `src/shared/automation-presentation.ts` (the one trigger summary Settings, the work-folder tab, and the route share), `workFoldAutomationWorkFolderRoles` in `src/local/automations/automation-declarations.ts`, `forWorkFolder`/`requireWorkFolderAutomation` on the `automationSettings` facade and the `/api/work-folders/:id/automations` routes in `src/local/server.ts`, `web-local/src/components/panes/WorkFolderAutomationsPane.tsx`, `web-local/src/hooks/useFolderAutomations.ts`; `tests/folder-automations.test.ts`, `tests/use-surface-tabs.test.ts`, `tests/frontend-interaction-contract.test.ts`.

## Deliberately not in this design

- **Automation chains.** Automation-caused settles never fire triggers; multi-hop
  behavior across automations is excluded structurally, not merely bounded.
- **Worker-turn, compaction, and work-fold agent request triggers**, for the
  reasons recorded under Triggers.
- **Ambient or durable file watching.** Version 3 admits only the explicitly reviewed bounded folder observation described above; it never watches an unselected work-folder or replays offline events.
- **Expressions, conditions, branching, retries, or free templating.**
  Version 4 admits only the closed, host-filled placeholder set; nothing
  evaluates model output, and there is no step-output piping beyond it and
  the declared created-files handoff.
- **Cross-work-folder moves or deletions.** The files step only copies additively
  with restore points; destructive operations stay with the person and are
  reversible through Recently deleted.
- **Recurring time-of-day and calendar schedules.** One-time absolute
  instants are admitted in version 2; daily, weekday, monthly, and
  RRULE-shaped recurrence remain later register decisions.
- **A newer-than-last-successful-run filter on `files` steps.** Recopying
  unchanged selector matches is safe by construction (additive,
  collision-renamed, restore-pointed), just noisy; the filter is deferred
  until dogfooding shows the noise matters.
- **Re-enablement when a referenced work-folder's capabilities change.** The
  enablement digest pins the declaration; the work-folders it names govern their
  own capabilities through their own grants. `automations show` and the desktop
  Automations pane state this as a residual rather than policing it with
  re-review machinery; if
  dogfooding shows it bites, that machinery is a register decision of its
  own.
- **Portable or shared automations.** Declarations never enter `.work-fold/`,
  sync, export, or any distribution lane.
- **A machine-wide automations rail destination, badge, or notification stream.**
  Settings owns management; the conditional work-folder entry above is a view of
  related automations, not a second management home.
- **Read-lane automation status.** All automation commands remain act-lane.
- **Hosted or remote execution.** Automations run only on this desktop while
  the app runs; outward exposure of anything an automation produces stays in
  [the publishing ladder](shared-pages.md) with its own grants, and no
  automation step may create or widen viewer exposure.
- **A general job system.** 64 run slots by default, generous bounds,
  four step kinds. If a flow does not fit, it belongs to a work-folder app's named
  automations, a Check, or a person.

## Authoring guidance

`work-fold help automations` includes a complete version-4 folder-change proposal
with file-copy, Chat, Check, and agent steps and two placeholders. The work-fold agent is instructed to consult it
before authoring. The example is checked against the real proposal validator;
it documents the nested `automation` envelope, additive copies, observer pauses,
and the distinction between a completed Check run and clear findings.


A Chat or agent hop follows its durable request through answer and synthesis
turns. A question ends this automation at that hop with a visible failure and a
Chat reference; answering continues the request, never the remaining automation
effects. A completed hop carries the selected result envelope internally,
while its receipt keeps identifiers and attribution rather than copying the
report's content. Created-file steps still use their declared checkpoint diff.
