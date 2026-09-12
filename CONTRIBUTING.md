# Contributing to work-fold

work-fold is an independent project, and help building and maintaining it is
welcome. A focused bug fix, a clearer interaction, a useful test, or a better
explanation is a good first contribution.

Start with something you noticed while using the app. Describe it in an
[issue](https://github.com/Mat-Tom-Son/work-fold/issues) or draft pull request
so we can discuss the approach as you work.

## First run

Use **Node 24**, **npm 11.16.0 or newer**, and Git. The root `.nvmrc` records
the recommended Node major; run `nvm use` if you use nvm. Check `npm --version`
after selecting Node: its bundled npm version varies. The contributor install
requires npm's per-dependency script controls so the computer helper is built by
our packaging lane, rather than installed by a dependency hook. The package's
minimum runtime remains Node 22.19.0.

```sh
git clone https://github.com/Mat-Tom-Son/work-fold.git
cd work-fold
npm ci
npm run repo:check
npm run local:dev
```

Open **http://localhost:5173** for the browser development UI. The local API
runs on port 4327. This is a live development host, so use test folders.
Connect a model in **Settings → Assistant** when you want to try a real turn;
installing dependencies and running the automated checks need no provider key.

For the native app, run `npm run desktop:smoke` instead. See
[Development](docs/development.md) for the source map, separate development
state, isolated test profiles, bridge setup, and focused test commands.

## Bring your coding agent

Open the repository root in your agent and give it a concrete task.
[AGENTS.md](AGENTS.md) is the canonical contributor contract. Codex reads it
directly; [CLAUDE.md](CLAUDE.md) imports it for Claude Code. Other agents can
read `AGENTS.md` explicitly. A useful first prompt is:

> Read AGENTS.md and CONTRIBUTING.md. Run npm run repo:check, find the code and
> owning docs for this task, then implement and verify: [describe the change].

Shared Skills live in `.agents/skills/`. Claude sees those same files through
tracked `.claude/skills/` symlinks. See [agent setup and Skill maintenance](docs/development.md#agent-setup-and-shared-skills)
for discovery checks and adding a Skill. Personal harness settings stay local.

## Find the right part of the project

Start with [the product model](docs/product-model.md) and the relevant row in
the [docs map](docs/README.md). Read only the additional contracts relevant to
your change; `AGENTS.md` identifies the required ones.

| Working on | Start here |
|---|---|
| Files, Chats, navigation, or UI | `web-local/src/`, [Desktop interaction](docs/ui-parity.md) |
| Filesystem, Assistant, or domain services | `src/local/`, [Architecture](docs/architecture.md) |
| The fold, CLI, or shared task state | [Kernel](src/local/work-fold-kernel.ts), [CLI](src/local/cli/), [Management layer](docs/management-layer.md) |
| Checks or cross-Space work | [Checks](docs/checks.md), [Routings](docs/fold-routings.md) |
| Assistant-built Space apps | [App foundation](docs/app-platform-foundation.md), [Authoring](docs/restricted-app-authoring.md), [Runtime](docs/restricted-app-runtime.md) |
| Native desktop behavior | `desktop/src/`, [macOS builds](docs/macos-build.md) |
| Landing page or web client | `services/bridge/public/`, [Bridge guide](services/bridge/README.md) |

## Verify and submit

Use focused tests while working, then run the shared gates:

```sh
npm run check
npm test
```

`check` includes the fast, offline `repo:check`: shared Skill parity, local-state
ignore rules, repository links, and current documented npm commands. It checks
files and paths, not exact marketing wording. Historical release commands stay
historical.

For bridge changes, also run `npm ci --prefix services/bridge` and
`npm test --prefix services/bridge`. For Electron, packaging, or runtime-resource
changes, run `npm run desktop:prepare`; that includes real Electron sandbox
probes. See [verification lanes](docs/development.md#verification) for details.

Open a **draft pull request** for development CI, or run CI manually from
Actions. PR updates cancel obsolete PR runs. Main and version tags run
independently, including queued runs. Electron failures save synthetic
lifecycle state and available screenshots in the run's diagnostics artifact.
Inspect the failing step and evidence before rerunning.

Describe the problem, resulting behavior, and validation in your PR. Update
the owning docs when behavior changes. Keep changes focused; preserve unrelated
work and keep credentials, local settings, and generated output out of commits.
[AGENTS.md](AGENTS.md) defines the shared product, authority, and compatibility
rules for every contributor and harness.

Mac publication is a maintainer operation with separate authorization and exact
main/tag CI requirements. Use the [release runbook](docs/macos-release.md).
Windows packaging remains inactive and does not gate Mac work.

## Bugs, security, and license

For a bug, include the app version, OS, expected behavior, actual behavior, and
a small reproduction with non-private files. Follow
[SECURITY.md](SECURITY.md) for vulnerabilities; keep keys, tokens, personal
paths, and private content out of public reports.

Contributions are distributed under the [MIT License](LICENSE).
