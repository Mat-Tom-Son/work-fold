# The overview — the work-fold agent's deterministic digest

**Status: shipped contract reference.** The overview shipped with the work-fold agent
build — `src/local/overview.ts` and `src/local/overview-seen-store.ts` with
their suites are the implementation authority — and its decisions were
promoted on 2026-08-11 into [the work-fold agent decision register](work-fold-agent-decisions.md) (F10),
[the work-fold agent and CLI](work-fold-agent-and-cli.md) (the remote-operation paragraph
and verification map), `README.md`, `SECURITY.md`, `PRIVACY.md`, and
[Desktop parity](ui-parity.md)/[the visual system](visual-design.md)
(surface placement). This document retains what canon does not carry: the
closed source inventory, the section and ordering rules, the marker
contract, and the non-goals. The promotion record is
[Fold integration](archive/fold-integration.md).

**Amended 2026-09-10** by [Receipts, not gates](receipts-not-gates.md) (F24):
**Needs you** carries recorded questions, due snoozes, and requests waiting
on a person's answer, and nothing else. Nothing in the digest waits to be
allowed, so no surface that renders it offers a control that allows an
action.

**Amended 2026-09-11** by [the collaboration contract](collaboration-contract.md)
(F25, F27, F28): the request records the digest reads are durable, so an
outstanding request survives a restart; **Running now** folds a request with
the turns it started; a needs-you item is one **open question** rather than a
request phase; and a settled request item names the outcome handed back.
Nothing else about the sections, ordering, caps, markers, or the non-goals
changes.

The overview is a small digest a person reads in a few seconds: what is
running right now, what is waiting on them, what changed since they last
looked, and where Checks stand. It is composed by app code from state the
product already records. No model call composes it and it adds no watcher.
Its Check-status reader may re-read and hash explicitly designated text to
verify freshness; it does not scan unconfigured work-folders or include that text
in the digest. The overview is a projection, not a store: every item points back at
a durable or task-scoped record that exists for its own reasons, the digest
can always be recomputed, and it is never itself the authority for
anything. The only state this design added is the per-surface last-seen
marker — machine-local presentation preference in the same class as the
existing Chat attention marker.

## The source inventory

The overview may read exactly these sources. The table is closed: adding a
source means adding a row here first, and the row must name a record the
product keeps for its own sake. The overview never causes a record to exist.

| Source | Module | Durability | The overview reads |
|---|---|---|---|
| Running task registry | `WorkFoldKernel` in `src/local/work-fold-kernel.ts` | In-memory, app run | Running `assistant_turn` and `compaction` tasks (stable v1) plus experimental `check_run` and `automation_run` tasks, with work-folder id, actor, `startedAt` |
| Settled turn outcomes | `SettledTurnRecord` in `src/local/server.ts` | In-memory, app run | Task-scoped `succeeded`/`failed`/`aborted` results with `endedAt` |
| Requests and questions | The durable request store under the state root's `requests/` directory (F25) | Durable machine-local app state, reconciled against the turn journal after a restart, never replayed | Requests in `working`/`handed_off` (running) with the child task ids they started, open questions whose respondent is the person (needs you), and settled requests with their outcome |
| Chat lifecycle and titles | `src/local/agent/chat-store.ts` | Durable — append-only portable transcripts with a rebuildable machine-local summary index | `conversation_lifecycle` events, title changes, `snoozedUntil` due times, and the newest assistant `landing.followUpPrompt` |
| History checkpoints | `listWorkFolderCheckpoints` in `src/local/history.ts` | Durable machine-local app state | `checkpointId`, `createdAt`, `label`, `reason`, `scope` |
| Check status | `WorkFoldCheckService.status()` in `src/local/checks/check-service.ts` | Durable machine-local Check state, locally re-verified designated inputs | Per-work-folder aggregate state and counts; text freshness reads/hashes designated files locally without executing a sensor or calling a model |
| Act receipts | `WorkFoldCliActReceipts` journal (`src/local/cli/act-receipts.ts`) | Durable, rotation-bounded | Terminal `ok`/`error` records: command name, work-folder id, outcome, checkpoint id, parent task id |
| App automation run receipts | `RestrictedAppAutomationRunReceipt` in `src/local/agent/restricted-app-service.ts` | Durable registry state | Named job, App Instance, outcome, timestamps |
| App automation scheduler state | `WorkFoldSchedulerService` | In-memory, app run | Active and pending named jobs, feeding "Running now" |
| Automation runs | `src/local/automations/automation-store.ts` | Durable | Running and settled automation runs with per-hop outcomes |
| Viewer grants | `src/local/publications.ts` | Durable | Publication created/revoked events and page health (not-available, resting) |

Durability is disclosed, not papered over. In-memory sources live for the
app run only; after a restart the digest recomputes from durable records
and simply contains less — it never fabricates continuity it cannot
re-derive. Requests moved to a durable store on 2026-09-11, so an
outstanding request and its open questions now survive a restart; the
sources still living for the app run are the kernel's running-task
registry, the settled-turn outcomes, and the app automation scheduler.

## The digest

One snapshot shape (`work-fold.overview.experimental`, version 0, in
`src/local/overview.ts`), composed on request. Composition is deterministic:
the same recorded state and the same single `composedAt` clock reading
produce a byte-identical digest. Headlines are fixed templates over typed
record fields — never model output, never file content, never free
re-wording. A receipt naming an unregistered work-folder renders the id plus
"(removed)". Every section carries a `truncated` flag; bounds are
disclosure, not curation.

**Running now** — everything the product knows is executing: assistant
turns and compactions, Check runs, app automation runs, and Automation runs.
Running work above a single turn is request-derived: a request in `working`
or `handed_off` is one item that carries the turns it started, wherever
those turns run, so a delegated request and its work-folder turns are never
double-counted. A request in `waiting` is not running: what it is waiting on
appears in **Needs you** instead. Ordered by
`startedAt` ascending (longest-running first), tie-broken by id. Cap 256;
overflow drops the newest, never the oldest — a long-running turn must not
be hidden by churn.

**Needs you** — only things structurally waiting on the person's answer:
`request-question` (one item per **open question** on a request whose
respondent is the person, not one item per request phase — a request with
two open questions contributes two items, and a question addressed to its
parent request belongs to that parent and never appears here; one older
form survives beside it, and only there: a **settled work-fold agent request**
whose own closing reply ends in a question mark contributes one item with no
question id, because that question was asked in prose and was never
recorded),
`chat-question` (a work-folder Chat whose newest transcript message carries a
recorded follow-up prompt, while Active and not running; it clears when the
person replies, never merely because it was looked at), and `due-snooze`.
The headline stays a fixed template over typed fields: a question's own text
is model output, so it is not in the digest — the item's `ref` carries the
question id and the asking work-folder, and a surface reads the text through
`requests show`. Nothing here is an action waiting to be allowed —
needs-you means a question (decisions F24 and F27). Ordered newest-first.
Cap 256; overflow keeps the newest and states truncation. A needs-you item
never disappears because it was seen; only answering, expiry, resuming, or
revocation removes it.

**Since you last looked** — settled and recorded changes, newest first:
`checkpoint-saved`, `turn-settled`, `request-settled` (a request reaching
`done`, `partial`, `failed`, `stopped`, or `expired`; the headline names
that outcome, and the item's `ref` carries the request id so a surface can
read the results handed back through `requests show` — a result's summary,
structured data, and files are never in the digest), `chat-lifecycle`,
`chat-renamed`, `check-run-settled`, `act-performed` (every receipted verb,
including the ones that install code, widen a power, or delete),
`app-automation-run-settled`, `automation-run-settled`, `viewer-grant-changed`, and
`publication-state` (page health: not-available and resting reach the person
here with the precise reason viewers never see). An answered question adds
no kind of its own: it simply leaves **Needs you**, and the request's own
settle carries the story. Bounded
twice: at most 128 items per kind and 512 total. The `cursor` identifies the
newest change item as `"<at>/<id>"`; surfaces render items newer than their
own marker as new and older items quieter, and a **Show earlier**
affordance reveals the bounded tail regardless of the marker, so marking
seen loses nothing.

**Checks** — one row per registered work-folder with configured Checks, projected
from the same aggregate snapshot as `checks status`: state, counts,
`lastRunAt`. Ordered `needs-attention`, `check-error`, `blocked`, `stale`,
`current-clear`, then by work-folder name; cap 512. The epistemic rules of the
[Checks register](checks.md) apply unchanged: unconfigured means unknown,
`neverRun` and `stale` stay distinct, a blocked or erroring Check is
health, never a content claim, and composing this section never runs a
sensor or calls a model. Designated text may be read and hashed locally
for freshness. Aggregate rows only — finding titles, paths,
and evidence stay in the work-folder's Checks work tab.

## Last-seen markers

One machine-local record (`overview-seen.json` under the state root,
`src/local/overview-seen-store.ts`) maps active surface ids — `main-window`
and `remote:<grantId>`, one marker per paired browser grant so two phones
do not clear each other — to the cursor each surface has acknowledged.
`popover` remains an accepted legacy id so existing state and an older
renderer cannot corrupt the store, but the current popover neither fetches
the digest nor advances that marker. Markers are presentation preference
exactly as the product model defines for Chat attention state: machine-local,
disposable, never portable, never authority. A marker advances only when a
person viewing a surface acknowledges a rendered digest; fetching never
advances a marker, and the work-fold agent narrating the overview never advances one
either.

Marker advance is the overview's only mutation, and its standard answers:

- **Journaling and receipt:** none, deliberately. The write changes no
  product state, content, or authority — only which items a surface renders
  as new, the same class as the unjournaled Chat attention acknowledgement.
  Remote advances still ride the signed envelope with a grant-scoped signed
  request id.
- **Revocation and undo:** a marker hides nothing — **Show earlier**
  reveals the bounded tail regardless — so there is nothing to undo.
  Revoking a browser deletes its `remote:<grantId>` marker with the rest of
  that grant's state.
- **Failure mid-act:** the store is a single atomic small-file write. A
  failed write leaves the old marker; the failure direction is
  over-reporting, never under-reporting.
- **Replay:** advance is monotonic (cursor comparison by timestamp then
  id), so a replayed or reordered advance is a no-op; remote advances
  additionally inherit the signed-request-id replay refusal.

## Surfaces

No current in-app surface renders the digest; `work-fold agent overview --json`
and the work-fold agent's narration read it on request. The `main-window` marker stays an
accepted id, and older paired clients retain their grant-scoped marker through
the compatible host operations. No surface receives push: the digest is pulled
on request and never recomputed in the background for nobody.

**Not the popover.** The compact menu-bar surface is reserved for the live
conversation and capture. It has no **What's new**
footer, does not request `GET /api/work-fold-agent/overview`, and never advances an
overview marker. Removing that presentation does not remove or clear any
recorded state.

**The paired web client.** Questions now live inside their owning Chat, with an
answer indicator in the saved-chat list. There is no Needs you destination or
receipt feed. The current client neither requests nor acknowledges the overview.
The signed `management.glance`/`management.glanceSeen` host operations remain
compatible with older paired clients, with their existing 64 KB bound and
per-grant marker isolation. Viewers never receive the overview.

**Not the main window.** The compact "Since you last looked" panel that hung off
the work-folder header was removed (2026-09-23). The main window neither requests nor
acknowledges the overview; the server routes and the seen-marker store remain.
The unmounted popover `OverviewSection` renderer was deleted on 2026-10-10.

## Narration on demand

The work-fold agent can say the overview out loud, grounded in the same digest, never in
ambient re-inspection. `work-fold agent overview --json` returns the digest
through the act lane (scoped to the work-fold agent, no `--work-folder`, journal-first
receipted like every act command; it mutates nothing, and it is act-lane
rather than read-lane because the digest is content-bearing — the same
split `chat status` follows). The work-fold agent's instructions teach it to
run the command when asked what is happening, narrate from its fields, and never
present a truncated section as complete — the `truncated` flags are part of
the answer. Narration is interactive only, inside a work-fold agent chat,
whose transcript is machine-local; the product never starts narration on its
own — only a person's message or an Automation's declared `agent` step starts
a work-fold agent turn — and there is no scheduled digest, wrap-up, or morning
summary. Narration never advances a marker; the
digest's `seen` table lets the work-fold agent say "since you last looked at the
popover" honestly, but only a person viewing a surface marks seen.

## Non-goals, in the Checks epistemic style

1. **No model composes the digest.** Composition is app code over typed
   records; a model touches the overview only when a person asks the work-fold agent to
   narrate it, and that narration adds no facts to it.
2. **No file is opened to build it.** The overview reads recorded state and
   never scans, stats, hashes, or reads work-folder files. If the digest cannot
   know something without opening a file, the digest does not know it.
3. **Nothing ambient.** No watcher, no schedule, no background
   recomputation. The digest exists while a surface is asking for it and is
   garbage the moment it is rendered.
4. **Unconfigured means unknown.** A work-folder without Checks is absent from
   the Checks section, not clear. An empty digest means nothing is
   recorded, not that nothing happened. A source that cannot be read is
   reported as unavailable in that section, never rendered as quiet.
5. **The overview is not a store.** No durable activity feed, no event log of
   its own, no retention policy. The one persisted record is the
   seen-marker file, and it is disposable preference.
6. **The overview is not protocol v1.** The read lane stays content-free. The
   snapshot ships at experimental version 0 like the Checks snapshot;
   promotion into the stable kernel and installed-CLI contracts is a later
   deliberate version decision.
7. **The overview does not notify.** No OS notifications, no badge counts, no
   dock or tray numbers. It is where a person looks when they choose to
   look — the same posture as the quiet Check markers, and the reason
   looking at it never destroys information.

## Implementation record

The plan items shipped as follows:

1. Overview types and composer — `src/local/overview.ts`; `tests/work-fold-overview.test.ts` (byte-identical determinism, ordering, caps, truncation, restart honesty, unavailable sources).
2. Seen-marker store — `src/local/overview-seen-store.ts`; `tests/work-fold-overview-seen-store.test.ts`.
3. Kernel query (`getOverview`) with the v1-exclusion guard — `src/local/work-fold-kernel.ts`; `tests/work-fold-kernel.test.ts`.
4. Local API routes (`/api/work-fold-agent/overview`, `/overview/seen`, served without work-fold agent readiness) — `src/local/server.ts`; `tests/work-fold-agent-api.test.ts`, `tests/local-server.test.ts`.
5. CLI act command (`agent overview`) — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/work-fold-cli-act-protocol.test.ts`, `tests/work-fold-cli-commands.test.ts` (read-lane guard).
6. Narration teaching in the work-fold agent's instructions — `src/local/work-fold-agent-instructions.ts`; `tests/work-fold-agent-conversation.test.ts`.
7. Shared renderer — removed; `web-local/src/popover/OverviewSection.tsx` was unmounted on 2026-09-23 and deleted on 2026-10-10, and `tests/work-fold-agent-popover-refresh.test.ts` pins its absence.
8. Remote surface — `src/local/remote-work-fold-agent.ts`, `desktop/src/remote-access.ts`, `services/bridge/`; `tests/desktop-remote-access.test.ts`, `tests/work-fold-agent-remote.test.ts`, the bridge suite.
9. Main-window panel — shipped, then removed on 2026-09-23; `tests/frontend-interaction-contract.test.ts` pins its absence.
10. Documentation promotion — recorded in [Fold integration](archive/fold-integration.md).
11. Receipts-not-gates (2026-09-10, F24) — needs-you reduced to questions and due snoozes, the removed source and its change kind dropped, the remote screen's allow controls removed — `src/local/overview.ts`, `services/bridge/`; `tests/work-fold-overview.test.ts`, the bridge suite.
12. Collaboration contract (2026-09-11, F25/F27/F28) — the request source read from the durable request store, running items folded from the request and the turns it started, one needs-you item per open question the person owns, and settled items covering `partial` and `expired` — `src/local/overview.ts`; `tests/work-fold-overview.test.ts`.

## Deliberately not in this design

- **Scheduled or proactive narration** — no morning summary, no idle-time
  digest turn, no notification that "the work-fold agent has news." Agency on a
  schedule lives in work-folders; above work-folders only declared deterministic glue
  runs unattended, and narration is neither.
- **A viewer-facing overview.** Viewers are read-only strangers to the
  work-fold agent; the overview crosses only to paired browsers under the
  existing full-trust grant.
- **Marker sync across machines.** Markers are machine-local like every
  other acknowledgement preference; a second computer has its own eyes.
- **A durable cross-source event store or subscription API.** Extensions
  and future consumers that need events should get a deliberate contract,
  not a side door through the digest.
- **Filtering, muting, pinning, or per-item preferences.** The digest is
  small enough to read; if the caps prove wrong, change the caps.
- **Overview content inside Worker Chats.** A Worker does not receive
  the cross-work-folder digest; work-folder transcripts are portable and cross-work-folder
  context in them is a leak. The rule from [Automations](automations.md)
  applies to reads as well as work.
- **Model summarization of the digest into the digest.** Narration renders
  facts already present; it never writes back.

## Checks navigation refinement

The popover has no Checks disclosure and does not read or acknowledge the overview. The shared renderer's Check rows offer Review, opening the owning work-folder’s Checks tab. No sensor or model turn starts from a digest. Trial runs are excluded from settled Check changes and live status.
