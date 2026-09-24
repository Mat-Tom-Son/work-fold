# Linux builds

The Linux x64 lane produces **local candidates** for Ubuntu 24.04 or newer and
Fedora on Intel/AMD PCs. It packages the existing Electron app and Pi runtime,
not a separate Linux agent. The public release and automatic-update lane remains
macOS. Linux candidates have no update feed and are not published by these commands.

## Build

Use Node 24, npm 11.16.0 or newer, Rust/Cargo, and a Linux x64 desktop. `npm ci`
verifies the reviewed dependency patches. The native helpers are built with
`cargo --locked`; nothing downloads or compiles a helper at application runtime.
Build distribution artifacts in the Ubuntu 24.04 environment below so a newer
Fedora glibc cannot accidentally become an Ubuntu runtime requirement.

```sh
npm ci
npm run check
npm run desktop:computer-helper
npm run desktop:linux-native-hosts
npm run desktop:linux-native-tests
npm test
npm run desktop:package:linux  # verified unpacked app
npm run desktop:make:linux     # DEB, RPM, AppImage, hashes and build record
```

Both package commands include `desktop:prepare`: native builds, renderer,
TypeScript, sandboxed preloads, restricted-app smoke and preflight. The package
hook then exercises the actual ASAR's Pi loaders, concurrent MCP sessions and
document workers, including native canvas and PDF page images. It checks the
archive hashes, security fuses, bundled helper hashes and source provenance.
`--skip-prepare` is only for an already prepared tree with `--dir` during packaging diagnostics;
it is not a substitute for the complete acceptance lane.

The reproducible build environment is [desktop/linux/Dockerfile](../desktop/linux/Dockerfile).
For Docker:

```sh
docker build -t work-fold-linux-build desktop/linux
docker run --rm --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -v "$PWD:/work" -e HOME=/tmp/work-fold-build work-fold-linux-build \
  bash -lc 'mkdir -p "$HOME"; npm ci && npm run check && npm run desktop:computer-helper && npm run desktop:linux-native-hosts && npm run desktop:linux-native-tests && npm test && dbus-run-session -- xvfb-run -a npm run desktop:make:linux'
```

For rootless Podman, replace `docker` with `podman`, replace `--user ...` with
`--userns keep-id:uid=1000,gid=1000 --user 1000:1000`, and use `--security-opt label=disable` instead of the AppArmor
option. These options let Chromium create namespaces inside the disposable
build container. Chromium's own renderer sandbox remains enabled. Never ship
or recommend `--no-sandbox` as a workaround. The container has no desktop session,
provider credentials or personal keyring.

Output lives under `out/linux/`. `linux-unpacked/work-fold-desktop` launches the
GUI; `linux-unpacked/bin/work-fold` is the management CLI. `linux-build.json`
and `SHA256SUMS` describe the three installers for this version. Full builds also
retain `work-fold-<version>-linux-source.tar.gz` and its JSON manifest. Git defines
the source inputs, including reviewed uncommitted files; ignored output and
dependency directories are excluded, and symlinks are not followed. GNU tar
creates the archive. The build checks that source bytes stayed unchanged and
records both evidence digests. The versioned build record is retained alongside
the latest `linux-build.json` alias. Existing artifact/source bytes require a higher
version rather than being overwritten.

Four CycloneDX files accompany each full build. The pinned upstream generators
are installed in the build image: cyclonedx-npm 6.0.1 inventories the npm graph
including build tools, and cargo-cyclonedx 0.5.9 inventories each Linux Rust
runtime graph. They are dependency inventories, not a claim that all npm tools
ship in the app. System-provided shared libraries remain external; helper
provenance and DEB/RPM dependencies record those requirements. The two reviewed
npm projections (Pi’s undici override and the MCP core source declaration) are
recorded explicitly; new dependency errors stop generation. Cargo generation
uses a private copy and refuses lockfile changes. Repeated generation has been
checked for identical bytes.

The AppImage requires the same native runtime libraries and plugins as the packages; DEB/RPM provide desktop integration and are preferable for an installed
Ubuntu/Fedora system. The pinned electron-builder AppImage toolset 1.0.3 uses the
statically linked [type2 runtime](https://github.com/AppImage/type2-runtime), so
it does not require a separately installed `libfuse.so.2`. It still needs access
to the kernel's FUSE support and a compatible user-namespace policy. The package's
Ubuntu AppArmor integration applies to the installed `/opt/work-fold` path, not
arbitrary AppImage mount paths.
If FUSE is unavailable, use the matching DEB/RPM, or extract the AppImage in a
disposable directory with `./work-fold-<version>-linux-x86_64.AppImage --appimage-extract`
and launch `squashfs-root/AppRun`. Extraction does not install desktop integration.
Linux startup rejects `--no-sandbox` before initializing application state,
including the upstream AppImage launcher's automatic fallback when its namespace
probe fails. Use the DEB/RPM with the distribution's supported sandbox policy in
that case. The earlier 0.4.32/0.4.33 AppImages lack this guard and must not be used
for further acceptance or distribution.

## Install and upgrade

Install the matching local candidate using the distribution's package manager:

```sh
sudo apt install ./out/linux/work-fold-<version>-linux-amd64.deb
# or on Fedora:
sudo dnf install ./out/linux/work-fold-<version>-linux-x86_64.rpm
```

The app installs into `/opt/work-fold`, adds a `work-fold.desktop` launcher, and
provides `work-fold-desktop` for the GUI and `work-fold` for the CLI. Installer
hooks extend electron-builder's sandbox, AppArmor and desktop database setup.
Linux uses the 512px brand icon in hicolor’s indexed size directory; the guarded
GTK launcher probe checks actual desktop lookup rather than just file presence.
See the [icon theme specification](https://specifications.freedesktop.org/icon-theme/latest/).
The CLI hook preserves an unrelated `/usr/bin/work-fold`. Uninstall removes
package-owned links and application files, never Folders or application data.
Quit work-fold before upgrading, install the newer package with the same package
manager, then relaunch. Signed repository **candidate staging** is available
below. Public Linux hosting, production signing-key custody, and unattended
updates are not configured.

**Open with** starts in `/usr/share/applications` and accepts Linux `.desktop`
entries. GIO handles their launch rules and file arguments; work-fold does not
parse or run their `Exec` text itself. **All files** also permits an explicitly
chosen executable. DEB/RPM declare the GIO command's distro dependency. See
[GIO application launching](https://docs.gtk.org/gio/method.AppInfo.launch.html).

Normal application data is `$XDG_CONFIG_HOME/work-fold`, or
`~/.config/work-fold`; Pi resources keep their existing native ownership. For
disposable testing use both `WORKFOLD_DESKTOP_STATE_DIR` and `WORKFOLD_AGENT_DIR`
as described in [Development](development.md). Set `WORKFOLD_CLI_STATE_DIR` to the
same state directory when using the candidate CLI from a separate shell.

Credentials saved by work-fold require an unlocked GNOME Keyring/libsecret or
KWallet backend. The Linux `basic_text` fallback is rejected. Unlock the desktop
keyring and restart if secure storage is unavailable. Folder registration and
ordinary file use still work without a model connection. Pi's external resource
and environment-based configuration retain their existing semantics.
An existing encrypted profile cannot currently start after its keyring prompts
are cancelled; it shows an unlock-and-restart error and preserves the encrypted
file. Its ordinary folders remain accessible outside the app.

Closing the main window with **Keep work-fold running** enabled minimizes it,
so it remains accessible when GNOME does not display tray icons. Where a tray
exists, it also provides the management window. On Wayland that window lets the
compositor choose its position. Explicit Quit retains the existing turn-draining
behavior.

## Included tools

- **Pi, Web, Documents and MCP:** the existing native tools and resource loader.
  Stdio MCP servers still need whatever executable their own configuration uses.
- **Computer:** the pinned Rust Linux helper provides AT-SPI window/control
  observations and semantic actions where applications expose them. The X11
  backend also provides screenshots and physical input. On GNOME Wayland, use
  **Skills & Extensions → Computer control → Share a screen**, choose the intended Chat,
  then select a monitor and allow remote interaction in the desktop chooser.
  The bundled portal helper adds visual observations, pointer movement, clicks,
  scrolling, drag paths, typing and shortcuts to the same Pi computer tools.
  Stop sharing remains available during setup and active work. See the limits below.
  Chromium may expose text fields without EditableText support; an accessible
  tree does not establish that every control supports semantic editing.
- **Chrome:** a native Rust bootstrap with the pinned Store origin and private
  loopback protocol. Connect Chrome writes only the user-level native-messaging
  manifest. Google Chrome and the Store companion are separate installations.
  Actual published version 1.0.0 has passed Linux connection, navigation,
  evaluation, two-Chat ownership, disconnect and browser/native-host restart
  tests in disposable profiles. Ordinary Store installation through Add to Chrome
  and the native confirmation, plus explicit foreground image feedback, also pass.
  Its background screenshot command still times out. The
  listing still describes Mac support. Chromium, Flatpak and Snap browser
  registration paths are not claimed by this lane.

The computer factory stays cold during catalog inspection. One scheduler
coordinates physical actions across Chats. An aborted dispatched Linux helper
command kills and awaits the helper before releasing that scheduler, returning
an uncertain-effect error without replay. This invalidates shared observations;
other Chats may need to observe again. It does not undo already delivered
accessibility or input effects. Native tools retain full-trust Pi authority;
restricted Folder apps get no computer-control bridge.

## Acceptance and remaining work

The [Linux completion plan](linux-roadmap.md) scopes the remaining implementation,
desktop test matrix, upgrade verification and distribution work. It separates
the current candidate evidence from proposed capabilities and release criteria.

The automated Linux CI job runs the complete build and packages local artifacts
on Ubuntu 24.04, then installs/reinstalls/removes the DEB and RPM in separate
disposable Ubuntu and Fedora 44 containers. It checks the installed launchers,
application launch and preserved user data, plus ownership of an unrelated CLI
on Ubuntu. The RPM removal hook preserves launchers when replacing an installed
package, following RPM's [scriptlet arguments](https://rpm.org/docs/4.20.x/manual/triggers.html).
Live desktop acceptance is separate from Xvfb/container tests.

The installed-app harness exercises the packaged Pi runtime using a bounded local
synthetic provider through Pi's standard `models.json`. Pi calls its native
`write` tool, and the test checks exact output bytes. This does not call a paid
provider or qualify provider login. A retained profile also checks Folder/Chat
identities, messages and results, History, Library bytes, model selection and the
durable request, then runs another turn after relaunch. `verify` refuses missing,
incomplete or unrecognized fixtures instead of silently creating fresh data.
The harness observes only its own process descendants and requires actual
renderers with Chromium sandboxing, `NoNewPrivs: 1` and seccomp filtering.

```sh
# Choose an empty disposable directory; explicit profiles are retained.
node scripts/linux-installed-smoke.mjs out/linux/linux-unpacked/work-fold-desktop \
  --profile-root /tmp/work-fold-upgrade-fixture --phase seed --expect-version 0.4.34
node scripts/linux-installed-smoke.mjs out/linux/linux-unpacked/work-fold-desktop \
  --profile-root /tmp/work-fold-upgrade-fixture --phase verify --expect-version 0.4.34
```

Inside the guarded disposable install containers, pass an older and a newer
package to `scripts/linux-deb-install-smoke.sh` or
`scripts/linux-rpm-install-smoke.sh` to test a real version upgrade. They seed with
the old app, verify with the new app, remove it, reinstall it and verify again.
Passing one package tests same-version replacement and reinstall only; this is
what ordinary CI can do without a retained previous candidate. Both cases leave
the synthetic profile inside the container until the container is removed.

`scripts/linux-credentials-smoke.sh` runs as a non-root user in the disposable
Ubuntu build container with `WORKFOLD_CONTAINER_INSTALL_TEST=1`. It creates a
private keyring directory and a fresh user bus/keyring daemon for every phase.
Real Electron safeStorage tests both provider and Folder-app connection stores:
encrypted persistence, corrupt-file preservation, rejection of `basic_text`, a
missing Secret Service, and a locked collection whose unlock prompt is unavailable.
A final unlocked run decrypts the original credentials again. The lifecycle
harnesses also seed the old installed ASAR's stores and read them through the new
ASAR after upgrade and reinstall. This uses the pinned development Electron test
host with a constant test identity and synthetic secrets; it does not qualify
credential entry through the installed Settings UI, interactive unlock/cancel
dialogs, KWallet, or a real provider connection.

Separately, an installed 0.4.36 RPM in a fresh Fedora 44 QEMU guest passes
synthetic key entry through Settings, encrypted-byte verification, persistence
after a cold app relaunch, and removal. That uses a real GDM password login and
its unlocked GNOME Keyring with SELinux enforcing. Explicitly locking that
synthetic keyring also verifies the native unlock dialog and successful startup
after unlocking. Cancelling every repeated native prompt produces the app's
unlock-and-restart error with the encrypted file unchanged. KWallet remains
unqualified. The guest is an official
Cloud image plus distro GNOME packages, with no personal host resources shared.
The installed 0.4.36 DEB also passes Settings entry, encrypted storage, cold
relaunch and removal in the Ubuntu 26.04.1 GDM guest with AppArmor unchanged.
Its native keyring cancellation dialog has not been separately qualified.

The optional check below creates a disposable GTK editor, targets only its own
process, edits text through AT-SPI, presses Save and reads back the exact bytes.
It needs a desktop accessibility bus and Python's GTK3 bindings (test-only).

```sh
node scripts/linux-accessibility-smoke.cjs
```

Before declaring a public Linux release, verify on clean Ubuntu and Fedora
desktop installs: model setup and a real Worker turn; Chrome Store connection;
file dialogs, open/reveal, notifications, shortcuts, scaling and multiple
displays; close/reopen and suspend/resume; uninstall/reinstall and a higher-version
upgrade preserving Folders, chats and credentials. Verify both GNOME and KDE if
both are advertised. Container packaging alone is not evidence for those paths.

### GNOME Wayland sharing

One combined XDG RemoteDesktop/ScreenCast session owns the granted PipeWire
connection and libei input connection. ASHPD, GStreamer and libxkbcommon provide
portal, media conversion and compositor-keymap handling. The helper records no
restore token, never reopens sharing automatically, and publishes an active
state only after receiving a frame and negotiating input. Images reach Pi and
the selected model only through a requested observation/action. The capture
pipeline keeps its latest frame in memory while sharing is active.

A grant belongs to one explicitly selected Chat. Each accepted turn acquires a
separate control lease; an OS file lock prevents two work-fold instances from
controlling the same seat at once. Stop, Chat disposal/archive, Folder removal,
app shutdown, helper loss, screen lock and suspend revoke sharing. Wake never
resumes it. Keyboard input follows the desktop's focus, so sharing a monitor
does not confine keystrokes to one application. Full-trust Pi capabilities remain
full-trust; restricted Folder apps do not receive this bridge.

The [native acceptance harness](../scripts/linux-wayland-probe/README.md) passes
on private GNOME 46 (Ubuntu 24.04) and GNOME 50 (Fedora 44) Wayland seats at 100%,
125%, 150% and 200% scaling, including compositor US and German keymaps. It
requires a real click to focus a GTK editor, verifies exact
saved bytes, scroll and drag events, balanced input, stale-state/owner rejection,
cross-process seat exclusion, pending-chooser Stop and compositor screen-lock
revocation. A second test drives the actual Pi client and included tools through
the same host service/native helper and verifies image delivery to a scripted
provider. Login services are simulated with python-dbusmock; this does not
qualify a physical GDM session, GPU, sleep/wake or default host security policy.


The packaged desktop test additionally exercises the actual setup UI, cancellation,
a warm Chat using the shipped helper, native folder chooser/cancel, Nautilus
reveal, and task completion while the main window is minimized. Native input
establishes focus before closing; actual compositor frames verify minimize and
desktop-switcher restore. DOM-driven setup controls use temporary DevTools focus
emulation while obscured; it is removed before native focus and continuity
checks. A Wayland programmatic focus request can legitimately
show a notification instead, so a second-process launch alone is not proof of
activation. Linux windows map immediately against the theme background; this
avoids a hidden first-paint deadlock. Local file opening uses Electron’s file-URL
launch path because the pinned Linux `openPath` implementation drops its
completion callback. See [Electron window behavior](https://www.electronjs.org/docs/latest/api/browser-window)
and [the pinned shell implementation](https://github.com/electron/electron/blob/v42.6.1/shell/common/platform_util_linux.cc).

The initial path supports **one explicitly selected GNOME monitor**, frames up to 4096 pixels per
dimension, and keys representable in the compositor's map. Unsupported composed
Unicode/IME input is rejected before dispatch. Both private GNOME versions also
pass a two-monitor test with a 100% primary and 100/125/200% selected secondary at
(1280, 0), verifying capture dimensions and exact input on the secondary. The
headless fixture disables hot corners because AT-SPI accepts Share without moving
its initial pointer away from (0, 0); the first motion otherwise opens the overview.
Rotations of 90°, 180° and 270° also pass capture, input and the Pi path at 100/125%
on both private compositors. Hotplug, physical multi-monitor/GPU paths and KDE
remain unqualified.
Geometry mismatches fail before input. Unit tests cover additional scale math
and US/German keymaps; they do not replace those desktop cases.

DEB/RPM declare libei (at least 1.2), libxkbcommon, GStreamer base/video libraries,
PipeWire's GStreamer plugin and xdg-desktop-portal. A working GNOME portal backend
and session screen-lock service are also required. AppImage does **not** bundle
these desktop libraries/plugins: install `libei1 libxkbcommon0 gstreamer1.0-pipewire
gstreamer1.0-plugins-base xdg-desktop-portal-gnome` on Ubuntu, or `libei
libxkbcommon pipewire-gstreamer gstreamer1-plugins-base xdg-desktop-portal-gnome`
on Fedora. Do not disable the Chromium sandbox to work around missing desktop
integration. See the upstream [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
and [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
contracts.

## Signed repository candidates

`npm run desktop:stage:linux` stages a new local directory using **aptly**,
**createrepo_c**, **rpmsign** and **GnuPG**. It verifies the build record and every
input artifact's name, size and SHA-256, checks DEB/RPM package identities, signs
a copy of the RPM, builds signed APT/RPM metadata, signs the AppImage, and writes
a signed `repository.json` and `SHA256SUMS`. Original build artifacts are unchanged.
The script never uploads anything or modifies this machine's package managers.

Build the tooling image after the normal Linux build image:

```sh
podman build -t work-fold-linux-repository desktop/linux/repository
# Run in the tooling image with an explicitly mounted private GNUPGHOME.
# Replace FINGERPRINT with the complete 40-character uppercase primary fingerprint.
npm run desktop:stage:linux -- --input out/linux --output out/linux/signed-candidate \
  --gnupg-home /private/signing --fingerprint FINGERPRINT
```

The output directory must not exist; the key directory must be owned, mode 0700,
outside the public output, and free of symlink ancestors. There is no default
signing identity and no key generation in the staging script. Production-key
staging refuses dirty source builds or missing source/SBOM evidence. The archive and
manifest are rechecked while copying into `source/`, then covered by the signed
repository manifest and checksums; the four dependency inventories receive the
same treatment under `sbom/`. For isolated acceptance, explicitly supply
a disposable test key with `--test-key`; the signed manifest records that choice
and still says `published: false`. Never use that test key for public distribution.

APT uses `stable/main`, `amd64`, content-addressed indexes, `InRelease` and
`Release.gpg`, plus a seven-day `Valid-Until`. Aptly owns the repository format;
the wrapper adds that expiry header before GnuPG signs the final Release. RPM
uses `rpm/x86_64`, package signatures and `repodata/repomd.xml.asc`. RPM signing
changes the package hash, so the signed manifest records the actual staged bytes
alongside the original `source-build.json`. AppImage verification uses its
detached `.asc` signature. Trust must come from an independently verified public
key fingerprint, not merely from a key downloaded beside an artifact.

The [container acceptance harness](../scripts/linux-repository-smoke.sh) requires
root **inside a disposable container** and `WORKFOLD_CONTAINER_INSTALL_TEST=1`.
Give it older/newer signed directories and `apt` or `rpm`. Stage them in that
order: APT rejects older signed Release dates at an existing repository URL.
The harness keeps negative-test cache state separate from the lifecycle test;
it uses real package-manager signature enforcement, a higher-version upgrade,
uninstall/reinstall, the retained Pi fixture and packaged credential stores.
Copy the shell script into the container before running it while editing the
checkout, so a live edit cannot change shell offsets midway through the test.

The [Fedora test image](../desktop/linux/repository/Dockerfile.fedora-test) keeps
the acceptance dependencies separate from production installers. APT acceptance
can use the repository tooling image. These tests do not qualify Wayland,
AppArmor, SELinux desktop policy, KDE, or interactive credential dialogs.

Public release still requires a clean source commit and retained build evidence,
the qualified desktop matrix, an owned production signing key and recovery/
rotation procedure, HTTPS hosting, atomic snapshot promotion retaining old
content-addressed indexes/packages, and timely renewal of expiring metadata.
There is no publisher or scheduled renewal configured by this staging command.
See [Aptly snapshots](https://www.aptly.info/doc/aptly/publish/snapshot/),
[RPM signatures](https://rpm.org/docs/), and
[DNF signature settings](https://dnf.readthedocs.io/en/latest/conf_ref.html).

## Real local-model acceptance

The installed harness can forward its synthetic task through the normal Pi
OpenAI-compatible provider adapter to an actual isolated **Ollama** server:

```sh
node scripts/linux-installed-smoke.mjs out/linux/linux-unpacked/work-fold-desktop \
  --profile-root /absolute/new-test-profile --phase seed --expect-version 0.4.34 \
  --live-ollama-url http://127.0.0.1:11474/v1 --live-model MODEL
```

Run `--phase verify` with the same profile and model after a successful seed.
The proxy forwards the actual model request and response; it does not synthesize
tool calls. The normal exact-file-byte, durable-request, sandbox and persistence
assertions still apply. Use enough model context for the full included-tool
catalog. The harness uses Pi's supported `httpIdleTimeoutMs` setting in that
disposable profile for CPU prefill, bounds each request to thirty minutes and
the accepted turn to forty, and disables automatic provider retries for this
live test. It accepts only an explicit loopback endpoint and never reads personal
provider credentials. Ollama 0.34.3 with a local Qwen3 4B instruct model has passed an actual native
Pi write task and cold-relaunch verification. That text-only test does not
qualify vision/computer planning, or a hosted provider's login, billing, OAuth
or encrypted credential setup.
