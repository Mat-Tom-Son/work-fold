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
  that automation records its remote result and may select the separately
  granted `inbox-refresh-finished` notification.
- Network calls and tab creation go through the narrow
  `workFoldRestrictedApp` bridge; the app has no Node, filesystem, process,
  or direct network access. Search and automation status use the host
  storage bridge, active visible UI re-reads after bounded invalidation hints,
  and service exports use a separately granted Space folder plus History
  safety.

The normal generated-app path begins in a Space Chat: the Assistant writes the
completed Space-relative package, proposes it through work-fold's host-owned
tool, and the person reviews and installs the exact digest in that Chat. For
this checked-in developer sample, register the repository as a Space or copy
this directory into one, then use **Capabilities → Installed → Apps in this
Space → Advanced local install**.

The mail endpoint is intentionally non-functional and declares API-key or
bearer authentication. It would need both a destination grant and a host-owned
connection configured in Capabilities; the example contains no real
credential. The local `project-service` destination is anonymous and expects a
service on `127.0.0.1:4317`, but still requires its own destination grant.
Together they demonstrate that installing an app grants nothing. work-fold
verifies the loopback address and port, but this version does not verify
process ownership.

## Hands-on local service

From the repository root, start the dependency-free demo service in an
ordinary terminal:

```powershell
node examples/services/restricted-app-demo-service.mjs
```

It binds only `127.0.0.1:4317` and implements `GET /health` plus
`POST /jobs/refresh`. Allow **project-service** for this app in Capabilities,
open **Project service**, then use **Check health** or **Run refresh job**.

This helper is an ordinary developer process outside the restricted app
package. work-fold and the sandboxed app do not execute, install, stop, or
trust it. work-fold verifies only the reviewed numeric loopback address and
port before brokering a request; it does not verify that this particular
process owns the port. Stop the helper from its terminal when testing is done.

Notifications are separately off after installation. If allowed, they can be
shown only during an enabled automation run while work-fold is running, using
the exact title and body reviewed in `agent-app.json`; app code cannot supply
dynamic notification copy, actions, or URLs. An explicit **Run now** while the
automation is disabled has no notification authority.

## Hands-on automation

1. Open this app and choose **View all** so its Inbox work tab remains selected
   on the right.
2. Open **Capabilities** on the left, expand this app, enable **Refresh inbox**,
   and choose **Allow notifications** for **Inbox refresh finished**. The
   `mail-api` network grant may remain off.
3. Choose **Run now**. The selected Inbox tab updates its automation-status card
   from a live `storage.onChanged` hint, including the storage revision and the
   honest network outcome. A granted notification is also requested even when
   the fake endpoint is denied or unavailable.
4. If the app view was inactive during the run, return to it to see the same
   durable result loaded from app storage. Invalidation hints are intentionally
   not queued or replayed for inactive views.

Windows can suppress a requested notification through Focus Assist or system
notification settings. The status card distinguishes a host-accepted request
from notification access being off or the Windows notification host failing.
The notification says only that the check finished; it never claims new mail
when the example endpoint could not be reached.

No credential belongs in this directory. Auth declarations describe the
host-owned connection adapters the app accepts; they are never tokens or
client secrets.
