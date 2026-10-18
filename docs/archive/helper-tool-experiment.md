# Helper tool experiment

> **Status:** Dated experiment evidence, 2026-10-18. This is not a contract
> and not accepted scope. The helper prototype is on hold, marked as work in
> progress on branch `claude/helper-tool-prototype-wip`. This branch carries
> only the evaluation harness and this write-up.

**Question.** Should Workers get a read-only *helper*? A helper takes one
focused reading task, runs it in its own context inside the Worker's turn, and
hands back a short result. A child Chat (`chat handoff` followed by
`chat wait`) already isolates context and returns results mid-turn. So a
helper could add only lower overhead, less Chat clutter, and narrower powers.

**Decision rule** (from Mat): quality first, latency second, cost last. Build
the helper only if either holds:

- (a) a single Chat's quality or task identity gets worse under context
  pressure; or
- (b) parallel helpers would plausibly cut latency on heavy reading.

Otherwise, defer it.

**Answer.**

- **(a) holds, for quality.** Only one model compacted mid-turn: GPT-6 Luna,
  at a trigger I lowered on purpose. Across 6 such single-Chat turns, 4 lost
  findings, scoring 7, 7, 4 and 4 out of 10. The Worker reported each partial
  list as complete. Same-folder handoff kept the parent below the trigger and
  stayed perfect.
- **Task identity is now fixed separately.** Before the fix, one of those runs
  also lost its task id. Pi's summary had written the previous turn's id into
  its "Critical context", so the report was refused. Branch
  `claude/compaction-keeps-task-id` (ec260a4) restates the turn's exact ids
  after any mid-turn compaction. With it, 4 of 4 compacting turns recorded
  their report under the right id. Lost findings are a separate problem the
  fix doesn't touch.
- **(b) does not hold.** About 80–94% of a turn's time is model round trips,
  and Workers already batch their reads or write scripts to scan files. Every
  helper path needs about 5 or more round trips one after another, so it can't
  be much faster. The one-helper arm was 1.3–2.3× slower than a single Chat.
- **Recommendation:** merge the task-id fix. Following Mat's rule, resume the
  helper, aimed at long Chats near their compaction point, where a fresh reader
  keeps findings that compaction drops. Re-measure that case against the
  single Chat before shipping anything. Improving what Pi's compaction summary
  keeps is the other lever. Don't teach
  same-folder handoff for reading. It's accurate under pressure but 1.2–2.2×
  slower, and it trips the duplicate-turn bug every time.

## Setup

**Runtime.**

- The real local API ran in-process (dev mode, disposable state and a
  disposable Pi folder), driven by `npm run work-fold:drive -- --attach`.
- Workers had a working `work-fold` CLI: the real macOS shim on `PATH`, an act
  token, and a stand-in app that forwards requests to `WorkFoldDesktopCliHost`.
- Every provider call was tapped, so usage covers titles, child Chats, helpers
  and the host's follow-up turns. Cost is what OpenRouter billed.
- No included tools, Extensions, Skills or Worker instructions.

**Prompts by round.**

| Round | Source | Worker prompt |
|---|---|---|
| Steps 1–2 | `7e0e796` | Pi's coding preamble; no date or time zone in the turn context |
| Step 3 | `5a2e877` (main after [#74](https://github.com/Mat-Tom-Son/work-fold/pull/74)) | Worker role preamble; the turn context opens with date, time zone and platform |

**Models.**

- `openai/gpt-6-luna` at thinking `high`: Mat's Pi default. Every round.
- `anthropic/claude-opus-5.5` at thinking `high`: step 3. It was the strongest
  practical model available through Mat's OpenRouter key (1M window).
  `claude-fable-5.1` costs about 2.5× as much and wasn't used. Mat's own Worker
  picks (`z-ai/glm-5.3`, `deepseek-v4.1-flash`) are cheaper, not stronger.
- The Worker's system prompt is about 15.7k tokens on GPT-6 Luna and about 26k
  on Opus, because the tokenizers differ.

**Arms.**

- **a** — the question alone, in one Chat.
- **b** — the question plus a hint to hand the reading to a fresh Chat in the
  same work-folder with `chat handoff`, then `chat wait`.
- **c** — the helper, with a matching hint. Steps 1–2 only, on GPT-6 Luna.
- **c0** — the helper with no hint. Steps 1–2 only, on GPT-6 Luna.

**Tasks.** The tasks were seeded folders. Expected answers were kept in a file
that never entered a work-folder. I read every answer; a line-level scorer
helped.

| Task | Files | Size | What makes it hard |
|---|---|---|---|
| Office launch | 40 | 95 KB | The site code `LIS` is used for Lisbon; distractor dates from other sites and the keys handover |
| Travel policy | 19 | 40 KB | A base policy, amendments and superseded addenda; a partly correct FAQ |
| Rename survey | 32 | 44 KB | `Orbit Logistics`, `ORBIT_API_KEY`, and a moon's orbit, which must not change |
| Export bug | 29 | 67 KB | Five different phrasings of the bug; import, PDF and praise distractors |
| **Export bug at scale** (context pressure) | 321 | 659 KB | Ten different phrasings of the bug. The obvious words appear in 128–295 files each, so grep can't narrow the search. The answer must also be recorded with `chat report` for this turn's task. |
| **Same, as turn 2 of a long Chat** (context pressure) | 321 | 659 KB + 375 KB of pasted history | Turn 1 pastes an unrelated 375 KB handbook. Pi's compaction trigger is set about 12k tokens above the history (or about 2k above it on the second Opus round), so the measured turn has to compact if it reads anything. |

On the pressure tasks, compaction is Pi's own automatic compaction. I lowered
its trigger through `compaction.reserveTokens`:

- **Export bug at scale:** 112k tokens, both models. That is where a
  128k-window model compacts.
- **Long Chat:** 100k for GPT-6 Luna, and 155k and then 145k for Opus. Each
  history was calibrated per model: about 88k tokens for GPT-6 Luna and about
  143k for Opus.

The model itself still had its full window, so this tests what compaction
does, not small-window reasoning.

## Results

Each cell is the mean of the runs, with the range in brackets. Quality lists each run's score.

### Context pressure (step 3)

**Export bug at scale**

| Model | Arm | Quality | Latency | Parent peak context | Compacted | Report recorded | Cost |
|---|---|---|---|---|---|---|---|
| GPT-6 Luna | a | 10/10, 10/10 | 59 s (53–66) | 84k | no | 2/2 | $0.018 |
| GPT-6 Luna | b | 10/10, 10/10 | 124 s (119–128) | 22k | no | 2/2 | $0.027 |
| Opus 5.5 | a | 10/10, 10/10 | 55 s (49–61) | 45k | no | 2/2 | $0.35 |
| Opus 5.5 | b | 10/10, 10/10 | 118 s (109–128) | 34k | no | 2/2 | $0.64 |

Neither model came under pressure. Both wrote short scripts or broad regular
expressions to scan all 320 transcripts, then read only the 10–20 candidates.
GPT-6 Luna, for example, used `python3` to list every line mentioning a version
or an issue. A Worker with bash already does map-style reading in code, without
putting the files into its context.

**Same task, as turn 2 of a long Chat**

| Model, trigger | Arm | Quality | Latency | Parent context (start → peak) | Compacted | Report recorded | Cost |
|---|---|---|---|---|---|---|---|
| GPT-6 Luna, 100k | a | 10/10, **7/10** | 90 s (85–94) | 89k → 111k | **yes, both** | 1/2 (**wrong task id**) | $0.028 |
| GPT-6 Luna, 100k | b | 10/10, 10/10 | 106 s (97–115) | 89k → 95k | no | 2/2 | $0.031 |
| Opus 5.5, 155k | a | 10/10, 10/10 | 62 s (56–68) | 143k → 154–159k | no | 2/2 | $0.45 |
| Opus 5.5, 155k | b | 10/10, 10/10 | 121 s (117–125) | 143k → 151–153k | no | 2/2 | $0.77 |
| Opus 5.5, 145k | a | 10/10, 10/10 | 65 s (64–66) | 143k → 159–163k | no | 2/2 | $0.47 |
| Opus 5.5, 145k | b | 10/10, 10/10 | 129 s (119–138) | 143k → 152–153k | no | 2/2 | $0.74 |

What happened in the GPT-6 Luna single-Chat run that failed:

1. Pi compacted mid-turn at 111k tokens.
2. Its summary's "Critical context" recorded the **setup turn's** task id
   (`turn-6137886c…`) as "Task ID". The current turn's hidden context had
   already been folded into the summary, so its id was lost.
3. The Worker ran `chat report --task turn-6137886c…`. work-fold correctly
   refused it ("That task's turn is stopping or has already finished").
4. The Worker tried `tool_search`, then stopped and said plainly: "The results
   were not recorded."
5. Its final list missed 3 of the 10 reporters.

The other GPT-6 Luna run also compacted, and it reported correctly with a
perfect list. In handoff, the parent stayed below its trigger and the child
started fresh, so both handoff runs stayed perfect.

**After the task-id fix** (`claude/compaction-keeps-task-id`, ec260a4), I ran
4 more GPT-6 Luna single-Chat runs, same task and trigger:

- **Compaction:** all 4 compacted mid-turn.
- **Reports:** all 4 were recorded under the correct task id.
- **Quality:** 7/10, 10/10, 4/10 and 4/10.

Findings gathered before compaction didn't survive the summary. The Worker
then presented the partial list as the answer, for example "Found and reported
four matches", and recorded it as succeeded.

Opus never compacted: not in its 4 single-Chat turns, and not in the handoff
parents. Single-Chat usage reached 154–164k tokens against triggers of 145k
and 155k. I haven't established why Pi's mid-turn
check didn't fire for Opus when it did for GPT-6 Luna; that is a follow-up.
With 143–163k tokens of context, the Opus single Chat stayed perfect and
recorded its reports.

### Graded step-1 tasks

| Task, model | Arm | Quality | Latency | Parent growth | Cost |
|---|---|---|---|---|---|
| Office launch, Opus 5.5 | a | 6/6, 6/6 | 29 s (29–30) | 24k | $0.31 |
| Office launch, Opus 5.5 | b | 6/6, 6/6 | 97 s (88–107) | 8k | $0.62 |
| Export bug, Opus 5.5 | a | 5/5, 5/5 | 27 s (27–28) | 22k | $0.28 |
| Export bug, Opus 5.5 | b | 5/5, **4/5** | 71 s (61–81) | 6k | $0.48 |
| Office launch, GPT-6 Luna | a / b / c / c0 | all 6/6 | 38 / 94 / 69 / 66 s | 17k / 4k / 2.5k / 8k | $0.007 / 0.017 / 0.012 / 0.014 |
| Travel policy, GPT-6 Luna | a / b / c / c0 | all 8/8 | 40 / 110 / 51 / 62 s | 10k / 5k / 2k / 7k | $0.006 / 0.017 / 0.006 / 0.008 |
| Rename survey, GPT-6 Luna | a / b / c / c0 | 8/8; 8, 8, 7.6/8; 8/8; 8/8 | 55 / 163 / 102 / 92 s | 11k / 7k / 4k / 9k | $0.006 / 0.023 / 0.009 / 0.009 |
| Export bug, GPT-6 Luna | a / b / c / c0 | 5/5; 4, 5, 5/5; 5/5; 5/5 | 20 / 60 / 45 / 26 s | 6k / 4k / 1.5k / 7k | $0.004 / 0.012 / 0.006 / 0.004 |

GPT-6 Luna rows have 3 runs per arm and Opus rows have 2.

**Where answers went wrong.** Every miss came from a delegated reader making a
call the parent passed on without checking:

- A handoff child dropped "the download is missing the final line" as not
  specific enough (GPT-6 Luna).
- A handoff child deliberately left out Noah, whose report was second-hand. It
  said so in its answer (Opus).
- A handoff child put the legal terms page under "hold for legal review" rather
  than "change". That's defensible, but the scorer docks it.

Every single-Chat answer was perfect, except the run that compacted.

**Graded claims as well as facts.**

- The coverage claims were true, for example "the review covered all 40
  files" and "line 19 in each transcript".
- Five runs misstated a file count by one. Three said "18 Markdown documents"
  where there are 19. Two said "31 files" where there are 32. One of these was
  a handoff run and four were helper runs; no single-Chat answer misstated a
  count.

### Latency, and whether parallel helpers could help (rule b)

| | Single Chat (a) | Handoff (b) | One helper (c) |
|---|---|---|---|
| Latency vs a | 1× | 2.5–3.0× (step 1); 1.2–2.2× under pressure | 1.3–2.3× |
| Model calls in a row on the critical path | 6–9 (step 1); 7–13 (pressure) | parent 3–8, plus a child of 9–15 | parent 2, plus a helper of 4.5–7 |

- **Where a turn's time goes.** In arm a, 81–94% of a turn is model round
  trips, at 3–8 s each. File reading itself takes milliseconds. Workers
  already issue several tool calls per round trip (1.5 on average) and write
  scripts that scan hundreds of files in one call.
- **The floor for any helper path.** A parent call to dispatch the work, a
  helper that searches, reads and submits (at least 3 calls), and a parent call
  to pull the answer together. That is about 5 sequential calls, against 6–13
  for a single Chat.
- **Best case.** Parallel helpers could save about 1–5 of those calls, roughly
  15–40% of latency, on the heaviest reading. That assumes each helper stays
  minimal; the measured one used 4.5–7 calls.
- **Measured reality.** In every case a single helper was slower than the
  single Chat.

So parallel helpers would not plausibly cut latency materially at these
sizes, and rule (b) does not hold.

### Stop (step 2, GPT-6 Luna)

Stop was pressed on office-launch, twice per arm. The whole request settled
156–293 ms later, with no provider call left running.

- **Single Chat:** the turn was aborted.
- **Handoff:** the parent and child requests were both stopped.
- **Helper:** the helper was recorded as `stopped` under the aborted turn.

The prototype's tests prove the order: the helper drains before the final
History checkpoint and before the turn's reservation is released. Both
ordering tests fail if the drain is removed.

### Prompt hint and helper usage (step 2)

Without a hint, Workers chose the helper in 8 of 12 runs. They usually read
some files themselves as well, so their context grew 0.5–1.15× as much as a
single Chat's. With the hint, it grew 0.14–0.34× as much.

## Inputs from the architecture review

1. **Following up with the same child.** No parent needed one. In all 26
   handoff runs the parent sent at most one handoff and then waited, once or twice.
   Every helper call was one-shot. A Worker has no way to send a follow-up to
   its child, and these tasks never needed one.
2. **Steering a running child.** No run would have benefited. The misses came
   from the child's own judgement, accepted without a check. A parent re-check
   would have caught them; correcting the child mid-turn would not.
3. **Parallel writers.** The tasks were read-only. Across all runs, the only
   writes were Worker scratch files in `.worker/`, all in task-id subfolders
   except one run that used `.worker/t9eb/`. Nothing overlapped.
4. **Compaction.** It was tested, and it surfaced the task-id bug above. Under
   compaction, the hidden turn context is the weak point.
5. **The helper's prompt.** The prototype doesn't use Pi's `customPrompt`. It
   calls `session.agent.streamFunction` with its own short system prompt and an
   explicit tool list.
6. **Overlap with the instruction fixes.** The on-hold prototype edits
   `pi-client.ts`: the `customTools` array, the turn's `finally`, abort and
   stop, and usage. Resuming it needs a merge with main after #74. It doesn't
   touch `buildTurnContextMessage` or `included-tools.ts`.

## Follow-ups

Each of these is independent of the helper.

- **Compaction lost the turn's task id. Fixed on branch
  `claude/compaction-keeps-task-id` (ec260a4), not yet merged.** A request-local
  hook restates the turn's exact ids after any mid-turn compaction. Measured:
  4 of 4 compacting turns recorded their report under the right id.
- **Compaction loses findings collected earlier in the same turn.** 4 of 6
  compacting GPT-6 Luna turns returned a partial list as if it were complete.
  Options:
  - teach the Worker to keep running findings in a `.worker/` file during long
    searches;
  - give Pi's summary instructions that preserve in-progress results (Pi offers
    a `session_before_compact` hook);
  - hand the reading to a fresh context: handoff today, or the helper.
- **Why Opus never compacted mid-turn.** Its turns passed the trigger without
  compacting. Find out whether Pi's mid-turn check behaves differently for some
  providers or models.
- **A redundant follow-up turn after `chat wait`.** It happened in every
  handoff run: 26 of 26, before and after #74. A child's result that the parent
  read through `chat wait` isn't recorded as delivered. The host then starts a
  synthesis turn, and the Chat shows the answer twice. A proposal card exists
  for this.
- **Usage receipts undercount.** Turn and request usage leave out cache-read
  and cache-write tokens, and OpenRouter catalog prices give cache a cost of
  $0. One turn recorded $0.000013; OpenRouter billed $0.0021. A proposal card
  exists for this.
- **Workers can see `.work-fold/`.** Pi's grep and find include hidden folders,
  so `.work-fold/conversations/*.jsonl` shows up in roughly half of
  single-Chat and handoff sessions. In two handoff runs, grep matched text
  inside those transcripts. One child listed them in its answer, and for a
  same-folder child that includes the Chat that delegated to it. The helper's
  path policy refuses these files.

## The prototype (on hold)

The prototype is on branch `claude/helper-tool-prototype-wip`, in
`src/local/agent/helper-tool.ts`, behind `WORKFOLD_DEV_HELPER_TOOL=1`, with 9
tests in `tests/helper-tool.test.ts`. If it is resumed:

- **Tools.** It runs read, grep, find and ls inside the work-folder. `read` is
  Pi's own tool with scoped file operations. Every path is checked after
  resolving symlinks, and `.work-fold`, `.pi` and `.workspace` are refused.
- **Model and input.** It uses the parent's model and transport. It sees only
  the task and the paths the parent chose.
- **Result.** It returns the standard result shape (F29).
- **Records.** It has no Chat or request record of its own. Its run is recorded
  on the parent turn's record, and its usage is counted in the turn's and
  request's totals.
- **Stop.** Stop drains it before the History checkpoint and before the turn's
  reservation is released.
- **Not built yet:** progress shown in the Chat, a choice of model per helper,
  and protection against a file changing between the path check and the read.

## Reproduce

The harness is in `scripts/helper-eval/`, and outputs go to the ignored `out/`
folder. Use Node 24 and put the OpenRouter key in the environment; it is never
written to disk.

1. Create the fixtures:

   ```sh
   npx tsx scripts/helper-eval/fixtures.ts out/helper-eval/fixtures
   ```

2. Start a host, choosing the model and, optionally, a compaction trigger:

   ```sh
   OPENROUTER_API_KEY=... npx tsx scripts/helper-eval/host.ts --out out/helper-eval/run1/x --model openrouter/anthropic/claude-opus-5.5 --compact-at 145000
   ```

3. Run a task and arm. Add `--stop-after <s>` to measure Stop instead:

   ```sh
   npx tsx scripts/helper-eval/run.ts --eval out/helper-eval/run1/x --fixtures out/helper-eval/fixtures --task export-bug-xl-long --arm a --rep 1
   ```

4. Score the runs:

   ```sh
   npx tsx scripts/helper-eval/score.ts --fixtures out/helper-eval/fixtures out/helper-eval/run1 --answers
   ```

**Spend.** OpenRouter billed about $17.85 in total:

- $0.50 for steps 1–2 and the Stop runs (GPT-6 Luna);
- $10.42 for step 3's measured turns, mostly Opus;
- $5.85 for step 3's untimed long-Chat setup turns;
- $0.91 for calibration and smoke runs;
- $0.15 for the post-fix check.

There are two or three runs per cell, so these are observations, not success
rates.
