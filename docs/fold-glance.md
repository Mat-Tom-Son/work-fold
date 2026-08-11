# The glance — the fold's deterministic digest

**Status: proposal.** Nothing in this document is implemented or decided.
[Product model](product-model.md) and [work-fold management layer](management-layer.md)
remain the decision registers; when this ships, decisions are promoted there
and this document shrinks. Amendments to canonical documents are staged in
[Fold integration](fold-integration.md), not applied here.

This is one of the fold design documents. [The fold](fold.md) defines the
surface and its name; [the act ledger](fold-act-ledger.md) defines receipted
direct verbs; [consecrations](fold-consecrations.md) defines staged acts and
pending decisions; [routings](fold-routings.md) defines declared cross-Space
glue; [publishing](fold-publishing.md) defines the viewer ladder.

## What the glance is

The glance is a small digest a person reads in a few seconds: what is running
right now, what is waiting on them, what changed since they last looked, and
where Checks stand. It is composed by app code from state the product already
records — kernel task records, transcripts, History checkpoints, Check status,
receipts — and by nothing else. No model call composes it, no file is opened
to build it, and nothing watches in the background to feed it.

The glance is a projection, not a store. Every item in it points back at a
durable or task-scoped record that already exists for its own reasons; the
digest can always be recomputed and is never itself the authority for
anything. The only state this design adds is a per-surface last-seen marker,
which is machine-local presentation preference in the same class as the
existing Chat attention marker described in [Product model](product-model.md).

## What the product already records

The glance may read exactly these sources. Each row names the owning module,
whether the record survives an app restart, and what the digest takes from it.

| Source | Module | Durability | The glance reads |
|---|---|---|---|
| Running task registry | `WorkFoldKernel` in `src/local/work-fold-kernel.ts` | In-memory, app run | Running `assistant_turn` and `compaction` tasks (stable v1) plus experimental `check_run` tasks, with Space id, actor, `startedAt` |
| Settled turn outcomes | `SettledTurnRecord` in `src/local/server.ts` | In-memory, app run | Task-scoped `succeeded`/`failed`/`aborted` results with `endedAt` |
| Management requests | `ManagementRequestRegistry` in `src/local/management-requests.ts`; phase computed in `src/local/server.ts` (`WorkFoldActManagementRequestPhase` from `src/local/cli/act-facade.ts`) | In-memory, bounded to 100 records | Requests in `working`/`handed_off` (running), `needs_you` (waiting on the person), and settled phases |
| Chat lifecycle and titles | `src/local/agent/chat-store.ts` | Durable — append-only portable transcripts under `.work-fold/conversations/`, with a rebuildable machine-local summary index | `conversation_lifecycle` events (archive, restore, snooze, snooze cleared), title changes, `snoozedUntil` due times, and the newest assistant `landing.followUpPrompt` |
| History checkpoints | `listSpaceCheckpoints` in `src/local/history.ts`, stored under `spaceHistoryRoot` (`src/local/state-paths.ts`) | Durable machine-local app state | `checkpointId`, `createdAt`, `label`, `reason`, `scope` |
| Check status | `WorkFoldCheckService.status()` in `src/local/checks/check-service.ts` producing `WorkFoldCheckStatusSnapshot` (`src/local/checks/check-types.ts`) | Durable machine-local Check state | Per-Space aggregate state and counts; status computation never executes a sensor and never reads file content |
| Act receipts | `WorkFoldCliActReceipts` journal (`src/local/cli/act-receipts.ts`), `cli/receipts/act.jsonl` | Durable, rotation-bounded | Terminal `ok`/`error` records: command name, Space id, outcome, checkpoint id, parent task id |
| Automation run receipts | `RestrictedAppAutomationRunReceipt` in `src/local/agent/restricted-app-service.ts`; scheduler `src/local/agent/work-fold-automation-service.ts` | Durable registry state | Named job, App Instance, outcome, timestamps |
| Automation scheduler state | `WorkFoldAutomationService` in `src/local/agent/work-fold-automation-service.ts` | In-memory, app run | Active and pending named jobs, feeding "Running now"'s `automation-run` items |
| Staged acts and pending decisions | As designed in [the act ledger](fold-act-ledger.md) and [consecrations](fold-consecrations.md) | Durable, per those designs | Pending decisions with category, staging surface, and expiry; recorded approvals and denials |
| Routing runs | As designed in [routings](fold-routings.md) | Durable, per that design | Running and settled routing runs with per-hop outcomes |
| Viewer grants | As designed in [publishing](fold-publishing.md) | Durable, per that design | Grant created/revoked events |

That table is closed. Adding a source to the glance means adding a row here
first, and the row must name a record the product keeps for its own sake. The
glance never causes a record to exist.

Durability is disclosed, not papered over. Settled turn outcomes and
management request projections live for the app run only — the same honesty
the popover already practices ("That request belonged to an earlier app run").
After a restart, the digest recomputes from durable records and simply
contains less; it never fabricates continuity it cannot re-derive.

## The digest

One snapshot shape, composed on request:

```ts
export const workFoldGlanceExperimentalSnapshotVersion = 0 as const;

interface WorkFoldGlanceSnapshot {
  kind: "work-fold.glance.experimental";
  version: typeof workFoldGlanceExperimentalSnapshotVersion;
  composedAt: string;             // the single clock reading used everywhere
  cursor: string;                 // "<at>/<id>" of the newest change item
  running: WorkFoldGlanceItem[];
  needsYou: WorkFoldGlanceItem[];
  changes: WorkFoldGlanceItem[];  // "Since you last looked"
  checks: WorkFoldGlanceCheckRow[];
  seen: Record<string, string>;   // surfaceId -> cursor, from the marker store
  truncated: { running: boolean; needsYou: boolean; changes: boolean; checks: boolean };
}

interface WorkFoldGlanceItem {
  id: string;                     // stable "<source>:<recordId>" dedupe identity
  at: string;                     // ISO time of the underlying record
  kind: WorkFoldGlanceItemKind;   // closed union, listed per section below
  spaceId?: string;
  spaceName?: string;             // resolved at composition; a receipt naming an
                                  // unregistered Space renders the id plus "(removed)"
  headline: string;               // deterministic template over typed fields, ≤ 200 chars
  ref?: {                         // enough to open the underlying record, nothing more
    taskId?: string; conversationId?: string; checkpointId?: string;
    requestId?: string; decisionId?: string; routingId?: string; runId?: string;
  };
}

interface WorkFoldGlanceCheckRow {
  spaceId: string;
  spaceName: string;
  state: WorkFoldCheckAggregateState;   // from src/local/checks/check-types.ts
  needsAttention: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  lastRunAt: string | null;
}
```

Composition is deterministic: the same recorded state and the same
`composedAt` clock reading produce a byte-identical digest. Headlines are
fixed templates over typed record fields (recorded titles, labels, names,
outcomes) — never model output, never file content, never free re-wording.
The clock is read once per composition and used for every due-snooze and
expiry comparison.

### Running now

Everything the product knows is executing at this moment:

- `assistant-turn` and `compaction` from the kernel task registry, including
  delegated children of management requests.
- `management-request` for requests in `working` or `handed_off` phase — one
  item per request, so a request and its child turns are not double-counted;
  a child turn appearing under a running request is folded into that item's
  headline count instead of listed twice.
- `check-run` from the experimental kernel task kind.
- `automation-run` for restricted-app jobs the scheduler is executing.
- `routing-run` for routing runs in flight, per [routings](fold-routings.md).

Ordered by `startedAt` ascending (longest-running first), tie-broken by id.
Cap: 16 items; overflow sets `truncated.running` and drops the newest, never
the oldest — a long-running turn must not be hidden by churn.

### Needs you

Only things that are structurally waiting on the person:

- `pending-decision` — every staged consecration awaiting its click, per
  [consecrations](fold-consecrations.md), with category and `expiresAt`.
  Expiry is not approval; an expired staging leaves this list by becoming a
  recorded expiry in **Since you last looked**.
- `request-question` — management requests in `needs_you` phase (the reply's
  final line asks a question).
- `chat-question` — a Space Chat whose newest transcript message is an
  assistant message carrying a recorded `landing.followUpPrompt`, while the
  Chat is Active and not running. The item clears when the person replies
  (the message is no longer newest), never merely because it was looked at.
- `due-snooze` — an unarchived Chat whose recorded `snoozedUntil` is at or
  before `composedAt`.

Ordered: pending decisions first by soonest `expiresAt`, then everything else
newest-first. Cap: 16 items; overflow sets `truncated.needsYou` and keeps
pending decisions over everything else — an authority decision outranks a
conversational question.

A needs-you item never disappears because it was seen. The last-seen marker
may render older items quieter; only answering, deciding, expiry, or
revocation removes them.

### Since you last looked

Settled and recorded changes, newest first, from these kinds:

| Kind | Underlying record |
|---|---|
| `checkpoint-saved` | A History checkpoint (label, reason, scope) |
| `turn-settled` | A settled turn outcome (in-memory; absent after restart) |
| `request-settled` | A management request reaching `done`/`failed`/`stopped` (in-memory) |
| `chat-lifecycle` | An appended lifecycle event: archived, restored, snoozed, snooze cleared |
| `chat-renamed` | An appended manual or generated title event |
| `check-run-settled` | A Check run record reaching a terminal state, with the aggregate state it produced |
| `act-performed` | A terminal act receipt: command, Space, outcome, checkpoint id when one was taken |
| `decision-recorded` | A consecration approval, denial, or expiry, per [consecrations](fold-consecrations.md) |
| `automation-run-settled` | A durable automation run receipt |
| `routing-run-settled` | A routing-run receipt, per [routings](fold-routings.md) |
| `viewer-grant-changed` | A viewer grant created or revoked, per [publishing](fold-publishing.md) |

The section is bounded twice: at most 12 items per kind and at most 48 items
total, newest first after the per-kind cut; overflow sets
`truncated.changes`. Bounds are disclosure, not curation — when the digest
cannot show everything, it says so instead of pretending completeness.

The `cursor` identifies the newest change item as `"<at>/<id>"`, compared as
the pair (timestamp, then id). Surfaces render items newer than their own
marker as new and older items quieter; a **Show earlier** affordance reveals
the bounded tail regardless of the marker, so marking seen loses nothing.

### Checks

One row per registered Space that has configured Checks, projected from the
same aggregate snapshot as `checks status`: state, counts, `lastRunAt`.
Ordered `needs-attention`, `check-error`, `blocked`, `stale`,
`current-clear`, then by Space name. Cap: 32 rows with `truncated.checks`.

The epistemic rules of the [Checks register](checks.md) apply unchanged: a
Space with no configured Checks does not appear and is not implied healthy —
unconfigured means unknown; `neverRun` and `stale` stay distinct; a blocked
or erroring Check is health, never a content claim; and composing this
section never runs a sensor, provider, or model, and never reads file
content. The glance shows aggregate rows only — finding titles, paths, and
evidence stay in the Space's Checks work tab where they already live.

## Last-seen markers

One machine-local record in work-fold application state (a `glance-seen.json`
beside the other app-state files under `workFoldStateRoot()`):

```ts
interface WorkFoldGlanceSeenState {
  version: 1;
  surfaces: Record<string, { seenThrough: string; updatedAt: string }>;
}
```

Surface ids: `popover`, `main-window`, and `remote:<grantId>` — one marker
per approved browser grant, so two phones do not clear each other. Markers
are presentation preference in exactly the sense the product model already
defines for Chat attention state: machine-local, disposable, never portable
conversation content, and never authority over anything.

A marker advances only when a person viewing a surface acknowledges the
digest — the surface reports the digest's `cursor` after it has actually
rendered. Fetching the digest never advances a marker, and the fold narrating
the glance never advances one either.

Marker advance is the only mutation this design introduces, and it answers
the standard questions:

- **Journaling and receipt:** none, deliberately. The write changes no
  product state, content, or authority — only which items a surface renders
  as new. It is the same class as the existing Chat attention
  acknowledgement, which is likewise unjournaled app preference. Remote
  advances still ride the signed envelope with a grant-scoped signed request
  id, so the bridge records only the bounded operation metadata it records
  for every operation.
- **Revocation and undo:** a marker hides nothing — **Show earlier** reveals
  the bounded tail regardless — so there is nothing to undo. Revoking a
  browser deletes its `remote:<grantId>` marker along with the rest of that
  grant's state; per [consecrations](fold-consecrations.md), revocation also
  cancels that browser's pending decisions, which then leave **Needs you**
  honestly.
- **Failure mid-act:** the store is a single atomic small-file write
  (write-temp-then-rename, like the conversation index). A failed write
  leaves the old marker; the only consequence is items staying highlighted —
  the failure direction is over-reporting, never under-reporting.
- **Replay:** advance is monotonic. The store refuses to move a marker
  backward (cursor comparison by timestamp then id), so a replayed or
  reordered advance is a no-op. Remote advances additionally inherit the
  existing signed-request-id replay refusal.

## Surfaces

Three human surfaces read the digest; each owns one marker.

**The popover top.** The menu-bar/tray popover renders the glance above the
composer: **Needs you** first, then **Running now**, then a compact
**Since you last looked**, then the Checks rows. It fetches
`GET /api/management/glance` through its existing local-API session on the
refresh cadence it already uses for the request summary, and posts the
rendered cursor to `POST /api/management/glance/seen` with surface id
`popover`. The digest does not require the management Pi session or the
materialized management instructions — it is app-composed — so the glance
stays available even when management commands fail closed; only narration
needs the conversation.

**The remote client home.** The approved-browser client shows the same
digest on its home screen, above the saved-Chat list. Content crosses only
inside the existing signed application-encrypted envelopes: a new
`management.glance` operation returns the digest and a `management.glanceSeen`
operation advances that grant's marker, both added to
`WorkFoldRemoteOperation` (`src/local/remote-management.ts`), the facade in
`src/local/server.ts`, the desktop dispatch in `desktop/src/remote-access.ts`,
and the bridge's operation allowlist in `services/bridge/server.mjs`. The
bridge relays ciphertext and persists no digest content, exactly as it
persists no transcript content today. The remote projection carries only the
requesting grant's own marker in `seen`, matching the existing cross-grant
hygiene of the direct adapter, and the serialized digest is bounded to
64 KB so it fits the existing per-operation and queued-byte budgets. Desktop
offline means no digest — the client shows its existing honest offline state
rather than a stale digest presented as current. Viewers, as defined in
[publishing](fold-publishing.md), never receive the glance: rung 1 of that
ladder is deliberately the approved-browser trust and nothing weaker.

**The main window.** The same digest is available to the main renderer from
the same local-API route, presented as a compact panel reachable from the
persistent Space-identity header region — deliberately not a new rail
destination, badge, or permanent navigation item, per the stable information
architecture. It refreshes when work-fold regains focus or visibility, the
same trigger Checks already use, and acknowledges with surface id
`main-window`.

No surface receives push for the glance. The popover's existing
per-conversation event stream is unchanged; the digest is pulled when a
surface is visible and never recomputed in the background for nobody.

## Narration on demand

The fold can say the glance out loud — "what's happening?" in the popover,
the remote client, or `work-fold manage send` — and the answer is grounded in
the same digest, never in ambient re-inspection:

- A new act-lane command, `work-fold manage glance --json`, returns the
  digest. It follows the manage-group pattern (management-scoped, no
  `--space`) and, like every act command, is per-launch-token authenticated
  and journal-first receipted by the shared executor in
  `src/local/cli/act-commands.ts`: an `accepted` record before it runs, a
  terminal record after, duplicate request ids refused. It mutates nothing —
  the receipt exists because every act-lane command leaves one, and because
  the digest is content-bearing it belongs in the act lane, not content-free
  protocol v1, the same split `chat status` and `chats list` already follow.
- The management instructions (`src/local/management-instructions.ts`) gain
  a short section teaching the fold to run that command when asked what is
  happening, narrate from its fields, and never present a truncated section
  as complete — the `truncated` flags are part of the answer.
- Narration is interactive only. It happens inside the management
  conversation, whose transcript is machine-local — which is precisely why
  cross-Space narration may live there and must never run inside a Space
  Chat, whose transcript travels with the folder. [Routings](fold-routings.md)
  steps are deterministic and cannot invoke narration or any model turn above
  Spaces; there is no scheduled digest, wrap-up, or morning summary.
- Narration never advances a marker. The digest's `seen` table tells the fold
  what each surface has acknowledged, so it can say "since you last looked at
  the popover" honestly, but only a person viewing a surface marks seen.

## Non-goals, in the Checks epistemic style

1. **No model composes the digest.** Composition is app code over typed
   records; a model touches the glance only when a person asks the fold to
   narrate it, and that narration adds no facts to it.
2. **No file is opened to build it.** The glance reads recorded state —
   registries, journals, transcripts' already-parsed summaries, Check status
   snapshots — and never scans, stats, hashes, or reads Space files. If the
   digest cannot know something without opening a file, the digest does not
   know it.
3. **Nothing ambient.** No watcher, no schedule, no background recomputation.
   The digest exists while a surface is asking for it and is garbage the
   moment it is rendered.
4. **Unconfigured means unknown.** A Space without Checks is absent from the
   Checks section, not clear. An empty digest means nothing is recorded, not
   that nothing happened. A source that cannot be read (a damaged journal, an
   unavailable store) is reported as unavailable in that section, never
   rendered as quiet.
5. **The glance is not a store.** No durable activity feed, no event log of
   its own, no retention policy to design. The one persisted record is the
   seen-marker file, and it is disposable preference.
6. **The glance is not protocol v1.** The read lane stays content-free. The
   snapshot ships at experimental version 0 like the Checks snapshot;
   promotion into the stable kernel and installed-CLI contracts is a later
   deliberate version decision.
7. **The glance does not notify.** No OS notifications, no badge counts, no
   dock or tray numbers. It is where a person looks when they choose to look
   — the same posture as the quiet Check markers, and the reason looking at
   it never destroys information.

## Deliberately not in this design

- **Scheduled or proactive narration** — no morning summary, no idle-time
  digest turn, no notification that "the fold has news." Agency on a
  schedule lives in Spaces; above Spaces only declared deterministic glue
  runs unattended, and narration is neither.
- **A viewer-facing glance.** Viewers are read-only strangers to the
  management lane; the glance crosses only to approved browsers under the
  existing full-trust grant. See [publishing](fold-publishing.md).
- **Marker sync across machines.** Markers are machine-local like every
  other acknowledgement preference; a second computer has its own eyes.
- **A durable cross-source event store or subscription API.** Extensions and
  future consumers that need events should get a deliberate contract, not a
  side door through the digest.
- **Filtering, muting, pinning, or per-item preferences.** The digest is
  small enough to read; preference machinery would grow a settings surface
  this layer does not need. If the caps prove wrong, change the caps.
- **Glance content inside Space Chats.** A Space Assistant does not receive
  the cross-Space digest; Space transcripts are portable and cross-Space
  context in them is a leak. The rule from [routings](fold-routings.md)
  applies to reads as well as work.
- **Model summarization of the digest into the digest.** Narration renders
  facts already present; it never writes back.

## Implementation plan

Dependency-ordered work items. Verification for every step:
`npm run check`, then the named suites through `npm test`.

1. **Glance types and composer.** New `src/local/glance.ts`: the snapshot
   and item types above, the closed source-reader interface (one typed
   method per inventory row), deterministic templates, ordering, caps, and
   cursor computation as pure functions over injected readers plus one clock
   value. Sources that exist today (kernel tasks, settled turns, management
   requests, chat summaries and lifecycle, checkpoints, Check status, act
   receipts, automation receipts) are wired first; the staged-act, routing,
   and viewer-grant readers are typed now and wired when the
   [act ledger](fold-act-ledger.md), [routings](fold-routings.md), and
   [publishing](fold-publishing.md) stores land — an absent reader renders
   its kinds as absent, never as empty-and-clear. New
   `tests/work-fold-glance.test.ts`: determinism (same inputs, same bytes),
   every ordering and cap rule, truncation flags, restart honesty (in-memory
   sources absent), removed-Space naming, and the unavailable-source state.
2. **Seen-marker store.** New `src/local/glance-seen-store.ts`: atomic
   write-temp-then-rename persistence, monotonic advance with cursor
   comparison, per-grant removal for revocation. New
   `tests/work-fold-glance-seen-store.test.ts`: monotonicity, replayed and
   backward advances as no-ops, damaged-file recovery (a malformed store
   resets markers, which only over-reports), and grant purge.
3. **Kernel query.** `src/local/work-fold-kernel.ts` gains
   `getGlance(actor)` returning the experimental snapshot, with the source
   readers injected through `WorkFoldKernelOptions` exactly as `listSpaces`
   and `loadCapabilityCatalog` are today. The kernel stays read-only: it
   never writes markers. The experimental kind stays out of stable
   `work-fold.tasks`/protocol-v1 projections, following the `check_run`
   precedent. Extend `tests/work-fold-kernel.test.ts` for the query, actor
   normalization, and the v1-exclusion guard.
4. **Local API routes and wiring.** `src/local/server.ts`: construct the
   readers over the live registries (kernel tasks, `SettledTurnRecord`s,
   `ManagementRequestRegistry`, chat store per registered Space,
   `listSpaceCheckpoints`, `WorkFoldCheckService.status`, the act-receipts
   journal, the restricted-app automation registry); add
   `GET /api/management/glance` and `POST /api/management/glance/seen`
   (surface id validated against the closed set) on the renderer session
   token. The glance routes do not require management readiness. Extend
   `tests/work-fold-management-api.test.ts` and `tests/local-server.test.ts`
   for both routes, marker monotonicity through the API, and the
   management-not-ready case still serving the digest.
5. **CLI act command.** `src/local/cli/act-commands.ts` parses
   `manage glance`; `src/local/cli/act-facade.ts` exposes the facade method;
   the shared executor's journal-first path covers it with no special
   casing. Extend `tests/work-fold-cli-act-protocol.test.ts`,
   `tests/work-fold-act-facade.test.ts`, and
   `tests/desktop-work-fold-cli-host.test.ts` for parsing, JSON projection,
   receipts, duplicate-id refusal, and the app-not-running failure.
6. **Management instructions.** `src/local/management-instructions.ts` adds
   the narration section: run `manage glance` when asked what is happening,
   narrate truncation honestly, never mark seen. Extend
   `tests/work-fold-management-conversation.test.ts` and
   `tests/management-turn-context.test.ts` for the materialized text.
7. **Popover surface.** New `web-local/src/popover/GlanceSection.tsx`
   rendered at the top of `web-local/src/popover/PopoverApp.tsx`, reusing
   the existing `web-local/src/lib/api.ts` client and refresh cadence;
   acknowledgement posts the rendered cursor. Extend
   `tests/management-popover-refresh.test.ts` (fetch/acknowledge sequencing
   — no acknowledge before render) and `tests/web-ui-contract.test.ts`
   (section order, quiet-not-hidden seen items, Show earlier).
8. **Remote surface.** Add `management.glance` and `management.glanceSeen`
   to `WorkFoldRemoteOperation` in `src/local/remote-management.ts`, the
   facade switch in `src/local/server.ts`, desktop dispatch in
   `desktop/src/remote-access.ts` with the 64 KB projection bound, the
   allowlist in `services/bridge/server.mjs`, and home rendering in
   `services/bridge/public/app.js`/`rendering.js`. Revocation paths delete
   the grant's marker. Extend `tests/desktop-remote-access.test.ts`
   (per-grant markers, revocation purge, bound enforcement, offline
   behavior) and the bridge suite `services/bridge/server.test.mjs`
   (allowlist only — the bridge stays content-blind).
9. **Main-window surface.** A compact panel component under
   `web-local/src/components/chrome/` reachable from the Space-identity
   header region of `web-local/src/App.tsx`, refreshing on focus/visibility,
   acknowledging as `main-window`. Extend `tests/web-ui-contract.test.ts`
   and `tests/frontend-interaction-contract.test.ts`; confirm no new rail
   destination appears.
10. **Documentation promotion.** On shipping, promote the digest and marker
    decisions into [Product model](product-model.md) and
    [work-fold management layer](management-layer.md) through the staged
    amendments in [Fold integration](fold-integration.md), update README
    surface claims, and shrink this document. `tests/documentation-contract.test.ts`
    guards the claims.
