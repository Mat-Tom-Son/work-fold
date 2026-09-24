# Linux completion plan

Research date: **2026-09-23**. Checkpoint: **2026-09-24**. Status: **GNOME Wayland bridge implemented; package and desktop qualification ongoing**.
This document scopes the work after the local Linux candidate. It does not
claim the proposed capabilities are implemented or authorize publication.
The [Linux build guide](linux-build.md) describes the current lane;
[Extensions and computer work](extension-foundation.md),
[tool feedback](tool-feedback.md), and the
[collaboration contract](collaboration-contract.md) remain the owning contracts.

## Outcome and scope

Deliver the existing work-fold app on **Ubuntu and Fedora, x86-64 Intel/AMD PCs**:
an installed desktop application, the native Pi runtime and included tools,
working credentials and browser connection, reliable computer work on Wayland,
preserved data across upgrades, and a verifiable public distribution channel.
Keep Pi's tool loop, resource loader, packages, Skills, Extensions, sessions,
and model registry. Linux needs platform integration, not another agent runtime.

Use three completion milestones:

1. **Daily-use desktop candidate:** installed DEB/RPM, real Worker turns,
   credential persistence, lifecycle and desktop integration, and honest tool
   readiness. Existing AT-SPI capabilities remain useful during this milestone.
2. **Wayland computer work:** explicitly shared capture targets, screenshots,
   semantic actions where available, physical input where granted, visible
   ownership, and verified stopping, revocation, and recovery.
3. **Public Linux release:** clean source-bound artifacts, qualified desktop
   matrix, real upgrades, signed distribution, operational ownership, and
   user documentation. The existing macOS release lane stays intact.

The first milestone is independently useful. Calling it a complete Wayland
computer-use release would be premature; the second and third milestones have
additional acceptance requirements below.

### Reuse established libraries and frameworks

**Implementation constraint from the user:** prefer trusted, maintained
frameworks and libraries that reduce the work we own. Custom code should connect
those components to work-fold's target identities, ownership, cancellation and
results. Implementing D-Bus, PipeWire, EI wire formats, keyboard-layout tables,
credential encryption or package-repository formats ourselves is outside the
intended approach.

The following are the default choices to validate in L0, not newly installed
dependencies or unconditional endorsements of every latest release:

| Layer | Preferred reuse | Selection rationale and remaining validation |
|---|---|---|
| Desktop and agent | Existing Electron, React, Pi and Pi computer tools | Preserve the working application and native tool model; add Linux adapters |
| Portal client | ASHPD with Tokio | Typed Rust portal/session/request APIs fit the existing Rust helper; check combined ScreenCast/RemoteDesktop, cancellation and the existing zbus dependency |
| Capture and conversion | GStreamer Rust bindings, PipeWire's `pipewiresrc`, `videoconvert` and bounded `appsink` | Start with a media framework that owns negotiation, buffers and conversion; prove portal-FD use, geometry metadata, baseline plugins and teardown |
| Smaller capture alternative | PipeWire's `pipewire-rs`/`libspa` bindings | Use if the GStreamer spike demonstrates a concrete packaging or metadata limitation; avoid maintaining two production capture backends initially |
| Emulated input | Upstream libei client library | Reuse its protocol/device machinery through an existing qualified binding, or a small generated FFI boundary if needed |
| Keyboard maps | libxkbcommon through maintained bindings | Use compositor-supplied maps and established layout/compose processing; test remaining typing semantics |
| Credential storage | Electron safeStorage and desktop keyrings | Retain the existing integration; qualify its actual behavior rather than introducing an encryption format |
| Installers | Existing electron-builder DEB/RPM/AppImage targets | Keep custom hooks limited to work-fold's CLI/native-host integration |
| Repository publication | aptly for APT; `createrepo_c`, `rpmsign` and GnuPG for RPM | Standard metadata and signing tools, wrapped by a small source/artifact verification script |

ASHPD wraps the XDG portal interfaces using zbus, supports Tokio, and exposes
combined remote-desktop/screencast sessions and EIS connection. This makes it the
first portal candidate rather than expanding our current handwritten read-only
proxy into a full client. ASHPD 0.13.13 uses zbus 5 while the current helper uses
zbus 4; isolate or deliberately migrate that boundary during the spike.
[ASHPD](https://docs.rs/ashpd/latest/ashpd/),
[RemoteDesktop API](https://docs.rs/ashpd/latest/ashpd/desktop/remote_desktop/struct.RemoteDesktop.html),
[dependency manifest](https://docs.rs/crate/ashpd/latest/source/Cargo.toml)

GStreamer's existing PipeWire source accepts a connection descriptor and target;
`videoconvert` and `appsink` provide frame conversion and application delivery.
Use those library APIs inside the helper, with bounded queues, instead of parsing
CLI output or writing our own media pipeline. Verify the required behavior on
Ubuntu's installed versions; current upstream properties are not proof of
baseline availability.
[PipeWire source implementation](https://raw.githubusercontent.com/pipewire/pipewire/master/src/gst/gstpipewiresrc.c),
[videoconvert](https://gstreamer.freedesktop.org/documentation/videoconvertscale/videoconvert.html),
[Rust AppSink](https://gstreamer.pages.freedesktop.org/gstreamer-rs/stable/latest/docs/gstreamer_app/struct.AppSink.html)

The lower-level [PipeWire Rust bindings](https://pipewire.pages.freedesktop.org/pipewire-rs/pipewire/)
are a credible alternative, but require more buffer/event-loop integration.
[libportal](https://libportal.org/class.Session.html) is another established
portal client if ASHPD has a blocking gap; choosing it would add a GLib/FFI and
system-library compatibility consideration. Pick one portal owner so capture
and input share the same granted session.

Electron's built-in capture is also worth retaining for capture-only product
features. Its documented API provides desktop media sources, but no combined
RemoteDesktop/EIS session handle for the Rust controller. The design inference
here is that one native session owner makes capture/input identity and Stop
easier to prove; revisit that choice if a supported Electron API removes the
integration burden. [Pinned Electron capture API](https://raw.githubusercontent.com/electron/electron/v42.6.1/docs/api/desktop-capturer.md)

For input, prefer the maintained upstream
[libei implementation](https://libinput.pages.freedesktop.org/libei/api/index.html).
The Rust-native [reis](https://docs.rs/reis/latest/reis/) option was also reviewed;
its current documentation explicitly describes it as incomplete and subject to
change, so it is not the default merely because the helper is Rust. A narrow
binding to a mature C library can create less maintenance than adopting a newer
protocol implementation. [libxkbcommon](https://xkbcommon.org/doc/current/)
supplies the established keymap/compose foundation.

Use upstream maintenance history, documented APIs, distro availability, license
compatibility, release integrity, dependency size and a working cancellation
test to select exact versions. Pin them in the existing lock/provenance chain.
Prefer distro-managed native libraries for DEB/RPM; explicitly inventory and
verify any libraries/plugins bundled into AppImage. Propose reusable Pi adapter
changes upstream when ready, while keeping local patches small and auditable.

L0 must finish with one selected stack and reasons for any departure from these
defaults. The estimates below assume library-based integration, not implementation
of the underlying desktop protocols.

### Implementation checkpoint — 2026-09-24

Historical 0.4.32–0.4.35 source/artifact records remain preserved in `out/linux/`.
They describe local uncommitted candidates, not public releases. The overnight
work adds the production Wayland bridge and acceptance infrastructure; a newer
unique candidate is required for changed artifact bytes. The complete 0.4.36
candidate fixes first-window mapping and native path opening on Linux; both
private packaged-desktop runs pass. Its immutable source archive, manifest and
four CycloneDX inventories are included in the signed test repository evidence.

The branch now incorporates upstream `main` at
`38e1cc7738376e26483445dc18e7ebdbdc0d6aeb`, including the 0.4.33 UI release.
The complete 0.4.37 DEB, RPM and AppImage candidate now contains that source;
the earlier artifacts retain their original source.
The new recoverable Folder Chat deletion also revokes a cold Chat's screen grant
before moving its transcript, and restoring that Chat never restores the grant.
A regression test reproduces the missing revocation before the integration fix.
The merged unpacked application passes packaged desktop acceptance on both
private GNOME seats. Linux Open with now delegates selected `.desktop` entries
to GIO; its real-launch test preserves spaces and shell-like filename characters.
Its source archive, manifest and four SBOMs are covered by verified disposable-key
repository signatures. Both APT and DNF pass .36→.37 upgrade, remove/reinstall,
state and encrypted-credential preservation, and tamper rejection.
The final .37 packaged desktop runs also verify clean native Quit and removal
of the per-launch CLI token on both private GNOME seats.

| Work | Evidence and limits |
|---|---|
| L0/L3–L6 native bridge | The bundled [Rust helper](../desktop/native/linux-wayland/Cargo.toml) uses ASHPD 0.13.13, GStreamer 0.25, libei and libxkbcommon. A combined portal grant, bounded frames, visual target identity, compositor geometry, accepted-turn ownership, stale-observation fencing, cross-process seat exclusion and paired input are implemented. Native unit and protocol tests pass. No restore token is retained. |
| L3–L6 live desktop | Fresh private GNOME 46/Ubuntu 24.04 and GNOME 50/Fedora 44 runs pass 100/125/150/200% scaling and US/German keymaps, click/type/scroll/shortcut/drag, independently verified saved bytes, screen-lock revocation and stopping a pending chooser. The actual Pi client/tool/host/native path passes on both. That provider is scripted; login services are simulated with python-dbusmock. The packaged setup UI, warm Chat, native folder chooser/cancel, Nautilus reveal, native close/minimize, accepted-turn continuity and desktop-switcher restore also pass on both. Two-monitor tests also pass with a 100% primary and 100/125/200% secondary at a nonzero desktop offset. 90°, 180° and 270° rotations also pass at 100/125% on both. A Fedora 44 full QEMU guest also passes installed RPM capture/input, native dialogs/reveal, minimize/turn continuity, restoration and second-instance handling under real GDM and SELinux enforcing. It uses the verified Cloud image plus distro GNOME packages, not a pristine Workstation ISO. Real GNOME lock/unlock also revokes the old grant and requires a fresh chooser before capture resumes. Both Ubuntu 26.04.1 and Fedora 44 KVM guests now pass the installed native flow and clean Quit; Ubuntu also passes real lock/unlock revocation. Fedora’s software VGA guest passes real S3 turn continuity and fresh-grant capture. The separate Ubuntu VGA/KVM guest also passes a measured five-second S3 cycle with accepted-turn continuity and a fresh grant. Physical GPUs and other IME engines remain open. |
| L1 actual model | Ollama 0.34.3 and a local Qwen3 4B instruct model complete a real Pi native-write task through packaged 0.4.36 and the merged-main 0.4.38 candidate, preserve exact output and durable records, then pass cold-relaunch verification. No paid provider, OAuth or vision-model claim follows. |
| L1 environment/credentials | Live session variables survive shell hydration. Real Electron/GNOME Keyring tests cover encrypted persistence, corrupt-file preservation, basic-text rejection, missing/locked service and recovery. Installed credential stores survive .34→.35 and .35→.36 upgrade/reinstall. The Fedora GDM guest also passes synthetic key entry through Settings, encrypted-byte verification, cold-relaunch persistence and removal. Native unlock allows startup; cancelling every repeated prompt shows an actionable unlock/restart error and preserves the encrypted file. An encrypted profile's app UI needs an unlocked keyring; its ordinary folders remain accessible outside the app. The packaged stores also pass real KWallet encrypted persistence, daemon restart, native unlock/cancel and rejection checks in a private KDE container; installed KDE Settings and desktop acceptance remain open. |
| L2 sandbox and lifecycle | .34 refuses explicit or AppImage-injected `--no-sandbox` before state initialization. DEB/RPM .34→.35 and .35→.36 upgrades and reinstalls preserve meaningful app state and credentials, including resolution of new Wayland library dependencies. Actual renderer sandbox/NoNewPrivs/seccomp checks pass. .34 AppImage direct FUSE launch passed on Fedora; extraction passed on Ubuntu. Earlier .32/.33 AppImages are unsuitable for distribution. |
| L7 actual Chrome | Published Store companion 1.0.0 and Chrome 154 pass authenticated native messaging, navigation/evaluation, two-Chat ownership, disconnect and browser/host restart in isolated profiles. Ordinary Store Add to Chrome/native confirmation and explicit foreground image feedback also pass on X11; managed Store installation and foreground capture also pass on private native Wayland. Background screenshots still time out; broader version/profile coverage remains open. Browser-restart tests explicitly request restoration of the fixture tabs. |
| L8 signed staging | Aptly, createrepo_c, rpmsign and GnuPG produce verified local APT/DNF/AppImage signatures with a disposable test key. Real APT/DNF install, .34→.35 and .35→.36 upgrades and reinstalls preserve state; wrong-key, tampered metadata and package tests reject altered content. New full builds retain an immutable source archive and four upstream CycloneDX dependency inventories, all covered by signed repository evidence. No production key, HTTPS publisher, renewal job or public Linux release exists. |
| Regression lane | The merged application suite passes 1,560 tests with 8 explicit skips (1,568 total), plus repository and both TypeScript checks. Linux CI now includes four-scale native GNOME and packaged desktop acceptance; a complete remote CI run for these source bytes is still required. |

The Ubuntu 26.04.1 GDM guest passes installed .37 capture/input, native folder
dialogs/reveal, close/minimize with a pending accepted turn, persisted completion,
restoration through GNOME's named work-fold entry, second-instance reuse and clean
native Quit, with AppArmor unchanged. Real lock/unlock revokes the old grant and
a fresh chooser captures successfully. Its earlier synthetic provider-key
Settings test verifies encrypted storage, cold-relaunch persistence and removal.

The original CPU-emulated Ubuntu guest repeatedly hit the production 10-second
first-frame deadline. Clock animation and earlier EIS initialization did not
resolve it; a diagnostic 30-second deadline received a frame after 12.4 seconds.
KVM CPU execution resolves that test latency while retaining software-rendered
virtual graphics. The production deadline and initialization order are unchanged.
A single Alt+Tab also selected Ubuntu Welcome rather than work-fold; the harness
now resolves the named GNOME app entry and clicks its visible bounds using the
real portal input driver, then verifies the compositor image and actual focus.

Fedora's virtio display fails S3 resume even without work-fold, on both kernel
6.19.10 and 7.2.7; no-app s2idle also failed. The symptom matches
[QEMU's upstream virtio S3 report](https://gitlab.com/qemu-project/qemu/-/issues/2520),
which is supporting evidence rather than an app wake result. Separate overlays
preserve those failures. The VGA/bochs-drm KVM guest on kernel 7.2.7 now passes a
real S3 cycle with .37: the same app process survives, its pending accepted turn
completes and persists, sharing stays revoked, and a fresh chooser grant captures.
Native dialogs, minimize/restore and clean Quit pass afterwards. The test's
private debugger socket disconnects across sleep; reattaching neither restarts
nor reloads the app. This qualifies the disposable VM, not physical GPU sleep.

Candidate .38 changes the Linux package icon to the existing 512px brand asset.
GTK cannot resolve .37's sole 1024px icon because that directory is absent from
the distro's hicolor index. A guarded live GTK launcher probe reproduces the
failure; after signed .37→.38 upgrades, both real GDM guests resolve the
installed icon at 1× and 2× scale. AppArmor and SELinux stay enabled.
The .38 build, source evidence and four SBOMs are complete; its signed APT/DNF
.37→.38 upgrade/remove/reinstall and tamper-rejection lanes pass, preserving
application state and encrypted credentials. Both GDM guests pass the complete
native desktop flow and clean Quit on .38. Fedora repeats the accepted-turn
sleep/resume test, with the kernel recording S3 entry/resume; it wakes too
quickly for the host observer to record a sustained QMP suspended state. This
does not qualify a sustained hardware sleep interval. All 1,560 application tests
pass again with 8 explicit skips. Version .39 is reserved for the clean source
branch/CI candidate; the local .38 artifacts retain their original source archive. Real Chrome 154 Stable and Chrome for Testing 155 Beta both pass Store
connection, explicit foreground capture and restart tests on .38. Background
capture fails on both, so both full Chrome harnesses remain red; Beta is
diagnostic coverage rather than the supported release channel.

The follow-up native input audit adds AltGr/level-three and level-five chords
through libxkbcommon's actual key state. German `@`, `€`, braces, brackets,
backslash, pipe and tilde now pass exact GTK saved-byte checks on both private
GNOME desktops at 100/125%, alongside balanced key releases and the Pi path.
The 45 native tests pass with one explicitly ignored live-bus test; locked
modifier behavior is covered without toggling Caps Lock. Compose/IME-only text
still fails before emission. These helper changes follow the immutable .38
candidate and need the next packaged candidate's qualification.

The actual Pi semantic-tool path also passes exact multilingual saved-byte
checks on both private desktops. It discovers only the owned GTK editor, sets
and saves accents (both composed and decomposed), CJK, Arabic, Hindi and emoji,
then clears the field before the independent physical-input test. No portal
grant or physical click/key is used for these semantic actions. A separate
multiline GTK TextView check passes through the same bundled AT-SPI helper.
This uses Pi's existing accessibility implementation; it does not establish
IME preedit/candidate behavior or universal Unicode physical typing.

A separate installed .38 test now verifies real IBus/libpinyin on both owned
Ubuntu 26.04.1 and Fedora 44 guests, using distro packages and CJK fonts. Native
Latin keys create preedit, Space selects `你好`, and the GTK editor saves exact
bytes. The actual Electron Worker composer also receives native composition,
keeps the Chinese commit and Enter composition confirmation as an unsent draft,
and quits cleanly. No Electron IME flags are needed. Other engines and sequences
remain open. The follow-up renderer fix also leaves IME Enter/Tab/arrows/Escape
to the input method, including keycode 229 after compositionend; its rendered
regression fails before the fix and passes afterwards, preserving ordinary
Enter-to-send. The full application suite passes 1,561 tests with eight explicit
environment skips, and TypeScript/repository checks and desktop preparation pass.

Live scale changes also pass on both private compositors: old observations
cannot produce GTK clicks or keys after 100→125%, 125→100%, 150→100% or
200→100%. Closing the old helper and accepting a fresh chooser restores exact
German/AltGr saved bytes and balanced input at the new scale. The shared CI
matrix now retains this regression check. Physical monitor hotplug is still
separate qualification work.

The first remote .39 CI run passes all four Mac jobs. Its Linux application
suite finds a build-image setup defect: GitHub's numeric checkout UID has no
passwd entry, so Pi's MCP credential-lock code cannot resolve `os.userInfo()`.
The Docker build now maps that UID/GID to its existing unprivileged account;
rootless Podman retains its normal 1000 mapping. A local run with the registered
UID 1001 passes all 1,558 enabled application tests (10 explicit environment
skips), including the failed MCP case; repository/TypeScript checks and full
Electron preparation also pass. Full remote Linux qualification remains pending
on the corrected source.

The next remote run passes all Mac jobs and all 1,558 enabled Linux application
tests, then reproduces Ubuntu's user-namespace restriction during Electron
preparation. A named AppArmor profile now grants namespace creation only to the
explicitly selected disposable build containers; the host restriction sysctl is
unchanged. The same Electron preload smoke fails before this profile and passes
under it in the owned Ubuntu VM, retaining Chromium sandboxing. The CI command
also checks user/PID/network namespace creation before compiling anything.
The full remote packaging and desktop matrix still needs a successful run.

That corrected remote run builds the .39 DEB/RPM/AppImage candidate, passes
built-ASAR tools, installed sandbox/Pi smoke and encrypted-credential restart
checks, then stops during private GNOME startup. Its short failure did not retain
the compositor log. Startup now prints the relevant private logs, and the Ubuntu
desktop image explicitly restores its fixed UID 1000 after inheriting the
runner-mapped build account. A local image derived from a UID 1001 build base
passes the native protocol, semantic Unicode and Pi screen-sharing tests. The
workflow now retains successfully built artifacts even if later acceptance
fails; retained artifacts do not imply a qualified release. The next source
candidate is .40, preserving .39's source/version identity.

A separate Ubuntu 26.04.1 VGA/KVM guest now passes installed .38 sleep/wake
with an actual five-second QMP S3 interval and host wake, plus kernel ACPI S3
entry/resume evidence. The same app process keeps its accepted turn, completes
and persists it after unlock, revokes the old sharing grant, and captures under
a fresh chooser grant. Native dialogs, minimize/restore, second-instance reuse
and clean Quit pass afterwards. AppArmor stays enabled. The test driver now
waits for the asynchronously loaded Chat option before selecting it; the first
run exposed that driver race before reaching sleep. This qualifies the
disposable software-display guest, not physical GPU or laptop sleep.

A cold-start copy of the Fedora 44 VGA/KVM guest also passes the complete .38
flow with a measured five-second QMP S3 interval, host wake and kernel resume
evidence. SELinux stays enforcing. This adds sustained VM sleep evidence to the
earlier immediate-wake results. Repeated sleep in the earlier VM exposed a
virtual-hardware/kernel limitation: after the app had quit, system power-off
synced and unmounted its filesystems, then kernel 7.2.7 panicked while powering
down. That log and original disk are retained separately; the successful
measured run uses a cold-start overlay. These results do not qualify repeated
hardware sleep or physical GPU drivers.

The clean 0.4.42 source candidate builds DEB, RPM and AppImage artifacts with
source and SBOM evidence. Disposable-key signed APT/DNF .40→.42 lifecycle tests
pass, including upgrade, removal/reinstall, durable profile and encrypted
credential retention, and tamper rejection. Both installed GNOME VMs pass the
native desktop flow and actual IBus/libpinyin composition in GTK and the Worker
composer. A separate KDE fixture now passes the packaged credential stores
against real KWallet, including native unlock/cancel; installed KDE desktop
qualification remains open. See the build guide for that narrower boundary.

Remote .41 CI passes Linux packaging, keyring restarts, the complete private
Ubuntu/Fedora GNOME matrix and AppImage acceptance, then fails DEB installation
because the test invokes `dpkg` without resolving its portal dependency. The
DEB harness now uses APT for local-file installation and passes its complete
install/replacement/removal/reinstall and retained-credential test in a fresh
build container. The same run's Mac
Electron smoke hits its existing five-second frame-recovery deadline; its
diagnostics are retained. The subsequent 0.4.43 source run passes all five CI
jobs, including the complete Linux candidate lane and macOS Electron integration
([run 36010001028](https://github.com/Mat-Tom-Son/work-fold/actions/runs/36010001028)).
Its separate local DEB/RPM/AppImage build also passes with clean source evidence.
The .42 actual local-model seed and cold-relaunch phases both pass. These results
supersede the earlier failures without deleting their diagnostics; later source
changes still require their own qualification.

The .44 follow-up adds KDE's native screen-lock monitor and invalidates grants
when either supported desktop's lock service loses or changes ownership. The
private Fedora 44/KWin 6.7.5 helper fixture passes actual Deny/Stop, capture/input
and exact saved bytes at 100/125/150/200%, stale-state rejection, owner teardown,
fresh approval and lock revocation. KDE's two-monitor regression reproduces a
combined-workspace grant with the previous helper; the fixed path rejects it
before capture. This is single-monitor helper coverage, not installed Plasma
desktop qualification. GNOME regressions, 17 native helper tests, 1,563 application
tests (8 explicit skips), repository/TypeScript checks and desktop preparation
pass. The .44 package and remote CI runs remain separate evidence.

The clean .44 build, signed APT/DNF .42→.44 lifecycle, exact-candidate KDE matrix,
installed Fedora desktop and actual local-model write/cold restart all pass.
Ubuntu's first installed run encounters a GNOME Shell/Mutter SIGSEGV with GBM
buffer errors; the unchanged app passes after a fresh GDM login with the temporary
KDE VGEM device removed. This does not establish a physical-GPU fix.

Remote .44 CI passes the four Mac/TypeScript/application/bridge jobs and Linux
packaging/keyring/native GNOME cases, then exposes a first-use lock-proxy bug in
the packaged desktop flow: initial D-Bus name acquisition is mistaken for
revocation. The same failure reproduces locally. The .45 follow-up performs the
first typed lock-state lookup before watching ownership, then subscribes and
rechecks before granting sharing. A private-bus activation regression fails
before the fix and passes afterwards, alongside the existing locked/missing
service, active-lock and name-loss cases. Its isolated activation subprocess is
exercised by that parent test, not a skipped behavior check. No failed candidate
is relabeled or treated as fully qualified.

The first hands-on development preview exposed a separate launch gap: installed
packages supplied the Worker's CLI, but the unpackaged desktop supplied only its
state-directory binding. The Worker consequently searched for an unavailable
command. The .45 development launch now exposes the already prepared native CLI
through profile-local launchers and starts Electron from the repository so its
package metadata is available. The person confirmed the original file-creation
task succeeds after restart. The shared smoke now exercises actual Pi shell
calls inside the running app, verifies the resulting History restore point and
file bytes, and repeats from a cold start; `npm start` is tested separately from
installed binaries. A local scripted provider makes that integration test
repeatable without consuming a person's provider account. This does not replace
real-provider or physical-desktop qualification.

The original baseline and architecture investigation below are retained as dated
planning evidence. They are not the current feature inventory. The [build guide](linux-build.md)
owns setup, requirements and present limitations. Continue with packaged-app
acceptance, unresolved Chrome image feedback and the remaining A1–A12 cases;
production publication still requires operational ownership and qualified bytes.

### Proposed support matrix

| Environment | Intended qualification |
|---|---|
| Ubuntu 24.04 LTS, GNOME, Wayland, x64 | Build/ABI baseline and full installed acceptance |
| Ubuntu 26.04 LTS, GNOME, Wayland, x64 | Current-LTS installed acceptance, including default security policy |
| Fedora 44 Workstation, GNOME, Wayland, x64 | Initial development desktop and full installed acceptance |
| Then-current Fedora stable at release | Requalify if Fedora advances before publication |
| Ubuntu 24.04 GNOME X11, where available | Existing AT-SPI/X11 regression coverage |
| Fedora KDE Plasma, Wayland, KWallet | Separate qualification milestone before advertising KDE support |

Ubuntu 26.04's default GNOME session is Wayland-only; XWayland application
compatibility does not supply a general native-Wayland capture/input fallback.
[Ubuntu LTS changes](https://documentation.ubuntu.com/release-notes/26.04/summary-for-lts-users/)
support treating Wayland as required, not optional future work.

CPU support does not establish graphics compatibility. Record Intel/AMD GPU
coverage and test NVIDIA before claiming it. Arm64, Flatpak, Snap, immutable
Fedora variants, headless desktops, and remote desktop sessions are expansion
work. Prefer DEB/RPM initially; qualify AppImage separately.

## Evidence available today

The local 0.4.32 candidate was built on 2026-09-23 from base commit
`5e8229bd57c1d1164213cd3bbaf713e161ff2ba7` plus the uncommitted Linux changes on
`codex/linux-desktop`. It is **not a clean release commit**. Its evidence is in
the generated `out/linux/VERIFICATION.md`, `linux-build.json`, `SHA256SUMS`,
and `verification-logs/`; retain those together when archiving this candidate.

| Area | Observed evidence | Remaining limitation |
|---|---|---|
| Build and application tests | Ubuntu 24.04 build; 1,520 application tests passed, 8 skipped; native Rust suites 32 passed, one live-bus test ignored | Local results, not evidence of a completed remote CI run |
| Packaged runtime | Actual-ASAR Pi loaders, concurrent MCP sessions, Documents formats and PDF images, helper hashes, archive integrity and fuses passed | No real provider-backed Worker turn in the installed candidate |
| DEB/RPM lifecycle | Disposable Ubuntu/Fedora containers installed, launched, replaced and removed packages; CLI ownership and data markers checked | Same-version replacement; fresh application profile for each smoke invocation |
| Fedora desktop | Sandboxed packaged app/CLI operations; own GTK editor observed, edited and saved through AT-SPI, with file bytes verified | No physical Wayland input, screenshot, or full desktop acceptance |
| AppImage | Extracted `AppRun` passed application smoke | Direct launch failed here because `libfuse.so.2` is missing |
| Credentials and Chrome | Secure-storage backend checks; Rust native host and protocol tests | Real keyring round-trip and Store-installed companion still unverified |
| Distribution | DEB, RPM, AppImage and checksums produced | No public Linux signing, repository, publication or automatic updates |

A read-only probe of this Fedora GNOME session reported GNOME Shell 50.5,
portal 1.22.1, GNOME portal backend 50.0, PipeWire 1.6.9, and libei 1.6.0.
RemoteDesktop advertises interface v2 and device mask 7; ScreenCast advertises
v5 and source/cursor masks 7. These are advertised capabilities, **not proof
that a user-granted session works**. Research did not start a portal session,
capture the desktop, inject input, or read credentials.

## Findings that determine the design

### Pi supplies most of the runtime; the Linux platform bridge is the gap

The reviewed dependency is `@injaneity/pi-computer-use` 0.5.1, pinned through
the [included-tools manifest](../patches/included-tools/manifest.json).
Its Rust `native/linux/bridge-rs/src/wayland.rs` only reads portal properties.
At the original 0.4.32 baseline there was no portal session, PipeWire frame acquisition, or Wayland input
transport. Upstream's current [Linux documentation](https://github.com/injaneity/pi-computer-use/blob/main/docs/linux.md)
still describes that boundary; a dependency bump alone does not complete it.

The native `main.rs` currently joins AT-SPI roots to X11 windows, takes images
through X11, and requires an X11 window for physical actions. `state.rs` retains
an accessibility root and image dimensions for observations. The TypeScript
Linux backend requires accessibility even when the requested operation could
eventually be visual. These assumptions need a deliberate target/protocol
extension, maintained in the reviewed patch until an upstream version contains
it. Do not make unreproducible edits directly in `node_modules`.

### A shared stream is not an accessible application window

The existing tool model expects an explicit application root. A portal returns
user-selected streams; their metadata does not establish an AT-SPI window
identity. A screen stream may cover multiple applications, and accessibility
may be absent entirely.

Add a first-class **shared capture target** alongside semantic application
roots in the existing native tools. Use a stable, session-local target id;
do not fabricate a PID or join by window title. Observations may attach
accessibility only when a mapping is actually established. A visual-only target
must work without AT-SPI. Start with one selected monitor at 100% scale, then
qualify other geometries. Treat window-stream control as unqualified until its
mapping is proven; it can remain capture-only.

ScreenCast's logical size can differ from frame pixels. Optional `mapping_id`
metadata, introduced in v5, can match an EIS region; the newer PipeWire serial
metadata is v6-only and cannot be required on this host. These are transport
identities, not application identities.
[ScreenCast interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)

### The current scheduler is necessary but insufficient for a desktop seat

The [Linux factory](../resources/included-tools/computer/linux.ts) shares a
helper and resource scheduler across Chats. Upstream scheduler keys are based
on application PID. The Rust helper serializes actions, but window focus has
a separate path. Neither is a complete ownership model for a portal's keyboard
and pointer, which can affect the desktop beyond a captured window.

Add an exclusive control lease around the physical seat, including focus and
compound actions. Bind it to the actual accepted turn/request and Chat identity,
not the selected UI tab. Keep existing Pi scheduling; do not add a model queue
or another planner. Also test production and development app instances together:
an in-process scheduler cannot coordinate two processes. If both can control
the same seat, use bounded same-user coordination with crash recovery.

This prevents work-fold's own tools from colliding. It does not sandbox
arbitrary full-trust Pi Extensions or other desktop applications.

### Upgrade and update evidence needs strengthening

[The installed smoke](../scripts/linux-installed-smoke.mjs) creates and removes
its application/Pi profile on every invocation. The
[DEB](../scripts/linux-deb-install-smoke.sh) and
[RPM](../scripts/linux-rpm-install-smoke.sh) lifecycle tests preserve marker
files. Those are useful installer checks, but cannot prove that actual chats,
History, requests or credentials survive a higher-version upgrade.

The pinned `electron-updater` 6.8.9 RPM implementation passes `--nogpgcheck`
to DNF/Yum; its DEB path uses `dpkg` and has an APT fallback containing
`--allow-unauthenticated`. The
[current updater](../desktop/src/updater.ts) excludes Linux, so those paths
are not active. Keep them inactive while designing distribution; merely adding
Linux to the platform allowlist would not establish the desired verification
chain.

## Proposed Wayland architecture

### Responsibilities and setup

| Layer | Responsibility |
|---|---|
| Trusted desktop setup | Person starts sharing, sees actual scope and owner, and can stop it; compositor owns its chooser |
| work-fold host service | Session lifecycle/status, turn identity, control lease, revocation and app shutdown |
| Existing Pi computer tools | Explicit targets, observations, actions, structured results and normal tool feedback |
| Bundled Rust helper | Portal D-Bus requests, session and file descriptors, PipeWire buffers, EIS/input transport, geometry and native cancellation |

Use the supported host event-bus pattern in
[included tools](../src/local/agent/included-tools.ts) and
[Chrome connection](../src/local/agent/included-chrome-connection.ts), rather
than inventing a privileged renderer bridge for full-trust tools. A proposed
`src/shared/computer-session.ts` should carry typed, content-free status and
session generations. Restricted Folder apps receive no computer-control bridge.

Recommended initial ownership policy: sharing is app-owned, while physical
control belongs to one accepted turn at a time. Starting setup names its intended
Chat or the work-fold agent; other Chats cannot silently inherit it. Specify
transfer and release semantics before implementing input. No persistent restore
tokens in the first release; restart, lock, sleep or revocation requires fresh
setup. Changing this policy later requires its own privacy and recovery review.

Catalog inspection and model tool calls must not open a desktop chooser. If
setup is absent, return an ordinary actionable unavailable result; do not hold
a tool callback or put a durable request into a fictitious approval wait.
Setup and a later accepted turn remain separate, as with existing connection
setup. Extend the existing setup surface with live status rather than trusting
its current five-minute readiness cache for active permission state.

### Session lifecycle

Implement an explicit state machine:

`idle → requesting → active → closing → idle`

Denial, missing services, disconnection and timeout produce distinct results.
Track capture, pointer and keyboard availability separately; an active
capture-only session must not advertise input. Publish active status only after
checking granted devices/streams and receiving usable transport state.

Through the selected portal library, create one RemoteDesktop session, select
devices and ScreenCast sources on it, then start it. Verify that the library
subscribes before issuing asynchronous requests, and close pending requests on
cancellation. Open PipeWire only through the
portal-provided remote descriptor. When supported, connect EIS after Start.
Once that succeeds, the session must use EIS for input: the portal rejects
mixing it with the legacy Notify methods. An EIS disconnect ends the session.
[RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html),
[Request](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html),
[Session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Session.html)

Spike Electron parent-window attribution early. A Wayland portal parent needs
an exported `xdg_foreign` handle, not an assumed X11 id or Electron native pointer.
The portal permits an empty parent when no suitable handle exists; test that
fallback's usability and attribution before promising a parented chooser.
[Window identifiers](https://flatpak.github.io/xdg-desktop-portal/docs/window-identifiers.html)

### Frames, geometry and observations

Use bounded on-demand snapshots with a small latest-frame buffer, not an
unbounded recording. Set explicit frame size, memory and timeout limits; close
descriptors and stop processing when sharing ends. Keep screenshots only through
the existing deliberate tool-result/history path, with no extra recording store
or diagnostic screenshot upload.

Try CPU-readable shared-memory frames first using the selected capture framework.
DMA-BUF formats and modifiers are not generally a linear CPU image; if supported
desktops cannot negotiate a usable format, evaluate the framework's supported
GPU import/conversion path before considering custom native code. Reject
unsupported formats explicitly instead of returning a black image.
[PipeWire capture tutorial](https://docs.pipewire.org/page_tutorial5.html),
[DMA-BUF handling](https://docs.pipewire.org/devel/page_dma_buf.html)

Every actionable observation must pin the helper/session generation, stream
identity, frame geometry version, crop/transform, pixel dimensions and logical
coordinate mapping. Invalidate it on stream replacement, geometry changes,
disconnect or helper restart. Reject stale coordinates before dispatch. Test
fractional scaling, rotated monitors, negative origins, cropping, hotplug,
window resizing and mixed-DPI displays. Never treat frame pixels as desktop
coordinates without the measured transform.

### Input, stopping and recovery

Prefer libei/EIS where the compositor provides it. Negotiate actual device
capabilities, resume state and region mapping; use complete event frames. A
separately tested D-Bus Notify implementation is a possible compatibility path
only before EIS is established, never a retry after ambiguous input delivery.
If a mapping or requested device is missing, expose capture-only behavior.

Handle keyboard layout and modifiers explicitly. Prefer AT-SPI text operations
where supported; characterize physical typing for non-US layouts, Unicode,
compose/dead keys and IMEs. Do not silently use the clipboard as an undeclared
typing substitute. The libei sender is responsible for releasing pressed keys
and buttons before ending emulation.
[libei sender API](https://libinput.pages.freedesktop.org/libei/api/group__libei-sender.html),
[regions](https://libinput.pages.freedesktop.org/libei/api/structei__region.html)

On Stop or revocation, fence new actions immediately, attempt bounded key/button
release, close the portal and drain native work. Retain the current helper kill
and await fallback if cooperative shutdown cannot finish. Invalidate observations
and leases for all affected Chats before allowing another operation. Report
uncertain effects when input may have occurred; never replay it automatically.
Cancellation cannot undo an already delivered edit or click.

Integrate lock, suspend, compositor restart, helper death and explicit Quit.
Ordinary minimize/tab switches preserve accepted Worker work; revoking computer
sharing removes that capability without losing the request's transcript/result.
Wake must not resume input or reopen sharing on its own. A captured window does
not constrain global keyboard focus; describe that scope plainly in setup.

## Implementation work packages

Estimates are **focused engineering days for one contributor**, including tests
and documentation, assuming access to the listed desktops. They are planning
ranges, not delivery commitments. Re-estimate after L0 and the first real portal
capture. Store review, signing/hosting setup and access to test machines can add
calendar time outside these estimates.

| ID | Deliverable | Dependencies | Estimate |
|---|---|---|---|
| L0 | Baseline checkpoint, capability/target design and disposable portal feasibility spike | Existing candidate | 2–3 days |
| L1 | Real credentials, Worker turns and reusable persistent-profile fixture | L0 baseline | 3–5 days |
| L2 | Desktop lifecycle and integration acceptance/fixes | L1 fixture; can progress alongside portal work | 3–5 days |
| L3 | Production portal lifecycle, capture-target protocol and ownership model | L0 decisions | 3–5 days |
| L4 | PipeWire images, geometry and visual-only observations | L3 | 5–8 days |
| L5 | Physical input, seat scheduling and cancellation/recovery | L4 mapping; L3 ownership | 5–8 days |
| L6 | Live setup/status, owner display and lifecycle integration | L3; completes against L5 | 3–5 days |
| L7 | Real Chrome companion acceptance and profile-path behavior | L1; Store access | 2–4 days |
| L8 | Higher-version upgrades and signed distribution tooling | L1; hosting/key decisions | 4–7 days |
| L9 | Full matrix qualification, release evidence and runbook | L2, L5–L8 | 4–6 days |

Total initial envelope: **34–56 engineering days, roughly 7–12 working weeks**
for one contributor. Daily-use candidate work is about 8–13 days through L0–L2,
with Chrome added when its Store path is available. Additional KDE/GPU coverage,
a required DMA-BUF conversion path, or an in-app updater would expand this scope.

### L0 — Resolve the expensive unknowns first

- Inventory the existing changes and preserve the candidate evidence; establish
  a reproducible source checkpoint before feature work. Do not relabel the dirty
  0.4.32 artifacts as a clean release.
- Record distro, desktop, actual Electron display backend, portal interfaces,
  accessibility, keyring and helper versions in content-free diagnostics.
  A Wayland login does not by itself prove Electron is running natively on it.
- Design semantic roots versus shared capture targets, ownership transfer,
  observation invalidation and error/result shapes. Review against
  [native feedback](tool-feedback.md) before changing the Pi-facing protocol.
- In a disposable desktop session, prove chooser → granted stream → one frame
  → close on Fedora and Ubuntu 24.04. Check EIS connection/regions without
  initially injecting input. Resolve frame format, coordinate metadata and
  parent-handle limitations. Prototype changes are not the production adapter.
- Validate the library choices above and select exact dependency versions after
  the spike. Measure GStreamer plugin/ABI requirements and packaging size; retain
  Tokio and review the ASHPD/zbus boundary, licenses and build provenance.

Ubuntu's baseline libraries are older than this Fedora host: Noble supplies
libei 1.2.1 and PipeWire 1.0.x. Build and test the selected APIs against that
baseline rather than accidentally requiring Fedora's versions.
[Ubuntu libei](https://packages.ubuntu.com/en/noble/libei1),
[Ubuntu PipeWire](https://packages.ubuntu.com/en/noble-updates/libpipewire-0.3-0t64)

**Exit:** recorded design decisions and a minimal frame/teardown demonstration
on both desktops, or a concrete revised compatibility scope with evidence.

### L1 — Make installed application state real in the tests

Extend the existing smoke harness to optionally retain one explicitly isolated
application/Pi root. Seed a Folder identity, Chat, History entry, Library item,
settings, requests and representative installed-app data through supported
product paths. Use deterministic provider fixtures for repeatable automated
tests; separately perform one bounded real provider turn in an isolated account
or test profile, verifying the resulting file bytes and persisted conversation.

Exercise the [secure-storage predicate](../desktop/src/secure-storage.ts) and
its [settings](../desktop/src/settings.ts) and
[connection](../desktop/src/restricted-app-connections.ts) consumers with an
unlocked, locked, missing and changed keyring. Verify encrypted persistence,
restart, clear failure, and no silent overwrite of unreadable credentials.
Keep ordinary Folder/file operations available without a provider connection.
Do not log secrets or replace Pi's existing external auth semantics.

Electron warns that Linux secret-store operations may block and that `basic_text`
uses a hardcoded password. Measure actual responsiveness and round-trip behavior;
the backend allowlist alone is not acceptance.
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

**Exit:** a real installed Worker task survives restart with its saved connection,
and the retained fixture can be reused by upgrade tests. KDE credential claims
require the same evidence with KWallet.

### L2 — Qualify desktop behavior on normal installations

Test from the desktop launcher as well as a terminal. Cover dialogs, open/reveal,
default browser, notifications, drag/drop, clipboard, shortcuts, IME entry,
fractional scaling, multiple displays, and accessibility enablement. Verify
main-window close/reopen, the work-fold agent's management window, explicit Quit,
and a real running turn across tab switches, minimize, lock and sleep/wake.
GNOME without a tray extension must retain a discoverable route back to work-fold.

Audit [login-shell environment merging](../desktop/src/shell-environment.ts):
it currently protects product/runtime prefixes but not explicit graphical
session variables. Test stale shell values for `DBUS_SESSION_BUS_ADDRESS`,
`WAYLAND_DISPLAY`, `DISPLAY` and `XDG_RUNTIME_DIR`; preserve the live desktop
session where necessary. This is an identified risk, not a reproduced failure.

Run installed tests with the distro's normal AppArmor/SELinux policy. The build
container's relaxed namespace/security settings do not establish that behavior.
Ubuntu restricts unprivileged user namespaces through AppArmor, making a clean
desktop install an essential test.
[Ubuntu security overview](https://documentation.ubuntu.com/security/security-features/security-features-overview/)

**Exit:** completed GNOME desktop matrix, no lost accepted turns, and documented
recovery for unsupported environment features without disabling Chromium's
sandbox or global OS protections.

### L3–L6 — Build the production computer bridge in testable increments

1. Add typed diagnostics, session generations and capture-target protocol;
   implement lifecycle and teardown before adding actions.
2. Add first-frame acquisition and visual-only `observe_ui` through the existing
   Pi tool path. Verify a disposable application with no useful AT-SPI tree.
3. Implement geometry mapping and stale-observation rejection before dispatching
   a click. Fail explicitly for unsupported frame formats or ambiguous mapping.
4. Add pointer, scrolling, keyboard and compound actions with seat ownership,
   proper event framing, focus handling and release of held input.
5. Connect trusted setup and live content-free status, owner identity and Stop.
   Integrate power/session events and helper failure cleanup.
6. Expand from one monitor to the geometry and failure matrix below. Keep X11
   regression coverage and update the reviewed patch/hash/license chain.

The first complete acceptance task edits and saves a disposable editor file,
then reads its bytes independently. Follow it with a visual-only target so
AT-SPI success cannot mask a broken capture/input implementation.

**Exit:** the same Pi tools complete those tasks on supported GNOME Wayland
desktops, and all interruption tests establish that no further input occurs
after Stop settles. Never infer completion from the tool returning success alone.

### L7 — Finish Chrome as an actual installed integration

The [Chrome distribution guide](chrome-extension-distribution.md) now records a
verified public version 1.0.0, updated September 15, 2026. Its listing still
describes Mac support. Test that Store-installed extension against the Linux app
in a disposable OS user/profile; prepare any required companion and listing
updates from the exact tested bytes. Store availability does not replace this
Linux acceptance.

[Native host registration](../desktop/src/chrome-native-host.ts) currently
targets the default XDG Google Chrome root. Official Chrome also supports
`CHROME_CONFIG_HOME`, `CHROME_USER_DATA_DIR` and explicit `--user-data-dir`.
Decide on explicit supported profile selection or a clear unsupported-path
message; do not search personal profiles and register indiscriminately.
Chrome for Testing has a separate native-host path in newer versions.
[Chrome user-data directories](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

Verify executable discovery on both distributions, first connection, browser/app
restart, extension service-worker suspension, two simultaneous Chats, Stop,
tab ownership, image feedback, wrong-origin rejection, and upgrades of both
companions. Preserve exact Store-origin pinning. Exercise moved/deleted AppImage
paths and ownership-aware registration repair if AppImage remains supported.
Do not weaken production registration to make an isolated test pass.

**Exit:** an installed companion completes a bounded browser task, reconnects
and stops correctly, with supported profiles and version compatibility recorded.

### L8 — Make upgrades and distribution verifiable

Upgrade from one real candidate to a **higher unique version**, reusing L1's
profile. Check Folder ids, chat content, History, Library, request reconciliation,
settings, connections, installed-app data, CLI/native-host registration and
credential decryption. Then remove/reinstall without erasing user state. Do not
compare the entire profile byte-for-byte: caches and reconciliation timestamps
can legitimately change. Verify meaningful invariants and exact user content.

Recommended first public update channel: signed **APT and DNF repositories**,
with clear package-manager update instructions in the app. APT authenticates
repository metadata and its package hashes; this is not equivalent to merely
placing a detached signature next to a DEB. DNF has distinct repository,
package and local-package signature settings, so qualify the exact install and
upgrade commands, including downloaded offline RPMs.
[APT authentication](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html),
[DNF5 configuration](https://dnf5.readthedocs.io/en/latest/dnf5.conf.5.html)

Define key custody, documented fingerprints, rotation/revocation, HTTPS hosting,
metadata freshness policy and atomic publication. Add tampered-package,
tampered-metadata, unknown-key and stale-metadata tests; qualify expiry where
the selected repository format supports it. Document replay/rollback limits
rather than treating a cache-refresh timeout as cryptographic freshness.
Preserve a recovery path that installs a higher fixed version; do not promise
that an older binary can read newer application state without a downgrade test.

Use [aptly's signed publication](https://www.aptly.info/doc/aptly/publish/)
and the RPM project's [createrepo_c](https://github.com/rpm-software-management/createrepo_c)
and [rpmsign](https://rpm-software-management.github.io/rpm/man/rpmsign.1)
tools to produce the repositories and signatures. Work-fold's scripts should
orchestrate these tools and verify outputs. Use current per-repository APT key
configuration; do not copy historical global `apt-key` instructions from older
tool examples.

Require clean source, unique immutable versions/tags, exact lockfiles and patch
hashes, pinned build-image digest/toolchains, native ABI evidence, license notices,
an SBOM and artifact hashes. The current Dockerfile is a baseline recipe, not
proof of bit-for-bit reproducibility. Build the final packages once, verify those
bytes, then publish those same bytes with their evidence.

Linux hosting/repository and signing ownership are still decisions. Do not use
the Mac release repository or frozen legacy repositories for Linux artifacts.
Keep Windows inactive. Treat an AppImage self-updater as separate work requiring
its own authenticity and two-version tests; keep the present Linux updater
disabled in this plan.

**Exit:** an isolated machine installs from the proposed signed channel,
upgrades successfully, rejects altered content, and preserves real application
state. Publication itself remains a separately reviewable final action.

### L9 — Turn the evidence into a release lane

Extend the existing [CI workflow](../.github/workflows/ci.yml) with deterministic
native protocol, geometry, cancellation, persistent-profile and package lifecycle
tests. Keep interactive desktop qualification separate: disposable VMs or trusted
desktop runners with real sessions, never untrusted PR code running with signing
keys or personal accounts. Record distro, compositor, graphics, keyring, portal,
package and helper versions with each result.

Qualify AppImage's direct launch, FUSE prerequisites, sandbox policy and desktop
integration separately from extraction. If that lane is unreliable on clean
supported desktops, ship DEB/RPM first and label AppImage experimental until
resolved. Do not advertise extracted-AppRun evidence as direct-launch success.

Write a Linux release runbook, installation/update/recovery guide, support matrix
and content-free diagnostic export. Reconcile README, privacy/security,
extension setup and contributor guidance only with capabilities actually tested.
Retain failures and explicit skips alongside successes. Re-run macOS checks when
shared runtime or protocol changes can affect it; do not impose Linux publication
requirements on the existing Mac lane accidentally.

**Exit:** traceable evidence for the exact proposed release artifacts, with every
advertised desktop capability backed by the matrix below.

## Required acceptance cases

| Case | Exercise | Evidence required |
|---|---|---|
| A1: normal install | Fresh DEB/RPM from launcher under default OS security | Sandboxed renderer, correct icons/CLI, usable dialogs, no development checkout or system Node dependency for the bundled app |
| A2: real work | Connect test provider, edit a disposable file, restart | Exact file bytes, persisted Chat/result, credential round-trip; logs contain no secrets |
| A3: keyring failures | Locked/missing/changed backend and unreadable credential | Actionable failure, no plaintext fallback or destructive replacement; files still usable |
| A4: portal setup | Accept, deny, dismiss, timeout, stop during chooser | Exactly one session lifecycle, no orphan chooser/descriptor, truthful granted-device status |
| A5: observation | Semantic editor and inaccessible visual target | Usable fresh images; explicit target identity; visual path works without AT-SPI |
| A6: coordinates | 100/125/150/200% scale, mixed DPI, rotation, negative origins, hotplug/resize | Click lands on marked disposable targets; changed geometry invalidates old observations |
| A7: input | Pointer, scroll, shortcuts, layout/Unicode/IME cases | Independent application outcome; held input released; unsupported cases clearly reported |
| A8: interruption | Stop before dispatch, mid-action, after input before frame, helper/EIS/PipeWire loss | No events after settled Stop; no automatic replay; uncertain effects reported accurately |
| A9: concurrency | Two Chats, focus changes, work-fold agent and two app instances | One physical owner, correct attribution, no interleaved compound input or stale references |
| A10: continuity | Tab switch, minimize/reopen, lock, sleep/wake, compositor restart, Quit | Accepted work remains recorded; sharing closes when required and never silently resumes |
| A11: Chrome | Store install, reconnect, suspended worker, wrong origin/profile, two versions | Bounded browser task and stop succeed; origin and ownership restrictions remain enforced |
| A12: lifecycle | Higher-version upgrade, uninstall/reinstall, tampered feed/package | Meaningful profile invariants and credentials preserved; invalid distribution rejected |

Start A4–A8 in a disposable desktop with only test applications. For keyboard
tests, record the target file/application outcome rather than unrelated desktop
content. Screenshots and tokens must not enter generic CI logs. A skipped desktop
case is unqualified behavior, not a passing result.

## Code map for implementation

| Concern | Existing starting points |
|---|---|
| Pi computer runtime and patch | [Linux factory](../resources/included-tools/computer/linux.ts), [dispatch](../resources/included-tools/computer/index.ts), [reviewed patch](../patches/included-tools/pi-computer-use-0.5.1.patch), [manifest](../patches/included-tools/manifest.json) |
| Host lifecycle and setup | [Host event bus](../resources/included-tools/host.ts), [runtime configuration](../src/local/agent/included-tools.ts), [setup service](../src/local/agent/included-tool-setup.ts), [setup UI](../web-local/src/components/panes/IncludedToolSetup.tsx), [Chrome lease pattern](../src/local/agent/included-chrome-connection.ts) |
| Desktop and credentials | [Main process](../desktop/src/main.ts), [management window](../desktop/src/management-popover.ts), [secure storage](../desktop/src/secure-storage.ts), [shell environment](../desktop/src/shell-environment.ts) |
| Chrome and installed CLI | [Native Rust hosts](../desktop/native/linux/src/lib.rs), [Chrome registration](../desktop/src/chrome-native-host.ts), [distribution contract](../src/shared/chrome-distribution.json) |
| Native build and provenance | [Computer helper build](../scripts/build-computer-helper.mjs), [native hosts build](../scripts/build-linux-native-hosts.mjs), [license extraction](../scripts/cargo-license-notices.mjs), [asset verification](../scripts/verify-packaged-app-assets.mjs) |
| Packaging and upgrade | [Linux builder](../scripts/build-linux-desktop.mjs), [builder config](../electron-builder.desktop.cjs), [build baseline](../desktop/linux/Dockerfile), [installed smoke](../scripts/linux-installed-smoke.mjs), [DEB lifecycle](../scripts/linux-deb-install-smoke.sh), [RPM lifecycle](../scripts/linux-rpm-install-smoke.sh) |
| Regression coverage | [Linux helper tests](../tests/linux-computer-helper.test.ts), [desktop tests](../tests/linux-desktop.test.ts), [native tool tests](../tests/included-computer-native.test.ts), [readiness tests](../tests/included-tool-readiness.test.ts), [accessibility smoke](../scripts/linux-accessibility-smoke.cjs) |

New files should follow these owners; the names above are not a mandate to put
the entire portal implementation in one module. Keep native session, frame and
input code separately testable. Run repository/TypeScript checks for code changes,
the behavior suite for runtime changes, and `desktop:prepare` for desktop/resource
changes. Rebuild installers at integration and release checkpoints, not for every
inner-loop edit.

## Decisions and risks to resolve during execution

| Decision or risk | Recommended starting position | What resolves it |
|---|---|---|
| Portal geometry or EIS regions absent on older desktops | Capture-only until mapping is proven; GNOME monitor first | L0/L4 evidence on Ubuntu baseline and Fedora |
| GPU buffers unavailable to CPU capture | Framework-managed negotiation/conversion, explicit unsupported result | GStreamer/PipeWire spike; evaluate framework GPU support before custom code |
| Who may control a shared desktop | Visible intended Chat/agent plus one accepted-turn control lease | Written ownership/transfer design before L5 |
| Keyboard scope/layout | Whole-seat scope disclosed; semantic text preferred | Layout/focus tests and honest supported-action list |
| KDE and additional graphics | Separate qualification before support claims | Test machines and completed A1–A12 coverage |
| Chrome Store Linux support | Published 1.0.0 companion verified; listing still describes macOS | Actual Linux installed connection and publisher-reviewed listing update |
| Public hosting and keys | Dedicated Linux distribution ownership; signed APT/DNF first | Hosting/key-custody decision before L8 publication tooling |
| AppImage reliability | Secondary to DEB/RPM; no automatic-update commitment | Clean-desktop direct-launch and sandbox evidence |
| Real provider/credential tests | Disposable user/profile with bounded test account | Available test credentials and measured round-trip; fixtures alone do not qualify this |

Continue from the dated implementation checkpoint above. The remaining work is
packaged-app/UI acceptance, unresolved Chrome feedback, the unqualified native
desktop matrix, and source-bound production distribution. Preserve the test
failures and limits; a private GNOME test or test-key signature does not qualify
an untested physical desktop or public channel.

The .40 local candidate completes DEB/RPM/AppImage and source/SBOM verification,
then passes signed APT/DNF .38→.40 upgrade/remove/reinstall, profile and encrypted
credential preservation, and tamper rejection. Both installed GNOME guests pass
Pinyin preedit, exact saved Chinese bytes, and the Worker composer's composition
confirmation without sending. The first Ubuntu attempt reports a bounded frame
timeout; the fresh grant on the next attempt passes, so that diagnostic is retained.
Remote .40 CI passes every Mac job but exposes inode reuse during a Folder-removal
recovery test on Linux, before packaging. New intents now pin the directory's
creation timestamp as well as device/inode, and older records recheck portable
Folder identity before reclaiming a path. Deterministic regressions model inode
reuse with both current and older records, including a replacement with copied
portable metadata. The next source candidate is .41; .40 artifacts stay immutable.
The focused removal suites pass 38 tests after the fix, and the full local suite
passes 1,563 tests with eight explicit environment skips. Repository and TypeScript
checks pass. The unrelated working-tree DMG image remains untouched.
