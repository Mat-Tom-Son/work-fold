# Helper tool experiment

> **Status:** Dated experiment evidence, 2026-10-18. Not a contract and not
> accepted scope. The prototype lives on branch `claude/helper-tool-experiment`
> behind `WORKFOLD_DEV_HELPER_TOOL=1`.

**Question.** Do Workers benefit from a read-only *helper*: one focused task
that runs in a separate context inside the Worker's own turn and hands back a
concise result? A child Chat (`chat handoff` plus `chat wait`) already isolates
context and returns results mid-turn, so a helper could only add lower overhead,
less Chat clutter, and narrower powers.

**Answer.** Change, don't ship yet. The helper gave the same answer quality as
ordinary execution. It cut the parent's context growth by 3–7×, but on these
one-question tasks it cost 1.1–1.75× as much and took 1.3–2.3× as long. It beats
same-folder handoff on every measure: about half the cost and 60% of the latency,
with no extra Chat, request, title, or follow-up turn. Its savings only come back
in later turns of the same Chat, so it needs a cheaper reading model and a
multi-turn measurement before it earns a place in the shipped Worker.

## Setup

- **Runtime:** the real local API in-process (dev mode, disposable state and
  Pi folder), driven by `npm run work-fold:drive -- --attach`. Workers had a
  working `work-fold` CLI: the real macOS shim on `PATH`, an act token, and a
  stand-in app that forwarded requests to `WorkFoldDesktopCliHost`.
- **Model:** `openrouter/openai/gpt-6-luna`, thinking `high` (Mat's default),
  for every parent, child, and helper call. Included tools were not configured;
  no Extensions, Skills, or Worker instructions were added. Pi's built-in tools,
  including `codemode` and `tool_search`, were present. The Worker system prompt,
  including the operations guide, is about 64.7k characters (about 15.7k tokens).
- **Tasks:** four seeded folders, with known facts planted among realistic filler
  and near-miss distractors. Expected answers were kept in a file that was never
  copied into a work-folder.

| Task | Files | Bytes | What makes it hard |
|---|---|---|---|
| Office launch: the current Lisbon opening date, each change and its note, stale living docs | 40 | 95 KB | Site code `LIS` instead of "Lisbon"; Porto, Warsaw, and keys-handover dates as distractors |
| Travel policy: the current hotel caps and per diem, with sources; documents that state them wrongly | 19 | 40 KB | Base policy, amendments, and superseded addenda; an FAQ that is partly right |
| Rename survey: before renaming Orbit to Harbor, the customer-facing changes, mentions that must not change, and internal files | 32 | 44 KB | `Orbit Logistics` (a company), `ORBIT_API_KEY`, a planetary orbit |
| Export bug: who reported "export drops the last row", with versions and files | 29 | 67 KB | Five different phrasings; an import bug, a PDF bug, and praise as distractors |

- **Arms**, each run three times per task on fresh copies:
  - **a**: the question alone.
  - **b**: the question plus: *"This needs a lot of reading. Keep your own context
    small: hand the reading to a fresh Chat in this same work-folder with
    `work-fold chat handoff` (to this work-folder, without --file), tell it
    exactly what to find and what to report back, then `work-fold chat wait` for
    its result and answer me from that result."*
  - **c**: the helper enabled, plus the same hint naming the `helper` tool.
  - **c0**: the helper enabled, with no hint.
- **Measures:**
  - **Quality:** line-level checks against the hidden expectations; every answer
    was also read.
  - **Parent context growth:** the parent's prompt at its first model call
    compared with its last call's prompt plus output.
  - **Usage and cost:** every provider call was tapped, including Chat titles,
    child Chats, the helper, and the host's follow-up turns. Cost is what
    OpenRouter billed.
  - **Latency:** from sending the message to the parent's `done`.
  - **Stop:** measured separately.

## Results

Each cell gives the mean of three runs, with the range in brackets. Quality lists each run's score.

### Office launch

| Arm | Quality | Parent growth (tokens) | Prompt tokens | Output tokens | Cost | Latency |
|---|---|---|---|---|---|---|
| a | 6/6, 6/6, 6/6 | 16,982 (14,040–20,227) | 191,937 | 2,127 | $0.0067 (0.0060–0.0076) | 38 s (29–49) |
| b | 6/6, 6/6, 6/6 | 4,234 (4,180–4,290) | 426,407 | 8,656 | $0.0169 (0.0162–0.0178) | 94 s (86–106) |
| c | 6/6, 6/6, 6/6 | 2,450 (2,259–2,751) | 201,550 | 5,508 | $0.0117 (0.0090–0.0141) | 69 s (61–79) |
| c0 | 6/6, 6/6, 6/6 | 8,297 (5,482–11,839) | 292,135 | 5,038 | $0.0144 (0.0086–0.0188) | 66 s (53–75) |

### Travel policy

| Arm | Quality | Parent growth (tokens) | Prompt tokens | Output tokens | Cost | Latency |
|---|---|---|---|---|---|---|
| a | 8/8, 8/8, 8/8 | 10,345 (8,037–14,438) | 167,190 | 2,692 | $0.0060 (0.0052–0.0065) | 40 s (36–44) |
| b | 8/8, 8/8, 8/8 | 4,885 (4,774–5,072) | 393,772 | 11,945 | $0.0166 (0.0149–0.0180) | 110 s (81–128) |
| c | 8/8, 8/8, 8/8 | 2,107 (1,949–2,214) | 67,682 | 3,938 | $0.0064 (0.0062–0.0065) | 51 s (41–59) |
| c0 | 8/8, 8/8, 8/8 | 7,402 (5,685–8,519) | 138,300 | 4,711 | $0.0078 (0.0074–0.0080) | 62 s (57–71) |

### Rename survey

| Arm | Quality | Parent growth (tokens) | Prompt tokens | Output tokens | Cost | Latency |
|---|---|---|---|---|---|---|
| a | 8/8, 8/8, 8/8 | 10,581 (8,535–13,680) | 109,631 | 3,821 | $0.0059 (0.0055–0.0061) | 55 s (48–64) |
| b | 8/8, 8/8, 7.6/8 | 6,900 (5,939–7,768) | 435,816 | 20,738 | $0.0233 (0.0172–0.0265) | 163 s (110–214) |
| c | 8/8, 8/8, 8/8 | 3,589 (2,360–4,867) | 84,118 | 8,337 | $0.0089 (0.0078–0.0100) | 102 s (94–111) |
| c0 | 8/8, 8/8, 8/8 | 8,597 (5,850–11,187) | 96,982 | 8,399 | $0.0087 (0.0053–0.0124) | 92 s (46–141) |

In arm b, one child put `legal/terms.md` under "hold for legal review" rather
than "change". That is a defensible call, but the check docks it.

### Export bug

| Arm | Quality | Parent growth (tokens) | Prompt tokens | Output tokens | Cost | Latency |
|---|---|---|---|---|---|---|
| a | 5/5, 5/5, 5/5 | 6,298 (6,079–6,612) | 106,575 | 1,129 | $0.0041 (0.0039–0.0043) | 20 s (17–22) |
| b | **4/5**, 5/5, 5/5 | 3,627 (3,321–3,888) | 299,213 | 4,927 | $0.0115 (0.0103–0.0136) | 60 s (49–74) |
| c | 5/5, 5/5, 5/5 | 1,495 (1,289–1,816) | 68,402 | 2,951 | $0.0058 (0.0056–0.0061) | 45 s (34–58) |
| c0 | 5/5, 5/5, 5/5 | 7,257 (6,054–8,687) | 103,315 | 1,126 | $0.0042 (0.0041–0.0045) | 26 s (18–34) |

In arm b, one child Chat dropped a valid report ("the download is missing the
final line") as not specific enough, and the parent passed the omission on.

### Compared with arm a

| Arm | Parent growth | Cost | Latency | Quality |
|---|---|---|---|---|
| b, same-folder handoff | 0.25–0.65× | 2.5–4.0× | 2.5–3.0× | one miss in 12 runs |
| c, helper with hint | 0.14–0.34× | 1.07–1.75× | 1.3–2.3× | same as a |
| c0, helper without hint | 0.5–1.15× | 1.0–2.2× | 1.3–1.7× | same as a |

### Stop

Stop was pressed with the same conversation abort route the composer uses, on
the office-launch task, twice per arm:

- **a:** 10 s after sending.
- **b:** 5 s after the child Chat started.
- **c:** 5 s after the helper started.

| Arm | Parent settled after Stop | Whole request settled | Provider calls still running | What stopped |
|---|---|---|---|---|
| a | 136–173 ms | 181–182 ms | 0 | turn `aborted`, request `stopped` |
| b | 172–194 ms | 202–293 ms | 0 | parent and child requests both `stopped` |
| c | 124–191 ms | 156–285 ms | 0 | turn `aborted`; helper recorded `stopped` under it |

Deterministic tests cover the required ordering. With the helper's model call
held open, Stop makes the turn wait until the helper has unwound. The host's
final History checkpoint includes a file written during that unwind, and the
turn's reservation is still held while it runs. Both tests fail when the drain
is removed.

## Findings

1. **Workers already read efficiently.** In arm a, the Worker used grep and then
   targeted reads. On 40–95 KB folders its context grew by 6–17k tokens, against
   a 1M-token window and a 15.7k-token system prompt. These tasks never put the
   parent's context under pressure.
2. **Overhead is the real cost of same-folder handoff.** For each child Chat:
   - a cold 15.7k-token system prompt;
   - `work-fold help collaborate` and CLI round trips;
   - another Chat title call and History checkpoints;
   - every one of the 12 runs got a redundant host follow-up turn (see
     follow-ups), which posted the answer a second time and cost $0.0007–0.0026.

   Children also read exhaustively: 47–106k characters, against 21–61k for arm a.
3. **The helper keeps the isolation and drops most of the overhead.** The parent
   made just two model calls and received about 3–7k characters of result. The
   helper's own spend was 55–75% of each arm c run. It was thorough: 11–35 tool
   calls over 5–8 model calls, and its fresh context paid cache-write prices. That
   is why it cost more than arm a, where the parent read only what grep pointed
   to.
4. **Without a hint, Workers chose the helper in 8 of 12 runs.** They usually read
   some files themselves too, so growth fell only to 0.5–1.15× of arm a.
5. **Where the helper could pay back (an estimate, not measured).** Every later
   parent model call in the same Chat re-sends the extra context. The billed rates
   were $0.01/M for cache reads and about $0.125/M for cache writes. On that basis,
   the helper's extra cost is recovered after roughly 35–43 later model calls
   with a warm cache: 5 on travel policy, where it cost almost nothing extra. A
   Chat resumed after its cache expired re-writes that context, so about 3 cold
   resumes would also recover it. Arm a used 6–9 model calls per turn, so that is
   roughly 4–7 more turns. A one-question Chat never recovers it.
6. **Usage records undercount.** The usage tap shows that request and turn usage
   receipts leave out cache-read and cache-write tokens and their cost. Pi's
   `stats.tokens.input` excludes them, and the OpenRouter catalog entry prices
   cache at $0. One smoke turn was recorded as 6 input tokens and $0.000013; it
   was billed for 31k prompt tokens and $0.0021. Helper records inherit the same
   gap. Every comparison here uses billed cost instead.

## Recommendation: change

- **Don't ship the helper to Workers yet.** On one-question reading tasks it adds
  cost and latency and does not improve answers.
- **Prefer this shape over same-folder handoff for read-only delegation.** Handoff
  was dominated on every measure. Don't teach Workers to use handoff to keep their
  context small.
- **Before deciding to ship, change two things and measure again:**
  1. Run the helper on a cheaper, faster reading model, chosen like the image
     model. The helper is most of arm c's spend, so this is the main lever.
     Optionally, tell it to stop once its evidence is sufficient.
  2. Measure what the helper is actually for: multi-turn Chats, where later turns
     pay for a grown context, and corpora 10–100× larger, where arm a's context
     would grow beyond its 6–17k tokens. Include a smaller-context model.

## Follow-ups found along the way

Each of these is independent of the helper.

- **Redundant follow-up turn after `chat wait`.** Reading a child's result through
  `chat wait` or `chat result` does not record it as delivered. Only
  `noteChildDelivery`, for results admitted into a turn's context, does. So
  `maybeStartRequestContinuation` starts a synthesis turn after the parent has
  already answered, and the Chat shows the answer twice. This probably also
  affects the work-fold agent's `chat send --parent-task` plus `agent wait`
  pattern.
- **Usage undercount** (finding 6). Turn and request usage should include
  cache-read and cache-write tokens, and cost should come from what the provider
  billed when it reports that.
- **Workers can see `.work-fold/` with their own tools.** Pi's grep and find pass
  `--hidden`, and `ls -la` lists hidden folders. In about half of the arm a and
  arm b sessions, `.work-fold/conversations/*.jsonl` showed up in tool output. In
  two handoff runs, grep matched text inside those transcripts, and one child
  listed them in its answer. For a same-folder child, that includes the transcript
  of the Chat that delegated to it. The helper's path policy refuses these files.

## Prototype

These files are on the branch:

- [`src/local/agent/helper-tool.ts`](../../src/local/agent/helper-tool.ts) holds
  the helper. It is registered beside `createImageGenerationTool` in
  [`pi-client.ts`](../../src/local/agent/pi-client.ts), for Worker scopes only,
  when `WORKFOLD_DEV_HELPER_TOOL=1`.
- [`tests/helper-tool.test.ts`](../../tests/helper-tool.test.ts) has 9 tests
  covering path enforcement, the helper inside a real Pi turn with a faux model,
  usage roll-up, and Stop ordering at the client and host.

What the helper enforces:

- **Read-only tools.** Pi's own `read` runs with scoped file operations; `grep`,
  `find`, and `ls` are written in Node so traversal is confined. There is no
  bash, edit, write, Extension, Skill, MCP, `codemode`, web, Chrome, Computer
  Control, or helper-in-helper.
- **Real-path scope.** Every path resolves to its real path inside the
  work-folder root, and `containsReservedWorkFolderPathSegment` is applied after
  resolution, so links out, `..`, `~`, and links into `.work-fold` are refused.
  Traversal never follows links, and it skips `.git` and `node_modules`. It does
  not apply `.gitignore`.
- **Parent's model and transport.** The helper runs through
  `session.agent.streamFunction`, as Chat titles and Checks do, with the parent's
  model and thinking level, and with the person's Worker instructions only.
- **The parent chooses the input.** The helper gets only the task text and the
  paths the parent chose, never the parent's transcript.
- **One result shape.** It returns F29 through `parseWorkFoldResultEnvelope`:
  named files get digests, and `partial` says what is missing.
- **No Chat or request record.** The run is recorded on the durable turn record
  (`helpers`: id, outcome, model calls, usage, and activity). Its usage rides on
  the tool result, so Pi counts it in the turn and request totals, which matched
  the billed output exactly. A stopped helper's spend is added to the turn
  explicitly.
- **Stop drains it.** Stop aborts every helper, and the client drains them before
  `prompt()` settles. The host's final History checkpoint and reservation release
  both come after that.

Not done:

- The helper's activity is not streamed to the Chat UI.
- There is no per-helper model choice.
- A time-of-check/time-of-use race between `realpath` and the read is possible.
  It is acceptable for a development flag, not for shipping.

## Reproduce

The harness is in `scripts/helper-eval/`. Outputs go to the ignored `out/`
folder. Use Node 24.

1. Create the fixtures:

   ```sh
   npx tsx scripts/helper-eval/fixtures.ts out/helper-eval/fixtures
   ```

2. Start a host. The provider key is read from the environment and never written.
   Add `WORKFOLD_DEV_HELPER_TOOL=1` for arms c and c0:

   ```sh
   OPENROUTER_API_KEY=... npx tsx scripts/helper-eval/host.ts --out out/helper-eval/run1/office-launch
   ```

3. Run one task and arm. Repeat for each task, arm (`a`, `b`, `c`, `c0`), and
   rep. Add `--stop-after <s>` (and `--stop-when-child`) for the Stop runs:

   ```sh
   npx tsx scripts/helper-eval/run.ts --eval out/helper-eval/run1/office-launch --fixtures out/helper-eval/fixtures --task office-launch --arm c --rep 1
   ```

4. Score the runs and print the answers:

   ```sh
   npx tsx scripts/helper-eval/score.ts --fixtures out/helper-eval/fixtures out/helper-eval/run1 --answers
   ```

The 48 measured runs cost $0.48 in total; the Stop runs cost $0.02. These are
three runs per cell with one model, so treat the results as observations, not
success rates.
