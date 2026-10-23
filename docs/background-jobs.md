# Background jobs

> **Status:** Accepted 2026-10-18 (owner decision) and built. It extends
> [the collaboration contract](collaboration-contract.md) (F25–F30) under
> [Receipts, not gates](receipts-not-gates.md); where they differ, those
> records govern. `src/local/jobs/`, `src/local/agent/job-tools.ts`, the
> `jobs` act verbs, and their suites are the implementation authority.

A Worker or the work-fold agent starts a shell command, keeps working or ends
its turn, and is woken with the result when the command exits. Exports,
conversions, installs, builds, test suites, and servers stop holding a turn
open, and a Chat stops going quiet while something long runs.

## What exists and what is missing

Pi's `bash` tool (`@earendil-works/pi-coding-agent` 1.1.0) takes `command`
and `timeout` and blocks the turn until the command exits. Codemode runs
several tools at once, but its script still blocks the turn. A Worker
therefore either waits out a 40-minute export or kills it with a timeout.

The host already starts one deterministic follow-up turn in an idle Chat when a
request's delegated children settle (F28), records which results it delivered
so none is delivered twice, never replays after a restart, and fences
continuation behind Stop. A finished job uses that path instead of a new one.

## Register entries

| # | Decision | What it does not change |
|---|---|---|
| F31 | **A background job belongs to the turn that started it.** A job is one shell command started by a running Worker or work-fold agent turn. It joins that turn's request: while it runs, the request reads `working`, so `chat wait`, the work line, the overview, Stop, and settled deletion treat it as outstanding work. A job record is journaled before the process starts, executes at most once, and is never re-run: a restart records a running job as `interrupted`. | Pi's `bash` tool stays as it is and remains the right tool for short commands. Turn acceptance, one turn per Chat, and History's turn checkpoints are unchanged. |
| F32 | **A finished job wakes its Chat once.** A job's end is delivered exactly once: to a turn in its Chat that reads it, to the next turn that starts in that Chat, or else in one host follow-up turn joined to the job's request when the Chat is idle. The follow-up carries the exit status, how long it ran, its History coverage, and the end of its output. It is the F28 continuation, so it follows Stop fences, the Limits switch that turns continuations off, and "restart never replays". | No busy-wait, no held turn, no polling loop. Nothing wakes a Chat for a job that settled before a restart. |
| F33 | **Job output stays machine-local.** Combined output is kept under the state root (`jobs/`), never in the work-folder, and is removed with the request retention window. Only what a turn reads or what the follow-up turn carries enters the Chat. | `.work-fold/` and `.pi/` stay untouched. A job's own writes are ordinary file changes in whatever folder it writes to. |

## Surface

One job service in the local API backs two surfaces with the same records,
refusals, and receipts.

### Tools in every Chat

Three Pi custom tools, registered beside `generate_image` in
`src/local/agent/pi-client.ts`, for Workers and the work-fold agent alike. The
tool knows its own turn, work-folder, and Chat, so it needs no ids or flags.

| Tool | Parameters | Returns |
|---|---|---|
| `job_start` | `command`; optional `name` (a short label the person sees), `cwd` (default: the Chat's folder), `timeout` (seconds; none by default), `wait` (seconds to wait before returning; default 3), `until` (a pattern; return as soon as the output matches it) | The job id, its state, and the output so far. A command that finishes inside `wait` returns exactly like `bash`, and its end counts as delivered. |
| `job_output` | optional `job` (omitted: list this Chat's jobs); `wait` (seconds to wait for the job to end); `until` (a pattern); `offset` and `limit` (lines, to page from the start); otherwise the end of the output | State, exit code, running time, total lines and bytes, `nextOffset` for incremental reads, and the requested text. |
| `job_stop` | `job` | The final state and the end of the output. |

`wait` and `until` let a turn that has nothing else to do wait in place for a
command that should finish soon, or for a server's "ready" line, without
another round trip. Stop interrupts the wait. The output text uses Pi's own
`bash` bounds: the last 2,000 lines or 50 KB per read, whichever is smaller,
with ANSI escapes and control characters removed.

### `work-fold jobs` on the CLI

The same operations as act-lane verbs, so codemode, a Worker's shell, and the
work-fold agent can drive Workers' jobs with receipts:

```
work-fold jobs start  --work-folder <id> --task <own-task-id> (--command "<cmd>" | --command-file <path>) [--name "<label>"] [--cwd <path>] [--timeout <s>] --json
work-fold jobs list   --work-folder <id> [--conversation <id>] [--running] --json
work-fold jobs show   --work-folder <id> --job <id> --json
work-fold jobs output --work-folder <id> --job <id> [--offset <line>] [--limit <lines>] [--wait <s>] [--until "<pattern>"] [--task <own-task-id>] --json
work-fold jobs stop   --work-folder <id> --job <id> [--parent-task <id>] --json
```

- `start` and `stop` are receipted, journal-first act verbs and join the
  request's action trail as `jobs.start` and `jobs.stop`. `start` requires
  `--task` to be the caller's own running turn, as `chat report` does.
- `list`, `show`, and `output` are act reads. A job is readable only through
  its own work-folder. A read counts as delivery only when `--task` names the
  reader's running turn in the job's own Chat; `jobs stop` takes no `--task`,
  so a job stopped from the CLI still wakes its Chat once.
- The work-fold agent reaches its own jobs through the tools; `requests show`
  lists them. The work-fold agent can read and stop any Worker's job through
  `--work-folder`.
- The tool path writes the same job journal and request action, so both
  surfaces leave the same record.

## Lifecycle

A job record carries its id (`job-<yyyymmddhhmmss>-<8 hex>`), work-folder (absent
for the work-fold agent), Chat, starting task, request, name, command, folder,
start and end times, process id, exit code or signal, output size, History
coverage, delivery, and state:

`accepted` → `running` → `exited` | `stopped` | `timed_out` | `failed` (could
not start) | `interrupted` (work-fold closed or restarted first).

- **Start.** The `accepted` record is written before the process is spawned;
  an unwritable journal refuses. The command runs through Pi's own shell
  configuration and environment with stdin closed, in its own process group,
  with `WORKFOLD_JOB_ID` set. A kernel task record (`job`, experimental like
  `check_run`, outside the stable `work-fold.tasks` v1 projection) lives while it runs.
- **Turn end.** The starting turn ends normally; the job keeps running. The
  turn's post-turn History checkpoint covers what the job wrote by then.
- **Shell exit.** On macOS and other POSIX hosts, remaining processes in the
  job's process group receive SIGTERM, then SIGKILL after the same grace
  period used by Stop. The job stays live until that group has drained,
  before History capture and request settlement; a shell's background child
  cannot keep writing after its job is reported finished.
- **Stop.** Stopping a request (the Chat's Stop, the work line's Stop, `agent
  stop`, a paired browser, or an App's cancel) stops every running job of that
  request and its descendants: SIGTERM to the process group, then SIGKILL after
  5 seconds. `job_stop` and `jobs stop` stop one job the same way. Stopping a
  newer, unrelated request in the same Chat does not stop an older request's job.
- **Quit and restart.** Quitting work-fold stops every running job the same
  way and records it `interrupted`; close-to-tray, sleep, and tab switches do
  not. A synchronous exit handler kills the process groups if the app exits
  abruptly. On the next start, any job still `accepted` or `running` is recorded
  `interrupted`; if its process group leader is still alive with the recorded
  start time, it is killed. An interrupted job makes its request read
  `failed`, is never re-run, and never wakes its Chat.
- **Deletion and restore.** A running job keeps its request unfinished, so
  deleting its Chat, a file in its work-folder, or the work-folder refuses
  until the job ends or is stopped, as settled deletion already does for
  turns, and a job a Stop is still ending keeps it unfinished until it has.
  Removing the work-folder's registration and restoring the whole
  work-folder from History refuse while a job runs in it; the restore
  refusal names the job. Installing, updating, or removing Skills &
  Extensions does not wait for jobs: a shell process loads no Pi resources.

## Wake-up

When a job ends, the host records it, captures History, and then evaluates
delivery on the same settle chain as turn settles. The job's reference on
its request settles only after that decision, so a request whose follow-up
is reserved never reads `done` in between:

1. If a turn in the job's Chat has already read its end, nothing more happens.
2. If a turn is running in that Chat, it can read the job directly. When that
   turn ends, the job is still undelivered, and the Chat is idle, step 4 applies.
3. When a new turn starts in that Chat (the person's message, an answer, a
   handoff), its hidden turn context lists the Chat's running jobs and every
   undelivered finished job with its exit status, and those are delivered.
4. Otherwise, once the Chat is idle and not compacting, the job's request is
   not stopped, and no question of that request is waiting for an answer, the
   host reserves one continuation (recording the job ids as delivered) and starts
   one `system`-actor turn joined to the job's request. Jobs that end together,
   and children that settled at the same time, share one follow-up.

The follow-up message is deterministic and needs no model call:

```text
work-fold is continuing request req-…: a background job this Chat started has finished. Nobody typed this message.

- Job job-… "Build the site" — exited with code 1 after 6 min 12 s
  command: npm run build
  History: saved checkpoint … after it finished (1,204 files; 2 skipped as too large)
  output: 18,233 lines (2.1 MB); the last 2,000 lines follow. Read more with job_output.

<last 2,000 lines or 50 KB of output, fenced>

Continue the work this job was part of, using job_output for more of its output. …
```

A request with a job that never exits (a dev server) stays `working` until the
job is stopped. Its parent still receives the Worker's report when the Worker's
turn ends (F28 already delivers settled child turns), but reads `handed_off`
rather than `done` while the server runs.

## History

The turn's final checkpoint is taken before a background job finishes, so a
job's later writes would be uncovered. When a work-folder job ends, the host
attempts a full History capture of that work-folder (label
`After background job: <name>`) and records its real coverage on the job:
the checkpoint id, files kept, and files skipped by reason, or why no capture
was possible. Identical content reuses the existing checkpoint. The follow-up
message, `job_output`, and `jobs show` report that coverage as it is. Jobs
of the work-fold agent have no History of their own; their record says so,
and the work-fold agent's instructions say to take `history save` in a
work-folder it changed through a job.

## Storage and bounds

```
<state root>/jobs/jobs.jsonl          job records, compacted like requests.jsonl
<state root>/jobs/<job id>/output.log combined stdout and stderr
<state root>/jobs/<job id>/output.1.log the previous segment after rotation
```

Bounds are resource guards sized so ordinary work never meets them, shown in
Settings → Automations → Limits:

| Bound | Value | On hit |
|---|---|---|
| Running time | none by default; `timeout` sets one | `timed_out`, the process group is stopped |
| Output kept per job | 1 GiB (two 512 MiB segments; the oldest is dropped when a third begins) | the job keeps running; the record says how much early output was dropped |
| Text per read and in the follow-up | last 2,000 lines or 50 KB, Pi's `bash` bounds | the rest stays readable with `offset` and `limit` |
| Running jobs on this computer | 256 | `job_start` is refused and names the number |
| Command text | 1 MiB | refused before anything is recorded |
| Retention | the request retention window (30 days) after the job ends | the record and its output are removed |

A start reserves its running slot before its first asynchronous check, so
concurrent starts cannot exceed the bound. Refused or failed starts release
their slots, and a live process group holds its slot until it drains.

## Teaching

The Worker operations guide and the work-fold agent instructions gain one
rule, stated once: *use `job_start` for anything that may take more than a
couple of minutes, or whose partial output decides the next step; use `bash`
for everything else.* Around it they say: after starting a job, keep working
or finish the turn and say what is running — work-fold brings its result back
to this Chat once; never poll in a loop or sleep; use `wait`/`until` only when
there is nothing else to do and the result is close; read a job a turn
context lists when it bears on the request; stop servers you started when the
work is done.

## Visibility

- The work line shows **Running in the background** with the job's name and
  running time while the request's only outstanding work is jobs, and keeps
  Stop available.
- A job tool call renders in the Chat's work trail like any other tool.
- Settings → Automations → Limits lists the job bounds, and its one switch
  ("Continue requests when handed-out work or background jobs finish") also
  turns job follow-ups off; a finished job then reaches the next turn's
  context instead.
- `requests show` and the request record list their jobs; `jobs list`
  lists a work-folder's.

Interactive terminals (`interactive`, `job_input`) and services (`service`)
are now supported by the same job service; see [Worker tools](worker-tools.md).

## Not in this version

- Notifications when a job ends, and a dedicated jobs panel. (A running job's
  announced local address, such as a dev server's `http://localhost:5173/`, is
  reported by `job_start`, `job_output`, and `jobs show` as `serving` while it
  runs; see [Built-in browser](built-in-browser.md).)
- CLI access to the work-fold agent's own jobs (it uses the tools).

## Owner decisions (2026-10-18)

1. **Name.** **Background job** in the interface, `jobs` on the CLI,
   `job_start`/`job_output`/`job_stop` as tools. ("Command" collides with
   "the `work-fold` command"; "task" is already the turn id.)
2. **Capability mutations do not wait.** Deletion, registration removal,
   and whole-work-folder History restore wait for a running job; installing,
   updating, or removing Skills & Extensions does not. A shell process does
   not load Pi resources, and a dev server would otherwise block installs for
   hours.
3. **`job_start` waits 3 seconds by default**, so a typo or a missing
   program comes back in the same call; `wait: 0` returns at once.

## Build and acceptance

1. Job store and records (`src/local/jobs/`), state paths, retention, and
   restart reconciliation before request reconciliation.
2. Job service: spawn, output files and rotation, reads, stop, timeout, quit,
   History capture, kernel task.
3. Request integration: job refs and delivered job ids on the request record,
   the `working`/`failed` rules, Stop, settled deletion, registration removal,
   restore fence, and the follow-up composer beside `composeContinuationMessage`.
4. The three tools, turn-context listing, and the `jobs` act family with help,
   shims, ledger, and receipts.
5. Teaching text, the work line label, and the docs that carry these contracts
   (this one, the collaboration contract, the CLI guide, the act ledger, README,
   SECURITY, PRIVACY).

`tests/background-job-service.test.ts` covers the service on real processes:
start, exit, History and settle ports, `until`, process-group stop, timeout,
paging, line-boundary segment rotation, the running bound, refusals, quit,
restart reconciliation with provable-identity reaping, single delivery, and
retention. `tests/background-jobs-journey.test.ts` drives real turns on a
scripted provider: the one follow-up with exit, History, and output; delivery
by a read and by the next turn's context; request Stop with deletion waiting;
the restore fence; quit and restart without a wake-up; and the work-fold
agent's own jobs and scope. `tests/work-fold-cli-jobs-verbs.test.ts` runs the
`jobs` family through the real executor and facade inside a held turn.

Real turn, 2026-10-18 (`npm run work-fold:drive -- --follow-ups 1`, OpenRouter
`openai/gpt-6-luna`, disposable folder): asked to run a 40-second command
without waiting, the Worker called `job_start` and ended its turn; 40 seconds
later one follow-up turn arrived carrying exit code 0, a History checkpoint
covering the file the command wrote, and its output line, and the Worker
reported that line. Nothing was re-run and no second follow-up started.
