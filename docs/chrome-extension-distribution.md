# Chrome extension distribution

Status: implemented in source. The public
[Chrome Store item](https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk)
was verified on 2026-09-23: version 1.0.0, updated September 15, 2026. That listing
snapshot describes Apple-silicon Mac support. Windows and Linux installed-Store
acceptance and corresponding listing claims require their own evidence;
availability in the Store does not establish a working preview connection.

The source now builds **1.0.2**, as pinned in
`src/shared/chrome-distribution.json`. Store approval and installation of that
companion are separate from desktop preparation and source integration; see
[Platform previews](platform-previews.md) for platform acceptance limits.

The earlier **1.0.1** candidate keeps new groups
in the target tab's existing window. The previous grouping call implicitly moved
tabs into Chrome's current window, which reproduced Linux background-capture
timeouts. The local 1.0.1 candidate passes real native connection, unfocused
target-pixel capture, two-Chat ownership, cleanup and browser/host restart on
Chrome for Testing 154.0.8037.57 Stable (X11 and private GNOME Wayland) and
155.0.8059.12 Beta (X11). The previously tested Store 1.0.0 retained the failure.
That result is dated acceptance evidence, not a claim about the live listing today; Store publication
and acceptance of a newer companion remain separate work.

## Installation and updates

**Skills & Extensions → Chrome → Connect Chrome** registers the app's verified
native helper and opens the exact Chrome Web Store listing. The person adds
**work-fold**, then chooses **Connect** in that profile. The first installation
opens this small setup page once; extension updates do not reopen it or connect
another profile. The UI shows Connected only after the authenticated HTTP
transport has negotiated compatible capabilities. A native lease alone means
Connecting. Setup reads do not launch a browser or enroll a profile.
On Windows and Linux, opening the listing waits for the Chrome process to launch, not for
the browser to exit. Otherwise a first launch would hold connection setup and
block the extension's own native bootstrap. A launched process alone does not
establish Connected; authenticated HTTP negotiation still determines readiness.

Chrome supplies normal extension updates through the same Store item. The
companion and desktop negotiate bridge major version and required capabilities;
their product/package versions need not match. Incompatible companions receive
Update work-fold or Update Chrome extension before any command is dequeued.
No new user's setup requires Developer mode, Load unpacked, or finding Library
folders. The older manual-companion helper remains a contributor/standalone Pi
facility, not the production onboarding path.

## Bootstrap and ownership

The maintained pi-chrome 0.15.51 adapter preserves native tools, observations,
cancellation, and session-owned tab cleanup. In work-fold, ordinary calls stay
in the background; `background: false` or `chrome_tab activate` explicitly brings
the target forward when needed. Focus is chosen per call within the person's
task and constraints, with no user-selectable background mode. The embedded
`/chrome` command offers connection check/setup only. Standalone Pi retains its
native session background preference.

Store bootstrap is a separate packaged script. Native Messaging is used only
to connect/resume/disconnect/query status or explicitly open the app; commands
and images retain the existing loopback HTTP path at `127.0.0.1:17318`.

The Swift host on macOS and Rust hosts on Windows and Linux accept only the
exact Store origin allowed by their manifest. Chrome supplies an extension
origin, not a profile identifier. The extension therefore generates a random installation ID and separate proof in
trusted-only local extension storage. The app owns selection and stores a proof
hash. Other installations cannot resume the selected profile, even if they use
the same extension ID. The temporary bridge credential stays in the service
worker's memory and native host runtime; it never enters the popup, renderer,
CLI, Chat, sync storage, or Store ZIP.

The host's private launch descriptor identifies its loopback bootstrap endpoint,
launch ID and token. The helper only forwards checked requests; it does not
change selection files itself. Desktop setup maintains an atomic user-level
NativeMessagingHosts manifest pointing to a versioned, byte-verified helper
under the app's private state root. Production Mac packaging signs that helper.
App updates repair their owned registration. A development or isolated profile
must not replace the normal Chrome registration. Linux uses the Google Chrome
manifest under `$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts` (default
`~/.config/google-chrome/NativeMessagingHosts`). The private registration receipt
pins the app executable used by the explicit Open app action. All platform implementations
bound framing and forward only to the private descriptor's loopback endpoint;
the Linux host disables proxies and redirects. See [macOS build](macos-build.md),
[Windows builds](windows-build.md), and [Linux builds](linux-build.md) for
packaging details. Linux Store-profile
acceptance remains separate from native-host protocol tests.

On Windows the same contract uses a Rust host built from
`desktop/native/chrome-host-windows` with its locked dependencies and the
Store origin compiled in. Chrome finds native hosts through the registry, so
only the NSIS-installed app writes
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.work_fold.chrome`, whose
default value names the manifest in the app's private `chrome\native-host`
directory; unpacked, development and state-overridden builds never touch it.
Automatic repair keeps the macOS ownership rule: it never replaces another
installation's registration, and only an explicit **Connect Chrome** chooses
this one. The host also accepts the `--parent-window=<handle>` argument Chrome
adds on Windows. In place of the POSIX owner and `mode & 0o077` check, it admits
`launch.json` only as a single-link regular file owned by the current user whose
DACL allows no one but that user, SYSTEM and Administrators; the app gives the
directory a protected DACL of exactly those principals, because an inherited
profile ACL can admit others. The host reads through a handle that still lets
the app replace the descriptor atomically, and speaks HTTP/1.0 so the reply is
never chunked. **Open work-fold** starts only an absolute `work-fold.exe` named
by the app's own `app.json` in that directory. The Store listing opens in Google
Chrome found through its App Paths registration rather than the default browser.

Both Disconnect and Change profile refuse while affected accepted Chrome work
is active. A turn acquires that fence on its first Chrome operation and retains
it through pauses between tools until turn end, Stop, or disposal. Chat Stop
remains the cancellation action. At a safe disconnect, the app revokes the
connection generation and all stale queues, polls and results. HTTP requires
the selected origin, token and connection ID; each command also carries the
existing bridge epoch. Uncertain browser effects are never automatically
replayed. Cleanup may close only the session's created tabs and remove its
own grouping; ordinary user tabs remain open.

The 1.0.2 companion source includes target-window grouping, hidden-input
failure reporting, complete multiline field replacement, targeted typing at
field end, and recovery from half-open long polls. Text insertion preserves
line breaks without sending Enter; widgets that require key events can use
`perCharacter: true`. Click and fill fall back only before trusted input is
dispatched, and results explicitly identify DOM fallback as untrusted page
events. Native fill reports field-value mismatches without retrying, and a
definite mismatch prevents a requested submission. Read-back is best-effort:
missing verification does not repeat a successful input. The
desktop observes compatible polls, accepted results and active-command
heartbeats rather than mistaking a long operation for a lost connection.
Desktop status refreshes do
not upgrade an installed extension. Companion-side fixes require the reviewed
1.0.2 ZIP to be approved and installed separately. Desktop preparation does
not submit or publish that companion to the Store.

## Build and publication

`npm run chrome:build` writes a deterministic ZIP plus per-file SHA-256 evidence
under `out/chrome-store/`. It verifies every declared upstream patch digest,
copies only explicit static files, adds the work-fold name and existing icon
assets, and excludes `host-config.json`. All service-worker/UI code is bundled.
The optional public key, when supplied, must derive the pinned item ID. A Store
upload can omit `manifest.key`; the Store signs it using its assigned identity.
No private signing key belongs in this repository. Production native builds and
the connector build reject missing Store identity. `--draft` permits a missing
identity only for an unpublished first upload; it is not a publication lane.

The Store listing must disclose broad site/debugger permissions, requested page
and interaction data, and transfer through the desktop to the configured model
provider. Page evaluation through Debugger API is declared using Chrome's
documented MV3 exception; it is not represented as an absence of supplied code.
No extension script is downloaded for execution in the extension context.
The [privacy policy](../PRIVACY.md) must be public and current before submission.

Publication requires the registered publisher account, final ZIP, listing and
privacy fields, truthful screenshots, and Google review. Google controls the
review outcome. Verify the final approved Store installation with the exact
packaged desktop on each claimed platform before describing its onboarding as complete.

## Verification

`tests/chrome-store-bootstrap.test.ts` covers explicit first connection, trusted
identity storage, worker suspension/resume, wrong profile, busy Disconnect,
duplicate actions, old HTTP responses, and status races on both sides of Connect.
`tests/chrome-store-build.test.ts` verifies deterministic bytes, identity checks,
the manifest, real icon dimensions, and exclusion of local connection files.
The maintained upstream tests use real loopback HTTP, a literal Chrome Origin,
two Pi sessions, before-dequeue compatibility, turn fences and lease revocation.
Native-host/service tests cover framing, exact origin, private registration,
repair, startup/shutdown, and interrupted setup without replay.

Release acceptance additionally needs real Chrome installation, first Connect,
restart and browser suspension recovery, update compatibility, two simultaneous
Chats, screenshot feedback reaching the model, Stop, and user-tab preservation.
Synthetic protocol tests are not evidence of Store approval or successful
installation in a real user's profile.

For a local candidate, the isolated Linux Chrome harness accepts
`WORKFOLD_CHROME_CANDIDATE_ZIP` pointing to the ZIP from `npm run chrome:build`.
It verifies the ZIP and file digests, extracts into its disposable profile root,
and loads it using Chrome for Testing selected by `WORKFOLD_TEST_CHROME`.
It reports candidate evidence explicitly and refuses a simultaneous Store
enrollment or managed-install policy. The published-Store lane remains the
default. Screenshots must contain the requested tab's known pixels while that
tab stays unfocused, rather than merely returning a nonempty image.

References: [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements),
[privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
