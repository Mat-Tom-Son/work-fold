# work-fold 0.1.1

work-fold 0.1.1 is the corrective Mac release for the first public work-fold
build. It preserves the new product identity, clean profile, public updater
feed, and legacy Workspace isolation introduced in 0.1.0.

## First-launch repair

- The main-window and management-popover preloads no longer import a local JSON
  module inside Electron's renderer sandbox.
- The host now passes the centralized product name and internal protocol through
  the same encoded, sandbox-safe renderer argument boundary used for API origin,
  app version, and native window material.
- A real Electron smoke launches both production preloads with context
  isolation, Node integration disabled, and the renderer sandbox enabled. It
  verifies the exposed bridge identity and the popover's deliberately narrower
  authority before desktop packaging can proceed.
- Static contract coverage prevents either sandboxed preload from acquiring a
  non-Electron `require` again and keeps the smoke in `desktop:prepare`.

## Data and update safety

- This repair does not add any import, migration, deletion, or fallback access
  to legacy Workspace profiles, credentials, updater caches, or `.workspace/`
  metadata.
- The published 0.1.0 assets remain immutable and are marked superseded rather
  than replaced in place.
- The installed 0.1.0 app supplied the lower-version input for the completed
  signed public update to 0.1.1 through the work-fold Mac feed.

## Release gate

The corrective source gate contains 683 tests: 682 passing, one expected
Windows-only skip on macOS, and zero failures. It also includes TypeScript
checks, the new main/popover preload smoke, the restricted-app sandbox smoke,
and a disposable packaged Mac launch that reaches onboarding with a live local
API bridge and no renderer console errors.

## Accepted Mac release evidence

The public Mac release passed its final acceptance gate on August 1, 2026:

- source tag `v0.1.1` resolves to commit
  `d0e3d4a38d19cdbbe3c93c3291fc8b26e1bd9d32`; its exact hosted
  [CI run](https://github.com/Mat-Tom-Son/work-fold/actions/runs/30711062110)
  passed TypeScript, all tests, and the Windows-hosted unpacked-package smoke;
- Apple accepted the signed app submission
  `3538a054-bb31-4db8-8a60-714350f86121` and signed DMG submission
  `7f7e1c5b-e310-47a7-b3b6-32846c90a58f`;
- the public arm64 DMG SHA-256 is
  `8822451b3ebeead8d4985aa26d035b7b9217a5aa530d3d93aab9717aba42f897`;
- installed 0.1.0 discovered, downloaded, replaced itself with, and relaunched
  0.1.1 through the public work-fold Mac feed after an explicit user click;
- both updater-cache copies of the ZIP matched the public asset SHA-256
  `c01eb4a9a881efe6da54fe4e59d3a5a654736c979181b83a90d61f7ffc100fa9`;
- the installed app passed bundle, feed, Team ID, Gatekeeper, and notarization
  staple verification without requesting Keychain secret data;
- a cold installed launch reached onboarding with a live authenticated API
  bridge and no renderer errors; the native menu-bar popover loaded with its
  narrow management-only bridge; close-to-menu-bar, reopen, full quit, and
  normal cold launch all passed; and
- the new profile still reported zero Spaces, while a deterministic manifest
  of all 1,939 files in the legacy Workspace profile was byte-for-byte
  unchanged across update and cold launch.

The public 0.1.0 tag and assets remain immutable and are visibly marked
superseded. Windows packaging and signing are deliberately deferred to a later
release operation.
