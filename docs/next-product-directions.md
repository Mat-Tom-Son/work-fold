# Proposed next product directions

**Status: ideas for discussion, September 6, 2026.** These are not accepted
requirements or shipped capabilities. The current [product model](product-model.md),
[Checks](checks.md), and [Routings](fold-routings.md) remain authoritative.

The strongest next step is to finish the everyday coordination experience:
people describe an outcome to the fold, Spaces do focused work, and the person
can see what needs attention without learning a workflow language.

## 1. One readable run view

Give each Routing run a compact view of its actual progress: received files,
Editorial working, Check needs review, Delivery complete. Open the exact Chat,
files, findings, or History checkpoint from each step. Let the fold explain a
failed step from these records rather than reconstructing scattered activity.

Build on existing run and hop receipts. Start read-only: no new scheduler,
transcript relay, or automatic recovery. Keep explanations behind a disclosure;
the default view is the step, status, and useful action.

Acceptance: a person can find a stopped or failed run, identify the failed
step, inspect what already changed, and reach its output without reading JSON.
A successful Check with findings must be shown as findings, not "ready."

## 2. An explicit review stop before handoff

Allow a person to tell the fold: "Draft this, check it against the approved
brief, then wait for me before sending it to Delivery." Offer a compact
review-and-continue action after the existing correction workflow.

This needs a deliberate extension to the current Routing contract. Today,
Check success means the run completed, even with findings; it is not a gate.
A future pause must pin the exact outputs and Check inputs, distinguish stale
or failed checks from clear results, survive restart, and revalidate before
continuation. It must never replay completed Chat/copy steps or infer approval
from elapsed time. A changed file returns to review.

Acceptance: correct the draft, continue once, and prove a restart or repeated
click cannot deliver twice. Show what would be delivered before continuing.

## 3. Reuse a proven setup

After a workflow succeeds, let the person ask the fold to reuse its arrangement
for another project: incoming material, working draft, reviewed deliverable,
and useful Checks. The fold asks only for the new folders and criteria, then
shows a short proposal with a trial before anything runs unattended.

Keep this separate from exporting existing Routings: those contain
machine-local Space identities. A future reusable recipe would contain no
live grants, credentials, transcripts, findings, or cross-Space state. Every
new installation resolves fresh Space identities and reviews its actual files,
copy destinations, messages, and trigger.

Acceptance: instantiate the same pattern in unrelated Spaces with no old
paths or authority, run a trial, and explicitly enable the new setup.

## Suggested order

Start with the run view, then the review stop. Together they make the current
folder-trigger and Checks machinery understandable and useful before adding
more trigger types. Reusable setups follow once two or three real workflows
prove which parts people actually want to repeat.

Calendar triggers, durable offline event capture, automatic retries, and
PDF/Word extraction could all be valuable later. Each changes a meaningful
contract; they should be separate decisions, not incidental additions to this
UI work. The current folder observer deliberately absorbs edits during Routing
work and rebaselines after wake rather than queueing every missed change.
