# Development

Start with [Contributing](../CONTRIBUTING.md). [AGENTS.md](../AGENTS.md) owns the
contributor rules; this guide explains how to run and navigate the checkout.

## Choose a development surface

Run commands from the repository root with Node 24 (`.nvmrc`). `npm ci` uses the
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
- `npm ci --prefix services/bridge` and `npm test --prefix services/bridge` run
  the bridge suite. It uses an in-memory test database; a live PostgreSQL server
  or Railway account is not required for those tests.
- `npm run desktop:prepare` verifies desktop resources, compiled code, native
  preloads, and the real restricted-app sandbox. After a compiled native change,
  `npm run desktop:restricted-app:smoke` is the focused sandbox probe.

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
