# Collaboration contract

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

## Register entries

| # | Decision | What it does not change |
|---|---|---|
| F25 | **Durable requests.** Every accepted Assistant turn belongs to a machine-local request record. A management turn creates a root request; a `chat send --parent-task` creates a child request under it; a Space turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory management request registry is replaced by this store; `manage status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. Space transcripts carry nothing new. |
| F26 | **Space turns get their own context.** Every Space turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way Space instructions are, describing the verbs below and the rule that cross-Space work goes through them. The fold transcript, the Space registry, and other Spaces' results never enter a Space turn. | Nothing is written into the Space folder. `.pi/` and `.work-fold/` are untouched. |
| F27 | **Report, ask, answer, handoff.** Four Space-scoped act verbs, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` delivers one accepted answer and starts exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another Space with a message and copies of named files. Delivery is host-side: no fold model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Routings remain the only unattended cross-Space glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `manage wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When every child of a root management request has settled after the fold's own turn ended, the host starts at most one continuation turn in that management conversation carrying the collected reports, within the request's limits. The person can turn continuations off in Settings → The fold → Limits. | F8's ban on scheduled or arbitrary event-driven fold turns. A continuation belongs to a person-initiated request and happens once per settle batch. |
| F29 | **One result shape.** A result envelope is `summary` (text, at most 32 KiB), optional `data` (JSON, at most 256 KiB, validated against a schema when the request declared one), optional `files` (Space-relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and routing chat hops all produce it. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the Assistant chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Views and workers subscribe; viewers do not. A hint carries ids and revisions, never content; the app re-reads. | Hints never start a model turn. The internal settle signal stays private. |

## Verbs

All are act-lane, Space-scoped, receipted, and available to the fold, a Space
Assistant, an app-requested task, and an outside harness alike. `help
collaborate` documents them with examples that the tests validate.

```
work-fold chat report  --space <id> --task <own-task-id> --summary "<text>" [--data <json-or-@file>] [--file <space-path>]... [--outcome succeeded|partial|failed] --json
work-fold chat ask     --space <id> --task <own-task-id> --question "<text>" [--to person|parent] --json
work-fold chat answer  --space <id> --question <id> --answer "<text>" [--parent-task <id>] --json
work-fold chat handoff --space <id> --task <own-task-id> --to-space <id> --message "<text>" [--file <space-path>]... --json
work-fold chat wait    --space <id> --task <id> [--timeout <s>] --json     # settles on terminal OR waiting
work-fold manage wait  --task <id> [--timeout <s>] --json                  # same
work-fold requests list|show --request <id> --json                          # management-scope reads of the request graph
```

- A task id in `--task` must belong to the caller's own turn; the host
  validates it the way `--parent-task` is validated today.
- `chat ask --to parent` on a root request with no parent is delivered to the
  person. `--to person` is the default.
- `chat answer` refuses a second answer, an answer to an expired question,
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

## Records

- **Request:** id, kind (`management`, `space`, `app`, `routing`, `cli`),
  root id, parent task id, owner scope (management, or Space id plus
  conversation id), app installation when applicable, surface, created at,
  state (`working`, `waiting`, `handed_off`, `done`, `partial`, `failed`,
  `stopped`, `expired`), children, questions, results, usage, deadline.
- **Question:** id, request id, task id, respondent (`person` or `parent`),
  text (at most 16 KiB), asked at, state (`open`, `answered`, `expired`,
  `cancelled`), answer and answered at, continuation task id.
- **Result:** the envelope above plus task id, recorded at, and receipt id.
- Records are machine-local under the state root. Only the assignment text,
  the answer text, released report summaries, and copied files ever enter a
  Space Chat.

## Limits (Settings → The fold → Limits)

| Limit | Default | On hit |
|---|---|---|
| Request deadline | 24 hours | request `expired`; open questions expire; no continuation |
| Child tasks per root request | 32 | `chat send`/`chat handoff` refused, names this limit |
| Delegation depth | 4 | same |
| Concurrent children per root | 8 | `chat send`/`chat handoff` refused, names this limit |
| Continuation turns per root | 4 | further settles are recorded, not narrated |
| Provider budget per root | unlimited (optional cap) | request `failed`, names the cap |
| Question lifetime | request deadline | question `expired` |

## Apps

- `bridge.tasks.onChanged(listener)` fires for the installation's own
  assistant tasks and inference receipts: `{ revision, taskIds, receiptIds }`.
- `bridge.checks.onChanged(listener)` fires when a selected Check's result
  changes: `{ revision, permissionIds }`.
- `bridge.files.onChanged(listener)` fires when files under a granted root
  change on disk, debounced, bounded: `{ revision, permissionIds, truncated }`.
- Subscriptions are per mount, dropped on close, and never replayed.
- App assistant tasks produce the F29 envelope: `result.summary`,
  `result.data` when the action declared an output schema, and `result.files`.

## What does not change

- Everything in the receipts record's "What does not change".
- The fold is never scheduled; routings remain the trigger-driven glue.
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
