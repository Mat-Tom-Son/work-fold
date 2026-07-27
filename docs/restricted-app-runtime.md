# Restricted app runtime

Workspace has a second executable lane for apps an agent creates for a Space.
These apps can render arbitrary reviewed web UI in the left navigator and open
normal persistent tabs in the work area. They are intentionally separate from
native Pi Extensions.

The version-2 package is now the reviewed Feature format for two distinct local
runtime kinds: a source-bound **Local preview** in a Development Instance and a
release-backed **Installed Release** in an App Instance. App Studio owns the
Project/Release/Instance lifecycle; the package and bridge contract described
here is unchanged. See [App platform foundation](app-platform-foundation.md).

For the exact package format, manifest template, bridge methods, worker
exports, denial handling, and hands-on workflow, use the canonical
[Restricted app authoring guide](restricted-app-authoring.md).

| Lane | Execution | Intended use |
|---|---|---|
| Native Pi Extension | Full current-user permissions; Pi may evaluate it while building the catalog. | Trusted developer capabilities, commands, providers, and compatibility with the Pi ecosystem. |
| Restricted app package | An exact reviewed revision runs as sandboxed web content with a narrow host bridge. | Agent-created inboxes, dashboards, extractors, and project-service panels with host-mediated powers. |

Restricted packages must never declare `pi.extensions`, use Pi's package
installer, or appear in Pi's loaded Extension catalog. Pi imports Extension
modules and calls their factories during catalog loading, which would cross the
restricted execution boundary before the app opened.

## Package contract

`agent-app.json` is strict and versioned. It declares:

- a required `sandboxed-web` HTML entry;
- an optional JavaScript worker entry for Assistant tools and named
  automations;
- optional UI metadata such as a rail icon and a whole-pixel app-canvas corner
  radius from 0 through 24;
- bounded Assistant tool declarations using a closed JSON Schema subset; and
- exact broker destinations, methods, and acceptable authentication modes;
- reviewed Space-file needs (`file` or `directory`, `read` or `read-write`);
- optional static notification categories, each with reviewed title and body;
  and
- a required `automations` array containing zero to sixteen independently
  controlled named interval jobs. Each job declares its handler, schedule,
  catch-up policy, overlap policy, and an exact subset of the app's reviewed
  network, file, and notification permissions.

Public destinations use `{ "kind": "public-https", "origin": "https://api.example.com" }`.
Local development services use an explicit numeric target such as
`{ "kind": "loopback-http", "host": "127.0.0.1", "port": 4317 }`.
Loopback targets do not use DNS, cannot redirect, and cannot receive saved
credentials. Workspace verifies the numeric address and port, but does not yet
verify which local process owns that port; the UI states that limitation when
access is granted.

Public auth declarations can use `none`, `api-key`, `bearer`, `basic`, or
`oauth2-pkce`. Manifests contain no secret values. OAuth declarations contain a
public HTTPS issuer, an existing public native-client id, scopes, an optional
discovery mode, and optional reviewed authorization parameters. Workspace does
not accept client secrets, OIDC scopes, or device-code declarations in this
lane. Generated apps cannot create a provider registration; provider-specific
convenience connections require a future Workspace-owned adapter and
registration.

An OAuth declaration locates its authorization server through RFC 8414
discovery (the default), OpenID Connect discovery, or pinned endpoints. A pinned
endpoint must use the issuer's exact host, enforced both in the manifest parser
and again in the OAuth client. Subdomains are refused too: authority inferred
from DNS structure grows as the issuer host shortens, and shared-tenant
platforms make co-tenants indistinguishable from the operator. Discovery may name a token
endpoint on an unrelated origin because that document is served over TLS from
the issuer's own well-known path and a package author cannot forge it; a pinned
endpoint has no such document and must therefore establish the same authority
structurally. Otherwise a package could pair a genuine issuer and authorization
endpoint with an attacker-controlled token endpoint and receive the
authorization code and PKCE verifier after a real provider consent screen.
Workspace renders the exact issuer, client id, scopes, discovery mode, pinned
endpoints, and static authorization parameters during app review and connection
management, but that transparency is not a substitute for structural
validation. Pinned mode also cannot require the RFC 9207
authorization-response `iss` check, because no metadata states whether the
provider supports it.
Workspace enforces what it can prove — the metadata issuer must equal the
declared issuer, endpoints must be public HTTPS, and an advertised grant list
must include `authorization_code` — and reports rather than refuses
under-declared provider capabilities, because the client itself always sends
PKCE S256 and never holds a client secret. Those bounded notes are retained
with the encrypted connection and remain visible in its management surface.
Gating on those advertisements
rejected Google and Microsoft, which both support public PKCE clients without
saying so in their metadata. Malformed metadata values still fail closed.

Reviewed `authorizationParameters` carry provider dialects such as Google's
`access_type=offline`, without which a provider need not issue a refresh token
and an unattended automation loses its connection within the hour. They are
bounded static text, may not use any name the authorization request owns, and
are overwritten by the protocol layer at request time.

The package inspector never invokes npm, imports package code, or runs lifecycle
scripts. It rejects scripts, binaries, workspaces, native build flags, Pi
declarations, unsafe paths, links, missing entries, unknown powers, and
oversized content. Dependency metadata is permitted because an agent may use a
normal frontend toolchain, but Workspace never resolves or installs it: all
runtime assets must already be present in the reviewed package.
Enumeration captures each regular file's identity, size, and change metadata;
later reads use bounded file handles, require the same identity before and
after the exact read, and derive the manifest, byte totals, and both digests
from that one captured snapshot. A package that changes during inspection
fails closed instead of allocating or reviewing the replacement bytes.

Files are copied into application storage under a SHA-256 content digest and
verified again. Inspection also computes the portable `workspace-artifact-v1`
digest used by the App-platform release contract. Installation requires the
exact reviewed bytes. The local registry owns one App Project and Development
Instance per participating Space, with a distinct Feature Installation and Data
Namespace per app. Source edits after installation do not change the installed
revision. This direct preview is a Development preview, not a published Release
or release-backed App Instance.

```text
connected-inbox/
├── package.json
├── agent-app.json
├── index.html
├── app.js
├── styles.css
└── worker.js       # optional; required for tools, automations, or notifications
```

The checked-in [connected inbox app](../examples/packages/restricted-connected-inbox/README.md)
is an interactive reference package with a separate ordinary loopback demo
service. Workspace does not launch or trust that developer process.

## Visible app host

The trusted Workspace renderer owns only a placeholder rectangle and app
identity. Electron main verifies the installed Runtime Instance, Feature
Installation, exact revision, and seven-domain Authority Stamp, snapshots the
staged package, and mounts a `WebContentsView` in the main window. Every mount
gets a separate ephemeral session and origin.

The view has Chromium sandboxing and context isolation enabled, with Node,
webviews, popups, downloads, dialogs, permissions, direct network access,
navigation, workers, frames, service workers, and file selection denied. Its
CSP permits only reviewed same-origin scripts, styles, images, and fonts. Native
view bounds and visibility follow the owning DOM placeholder; inactive tabs,
hidden windows, minimization, and modal occlusion detach the native view while
leaving its renderer alive.

The shell gives a navigator app the same 12px inset used by built-in pane
content. Its placeholder and native view share a rounded 12px canvas by
default. A reviewed manifest may override that radius from 0 through 24 pixels;
the host clips the native view itself because renderer CSS cannot clip a
`WebContentsView` layered above it. Electron's rounded cutout is visual only;
the corner area still participates in hit testing, so the inset keeps it over
inert pane background rather than trusted controls.

The preload exposes only `workspaceRestrictedApp`:

- `context.get()` and `context.onChanged()` report placement (`navigator` or
  `tab`), route, host-owned app identity, theme, active state, and bounded tab
  state;
- `tabs.open(...)` asks Workspace to create or activate a Space-owned work tab;
- a tab may update or close itself;
- `request(...)` sends a declared request through the network broker;
- `storage` provides Tenant-and-Data-Namespace-owned JSON data and active-UI
  invalidation hints;
- `files` lists, reads, or writes only through current reviewed grants; and
- `notifications.show({ permissionId })` selects reviewed static copy, only
  during an enabled automation invocation whose permission subset includes a
  separately granted category; and
- `limits.get()` returns the host's effective network, storage, file, and
  automation bounds synchronously.

The limits view is a mount argument rather than an IPC call: the values never
change while a mount lives, are not secret, and are composed from the live
brokers so a host enforcing non-default bounds cannot publish stale ones. It
exists so an app — and the agent writing one — can design to the budget instead
of discovering it by crashing into it. Each bound also has its own terminal
error code (`NETWORK_RESPONSE_TOO_LARGE`, `NETWORK_REQUEST_TOO_LARGE`,
`FILE_TOO_LARGE`, `STORAGE_QUOTA`) naming the limit that was hit, so an
over-large read is distinguishable from a transport failure.

An app supplies a local `appTabId`, title, route, and JSON state. It never
supplies the owning Space, app id, digest, or shell tab id. Workspace derives
those values from the sending `WebContents` and constructs
`restricted-app:<space>:<app>:<digest>:<appTabId>`. App tabs use the same shell
storage, cross-Space activation, close behavior, and most-recent-tab restoration
as built-in tabs. An updated or removed revision cannot silently take over a
persisted old tab.

## Worker host

Apps that expose Assistant tools or automations declare a separate worker
module. Workspace loads it in a hidden sandboxed renderer with the same
direct-network and Node denials. Inputs and outputs are schema checked and
bounded; timeouts, crashes, cyclic values, intrinsic tampering, and oversized
results terminate the worker. The worker is optional so a UI-only app does not
need executable worker code.

Automations are first-class host jobs, not one app-wide background switch.
Every declared job starts disabled and is enabled separately in Assistant tools.
The worker exports `handleAutomation(event)` and dispatches using the reviewed
`automationId` and `handler`. Intervals are whole minutes from 15 through
1,440. `catchUp: "latest"` permits at most one deterministically staggered run
for the latest missed occurrence after startup or resume; `"none"` skips missed
occurrences. `overlap` is currently fixed to `"skip"`.

One machine-wide `WorkspaceAutomationService` owns scheduling across every
Space and restricted app. It uses a FIFO queue, at most two active jobs, and
never overlaps the same named job. Scheduled, manual, skipped, cancelled, and
failed attempts produce durable run receipts. The cadence anchor is persisted
separately from one-off manual runs, so **Run now** does not shift the next
scheduled occurrence. A manual run is allowed while its schedule is disabled,
but it receives no notification authority. At launch, Workspace re-reads the
installed digest and current grants, then intersects those grants with that
job's reviewed permission subset. Disabling, updating, removing, sleeping, or
quitting stops stale launches before authority changes take effect.

Notifications are host-owned system notifications, not arbitrary renderer
UI. The manifest title and category copy are single-line reviewed text; the
runtime cannot add dynamic copy, actions, or URLs. A category grant, an enabled
automation, and inclusion in that automation's permission subset are all
required. The host limits each invocation,
category frequency, hourly app volume, and outstanding notifications. Rate
history is keyed by Space and app so renderer restarts, permission churn, and
digest updates cannot reset the anti-spam budget. Clicking revalidates the
current digest, declaration, grant, and automation authority before opening
the exact owning Space and app. Suspend, disable, update, removal, and shutdown
close outstanding notifications.

The real-Electron preparation probe covers both hosts: missing Node globals,
rejected Node imports, direct loopback HTTP/WebSocket denial, WebRTC and popup
denial, sender-bound broker failure, bounded results, timeout recovery, visible
UI loading, durable storage, active-only storage invalidation, a
History-covered Space-file write, automation execution, static notification
delivery and cleanup, and an app-requested host-owned tab.

## Network and credentials

Connections live in a separate operating-system-encrypted store outside the
Space and provider AuthStorage. A binding includes the host-derived Tenant,
Runtime Instance, Feature Installation, canonical Feature Revision artifact
digest, destination declaration and digest, canonical target identity, and an
explicit owner. The current local path creates Runtime-Instance-owned bindings;
Principal-owned consent and delegation remain future product work. Apps receive
status and errors, not secret values. The former Space/app/package-digest store is read only as
disconnected authority; an explicit reconnect atomically replaces it without
transferring ambiguous credentials.

OAuth PKCE uses RFC 8414 discovery, S256, a random one-shot loopback callback,
state and verifier checks, the system browser, encrypted token storage, and
serialized refresh with refresh-token rotation. The same public-HTTPS broker
validates and pins discovery and token endpoints. Access and refresh tokens are
never returned to app JavaScript.

For public HTTPS, the broker enforces method, exact origin, bounded same-origin
redirects, public DNS resolution, approved-address pinning, TLS verification,
header stripping, credential injection, byte limits, and deadlines. For numeric
loopback HTTP, it bypasses DNS, connects only to the declared address and port,
rejects redirects, permits anonymous auth only, and applies the same method,
header, byte, and deadline controls. Direct renderer networking remains off in
both cases.

## Storage and Space files

Every installed app has bounded, machine-local JSON storage physically keyed by
Tenant and Data Namespace and self-describing its Runtime Instance and Feature
Installation owner. The default limits are 5 MiB, 512 keys, 128 KiB per value,
and bounded atomic transactions with revision checks. The schema-1 Space/app
store is adopted exactly once after the host durably establishes those new
identities. Data survives renderer replacement and reviewed updates and is never
placed in the Space. Removing a Development preview purges its namespace.
Uninstalling a release-backed App Instance instead requires an explicit
retain-or-purge choice: retained data loses all live Feature authority and can
be purged later from App Studio. Removing either a source or target Space is
blocked while an active App Instance still depends on it. A retain choice also
keeps the source Space registered until its Project's retained data is purged;
the former target is no longer required.

Active visible UI may subscribe to bounded `storage.onChanged` invalidation
hints. The host coalesces keys, caps the list (falling back to `reset: true`),
and emits at most ten times per second. Hints are briefly coalesced in memory,
never durably queued or replayed, and are never delivered to workers, inactive
or occluded views, minimized windows,
or a view owned by another Space. Apps re-read storage after a hint; event data
is not a second state channel.

A file declaration grants nothing by itself. In Assistant tools, the person maps
it to a relative file or folder inside that app's Space. The sandbox sends only
the grant id and a grant-relative path; the host derives Runtime Instance,
Feature Installation, exact revision, current authority, and the selected root.
The broker rejects absolute paths, traversal, links and
junction escapes, alternate data streams, `.workspace`, `.pi`, oversized
operations, and authority beyond the declaration. Writes are atomic and create
a targeted History checkpoint. Revocation or a digest update stops current app
hosts and removes the grant; uninstall never deletes or rewrites Space files.

## Review and lifecycle

The primary path starts in a Space Chat. The host-owned `propose_space_app`
tool accepts only a Space-relative package folder, inspects it, and creates a
machine-local review receipt bound to that Space, Chat, source path, and digest.
The tool cannot execute or install code, grant a destination, or collect a
credential. Its model-facing guidelines include the complete package, bridge,
worker, permission, storage, file, tab, automation, and OAuth declaration
contract, so app generation does not depend on a source checkout or hidden
Workspace-only skill.

Human approval adds the receipt's exact revision as a Local preview in the
source Space's Development Instance, with network, file, and notification
access off and every automation disabled. Source changes require a new review.
**Assistant tools → Installed → Apps in this Space** manages destination, file,
and notification grants, connections, each automation's schedule and run
history, local data, and removal; advanced
local preview remains a recovery/developer path. A reviewed update preserves
the Feature Installation and Data Namespace but advances the Feature, grant,
connection, and job authority domains; network, file, and notification grants,
connections, and every automation reset. Prior receipts remain immutable
predecessor lineage and are not presented as current-revision runs. Removing or
updating an app stops its UI views and worker before changing staged bytes.

App Studio is a separate Space-bound work tab for moving reviewed previews into
the local release-backed lane. The shipped lifecycle is:

1. Declare or edit one App Project's machine-local title, description, and icon.
   The Project record stays in Workspace application data; no portable Project
   file is written into the Space.
2. Prepare an immutable `workspace-app-release` format-version-2 envelope from
   every current preview. The digest covers App presentation, exact Feature
   artifacts and declarations, dependency inventory, provenance, and inspection
   evidence. The verified canonical envelope is stored durably by digest.
3. Separately publish the prepared Release. Publication revalidates the source
   Feature stamps and only marks the Release eligible for local installation; it
   does not upload, host, sign, list, or grant anything.
4. Prepare installation into one chosen registered Space, then activate the
   persisted operation. Activation re-verifies and stages the closure before a
   single registry commit creates a new App Runtime Instance, Feature
   Installation ids, and Data Namespace ids. Preview state never transfers and
   every external power starts off.
5. Prepare an update or rollback to another published Release, review the
   deterministic per-Feature continuity/reset plan, then activate it. The host
   recomputes the durable plan and verifies the active Release before fencing
   the old runtime and committing the new pointer. Exact unchanged content may
   retain eligible authority; changed content keeps the Feature/Data lineage but
   resets grants, connections, jobs, and current-revision run state.
6. Uninstall the whole App Instance with an explicit data disposition. Purge
   queues namespace deletion; retain detaches the namespace from all execution
   and exposes a later explicit purge action. Project source and separately
   selected ordinary Space files are never deleted.
7. Delete an individual Release only after it is unused. The host refuses while
   an active App Instance, either side of a prepared install/update/rollback, or
   retained-data lineage still references it. Registry deletion commits before
   safe object pruning, and interrupted pruning is retried.

The current local host admits at most one App Instance for a `(projectId,
target Space)` pair and rejects installation when any preview or App in the
target already owns one of the Release's Feature ids. It also rejects Release
Features with a data schema or migrations; migration execution and retained-data
adoption are future management operations. Install and update preparations
survive restart until activated or cancelled.

The canonical Release store has a four-GiB aggregate byte quota in addition to
per-envelope and object-count bounds. A new put measures owned regular-file
bytes before it creates the digest directory; retrying an already verified
digest stays idempotent even at the quota. Startup verifies every closed object
once, passes compact verified projections into registry and staged-package
validation before pruning orphans, and rechecks filesystem snapshots around the
deletion boundary. Directory enumeration stops at the declared object bounds.
After validation, a transient physical lock on an orphan is recorded as pending
cleanup and retried without blocking startup; referenced, canonical, path, and
snapshot failures still fail closed.

Persisted automations are inert when the service is constructed. The owning
Local API starts them exactly once, after durable Space-removal recovery, and
keeps every still-pending Space excluded for that service lifetime.

Authority is rechecked at effect time, including immediately before an external
fetch and before atomic storage or Space-file commits. Persistent connections
are bound to Tenant, Runtime Instance, Feature Installation, exact Feature
revision, declaration digest, target identity, and the current Runtime Instance
owner. The portable contract also defines future Principal-owned connection
consent and unattended delegation, but the version-2 local product does not
offer that path. The old Space/app connection schema fails closed and requires
reconnection because it cannot prove the stronger identities. All legacy
bindings remain disconnected; the first explicit reconnect replaces the legacy
store and discards its ambiguous bindings.

New automation receipts capture the accepting Tenant, Runtime Instance,
Feature Installation, canonical Feature Revision, Data Namespace, effective
Principal, seven-domain authority, occurrence, attempt, state, and acceptance
time without storing worker inputs, outputs, file contents, request bodies, or
credentials. Receipts imported from the older registry remain explicitly
`legacy-unverified`; Workspace does not invent authority facts that were never
recorded. The host persists an installation-independent `accepted` receipt
before starting worker execution and later terminalizes that run by its durable
run id, even if update or removal has already detached the installation.
On startup, any receipt left only in `accepted` state is reconciled to an
`interrupted` outcome and `expired` state with an explicit warning that the
completion of external effects is unknown; Workspace never reports a guessed
success, failure, or cancellation.
The registry has the same 5 MiB bound on write and read. Each automation
acceptance preflights enough space for every currently accepted run to become a
worst-case terminal receipt, so a successful admission cannot create a result
that the persistence format has no room to record.

Update, removal, and permitted Space-removal registry transitions durably record every
required credential, storage, and staged-package cleanup before making the old
authority unreachable. Cleanup is idempotent and retried at startup and before
later mutations. A cleanup failure therefore cannot reactivate an installation
or make an already-committed authority change appear to have failed.

Removing a source Space is blocked while its Project has any active local App
Instance or retained data; removing a target Space is blocked only while an App
Instance is attached there. Workspace requires the whole App Instance to be
uninstalled first so a Space-removal shortcut cannot silently choose a data
disposition. After explicit purge, source removal clears the machine-local App
Project and Release lineage. Target removal cancels unactivated operations
prepared for that Space.

The restricted app itself appears directly in the contributed rail. Selecting
it mounts its navigator; the app decides which persistent work tabs to open.
This is not a `surface.json` contribution. `surface.json` remains the separate,
static compatibility lane for full-trust Pi Extensions.

## Remaining host capabilities

The web canvas and tab model are intentionally general; new product powers
should be narrow host services rather than additions to a fixed widget schema.
The main gaps are:

- host-owned remote subscriptions and arbitrary push adapters (static reviewed
  automation notifications are available);
- a Space-service registry that can verify process ownership and lifecycle,
  replacing raw loopback-port grants for managed project services;
- reviewed schema/migration execution, retained-data adoption and export, and a
  portable Project import/collision model; and
- finer resource controls for long-running or memory-heavy web apps.

A verified Space-service target is deliberately not exposed yet. An honest
implementation needs a trusted Workspace launcher/process authority outside the
renderer and local API, per-instance secret challenge, and generation-aware
lifecycle. Treating any listener on a reviewed port as owned would only rename
the existing raw-loopback limitation.

Chromium still carries browser-engine exploit and denial-of-service risk.
Electron updates, sender validation, package review, and the real-runtime probe
remain release requirements.
