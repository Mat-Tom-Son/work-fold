# Native Wayland acceptance

This directory tests the production helper in
[`desktop/native/linux-wayland`](../../desktop/native/linux-wayland/Cargo.toml).
Its small diagnostic binary reuses that crate; the application ships the
production stdio helper, not the diagnostic CLI. ASHPD, GStreamer, libei and
libxkbcommon own the desktop protocols and conversion/keymap machinery.

## Build and isolated native tests

Build the Ubuntu 24.04 baseline image first. Run as the checkout owner so generated
files remain writable. Neither command forwards a personal desktop bus or home.

```sh
podman build -t work-fold-linux-build desktop/linux
podman build -t work-fold-wayland-probe scripts/linux-wayland-probe
podman run --rm --userns keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --security-opt label=disable -v "$PWD:/work" \
  -e CARGO_TARGET_DIR=/work/out/linux-wayland-probe-target \
  work-fold-wayland-probe cargo test --locked \
  --manifest-path desktop/native/linux-wayland/Cargo.toml
```

The native tests exercise synthetic GStreamer frames, region/scale matching,
upstream libeis device negotiation, paired pointer/keyboard events, paused and
removed devices, compositor US/German keymaps and protocol replay/state fences.
These tests alone do not qualify a compositor. `npm run desktop:linux-native-hosts`
builds the release helper, license inventory and source/hash manifest.

## Private GNOME acceptance

The Ubuntu and Fedora images create their own D-Bus, PipeWire, WirePlumber,
headless GNOME Wayland seat and GTK target. They never mount a personal bus,
keyring, home, graphics device or input device. python-dbusmock supplies isolated
logind/GDM services so the actual GNOME screen shield can run. This establishes
compositor behavior, not a physical login, hardware GPU or default host security
policy. No account or model credential is needed.

```sh
podman build -f scripts/linux-wayland-probe/Dockerfile.gnome-test \
  -t work-fold-gnome-acceptance .
podman build -f scripts/linux-wayland-probe/Dockerfile.fedora-test \
  -t work-fold-gnome-fedora-acceptance .
# Repeat with work-fold-gnome-fedora-acceptance for Fedora.
podman run --rm --userns keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --security-opt label=disable -v "$PWD:/work:ro" \
  -e HOME=/tmp/workfold-gnome-home -e WORKFOLD_ISOLATED_GNOME_TEST=1 \
  work-fold-gnome-acceptance \
  bash -euc 'mkdir -p "$HOME"; bash /work/scripts/linux-wayland-probe/acceptance.sh'
```

The production release helper must already exist in `out/included-tools/wayland-helper`.
The checkout must have installed npm dependencies. The acceptance runner waits
for GNOME's completed startup before operating the private desktop; a reachable
D-Bus service alone does not establish input readiness.

`protocol-smoke.py` selects only the private test monitor in the actual portal
chooser. It verifies PNG delivery, exact saved editor bytes,
click-to-focus, scrolling, shortcut and drag events, paired input, stale-state
and wrong-owner rejection, cross-process seat exclusion, compositor screen-lock
revocation and Stop during a pending chooser. It saves bounded evidence only
under `/tmp/workfold-input-fixture*` inside the disposable container.

`pi-smoke.mts` exercises the real Pi client and included computer tools, host
accepted-turn lease, native portal, PipeWire image, image-bearing provider request,
libei input, exact output bytes, end-of-turn release and Chat teardown. Its
provider responses are scripted. The separate installed local-model harness in
the [Linux build guide](../../docs/linux-build.md) covers actual model generation.

Both private GNOME 46/Ubuntu 24.04 and GNOME 50/Fedora 44 matrices pass at
100%, 125%, 150% and 200%. Set `WORKFOLD_NATIVE_TEST_SIZE=2880x1800` for all four
scales; its integer dimensions permit exact 150% as well as 125%. The default
1280×720 run covers 100% and 125%. Set `WORKFOLD_NATIVE_TEST_LAYOUT=de` to test
the compositor's German keymap, including umlauts, ß and AltGr symbols such as
`@`, `€`, braces and backslash; the default is US. Modifier chords are resolved
through libxkbcommon's key state, including locked modifiers, without changing
Caps Lock or assuming Ctrl+Alt means AltGr. Compose/IME-only text is rejected
before any keys are sent.
Both layouts have passed real input and exact-file verification. A separate
two-monitor run uses `WORKFOLD_NATIVE_TEST_SECOND_MONITOR=2560x1440` with the
default 1280×720 primary; the selected secondary starts at (1280, 0). Both
desktops pass its 100/125/200% secondary cases with the primary at 100%.
`WORKFOLD_NATIVE_TEST_TRANSFORM=1`, `2`, or `3` tests a single monitor rotated
90°, 180°, or 270° at 100/125%; capture, input and the Pi path pass for all three
rotations on both compositors. The headless fixture disables
hot corners: AT-SPI portal selection leaves the initial pointer at (0, 0), where
the first move can otherwise open the overview and consume the click. Mirroring,
hotplug, physical multi-monitor setups, physical
sleep/wake, GPU buffer negotiation, composed Unicode/IME and KDE remain outside
this evidence. Unit math/keymap tests do not substitute for those cases.

Set `WORKFOLD_NATIVE_TEST_LIVE_SCALE=1` for a single unrotated monitor to change
its scale while a turn holds an observation. The test requires rejection of
the old input attempt without GTK clicks or keys, then closes the old helper
and selects a fresh portal grant. Exact saved text and balanced input must work
again at the new scale. Both private desktops pass 100→125%, 125→100%,
150→100% and 200→100%, with the German/AltGr exact-text checks retained.
The compositor ends the old capture pipeline or invalidates its input region.
Neither case permits reuse of the old coordinates. This covers live
virtual-monitor scaling, not physical cable hotplug.

`desktop-acceptance.sh` adds the packaged application to the same isolated seat.
Run it in place of `acceptance.sh`, with `--security-opt seccomp=unconfined` so
Electron can create its renderer sandbox inside the container. It uses the real
setup UI and portal, a warm Chat and actual Pi tools, native folder dialogs and
Nautilus, plus accepted-turn continuity during a window-manager close and
desktop-switcher restore, second-instance reuse and clean native Quit. The switcher
check locates work-fold by its native accessible name and sends a real portal
click to its visible bounds, rather than assuming one Alt+Tab selects it. It establishes actual focus
with native input before closing; a Wayland focus request can legitimately show
a notification instead of activating a window. Temporary DevTools focus emulation keeps DOM setup commands responsive under
occlusion and is disabled before native focus/minimize/continuity checks.
Its screenshots come from the shipped portal path,
not the web debugger. A test-only local provider drives deterministic tool calls;
the harness never receives model credentials or a personal desktop connection.

## Full disposable virtual machines

The same packaged desktop test can run after a real GDM password login in a
fresh QEMU guest. The overnight Fedora 44 guest uses a signature-verified official
Cloud image plus distro GNOME packages, installs the signed test RPM through DNF,
and keeps SELinux enforcing. It passes capture/input, native dialogs/reveal,
minimize/turn continuity, restoration and second-instance handling. This is
separate from the simulated login services above and from physical GPU evidence.

`fixture-environment.py` refuses VM interaction unless a root-owned, non-writable
`/etc/workfold-disposable-vm.json` record pins its schema
`work-fold.disposable-vm.v1`, random `fixtureId`, actual `machineId`, and non-root
`userUid`. `WORKFOLD_ISOLATED_VM_TEST` must match that fixture ID; the real QEMU
identity, owned runtime directory, session bus and Wayland socket are checked.
The VM must be provisioned for this test, with synthetic login credentials and
no personal data, shared home, bus, graphics device or input device.

Place the test harness and its npm dependencies under `/work`, use Node 24, and
install the candidate using its package manager. Set the ordinary GNOME login
session environment and `WORKFOLD_ISOLATED_GNOME_TEST=1`;
`WORKFOLD_VM_MONITOR_NAME` is the guest monitor's exact portal label. The test
driver allows five times its normal waits for software emulation. QEMU may also
use KVM for CPU execution; the fixture guard accepts both modes and verifies
QEMU's DMI identity. No host desktop, GPU, input device or home is passed through.
Product and native-helper timeouts remain unchanged. These timings do not
measure physical graphics performance.

Run `desktop-smoke.mjs /opt/work-fold` first. Its printed evidence directory
contains the disposable profile. `launcher-smoke.py` separately verifies the
installed desktop entry and actual GTK icon lookup at both 1× and 2× scale.
`settings-credentials.mjs /opt/work-fold
<evidence-directory>` tests synthetic key entry through Settings, encrypted
storage, cold-relaunch persistence and removal; it never calls a model provider.
`vm-lock-revocation.mjs /opt/work-fold` locks only that guest's GDM session and
requires unlocking through its virtual console before testing a fresh grant.
The optional `WORKFOLD_VM_SUSPEND_TEST=1` desktop run also requests real guest
suspend while a provider response is pending. Observe QEMU enter `suspended`
before issuing `system_wakeup` on that guest's private QMP socket, then unlock
its virtual console. Retain both QMP observations and the guest sleep journal.
If the guest wakes immediately before the host observes its suspended state,
record that limit: kernel S3 entry/resume proves the OS lifecycle path, not a
sustained sleep interval. The test checks turn completion and a new screen grant
after wake. A disconnected test debugger is reattached to the same
still-running app without restarting or reloading it. The Fedora 44 software VGA
KVM guest passes this path; the virtio display does not reliably resume even
without the app. This does not qualify physical hardware sleep behavior.
Never satisfy these guards on a personal VM or weaken them for the host desktop.

## Optional diagnosis in a disposable session

Build `scripts/linux-wayland-probe/Cargo.toml` with `cargo build --locked` in the
baseline environment. `--diagnose` reads portal capabilities and plugin
availability; `--test-pattern` converts synthetic pixels. `--capture` opens the
normal chooser, captures one frame through the granted connection and closes;
it sends no input. The guarded `--isolated-input-test` mode is test-only.

```sh
out/linux-wayland-probe-target/debug/work-fold-wayland-probe --diagnose
out/linux-wayland-probe-target/debug/work-fold-wayland-probe --test-pattern
out/linux-wayland-probe-target/debug/work-fold-wayland-probe --capture
```

Never forward a personal desktop bus into a build/test container. A denied or
timed-out chooser is not a successful capture. The [completion plan](../../docs/linux-roadmap.md)
tracks remaining desktop and release qualification.
