# The glance — the fold's deterministic digest

**Status: shipped contract reference.** The glance shipped with the fold
build — `src/local/glance.ts` and `src/local/glance-seen-store.ts` with
their suites are the implementation authority — and its decisions were
promoted on 2026-08-11 into [the fold](fold.md) decision register (F10),
[the management layer](management-layer.md) (the remote-operation paragraph
and verification map), `README.md`, `SECURITY.md`, `PRIVACY.md`, and
[Desktop parity](ui-parity.md)/[the visual system](visual-design.md)
(surface placement). This document retains what canon does not carry: the
closed source inventory, the section and ordering rules, the marker
contract, and the non-goals. The promotion record is
[Fold integration](fold-integration.md).

The glance is a small digest a person reads in a few seconds: what is
running right now, what is waiting on them, what changed since they last
looked, and where Checks stand. It is composed by app code from state the
product already records — and by nothing else. No model call composes it,
no file is opened to build it, and nothing watches in the background to
feed it. The glance is a projection, not a store: every item points back at
a durable or task-scoped record that exists for its own reasons, the digest
can always be recomputed, and it is never itself the authority for
anything. The only state this design added is the per-surface last-seen
marker — machine-local presentation preference in the same class as the
existing Chat attention marker.

## The source inventory

The glance may read exactly these sources. The table is closed: adding a
source means adding a row here first, and the row must name a record the
product keeps for its own sake. The glance never causes a record to exist.

| Source | Module | Durability | The glance reads |
|---|---|---|---|
| Running task registry | `WorkFoldKernel` in `src/local/work-fold-kernel.ts` | In-memory, app run | Running `assistant_turn` and `compaction` tasks (stable v1) plus experimental `check_run` and `routing_run` tasks, with Space id, actor, `startedAt` |
| Settled turn outcomes | `SettledTurnRecord` in `src/local/server.ts` | In-memory, app run | Task-scoped `succeeded`/`failed`/`aborted` results with `endedAt` |
| Management requests | `ManagementRequestRegistry` in `src/local/management-requests.ts` | In-memory, bounded to 100 records | Requests in `working`/`handed_off` (running), `needs_you` (waiting on the person), and settled phases |
| Chat lifecycle and titles | `src/local/agent/chat-store.ts` | Durable — append-only portable transcripts with a rebuildable machine-local summary index | `conversation_lifecycle` events, title changes, `snoozedUntil` due times, and the newest assistant `landing.followUpPrompt` |
| History checkpoints | `listSpaceCheckpoints` in `src/local/history.ts` | Durable machine-local app state | `checkpointId`, `createdAt`, `label`, `reason`, `scope` |
| Check status | `WorkFoldCheckService.status()` in `src/local/checks/check-service.ts` | Durable machine-local Check state | Per-Space aggregate state and counts; status computation never executes a sensor and never reads file content |
| Act receipts | `WorkFoldCliActReceipts` journal (`src/local/cli/act-receipts.ts`) | Durable, rotation-bounded | Terminal `ok`/`error` records: command name, Space id, outcome, checkpoint id, parent task id |
| Automation run receipts | `RestrictedAppAutomationRunReceipt` in `src/local/agent/restricted-app-service.ts` | Durable registry state | Named job, App Instance, outcome, timestamps |
| Automation scheduler state | `WorkFoldAutomationService` | In-memory, app run | Active and pending named jobs, feeding "Running now" |
| Staged acts and pending decisions | `src/local/fold-staged-acts.ts` | Durable | Pending decisions with category, staging surface, and expiry; recorded approvals and denials; policy-store changes |
| Routing runs | `src/local/routings/routing-store.ts` | Durable | Running and settled routing runs with per-hop outcomes |
| Viewer grants | `src/local/publications.ts` | Durable | Publication created/revoked events and page health (not-available, resting) |

Durability is disclosed, not papered over. In-memory sources live for the
app run only; after a restart the digest recomputes from durable records
and simply contains less — it never fabricates continuity it cannot
re-derive.

## The digest

One snapshot shape (`work-fold.glance.experimental`, version 0, in
`src/local/glance.ts`), composed on request. Composition is deterministic:
the same recorded state and the same single `composedAt` clock reading
produce a byte-identical digest. Headlines are fixed templates over typed
record fields — never model output, never file content, never free
re-wording. A receipt naming an unregistered Space renders the id plus
"(removed)". Every section carries a `truncated` flag; bounds are
disclosure, not curation.

**Running now** — everything the product knows is executing: assistant
turns and compactions (a management request and its child turns are folded
into one item, never double-counted), Check runs, automation runs, and
routing runs. Ordered by `startedAt` ascending (longest-running first),
tie-broken by id. Cap 16; overflow drops the newest, never the oldest — a
long-running turn must not be hidden by churn.

**Needs you** — only things structurally waiting on the person:
`pending-decision` (every staged consecration awaiting its click, with
category and expiry), `request-question` (management requests in
`needs_you` phase), `chat-question` (a Space Chat whose newest transcript
message carries a recorded follow-up prompt, while Active and not running;
it clears when the person replies, never merely because it was looked at),
and `due-snooze`. Ordered: pending decisions first by soonest expiry, then
newest-first. Cap 16; overflow keeps pending decisions over everything else
— an authority decision outranks a conversational question. A needs-you
item never disappears because it was seen; only answering, deciding,
expiry, or revocation removes it.

**Since you last looked** — settled and recorded changes, newest first:
`checkpoint-saved`, `turn-settled`, `request-settled`, `chat-lifecycle`,
`chat-renamed`, `check-run-settled`, `act-performed`, `decision-recorded`
(approvals, denials, and expiries — including policy-approved acts, listed
distinctly), `automation-run-settled`, `routing-run-settled`, and
`viewer-grant-changed` (including page health: not-available and resting
reach the person here with the precise reason viewers never see). Bounded
twice: at most 12 items per kind and 48 total. The `cursor` identifies the
newest change item as `"<at>/<id>"`; surfaces render items newer than their
own marker as new and older items quieter, and a **Show earlier**
affordance reveals the bounded tail regardless of the marker, so marking
seen loses nothing.

**Checks** — one row per registered Space with configured Checks, projected
from the same aggregate snapshot as `checks status`: state, counts,
`lastRunAt`. Ordered `needs-attention`, `check-error`, `blocked`, `stale`,
`current-clear`, then by Space name; cap 32. The epistemic rules of the
[Checks register](checks.md) apply unchanged: unconfigured means unknown,
`neverRun` and `stale` stay distinct, a blocked or erroring Check is
health, never a content claim, and composing this section never runs a
sensor or reads file content. Aggregate rows only — finding titles, paths,
and evidence stay in the Space's Checks work tab.

## Last-seen markers

One machine-local record (`glance-seen.json` under the state root,
`src/local/glance-seen-store.ts`) maps surface ids — `popover`,
`main-window`, and `remote:<grantId>`, one marker per approved browser
grant so two phones do not clear each other — to the cursor each surface
has acknowledged. Markers are presentation preference exactly as the
product model defines for Chat attention state: machine-local, disposable,
never portable, never authority. A marker advances only when a person
viewing a surface acknowledges a rendered digest; fetching never advances a
marker, and the fold narrating the glance never advances one either.

Marker advance is the glance's only mutation, and its standard answers:

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

Three human surfaces read the digest; each owns one marker. No surface
receives push: the digest is pulled when a surface is visible and never
recomputed in the background for nobody.

**The popover's What's new strip.** Since the 0.3.1 popover redesign the
glance folds behind a footer strip labeled **What's new (N)** — N counts
unseen change items — and expands to the same section order: **Needs you**,
then **Running now**, then a compact **Since you last looked**, then the
Checks rows, via `GET /api/management/glance` on the existing session and
refresh cadence. Acknowledgement is expansion-gated: opening the strip is
what posts the rendered cursor to `POST /api/management/glance/seen` as
`popover`; a collapsed strip fetches but never marks seen. The digest is
app-composed and does not require the management Pi session, so the glance
stays available even when management commands fail closed; only narration
needs the conversation.

**The remote client's Needs you screen.** The approved-browser client shows
the same digest on its **Needs you** screen, below that screen's pending
decision cards: the digest's needs-you items that are not pending decisions
list there as **From chats**, then **Running now**, **Since you last
looked**, and the Checks rows. The digest arrives through the
`management.glance`/`management.glanceSeen` operations — signed envelopes,
no digest content persisted at the bridge, only the requesting grant's own
marker in the projection, and the serialized digest bounded to 64 KB.
Acknowledgement is screen-gated: the marker advances only while **Needs
you** is the visible screen, under the same rendered-digest rule every
surface follows. Desktop offline means no digest: the client shows its
honest offline state rather than a stale digest presented as current.
Viewers never receive the glance — rung 1 of
[publishing](fold-publishing.md) is deliberately the approved-browser trust
and nothing weaker.

**The main window.** The same digest as a compact panel reachable from the
Space-identity header region — deliberately not a new rail destination,
badge, or permanent navigation item — refreshing on focus/visibility like
Checks, acknowledging as `main-window`.

## Narration on demand

The fold can say the glance out loud, grounded in the same digest, never in
ambient re-inspection. `work-fold manage glance --json` returns the digest
through the act lane (management-scoped, no `--space`, journal-first
receipted like every act command; it mutates nothing, and it is act-lane
rather than read-lane because the digest is content-bearing — the same
split `chat status` follows). The management instructions teach the fold to
run it when asked what is happening, narrate from its fields, and never
present a truncated section as complete — the `truncated` flags are part of
the answer. Narration is interactive only, inside the management
conversation whose transcript is machine-local; routing steps cannot invoke
narration or any model turn above Spaces, and there is no scheduled digest,
wrap-up, or morning summary. Narration never advances a marker; the
digest's `seen` table lets the fold say "since you last looked at the
popover" honestly, but only a person viewing a surface marks seen.

## Non-goals, in the Checks epistemic style

1. **No model composes the digest.** Composition is app code over typed
   records; a model touches the glance only when a person asks the fold to
   narrate it, and that narration adds no facts to it.
2. **No file is opened to build it.** The glance reads recorded state and
   never scans, stats, hashes, or reads Space files. If the digest cannot
   know something without opening a file, the digest does not know it.
3. **Nothing ambient.** No watcher, no schedule, no background
   recomputation. The digest exists while a surface is asking for it and is
   garbage the moment it is rendered.
4. **Unconfigured means unknown.** A Space without Checks is absent from
   the Checks section, not clear. An empty digest means nothing is
   recorded, not that nothing happened. A source that cannot be read is
   reported as unavailable in that section, never rendered as quiet.
5. **The glance is not a store.** No durable activity feed, no event log of
   its own, no retention policy. The one persisted record is the
   seen-marker file, and it is disposable preference.
6. **The glance is not protocol v1.** The read lane stays content-free. The
   snapshot ships at experimental version 0 like the Checks snapshot;
   promotion into the stable kernel and installed-CLI contracts is a later
   deliberate version decision.
7. **The glance does not notify.** No OS notifications, no badge counts, no
   dock or tray numbers. It is where a person looks when they choose to
   look — the same posture as the quiet Check markers, and the reason
   looking at it never destroys information.

## Implementation record

The plan items shipped as follows:

1. Glance types and composer — `src/local/glance.ts`; `tests/work-fold-glance.test.ts` (byte-identical determinism, ordering, caps, truncation, restart honesty, unavailable sources).
2. Seen-marker store — `src/local/glance-seen-store.ts`; `tests/work-fold-glance-seen-store.test.ts`.
3. Kernel query (`getGlance`) with the v1-exclusion guard — `src/local/work-fold-kernel.ts`; `tests/work-fold-kernel.test.ts`.
4. Local API routes (`/api/management/glance`, `/glance/seen`, served without management readiness) — `src/local/server.ts`; `tests/work-fold-management-api.test.ts`, `tests/local-server.test.ts`.
5. CLI act command (`manage glance`) — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/work-fold-cli-act-protocol.test.ts`, `tests/work-fold-cli-commands.test.ts` (read-lane guard).
6. Management-instruction narration teaching — `src/local/management-instructions.ts`; `tests/work-fold-management-conversation.test.ts`.
7. Popover surface — `web-local/src/popover/GlanceSection.tsx`; `tests/management-popover-refresh.test.ts`, `tests/web-ui-contract.test.ts`.
8. Remote surface — `src/local/remote-management.ts`, `desktop/src/remote-access.ts`, `services/bridge/`; `tests/desktop-remote-access.test.ts`, `tests/work-fold-remote-management.test.ts`, the bridge suite.
9. Main-window panel — `web-local/src/components/chrome/GlancePanel.tsx`; `tests/web-ui-contract.test.ts`, `tests/frontend-interaction-contract.test.ts`.
10. Documentation promotion — recorded in [Fold integration](fold-integration.md).

## Deliberately not in this design

- **Scheduled or proactive narration** — no morning summary, no idle-time
  digest turn, no notification that "the fold has news." Agency on a
  schedule lives in Spaces; above Spaces only declared deterministic glue
  runs unattended, and narration is neither.
- **A viewer-facing glance.** Viewers are read-only strangers to the
  management lane; the glance crosses only to approved browsers under the
  existing full-trust grant.
- **Marker sync across machines.** Markers are machine-local like every
  other acknowledgement preference; a second computer has its own eyes.
- **A durable cross-source event store or subscription API.** Extensions
  and future consumers that need events should get a deliberate contract,
  not a side door through the digest.
- **Filtering, muting, pinning, or per-item preferences.** The digest is
  small enough to read; if the caps prove wrong, change the caps.
- **Glance content inside Space Chats.** A Space Assistant does not receive
  the cross-Space digest; Space transcripts are portable and cross-Space
  context in them is a leak. The rule from [routings](fold-routings.md)
  applies to reads as well as work.
- **Model summarization of the digest into the digest.** Narration renders
  facts already present; it never writes back.
