# Connected inbox app example

This package exercises work-fold's dynamic restricted-app runtime: a real
interactive rail navigator, persistent Space-owned tabs, brokered public
HTTPS, a numeric loopback service panel, durable app storage, a reviewed
Space-folder export, an optional worker, a named inbox-refresh automation, and
a reviewed static notification category for completed automation runs.

Use the canonical [Restricted app authoring guide](../../../docs/restricted-app-authoring.md)
for the complete package and bridge contract, and
[Restricted app runtime](../../../docs/restricted-app-runtime.md) for the
security architecture.

- `agent-app.json` declares the app identity, reviewed HTML entry, optional
  worker, tools, schemas, and exact network destinations.
- `index.html`, `styles.css`, and `app.js` form the sandboxed app UI. The same
  code adapts to the rail navigator and app-owned work tabs using
  `workFoldRestrictedApp.context`.
- `worker.js` exposes an Assistant action and the `refresh-inbox` automation;
  that automation records its remote result and may select the declared
  `inbox-refresh-finished` notification while its grant remains enabled.
- Network calls and tab creation go through the narrow
  `workFoldRestrictedApp` bridge; the app has no Node, filesystem, process,
  or direct network access. Search and automation status use the host
  storage bridge, active visible UI re-reads after bounded invalidation hints,
  and service exports use the installed directory permission plus History
  safety. That permission binds to the whole work-folder; app code chooses the
  declared export path.

The normal generated-app path begins in a work-folder Chat: the Worker writes
the completed folder-relative package and installs the digest-pinned preview
through work-fold's host-owned tool. The act executes once and leaves a receipt.
For this checked-in developer sample, register the repository as a work-folder or copy
this directory into one, then run
`work-fold apps install-preview --space <id-or-name> --package examples/packages/restricted-connected-inbox`
(adjust the folder-relative path if copied). Settings → Apps shows the installed
preview, its declared powers, and the receipt.

The mail endpoint is intentionally non-functional and declares API-key or
bearer authentication. Its destination is granted by installation, but a
host-owned connection still needs the person's secret entry in Settings → Apps;
the example contains no real credential. The local `project-service`
destination is anonymous and expects a service on `127.0.0.1:4317`.
Installation grants both destinations, the declared whole-work-folder directory
permission, and the notification category, and enables **Refresh inbox**.
The person can narrow those powers in Settings → Apps. work-fold
verifies the loopback address and port, but this version does not verify
process ownership.

## Hands-on local service

From the repository root, start the dependency-free demo service in an
ordinary terminal:

```powershell
node examples/services/restricted-app-demo-service.mjs
```

It binds only `127.0.0.1:4317` and implements `GET /health` plus
`POST /jobs/refresh`. Confirm **project-service** remains enabled in Settings → Apps,
open **Project service**, then use **Check health** or **Run refresh job**.

This helper is an ordinary developer process outside the restricted app
package. work-fold and the sandboxed app do not execute, install, stop, or
trust it. work-fold verifies only the reviewed numeric loopback address and
port before brokering a request; it does not verify that this particular
process owns the port. Stop the helper from its terminal when testing is done.

The declared notification category is enabled by installation. While allowed, it can be
shown only during an enabled automation run while work-fold is running, using
the exact title and body reviewed in `agent-app.json`; app code cannot supply
dynamic notification copy, actions, or URLs. An explicit **Run now** while the
automation is disabled has no notification authority.

## Hands-on automation

1. Open this app and choose **View all** so its Inbox work tab remains selected
   on the right.
2. Open **Settings → Apps** and inspect this app. **Refresh inbox** and
   **Inbox refresh finished** begin enabled. Revoke `mail-api` access if you
   want to test a denied network result; the endpoint is otherwise fake and
   still has no configured credential.
3. Choose **Run now** and inspect its receipt. A granted notification is also
   requested even when the fake endpoint is denied or unavailable.
4. Return to the Inbox tab to see the durable result loaded from app storage.
   For a scheduled run while Inbox is active, its status card updates through
   a live `storage.onChanged` hint. Hints are not queued for inactive views.

Windows can suppress a requested notification through Focus Assist or system
notification settings. The status card distinguishes a host-accepted request
from notification access being off or the Windows notification host failing.
The notification says only that the check finished; it never claims new mail
when the example endpoint could not be reached.

No credential belongs in this directory. Auth declarations describe the
host-owned connection adapters the app accepts; they are never tokens or
client secrets.
