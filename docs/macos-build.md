# macOS build and release lane

work-fold retains one Electron, React, local API, Pi, management-kernel, restricted-app, and versioning codebase with cross-platform seams, but Apple-silicon macOS is the only active CI packaging and public distribution lane. Windows build code is dormant future work, not a Mac release gate.

## Legacy Workspace baseline evidence

The Apple silicon lane was verified on July 15, 2026 against Workspace 0.2.9:

- TypeScript checks and the complete 246-test suite pass.
- Desktop preparation passes, including the native Pi resource preflight and real-Electron restricted-app sandbox probe.
- Electron Builder produces an arm64 app, DMG, ZIP, both blockmaps, `latest-mac.yml`, checksums, and machine-readable/text release manifests.
- The app and DMG are Developer ID-signed by Team `464JD5K8DC`, use hardened runtime, are notarized and stapled, and are accepted by Gatekeeper.
- The packaged app uses bundle id `io.github.mattomson.workspace`, the custom icon, native macOS menus, and the complete renderer and CLI payload.
- The Mac update feed is the public artifact-only repository [`Mat-Tom-Son/workspace-mac-releases`](https://github.com/Mat-Tom-Son/workspace-mac-releases). Windows remains on [`Mat-Tom-Son/workspace`](https://github.com/Mat-Tom-Son/workspace/releases).
- A signed/notarized installed 0.2.8 app discovered 0.2.9, exposed the rendered `Download Workspace 0.2.9` control, downloaded the public ZIP, installed it, and relaunched as 0.2.9. The updater-cache SHA-256 matched the published asset digest exactly.
- After removing the obsolete ad hoc `Workspace Safe Storage` item once, two cold launches under the stable Developer ID identity completed without Keychain password prompts.

This is preserved historical evidence for the legacy product; it does not prove
work-fold identity, clean-profile behavior, or updater compatibility. The
work-fold ad hoc package lane may retain the manifest for structural
verification, but it uses the distinct `work-fold Local Smoke` name,
`com.work-fold.desktop.local-smoke` bundle id, build channel, and
application-data directory; its runtime never starts the updater or contacts
the production feed.

## Toolchain

Use Node 24 for repeatable release evidence. Node 22.19.0 or newer is supported for development.

```bash
npm ci
npm run check
npm test
npm run desktop:make:mac
```

Use the smallest lane that proves the behavior under test:

| Lane | Command | Purpose |
| --- | --- | --- |
| UI development | `npm run local:dev` | Live renderer and local API work without packaging or Apple services. |
| Desktop integration | `npm run desktop:smoke` | Prepared, unpackaged Electron behavior using development state. |
| Structural package | `npm run desktop:make:mac` | Ad hoc, separately identified DMG/ZIP package and verification; never install it as production. |
| Interactive release candidate | `npm run desktop:rc:mac` | Developer ID-signed and app-notarized production bundle without DMG/ZIP assembly, DMG notarization, updater artifacts, or publication. |
| Distribution candidate | `npm run desktop:make:mac:release` | Complete signed/notarized DMG and ZIP set plus strict local verification. |
| Public release | `npm run desktop:release:mac` | Fresh distribution candidate followed by guarded draft-first publication. |

The app-only release-candidate lane is the normal packaged UI/desktop QA loop.
It produces `out/mac-rc/mac-arm64/work-fold.app`, verifies the Developer ID
signature, hardened runtime, notarization staple, Gatekeeper acceptance, and
packaged assets, and leaves the full updater/distribution proof to the slower
distribution lane. Electron Builder's unpacked `--dir` output has no updater
metadata, so it cannot prove update discovery or installation.

`desktop:make:mac` is the unsigned/ad hoc structural smoke lane. It performs desktop preparation, Pi and restricted-app smoke checks, Electron Builder DMG/ZIP assembly, packaged-asset and fuse verification, updater-manifest verification, mounted-DMG inspection, checksum generation, and release-manifest generation. Installer-only DMG artwork is generated under ignored `out/generated-assets` so image encoders cannot rewrite tracked source bytes or make the guarded publisher reject its own build. The smoke build is not distributable and must not be renamed or installed over the production app.

Expected Apple silicon outputs:

- `out/builder/mac-arm64/work-fold Local Smoke.app`
- `out/builder/work-fold-<version>-mac-arm64.dmg`
- `out/builder/work-fold-<version>-mac-arm64.zip`
- matching `.blockmap` files
- `out/builder/latest-mac.yml`
- `out/builder/SHA256SUMS-mac.txt`
- `out/builder/work-fold-mac-release-manifest.json`
- `out/builder/work-fold-mac-release-manifest.txt`

Use `-- --arch x64` after a build command when an Intel candidate is required. An Intel artifact is not releasable until it receives a real Intel launch and updater smoke.

## Interactive packaged smoke

Do not interactively launch an ad hoc candidate under a normal macOS account. An ad hoc app using the production identity can invalidate Keychain access control and cause password prompts even when `WORKFOLD_DESKTOP_STATE_DIR` points at `/tmp`; the profile override does not isolate Keychain. The checked-in smoke lane's distinct name and bundle id prevent it from impersonating production, but routine ad hoc verification remains non-interactive.

Use a Developer ID-signed candidate for interactive checks on the release workstation:

```bash
WORKFOLD_DESKTOP_STATE_DIR=/tmp/work-fold-macos-smoke \
  out/mac-rc/mac-arm64/work-fold.app/Contents/MacOS/work-fold
```

That app-only path exists after `npm run desktop:rc:mac`; the complete distribution candidate remains at `out/builder/mac-arm64/work-fold.app`. The ad hoc executable is `out/builder/mac-arm64/work-fold Local Smoke.app/Contents/MacOS/work-fold Local Smoke`. Exercise onboarding, Space creation/registration, Files, Chats, History, Add, the Space-owned Library and Assistant tools tabs, Settings, native file actions, restricted apps, menus, window close/reopen, and sleep/wake continuity. The profile override isolates CLI requests, app files, restricted-app state, and preferences, but it is not a Keychain boundary. A separate disposable macOS account is the alternative for interactive ad hoc testing.

The packaged CLI can be tested directly:

```bash
WORKFOLD_DESKTOP_STATE_DIR=/tmp/work-fold-macos-smoke \
WORKFOLD_CLI_STATE_DIR=/tmp/work-fold-macos-smoke \
WORKFOLD_CLI_APP="$PWD/out/mac-rc/mac-arm64/work-fold.app/Contents/MacOS/work-fold" \
  out/mac-rc/mac-arm64/work-fold.app/Contents/bin/work-fold context --json
```

The app adds `Contents/bin` to child-process `PATH`. A DMG must not edit a person's shell profile; making `work-fold` available to unrelated Terminal sessions remains an explicit installation action.

## Signing configuration

The ignored `.env.macos.local` file is the normal workstation configuration:

```dotenv
WORKFOLD_MAC_SIGN_IDENTITY="Developer ID Application: James Thompson (464JD5K8DC)"
APPLE_KEYCHAIN_PROFILE="kai-workspace-notary"
WORKFOLD_MAC_RELEASE_OWNER="Mat-Tom-Son"
WORKFOLD_MAC_RELEASE_REPO="work-fold-mac-releases"
WORKFOLD_MAC_TEAM_ID="464JD5K8DC"
```

The notary profile name is local and arbitrary; the existing profile is valid for both products. Never commit Apple passwords, API keys, certificate private keys, or exported identities. `APPLE_KEYCHAIN_PROFILE` may be replaced by a complete App Store Connect API-key or Apple-ID environment set when needed.

Build the fast app-only candidate for interactive QA:

```bash
npm run desktop:rc:mac
```

Build the complete distribution candidate without publishing:

```bash
npm run desktop:make:mac:release
```

The release lane signs/notarizes the app, signs/notarizes/staples the final DMG, then regenerates the DMG blockmap and `latest-mac.yml` checksum after those byte-changing operations. Strict verification requires the expected Developer ID team, hardened runtime, stapling, Gatekeeper acceptance, feed, manifest, CLI, DMG layout, and exact artifact hashes.

## Timings and resumable release work

Every macOS candidate stage reports elapsed time. A complete signed distribution
build writes an ignored checkpoint at
`out/builder/work-fold-mac-release-state.json`. The checkpoint binds completed
stages to the package version, architecture, Node version, signing identity,
release feed, source/configuration fingerprint, signed app, and exact artifact
hashes. It contains no signing or notarization credentials.

Inspect a checkpoint without changing it:

```bash
npm run desktop:release:mac:status
npm run desktop:release:mac:status -- --json
```

Resume an interrupted local distribution build:

```bash
npm run desktop:make:mac:release:resume
```

Resume the build and continue into guarded publication:

```bash
npm run desktop:release:mac:resume
```

Resume never means “trust whatever is in `out/`.” The command verifies the
saved fingerprint, exact file receipts, app signature, notarization staple, and
Gatekeeper result before skipping work. It fails closed if inputs, environment,
or artifacts changed; run a fresh `desktop:make:mac:release` in that case. Do
not hand-edit the state file. The full verifier still runs before publication.

## Public releases

The active public desktop release is the signed, notarized Apple-silicon Mac build. The source repository carries the exact source tag, while the separate Mac feed owns only the distribution artifacts:

The first public work-fold version is `0.1.0`. The repository used `0.8.0` as a
development holdover and reset it only when the first release commit and tag
were ready. Its Developer ID-signed, notarized, and stapled Mac artifacts were
installed on August 1, 2026; real first-launch QA then found a sandboxed-preload
module-load defect before onboarding. The published assets remain immutable
and superseded. `0.1.1` repairs that boundary and is the first higher release
used to prove the new `Mat-Tom-Son/work-fold-mac-releases` updater path from
installed `0.1.0`. Neither version is an update from Workspace. The frozen
legacy release repository must never receive these artifacts.

```bash
npm run desktop:release:mac
```

Publication starts only after GitHub CI succeeds for the exact release commit
on pushed `main` and succeeds again for the matching pushed source tag. These
are separate runs over the same SHA: the tag run catches tag-only release
conditions without making tag creation itself a publisher. A failed pushed tag
remains immutable evidence; correct the source, advance the package version,
and create a new commit and tag.

The publisher requires a clean worktree whose `HEAD` equals `origin/main`, the matching source tag, public source and feed repositories, and an unused `v<version>` tag in the feed. It verifies the local release again, uploads all assets as a draft, checks remote names, sizes, and GitHub digests, then publishes the release as latest. It does not require a source-repository GitHub Release or any Windows artifact. There is no dirty-worktree bypass.

See [macOS release runbook](macos-release.md) for the exact repeatable procedure and recovery rules.

## Keychain behavior

Provider and restricted-app credentials use Electron `safeStorage`, backed by Keychain. Stable Developer ID signing gives macOS one durable requester identity. An older ad hoc app that reused the production name may leave a Safe Storage access-control entry that repeatedly asks for a password after migration. Current local smoke builds use `work-fold Local Smoke`, a separate bundle id and application-data directory, and never start the production updater; do not rename them to `work-fold.app`.

Only when repeated prompts are observed, quit work-fold and run:

```bash
npm run desktop:reset:mac-safe-storage -- --yes --reopen
```

The helper deletes only the `work-fold Safe Storage` key and encrypted provider/restricted-app credential blobs. Spaces, chats, History, preferences, and ordinary app data remain. Users may need to enter provider or app credentials again.

Do not diagnose this with `security find-generic-password ... -g`: `-g` requests the secret and can itself trigger a password prompt. The installed-app verifier deliberately reads no Keychain secret data.

## Code map

- `electron-builder.desktop.cjs`: shared targets, platform-selected feeds, Mac identity, entitlements, icon, and DMG layout.
- `scripts/generate-dmg-background.mjs`: installer-only DMG artwork under ignored build output.
- `scripts/build-mac-release-candidate.mjs`: app-only signed/notarized interactive release candidate.
- `scripts/verify-mac-release-candidate.mjs`: signature, hardened-runtime, staple, Gatekeeper, identity, version, and architecture verification for the app-only candidate.
- `scripts/build-mac-desktop.mjs`: unsigned-smoke and checkpointed signed-distribution orchestrator.
- `scripts/mac-release-state.mjs`: source fingerprints, artifact receipts, atomic checkpoints, and timing summaries.
- `scripts/mac-release-status.mjs`: read-only human/JSON checkpoint inspection.
- `.agents/skills/ship-macos-release/SKILL.md`: standard project Skill that selects and executes these same documented lanes.
- `scripts/finalize-mac-release-artifacts.mjs`: final DMG signing, notarization, stapling, and post-signing metadata refresh.
- `scripts/write-mac-release-manifest.mjs`: release evidence and artifact hashes.
- `scripts/publish-mac-release.mjs`: guarded draft-first public publisher.
- `scripts/verify-mac-release.mjs`: bundle, signature, updater, manifest, checksum, and mounted-DMG verification.
- `scripts/verify-installed-mac-app.mjs`: installed version/feed/signature/notarization verification without Keychain reads.
- `scripts/reset-mac-safe-storage.mjs`: narrow ad hoc-to-Developer-ID credential recovery helper.
- `desktop/src/updater.ts`: shared Windows and Squirrel.Mac update state machine.
- `desktop/cli/work-fold-cli.jxa.js`: macOS protocol-v1 CLI helper.
