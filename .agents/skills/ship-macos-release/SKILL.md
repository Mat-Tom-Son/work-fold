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
   explicit user authorization. Existing authorization in the conversation
   counts; do not ask again for an action the user already authorized.
6. Finish release inputs and merge to `main`, then run
   `npm run desktop:release:mac:check` on that final clean commit with Node 24
   on an Apple-silicon Mac with supported npm and Google Chrome for the real
   CSS tests. It performs fresh root/bridge installs, repository and TypeScript
   checks, full application and bridge tests, and Electron
   preparation. A successful receipt pins the exact SHA, tree, build-input
   fingerprint, runtime, and completed stages. Use `-- --status` to validate it
   read-only. An older commit's receipt cannot carry across a merge.
7. The full signed build requires a valid local receipt before it starts.
   Publication requires source-bound signed artifacts built after that receipt
   completed, under the same Node/npm and dependency state. The publisher
   requires canonical pushed `main` and its matching annotated source tag; it does not wait on GitHub Actions. Main/PR
   CI remains background evidence, tag verification checks source identity,
   and `desktop:release:mac:ci` is an optional diagnostic. Fix and recheck local
   failures before tagging without consuming a version. A failed candidate's
   pushed tag remains immutable; fix forward with a higher version and new tag.

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
Release-tooling-only changes need focused and normal local checks, not a new
app version or an Apple submission.

Run the local release check on final `main` before building; do not edit source
or run dependency installs while packaging. The shared per-worktree lock
serializes local checks, all macOS builds, and publication; the app-only RC
lane needs no verification receipt but holds the same lock. Use `:resume` only when the build began after the current
check succeeded and its fingerprint and artifact receipts still validate. A
fresh check reinstalls dependencies and therefore needs a subsequent fresh
distribution build. A compatible build checkpoint cannot substitute for a
local-check receipt at the exact release SHA. Keep the same Node/npm toolchain
and dependency state; hidden lockfile hashes detect ordinary dependency drift.

## Keep candidate, installed, and published versions distinct

A production-signed macOS candidate has the normal work-fold name, identity,
and application-data profile even when launched from `out/mac-rc`. It is not
the isolated Local Smoke app. An explicit `WORKFOLD_DESKTOP_STATE_DIR` selects
separate app data but does not isolate Keychain.

Before updater testing or reporting a version, inspect the running executable
path, the bundle version in `/Applications/work-fold.app`, and the public feed
separately. Quit the candidate before opening the installed copy; their shared
single-instance identity can otherwise keep the candidate running. Removing a
temporary candidate means removing its bundle, not the shared application data.
An app-only candidate has no distribution updater metadata. Publication alone
does not prove installation; if the person wants to press the update button,
verify the offered version and leave installation and relaunch unclaimed.

## Resume interrupted work

1. Run `npm run desktop:release:mac:status` first. Use `-- --json` when a
   machine-readable result is useful.
2. Resume a compatible local distribution build with
   `npm run desktop:make:mac:release:resume`.
3. Resume through normal publication with
   `npm run desktop:release:mac:resume`.
4. Start a fresh build when status reports changed source, package version,
   architecture, Node runtime, signing identity, feed, or artifact bytes.
   Changed source, Node/npm, or dependencies also requires fresh local checks.

Never edit `out/builder/work-fold-mac-release-state.json`. A checkpoint is
ignored recovery data, not proof by itself. Resume must validate the source
fingerprint, exact artifact receipts, signed app, notarization staple, and
Gatekeeper result. Never edit `out/release-checks/local-verification.json`
either: starting or failing a local check invalidates old evidence, and source
changes during the run fail. Publication checks the local receipt, canonical
source identity, and signed artifact evidence before upload and immediately
before publishing the draft, including when the publisher is invoked directly.
The strict verifier still runs; GitHub Actions status is not required.

## Verify and report

Run the smallest relevant checks while editing release tooling, then run
`npm run check` and the focused release tests. Run the complete `npm test`
before handing off behavior changes. Do not submit to Apple merely to test
argument parsing or documentation.

For a real distribution candidate, retain and report:

- the version, architecture, source commit, and selected release lane;
- exact-commit local-check receipt, per-stage timings, and status/resume results;
- Developer ID, hardened-runtime, notarization-staple, and Gatekeeper outcomes;
- exact DMG, ZIP, blockmap, updater metadata, checksum, and manifest results;
- installed-app and updater evidence required by the runbook;
- the public release URL only after publication actually succeeds.

If a run fails, name the failed stage and preserve valid prior work. Do not
describe an artifact as released, installed, or updater-proven until that exact
operation has passed.
