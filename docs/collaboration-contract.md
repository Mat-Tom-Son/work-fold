# Collaboration contract

Current product language calls the Folder helper a **Worker** and the
management helper the **work-fold agent**. This durable contract keeps its
technical `space`, `fold`, and `routing` record and command names.

> **Status:** Accepted 2026-09-11 (owner decision) as the wave B build
> specification under [Receipts, not gates](receipts-not-gates.md). It turns
> the design in [Assistant collaboration and app AI primitives](assistant-collaboration-plan.md)
> into concrete verbs, records, and defaults. Where this document and that
> plan differ, this document governs; where this document and the receipts
> record differ, the receipts record governs.

The goal: a person asks the fold for an outcome, the fold and Space
Assistants divide the work, hand each other selected results, ask each other
and the person questions, and continue exactly once when an answer arrives.
Custom apps see their own work change without polling. Any shell-capable
agent on the CLI gets the same verbs. Nothing in this contract adds a gate.

The person-facing presentation is specified in [Collaboration experience](collaboration-experience.md):
request-wide progress and Stop, addressed questions, selected files, and explicit recovery
across Chats, the fold, Apps, and the paired browser.

Native Pi Extension dialogs are a separate compatibility mechanism: the
development [Extension UI adapter](assistant-capabilities.md#live-extension-questions-development)
places live callbacks in the owning Chat and cancels them on Stop or session
end. It cannot reconstruct a callback after restart and does not claim F27's
durable answer/continuation semantics. An Extension needing those semantics
uses the collaboration verbs below.

## Register entries

| # | Decision | What it does not change |
|---|---|---|
| F25 | **Durable requests.** Every accepted Assistant turn belongs to a machine-local request record. A management turn creates a root request; a `chat send --parent-task` creates a child request under it; a Space turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory management request registry is replaced by this store; `manage status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. Space transcripts carry nothing new. |
| F26 | **Space turns get their own context.** Every Space turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way Space instructions are, describing the verbs below and the rule that cross-Space work goes through them. The fold transcript, the Space registry, and unselected results from other Spaces never enter a Space turn. | Nothing is written into the Space folder. `.pi/` and `.work-fold/` are untouched. |
| F27 | **Report, ask, answer, handoff.** Space-scoped collaboration verbs and management-scoped `manage ask|answer`, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` and `manage answer` durably reserve one answer delivery and start exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another Space with a message and copies of named files. Delivery is host-side: no fold model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Routings remain the only unattended cross-Space glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `manage wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When an owning Chat is idle and its children have settled or asked questions, the host can start one continuation carrying undelivered direct-child reports. This applies to the fold, Space, app, CLI and routing requests. Delivery is recorded by child turn identity, never inferred from relative settle times. | No arbitrary event-driven fold turns. A continuation belongs to an explicit request; declared routing fold steps remain the only trigger-driven entry. |
| F29 | **One result shape.** A result envelope is `summary` (text, at most 32 KiB), optional `data` (JSON, at most 256 KiB, validated against a schema when the request declared one), optional `files` (Space-relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and routing chat hops all produce it. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the Assistant chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Active views subscribe; workers receive task/file hints during an operation, while Check access and hints remain view-only. Viewers do not subscribe. A hint carries ids and revisions, never content; the app re-reads. | Hints never start a model turn. The internal settle signal stays private. |

## Verbs

All are act-lane and receipted; `chat` verbs name a Space and `manage` verbs own management questions. They are available to the fold, a Space
Assistant, an app-requested task, and an outside harness alike. `help
collaborate` documents them with examples that the tests validate.

```
work-fold chat report  --space <id> --task <own-task-id> --summary "<text>" [--data <json-or-@file>] [--file <space-path>]... [--outcome succeeded|partial|failed] --json
work-fold chat ask     --space <id> --task <own-task-id> --question "<text>" [--to person|parent] --json
work-fold chat answer  --space <id> --question <id> --answer "<text>" [--parent-task <id>] --json
work-fold chat handoff --space <id> --task <own-task-id> --to-space <id> --message "<text>" [--file <space-path>]... --json
work-fold chat wait    --space <id> --task <id> [--timeout <s>] --json     # settles on terminal OR waiting
work-fold manage ask   --task <own-task-id> --question "<text>" --json
work-fold manage answer --question <id> --answer "<text>" --json
work-fold manage wait  --task <id> [--timeout <s>] --json                  # same
work-fold requests list|show --request <id> --json                          # management-scope reads of the request graph
```

- A task id in `--task` must belong to the caller's own turn; the host
  validates it the way `--parent-task` is validated today.
- `chat ask --to parent` on a root request with no parent is delivered to the
  person. `--to person` is the default.
- `chat answer` refuses a second answer, an answer after Stop,
  and an answer from a Space that does not own the question. The
  continuation is a new turn in the same Chat, carrying the answer as an
  ordinary user-role message with the question id in machine-local metadata.
- `chat handoff` copies files through the same additive, restore-pointed path
  as `files add`, starts a new Chat in the destination through the normal
  acceptance path, links it as a child of the caller's root request, and the
  destination's report flows back to that root.
- Delivery of a report to a parent whose turn is still running is available
  to that turn through `chat wait`; a parent whose turn has ended sees it in
  `manage status`, `requests show`, the glance, and the continuation turn.

## Completion, delivery and recovery

A request owns the work; a turn is one execution within it. Status, waits,
app receipts and routing hops follow the request across answer and synthesis
turns. An unanswered question or an accepted answer without a linked turn
remains outstanding, including after restart. Stop fences answer acceptance
and continuation admission through every ancestor.

The original assignment is saved separately from the latest message. Every
Space continuation rebuilds its assignment and delegated handle from that
record. Selected direct-child reports may be admitted into a new turn's hidden
context; their delivery identities are recorded. Otherwise an idle owner can
receive one synthesis turn. Children finishing before their parent
ends are eligible too. Nested owners synthesize before their own parent wakes.
The same child turn is not delivered twice, and a continuation cannot wake
itself. A reserved continuation that fails acceptance or is interrupted by
restart is recorded as failed, without redispatch.

`chat result --space <id> --task <id>` and `manage result --task <id>` return
`request` and the completed request's selected `result` envelope alongside
its latest reply. They refuse while work remains outstanding. A Space can
read a named child's released result through that child's Space and task id;
it cannot read the machine-wide request graph. The latest turn's latest
report describes its outcome; old partial reports remain history rather than
permanently preventing a later successful result. File paths belong to the
reporting Space until explicitly copied.

An app receipt keeps its installation and authority pins while following the
whole owned request. `waiting` is ongoing and has no final result. Stop reaches
outstanding descendants, schema validation applies to every own continuation,
and usage totals include settled delegated work. A routing waits for the
request, not only its first turn. If it needs an answer, the routing ends at
that hop with an explicit failure; answering in the Chat continues that
request but never replays subsequent routing effects.

## Records

- **Request:** id, kind (`management`, `space`, `app`, `routing`, `cli`),
  root id, parent task id, original assignment, latest message, delivered child
  turn ids, continuation reservation state, owner scope (management, or Space id plus
  conversation id), app installation when applicable, surface, created at,
  state (`working`, `waiting`, `handed_off`, `done`, `partial`, `failed`,
  `stopped`), children, questions, results, and usage.
- **Question:** id, request id, task id, respondent (`person` or `parent`),
  text (at most 16 KiB), asked at, state (`open`, `answered`,
  `cancelled`), answer and answered at, continuation task id.
- **Result:** the envelope above plus task id, recorded at, and receipt id.
- Records are machine-local under the state root. Only the assignment text,
  the answer text, released report summaries, and copied files ever enter a
  Space Chat.

## Execution and transport bounds

Requests, questions, reports, and continuations do not have a built-in
lifetime or count quota. They remain explicit, durable records until they
settle, are stopped, or retention removes settled data. Concurrent work and
transport fields stay bounded so cancellation, scheduling, and persistence
remain reliable.

| Bound | Value | On hit |
|---|---|---|
| Concurrent children per root | 8 | new child work waits for a slot |
| Question text | 16 KiB | the write is refused before it is recorded |
| Result summary | 32 KiB | the write is refused before it is recorded |
| Result data | 256 KiB | the write is refused before it is recorded |

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
- The fold has no independent ambient scheduler. A declared routing fold step may start a management request; its continuations keep the same durable identity and Stop behavior.
- Space Chats stay portable and carry no cross-Space state.
- The bounded text-review Check, `assistant.infer`, and the app sandbox.

## Build plan

Wave B is one gated workflow on the `receipts-not-gates` branch: survey →
foundations (request store, question store, envelope validator, help text) →
request integration (replace the in-memory registry; Space turn context and
guide) → verbs and continuation → app subscriptions → fold instructions,
docs, and copy → gates → adversarial review → checkpoint. Acceptance is the
plan's "Delegate and clarify", "Request help from a Space", "Compose Spaces
and apps", and "Discover and build" journeys, each driven end to end through
the local API and CLI in tests, plus restart and double-answer cases.
