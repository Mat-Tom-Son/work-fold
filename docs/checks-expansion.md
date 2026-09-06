# Checks expansion: current boundary and remaining ideas

**Status: partially superseded proposal, updated September 6, 2026.**
[Checks](checks.md) is the current decision register. The earlier phased plan
predated text review, folder triggers, trials, and reviewed corrections. Its
original text remains in Git history; its proposed sequencing is not a gate on
features that have since shipped.

## What shipped

- Deterministic file-presence Checks and bounded model-backed text review.
- Runner-opened UTF-8 snapshots, content digests, exact unique quotations, and
  primary/reference freshness checks. Status may re-read designated text
  locally, but never invokes a model or returns content through the read lane.
- The fold's configured model, with a closed submission schema, one terminating
  submission operation, explicit byte/time/output bounds, and no general tools
  or automatic retry. A Check does not pin a separate model at enablement.
- Fold-led proposals, one-time trials isolated from live results, explicit
  enablement, and compact Space-owned findings and health views.
- Space Assistant help, inert single-file corrections, Before/After review,
  exact-byte History, and a separate recheck after application.
- Separately enabled Routings that run Checks on schedules, settled events,
  or explicitly designated folder changes. Routing-caused settles do not
  trigger other Routings; a successful run with findings is not a blocking gate.

The original proposal's metadata-only content freshness, validation retries,
separate fast-model binding, and prohibition on all folder triggers were not
adopted. A reviewed `criteria` rubric is allowed; arbitrary executable
expressions, model names, credentials, and tool instructions are not.

## Invariants for any next layer

Sensors propose; the runner admits. Quote verification proves that the cited
text exists, not that the model's judgment is correct. Invalid or partial
submissions remain Check health errors, never a clear result. Exact declaration
and sensor authority, bounded target ownership, input freshness, and explicit
provider use must survive every extension.

Checks remain Space-owned. Cross-Space coordination belongs to the fold and
Routings; a reference file is explicitly copied into the reviewing Space.
Neither a new sensor nor a reusable rubric grants run authority by itself.

## Still proposed

| Direction | Useful outcome | Decision and evidence needed before implementation |
|---|---|---|
| More deterministic content Checks | Non-empty files, required headings, or structured field comparisons without a model request | Versioned observation/evidence contracts and fresh-input admission for each sensor |
| Reusable reviewed rubrics | Reapply a useful expectation to another Space | Explicit target binding and fresh trial/enablement; no portable grants or findings |
| Check-based handoff conditions | Pause delivery while current findings need review | Distinguish clear, acknowledged, stale, blocked, and error; recheck inputs at the handoff and preserve pause/resume receipts |
| Bounded document extraction | Review PDF or Word content through the same UI | Page/paragraph provenance, exact source digests, extraction limits, and a review path that never applies a text replacement to binary source bytes |
| Additional sensor distribution | Install a reviewed sensor without a new desktop release | Explicit executable authority and source-digest review; no declaration-supplied code |

Domain packs, proactive notifications, cache replay, hosted execution, and
cross-Space Checks remain uncommitted ideas. They must not enter the current
contract merely because this document lists them.
