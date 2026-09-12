# Chrome extension distribution

Status: implemented in source; Store review and installed-Store acceptance are
separate release requirements. The unpublished item is
`ophmjbphcjmjcpcdpmfehbldiomkepgk`. Creating an item does not publish an extension.

## Installation and updates

**Skills & Extensions → Chrome → Connect Chrome** registers the app's signed
native helper and opens the exact Chrome Web Store listing. The person adds
**work-fold**, then chooses **Connect** in that profile. The first installation
opens this small setup page once; extension updates do not reopen it or connect
another profile. The UI shows Connected only after the authenticated HTTP
transport has negotiated compatible capabilities. A native lease alone means
Connecting. Setup reads do not launch a browser or enroll a profile.

Chrome supplies normal extension updates through the same Store item. The
companion and desktop negotiate bridge major version and required capabilities;
their product/package versions need not match. Incompatible companions receive
Update work-fold or Update Chrome extension before any command is dequeued.
No new user's setup requires Developer mode, Load unpacked, or finding Library
folders. The older manual-companion helper remains a contributor/standalone Pi
facility, not the production onboarding path.

## Bootstrap and ownership

The maintained pi-chrome 0.15.51 adapter preserves native tools, schemas,
observations, background behavior, cancellation, and session-owned tab cleanup.
Store bootstrap is a separate packaged script. Native Messaging is used only
to connect/resume/disconnect/query status or explicitly open the app; commands
and images retain the existing loopback HTTP path at `127.0.0.1:17318`.

The signed Swift host accepts only the exact Store origin allowed by its
manifest. Chrome supplies an extension origin, not a profile identifier. The
extension therefore generates a random installation ID and separate proof in
trusted-only local extension storage. The app owns selection and stores a proof
hash. Other installations cannot resume the selected profile, even if they use
the same extension ID. The temporary bridge credential stays in the service
worker's memory and native host runtime; it never enters the popup, renderer,
CLI, Chat, sync storage, or Store ZIP.

The host's private launch descriptor identifies its loopback bootstrap endpoint,
launch ID and token. The helper only forwards checked requests; it does not
change selection files itself. Desktop setup maintains an atomic user-level
NativeMessagingHosts manifest pointing to a versioned, byte-verified signed
helper under the app's private state root. App updates repair their owned
registration. A development or isolated profile must not replace the normal
Chrome registration. See [macOS build](macos-build.md) for packaging details.

Both Disconnect and Change profile refuse while affected accepted Chrome work
is active. A turn acquires that fence on its first Chrome operation and retains
it through pauses between tools until turn end, Stop, or disposal. Chat Stop
remains the cancellation action. At a safe disconnect, the app revokes the
connection generation and all stale queues, polls and results. HTTP requires
the selected origin, token and connection ID; each command also carries the
existing bridge epoch. Uncertain browser effects are never automatically
replayed. Cleanup may close only the session's created tabs and remove its
own grouping; ordinary user tabs remain open.

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
review outcome. Verify the final approved Store installation with the signed
desktop before describing onboarding as production-complete.

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

References: [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements),
[privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
