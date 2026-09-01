# Routings expansion: shipped Phase 1 and 2

**Status: implemented on 2026-09-01.** This record describes the first
Routings expansion as it shipped: the desktop Settings surface and the
bounded one-time trigger. [Routings](fold-routings.md) and
[the fold](fold.md) are canonical. Daily schedules, app-event triggers, a
visual builder, remote management, and running while work-fold is quit are
not implemented.

## Outcome

Routings remain the one machine-local form of unattended behavior above
Spaces: a typed trigger runs deterministic app-owned steps, and any model
work begins as a fresh Chat in one named Space under that Space's own
Assistant configuration. This expansion added no job-system noun, open
trigger registry, suspended model turn, or second executor.

The shipped slice closes two concrete gaps:

- Settings now gives a person a direct place to inspect and manage the
  routings already owned by the fold.
- A version-2 proposal can schedule one future occurrence without keeping a
  model turn alive.

## Invariants retained

1. **Agency on a schedule lives in Spaces.** The fold is never a routing
   target. A Chat step carries only its reviewed fixed message into one
   Space's new portable transcript.
2. **Enablement remains a staged decision.** Reviewed waits for a person;
   Unrestricted lets the host consume a fresh admission. A standing policy
   cannot approve `routing.enable`.
3. **Declarations are closed, inert data.** Unknown versions, trigger kinds,
   and fields fail closed. Proposal creation arms nothing.
4. **Scheduled runs keep the existing receipt discipline.** A run is
   accepted first, its schedule occurrence is claimed durably before hop 1,
   and each hop records accepted and terminal evidence.
5. **Nothing runs while work-fold is quit.** Launch and wake reconcile a
   missed one-time slot using its declared policy; they do not pretend the
   app remained awake.
6. **Run now is never a schedule mutation.** It runs a copy and leaves the
   declared slot unchanged.

## Phase 1 — Settings → The fold → Routings

The desktop Settings modal includes a **Routings** subtab alongside Web
access, Shared pages, and Authority. Its data and mutations use an
in-process, main-window-only preload bridge into the same routing service as
the CLI. There is no localhost Settings API for this surface, and the menu
bar popover does not receive this bridge.

The surface provides:

- a compact list with title, trigger, health, next scheduled time when one
  exists, and last-run state;
- a selected-routing review showing its schedule, destinations, fixed
  ordered steps, and bounded recent run evidence;
- **Ask to turn on**, which stages the exact stored declaration for a fresh
  enablement decision;
- **Run a copy now**;
- **Stop** while a run is active, **Turn off** when enabled, and **Delete**
  when the record is inert and disabled, suspended, or completed; and
- one restrained empty state: “No routings yet. Ask the fold to set one up.”

There is no visual builder and no bulk **Clear all** action. Completed
one-time routings remain individually visible and individually deletable.
Their receipts remain after deletion.

## Phase 2 — one-time `at`

A one-time proposal uses contract version 2 and this exact trigger shape:

```json
{
  "kind": "at",
  "at": "2026-09-01T21:00:00-04:00",
  "ifMissed": "run"
}
```

- `at` is an ISO timestamp with an explicit UTC offset and is normalized to
  one UTC instant.
- `ifMissed` is required and must be `run` or `skip`; there is no implicit
  default.
- Enablement rechecks that the instant is at least 1 minute and no more than
  366 days ahead. Stable parsing validates shape; the time-sensitive horizon
  is checked again when authority would be admitted.
- `run` admits one bounded catch-up for the exact missed slot after launch or
  wake. `skip` records that the occurrence did not run.

Version 1 remains valid for manual, interval, and admitted on-settled
triggers. Version 2 adds only `at`; it does not admit daily, weekday,
calendar, or app-event triggers.

### Durable single-fire claim

For the scheduled or resumed occurrence, the executor follows this order:

1. append the run's strict `accepted` receipt;
2. atomically commit
   `{occurrenceId, slotAt, consumedAt, runId}` and move the routing to
   `completed`;
3. begin hop 1; and
4. add `finishedAt` after the run reaches a terminal outcome.

The pre-hop durable claim is the at-most-once gate. A crash after acceptance
but before the claim is reconciled at startup into that same deterministic
occurrence and recorded `interrupted`; a crash after the claim cannot re-arm
the routing. Success, failure, Stop, and interruption all leave the slot
consumed.

When a past slot uses `ifMissed: "skip"`, startup makes the same durable
claim, writes a run outcome of `skipped`, and then writes the routing
lifecycle outcome `completed`. No hop runs. The product does not use a
separate `lapsed` health or lifecycle state.

### Run-now and retention

Running an enabled one-time routing manually creates an independent copy.
It does not consume, advance, or replace the future slot. Once the scheduled
or resumed slot is claimed, `completed` health refuses another run-now; a
repeat is a new proposal and staged enablement.

Completed records count toward the 32-routing machine bound until they are
deleted. They do not auto-prune, and Settings offers Delete per record only.

## Reminders and deferred work

The fold is taught to distinguish two requests:

- A **pure reminder** performs no future Assistant work. The relevant
  existing Chat is snoozed with `chat snooze --until`, then resurfaces as a
  due item.
- **Deferred work** becomes a version-2 `at` proposal whose Chat step has a
  fixed, self-contained message for one relevant Space. The fold resolves an
  unambiguous absolute time, stages the proposal, reports whether the
  decision is waiting or executed, and finishes the current turn.

The fold never busy-waits, promises to remain awake, leaves a request open,
or schedules itself. Cross-Space judgment either happens in the
machine-local fold conversation while the person is present or is reduced
to reviewed deterministic steps and a Space-scoped future message.

## Contract and compatibility

- The proposal parser accepts contract versions 1 and 2. A v1 proposal keeps
  its original vocabulary; v2 admits the one-time `at` trigger only.
- Routing store schema 2 persists `completed` health and the one-time
  occurrence claim. Schema-1 stores load and rewrite as schema 2 on the next
  mutation; newer stores still fail closed on an older build.
- The shared automation scheduler accepts interval and one-time schedules.
  Its FIFO admission, two-run machine limit, per-routing non-overlap,
  suspension, bounded catch-up, and abort behavior remain shared with the
  existing machinery.
- One-time receipts use the existing run outcomes, including `skipped`, plus
  the routing lifecycle outcome `completed`. Readers do not infer work from
  the health transition; run and hop evidence remain authoritative.

## Bounds

| Bound | Shipped value |
|---|---|
| Routings per machine | 32 |
| Steps per routing | 1–8 |
| Concurrent routing runs | 2, FIFO, machine-wide |
| Interval | 15–1440 minutes |
| One-time horizon at enablement | 1 minute–366 days ahead |
| `ifMissed` | Required: `run` or `skip` |
| Scheduled/resume occurrence | One durable claim ever |
| Completed retention | Until individual Delete; still counts toward 32 |

All other routing bounds remain those in [Routings](fold-routings.md).

## Deliberately not shipped

- daily, weekday, monthly, cron, or RRULE schedules;
- app-event or other new settle families;
- a visual routing builder or bulk Clear all;
- scheduled fold turns or scheduled glance narration;
- suspending and later resuming the current model turn;
- execution while work-fold is quit, a login helper, or hosted execution;
- remote/browser routing management; and
- an open trigger registry, callback source, file watcher, or external
  webhook.

Each would require a separate register decision rather than being implied by
version 2.

## Verification map

The shipped slice is covered by the routing declaration, store, service,
automation scheduler, act-facade, staged-decision, Settings bridge/UI, and
management-conversation suites. The focused instruction test also verifies
that both the fold's main context and its materialized `manage-spaces` Skill
teach the same version-2 and reminder/deferred-work contract.
