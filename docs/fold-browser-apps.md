# Space apps in approved browsers

The development branch adds private, read-only app views to the fold's Spaces
screen. Apps appear above the selected Space's files. Opening one shows its
reviewed web view, the Space and version, Close and Refresh. Apps without a
reviewed web view say **Desktop only** and explain that limitation when opened.
No share link or public exposure is created, and a local Development preview
can be opened without first publishing a Release.

## Reviewed content and exact identity

The existing `viewer` declaration identifies the packaged entry and readable
instance-owned data prefixes. It remains a maximum content declaration, not
permission to publish. Both private app views and shared viewers use the same
read implementation, `readRestrictedAppWebView`; their authority adapters are
separate. The public adapter still requires a consecrated Release-backed
publication. The private adapter requires an approved browser and pins the
Space, app, Feature Installation, revision and current authority digest.

`spaces.list` advertises `capabilities.appViews`. The closed management lane
adds `apps.list` for one registered Space and `apps.read` for one exact installed
web view. Listings contain at most 64 compact descriptors and report truncation.
They omit absolute roots, credentials, grants and data. Read calls accept only
`entry`, `asset`, `data.keys` and `data.get`, with strict field validation.
Owner identity comes from the installation, never the app or a request body.

Assets are rehashed against the installed package and limited to 1 MiB each.
Mutable source edits cannot change running bytes. Data reads include only the
declared prefixes, with the existing 512-key/128-KiB-per-value storage bounds.
The service serializes reads against authority changes and checks the exact
installation again after queued changes settle. The remote host independently
fences browser revocation before returning or caching a response. Reads never
run a model, action, automation, network broker, or storage mutation.

## Browser isolation and lifecycle

The management document keeps its existing restrictive script policy. It
embeds a static intermediary at `/browser-app-frame.html`; that frame and its
separate app child both use `sandbox="allow-scripts"` without
`allow-same-origin`. The intermediary passes the reviewed entry to a blob
document and forwards only messages from that exact child. The outer host
accepts only its exact intermediary window and a fresh per-view channel.

The intermediary's response policy permits only blob child navigation, denies
network connections and forms, and limits images/media/fonts to blob or data
URLs. This policy also constrains the app. App code cannot read either parent
document, cookies, local storage or the management browser's identity keys.
It receives the frozen `workFoldViewerApp` read API; no mutation or management
API is installed. The host admits at most four concurrent reads, the SDK caps
pending reads at sixteen and times them out after thirty seconds, and the relay's
existing per-session operation budget still applies.

Controls become visible after document readiness. A browser that cannot load
the sandboxed content gets a failure state after ten seconds. A blocked attempt
to leave the app replaces its view with a Refresh message. Closing, signing out
or detecting disconnection destroys the frame and invalidates pending results.
Reconnect never replays a read or action. Refresh resolves the same installation
again, accepting an updated revision but refusing a removed/reinstalled sibling.
While visible, a non-overlapping fifteen-second catalog check closes a view
whose revision or authority changed; every read also rechecks immediately.
Already displayed information cannot be recalled from someone who copied it.

## Action service under integration

The action foundation now adds the separate closed operations
`apps.actions.request|get|list|review|approve|cancel`. They require a host-only
live browser-authority callback in addition to the authenticated Principal.
They are not part of `apps.read` or the shared-viewer vocabulary. The trusted
browser review UI and private action SDK are still being connected; the current
web view continues to expose only its read SDK.

Requests select a declared worker action and at most 16 KiB of schema-checked
JSON. The host pins the Space, installation, revision, authority, browser and
grant, and records the accepting Tenant, Runtime Instance, Data Namespace,
canonical artifact and human Principal. App code cannot choose those owners.
The machine-local `restricted-apps/browser-actions.json` journal separates
bounded intent/result content from metadata-only receipt projections. Results
are schema-checked and at most 128 KiB; lists contain summaries without results.
Record contents are never sent through a shared viewer.

A request UUID and timestamp identify a retry. Identical retries return the
same record; changed input is refused. A trusted approval must match the exact
review digest. Acceptance is written and synced before worker dispatch, and
the durable receipt id becomes the native invocation id. Reconnecting or
repeating approval cannot dispatch an accepted request again. Startup marks
uncertain accepted work Interrupted, without replay or a guessed outcome.

The lane admits four live requests per installation and sixteen per browser,
runs at most two actions globally and one per installation, and expires pending
reviews after fifteen minutes. It retains at most 1,000 records in a 64-MiB
journal and prunes terminal records older than a day when admitting new work.
Admission reserves room for bounded terminal results. Damaged journals or
uncertain persistence disable this lane without preventing app startup.

Stop fences dispatch immediately, including approval races. Native workers
recheck both installed authority and the browser's live fence at launch, every
broker effect boundary and result delivery. Revocation aborts matching runs
and cancels that grant's pending requests; another browser's requests retain
their own authority. Closing a view does not cancel an accepted run. Stop or a
failed result does not claim to reverse effects that already completed.

## Remaining implementation

The repeatable isolation probe is
[`scripts/probes/browser-app.probe.js`](../scripts/probes/browser-app.probe.js).
With the local bridge on port 4319 and Playwright CLI opened to
`http://127.0.0.1:4319/?fixture=spaces`, run it with
`playwright-cli run-code --filename=scripts/probes/browser-app.probe.js`.
It refuses other pages and uses only inert fixture data. The probe checks the
actual quote read, opaque parent/cookie/storage boundaries, frozen read API,
network denial and blocked navigation. These browser checks complement the
domain, transport and DOM tests; they do not replace paired live acceptance.

Completing the browser action UI and richer result navigation remain part of
[the active goal](apps-fold-workflows.md). They must use a separate, bounded
intent/review/receipt path with exact app and browser provenance, deduplicated
acceptance, visible outcomes and revocation. App code cannot invoke that path
directly as if it were a read. Any confirmation belongs in the fold's trusted
UI outside the app frame. Shared viewers must retain their existing closed
read-only vocabulary. The foundation alone does not claim the complete action
experience ships.
