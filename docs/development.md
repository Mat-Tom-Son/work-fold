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
| Native Electron, already prepared | `npm start` | Opens the existing development build without rebuilding helpers or creating packages |
| Optional hosted relay | See [Bridge development](../services/bridge/README.md#local-development) | Separate dependencies and local PostgreSQL; unnecessary for ordinary desktop work |
| Packaged Mac candidate | See [Mac build lanes](macos-build.md) | Packaging, signing, and publication are separate from everyday development |
| Packaged Linux candidate | See [Linux builds](linux-build.md) | Ubuntu/Fedora x64, Rust native helpers, DEB/RPM/AppImage; no public update feed |

The browser preview cannot prove native dialogs, secure storage, preloads, or
restricted-app WebContentsView behavior. Use the native lane for those changes.
`desktop:prepare` alone builds and runs automated probes; it does not launch the
normal interactive app or create an installer.

For native iteration, prepare once with `npm run desktop:prepare`, then use
`npm start` to reopen the app. This starts Electron from the project root so
it reads the package version and resolves development resources correctly.
After renderer edits, run `npm run local:build`; after desktop or local-server
TypeScript edits, run `npm run desktop:compile`. Quit and reopen the app to
load those changes. Rebuild a changed native helper with its focused build
command. Use `npm run local:dev` for live renderer updates in the browser.
Reserve installers for packaging, installation, upgrade, and release checks;
the full `desktop:prepare` check still applies before handing off desktop changes.

On Linux, the unpackaged app also puts `work-fold` on Worker shell PATH, using
the prepared native CLI and launchers in the development profile. Calls use
that running profile and reopen Electron with the repository argument. Missing
native CLI output produces a setup error at startup rather than a Worker
searching for an unavailable command.

`npm run desktop:test:linux-dev` checks the prepared Linux development app
without making a package. It launches `npm start` with a disposable profile and
a local scripted provider, then asks real Pi shell tools to find `work-fold`,
create a file with a History restore point, and finish the file through Pi.
It also checks Folder, Chat, Library, request, model, and renderer sandbox state.
Use `-- --profile-root <empty-directory>` to retain the test profile, then
`-- --profile-root <same-directory> --phase verify` to check a cold restart.
CI runs both phases on a private Xvfb desktop. This tests integration, not a
real provider's model decisions or OAuth.

## Development state and model access

The browser/local API and unpackaged Electron default to **work-fold
Development** application data, separate from the installed app. They can
share that development profile. Run one development host at a time against a
given profile, and use disposable Space folders for tests that change files.
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

Real Assistant work needs a model provider and may incur charges. The browser
development host and unpackaged desktop load the root `.env` when present;
already-exported variables win. Copy [the optional template](../.env.example)
only if you need it, and uncomment only the settings you intend to use.
`WORKFOLD_AGENT_DIR` selects work-fold's Pi directory; the native Pi variable
`PI_CODING_AGENT_DIR` is also supported. `PI_AGENT_DIR` is not supported.

The installed `work-fold ... --json` CLI addresses a running app's management
surface. `npm run work-fold:drive` is a separate real-Pi-turn test driver and
can use a chosen agent directory; it is not an offline unit test. See
[Management and CLI](management-layer.md) before driving real work.

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
This is a developer diagnostic route, with no normal Chat, fold or Settings entry. Enable
**Record model context**, reproduce the behavior in the app, then refresh and
choose the request. The all-request view includes Assistant turns, titles,
Checks, app inference and compaction. Search or copy assembled context, compare
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
| `src/local/agent/` | Pi integration, Checks, app services, and brokers |
| [Kernel](../src/local/work-fold-kernel.ts), [CLI](../src/local/cli/), [adapter](../src/local/work-fold-cli-adapter.ts) | Shared context, tasks, and control-plane contracts |
| `src/shared/` | Shared types and the product identity contract |
| `desktop/src/` | Electron windows, lifecycle, preloads, native app hosts, and updater |
| `services/bridge/` | Relay, database, public website, and browser client |
| `tests/`, `services/bridge/*.test.mjs` | Application and bridge regression tests |
| `scripts/` | Shared development, validation, and release commands |
| `docs/`, `.agents/skills/` | Product contracts and task-specific contributor workflows |

Use the [docs map](README.md) to distinguish current contracts from proposals
and dated release evidence. Files in `docs/reference-skills/` are examples;
app-generated fold instructions are runtime resources. Neither is an extra
repository instruction source.

## Verification

- `npm run repo:check` runs without installed dependencies or network access.
  It includes new, non-ignored files, so it is useful before staging a change.
  It verifies shared files and paths, not model obedience or personal settings.
- `npm run check` runs repository hygiene plus both TypeScript checks.
- `npm test` runs the application suite. While editing, run a focused file with
  `node --import tsx --test tests/documentation-contract.test.ts`, substituting
  the relevant test file. Use the full suite before handing off behavior changes.
  CI divides the same discovered test files into four disjoint shards; reproduce
  one with `npm test -- --shard=1/4` (through `4/4`). Every file belongs to exactly
  one shard; an unsharded `npm test` still runs everything.
- `npm ci --prefix services/bridge` and `npm test --prefix services/bridge` run
  the bridge suite. It uses an in-memory test database; a live PostgreSQL server
  or Railway account is not required for those tests.
- `npm run desktop:prepare` verifies desktop resources, compiled code, native
  preloads, and the real restricted-app sandbox. After a compiled native change,
  `npm run desktop:restricted-app:smoke` is the focused sandbox probe.

Full CI runs in the background on PRs and pushed `main` with seven jobs:
Repository & TypeScript, four Application tests shards, Web bridge tests, and
Electron integration. Version tags run only `Release tag verification`, which
checks the annotated tag, package version, and canonical source identity. It
does not repeat dependency installation or tests, or wait for main CI.

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
