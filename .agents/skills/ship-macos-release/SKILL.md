---
name: ship-macos-release
description: Build, inspect, resume, verify, install-test, or publish work-fold macOS release candidates with the repository's Developer ID signing, Apple notarization, artifact verification, and guarded GitHub release lanes. Use when working on macOS packaging or release tooling, preparing an interactive signed candidate, diagnosing a slow or failed Mac build, resuming notarization or publication, auditing release evidence, or shipping a public Mac release.
---

# Ship a macOS release

Follow the repository's release authority rather than reconstructing commands.
Keep signing material outside the repository and choose the least expensive lane
that proves the requested behavior.

## Establish the release context

1. Read `../../../AGENTS.md`, `../../../docs/macos-build.md`, and
   `../../../docs/macos-release.md` completely before changing or running the
   release lane.
2. Inspect `git status --short`, `package.json` version, the current branch and
   commit, and the requested outcome. Preserve unrelated worktree changes.
3. Use Node 24 for signed, notarized, or public release evidence.
4. Inspect `.env.macos.local` only for variable presence. Never print, copy,
   commit, or request secret values. Do not use Keychain commands that reveal a
   secret.
5. Treat public publication, tag creation, installation over `/Applications`,
   and deletion of a failed GitHub draft as separate external actions requiring
   explicit user authorization.

## Choose the lane

- Use `npm run local:dev` for live renderer/local API work.
- Use `npm run desktop:smoke` for unpackaged Electron integration.
- Use `npm run desktop:make:mac` for the separately identified, ad hoc
  structural DMG/ZIP lane. Never rename or install that output as production.
- Use `npm run desktop:rc:mac` for interactive packaged QA. This creates a
  production-identity app that is Developer ID-signed, app-notarized, stapled,
  and Gatekeeper-checked under `out/mac-rc`, but deliberately omits updater and
  distribution artifacts.
- Use `npm run desktop:make:mac:release` for a fresh complete DMG/ZIP candidate
  without publication.
- Use `npm run desktop:release:mac` only when the user explicitly requests the
  guarded public Mac release. Windows is not an active release lane or a Mac
  publication prerequisite.

Do not use a signed or packaged lane to check ordinary UI copy or styling.

## Resume interrupted work

1. Run `npm run desktop:release:mac:status` first. Use `-- --json` when a
   machine-readable result is useful.
2. Resume a compatible local distribution build with
   `npm run desktop:make:mac:release:resume`.
3. Resume through normal publication with
   `npm run desktop:release:mac:resume`.
4. Start a fresh build when status reports changed source, package version,
   architecture, Node runtime, signing identity, feed, or artifact bytes.

Never edit `out/builder/work-fold-mac-release-state.json`. A checkpoint is
ignored recovery data, not proof by itself. Resume must validate the source
fingerprint, exact artifact receipts, signed app, notarization staple, and
Gatekeeper result. Publication must still run the strict verifier and GitHub
guards.

## Verify and report

Run the smallest relevant checks while editing release tooling, then run
`npm run check` and the focused release tests. Run the complete `npm test`
before handing off behavior changes. Do not submit to Apple merely to test
argument parsing or documentation.

For a real distribution candidate, retain and report:

- the version, architecture, source commit, and selected release policy;
- per-stage timings and the status/resume result;
- Developer ID, hardened-runtime, notarization-staple, and Gatekeeper outcomes;
- exact DMG, ZIP, blockmap, updater metadata, checksum, and manifest results;
- installed-app and updater evidence required by the runbook;
- the public release URL only after publication actually succeeds.

If a run fails, name the failed stage and preserve valid prior work. Do not
describe an artifact as released, installed, or updater-proven until that exact
operation has passed.
