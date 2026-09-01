# Contributing to work-fold

Thanks for helping make folder-based computer work more understandable and more capable.

## Start with the product model

Before changing navigation, terminology, storage, trust, or Assistant behavior, read:

- [Product model and roadmap](docs/product-model.md)
- [App platform foundation](docs/app-platform-foundation.md)
- [Assistant capabilities](docs/assistant-capabilities.md)
- [Checks](docs/checks.md)
- [The fold](docs/fold.md)
- [Restricted app runtime](docs/restricted-app-runtime.md)
- [Restricted app authoring](docs/restricted-app-authoring.md)
- [Architecture](docs/architecture.md)
- [work-fold management layer](docs/management-layer.md)
- [macOS build and release lane](docs/macos-build.md)
- [macOS release runbook](docs/macos-release.md)
- [work-fold contributor guide](AGENTS.md) — the canonical policy for Codex and every contributor.
- [Claude Code entrypoint](CLAUDE.md) — imports `AGENTS.md` rather than duplicating it.

The central constraint is that a Space remains an ordinary folder. work-fold may register and present that folder, but should not silently move, convert, decorate, upload, or place all of its contents into Assistant context.

## Report an issue

Use [GitHub Issues](https://github.com/Mat-Tom-Son/work-fold/issues) for reproducible bugs and focused feature proposals. Include the work-fold version, operating system and version, what you expected, what happened, and the smallest safe reproduction you can provide.

Do not put API keys, tokens, private file contents, personal paths, or security vulnerabilities in a public issue. Follow [the security policy](SECURITY.md) for vulnerabilities.

## Develop locally

work-fold requires Node 22.19.0 or newer.

```bash
git clone https://github.com/Mat-Tom-Son/work-fold.git
cd work-fold
npm ci
npm run local:dev
```

Keep changes focused and avoid committing generated `dist/`, `out/`, user-data, credential, or signing files.

## Codex and Claude Code parity

Codex reads the root `AGENTS.md` directly. Claude Code reads the tracked root `CLAUDE.md`, which imports `AGENTS.md` with `@AGENTS.md`. Update shared rules only in `AGENTS.md`; do not create a parallel harness-specific build, test, release, terminology, architecture, Skill, Extension, or tool contract. Both harnesses work against the same Pi-owned capability catalog and the same product documentation.

Shared project Skills have one source in `.agents/skills/`. Codex discovers that
tree directly. Tracked symlinks under `.claude/skills/` expose the same Skills to
Claude Code without duplicating their contents. Everything else under `.claude/`
and `.codex/` is ignored machine-local launch, permission, session, or worktree
state. A fresh clone therefore gives both harnesses the same rules and workflows.

Both harnesses can inspect an installed app through `work-fold ... --json`. To drive one real Assistant turn through the development local API and native Pi runtime:

```bash
npm run work-fold:drive -- --space-root /path/to/space --prompt "Summarize this Space"
npm run work-fold:drive -- --space-root /path/to/space --prompt "..." --json --agent-dir /tmp/isolated-pi
```

Use the installed CLI for read-only management snapshots and `work-fold:drive` for an end-to-end Pi turn. See [work-fold management layer](docs/management-layer.md) for their different boundaries.

## Verify a change

Use the smallest relevant lane while working, then promote the change before handoff:

```powershell
npm run check
npm test
npm run desktop:prepare
```

GitHub CI runs these gates on macOS. Windows package and installer commands are dormant manual diagnostics; they are not CI or release gates and should not be run as routine handoff evidence.

Tests that observe asynchronous work should wait on the owned in-memory or
domain completion signal, then verify durable persistence separately. Do not
make correctness depend on a journal file becoming visible within one event-loop
turn or on an arbitrary sleep; those checks are fast locally and unreliable on
shared CI runners. When a test installs a fake clock, keep advancing that clock
while asynchronous continuations settle; waiting in real time cannot fire a
fake timer that was armed after the first advance.

For restricted-app manifest, bridge, broker, sandbox, storage, file, notification, connection, or lifecycle changes, run the focused tests and `npm run desktop:restricted-app:smoke`. That command exercises the real Electron visible and worker sandboxes; browser fixtures or Node-only tests do not prove the security boundary. `desktop:prepare`, the package lanes, and the release lane include this probe.

On macOS, use Node 24 and `npm run desktop:make:mac` for the non-interactive `work-fold Local Smoke` app/DMG/ZIP structural candidate. Do not rename or install that ad hoc app over production. Developer ID, notarized, interactive candidates use `npm run desktop:make:mac:release`; see [macOS build and release lane](docs/macos-build.md). Never publish ad hoc artifacts as releases.

Add or update tests for behavior changes. Update README and focused docs when a change affects shipped behavior, terminology, privacy, security, trust, build commands, or the roadmap.

work-fold is a clean break from the legacy Workspace product. Do not add code or documentation that imports, migrates, rewrites, wipes, or deletes the old application profile or `.workspace/` metadata. Preserved legacy data stays inert and hidden; new portable records use `.work-fold/`.

For kernel or CLI changes, update the snapshot/protocol version deliberately and exercise the kernel, adapter, protocol, broker, desktop-host, and installer-packaging tests through `npm test`. Keep the README, management guide, Security, and Privacy output descriptions in sync. Protocol v1 must remain read-only.

For restricted-app changes, update the product model, authoring guide, runtime contract, Security, Privacy, example package, and release QA guidance together whenever their behavior changes. Distinguish the normal owning-Chat proposal/review path from the advanced local-package install path, and never describe a proposal or install as granting access.

## Pull requests

A useful pull request:

- Explains the user outcome and the problem it solves.
- Keeps internal compatibility names separate from user-facing Space and Library language.
- Identifies data, scope, context, and trust changes explicitly.
- Preserves Pi's native resource behavior instead of adding a parallel format.
- Includes relevant test and verification results.
- Calls out remaining risk or follow-up work without presenting roadmap items as shipped.

Maintainers publish releases from clean version tags. Contributors should not rewrite a released tag or replace artifacts beneath an existing version.

The full active maintainer sequence—local gates, green CI for the exact pushed
`main` commit, a matching annotated source tag, green CI for that tag, guarded
publication, public asset verification, and installed updater smoke—is
documented in the [macOS release runbook](docs/macos-release.md). A failed
pushed candidate tag remains immutable source evidence; the correction uses a
higher version and a new tag rather than moving or reusing the failed one.
The Windows references are dormant notes for a future deliberate reactivation.

## License

By contributing, you agree that your contribution may be distributed under the repository's [MIT License](LICENSE).
