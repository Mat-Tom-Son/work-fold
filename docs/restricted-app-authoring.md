# Restricted app authoring

This is the canonical package and bridge reference for Space apps that run in
Workspace's restricted web runtime. Read [Restricted app runtime](restricted-app-runtime.md)
for the security architecture, lifecycle boundaries, and remaining host gaps.
The App Studio and release-backed runtime behind this surface are documented in
[App platform foundation](app-platform-foundation.md). A version-2 package is a
reviewed Feature in either a Development preview or an immutable Release; its
authoring and bridge contract does not change between those placements.

Restricted apps are not native Pi Extensions. They are prebuilt HTML, CSS, and
JavaScript packages that Workspace inspects without evaluation, pins to an
exact content digest, and runs in separate sandboxed Chromium hosts. Never add
`pi.extensions` or install one through Pi's package manager.

The checked-in [Connected inbox](../examples/packages/restricted-connected-inbox/README.md)
is the reference implementation. The separate
[full-trust Connected inbox](../examples/packages/connected-inbox/README.md)
shows the native Pi Extension lane and is intentionally not a sandbox example.

## Normal creation and installation

The normal product path begins in a Chat belonging to the target Space:

1. Ask the Assistant to build the app. It writes a complete package into an
   ordinary visible folder inside that Space.
2. The Assistant calls the host-owned `propose_space_app` tool with only the
   Space-relative package folder.
3. Workspace inspects the package without running JavaScript, computes its
   digest, and creates a review bound to the Space, Chat, source folder, and
   exact bytes.
4. Review and add that digest in the owning Chat as a **Local preview** in
   the Space's Development Instance. Proposal does not add a preview, grant a
   permission, or collect a credential.
5. Manage the preview under **Capabilities → Installed → Apps in this
   Space**. Network destinations, file targets, notification categories,
   connections, and each named automation are separate controls.

**Advanced local preview** in that Capabilities section is the developer and
recovery path for a completed package already inside the current Space. It
does not replace the Chat-bound proposal and review flow for agent-created
apps.

## From preview to an installed App

Use **Open App Studio** when the reviewed preview is ready to install as an App:

1. Declare or edit the App Project title, description, and icon. In 0.4 these
   fields and `projectId` are machine-local Workspace state; do not create or
   depend on `.workspace/app-project.json`.
2. Prepare a Release with a display version. Workspace snapshots every reviewed
   preview in that Development Instance, so use stable, unique Feature ids and
   finish each package review first.
3. Review the immutable digest and publish it as a separate local action. If any
   preview changed since preparation, publishing fails and a new Release must be
   prepared.
4. Choose a registered target Space, prepare the install, then activate it. The
   target cannot already contain a Development preview or installed App Feature
   with the same id, and only one instance of this Project can be attached to
   that Space.
5. Configure the Installed Release's destinations, file roots, notifications,
   connections, and named automations in Capabilities. None transfer from the
   preview and all begin off.

The v2 Release is a closed local artifact: it contains the prebuilt package
bytes and declarations rather than a source-folder pointer or ambient Pi
dependency. “Publish” does not upload, host, sign, sync, or list it. Executable
bytes, mutable data, grants, connections, schedules, operation journals, and
receipts stay in Workspace application data even though the App is attached to
the chosen Space for navigation and file-grant selection.

App Studio can prepare an update or rollback to any other published Release from
the same Project. Exact unchanged Features may keep eligible authority; a
changed Feature keeps its installation and data namespace but resets grants,
connections, and jobs. The current local runtime rejects data schemas and
migrations, so this package format must continue to rely on backward-compatible
JSON storage until reviewed migration execution is implemented. Uninstall
requires retaining or purging App data; retained namespaces are inactive and
can only be purged later in 0.4.

## Package layout

A small package can remain dependency-free:

```text
my-space-app/
├── package.json
├── agent-app.json
├── index.html
├── app.js
├── styles.css
└── worker.js       # required for tools, automations, or notifications
```

`package.json` identifies the data-only manifest and declares ESM:

```json
{
  "name": "my-space-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "agentApp": "agent-app.json"
}
```

Workspace requires `name`, `version`, `type: "module"`, and `agentApp`. It
rejects package `scripts`, `bin`, `workspaces`, `gypfile`, and `pi` fields.
Dependency metadata may describe the toolchain that produced the assets, but
Workspace never runs npm or installs those dependencies. Bundle every runtime
asset into the reviewed directory before proposing it. Package roots and files
must be ordinary files and directories, not links or junctions.

The package limits are 2,048 files, 50 MiB total, 20 MiB per file, a 512 KiB
app manifest, and 24 directory levels. `package.json` is limited to 64 KiB.

## Complete manifest template

`agent-app.json` is closed and versioned; unknown fields fail review. This
template exercises every current section:

```json
{
  "version": 2,
  "id": "my-space-app",
  "title": "My Space app",
  "description": "A Space-bound app with a connected service.",
  "runtime": {
    "kind": "sandboxed-web",
    "entry": "index.html",
    "worker": "worker.js"
  },
  "ui": {
    "icon": "mail"
  },
  "tools": [
    {
      "name": "search_records",
      "description": "Search records in the connected service.",
      "action": "search",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "maxLength": 500 }
        },
        "required": ["query"],
        "additionalProperties": false
      },
      "resultSchema": {
        "type": "object",
        "properties": {
          "count": { "type": "integer", "minimum": 0 }
        },
        "required": ["count"],
        "additionalProperties": false
      }
    }
  ],
  "automations": [
    {
      "id": "refresh-records",
      "title": "Refresh records",
      "description": "Fetch and store the latest record summary.",
      "handler": "refresh-records",
      "trigger": {
        "kind": "interval",
        "intervalMinutes": 30
      },
      "permissions": {
        "network": ["records-api"],
        "files": [],
        "notifications": ["refresh-finished"]
      },
      "catchUp": "latest",
      "overlap": "skip"
    }
  ],
  "permissions": {
    "network": [
      {
        "id": "records-api",
        "target": {
          "kind": "public-https",
          "origin": "https://api.example.com"
        },
        "methods": ["GET", "POST"],
        "requestHeaders": ["x-api-version"],
        "auth": [
          { "kind": "api-key", "header": "x-api-key" },
          { "kind": "bearer" }
        ]
      },
      {
        "id": "project-service",
        "target": {
          "kind": "loopback-http",
          "host": "127.0.0.1",
          "port": 4317
        },
        "methods": ["GET", "POST"],
        "auth": [{ "kind": "none" }]
      }
    ],
    "files": [
      {
        "id": "exports",
        "target": "directory",
        "access": "read-write"
      }
    ],
    "notifications": [
      {
        "id": "refresh-finished",
        "title": "Refresh finished",
        "description": "The records refresh automation finished. Open Workspace to review the result."
      }
    ]
  }
}
```

Manifest ids use lowercase letters, numbers, and hyphens. `ui`, `tools`, and
`automations` are required even when they are empty (`{}`, `[]`, and `[]`).
`permissions.network` is also required and may be empty; `files` and
`notifications` may be omitted and then normalize to empty arrays. Tool names
may additionally use underscores.

The supported tool-schema subset contains `object`, `array`, `string`,
`number`, `integer`, `boolean`, and `null`, with closed properties, required
keys, one `items` schema, scalar enums, and the declared string, number, and
array bounds. Open-ended or executable schema features are rejected. A worker
is required when `tools` is nonempty.

An app may declare up to sixteen automations. Each automation has a unique id,
reviewed title, optional description, handler id, an interval from 15 through
1,440 whole minutes, `catchUp` set to `none` or `latest`, and `overlap` set to
`skip`. Its `permissions` object is required, all three arrays are required,
and every id must reference an app-level declaration. This is an exact maximum
for that job: launch-time authority is the intersection of this subset and the
person's current grants. Automations require a worker. Every notification
declaration must be referenced by at least one automation. Notification title
and description are reviewed, bounded, plain single-line text.

Network methods are limited to `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.
Public targets are exact HTTPS origins. Loopback targets are numeric
`127.0.0.1` or `::1` addresses and cannot receive credentials or follow
redirects. A public destination resolving to several addresses may try `GET`
requests in resolver order, so a dual-stack service stays reachable from a
single-stack network; every candidate has already passed the same
public-address check. Mutating requests use one approved address only because
retrying after an ambiguous connection failure could apply the same operation
twice.

A request may always set `accept`, `content-type`, `if-modified-since`, and
`if-none-match`. Anything else must be named in that destination's optional
`requestHeaders` array, which is reviewed with the rest of the package. Header
names are lowercase, at most 16 per destination, and may not be routing,
hop-by-hop, or credential-bearing names such as `authorization`, `host`,
`cookie`, `content-length`, `transfer-encoding`, or `x-forwarded-*`. A
destination may not name the header its own `api-key` credential occupies, and
a header reviewed for one destination grants nothing to another.

## Visible UI and content policy

The HTML entry runs with Node disabled and direct networking, navigation,
popups, downloads, dialogs, permissions, workers, frames, service workers, and
file selection denied. Scripts and fonts must come from reviewed same-origin
files. Styles may be same-origin or inline; images may be same-origin or
`data:`. Bundle browser libraries and assets into the package instead of using
a CDN. Use the host bridge for network and Space files.

The preload exposes one frozen global:

```js
const bridge = globalThis.workspaceRestrictedApp;
```

Bridge values and requests must be JSON-compatible and bounded. Do not pass
functions, DOM nodes, cyclic objects, secrets, or host identity fields.

### Context and placement

```js
let context = bridge.context.get();

const unsubscribe = bridge.context.onChanged((next) => {
  context = next;
  document.documentElement.dataset.theme = next.theme;
  render();
});
```

Context contains host-owned `workspaceId`, `appId`, `digest`, and `mountId`,
plus `placement` (`navigator` or `tab`), nullable `appTabId`, origin-relative
`route`, JSON `state`, `theme` (`light` or `dark`), and `active`. Treat identity
as descriptive; the host derives authority from the sending renderer, never
from values supplied back by app code. One UI entry can branch on placement and
route to render a compact left navigator and full work-tab views.

### Space-owned tabs

```js
await bridge.tabs.open({
  tabId: "record:123",
  title: "Record 123",
  route: "/records/123",
  state: { recordId: "123" },
});

// These are valid only from the currently mounted app tab.
await bridge.tabs.update({ title: "Record 123 · edited", route: "/records/123", state: { dirty: true } });
await bridge.tabs.close();
```

`tabId` is app-local and stable; it may use lowercase letters, numbers,
periods, underscores, colons, and hyphens. Routes must begin with one `/` and
remain origin-relative. State is JSON-compatible and limited to 64 KiB. The
app never supplies a Space id, digest, or shell tab id. Opening an existing
app-local id activates or retargets its Space-owned tab.

### Brokered network requests

`bridge.request` and `bridge.network.request` are aliases:

```js
const response = await bridge.request({
  destinationId: "records-api",
  method: "POST",
  path: "/v1/search",
  headers: {
    accept: "application/json",
    "content-type": "application/json"
  },
  body: JSON.stringify({ query: "quarterly" }),
});

if (response.encoding !== "utf8") throw new Error("Expected text");
const value = JSON.parse(response.body);
```

Requests name a reviewed destination, allowed method, and origin-relative
path. `GET` and `DELETE` cannot include a body. Request bodies default to a
128 KiB limit; responses default to 256 KiB and a 15-second deadline. App-set
headers may use `accept`, `content-type`, `if-modified-since`, and
`if-none-match`. A destination may also accept the exact additional names in
its reviewed `requestHeaders` declaration. The response contains `status`, a
small safe header map, `body`, and `encoding` (`utf8` for recognized text
types, otherwise `base64`). The host injects credentials after validation; app
code never sets or reads an authorization secret.

### App storage and invalidation hints

Storage is machine-local and keyed by Space and app id:

```js
const usage = await bridge.storage.usage();
const keys = await bridge.storage.keys("record:");
const current = await bridge.storage.get("record:123"); // undefined when absent

await bridge.storage.set("record:123", { title: "Quarterly" });
await bridge.storage.delete("record:old");

await bridge.storage.transaction({
  expectedRevision: usage.revision,
  set: [{ key: "record:123", value: { title: "Quarterly" } }],
  delete: ["record:old"],
});
```

`set`, `delete`, `clear`, and `transaction` return usage metadata plus
`changed` and `changedKeys`. Transactions may use `expectedRevision` for
optimistic concurrency and may also set `clear: true`. Values must be ordinary
JSON. Default limits are 5 MiB per app, 512 keys, 128 KiB per value, and 128
operations or 160 KiB per transaction.

Only active visible UI receives invalidation hints:

```js
bridge.storage.onChanged(async (event) => {
  if (!event.reset && !event.keys.includes("last-refresh")) return;
  const latest = await bridge.storage.get("last-refresh");
  renderRefresh(latest, event.revision);
});
```

The event contains `revision`, bounded `keys`, and `reset`. Hints are
coalesced, are not state themselves, and are never queued or replayed for an
inactive, occluded, minimized, or worker view. Always re-read storage. Also
read required state during startup because the view may have missed a hint.

### Granted Space files

A manifest file declaration is only a maximum request. The person maps it to
an ordinary relative file or directory in that app's Space before use:

```js
const listing = await bridge.files.list({ grantId: "exports", path: "." });
const previous = await bridge.files.read({ grantId: "exports", path: "report.json", encoding: "utf8" });
const written = await bridge.files.write({
  grantId: "exports",
  path: "report.json",
  encoding: "utf8",
  data: JSON.stringify({ ok: true }, null, 2),
  mode: "replace",
});
```

`list` returns `{ path, entries, truncated }`; entries contain `name`, `path`,
`kind`, optional `sizeBytes`, and `modifiedAt`. `read` returns `{ path,
encoding, data, sizeBytes, modifiedAt }`. `write` returns `{ path, sizeBytes,
modifiedAt }` and requires explicit `create` or `replace` mode. Data may be
`utf8` or `base64`. Default read and write limits are 512 KiB and listings are
limited to 200 entries. Every write is atomic and creates a targeted History
checkpoint. Grant-relative paths cannot traverse links, metadata roots, or the
selected Space target.

## Worker tools and automations

The optional worker is a separate hidden sandbox. It has the same bridge name,
Node denial, direct-network denial, and host-derived authority as visible UI.
It cannot manipulate visible tabs. Export `handleAction` for declared tools and
`handleAutomation` when the manifest declares one or more automations:

```js
export async function handleAction(action, input) {
  if (action !== "search") throw new Error("Unknown action.");
  const response = await globalThis.workspaceRestrictedApp.request({
    destinationId: "records-api",
    method: "GET",
    path: `/v1/records?query=${encodeURIComponent(input.query)}`,
    headers: { accept: "application/json" },
  });
  const value = JSON.parse(response.body);
  return { count: Number.isInteger(value.count) ? value.count : 0 };
}

export async function handleAutomation(event) {
  if (event.automationId !== "refresh-records" || event.handler !== "refresh-records") {
    throw new Error("Unknown automation.");
  }
  let network;
  try {
    const response = await globalThis.workspaceRestrictedApp.request({
      destinationId: "records-api",
      method: "GET",
      path: "/v1/records?limit=20",
      headers: { accept: "application/json" },
    });
    network = { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch (error) {
    network = { ok: false, code: error?.code || "NETWORK_FAILED" };
  }

  let notification;
  try {
    notification = await globalThis.workspaceRestrictedApp.notifications.show({
      permissionId: "refresh-finished",
    });
  } catch (error) {
    notification = { status: "not-shown", code: error?.code || "NOTIFICATION_FAILED" };
  }

  await globalThis.workspaceRestrictedApp.storage.set("last-refresh", {
    reason: event.reason,
    scheduledAt: event.scheduledAt,
    completedAt: new Date().toISOString(),
    network,
    notification,
  });
}
```

Tool inputs and results are checked against the manifest schemas and limited
to 256 KiB. Worker invocations default to a five-second deadline. Automation
events contain `runId`, `automationId`, `handler`, `reason` (`scheduled`,
`manual`, or `resume`), and ISO `scheduledAt`. Treat `automationId` and
`handler` as the reviewed dispatch pair and reject unknown values.

Every automation installs disabled. Enabling one schedules only that job while
Workspace is running. One scheduler is shared across all Spaces and apps, with
a two-run global limit, FIFO admission, same-job non-overlap, and at most one
staggered latest catch-up when requested. **Run now** is a one-off execution:
it works while the schedule is disabled and does not move the recurring
cadence. Every attempt receives a durable receipt visible in Capabilities.

At launch, the worker sees only current app grants also named by that
automation's `permissions` subset. `notifications.show({ permissionId })`
works only inside an enabled automation invocation and only for a separately
granted category included in that job. A manual run of a disabled automation
therefore cannot notify. The method returns a
status of `shown`, `rate-limited`, or `unsupported`. The host supplies the
reviewed title and description; the worker cannot add dynamic text, actions,
or URLs. Notification failure should not discard already completed work. Use
copy such as “refresh finished” when the result may be either success or
failure.

## Authentication declarations

Authentication describes what host-owned connection setup the destination
accepts. It never contains a credential:

| Kind | Manifest shape | Host behavior |
|---|---|---|
| None | `{ "kind": "none" }` | No connection is stored. It must be the destination's only auth declaration and is the only kind allowed for numeric loopback. |
| API key | `{ "kind": "api-key", "header": "x-api-key" }` | Capabilities collects the value and the broker injects it through the reviewed non-sensitive header name. |
| Bearer | `{ "kind": "bearer" }` | Capabilities stores the token and the broker writes `Authorization: Bearer …`. |
| Basic | `{ "kind": "basic" }` | Capabilities stores username/password and the broker creates the Basic authorization header. |
| OAuth PKCE | `{ "kind": "oauth2-pkce", "issuer": "https://identity.example.com", "clientId": "public-native-client", "scopes": ["records.read"] }` | Workspace performs public-issuer discovery, S256, system-browser authorization, one-shot loopback callback, encrypted storage, and refresh. |

A public destination may accept multiple credential kinds, but `none` cannot
be combined with another kind. OAuth requires a client id registered with a
public HTTPS issuer that supports public clients without a client secret, plus
scopes that exclude `openid`. Workspace cannot verify who owns that client
registration. Client secrets, device-code flow, and package-supplied
authorization or token endpoints are rejected. Connections are configured per
exact Feature revision and reviewed destination in Capabilities. The host also
binds each secret to its Tenant, Runtime Instance, Feature Installation,
declaration digest, target identity, and current Runtime Instance owner. The
portable contract reserves Principal-owned connection consent and job delegation
for a future product path; version-2 local apps cannot request it. There is no
connection or secret-reading bridge.

## Default-off lifecycle and denial handling

Adding a reviewed digest as a Development preview, or installing a published
Release Feature, makes its UI available but leaves network, file, and
notification grants off, stores no connection, and leaves every automation
disabled. Storage is available without an external-power grant. A direct
preview update preserves the Feature's Data Namespace but resets destination
grants, file grants, notification grants, connections, and automation state. A
Release update uses App Studio's persisted continuity plan: only an exact
unchanged revision can be eligible to retain those powers; changed revisions
reset them while preserving installation/data lineage. Historical
run receipts remain predecessor audit lineage while the new revision's run view
starts empty. New receipts bind the accepting Tenant, Runtime Instance, Feature
Installation, canonical revision, Data Namespace, effective Principal,
seven-domain authority, occurrence, and attempt; imported older receipts are
explicitly `legacy-unverified`. Removing a Development preview purges its app
storage and connections. Uninstalling a release-backed App Instance removes its
connections and makes its data unreachable in the same registry transition,
then either retains the detached namespace or queues its physical purge as
explicitly chosen. Cleanup is idempotent after interruption and never deletes
Space files. Source edits do not change preview or Release bytes; propose and
review a new digest.

Bridge promises reject an `Error`; host failures expose a stable enumerable
`error.code`. Handle denial as visible product state rather than retrying or
asking for secrets inside the app:

```js
try {
  await bridge.request({ destinationId: "records-api", method: "GET", path: "/v1/records" });
} catch (error) {
  if (error?.code === "NETWORK_DENIED") showStatus("Allow this destination in Capabilities.");
  else if (error?.code === "AUTH_REQUIRED") showStatus("Connect this destination in Capabilities.");
  else showStatus(error?.message || "The connection is unavailable.");
}
```

Common codes are:

- network: `NETWORK_DENIED`, `AUTH_REQUIRED`, `NETWORK_FAILED`;
- files: `FILE_DENIED`, `FILE_NOT_FOUND`, `FILE_CONFLICT`, `FILE_TOO_LARGE`,
  `FILE_FAILED`;
- storage: `STORAGE_INVALID`, `STORAGE_QUOTA`, `STORAGE_CONFLICT`,
  `STORAGE_CORRUPT`, `STORAGE_UNSAFE`, `STORAGE_FAILED`;
- notifications: `NOTIFICATION_DENIED`, `NOTIFICATION_FAILED`; and
- worker/tool lifecycle: `ACTION_UNKNOWN`, `INPUT_INVALID`, `OUTPUT_INVALID`,
  `APP_TIMEOUT`, `APP_CRASHED`, `APP_ERROR`, `APP_UNAVAILABLE`, and
  `REVISION_CHANGED`.

Do not repeatedly retry a denied power, infer that a declaration is a grant,
or collect credentials in app UI or storage. Provide useful local or demo state
when the external system is optional.

## Run the checked-in local demo

The Connected inbox package includes a project-service panel. To test it:

1. Register this repository as a Space, or copy
   `examples/packages/restricted-connected-inbox` into an ordinary folder in a
   registered Space.
2. Add that Space-relative package as a Local preview through **Advanced
   local preview**.
3. From the repository root, start the companion process:

   ```powershell
   node examples/services/restricted-app-demo-service.mjs
   ```

4. In Capabilities, allow the app's **project-service** destination.
5. Open the app's **Project service** tab and use **Check health** or **Run
   refresh job**.

The helper is an ordinary dependency-free developer process that binds only
`127.0.0.1:4317`. Workspace and the sandboxed app do not execute, install,
stop, or trust it. The loopback broker verifies the reviewed address and port,
not which process owns the listener. See the
[example README](../examples/packages/restricted-connected-inbox/README.md)
for the storage-invalidation and static-notification walkthrough.

## Verification and related contracts

- Run `npm run check` and `npm test` after TypeScript or product behavior
  changes.
- Run `npm run desktop:prepare` after changing the sandbox host, preload,
  brokers, Electron integration, or packaged runtime resources. Its real
  Electron probe is a release boundary, not a substitute for Node-only tests.
- Keep [Security](../SECURITY.md), [Privacy](../PRIVACY.md),
  [Product model](product-model.md), [Assistant capabilities](assistant-capabilities.md),
  and [Architecture](architecture.md) aligned when authority or lifecycle
  changes.
- Keep native Pi `surface.json` work in the separate
  [Extension surfaces](extension-surfaces.md) contract.
