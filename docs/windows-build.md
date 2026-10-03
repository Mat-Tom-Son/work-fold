# Windows build (inactive reference)

> Windows CI packaging and public distribution are inactive. These commands are
> retained as dormant manual diagnostics for a future deliberate Windows
> reactivation; they are not release gates and must not be added to CI or tag
> automation without first updating the contributor contract and release
> architecture.

Use Node 24 and npm 11.16.0 or newer for contributor installs and verification.
The minimum application runtime is Node 22.19.0. GitHub Actions is disabled;
the checked-in workflows are dormant diagnostics.

## Local Windows port

The Windows shell, Mica fallback, tray, PowerShell CLI, isolated development
profile, Electron Builder configuration, and NSIS configuration are retained.
The local port can be exercised with the existing manual commands below.
This does not reactivate public Windows distribution or tag automation.

The included Web, Documents, and Service Connections tools use the shared Pi
runtime. Documents discovers `soffice.exe` and `tesseract.exe` on PATH and in
the usual Program Files and per-user Programs locations; neither optional
engine is bundled. Chrome uses a Rust native messaging host built from
`desktop/native/chrome-host-windows` by the same `desktop:prepare` step and
registered per user under HKCU by the NSIS-installed app only; see
[Chrome distribution](chrome-extension-distribution.md#bootstrap-and-ownership).
Directories holding tokens and launch descriptors get a protected owner-only
DACL, because an inherited profile ACL can admit other principals.

Computer Control uses the dependency's Windows UI Automation backend through the
reviewed integration patch. `desktop:prepare` builds its Rust helper from the
pinned crate sources with `cargo build --release --locked` (target
`x86_64-pc-windows-msvc`), so Windows desktop preparation requires
[rustup](https://rustup.rs/) with the stable MSVC toolchain. The upstream
prebuilt executable is never shipped, and normal installation runs no upstream
helper setup. The build writes
`out/included-tools/computer-helper/work-fold Computer/` with the executable,
its license, and a `source.json` binding the build inputs to the manifest;
packaging places it under `resources\computer-helper`, outside `app.asar`, and
packaged verification rechecks that provenance. The helper is unsigned until
Windows signing is deliberately reactivated.

Windows source checkouts also need real Git symlinks for the shared Claude
Skill. Enable Windows symlink creation and use `git clone -c core.symlinks=true`
for a new checkout. If Git flattened that link into a text file, `repo:check`
must continue to diagnose it. The full suite includes symlink, POSIX-shell,
Unix-permission, and native-helper fixtures; failures in those fixtures must
be accounted for before claiming complete Windows verification.

Initial History metadata creation is shared by concurrent file captures, so
Windows rename contention cannot mark readable files as uncaptured. App working
copies use Windows' refusal to rename over an existing directory rather than
the POSIX empty-directory claim. App action journals retry only the exact staged
file replacement for brief Windows sharing failures; admission and worker
effects are never replayed.

## Feedback ladder

Desktop release builds are intentionally thorough and therefore slow: they rebuild multiple processes, run Pi resource preflight and the real-Electron restricted-app runtime probe, package Electron, create NSIS/update artifacts, and verify the result. That cost belongs at the release boundary, not in every edit-run cycle.

Use the smallest lane that exercises the layer you changed:

| Lane | Commands | Use it for |
|---|---|---|
| Type and behavior | `npm run check`, then `npm test` | Normal implementation feedback and every behavior handoff. |
| Desktop integration | `npm run desktop:prepare` | Electron/local API changes, runtime resources, renderer production build, native Pi preflight, and the real-Electron restricted-app probe. |
| Release-layout smoke | `npm run desktop:package:smoke` | Packaged-path behavior, Electron assets, preload/main integration, and local QA without NSIS compression. |
| Installer/release | `npm run desktop:make` | A versioned Windows release candidate only. |

During UI work, `npm run local:dev` is the normal live-reload loop. Run independent checks in parallel when the machine has capacity. Do not repeatedly run `desktop:make` to validate a renderer-only copy or styling change; promote the change through the later lanes once it is ready to hand off.

The `local:api`, `local:dev`, non-packaged Electron, and every uninstalled Windows package directory default to `%APPDATA%\work-fold Development`, separate from the installed product's `%APPDATA%\work-fold` state. That includes the feed-less smoke output and the feed-bearing `win-unpacked` directory created by `desktop:make`: updater metadata does not prove that a package has been installed. Only an NSIS-installed app with its installer-owned sibling uninstaller selects production state, including when the person chose a custom installation directory. Use `WORKFOLD_STATE_DIR` for the local API or `WORKFOLD_DESKTOP_STATE_DIR` for Electron only as an explicit override for a disposable test state tree; ordinary development and unpacked-package QA must not advance schemas in installed-user data. Packaged shell children receive the distinct `WORKFOLD_CLI_STATE_DIR` broker root, so CLI routing does not masquerade as consent to reuse desktop state.

The lanes are cumulative confidence, not interchangeable artifacts. A passing development server does not verify ASAR/package paths, and an unpacked app does not verify the NSIS updater output. The retained `npm run desktop:package` command creates the slower Forge package and is useful only when diagnosing or changing that alternate lane; routine packaged QA should use `desktop:package:smoke` because it shares Electron Builder configuration with the release.

Electron Builder's unpacked `--dir` lane does not generate `resources/app-update.yml`. work-fold therefore keeps updater controls disabled in that smoke package instead of presenting a missing-feed error. The NSIS `desktop:make` lane and the tagged GitHub build are the updater verification boundary.

In one warm local comparison on the primary Windows workstation, `desktop:package:smoke` completed in about 68 seconds and the Forge `desktop:package` lane took about 412 seconds—roughly 6.2 times faster and nearly six minutes saved. Exact times depend on hardware and caches; the structural saving comes from using the release packager while skipping the alternate Forge pass and NSIS artifact work.

CI runs `check`, `test`, and `desktop:package:smoke` as independent workflow steps so a later successful command cannot mask an earlier failure. Because the smoke command already includes `desktop:prepare`, CI does not run preparation as a separate duplicate step.

## Full Windows candidate

```powershell
npm run check
npm test
npm audit --audit-level=high
npm run desktop:make
```

`desktop:prepare` builds the renderer and Electron runtime, runs a native Pi resource smoke test, and launches the restricted-app hosts in real Electron. The restricted-app probe verifies sandbox startup and teardown, direct-network and out-of-lifecycle denial, bounded storage and active-view invalidation, History-covered file access, host-owned tabs and notifications, suspend behavior, and termination of a hung worker. A Node process, worker thread, or `vm` is not an equivalent security-boundary test. `desktop:package:smoke` adds Electron Builder's unpacked application plus packaged-asset and fuse verification. `desktop:make` includes preparation and uses Electron Builder as the canonical installer lane so the unpacked app, Electron fuses, NSIS installer, blockmap, `latest.yml`, and embedded `app-update.yml` come from one build.

Both package lanes place the public `work-fold.cmd` launcher, an extensionless `work-fold` shim for Pi/Git Bash, and the private `work-fold-cli.ps1` helper in `<package>\bin`, outside `app.asar`; packaged-asset verification rejects missing or accidentally archived shims. PowerShell and Command Prompt resolve the CMD launcher, which explicitly invokes the private helper with `-ExecutionPolicy Bypass`; POSIX-style shells resolve the extensionless shim and delegate to that same CMD entry point. Electron Builder copies the directory with `extraFiles`, and the retained Forge diagnostic lane mirrors it with an `afterComplete` hook. `RunAsNode` stays disabled—the command communicates with the desktop process through protocol-v1 request and response files instead of executing JavaScript through Electron.

The NSIS include adds `<install>\bin` idempotently to the current user's `HKCU\Environment\Path`, broadcasts `WM_SETTINGCHANGE`, and removes only that entry during uninstall. It does not modify any shell profile. The shim normally launches the parent `work-fold.exe`; `WORKFOLD_CLI_APP` and the bounded `WORKFOLD_CLI_TIMEOUT_MS` override exist for unpacked automated tests and should not be set by the installer.

The NSIS product must keep `deleteAppDataOnUninstall: false`. Uninstall removes
the installed application and its PATH entry, not the work-fold profile, Space
metadata, or any preserved legacy Workspace data. Chrome's per-user HKCU
registration also stays, pointing into that preserved profile as the macOS
manifest does, so a reinstall resumes the selected Chrome profile through its
owned-registration repair; while no app is installed, **Open work-fold** in the
extension reports that the app is not running.

Protocol v1 exposes only read operations (`context`, `spaces list`, `tasks list`, and `capabilities list`). Its request directory is a same-user coordination channel, not an authenticated caller boundary. Do not add mutations to this protocol without caller authorization and an authenticated transport or equivalent per-launch request authentication.

The CLI is an adapter over the shared `WorkFoldKernel`, not a packaging-only utility. See [work-fold management layer](management-layer.md) before changing its snapshots, commands, shims, or broker.

## Candidate outputs

`desktop:make` verifies but does not publish. A successful local candidate places these artifacts under `out/builder`:

| Path | Purpose |
|---|---|
| `win-unpacked/work-fold.exe` | Exact unpacked application used to assemble the installer. |
| `win-unpacked/resources/app-update.yml` | Installed-app GitHub feed configuration. Its presence enables updater controls. |
| `work-fold-Setup-<version>.exe` | NSIS per-user Windows installer. |
| `work-fold-Setup-<version>.exe.blockmap` | Differential updater block map. |
| `latest.yml` | Public updater version, size, path, and SHA-512 metadata. |

The tagged cloud workflow rebuilds these outputs from the tag and adds `SHA256SUMS.txt` before publishing. Local artifacts and cloud artifacts are separate builds and therefore are not expected to be byte-identical; each must verify against its own manifest and signature.

For an unsigned NSIS installer:

```powershell
npm run desktop:make
```

For a build signed with the current user's personal certificate:

```powershell
.\scripts\create-personal-signing-certificate.ps1
.\scripts\build-signed-windows.ps1
```

The PFX and its DPAPI-protected password are stored in `%USERPROFILE%\.work-fold-signing`, never in this repository. The certificate is self-signed and therefore remains untrusted on other computers unless they deliberately trust its public certificate. Replace the two GitHub signing secrets with a certificate-authority-backed PFX when one is available.

`build-signed-windows.ps1` uses the Node on PATH (or `-Node <path>`), requires Node 22.19.0 or newer (Node 24 for release builds), and runs the npm installed beside that Node, so an older system npm cannot be picked up.

## Packaged QA checklist

- Launch the exact `win-unpacked` binary rather than an older installed copy and confirm **About work-fold** reports the candidate version. It must use `%APPDATA%\work-fold Development` even when the release candidate contains `app-update.yml`; install through NSIS for any test that intentionally requires production state.
- Exercise Files, Chats, History, the Skills & Extensions popup, Settings including Settings → Apps, native menus, close-to-tray, and background-turn continuity.
- Confirm the `desktop:prepare` output reports a passing restricted-app Electron smoke. Treat a skipped, mocked, or Node-only substitute as a failed release gate.
- In a disposable Space, add the checked-in restricted Connected inbox example through the advanced local-preview path. Confirm adding it grants no network destination, Space file, notification category, connection, or automation schedule; then exercise its rail navigator, persistent Space-owned tab, storage refresh, and explicit grant/revoke controls.
- Enable **Refresh inbox** and its reviewed notification category separately, then run it once. Confirm the durable receipt and app result reach the active view, inactive views recover app state from storage when reopened, and clicking a Windows notification targets the exact owning Space and app. Disable the automation and confirm **Run now** still works but cannot notify. Windows Focus Assist may suppress presentation, but the host-accepted versus denied outcome must remain honest.
- Revoke the example's grants, stop or remove it, suspend/resume Windows when practical, and confirm its views, workers, pending notifications, and brokered authority do not survive their lifecycle.
- Verify Mica on Windows 11 22H2+ and the solid fallback where reduced transparency or an older host disables it; exercise light, dark, and system themes.
- Verify unpacked smoke builds report updates as unsupported without a red missing-feed error, while the NSIS candidate contains `resources/app-update.yml` and exposes **Help > Check for Updates…**.
- Exercise a Space through both its normal path and any available Windows 8.3 short-path alias; the watcher must canonicalize the native watch root without changing the logical policy root.
- Run `desktop:verify:release`, inspect Authenticode status, and compare installer size/hash to `latest.yml` before handoff.

See [Windows releases and signing](windows-release.md) for the public tag workflow.
