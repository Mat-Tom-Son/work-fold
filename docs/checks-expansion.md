# Checks expansion design

**Status: proposal.** Nothing in this document is implemented or decided.
[Checks](checks.md) remains the decision register; when a phase here ships,
its decisions are promoted into that register and this document shrinks.

## What we are trying to accomplish

Today a Check can hold one durable expectation about file *form*: an exactly
designated file is present or absent. The destination is that a person can
teach work-fold durable expectations about file *content and meaning* — and
work-fold can verify them on request with fast, bounded judgment — without
giving up any of the properties that make Checks trustworthy: explicit
designation, exact-digest authority, evidence-backed findings, health kept
separate from content, and a quiet desktop surface.

Domain-neutral examples of where this ladder ends:

- "Nothing matching `*.tmp` or `.DS_Store` may exist under `deliverables/`" — deterministic, no new evidence shape.
- "Every chapter file must be non-empty and under 2 MB" — deterministic, needs one new evidence shape.
- "No unresolved TODO/placeholder text in `final/`" — judgment over deterministic candidates.
- "`proposal.md` must contain a filled-in Revision History section" — judgment with extracted evidence.
- "These two files must state the same version" — extraction plus comparison.

The one-sentence architecture, unchanged from the current register: **sensors
propose, the runner admits.** A model-backed sensor is just a proposer whose
output is *less* trusted than a deterministic one — which costs nothing,
because admission never trusted proposers in the first place. Everything below
is sequencing toward that point without widening the trust model.

## Invariants that survive every layer

1. **Declarations stay inert data.** No prompts, instructions, model names,
   credentials, or executable expressions — `forbiddenParameterKeys` keeps
   applying as-is. Prompt-bearing logic lives inside trusted sensor
   implementations covered by `implementationDigest`.
2. **Exact authority.** A person enables declaration digest × sensor id ×
   revision × implementation digest. Model-backed sensors extend this by
   pinning the resolved model binding at enable time; they never widen it.
3. **No independently re-verifiable evidence, no active finding.** Every
   candidate — deterministic or model-proposed — carries typed evidence the
   runner re-verifies against the person's actual files before persistence.
   A hallucinated finding dies at admission, structurally.
4. **Health is never content.** Missing provider, offline model, exceeded
   token budget, malformed submission: `blocked` or `check-error`, never a
   problem in the person's files.
5. **The read lane stays content-free and status never executes anything.**
   `checks status` continues to report counts only, and computing freshness
   must never invoke a sensor, provider, or model — and never read file
   content.

## Layer map

Each phase is independently shippable, updates `docs/checks.md` when it
lands, and is a prerequisite for the phase after it.

| Phase | Ships | Unblocks |
|---|---|---|
| 0 | Seam tightening | Trustworthy base |
| 1 | Second deterministic sensor + sensor catalog surfaces | Multi-sensor registry |
| 2 | Snapshots, content identity, real staleness | Any content-reading sensor |
| 3 | Evidence contract 1 (text spans, structured values) | Findings about content |
| 4 | Embedded fast model, adjudicator mode | Judgment-backed Checks |
| 5 | Extractor-mode model sensors, distribution | Horizon |

### Phase 0 — seam tightening

Small fixes that make the base honest before anything is added:

- Derive the `#problems` truncation cap from the run finding limit instead of
  the free-standing `250` next to `maximumFindings: 256`
  (`check-service.ts:764` vs `:39`).
- `listWorkFoldCheckSensors()` (`check-sensors.ts:97`) has zero callers; keep
  it only if Phase 1's sensor catalog surface consumes it, otherwise remove.
- `WorkFoldCheckStore.recordRun()` is public but only called by the adjacent
  `acceptRun()`; make it private.
- Reconcile the register's evidence wording: it promises "content digest or
  missing-file state" in input identity, but the runner records path state
  plus size only (`runnerOwnedInputs`, `check-service.ts:937`). Until
  Phase 2, the register should say what contract 0 actually records.

### Phase 1 — second deterministic sensor, same evidence contract

A "forbidden files" sensor proves the expansion story end-to-end with no new
evidence shape: tree targets, `expect: absent`, and every violation is an
exact file that exists but should not — which is precisely what contract-0
`path-state` evidence (`expected: missing, observed: file`) can already
express and re-verify.

- **New sensor id** (working name `work-fold.forbidden-files`) rather than a
  `file-presence` revision bump. `resolveWorkFoldCheckSensor` currently
  resolves one revision per id, so bumping the built-in revision would
  silently block every existing rev-1 enablement. Frozen revisions stay
  resolvable; the registry becomes keyed by id + revision to allow future
  coexisting revisions.
- Validation: tree targets only, bounded recursion and extension filters as
  today; parameters stay a closed typed set.
- This phase also carries the CLI/surface rounding that only makes sense once
  there are two sensors: a sensors listing (act lane), `checks wait` in the
  TypeScript CLI to match the shims, and human `checks status` output that
  names per-sensor counts. The register's CLI-lane section moves with it.

### Phase 2 — content identity, snapshots, real staleness

The gate the register already places before any content sensor: the runner —
not the sensor — opens files.

- **Snapshot reader.** During a run, the runner opens each designated file
  no-follow, re-verifies identity (dev/ino), reads at most the per-file byte
  cap into an immutable in-memory snapshot, and hashes it. Sensors receive
  snapshot content through the closed projection; they still never see a
  reopenable path.
- **Input identity gains `sha256` and `modifiedAt`**, populated from the
  snapshot at run time — zero extra IO, since the bytes are already in hand.
  The typed-but-empty fields on `WorkFoldCheckFileIdentity` were built for
  this.
- **Observation classes.** Each sensor declares what it observes:
  `path-state` (file-presence, forbidden-files) or `content`. Freshness
  compares only the dimensions the sensor observes, so editing a designated
  file makes a content-observing Check `stale` while a presence Check stays
  `current` — today `sameSemanticInputs` (`check-service.ts:951`) compares an
  always-null digest and drops size, so staleness is presence-only for
  everyone.
- **Status stays cheap and inert.** Status-time freshness for content
  sensors compares recorded size + mtime against a stat; it never re-reads or
  re-hashes content. A size/mtime match is trusted as current; a mismatch is
  `stale`. The invariant "status never invokes a sensor, provider, model,
  connection, or network adapter" extends to "and never reads file content."

### Phase 3 — evidence contract 1

Two additive evidence kinds, both mechanically re-verifiable by the runner
with no judgment:

- **`text-span`**: path, typed locator (byte or line range), the exact
  quoted text, and the snapshot content digest it was observed in.
  Re-verification re-reads the span and compares bytes exactly; a changed
  file invalidates the finding into `stale`, exactly like today.
- **`structured-value`**: path, an extractor id + typed arguments from a
  small runner-owned deterministic catalog (e.g. front-matter key, JSON
  pointer, line-count), the observed value, and a typed relation to an
  expected value. Re-verification recomputes the extraction. Extractors are
  versioned and digest-covered like sensors — they are runner code, never
  declaration content.

Contract 0 → 1 is a deliberate register revision. Older runners keep
rejecting the new kinds (the `evidence.kind !== "path-state"` checks in
admission and the store already fail closed, which is the point of them).
This phase makes deterministic *content* sensors possible — file-size and
required-heading checks need nothing from Phase 4.

### Phase 4 — the embedded fast model

One new component, the **model task harness**, and one deliberately humble
first sensor.

**Harness contract** (implements the register's existing sentence: one
bounded model task, no general tools, one schema-validated terminating
submission operation):

- Input: the sensor's prompt template (part of the digest-pinned
  implementation) plus bounded snapshot slices from Phase 2. File content is
  data; the harness never treats it as instructions.
- The model has exactly one operation: `submit_findings`, schema-validated.
  Malformed submissions get bounded retries with the validation error fed
  back; exhausting retries fails the run as health, not content.
- Hard budgets from the authorization's limits — new `maximumModelCalls` and
  `maximumModelTokens` alongside the existing time/byte limits — under the
  same `AbortSignal` as everything else. Not a persistent Chat turn; nothing
  is remembered between runs.
- Model access goes through Pi's model registry and auth storage. work-fold
  stores no new credentials and adds no provider UI; a missing or unusable
  provider is `blocked`.
- **Enable-time model binding.** Enabling a model-backed Check resolves a
  fast-class model (Haiku-class or a capable local model) and records the
  exact provider + model id in the authorization, shown to the person in the
  enable action. `WorkFoldCheckAuthorization.execution: "model"` is already
  typed and normalized; the binding extends the same exact-authority idea. A
  binding that no longer resolves is `blocked` until re-enabled.
- The run record's existing `cost` field is finally written (model id,
  tokens, amount) and surfaces through `checks result`, which already
  projects it. Cost stays machine-local, out of the content-free lane.

**Mode A — the adjudicator (ships first).** A deterministic matcher proposes
candidate spans (TODO/TBD/lorem/unfilled-blank patterns); the fast model's
only job is classifying each candidate — real placeholder or false positive.
Only confirmed candidates become findings, and their evidence is the
deterministic `text-span` the matcher produced, so admission re-verification
is near-infallible and the register's fail-closed admission rule stays
untouched. The model can suppress noise; it structurally cannot invent a
finding. First sensor: a placeholder/unfinished-text scan — the highest-value
judgment task that pure regex does badly.

This ordering derisks everything operational about the model (auth, budgets,
latency, cost, health states, offline behavior) while the blast radius of a
bad model answer is a false negative, never a fabricated problem.

### Phase 5 — horizon (each needs its own register decision)

- **Mode B — the extractor.** The model proposes findings directly with
  exact-quote `text-span` or `structured-value` evidence; the sensor
  pre-verifies every span against its own snapshot before submitting, so
  runner admission stays fail-closed and admission failures stay
  exceptional. Enables section-presence, cross-file consistency, and
  filled-in-table sensors.
- Distribution of model sensors through the existing Pi capability lane
  (built-in and maximally trusted until then).
- Schedules via the existing named-automation model; still never a watcher.
- Domain packs, gates that block other work, cache replay: unchanged from
  the register's deferred list.

## Open decisions

1. Second sensor as a new id (recommended) vs. multi-revision `file-presence`.
2. Adjudicator-first (recommended) vs. going straight to extractor mode.
3. Model binding pins an exact provider + model id (recommended) vs. a
   named speed/capability class resolved per run.
4. Keep fail-closed admission for model sensors (recommended) vs. a distinct
   "candidate discarded" run outcome.
5. Sensors listing in the act lane (recommended) vs. extending read-lane
   protocol v1.
6. Per-sensor observation classes for freshness (recommended) vs. global
   content-aware freshness for all Checks.

## Explicitly not in this design

Background watchers, proactive notifications, blocking gates, hosted
execution, cross-Space Checks, and any import of legacy Workspace check
state remain out, per the existing register.
