# Collaboration contract

Current product language calls the work-folder helper a **Worker** and the
management helper the **work-fold agent**. This durable contract keeps its
technical `work-folder`, `fold`, and `automation` record and command names.

> **Status:** Accepted 2026-09-11 (owner decision) as the wave B build
> specification under [Receipts, not gates](receipts-not-gates.md). It turns
> the design in [agent collaboration and app AI primitives](archive/assistant-collaboration-plan.md)
> into concrete verbs, records, and defaults. Where this document and that
> plan differ, this document governs; where this document and the receipts
> record differ, the receipts record governs.

The goal: a person asks the work-fold agent for an outcome, the work-fold agent and work-folder
agents divide the work, hand each other selected results, ask each other
and the person questions, and continue exactly once when an answer arrives.
Custom apps see their own work change without polling. Any shell-capable
agent on the CLI gets the same verbs. Nothing in this contract adds a gate.

The person-facing presentation is specified in [Collaboration experience](collaboration-experience.md):
request-wide progress and Stop, addressed questions, selected files, and explicit recovery
across Chats, the work-fold agent, Apps, and the paired browser.

Native Pi Extension dialogs are a separate compatibility mechanism: the
development [Extension UI adapter](skills-and-extensions.md#live-extension-questions-development)
places live callbacks in the owning Chat and cancels them on Stop or session
end. It cannot reconstruct a callback after restart and does not claim F27's
durable answer/continuation semantics. An Extension needing those semantics
uses the collaboration verbs below.

## Register entries

| # | Decision | What it does not change |
|---|---|---|
| F25 | **Durable requests.** Every accepted agent turn belongs to a machine-local request record. A work-fold agent turn creates a root request; a `chat send --parent-task` creates a child request under it; a work-folder turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory work-fold agent request registry is replaced by this store; `agent status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. work-folder transcripts carry nothing new. |
| F26 | **work-folder turns get their own context.** Every work-folder turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way work-folder instructions are, describing the verbs below and the rule that cross-work-folder work goes through them. The work-fold agent transcript, the work-folder registry, and unselected results from other work-folders never enter a work-folder turn. | Nothing is written into the work-folder's folder. `.pi/` and `.work-fold/` are untouched. |
| F27 | **Report, ask, answer, handoff.** work-folder-scoped collaboration verbs and management-scoped `agent ask|answer`, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` and `agent answer` durably reserve one answer delivery and start exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another work-folder with a message and copies of named files. Delivery is host-side: no work-fold agent model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Automations remain the only unattended cross-work-folder glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `agent wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When an owning Chat is idle and its children have settled or asked questions, the host can start one continuation carrying undelivered direct-child reports. This applies to the work-fold agent, work-folder, app, CLI and automation requests. Delivery is recorded by child turn identity, never inferred from relative settle times. | No arbitrary event-driven fold turns. A continuation belongs to an explicit request; declared automation agent steps remain the only trigger-driven entry. |
| F29 | **One result shape.** A result envelope is `summary` (text, at most 4 MiB), optional `data` (JSON, at most 16 MiB, validated against a schema when the request declared one), optional `files` (work-folder-relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and automation chat hops all produce it. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the agent chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Active views subscribe; workers receive task/file hints during an operation, while Check access and hints remain view-only. Viewers do not subscribe. A hint carries ids and revisions, never content; the app re-reads. | Hints never start a model turn. The internal settle signal stays private. |

### 2026-10-01 amendment: work-folders inside work-folders

A person may register work-folders inside another work-folder (a repository and its
packages). Each inner work-folder's Worker owns that part of the parent's folder.
F26 is amended in two narrow ways; both come from the person's own acts, not
from the registry:

- **Nested work-folders.** A work-folder turn's hidden context lists the work-folders
  registered directly inside its own folder (id, name, path relative to it)
  and asks the Worker to hand their work off with `chat handoff` instead of
  editing it. The parent learns nothing else about them, and a work-folder with no
  nested work-folders hears nothing new.
- **Addressed Workers.** When the person writes `@Name` in a message, the
  composer sends those work-folder ids as `addressedWorkFolderIds` (at most eight,
  never the sender's own; an id no longer registered is dropped, and the ids
  stay out of the request digest so a retry still replays). The host resolves them to id and name
  in that turn's context only. A work-folder Worker hands each its part with
  `chat handoff`; the work-fold agent sends each its part with
  `chat send --parent-task`. The `@Name` text stays ordinary message text.
  A message steered into a running turn carries no addressed Workers; the
  composer queues a message that mentions one until the turn ends.
- **work-folder operations.** A parent work-folder cannot delete, move, or rename a
  folder that holds a nested work-folder, or anything inside one; that content is
  changed from the nested work-folder itself.

Nothing new is written into a work-folder's folder, and the work-folder registry, the
work-fold agent's transcript, and other work-folders' results still never enter a work-folder turn.
`work-fold work-folders list --json` and the work-fold agent turn's registry snapshot
carry `parentWorkFolderId` for a nested work-folder, so the work-fold agent can split a
request by owner.

## Verbs

All are act-lane and receipted; `chat` verbs name a work-folder and `agent` verbs own management questions. They are available to the work-fold agent, a work-folder
agent, an app-requested task, and an outside harness alike. `help
collaborate` documents them with examples that the tests validate.

```
work-fold chat report  --work-folder <id> --task <own-task-id> --summary "<text>" [--data <json-or-@file>] [--file <work-folder-path>]... [--outcome succeeded|partial|failed] --json
work-fold chat ask     --work-folder <id> --task <own-task-id> --question "<text>" [--to person|parent] --json
work-fold chat answer  --work-folder <id> --question <id> --answer "<text>" [--parent-task <id>] --json
work-fold chat handoff --work-folder <id> --task <own-task-id> --to-work-folder <id> --message "<text>" [--file <work-folder-path>]... --json
work-fold chat wait    --work-folder <id> --task <id> [--timeout <s>] --json     # settles on terminal OR waiting
work-fold agent ask   --task <own-task-id> --question "<text>" --json
work-fold agent answer --question <id> --answer "<text>" --json
work-fold agent wait  --task <id> [--timeout <s>] --json                  # same
work-fold requests list|show --request <id> --json                          # management-scope reads of the request graph
```

- A task id in `--task` must belong to the caller's own turn; the host
  validates it the way `--parent-task` is validated today.
- `chat ask --to parent` on a root request with no parent is delivered to the
  person. `--to person` is the default.
- `chat answer` refuses a second answer, an answer after Stop,
  and an answer from a work-folder that does not own the question. The
  continuation is a new turn in the same Chat, carrying the answer as an
  ordinary user-role message with the question id in machine-local metadata.
- `chat handoff` copies files through the same additive, restore-pointed path
  as `files add`, starts a new Chat in the destination through the normal
  acceptance path, links it as a child of the caller's root request, and the
  destination's report flows back to that root.
- Delivery of a report to a parent whose turn is still running is available
  to that turn through `chat wait`; a parent whose turn has ended sees it in
  `agent status`, `requests show`, the overview, and the continuation turn.

## Completion, delivery and recovery

A request owns the work; a turn is one execution within it. Status, waits,
app receipts and automation hops follow the request across answer and synthesis
turns. An unanswered question or an accepted answer without a linked turn
remains outstanding, including after restart. Stop fences answer acceptance
and continuation admission through every ancestor.

The original assignment is saved separately from the latest message. Every
work-folder continuation rebuilds its assignment and delegated handle from that
record. Selected direct-child reports may be admitted into a new turn's hidden
context; their delivery identities are recorded. Otherwise an idle owner can
receive one synthesis turn. Children finishing before their parent
ends are eligible too. Nested owners synthesize before their own parent wakes.
When compaction holds an otherwise idle owner, both successful and failed
compaction cleanup reevaluate its pending child deliveries. This releases
only results settled during the current app run; restart never replays them.
The same child turn is not delivered twice, and a continuation cannot wake
itself. A reserved continuation that fails acceptance or is interrupted by
restart is recorded as failed, without redispatch.

`chat result --work-folder <id> --task <id>` and `agent result --task <id>` return
`request` and the completed request's selected `result` envelope alongside
its latest reply. They refuse while work remains outstanding. A work-folder can
read a named child's released result through that child's work-folder and task id;
it cannot read the machine-wide request graph. The latest turn's latest
report describes its outcome; old partial reports remain history rather than
permanently preventing a later successful result. File paths belong to the
reporting work-folder until explicitly copied.
Synthesis selects that same latest-turn report and its files. An older
success cannot describe a failed answer turn or a new turn with no report;
failed, stopped, and partial request outcomes override an optimistic report.

Deleting a Chat, a file, or a work-folder refuses while its affected request
graph remains unfinished, including questions waiting for an answer and
accepted continuations. Stop closes outstanding work but deletion waits for
its accepted turns to drain. File and work-folder deletion also reserve the
affected work-folder against new turns, compaction, Checks, app jobs with file
access, and Automation file work until the deletion completes.

An app receipt keeps its installation and authority pins while following the
whole owned request. `waiting` is ongoing and has no final result. Stop reaches
outstanding descendants, schema validation applies to every own continuation,
and usage totals include settled delegated work. An automation waits for the
request, not only its first turn. If it needs an answer, the automation ends at
that hop with an explicit failure; answering in the Chat continues that
request but never replays subsequent automation effects.

## Records

- **Request:** id, kind (`management`, `work-folder`, `app`, `automation`, `cli`),
  root id, parent task id, original assignment, latest message, delivered child
  turn ids, continuation reservation state, owner scope (management, or work-folder id plus
  conversation id), app installation when applicable, surface, created at,
  state (`working`, `waiting`, `handed_off`, `done`, `partial`, `failed`,
  `stopped`), children, questions, results, and usage.
- **Question:** id, request id, task id, respondent (`person` or `parent`),
  text (at most 4 MiB), asked at, state (`open`, `answered`,
  `cancelled`), answer and answered at, continuation task id.
- **Result:** the envelope above plus task id, recorded at, and receipt id.
- Records are machine-local under the state root. Only the assignment text,
  the answer text, released report summaries, and copied files ever enter a
  work-folder Chat.

## Execution and transport bounds

Requests, questions, reports, and continuations do not have a built-in
lifetime, delegation-depth, or count quota. They remain explicit, durable
records until they settle, are stopped, or retention removes settled data.
Each Chat runs one turn or compaction at a time. Different Chats and
work-folders, including work-fold agent Chats, can run concurrently; delegated children
have no separate slot limit or waiting queue. Transport fields keep resource
guards sized so ordinary work never meets them (2026-10-10).

| Bound | Value | On hit |
|---|---|---|
| Question text | 4 MiB | the write is refused before it is recorded |
| Answer text | 4 MiB | the write is refused before it is recorded |
| Result summary | 4 MiB | the write is refused before it is recorded |
| Result data | 16 MiB | the write is refused before it is recorded |
| Provider budget per root | no default cap; a host may set one | request fails when the configured cap is exceeded |

## Apps

- `bridge.tasks.onChanged(listener)` fires for the installation's own
  assistant tasks and inference receipts: `{ revision, taskIds, receiptIds }`.
- `bridge.checks.onChanged(listener)` fires when a selected Check's result
  changes: `{ revision, permissionIds }`.
- `bridge.files.onChanged(listener)` fires when files under a granted root
  change on disk, debounced, bounded: `{ revision, permissionIds, truncated }`.
- Subscriptions are per mount, dropped on close, and never replayed. Check
  reads/hints remain view-only. Inference receipt ids can refresh the trusted
  Apps view; the app bridge has no receipt lookup.
- App assistant tasks produce the F29 envelope: `result.summary`,
  `result.data` when the action declared an output schema, and `result.files`.

## What does not change

- Everything in the receipts record's "What does not change".
- The work-fold agent has no independent ambient scheduler. A declared automation agent step may start a work-fold agent request; its continuations keep the same durable identity and Stop behavior.
- work-folder Chats stay portable and carry no cross-work-folder state.
- The bounded text-review Check, `assistant.infer`, and the app sandbox.

## Build plan

Wave B is one gated workflow on the `receipts-not-gates` branch: survey →
foundations (request store, question store, envelope validator, help text) →
request integration (replace the in-memory registry; work-folder turn context and
guide) → verbs and continuation → app subscriptions → fold instructions,
docs, and copy → gates → adversarial review → checkpoint. Acceptance is the
plan's "Delegate and clarify", "Request help from a work-folder", "Compose work-folders
and apps", and "Discover and build" journeys, each driven end to end through
the local API and CLI in tests, plus restart and double-answer cases.
