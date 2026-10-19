# Development

Start with [Contributing](../CONTRIBUTING.md). [AGENTS.md](../AGENTS.md) owns the
contributor rules; this guide explains how to run and navigate the checkout.

## Choose a development surface

Run commands from the repository root with Node 24 (`.nvmrc`) and npm 11.16.0
or newer. The install requirement and dependency-script policy are explained
in [Contributing](../CONTRIBUTING.md#first-run). `npm ci` uses the
committed lockfile. Git, Node, and npm are enough to run the repository checks;
model credentials, Apple signing credentials, and Railway access are separate.

| Surface | Command | What to expect |
|---|---|---|
| Browser UI + local API | `npm run local:dev` | Vite at `http://localhost:5173`, local API at `http://127.0.0.1:4327`; live renderer updates |
| Native, unpackaged Electron | `npm run desktop:smoke` | Builds and verifies the desktop, then opens Electron; restart after native changes |
| Optional hosted relay | See [Bridge development](../services/bridge/README.md#local-development) | Separate dependencies and local PostgreSQL; unnecessary for ordinary desktop work |
| Packaged Mac candidate | See [Mac build lanes](macos-build.md) | Packaging, signing, and publication are separate from everyday development |

The browser preview cannot prove native dialogs, secure storage, preloads, or
restricted-app WebContentsView behavior. Use the native lane for those changes.
`desktop:prepare` alone builds and runs automated probes; it does not launch the
normal interactive app or create an installer.

## Development state and model access

The browser/local API and unpackaged Electron default to **work-fold
Development** application data, separate from the installed app. They can
share that development profile. Run one development host at a time against a
given profile, and use disposable folders for tests that change files.
An existing folder remains a real folder, even in a development build.

Pi's personal capabilities and auth can still be shared with your normal Pi
configuration. To use separate app and Pi data, choose an explicit temporary
profile in your shell before launching either development surface:

```sh
workfold_dev_root=$(mktemp -d "${TMPDIR:-/tmp}/work-fold-dev.XXXXXX")
export WORKFOLD_STATE_DIR="$workfold_dev_root/state"
export WORKFOLD_DESKTOP_STATE_DIR="$workfold_dev_root/state"
export WORKFOLD_AGENT_DIR="$workfold_dev_root/pi"
npm run local:dev
```

Use `npm run desktop:smoke` in place of the last command for Electron. The
variables apply to this shell and its children. Stop the host before removing
its temporary profile; keep test folders you want to retain. A data-directory
override does **not** isolate macOS Keychain. A signed Mac candidate uses the
production identity by default—follow the [candidate guidance](macos-build.md#interactive-packaged-smoke)
before launching one.

Real Worker and work-fold agent turns need a model provider and may incur
charges. The browser development host and unpackaged desktop load the root
`.env` when present; already-exported variables win. Copy [the optional template](../.env.example)
only if you need it, and uncomment only the settings you intend to use.
`WORKFOLD_AGENT_DIR` selects work-fold's Pi directory; the native Pi variable
`PI_CODING_AGENT_DIR` is also supported. `PI_AGENT_DIR` is not supported.

The installed `work-fold ... --json` CLI addresses the running app.
`npm run work-fold:drive` is a separate real-Pi-turn test driver and can use a
chosen agent directory; it is not an offline unit test. `--follow-ups <n>` keeps
its local API running for n more turns work-fold starts in the same Chat, such as
a [background job](background-jobs.md)'s wake-up, and reports each with the
message that started it. See
[the work-fold agent and CLI](work-fold-agent-and-cli.md) before driving real work.

## Inspect a model request

For an installed Mac build, run:

```sh
open -n -a /Applications/work-fold.app --args --work-fold-inspect-context
```

The same command opens or focuses a separate inspector when work-fold is
already running. It uses the existing single-instance host and never enables
recording automatically. Close or Escape closes just the inspector window;
turn recording off explicitly when finished, or quit work-fold to discard it.
During browser development, open the local renderer with `?dev-context`
(for example, `http://localhost:5173/?dev-context` at Vite's default port).
This is a developer diagnostic route, with no normal Chat, work-fold agent or
Settings entry. Enable **Record model context**, reproduce the behavior in the
app, then refresh and choose the request. The all-request view includes Worker
and work-fold agent turns, titles, Checks, app inference and compaction. Search or copy assembled context, compare
provider payloads where the adapter exposes them, and inspect provenance from
the loaded runtime: source paths, instruction digests, Skills, Extensions and
tools. These facts are captured at dispatch, not reconstructed from later file
contents. Inspection itself never starts a model request.

Recording starts off, covers future calls through work-fold's native Pi
transport, and keeps bounded snapshots in memory for up to 30 minutes. Images
appear as metadata. Text may contain private content; review it before sharing
a copied snapshot. **Clear all** discards captures while recording continues;
turning recording off clears them and stops capture. Independent transports
inside Extensions are outside this observer. See [the feedback contract](tool-feedback.md#inspect-model-context)
for capture stages, coverage and bounds.

## Source map

| Path | Responsibility |
|---|---|
| `web-local/src/` | React UI, client state, styles, and inert UI fixtures |
| `src/local/server.ts` | Local API routes and domain-service composition |
| `src/local/agent/` | Pi integration, Chat turns, app services, and brokers |
| `src/local/work-folder*.ts` | work-folder registration, path policy, ignore rules, watching, and appearance |
| `src/local/checks/`, `src/local/automations/`, `src/local/requests/` | Checks, Automations, and durable request records |
| `src/local/overview.ts`, `src/local/work-fold-agent-*.ts` | The work-fold agent's overview, attachments, and instructions |
| [Kernel](../src/local/work-fold-kernel.ts), [CLI](../src/local/cli/), [adapter](../src/local/work-fold-cli-adapter.ts) | Shared context, tasks, and control-plane contracts |
| `src/shared/` | Shared types and the product identity contract |
| `desktop/src/` | Electron windows, lifecycle, preloads, native app hosts, and updater |
| `services/bridge/` | Relay, database, public website, and browser client |
| `tests/`, `services/bridge/*.test.mjs` | Application and bridge regression tests |
| `scripts/` | Shared development, validation, and release commands |
| `docs/`, `.agents/skills/` | Product contracts and task-specific contributor workflows |

Use the [docs map](README.md) to distinguish current contracts from proposals
and dated release evidence. Files in `docs/reference-skills/` are examples;
app-generated work-fold agent instructions are runtime resources. Neither is an
extra repository instruction source.

## Verification

- `npm run repo:check` runs without installed dependencies or network access.
  It includes new, non-ignored files, so it is useful before staging a change.
  It verifies shared files and paths, not model obedience or personal settings.
- `npm run check` runs repository hygiene plus both TypeScript checks.
- `npm test` runs the application suite. While editing, run a focused file with
  `npm test -- tests/documentation-contract.test.ts`, substituting the relevant
  test files. Use the full suite before handing off behavior changes.
  The runner can divide the discovered test files into four disjoint shards;
  run one with `npm test -- --shard=1/4` (through `4/4`). Every file belongs to exactly
  one shard; an unsharded `npm test` still runs everything.
- Tests never use your real Pi folder. The runner points `PI_CODING_AGENT_DIR`
  at a temporary folder for every test process, so no test reads your
  provider credentials or writes sessions, settings, or locks into `~/.pi`, and
  it fails the run and names the test file if anything still changes the real
  folder. Running a test file directly with `node --import tsx --test` skips
  that isolation; use `npm test -- <file>` instead.
- `npm ci --prefix services/bridge` and `npm test --prefix services/bridge` run
  the bridge suite. It uses an in-memory test database; a live PostgreSQL server
  or Railway account is not required for those tests.
- `npm run desktop:prepare` verifies desktop resources, compiled code, native
  preloads, and the real restricted-app sandbox. After a compiled native change,
  `npm run desktop:restricted-app:smoke` is the focused sandbox probe.

GitHub Actions is disabled in the canonical source repository as of September
30, 2026. Pushes, PRs, and release tags do not run remote checks. The checked-in
CI and source-tag workflows remain dormant diagnostics; use local verification
and do not re-enable Actions unless explicitly requested.

Public Mac releases use `npm run desktop:release:mac:check` on the final clean,
committed release SHA with Node 24, supported npm, and Google Chrome on an
Apple-silicon Mac. Chrome runs the real CSS tests. This performs fresh
root and bridge installs, `check`, the complete unsharded `npm test`, bridge
tests, and `desktop:prepare`, then saves an ignored receipt at
`out/release-checks/local-verification.json`. It records the exact source SHA,
tree, build-input fingerprint, runtime, and successful stages; starting or
failing a run invalidates the old receipt, and source changes during the run
fail verification. `npm run desktop:release:mac:check -- --status` checks that
receipt without running the stages. A receipt cannot carry across a merge or
other commit change, even when the tree matches. The full signed build must
start after that check succeeds; a fresh check reinstalls dependencies and
requires a subsequent fresh build. Publication verifies matching Node/npm and
dependency state, including hidden lockfile hashes. A shared per-worktree lock
serializes local checks, all macOS builds, and publication so installation or
preparation cannot race packaging. Test-filter environment flags cannot narrow
the release check. GitHub Actions status is not a publication dependency. See
the [release runbook](macos-release.md).

Async tests should wait on the owned completion signal and verify persistence
separately. Avoid arbitrary sleeps or assuming a journal write appears within
one event-loop turn. When using a fake clock, advance it as async continuations
settle so newly armed timers can run.

## Agent setup and shared Skills

Launch your coding agent from the repository root. Codex reads `AGENTS.md`;
Claude Code reads the root `CLAUDE.md`, whose `@AGENTS.md` import loads the same
contract. Other shell-capable agents can read `AGENTS.md` explicitly and use the
same npm commands. No project-specific plugin or private config is required.

Confirm the instruction sources in a new session. Ask Codex which instruction
files it loaded; in Claude Code, `/context` lists its memory files. Global and
machine-local settings can add instructions or override skill discovery, so
this repository can verify its shared files, not guarantee identical behavior
across personal harness configurations.

Shared workflows have one source at `.agents/skills/<name>/SKILL.md`. Each has
one tracked link at `.claude/skills/<name>` pointing to that directory. There is
no `.agent/` contract. Root `CLAUDE.md` stays an import shim; `.claude/rules/`,
`.claude/agents/`, launch settings, and `.codex/` are not additional shared policy.

To add a shared Skill, author it under `.agents/skills/`, then run from the root
(replace `my-skill` with its name):

```sh
ln -s ../../.agents/skills/my-skill .claude/skills/my-skill
```

Add `!/.claude/skills/my-skill` to the allowlist in `.gitignore`, run
`npm run repo:check`, and commit the source and link together. Edit the canonical
source when updating it. The optional `agents/openai.yaml` is discovery/UI
metadata, not a second workflow. Never copy the Skill into the Claude directory.
Git must preserve symlinks; a flattened link is diagnosed by `repo:check`.

Loading conventions verified against [Codex instructions](https://developers.openai.com/codex/guides/agents-md),
[Codex Skills](https://developers.openai.com/codex/skills),
[Claude memory](https://code.claude.com/docs/en/memory#agentsmd), and
[Claude Skills](https://code.claude.com/docs/en/skills#where-skills-live).
Repository behavior remains defined by `AGENTS.md`.


## Focused harness evaluation

Before proposing a new runtime layer, exercise ordinary content work with the
existing real-Pi driver in disposable work-folders. Keep app state, Pi resources and
reference fixtures separate as above; an isolated profile is not an OS sandbox.
The installed CLI addresses its running desktop host, so do not accidentally point
a development Worker at production CLI commands. Tests needing that lane
must supply a matching development broker/host. `work-fold:drive` alone does not
start the installed desktop's CLI broker.

Useful repeatable cases are narrow edits across prose and a guide with unrelated
bytes held out; CSV reconciliation with duplicates, refunds and separate currencies;
a small code repair against independent inputs; and a fresh-Chat comparison of a
saved file with current bytes. Seed known before/after files and keep expected outputs
outside model context. Check final claims as well as file bytes: a correct calculation
can still have an incorrect explanation. Record model, reasoning level, instructions,
resources and starting bytes, and change one factor at a time. Tool counts are
observations, not pass criteria. Keep live-provider results separate from deterministic
regressions and do not report one run as a measured success rate.

The deterministic harness coverage now includes `local-history-review`,
`work-fold-history-review-adapters`, `conversation-context-office`, `chat-presentation`,
`history-comparison-ui`, `history-comparison-keyboard`, and `work-fold-turn-store`
test files. They cover scope, completeness, persistence and UI behavior without
requiring a paid model or production user data.

## Real-model harness acceptance

`npm run harness:autonomous -- --model openrouter/openai/gpt-6-luna --case
research --out out/autonomous-eval/research-luna` runs an outcome-based live
case in an isolated profile with an explicitly supplied `OPENROUTER_API_KEY`.
Cases are `research` (confirmed saved-edit loss with exact quotes), `reconcile`
(a policy question and a source correction), and `repair` (a validated patch
while preserving original and uncommitted files). Prompts specify deliverables
and constraints without naming tools or ordering execution. The driver answers
person-directed questions through the real CLI; parent questions remain the
parent's responsibility. Independent checks grade final bytes, source
preservation and request settlement; tool choices, compactions, recovery use,
cost and duration are observations. No tool count is required for a pass.

Each fresh output directory preserves the exact prompt, its digest, source
commit and diff digest, hidden fixture expectations, native journals, provider
usage and result. `--verify --out <saved-directory>` checks saved evidence
without another model call. Preserve failed runs and freeze prompts before
comparing models; repeated coached attempts do not establish an autonomous
success rate. The live cases are separate from deterministic regression tests.
Without compaction flags the autonomous driver uses native Pi settings (the
normal model window, 16,384 reserved tokens and 20,000 recent tokens in Pi
1.1.0). Earlier versions of this driver silently forced a 40,000-token trigger;
do not label those runs production-default context trials.
For a context-pressure variant, keep the same prompt and add `--compact-at
18000 --keep-recent 2000`; the host records those explicit compaction settings.
This is a stress configuration, not the production default.

For repeated first-attempt comparisons, commit the evaluator, then create an
immutable plan with `npm run harness:repeat -- --create-plan
out/frozen-eval/plan.json --repetitions 3`. It freezes the three cases, prompts,
answers, expected results, source-file hashes, evaluator files, dependency
lockfile, Node runtime and a copied model catalog. The 36 interleaved trials use
GLM 5.3 and GPT-6 Luna at high reasoning, both normal and stressed settings,
with three concurrent disposable hosts. Hosted model weights and provider
routing are outside this client-side freeze.

With `OPENROUTER_API_KEY` explicitly supplied, run `npm run harness:repeat --
--plan out/frozen-eval/plan.json --out out/frozen-eval/baseline`. Every phase
requires clean committed source and a fresh output directory, refuses changed
evaluation inputs, and preserves each attempt, including failures. Make product
fixes only between phases, commit them, then use the same plan and a new output
directory. `results.json` records every trial and aggregates each model/case/
context cell; no failed attempt is replaced by a retry. Source changes while a
phase is running invalidate it. Exact repeated reads with unchanged bracketed
fingerprints and repeated helper arguments are diagnostic proxies, not proof
that the work was unnecessary. A Done request with failing independent artifact
checks is flagged separately for review of its completion claims. Inspect
explanations as well as machine-graded bytes. Three repetitions per cell provide
an initial signal, not a precise production success-rate estimate.

`npm run harness:check` checks the evaluation scripts without making model
requests; it is also part of `npm run check`.
Use `npm run harness:eval -- --verify --out <saved-directory> --helper-model
<the-original-helper-model>` to recheck saved evidence without model calls.
Verification resolves files from the host's working-copy identities and stops
the evaluation's own service if it is still running.

With `OPENROUTER_API_KEY` explicitly provided, run `npm run harness:eval --
--model openrouter/openai/gpt-6-luna --helper-model
openrouter/deepseek/deepseek-v4.1-flash --out out/harness-eval/luna`. This spends
real model credit. Use a fresh output directory for each run. It starts the
isolated development host, uses disposable Git folders, answers the model
question through the real CLI while the turn runs, and verifies structured
collaboration, narrow helpers, PTY input, service lifetime, working-copy
isolation/archive/recovery, and one answer continuation from native records.
It never reads personal provider credentials, installs an app, merges code, or
replays old jobs. Output includes provider usage, sessions, journals and an
independently checked summary. Host shutdown stops leftover processes.
