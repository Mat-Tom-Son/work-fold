# Windows and Linux test previews

Status reviewed **2026-10-05**. work-fold has experimental Windows and Linux
downloads for early testers. This integration branch combines their reviewed
implementations; the published installers still belong to the exact source tags
below. The production distribution and automatic-update feed remain Apple-silicon Mac.
GitHub Actions is disabled. Preview uploads are manual and do not add release
gates to the Mac lane.

## Downloads and exact source

| Platform | Test download | Published source | Implementation branch |
|---|---|---|---|
| Windows 11, Intel/AMD x64 | [Windows 0.4.50](https://github.com/Mat-Tom-Son/work-fold/releases/tag/windows-test-0.4.50) | `windows-test-0.4.50`, commit `a52d34b34b1c894867e794fc962273a3c9d2abd2` | `claude/windows-port-foundation-52959d` |
| Ubuntu 24.04+ / Fedora, Intel/AMD x64 | [Linux 0.4.52](https://github.com/Mat-Tom-Son/work-fold/releases/tag/linux-test-0.4.52) | `linux-test-0.4.52`, commit `2e25a3b1e4ca8456f75ef1f26ef7aa623d371c15` | `codex/linux-desktop`, [PR #7](https://github.com/Mat-Tom-Son/work-fold/pull/7) |

Follow the installation steps and limitations in each release. Windows uses a
timestamped personal self-signed certificate that other PCs do not trust; do
not install that certificate as a trusted root. Linux packages have no production
package signatures. Neither preview has automatic updates.

[Windows draft PR #25](https://github.com/Mat-Tom-Son/work-fold/pull/25)
tracks the original port plus portable test-fixture fixes on
`codex/windows-preview-hygiene`; the original platform branch is preserved.

The combined source includes [Windows build instructions](windows-build.md)
and [Linux build instructions](linux-build.md). For reproducing a published
preview, use its original guide:

- [Windows build guide at the published tag](https://github.com/Mat-Tom-Son/work-fold/blob/windows-test-0.4.50/docs/windows-build.md).
- [Linux build guide at the published tag](https://github.com/Mat-Tom-Son/work-fold/blob/linux-test-0.4.52/docs/linux-build.md)
  and [Linux completion plan](https://github.com/Mat-Tom-Son/work-fold/blob/linux-test-0.4.52/docs/linux-roadmap.md).

Both sources include `main` through `cc16e4b`, including the Mac 0.4.41 app
baseline. `main` at `825b969` adds the subsequent landing-page download update.
Check the current PR head when reviewing new work; a moving branch is not the
source identity of an already published installer.

## Combined source and review status

As reviewed on October 5, [draft PR #27](https://github.com/Mat-Tom-Son/work-fold/pull/27)
on `codex/platform-preview-integration` combines the Linux port from
[PR #7](https://github.com/Mat-Tom-Son/work-fold/pull/7), the Windows review from
[PR #25](https://github.com/Mat-Tom-Son/work-fold/pull/25), and repository hygiene
from [PR #26](https://github.com/Mat-Tom-Son/work-fold/pull/26). The combined
source merges cleanly into the reviewed `main` baseline. These are review
branches; creating or pushing the draft does not merge it into `main`.

Runtime source `7e132525f4de0a7f2a78e90318435a24795f85ac` passed fresh dependency
installation and all reviewed patches, repository/TypeScript checks, the full
application suite (1,885 passed, 13 platform-specific skips, zero failures), and
Electron preparation on Apple-silicon macOS with Node 24.18.0 and npm 11.16.0.
Focused integration suites passed 38 tests with one Windows-only skip. The
Computer Control patch combines the actual reviewed source trees against their
common ancestor and pins 49 source files. No new Windows or Linux installer was
built or qualified from this combined source.

The source version is still 0.4.52 from the Linux preview. That version is not
permission to replace its published artifacts. Choose a higher unused version,
commit the final source, rebuild and qualify native artifacts, and retain the
matching tag and evidence for any replacement preview.

## What the published-preview evidence establishes

The October 5 review matched both build records to their tag commits and
compared recorded installer sizes and SHA-256 values with `SHA256SUMS` and
GitHub asset metadata. All nine Linux checksum entries matched their GitHub
digests. The Linux source manifest's 1,198 entries matched the tagged Git
content. This verifies the metadata relationships; it is not a fresh download
and execution of the installers on their target operating systems.

The Windows release records Windows 11 live testing and an in-place upgrade.
Its native application suite passed 1,813 tests, skipped 30 POSIX tests, and
could not create symlink fixtures for 24 further tests because Developer Mode
was disabled. Those 24 tests remain unqualified on Windows.

The Linux release records application, bridge, native Rust, packaging, private
Ubuntu/Fedora GNOME desktop, profile migration, and RPM upgrade/reinstall
checks. Final 0.4.52 DEB lifecycle checks were not repeated; the recorded DEB
result belongs to the earlier integrated 0.4.50 candidate. Private desktop
fixtures do not qualify physical GPU, GDM, host security policy, or sleep/wake.

Fresh checks on an Apple-silicon Mac pass repository and TypeScript validation
for both published sources. Linux's application suite passes 1,866 tests with
seven platform skips. Windows's initial run found three portable-fixture
failures; after fixes, the Windows review branch passes 1,860 tests with seven
platform skips. These Mac-host checks add
regression evidence; they do not replace native Windows or Linux acceptance.

## Work before a production release

1. **Qualify the remaining native paths.** On Windows, enable Developer Mode
   in a disposable test setup and rerun the symlink suites; finish uninstall/
   reinstall, mixed-DPI/multiple displays, and longer sleep/hibernate checks.
   On Linux, rerun the final DEB lifecycle and qualify the current Store Chrome
   companion, clean desktop/provider matrix, physical desktop/sleep behavior,
   and KDE support before claiming those paths. Windows 10 and ARM64 remain
   outside the qualified Windows preview scope.
2. **Validate the combined source on each platform.** The
   `codex/platform-preview-integration` branch resolves the shared Chrome/native
   hosts, Electron startup, Computer Control patch and provenance, readiness,
   setup UI, version, installer artwork, and test conflicts. The Computer Control
   patch was regenerated from both reviewed source trees against their common
   ancestor, with every file digest recalculated. Windows keeps its host-owned
   helper and HKCU registration; Linux keeps its portal lifecycle and immutable
   native helpers. Rebuild and rerun native acceptance on this combined source
   before publishing a replacement preview. Earlier platform evidence does not
   qualify a newly combined installer.
3. **Finish production distribution separately.** Establish Windows public
   signing/updater ownership and Linux production signing-key custody,
   repository hosting, and metadata renewal. Preserve the existing Mac identity,
   feed, and exact-source verification. Source changes need fresh build evidence
   and a new unique version before publishing replacement artifacts.

## Maintain the preview record

Publish only clean, committed, source-bound test builds with their platform tag,
build record, checksums, setup steps, and honest qualification limits. Retain
published tags and artifacts; fix forward. Keep each PR's description aligned
with its current head and latest preview, while retaining older evidence as
historical evidence. Update this page when the current preview or implementation
branch changes. Never infer a tag's source from a release's `targetCommitish`
label: resolve the actual tag commit and compare it with the build record.

Windows diagnostics and preview packaging are described in [Windows build](windows-build.md).
Mac release authority remains in [the release runbook](macos-release.md).
