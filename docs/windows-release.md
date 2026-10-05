# Windows previews and production signing

Windows 11 x64 has an experimental manual test-preview lane. Production
Windows distribution, automatic updates, CI packaging, and tag automation
remain inactive. GitHub Actions is disabled in the source repository, so a
push, PR, or tag runs no remote checks or packaging. Windows preview work is
not a prerequisite for a Mac release.

[Platform previews](platform-previews.md) records the published installer,
exact source tag and commit, checksums, build evidence, and the combined source
under review. [Windows builds](windows-build.md) describes the native helpers,
NSIS packaging, development profiles, and packaged QA. The production desktop
lane remains [Apple-silicon macOS](macos-release.md).

## Preview contract

A Windows test preview uses a unique `windows-test-<version>` tag and a GitHub
prerelease in `Mat-Tom-Son/work-fold`. Its handoff contains:

- `work-fold-Setup-<version>.exe`, the per-user NSIS installer;
- `SHA256SUMS`, checksums for the recorded build; and
- `work-fold-<version>-windows-build.json`, binding the source commit, signer,
  toolchain, and helper provenance to the artifacts.

A test preview contains neither `resources/app-update.yml` nor `latest.yml`.
It has no automatic updates or publicly trusted publisher. A personal
self-signed, timestamped signature establishes artifact identity, not public
Windows trust. Testers may see an unknown-publisher or SmartScreen warning;
never ask them to install the personal certificate as a trusted root.

Published artifacts and candidate tags are immutable evidence. Never replace
an installer or manifest beneath an existing version, move a tag, or relabel
an earlier build. A later preview requires a higher unique version, a new
clean source commit, fresh native verification, and a new build and tag.
The combined source inherits a package version already used by a published
preview; that does not authorize another publication with that version.

## Prepare and verify a manual preview

Use a native Windows 11 x64 checkout with real Git symlinks, Node 24, npm
11.16.0 or newer, the stable Rust MSVC toolchain, and Google Chrome for native
Chrome acceptance. Follow the [contributor setup](../CONTRIBUTING.md) and
[development guide](development.md). Keep personal certificates and
credentials outside the checkout.

Finish the source and version changes, review them, and commit before building.
From that clean committed tree, run each local verification command and retain
its result:

```powershell
npm ci
npm run check
npm test
npm audit --audit-level=high
.\scripts\build-signed-windows.ps1 -TestBuild
```

Audit output requires review against the resolved dependency tree and admitted
local patches; an upstream advisory report alone does not establish that a
reviewed patched parser remains vulnerable. Record unresolved findings and
platform-dependent test failures honestly before a tester handoff.

The signing script uses the selected Node and its adjacent npm, invokes
`desktop:make`, and requires signing. Desktop preparation includes the pinned
native helpers, Pi preflight, and the real-Electron restricted-app probe.
After installer verification, `scripts/windows-test-build-record.mjs` records
the checksums and provenance; it refuses a dirty tree or an update feed.

Exercise the exact unpacked app and installed NSIS candidate using the
[packaged QA checklist](windows-build.md#packaged-qa-checklist). Native
acceptance includes Computer Control, Chrome connection and restart, installed
CLI routing, background-turn continuity, suspend/resume, and reinstall and
upgrade preservation. Mac-host source tests do not substitute for those runs.
Test in a disposable environment and retain the native build and acceptance
results with the exact commit.

Before an explicitly authorized manual publication, verify the installer
signature and hash, the source identity in the build record, the tag/version
relationship, and the absence of updater metadata. The prerelease notes must
state the supported Windows version, signing limitation, manual upgrade path,
known limitations, and the native evidence actually collected. After upload,
verify the downloaded assets against their own checksums and build record.
Tagging alone does not build or publish them.

## Installation and continuity

Testers upgrade by running a later NSIS installer. It replaces the application
in place while preserving `%APPDATA%\work-fold`. Unpacked applications use
`%APPDATA%\work-fold Development`; only an NSIS-installed app with its
installer-owned uninstaller selects production state. A test preview keeps
the work-fold app identity and profile, but that compatibility is not proof
of a future automatic-update path.

NSIS keeps `deleteAppDataOnUninstall: false`. Uninstall removes the application
and its PATH entry, preserving work-fold data and the per-user Chrome
registration for owned-registration repair on reinstall. Ordinary folders,
portable `.work-fold/` records, and frozen legacy Workspace state must remain
intact. work-fold never imports or mutates that legacy state.

Verify app permissions using the current [App platform foundation](app-platform-foundation.md):
installation grants all declared destinations, file permissions (a directory
permission binds to the whole work-folder), notification categories, and named
automations. Settings → Apps provides the person's revoke, disconnect, and
disable controls. Connection secrets are entered on the trusted setup surface.
Upgrade tests must preserve compatible connections, automation enabled states,
receipts, and local storage according to the owning contracts.

## Production qualification remains separate

A future Windows production lane needs an explicit contributor and release
architecture decision before activation. That work must establish publicly
trusted signing, feed ownership and updater metadata, an exact-source local
verification and publication boundary, artifact verification, and an installed
update proof between two unique versions. It must also qualify DPI and theme
behavior, tray and background work, sleep recovery, CLI and real symlink
fixtures, native helpers, uninstall/reinstall, and restricted-app authority
and data continuity on supported Windows hosts.

The retained feed-bearing `desktop:make` diagnostic is not a production
publication lane. Do not publish its `latest.yml`, point preview installers
at a production feed, or enable dormant workflows to make a preview pass.
No Windows or Linux artifact belongs in the Mac release repository.

`scripts/create-personal-signing-certificate.ps1` stores the personal PFX and
DPAPI-protected password under `%USERPROFILE%\.work-fold-signing`. The build
uses `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`; no PFX, password, private key,
or temporary verification download belongs in source control. If a cloud
signing lane is deliberately introduced later, use those Windows-specific
secrets and a product-owned identity rather than organization credentials.
Publicly trusted signing and its installed-updater transition require their
own verification.

The earlier inactive cloud-tag and first-release research is preserved in the
[Windows preview tag's historical guide](https://github.com/Mat-Tom-Son/work-fold/blob/windows-test-0.4.50/docs/windows-release.md).
Its proposed CI workflow and initial-version reset are not current commands.
Keep existing release versions, source tags, and historical evidence intact.
See [Security](../SECURITY.md) for the release-integrity boundary.
