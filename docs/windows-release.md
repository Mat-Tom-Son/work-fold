# Windows releases and signing (inactive reference)

> There is no active Windows release workflow or public Windows distribution.
> This document preserves prior signing and installer research for a future
> deliberate reactivation only. Pushing a version tag does not build or publish
> Windows artifacts, and Windows is not a prerequisite for the Mac release.

work-fold updates from the public releases in `Mat-Tom-Son/work-fold`. Keep the application id, executable name, package name, repository, and updater cache name stable so installed copies continue to recognize later versions.

- [Public releases](https://github.com/Mat-Tom-Son/work-fold/releases)
- [GitHub Actions](https://github.com/Mat-Tom-Son/work-fold/actions)

## Release contract

Every public release is rebuilt from an exact `v<package version>` tag and must contain four artifacts from that one cloud build:

- `work-fold-Setup-<version>.exe`
- `work-fold-Setup-<version>.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

Draft releases are not update candidates. Never replace an installer or manifest beneath an existing version. Fixes and rollbacks both require a newer unique version and tag.

The first public work-fold release is `0.1.0`. The repository used `0.8.0` as a
development holdover during the cutover and reset `package.json` only when the
complete clean-break candidate was ready. From the `0.1.0` release commit
forward, all work-fold releases increase monotonically.

## Clean-break release prerequisites

Before publishing `v0.1.0`:

1. Ship and verify the final legacy Workspace containment release from the last
   legacy source line. It must treat `.work-fold/` as inert and must block managed
   recursive deletion when a claimed folder contains `.work-fold/`. Freeze the
   legacy source and Mac-release repositories after that release; they must
   never receive work-fold commits, tags, binaries, or updater metadata.
2. Confirm the new public source repository is `Mat-Tom-Son/work-fold` and the
   separate public Mac feed is `Mat-Tom-Son/work-fold-mac-releases`.
3. Verify a fresh work-fold install starts with an empty new profile and does
   not open, import, migrate, mutate, wipe, or delete the legacy Workspace
   profile or `.workspace/` metadata. Pi personal resources and authentication
   may remain shared; Pi sessions must use `sessions/work-fold/`.
4. Verify the NSIS configuration keeps `deleteAppDataOnUninstall: false` and
   uninstalling either product does not remove the other's data.
5. Require a valid Authenticode signature from a new work-fold or
   product-neutral signing identity for the `0.1.0` installer. Do not reuse a
   legacy product-branded certificate. A self-signed identity satisfies the
   artifact-signature gate but does not establish public Windows trust, so that
   limitation must remain explicit.

The first work-fold installation is a manual clean install, not an update from
Workspace. After `0.1.0` is installed and proven, publish a higher work-fold
version and complete an installed updater proof from `0.1.0` to that version.

## Maintainer runbook

### 1. Prepare a unique version

Start from a clean `main` branch and use Node 24 when available; the supported floor is Node 22.19.0.

```powershell
# For the first release only, after every prerequisite is ready:
npm version 0.1.0 --no-git-tag-version
# Later releases use:
# npm version patch --no-git-tag-version
npm ci
npm run check
npm test
npm audit --audit-level=high
npm run desktop:make
git diff --check
```

Use `./scripts/build-signed-windows.ps1` instead of the final `desktop:make` command when building with the current user's personal certificate. `desktop:make` verifies the local NSIS candidate but never publishes it.

`desktop:make` includes `desktop:prepare`; a release candidate therefore must pass both native Pi preflight and the real-Electron restricted-app probe before Electron Builder creates the installer. Do not accept a Node-only sandbox test, a skipped Electron probe, or a package produced after that probe failed.

Review the complete diff and inspect the exact unpacked application and installer as described in [Windows build](windows-build.md). Confirm the version, Files/Space language, tabs, menus, background turn continuity, CLI, Mica/fallback, updater surface, and the restricted-app install/review, rail/tab, default-off grant and automation, run-receipt, storage, notification, suspend, and teardown paths. The local and cloud installers are separate builds, so use local QA to validate behavior rather than expecting byte-for-byte identity.

Prepare a complete checked-in release note at `docs/releases/<version>.md`. For
`0.1.0`, create a new work-fold release note rather than rewriting the preserved
legacy Workspace notes. The tagged workflow can generate comparison metadata,
but the public release body must explain material user-facing behavior,
authorization and security boundaries, known limitations, clean-install
behavior, and verification. Do not leave a feature release with only a
generated changelog link.

### 2. Commit, push, and gate the tag

```powershell
git add -A
git commit -m "release: work-fold <version>"
git push origin main
```

Wait for the `CI` workflow on that exact commit to complete successfully. It runs type checks, tests, and the canonical unpacked Electron Builder smoke package as separate steps. Do not tag a commit whose main-branch CI is missing, cancelled, or failing.

Create an annotated tag pointing to the same commit and push only that tag:

```powershell
git tag -a v<version> -m "work-fold <version>"
git push origin v<version>
```

The tag must match `package.json` exactly. Do not move or recreate a published tag.

### 3. Watch the tagged workflows

The tag starts both `CI` and `Windows Release`. The release workflow performs independent named steps for:

1. tag/version validation;
2. dependency installation;
3. source checks;
4. tests;
5. high-severity dependency audit;
6. Windows installer build and release verification, including the real-Electron restricted-app probe inherited from `desktop:prepare`;
7. SHA-256 checksum generation;
8. retained workflow-artifact upload; and
9. draft creation followed by public release publication.

After publication, compare the generated GitHub body with `docs/releases/<version>.md`. Replace the generated-only body with the checked-in release note when needed, retaining a full-changelog link. This is a documentation correction, not permission to replace artifacts or reuse the tag.

Each gate is a separate workflow step so a later successful command cannot mask an earlier test or audit failure. Treat any failed workflow as an unaccepted release. Inspect whether GitHub created a draft or public asset before the failure; if it did, never reuse that version or tag. Diagnose the failure, bump the version, and repeat from a clean commit.

### 4. Verify the public release independently

Do not stop at a green workflow badge. Fetch the public release and verify:

- all four required assets exist and are non-empty;
- `latest.yml` reports the intended version, installer name, installer size, and SHA-512;
- downloaded `latest.yml`, blockmap, and installer SHA-256 values match `SHA256SUMS.txt`;
- the downloaded installer's computed SHA-512 matches `latest.yml`;
- Authenticode contains the expected signer when signing was required; and
- the public release is neither a draft nor a prerelease; and
- the public release body reflects the checked-in `docs/releases/<version>.md` instead of only linking to a generated comparison.

GitHub's release API exposes asset names, sizes, URLs, and SHA-256 digests for an additional cross-check. Keep downloaded verification files outside the repository and remove them after the audit.

### 5. Exercise the installed updater

For `0.1.0`, install the signed public artifact manually and verify the empty
new profile, product identity, CLI, updater feed, Spaces, Chats, restricted-app
clean state, and coexistence with untouched legacy Workspace data. No Workspace
build is a valid lower work-fold updater source.

For the next higher work-fold release, keep `0.1.0` installed for the final
updater smoke test:

1. Confirm the installed version and `resources/app-update.yml`. Record one installed version-2 restricted app's reviewed digest, grants, connection status, automation settings and recent receipt count, and a harmless local-storage value when available.
2. Open **Help > Check for Updates…**.
3. Confirm the new version is offered without a missing-feed or network error.
4. Choose **Update now** to download it.
5. Confirm work-fold performs its update-specific shutdown and relaunch after the download. If a ready-update prompt appears instead, exercise **Restart now** or choose **Later** and then explicitly quit the app.
6. Confirm the restarted installed application reports the new version and preserves its Spaces, Chats, preferences, Pi state, version-2 restricted-app installs and reviewed digests, explicit grants, automation settings, receipts, and local app storage. Reopen the app's owning Space and verify its rail surface and any persistent Space-owned tab still resolve to that Space. Confirm the frozen legacy Workspace profile remains untouched and is still not imported.

Do not silently install over a user's test environment merely to verify a release; leave the lower installed version available when the user is meant to exercise the update themselves.

## Updater behavior and feed gating

The NSIS/installed package contains `resources/app-update.yml`, which points to the public GitHub repository. work-fold never embeds a GitHub token and never overrides that feed at runtime. Installed Windows builds check silently after startup and every four hours; **Help > Check for Updates…** performs an interactive check.

Checks do not download an update. When a version is available, the user chooses **Update now**. work-fold downloads the installer, validates the SHA-512 from `latest.yml`, performs its update-specific shutdown, and asks electron-updater to relaunch. If a downloaded update becomes ready outside that immediate action, work-fold offers **Restart now** or **Later**; a ready update chosen for Later installs on explicit application quit.

Electron Builder's unpacked `--dir` smoke lane does not create `resources/app-update.yml`. work-fold deliberately reports updates as unsupported in that package instead of showing a red missing-manifest error. The installed NSIS package and tagged release are the updater boundary.

## Signing

GitHub Actions requires these repository secrets before a tagged Windows
release can publish:

- `WIN_CSC_LINK`: base64-encoded PFX bytes.
- `WIN_CSC_KEY_PASSWORD`: the PFX password.

The workflow fails before dependency installation when either secret is absent
and always sets `WORKFOLD_REQUIRE_CODE_SIGNING=1` for a tagged build. A
non-release local test build may remain honestly unsigned, but no tagged
Windows release may publish that way. A failed tag run can be rerun after the
maintainer configures the signing secrets; do not move or replace the tag.

`scripts/create-personal-signing-certificate.ps1` creates an exportable self-signed code-signing identity in the current user's Windows certificate store and backs it up under `%USERPROFILE%\.work-fold-signing`, outside the repository. It provides stable personal artifact identity but not public Windows trust. Other computers may report an untrusted root or SmartScreen warning even though the artifact contains that signature.

The first work-fold release must use a newly created work-fold or
product-neutral certificate subject. A certificate whose subject names the
legacy product is not reusable even when its key remains available.

While the personal self-signed certificate is in use, set the repository variable `WORKFOLD_TRUSTED_CODE_SIGNING=0`. The update feed then omits `publisherName`: GitHub SHA-512 metadata remains enforced, but Authenticode is not treated as a public trust anchor.

After configuring a publicly trusted signing lane, set `WORKFOLD_TRUSTED_CODE_SIGNING=1`. The current workflow can accept a CA-backed OV/EV PFX through the two secrets above; Microsoft Artifact Signing would require a separate, deliberately implemented cloud-signing integration rather than a PFX substitution. With trusted signing enabled, Electron Builder embeds the publisher name and electron-updater requires a matching valid signature. Test that transition through an update from an older installed version before treating the new identity as production-ready.

Keep every PFX, password, private key, provider credential, and temporary verification download outside source control. See [Security](../SECURITY.md) for the release-integrity boundary.
