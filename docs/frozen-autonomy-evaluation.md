# Repeated frozen autonomy evaluation — 2026-10-19

156 first-attempt live-model trials compared the released runtime, three full fix cohorts, and a targeted research follow-up. **The final full follow-up passed 35/36 automated outcome and precision checks**, compared with 30/36 at baseline. The preceding full cohort passed 35/36; the line-aligned paging cohort then passed 10/12 research trials. All attempts, including incorrect Done results and deadline failures, remain in the evidence. Manual review still found inaccurate statements in validation notes; automated scores do not certify every sentence.

| Cohort | Original checker | Audited normal | Audited stressed | Audited total | Deadline failures | Invalid Done |
|---|---:|---:|---:|---:|---:|---:|
| Released baseline | 34/36 | 16/18 | 14/18 | 30/36 | 2 | 4 |
| Initial fix | 34/36 | 17/18 | 14/18 | 31/36 | 1 | 4 |
| Full follow-up | 35/36 | 18/18 | 17/18 | 35/36 | 1 | 0 |
| Line-aligned research only | 10/12 | 6/6 | 4/6 | 10/12 | 2 | 0 |
| Final structured-output full follow-up | 35/36 | 17/18 | 18/18 | 35/36 | 1 | 0 |

Known USD is the sum of provider-reported costs with usage. Missing usage makes that amount a lower bound; it is not an invoice total. Per-trial usage/cost snapshots and drained final logs are distinguished in the data.

| Cohort | Final logged calls | Known USD | Unpriced calls | Compactions | Repeated unchanged reads | Repeated recovery arguments |
|---|---:|---:|---:|---:|---:|---:|
| Released baseline | 1,035 | 2.3761 | 2 | 219 | 66 | 86 |
| Initial fix | 1,026 | 2.4369 | 1 | 201 | 48 | 16 |
| Full follow-up | 1,038 | 2.6613 | 1 | 219 | 67 | 41 |
| Line-aligned research only | 369 | 0.7304 | 1 | 85 | 23 | 7 |
| Final structured-output full follow-up | 912 | 2.3269 | 1 | 156 | 29 | 22 |

Across all cohorts: 4,380 logged provider requests, USD 10.5316 in reported usage cost, and six calls without usage.

Each full cohort contains 18 normal-context and 18 stressed-context trials. The targeted line-aligned follow-up contains six of each and reuses only the original research case across both models, with three repetitions per cell. The original small-value checker and the supplemental precision audit are reported separately. The audit was added after baseline review exposed a blind spot, then applied uniformly to every saved patch. No original grade or model patch was replaced.

## What changed

- **Recover complete pages.** Pi's native compaction serializer keeps the first 2,000 characters of a tool result. Long recovery responses put their continuation after material the summarizer dropped. After compaction, `progress` now returns smaller complete text/index pages, leading cursors and provenance warnings, and bounded task-local recent-recovery activity. Normal recovery retains the generous previous limits. Large fingerprint metadata remains in the live result but may exceed a later summary. Requested `limit` is an upper bound; `nextOffset` reflects actual coverage. Text pages now end at a newline when one fits the budget, preserving short physical lines. A line larger than the budget remains character-paged.
- **Expose native structured recovery.** `progress` now declares Pi's `outputSchema` and returns matching `structuredContent`. Codemode receives a typed page object with `text` and `nextOffset`; the model still receives the existing JSON text once. Without this native contract, codemode received a string, and one live pagination script looped on an undefined cursor. A real native codemode regression covers text pages, index lookup and saving a finding.
- **Retain a Worker's original assignment.** An answer/result continuation already carried its own original assignment in hidden context, but the compaction restatement restored only its latest message. It now restores the original assignment separately, with later corrections still applying, exact-text visibility checks, explicit excerpt bounds, and request isolation. The regression failed before the fix and passes through real native Pi compaction transport. This matrix does not test the work-fold agent's own conversation workflow.
- **Reuse applicable evidence.** The blanket fresh-check reminder conflicted with recovery. Guidance now preserves applicable verification, requires new checks for changed captured sources, treats untracked freshness as unknown, and recognizes that historical baselines are intentionally historical. Provenance and freshness flags are unchanged. It favors concise scoped comparisons and evidence references over repeatedly reconstructing raw inventories.
- **Preserve exactness and output contracts.** Number-valued integer cents still have a finite exact range. Guidance now calls for arbitrary precision from original decimal text through formatting when no magnitude bound exists, and checking literal required fields/types against the original request rather than only an agent-written test's chosen shape.
- **Grade independently.** The repeated runner freezes outcome-only prompts, fixtures, answers, expectations, evaluator files, dependency lockfile, Node and model catalog. Its normal lane now uses actual native Pi defaults; the earlier driver had silently forced a 40,000-token trigger. A separate frozen 40-case audit catches precision errors the original 26 small-value cases accepted, without modifying model outputs.

## Design

The two OpenRouter parent models, `z-ai/glm-5.3` and `openai/gpt-6-luna`, were configured for high reasoning. Native helper calls retained their normal tool-selected settings. Each model/case/context cell has three fresh first attempts; three disposable hosts run concurrently in deterministic interleaving. Each trial has a 900-second evaluation deadline. The product retains native Pi's uncapped default turn duration.

- **Normal:** Pi 1.1.0 defaults; catalog windows 1,048,576 and 1,050,000 tokens, reserve 16,384, keep-recent 20,000.
- **Stressed:** same prompts/fixtures, native auto-compaction trigger 18,000 and keep-recent 2,000. This trigger is not a hard input-token limit; helpers and compaction have separate request sizes.
- **Research:** classify all 36 synthetic interview notes, deliver ten confirmed saved-edit-loss participants with exact quotes, distinguish preview/unsaved/export cases, and preserve sources.
- **Reconcile:** ask about disputed payments, continue useful work, incorporate a person-side K correction from EUR 5.00 to 8.00, and deliver exact totals/ID sets in the requested shape.
- **Repair:** deliver a money-aggregation patch and validation notes while preserving original code and an uncommitted draft. Apply the patch independently to fresh copies and test it.

Task prompts name outcomes and constraints; they never prescribe tools or their order. Models can correct tool errors and use normal native provider retries within one attempt. Failed whole trials are never replaced. All hosts use isolated app state, Pi directories and broker tokens. Native shared-home Skill discovery remains enabled; those home resources were not part of the frozen plan. The comparison is therefore not hermetic across every resource the runtime can discover. The installed app and user work-folders are not used. Node is 24.18.0, npm 11.16.0, macOS arm64.

## Results by cell

Entries are **passes out of three; median seconds**, including capped deadline failures. These are audited outcomes, not the original grader alone.

| Case | Model | Context | Baseline | Initial fix | Full follow-up | Line-aligned research | Final structured-output full follow-up |
|---|---|---|---:|---:|---:|---:|---:|
| research | GLM 5.3 | normal | 3/3; 28s | 3/3; 37s | 3/3; 38s | 3/3; 56s | 3/3; 44s |
| research | GPT-6 Luna | normal | 3/3; 84s | 3/3; 74s | 3/3; 77s | 3/3; 89s | 3/3; 76s |
| research | GLM 5.3 | stressed | 3/3; 155s | 3/3; 325s | 3/3; 95s | 3/3; 291s | 3/3; 281s |
| research | GPT-6 Luna | stressed | 1/3; 900s | 3/3; 219s | 2/3; 311s | 1/3; 900s | 3/3; 177s |
| reconcile | GLM 5.3 | normal | 3/3; 54s | 3/3; 146s | 3/3; 69s | not re-run | 2/3; 66s |
| reconcile | GPT-6 Luna | normal | 3/3; 128s | 3/3; 96s | 3/3; 152s | not re-run | 3/3; 102s |
| reconcile | GLM 5.3 | stressed | 3/3; 254s | 3/3; 188s | 3/3; 119s | not re-run | 3/3; 323s |
| reconcile | GPT-6 Luna | stressed | 3/3; 106s | 2/3; 413s | 3/3; 589s | not re-run | 3/3; 218s |
| repair | GLM 5.3 | normal | 1/3; 60s | 2/3; 140s | 3/3; 43s | not re-run | 3/3; 143s |
| repair | GPT-6 Luna | normal | 3/3; 108s | 3/3; 99s | 3/3; 108s | not re-run | 3/3; 96s |
| repair | GLM 5.3 | stressed | 1/3; 279s | 0/3; 360s | 3/3; 460s | not re-run | 3/3; 191s |
| repair | GPT-6 Luna | stressed | 3/3; 156s | 3/3; 279s | 3/3; 220s | not re-run | 3/3; 197s |

## Failures preserved and interpretation

**Released baseline:** 6 automated failures.

- `research-stressed-luna-1` — request deadline, missing deliverable; state `working`; 900s; missing findings.json, findings.md.
- `repair-normal-glm-1` — decimal precision; state `done`; 41s; precision 19/40.
- `repair-stressed-glm-1` — decimal precision; state `done`; 119s; precision 19/40.
- `research-stressed-luna-2` — request deadline; state `working`; 900s.
- `repair-normal-glm-2` — decimal precision; state `done`; 60s; precision 19/40.
- `repair-stressed-glm-2` — decimal precision; state `done`; 279s; precision 19/40.

**Initial fix:** 5 automated failures.

- `repair-stressed-glm-1` — decimal precision, request deadline; state `working`; 900s; precision 19/40.
- `reconcile-stressed-luna-2` — requested output contract; state `done`; 413s.
- `repair-normal-glm-2` — decimal precision; state `done`; 38s; precision 19/40.
- `repair-stressed-glm-2` — decimal precision; state `done`; 360s; precision 19/40.
- `repair-stressed-glm-3` — decimal precision; state `done`; 216s; precision 19/40.

**Full follow-up:** 1 automated failure.

- `research-stressed-luna-3` — request deadline; state `working`; 900s.

**Line-aligned research only:** 2 automated failures.

- `research-stressed-luna-2` — request deadline; state `working`; 900s.
- `research-stressed-luna-3` — request deadline, missing deliverable; state `working`; 900s; missing findings.json, findings.md.

**Final structured-output full follow-up:** 1 automated failure.

- `reconcile-normal-glm-2` — request deadline; state `working`; 900s.


The initial fix passed all 12 research trials, although the later full follow-up still had a research deadline failure. The initial fix did not reliably correct GLM's arithmetic. Four patches in each of the first two cohorts failed 21 of 40 precision cases. For example, `90071992547409.91 + 0.10` must return `90071992547410.01`; a failing patch returned `.00`. Their notes claimed exactness. The original small-value checker had accepted them.

The initial-fix Luna reconciliation returned correct amounts and IDs under `currencyTotals` instead of `totals`. Its provisional file already used that wrong key **before** the first compaction, so the missing assignment is not established as its sole cause. Assignment loss is an independently reproduced runtime defect; contract-verification guidance addresses the separate self-checking error.

The full-follow-up `research-stressed-luna-3` trial wrote correct findings but was still working at 900 seconds. Its complete character pages split checksum rows around P14 and P28; repeated summaries treated row fragments as missing evidence. No cache bytes were lost, but stitching fragments across repeated compaction proved fragile. The subsequent line-boundary adjustment has a red/green regression for complete short lines, lossless reconstruction and progress through oversized lines. Its separately frozen 12-trial research cohort is a targeted check, not a replacement for the failed full-cohort attempt.

The initial-fix GLM deadline failure also had an upstream HTTP 200 stream open for 636,869 ms after compaction before cancellation. Its saved patch separately failed precision. The stall and numeric error are distinct. Final structured-output `reconcile-normal-glm-2` likewise reached 900 seconds with correct artifacts and no compactions. After its last successful source/contract check, an HTTP 200 model stream remained open for 768,064 ms until shutdown cancellation, without a usage record. The request was still working, so it fails the settlement check. This is separate from the recovery return-type defect. The product retains native Pi's runtime-duration and retry semantics.

The line-aligned `research-stressed-luna-2` trial exposed a separate native integration gap. Its loop used `r.text` and `r.nextOffset`, but a tool without an output schema resolves to text in Pi codemode. The resulting undefined cursor never equaled null, so the script kept recovering the first page until the evaluation deadline. The cache and page offsets were intact. The other line-aligned deadline failure, `research-stressed-luna-3`, continued reading and checking and had written neither required deliverable. Declaring Pi's native structured-output contract fixes that programmatic surface; the final full structured-output cohort tests it with the original frozen plan without replacing this failure.

Read/recovery counts reflect journal-visible calls; an unfinished or aborted codemode script can omit in-flight nested activity. Exact repeated reads/recovery arguments are diagnostic proxies. Freshness, index contents or purpose may have changed, and different arguments can still reconstruct the same information. No count is treated as proof of waste or required for a pass.

## Manual review: remaining weakness

Artifacts can pass functional checks while their explanations still contain errors. Examples from manual review (not an exhaustive prose error count):

- Full-follow-up `repair-stressed-glm-1` labels a test using `900719925474.09` as beyond 2^53 cents. Its 90,071,992,547,409 cents are below 9,007,199,254,740,992. The independent audit covers actual unsafe-range values and passes; the model's example label is wrong.
- Full-follow-up `repair-normal-glm-2` reports Node 24.18.2, while the frozen host and its Bash trace show 24.18.0. Its reported MD5 hashes were independently checked and are correct.
- Full-follow-up `research-stressed-luna-2` describes incomplete/wrong exported output where the source reports only a slow export. `research-stressed-glm-3` adds an unsaved-draft-pane/quit scenario absent from the source crash accounts. The classifications and required JSON quotes still pass.
- Full-follow-up `repair-normal-glm-1` initially says the original fails all four requirements, although currency separation was already present; later text acknowledges that.
- Line-aligned `research-normal-glm-1` calls a three-participant group “two” and reports 24 Background lines where a source file has 23. Line-aligned `research-stressed-glm-1` prints “12 + 9 + 5 = 36” instead of 26. Their participant sets and required quotes are correct. Line-aligned `research-normal-luna-2` broadens “slow export” into an export/download failure in the explanation.

Final structured-output `repair-stressed-glm-1` prints a 63-character `ledger.mjs` SHA-256 value with a missing character. The protected file matches the independent expected hash; the model-written evidence string does not.

Final structured-output `repair-normal-glm-1` says the original turns `1.234` into a NaN-poisoned total; it actually returns the finite number 1.234. That input is outside the valid two-decimal cases, but the explanatory claim is false.

Final structured-output `research-stressed-glm-1` also equates the app reporting saved state with proof that the changes existed on disk. The interview statements support the requested reported-loss classification, but do not independently prove that physical persistence happened.

These model-written files are preserved unchanged. Automated grading covers the specified artifact/source/request checks and numerical cases; it does not certify all prose, tool-version claims or reasoning. Evidence reporting remains a model-quality weakness even after the concrete recovery defects are fixed.

## Local validation and evidence

The paging regressions failed against the old implementation. Tests cover complete Unicode/escaped text and index pages through Pi's public serializer, original normal limits, stale-source warnings with large metadata, ownership and recovery-history scope. The native codemode regression fails against the prior string-returning implementation and passes for structured read pages, index lookup and finding saves. Assignment tests cover root/delegated continuations, bounded excerpts, exact visibility, prefix collisions, another request's isolation, and actual post-compaction transport. Precision-grader tests reject approximate arithmetic and lossy parsing followed by otherwise exact arithmetic.

`npm run check` passed. The final runtime's full `npm test` run had **2,188 passed, zero failures, one Windows-only skip** (2,189 total). `npm run desktop:prepare` passed, including native Electron sandbox and preflight checks. No remote CI was used.

| Cohort | Evaluated source SHA | Protected source hashes checked | Mismatches |
|---|---|---:|---:|
| Released baseline | `3e0658172337dd1f245a10b2d03e339bd6d40807` | 492 | 0 |
| Initial fix | `89ff1923978b054198ad7b30ec8eef70c956c5a1` | 492 | 0 |
| Full follow-up | `3442ca4da85557c7d8872accde4a12e7a3ef7582` | 492 | 0 |
| Line-aligned research only | `4ab70b1a44f59a29134ee76558c1e91f33d5a267` | 432 | 0 |
| Final structured-output full follow-up | `3d1fbcdc30b390238655d6883ea6029132365c55` | 492 | 0 |

The baseline evaluator commit changes no product runtime files from released 0.12.0 (`2a168538948e8bb22d579e1cb4298c0824ebfd97`). The targeted line-aligned research plan derives from that plan with unchanged prompts, fixtures, answers, evaluator hashes, catalog and limits; its SHA-256 is `4adda9f9648aabd322e4763006a0751095ed611f8b937ad97e9038c8d6d0c550`. The final structured-output cohort reuses the original full 36-trial plan. Every phase requires clean committed source and checks its SHA/tree before and after every trial. Runtime edits occur only between phases. Later report/documentation commits do not alter the evaluated runtime.

Frozen plan SHA-256: `3bdc3e0fc5a5236a14b7faa90fe378ab20c595b1ad12823c53ff00a214d4a978`.

Precision cases SHA-256: `698d6850d93cc6b1c9a8a0661654793f4b7111e5b9d200b11cc143ca6848e5ed`. Checker source SHA-256: `c9d3e923d3f3a94a71c168f11fb2931f308dce6a6f2045551dd087b5dbac5f21`. Checker manifest SHA-256: `53fe687ef8f1a9c60f2308da2d9f6e75d4a6f52994e1fdaefa0e1607e976679f`. Cases were frozen during the baseline; the checker was frozen before any fixed cohort. Full fixture/evaluator/catalog/lock hashes and every sanitized trial are in [the results data](evaluations/frozen-autonomy-2026-10-19.json).

Raw journals, provider logs, original grades, supplemental grades, synthetic artifacts and artifact hashes remain in the initiating checkout's ignored `out/frozen-eval/2026-10-19/` directory. The data also inventories missing required deliverables without replacing any original grade. Per-phase final-log audits check all protected fixture files, including trials whose original verifier stopped before checking sources. Expected hashes allow only the driver's explicit person-side payment correction. These are final-byte checks, not proof against every possible transient external mutation.

## Reproduce and limits

See [development evaluation commands](development.md#real-model-harness-acceptance) and the checked-in [repeated runner](../scripts/harness-eval/repeat.ts), [fixtures](../scripts/harness-eval/fixtures.ts), [precision audit](../scripts/harness-eval/precision-audit.ts), and [recovery diagnostics](../scripts/harness-eval/recovery-audit.ts). Freeze a fresh plan on committed source, supply model credentials explicitly, preserve all failed trials, make changes between cohorts, and reuse that plan with a fresh output directory. The saved precision manifest checks its own code/data hashes before grading.

The repair fixtures and precision cases use two-decimal text amounts. Compatibility with JavaScript number inputs is not established by this audit; the prompt does not spell out a JavaScript type. Final `repair-normal-luna-1` calls strings the stated contract even though that is an assumption, and rejects numeric whole-dollar/one-fractional-digit representations. This is an input-domain limitation alongside its passing text-amount precision checks.

Three repetitions per cell are an initial signal, not a precise production success rate. Fixes were informed by these cases, so this is workload-informed iteration, not a held-out generalization test. Hosted weights, routing and provider load are outside the freeze. Time/cost differences cannot separate the combined changes; local checks overlapped the baseline tail. Browser/computer control, document rendering, arbitrary Extensions, hostile content, crash/restart recovery, other providers and the work-fold agent's own requests are outside these three live cases. This study does not measure parity against the Codex harness.
