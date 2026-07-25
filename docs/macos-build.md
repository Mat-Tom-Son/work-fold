# macOS build and release lane

Workspace uses one Electron, React, local API, Pi, management-kernel, restricted-app, and versioning codebase on Windows and macOS. macOS is a platform lane in this repository, not a fork.

## Production baseline

The Apple silicon lane was verified on July 15, 2026 against Workspace 0.2.9:

- TypeScript checks and the complete 246-test suite pass.
- Desktop preparation passes, including the native Pi resource preflight and real-Electron restricted-app sandbox probe.
- Electron Builder produces an arm64 app, DMG, ZIP, both blockmaps, `latest-mac.yml`, checksums, and machine-readable/text release manifests.
- The app and DMG are Developer ID-signed by Team `464JD5K8DC`, use hardened runtime, are notarized and stapled, and are accepted by Gatekeeper.
- The packaged app uses bundle id `io.github.mattomson.workspace`, the custom icon, native macOS menus, and the complete renderer and CLI payload.
- The Mac update feed is the public artifact-only repository [`Mat-Tom-Son/workspace-mac-releases`](https://github.com/Mat-Tom-Son/workspace-mac-releases). Windows remains on [`Mat-Tom-Son/workspace`](https://github.com/Mat-Tom-Son/workspace/releases).
- A signed/notarized installed 0.2.8 app discovered 0.2.9, exposed the rendered `Download Workspace 0.2.9` control, downloaded the public ZIP, installed it, and relaunched as 0.2.9. The updater-cache SHA-256 matched the published asset digest exactly.
- After removing the obsolete ad hoc `Workspace Safe Storage` item once, two cold launches under the stable Developer ID identity completed without Keychain password prompts.

This proof enables automatic updates in signed production macOS builds with an embedded `app-update.yml`. The ad hoc package lane may retain the manifest for structural verification, but it uses the distinct `Workspace Local Smoke` name, `io.github.mattomson.workspace.local-smoke` bundle id, build channel, and application-data directory; its runtime never starts the updater or contacts the production feed.

## Toolchain

Use Node 24 for repeatable release evidence. Node 22.19.0 or newer is supported for development.

```bash
npm ci
npm run check
npm test
npm run desktop:make:mac
```

`desktop:make:mac` is the unsigned/ad hoc structural smoke lane. It performs desktop preparation, Pi and restricted-app smoke checks, Electron Builder DMG/ZIP assembly, packaged-asset and fuse verification, updater-manifest verification, mounted-DMG inspection, checksum generation, and release-manifest generation. Installer-only DMG artwork is generated under ignored `out/generated-assets` so Windows and macOS image encoders cannot rewrite tracked source bytes or make the guarded publisher reject its own build. The smoke build is not distributable and must not be renamed or installed over the production app.

Expected Apple silicon outputs:

- `out/builder/mac-arm64/Workspace Local Smoke.app`
- `out/builder/Workspace-<version>-mac-arm64.dmg`
- `out/builder/Workspace-<version>-mac-arm64.zip`
- matching `.blockmap` files
- `out/builder/latest-mac.yml`
- `out/builder/SHA256SUMS-mac.txt`
- `out/builder/Workspace-mac-release-manifest.json`
- `out/builder/Workspace-mac-release-manifest.txt`

Use `-- --arch x64` after a build command when an Intel candidate is required. An Intel artifact is not releasable until it receives a real Intel launch and updater smoke.

## Interactive packaged smoke

Do not interactively launch an ad hoc candidate under a normal macOS account. An ad hoc app using the production identity can invalidate Keychain access control and cause password prompts even when `WORKSPACE_DESKTOP_STATE_DIR` points at `/tmp`; the profile override does not isolate Keychain. The checked-in smoke lane's distinct name and bundle id prevent it from impersonating production, but routine ad hoc verification remains non-interactive.

Use a Developer ID-signed candidate for interactive checks on the release workstation:

```bash
WORKSPACE_DESKTOP_STATE_DIR=/tmp/workspace-macos-smoke \
  out/builder/mac-arm64/Workspace.app/Contents/MacOS/Workspace
```

That production-name path exists only after `npm run desktop:make:mac:release`; the ad hoc executable is `out/builder/mac-arm64/Workspace Local Smoke.app/Contents/MacOS/Workspace Local Smoke`. Exercise onboarding, Space creation/registration, Files, Chats, Library, History, Add, Assistant tools, Settings, native file actions, restricted apps, menus, window close/reopen, and sleep/wake continuity. The profile override isolates CLI requests, app files, restricted-app state, and preferences, but it is not a Keychain boundary. A separate disposable macOS account is the alternative for interactive ad hoc testing.

The packaged CLI can be tested directly:

```bash
WORKSPACE_DESKTOP_STATE_DIR=/tmp/workspace-macos-smoke \
WORKSPACE_CLI_STATE_DIR=/tmp/workspace-macos-smoke \
WORKSPACE_CLI_APP="$PWD/out/builder/mac-arm64/Workspace.app/Contents/MacOS/Workspace" \
  out/builder/mac-arm64/Workspace.app/Contents/bin/workspace context --json
```

The app adds `Contents/bin` to child-process `PATH`. A DMG must not edit a person's shell profile; making `workspace` available to unrelated Terminal sessions remains an explicit installation action.

## Signing configuration

The ignored `.env.macos.local` file is the normal workstation configuration:

```dotenv
WORKSPACE_MAC_SIGN_IDENTITY="Developer ID Application: James Thompson (464JD5K8DC)"
APPLE_KEYCHAIN_PROFILE="kai-workspace-notary"
WORKSPACE_MAC_RELEASE_OWNER="Mat-Tom-Son"
WORKSPACE_MAC_RELEASE_REPO="workspace-mac-releases"
WORKSPACE_MAC_TEAM_ID="464JD5K8DC"
```

The notary profile name is local and arbitrary; the existing profile is valid for both products. Never commit Apple passwords, API keys, certificate private keys, or exported identities. `APPLE_KEYCHAIN_PROFILE` may be replaced by a complete App Store Connect API-key or Apple-ID environment set when needed.

Build a signed candidate without publishing:

```bash
npm run desktop:make:mac:release
```

The release lane signs/notarizes the app, signs/notarizes/staples the final DMG, then regenerates the DMG blockmap and `latest-mac.yml` checksum after those byte-changing operations. Strict verification requires the expected Developer ID team, hardened runtime, stapling, Gatekeeper acceptance, feed, manifest, CLI, DMG layout, and exact artifact hashes.

## Public releases

Normal releases use one package version across Windows and Mac, but separate artifact feeds so the two publishers cannot race to own one GitHub release:

```bash
npm run desktop:release:mac
```

The publisher requires a clean worktree whose `HEAD` equals `origin/main`, the matching source tag and complete public Windows release, a public feed repository, and an unused `v<version>` tag in that feed. It verifies the local release again, uploads all assets as a draft, checks remote names, sizes, and GitHub digests, then publishes the release as latest. There is no dirty-worktree bypass.

See [macOS release runbook](macos-release.md) for the exact repeatable procedure and recovery rules.

## Keychain behavior

Provider and restricted-app credentials use Electron `safeStorage`, backed by Keychain. Stable Developer ID signing gives macOS one durable requester identity. An older ad hoc app that reused the production name may leave a Safe Storage access-control entry that repeatedly asks for a password after migration. Current local smoke builds use `Workspace Local Smoke`, a separate bundle id and application-data directory, and never start the production updater; do not rename them to `Workspace.app`.

Only when repeated prompts are observed, quit Workspace and run:

```bash
npm run desktop:reset:mac-safe-storage -- --yes --reopen
```

The helper deletes only the `Workspace Safe Storage` key and encrypted provider/restricted-app credential blobs. Spaces, chats, History, preferences, and ordinary app data remain. Users may need to enter provider or app credentials again.

Do not diagnose this with `security find-generic-password ... -g`: `-g` requests the secret and can itself trigger a password prompt. The installed-app verifier deliberately reads no Keychain secret data.

## Code map

- `electron-builder.desktop.cjs`: shared targets, platform-selected feeds, Mac identity, entitlements, icon, and DMG layout.
- `scripts/generate-dmg-background.mjs`: installer-only DMG artwork under ignored build output.
- `scripts/build-mac-desktop.mjs`: unsigned-smoke and signed-release orchestrator.
- `scripts/finalize-mac-release-artifacts.mjs`: final DMG signing, notarization, stapling, and post-signing metadata refresh.
- `scripts/write-mac-release-manifest.mjs`: release evidence and artifact hashes.
- `scripts/publish-mac-release.mjs`: guarded draft-first public publisher.
- `scripts/verify-mac-release.mjs`: bundle, signature, updater, manifest, checksum, and mounted-DMG verification.
- `scripts/verify-installed-mac-app.mjs`: installed version/feed/signature/notarization verification without Keychain reads.
- `scripts/reset-mac-safe-storage.mjs`: narrow ad hoc-to-Developer-ID credential migration helper.
- `desktop/src/updater.ts`: shared Windows and Squirrel.Mac update state machine.
- `desktop/cli/workspace-cli.jxa.js`: macOS protocol-v1 CLI helper.
