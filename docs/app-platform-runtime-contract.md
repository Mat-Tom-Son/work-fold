# App platform runtime contract exploration

> **Status:** Accepted Gate 4 semantic contract
>
> **Purpose:** Define the portable feature-runtime broker semantics that preserve
> the same product authority across the local Electron host and a hosted web
> adapter.
>
> **Authority:** [Product model](product-model.md) and
> [App platform foundation](app-platform-foundation.md) are normative. Operations
> and shapes labeled candidate are not a public API commitment until versioned
> code and conformance fixtures implement them.

This document is a companion to
[App platform exploration](app-platform-exploration.md). It authorizes the
bounded implementation order in the foundation; it does not silently change
`agent-app.json`, expose a cloud mutation API, or weaken the existing
restricted-app boundary.

## Contract objective

A reviewed feature should be able to render views, use bounded data and external services, expose actions, and run named jobs without acquiring ambient authority from whichever host happens to execute it.

“Portable” therefore means:

- the same identities, declarations, grant intersections, connection ownership, invocation lineage, denial categories, and receipt semantics;
- a host-resolved effective Principal and discriminated Runtime Instance context that Feature code cannot choose or widen;
- explicit capability discovery when a host does not implement an optional power; and
- honest visibility into host-specific scheduling, quota, delivery, availability, and offline policy.

It does **not** mean that Electron IPC, browser routing, local folders, cloud object storage, Windows notifications, distributed queues, or process isolation must share an implementation.

## Existing baseline

The current desktop runtime already establishes useful constraints:

- reviewed feature bytes are content-addressed and digest-pinned before execution;
- visible UI and hidden action/automation workers run in separate sandboxed Chromium hosts;
- main binds each sender to its Space, app id, digest, lifecycle, placement, and current grants;
- network, storage, Space files, tabs, and notifications are host brokers rather than ambient browser powers;
- storage uses revisions and bounded atomic transactions;
- file writes are grant-relative, atomic, and History-covered;
- secrets stay in a separate encrypted store and are injected only by the network broker;
- each automation begins disabled, runs with the intersection of its reviewed permission subset and current grants, and produces a durable bounded receipt;
- one local scheduler supplies FIFO admission, two machine-wide slots, same-job non-overlap, bounded catch-up, cancellation, and current-authority checks at launch; and
- app-scope runtime generations stop stale launches when an app is updated, removed, or stopped.

Those are strong reference semantics. Fixed byte limits, interval vocabulary, Windows delivery, machine-wide concurrency, in-process timers, and Electron lifecycle are current local policy rather than automatically portable law.

work-fold begins with a new runtime authority domain. Legacy Workspace profiles,
portable `.workspace/` records, registries, storage, connections, receipts, and
artifacts are never imported or adopted by either adapter and cannot authorize
a mount, invocation, grant, data namespace, or effect.

## Vocabulary used in this memo

| Term | Meaning here |
| --- | --- |
| **Feature Revision** | Immutable reviewed feature bytes plus their closed declarations, identified by a digest. |
| **Runtime Instance** | Internal union over exactly two runtime owners: a source-bound, release-less Development Instance or a release-backed App Instance. It is not a user-facing third instance kind. |
| **Development Instance** | A local Runtime Instance bound to one Space and App Project. It runs reviewed Feature Revisions without an App Release. |
| **App Instance** | A release-backed Runtime Instance that may be hosted locally or in the cloud. It always identifies its immutable App Release. |
| **Feature Installation** | One stable runtime incarnation of a Feature inside one Runtime Instance, with its own current revision, grants, connections, jobs, and complete `AuthorityStamp`. A fresh install receives a fresh id; a reviewed update preserves it. |
| **Data Namespace** | Mutable Feature data identity separate from executable installation identity. Retention, export, migration, removal, and purge policy decide whether it survives an installation transition. |
| **Tenant** | The owner of instance policy and shared runtime data. The no-account desktop profile is a valid local tenant. |
| **Principal** | The one effective human, agent, service, or system actor to which an invocation is attributed. Local and cloud are identity realms, not additional Principal kinds. Feature code is an installation identity acting for that Principal, not another Principal. |
| **Declaration** | A reviewed maximum requested by a feature revision. It is never a grant. |
| **Grant** | Current instance policy authorizing one declared power, target, category, or owner class. |
| **Authority stamp** | Host-owned generations and bindings captured for a dispatch and revalidated before effects. It is descriptive to feature code, never a bearer credential. |
| **Occurrence** | One intended scheduled time for a named job. |
| **Attempt** | One execution attempt for an occurrence or manual run. |
| **Receipt** | Durable content-free evidence of an accepted action, job attempt, brokered mutation, or administrative transition. |

User-facing language can remain simpler. These terms exist because security, updates, multi-user data, and retries cannot safely bind to a friendly app title alone.

## Product semantics versus host policy

The portable contract should standardize what a power means and leave resource policy to the host.

| Stable product semantic | Host-specific policy or implementation |
| --- | --- |
| Host resolves tenant, Runtime Instance, feature revision, installation, data namespace, effective Principal, and invocation identity. | Electron sender binding, cloud session/authentication mechanism, worker process/container layout. |
| A declaration is a maximum; effective authority is the intersection with current grants and invocation scope. | Grant UI, organization policy, regional restrictions, plan entitlements. |
| Views use host-owned navigation identity and cannot claim another instance or feature. | Desktop tabs and rail, browser URLs/history, mobile navigation. |
| Storage is namespaced, revisioned, bounded, and supports optimistic transactions. | Local JSON files, database engine, replication, quota amount, retention. |
| Resource access names an approved grant and uses relative or opaque locators below it. | Local filesystem and History, object store, document provider, maximum sizes. |
| Network requests name a reviewed destination and never receive raw credentials. | DNS and address policy, egress proxy, redirect ceiling, regional routing, timeout. |
| Connections have an explicit owner class and consent context. | Operating-system encryption, cloud secret manager, provider adapters, refresh implementation. |
| Named jobs bind intent, declaration identity, authority, occurrences, attempts, and receipts. | Timer service, queue, leases, retry count, concurrency, uptime, cost limits. |
| Cancellation stops future brokered effects and records the observed terminal state. | Process termination grace, queue cancellation mechanism, hard timeout. |
| Notifications select reviewed categories through a separately granted adapter. | Windows notification, web push, email, mobile delivery, rate limits. |
| Stable error categories and codes explain denial and retry posture. | Local diagnostic detail, incident id, regional outage metadata. |

Host policy may be stricter than a release declaration. A feature must degrade visibly when an optional capability or requested limit is unavailable; it must not reach around the broker.

## Runtime boundary

The candidate API is a logical RPC surface, not a commitment to a JavaScript global or transport. For discussion, call it `feature-runtime/v1`.

The host supplies four things:

1. a read-only runtime context;
2. a bounded set of callable broker operations;
3. action and job invocation envelopes delivered to the feature worker; and
4. cancellation, invalidation, and lifecycle events.

The feature supplies only reviewed declaration ids, app-local view ids, relative or opaque resource locators, bounded inputs, and idempotency hints. It never supplies tenant, Runtime Instance, Principal, feature, release, installation, data-namespace, grant, connection-secret, shell-tab, queue, or worker identity.

No operation in this runtime API may install a feature, approve new bytes, widen a grant, save a connection, enable a job, assign a role, publish a release, or deploy an instance. Those are authenticated management-plane mutations with separate review and receipts.

## Common context and envelopes

Every visible mount and worker invocation receives a host-produced context equivalent to the following discriminated Runtime Instance union:

```ts
interface AuthorityStamp {
  runtimeInstanceGeneration: string;
  featureInstallationGeneration: string;
  grantGeneration: string;
  connectionGeneration: string;
  jobGeneration: string;
  principalGeneration: string;
  dataGeneration: string;
}

type RuntimeInstanceContext =
  | {
      kind: "development";
      runtimeInstanceId: string;
      spaceId: string;
      projectId: string;
      connectivity: "online" | "offline" | "degraded";
      authorityExpiresAt?: string;
    }
  | {
      kind: "app";
      runtimeInstanceId: string;
      host: "local" | "hosted";
      releaseDigest: string;
      connectivity: "online" | "offline" | "degraded";
      authorityExpiresAt?: string;
    };

interface RuntimeContext {
  api: {
    major: number;
    minor: number;
    capabilities: string[];
    hostKind: "local-electron" | "hosted-web" | string;
  };
  tenant: { tenantId: string; kind: "local" | "cloud" };
  runtimeInstance: RuntimeInstanceContext;
  feature: {
    featureId: string;
    featureRevisionDigest: string;
    featureInstallationId: string;
    dataNamespaceId: string;
    declarationDigest: string;
  };
  principal: {
    principalId: string;
    kind: "human" | "agent" | "service" | "system";
    realm: "local" | "cloud";
    interactive: boolean;
    delegationId?: string;
    capabilityHints?: string[];
  };
  invocation: {
    invocationId: string;
    kind: "view" | "action" | "job" | "migration";
    startedAt: string;
    receiptId?: string;
  };
  authority: AuthorityStamp;
}
```

The exact wire representation remains open. The invariants do not:

- the host derives every field from trusted state;
- ids are opaque and carry no authority by themselves;
- a remote service re-derives tenant and Principal scope from authenticated state rather than trusting client claims;
- local ids do not silently become cloud identities when an account is linked;
- context values returned by feature code are ignored for authorization;
- sensitive dispatches capture the complete `AuthorityStamp` and every brokered effect revalidates its relevant current fields; and
- wall-clock timestamps explain events but do not replace fencing or ordering.

`capabilityHints` may contain only bounded, non-secret statements useful for rendering controls, such as whether the current Principal is likely allowed to request an action. They are never role records or grants. The host re-evaluates the declared access policy and current Principal immediately before dispatch and every brokered effect.

Visible contexts may additionally include placement, app-local route/state, theme, active/occluded state, locale, and accessibility preferences. None of those fields grant runtime power.

## Views and navigation

Candidate operations:

| Operation | Portable meaning |
| --- | --- |
| `context.get()` | Return the current host-derived context and view placement. |
| `context.onChanged(listener)` | Deliver bounded hints for theme, active state, route/state, connectivity, capability, or authority expiry changes. The feature must re-read state after a hint. |
| `views.open({ viewId, title, route, state })` | Ask the host to create or activate one app-local persistent view in the current instance. |
| `views.update({ title, route, state })` | Update the calling view's host-owned presentation. |
| `views.close()` | Close the calling view. |

Routes remain feature-relative. State is bounded JSON, not an identity or secret channel. The host derives the shell tab, browser route, ownership, back-stack, persistence, and cross-instance activation behavior. Popups, arbitrary top-level navigation, downloads, and file pickers remain unavailable unless later introduced as separate reviewed brokers.

An inactive view may retain in-memory UI state, but view activity is not background execution authority. Interactive-only powers may be denied when a view is hidden, occluded, disconnected, or no longer bound to a live principal.

## Storage

Candidate operations preserve the current revisioned JSON model. Every call names a reviewed `collectionId`; the declaration fixes its ownership class and, for role-shared data, its host-enforced access policy:

- `storage.usage({ collectionId })`
- `storage.keys({ collectionId, prefix })`
- `storage.get({ collectionId, key })`
- `storage.set({ collectionId, key, value, expectedRevision? })`
- `storage.delete({ collectionId, key, expectedRevision? })`
- `storage.clear({ collectionId, expectedRevision? })`
- `storage.transaction({ collectionId, expectedRevision?, clear?, set?, delete? })`
- `storage.onChanged(listener)` for lossy invalidation hints

Each collection declares one ownership class:

- `instance-shared`: shared Feature data owned by the Runtime Instance;
- `principal-private`: private Feature data additionally keyed by the effective Principal; or
- `role-shared`: Runtime-Instance-owned data governed by one declared `accessPolicyId` that identifies the roles allowed to read, create, update, or delete records.

Principal-private and role-shared storage are proposed hosted-capable additions, not shipped desktop behavior. A Feature Revision must declare every collection, ownership class, schema, and role-shared access-policy id it uses. Jobs cannot access Principal-private storage without the owning effective Principal and explicit unattended-use policy.

Portable guarantees:

- the namespace includes tenant, Runtime Instance, and `dataNamespaceId`; Principal-private collections additionally include Principal id;
- a new Feature Installation receives a new `featureInstallationId`, while a reviewed update preserves that incarnation; `dataNamespaceId` remains a separate lifecycle decision and cannot be inferred from either the stable Feature id or installation id;
- role-shared collection reads and mutations re-evaluate the declared access policy against the one effective Principal at the operation and commit boundaries; safe capability hints in context never authorize access;
- values are bounded JSON, revisions increase monotonically within the namespace, and a transaction is atomic within one namespace;
- `expectedRevision` conflicts rather than silently overwriting;
- invalidation is a lossy hint, not a second data stream, and consumers re-read after reconnect or activation;
- a Feature update cannot change the data owner or collection policy merely by retaining a display id; and
- export, migration, retention, deletion, and backup behavior are instance lifecycle contracts outside this method surface.

Hosts choose quotas, persistence engines, consistency outside one namespace, replication, and hint delivery. Cross-namespace transactions and an implication of globally serializable cloud data are deliberately excluded.

## File and object access

Local files and hosted objects should share authority semantics without being disguised as identical storage systems.

A release may request either kind of resource declaration:

| Kind | Locator | Minimum operations |
| --- | --- | --- |
| `tree` | Grant-relative portable path | `list`, `read`, `write`; optional `delete` only if separately declared later |
| `object-collection` | Opaque object key supplied or returned within one collection | `list`, `get`, `put`; optional `delete` only if separately declared later |

Candidate operations live under `resources.tree.*` and `resources.objects.*` rather than one misleading universal filesystem. Every call names a reviewed `grantId`; the host resolves its real local root, object collection, tenancy, access mode, and current generation.

Portable guarantees:

- declarations identify target kind and maximum `read` or `read-write` access;
- grants bind one declaration to one host-selected target and expose only safe descriptive metadata;
- path traversal, link/junction escape, alternate identity roots, and cross-tenant object keys are denied;
- reads and listings are bounded and indicate truncation where applicable;
- writes use explicit `create`/`replace` or revision/entity-tag preconditions and do not silently change kind;
- a successful mutation returns the new revision/entity tag and a receipt id;
- cancellation or revocation is checked before commit; and
- resource contents never become model context, network payload, or another feature's data implicitly.

The Electron adapter maps `tree` grants to ordinary Space-relative files and keeps `.work-fold`, preserved legacy `.workspace`, and `.pi` unavailable; its writes remain atomic and History-covered. A hosted adapter maps grants to a tenant-aware object/document service and records audit lineage. Local History and cloud audit are different host services even when the feature observes the same write result.

A Development Instance may grant selected project files, but publish inputs require visible risk composition and History. When a granted resource mutation commits bytes that are selected publish inputs, the trusted project mutation service must, in one serialized crash-safe transaction, commit the file change, advance the durable project-source generation, invalidate every proposal/review over the prior source generation or digest, and commit its History/receipt metadata before reporting success. A journal or equivalent recovery record must make an interrupted commit complete or fail closed after restart; a successful file write with a still-valid stale publish proposal is forbidden.

A release-backed App Instance must not infer a filesystem merely because its release was built from a folder.

## Network

Candidate operation:

```ts
network.request({
  destinationId,
  method,
  path,
  headers?,
  body?,
  connection: { owner: "instance" | "principal" } | null,
  idempotencyKey?,
})
```

The result contains bounded status, safe response headers, body plus encoding, timing class, and an optional effect receipt id. Feature code never supplies a raw origin, IP address, authorization header, cookie jar, client secret, token, or connection id.

Portable guarantees:

- the destination, methods, authentication modes, and connection owner classes are reviewed declarations;
- the request uses an origin-relative path and a small allowed header set;
- the host enforces current destination grant, invocation scope, connection consent, body/response limits, deadline, redirect policy, and egress policy;
- credentials are injected after validation and never returned to feature code;
- redirects cannot widen the reviewed destination;
- cancellation and authority revocation abort work where possible and deny later effects; and
- a timeout or cancellation does not assert that the remote service observed no request.

Exact public HTTPS origin is the leading portable destination. Numeric loopback is a local Development Instance or locally hosted App Instance policy and is not a hosted-portable destination. A future verified local service needs a host-owned launcher, process-generation identity, and challenge binding before it can claim stronger semantics.

The host may impose stricter destination reputation, regional egress, method, header, redirect, payload, frequency, or cost rules. Features must handle `DENIED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `TIMEOUT`, and `UNAVAILABLE` without asking users to paste secrets into feature UI or storage.

## Instance- and principal-owned connections

Connection setup and revocation remain host UI/control-plane operations. Runtime methods may inspect bounded status but cannot create, read, export, transfer, or broaden a credential:

- `connections.status({ destinationId, owner: "instance" | "principal" })`
- network requests select an allowed owner class, after which the host resolves the exact binding.

An **instance-owned connection** belongs to the Tenant and Runtime Instance and may support unattended jobs when an instance administrator has explicitly bound it and enabled that job.

A **principal-owned connection** belongs to one consenting principal. It may be used only when:

- the invocation's effective principal is that owner; or
- a separately reviewed, time-bounded unattended delegation explicitly names the feature, action/job, destination, scopes, instance, and expiry.

Principal removal, consent withdrawal, provider failure, scope loss, account transfer, and `connectionGeneration` change stop new uses. A Principal-owned connection never silently becomes shared because a job is Tenant-owned. Receipts identify the owner class, bounded destination/declaration id, and effective Principal without exposing secret material, target credentials, tokens, request bodies, or secret references.

Deleting a host binding is distinct from provider-side credential revocation. The product must explain both. Refresh, replacement, disconnect, and role removal must use connection generations so an in-flight callback or token refresh cannot restore stale authority.

### Tenant transfer

Transferring a Runtime Instance to another Tenant is not connection continuity. Before the ownership transition activates, the host advances `runtimeInstanceGeneration`, `connectionGeneration`, `jobGeneration`, and any affected `principalGeneration`; fences workers and queued attempts; revokes unattended delegations; and moves every connection to a visible disconnected-or-pending-rebind state.

- An instance-owned connection is disconnected by default. It may be rebound only through an explicit transfer/rebind flow authorized by both applicable ownership policy and a new-Tenant administrator, with provider-side constraints and the new binding recorded. Possession of the prior encrypted secret reference never authorizes the new Tenant.
- A Principal-owned connection remains owned by that Principal, but is unusable in the transferred Runtime Instance until that Principal is authorized in the new Tenant and explicitly consents to a new instance binding. Otherwise the host disconnects the binding and schedules secret destruction under retention policy.
- No connection changes owner class or Principal owner during transfer. Jobs remain off until their connection, grant, role, and budget dependencies are revalidated under the new Tenant.
- The transfer receipt names the prior and new Tenant ids, effective Principal and authorizer, connection outcomes, before/after `AuthorityStamp`, and provider-revocation status without containing secrets.

Provider-side credential revocation remains a separate operation and receipt even when transfer disconnects every work-fold-held binding.

## Actions

Actions are host-to-worker invocations, not ambient callable tools inside the feature:

```ts
interface ActionInvocation {
  actionId: string;
  input: unknown;
  context: RuntimeContext;
  signal: AbortSignal;
}
```

An action declaration may additionally name a host-enforced `accessPolicyId` defining the Runtime Instance roles allowed to invoke it. The host validates the action declaration, access policy, one effective Principal, and bounded input schema before dispatch, supplies current grants, enforces one or more host concurrency limits, and validates the bounded result schema before returning it. An Assistant action uses an `agent` Principal plus the human-authorized Chat/tool context; an end-user action uses the authenticated interactive `human` Principal. These Principals are not interchangeable. Context capability hints may hide or disable a control, but the host rechecks roles and policy at dispatch and every brokered effect.

The worker executes as the identified Feature Installation on behalf of exactly that one Principal. Feature code, a renderer sender, and a `featureInstallationId` are not additional Principals and cannot become independent action attribution.

Every accepted action receives an invocation/receipt id. The receipt records the effective Principal, optional delegation/authorizer, Feature Installation and revision, authority stamp, times, terminal state, and bounded failure metadata, but not inputs, outputs, credentials, resource contents, or request bodies by default.

## Restricted data migrations

A migration is a separate management-triggered execution class. It is not a view, action, job, app startup hook, install script, or deploy-time build step. Management may dispatch it only from an approved instance update plan after verifying the exact migration and source/target schema records in the immutable release closure.

```ts
interface MigrationInvocation {
  migrationInvocationId: string;
  migrationDigest: string;
  featureId: string;
  featureInstallationId: string;
  dataNamespaceId: string;
  sourceSchema: { schemaId: string; version: number; digest: string };
  targetSchema: { schemaId: string; version: number; digest: string };
  allowedCollections: Array<{
    collectionId: string;
    access: "read" | "read-write";
    ownership: "instance-shared" | "principal-private" | "role-shared";
  }>;
  context: RuntimeContext;
  signal: AbortSignal;
}
```

Portable migration rules:

- exact migration, source-schema, target-schema, Feature Revision, declaration, and data-namespace identities are host supplied and verified before execution;
- the effective Principal is exactly the management Principal authorizing the transition, or a `service` Principal operating through a receipt-linked delegation from that authorizer;
- the migration receives only the declared namespace/collection access needed for the schema transition;
- network, connections, notifications, views, actions, and jobs are unavailable by default and require a future separately reviewed migration capability rather than inherited Feature authority;
- old views, actions, jobs, and conflicting writes are fenced before migration; every storage read and commit revalidates the full `AuthorityStamp`, including `dataGeneration`;
- cancellation stops future commits but does not claim to reverse already committed batches; retry/resume behavior and idempotency are part of the reviewed migration declaration;
- Principal-private records remain partitioned by their owning Principal throughout enumeration, transformation, verification, export, and rollback. A migration cannot collapse them into shared data, change owners, or read another Principal's partition merely because one administrator authorized the update;
- role-shared collections preserve their declared owner and access-policy identity unless the reviewed update plan contains an explicit policy migration; and
- accepted, running, batch, verification, cancellation, failure, activation, and recovery outcomes link to a dedicated migration receipt without storing record contents.

The host activates new Feature bytes only after migration verification and the Runtime-Instance-level update transition commit. A failed migration leaves the Runtime Instance visibly fenced or in recovery; it never runs a half-migrated combination of schemas and code.

## Named jobs and automation portability

A portable job declaration binds:

- stable job id and handler id;
- feature revision and declaration digests;
- trigger intent and cadence anchor;
- explicit permission subsets for network, resources, storage scopes, connections, and notifications;
- overlap intent;
- catch-up intent;
- maximum portable execution duration, when declared; and
- input/result schema when the job accepts a bounded configuration value.

Enablement, connection binding, delivery destinations, budget, and host schedule state belong to the Runtime Instance and begin off. A Feature or App Release declaration cannot turn them on.

### Occurrences, attempts, and delivery

The common model distinguishes:

- `occurrenceId`: stable identity for one job and intended scheduled instant;
- `runId`: one logical run, including a manual run;
- `attemptId`: one lease/worker attempt for that run; and
- `receiptId`: durable observation of the accepted run and its attempts.

The portable contract is **at-least-once attempt delivery with observable deduplication identity**, never exactly-once execution. A host may avoid duplicate attempts, but crashes can occur after an external effect and before durable completion. Each job and mutating broker call receives a stable idempotency key that the feature can pass to a cooperating remote service. A feature must make state transitions idempotent or surface when it cannot.

Stable receipt states are `accepted`, `queued`, `running`, `succeeded`, `failed`, `skipped`, `cancelled`, and `expired`. Attempt receipts link retries and record the one effective Principal, delegation/authorizer when applicable, complete `AuthorityStamp`, lease/fence identity, host, start/finish times, bounded error, and usage summary. A skipped overlap, disabled launch, stale authority, quota denial, or expired offline lease remains visible rather than disappearing.

### Portable versus host-specific scheduling

Portable candidates:

- named declaration identity and explicit per-job enablement;
- cadence anchor and intended occurrence time;
- declared timezone and daylight-saving policy;
- `none` or `latest` bounded catch-up intent;
- no concurrent attempts for the same job unless a later declaration explicitly allows it;
- manual runs that do not shift recurring cadence;
- current-authority validation before every attempt and broker effect; and
- durable occurrence/attempt receipt lineage.

Host-specific until deliberately standardized:

- supported trigger vocabulary beyond interval;
- minimum/maximum interval, timer precision, and uptime promise;
- global and tenant concurrency;
- lease duration, heartbeat, retry count/backoff, queue ordering, and regional placement;
- cost, CPU, memory, network, notification, and wall-time budgets; and
- retention duration for detailed attempt logs.

The current desktop values—15 to 1,440 minute intervals, two machine-wide FIFO slots, `skip` overlap, one latest catch-up, five-second worker deadline, and execution only while work-fold runs—remain local policy. A hosted adapter must publish its actual policy through capability/limit introspection instead of imitating those values accidentally.

A manual run while a schedule is disabled requires independent interactive authority. It does not inherit schedule-only notification or unattended connection authority unless policy explicitly grants the manual invocation those powers.

## Notifications

Candidate operation:

- `notifications.show({ categoryId })`

The category is a reviewed declaration with static or policy-approved templated copy. The host chooses an enabled delivery adapter and returns `shown`, `rate-limited`, `unsupported`, or a stable denial error. Feature code cannot choose an arbitrary recipient, URL, action, title, or body through this baseline operation.

Notification authority requires the intersection of category declaration, current category grant, invocation permission subset, effective Principal/connection policy, and host abuse budget. Clicking or acting on a delivery revalidates the current Feature Revision, installation, `principalGeneration`, `grantGeneration`, and Runtime Instance state before opening anything.

Windows notification, web push, email, and mobile delivery are adapters. A grant for one destination class does not silently grant another.

## Receipts and audit

The runtime needs one stable minimal receipt model even though desktop persistence and cloud audit storage differ:

```ts
interface RuntimeReceipt {
  receiptId: string;
  kind: "action" | "job" | "migration" | "resource-mutation" | "notification" | "admin-transition";
  tenantId: string;
  runtimeInstanceId: string;
  featureInstallationId?: string;
  featureRevisionDigest?: string;
  dataNamespaceId?: string;
  effectivePrincipal: {
    principalId: string;
    kind: "human" | "agent" | "service" | "system";
    realm: "local" | "cloud";
  };
  authorization?: {
    delegationId?: string;
    authorizerPrincipalId?: string;
  };
  effectAttribution?: {
    networkDestinationId?: string;
    connectionOwner?:
      | { kind: "instance" }
      | { kind: "principal"; principalId: string };
  };
  transitionAttribution?: {
    priorTenantId?: string;
    nextTenantId?: string;
  };
  authority: AuthorityStamp;
  acceptedAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: "accepted" | "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "expired";
  error?: { code: string; message: string; retryable: boolean };
  parentReceiptId?: string;
  occurrenceId?: string;
  runId?: string;
  attemptId?: string;
}
```

Every receipt has exactly one `effectivePrincipal`. A delegated job, agent action, operator intervention, or management migration additionally records the delegation and/or authorizing Principal when one exists; it never adds several “effective actors.” Feature code is attributed through `featureInstallationId`, not represented as another Principal. A platform operator is a `service` Principal exercising one narrowly scoped operator role, not a special Principal kind.

The optional effect attribution is bounded, non-secret metadata. It may name a reviewed destination/declaration id and connection owner class, but never an origin containing credentials, secret reference, token, authorization header, provider payload, request body, response body, or connection value.

The host may add usage, region, policy-decision, and trace references. Receipts must omit secrets and payloads by default, be bounded, append-only or tamper-evident at the host's assurance level, and survive renderer/worker loss. Feature code may inspect only receipts in its own authorized installation scope and only under the current effective Principal's access policy. Runtime Instance administrators and platform operators have different audit projections; neither receives product data merely because a receipt exists.

Project History, release history, runtime receipts, and platform security audit remain distinct systems linked by digests and ids.

## Errors, cancellation, and quotas

Every rejected operation returns a stable structured error:

```ts
interface RuntimeError {
  code: string;
  category:
    | "invalid-input"
    | "denied"
    | "authentication"
    | "not-found"
    | "conflict"
    | "quota"
    | "rate-limit"
    | "timeout"
    | "cancelled"
    | "stale-authority"
    | "unavailable"
    | "host-failure";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  receiptId?: string;
}
```

Specific portable codes should retain useful current distinctions such as invalid input/output, undeclared action, network/file/notification denial, authentication required, conflict, quota, timeout, crash, revision change, and unavailable host. New families should include `AUTHORITY_STALE`, `AUTHORITY_EXPIRED`, `CAPABILITY_UNSUPPORTED`, `RATE_LIMITED`, and `CANCELLED`.

Error messages are bounded diagnostics, not policy or parsing interfaces. Callers branch on codes. A retryable error means policy permits a later retry; it does not authorize automatic unbounded retry.

Cancellation is cooperative computation termination plus mandatory fencing of later broker effects. Each invocation receives an abort signal and a host cancellation operation. Once cancelled:

- pending attempts do not start;
- running workers are asked to stop and may be terminated after a host grace period;
- new broker calls fail;
- commit points revalidate cancellation and authority;
- terminal receipt state records what the host observed; and
- already committed local writes, delivered notifications, or remote requests are not represented as rolled back.

The host exposes `limits.get()` and bounded usage summaries for the effective feature/invocation. Limit names and units are versioned; values are host/tenant policy. Quota denial must occur before an effect where feasible and must not be bypassable by restarting a renderer, changing a digest, or splitting requests across principals without corresponding policy.

## Authority generations and fencing

One app-scope in-memory generation is sufficient to stop current local launches, but distributed execution needs finer durable domains. Every dispatch, lease, worker, broker, receipt, and effect uses the one `AuthorityStamp` shape defined in `RuntimeContext`:

1. `runtimeInstanceGeneration` — suspension, deletion, Tenant transfer, governance change, or App Release activation;
2. `featureInstallationGeneration` — new install incarnation, revision activation, block-launch, disable, or removal;
3. `grantGeneration` — permission grant/revocation, declared access-policy change, or relevant target change;
4. `connectionGeneration` — binding replacement, disconnect, consent/scope change, owner removal, or Tenant transfer;
5. `jobGeneration` — enablement, schedule, permission subset, budget, job declaration, or lease-policy change;
6. `principalGeneration` — session, role, membership, delegation, consent, or effective-Principal revocation; and
7. `dataGeneration` — namespace schema, migration, retention state, deletion fence, ownership-policy, or restore transition.

Each field may be a monotonic counter, durable version, or equivalent unforgeable fencing token. The fields do not need one global total order, but no subsystem may invent a differently named or partial authority-stamp shape. A broker may compare only the fields relevant to an operation only after the host has supplied the complete stamp and the contract defines that projection.

Rules:

- dispatch captures the current stamp after authorization;
- queue records, leases, worker heartbeats, retries, receipts, and broker calls carry the complete stamp internally;
- the authoritative broker compares the relevant current fields of the complete `AuthorityStamp` immediately before each side effect or commit;
- a worker with an older fence cannot write storage/resources, use a connection, send network effects, or notify even if it still has CPU time;
- update continuity is eligible only for an unchanged Feature Revision digest, unchanged relevant declaration digest and target identity, no authority expansion, and explicit Runtime Instance policy;
- changed revisions advance `featureInstallationGeneration` while preserving `featureInstallationId`; a fresh install creates a new `featureInstallationId`. Neither transition inherits a stale live worker, grant, connection, job lease, or notification; and
- generation rollover and restore-from-backup cannot make an old token current again.

The broker, not feature code, holds fencing authority. A signed capability token cached inside a worker is insufficient unless every effect endpoint validates it against current revocation state or a deliberately bounded lease.

## Revocation and offline semantics

Revocation is a sequence with observable limits:

1. commit the new policy and advance the relevant generation;
2. stop new dispatch and lease acquisition;
3. cancel queued and running work;
4. close visible/notification surfaces where required;
5. make all authoritative brokers reject the old stamp;
6. invalidate connection refresh/callback work;
7. record receipts for cancellation and the administrative transition; and
8. apply retention, export, deletion, or provider-side revocation separately.

Already delivered external effects cannot be recalled. The product must state a revocation-latency objective rather than imply magic rollback.

Every Runtime Instance has an internal governance-policy enum. Its possible internal states distinguish authority administered entirely by the local work-fold profile, authority requiring current cloud policy or a bounded lease, and a mixed policy that assigns those behaviors per named power. These enum labels are implementation/policy vocabulary, not user-facing modes or marketing promises.

The UI explains concrete outcomes instead of exposing raw governance labels: whether this action can run without a connection, which powers pause and when, the lease expiry or required check-in, which data remains available locally, and when a disconnected device may not yet have received a revocation.

For powers governed by cloud policy or a bounded cloud lease:

- the lease identifies tenant, instance, feature revision/installation, declaration digest, principal/delegation where required, generations, allowed powers, issued/expiry times, and unique lease id;
- offline duration is bounded by policy and never extended from an untrusted client wall clock;
- after expiry, new privileged actions, jobs, network requests, connection use, and mutations pause with `AUTHORITY_EXPIRED`;
- queued offline effects reauthorize and deduplicate before replay;
- a block-new-launch or role/connection revocation takes effect on reconnect or lease expiry, whichever is earlier;
- local source and user-owned files remain accessible through ordinary filesystem tools according to local product rules, even when brokered cloud powers pause; and
- the UI states when revocation cannot yet have reached a disconnected locally hosted Runtime Instance.

Backup restore must not restore valid leases, connection generations, queue ownership, or fencing counters without revalidation. Hosted workers do not use offline leases; their brokers consult the hosted authority plane.

## Abuse controls

Portability cannot turn hosted infrastructure into an unmetered relay. A hosted adapter may deny or suspend otherwise well-formed calls based on abuse and operational policy while preserving stable errors and receipts.

At minimum, policy can scope budgets by tenant, principal, instance, feature revision/installation, destination, connection owner, job, notification category, and region. Controls include:

- request, byte, compute, storage, queue, notification, and model-call budgets;
- destination reputation and egress anomaly controls;
- concurrency, retry, catch-up, and fan-out ceilings;
- payload and schema bounds before queueing;
- per-principal and per-tenant anti-spam limits;
- automated suspension with a reason class and recovery/appeal path; and
- narrowly scoped emergency controls for new install, new launch, egress, jobs, connection use, notifications, or a hosted App Instance.

Rate-limit history and incident fences must not reset merely because a worker restarts, a renderer remounts, or a feature changes its display id. Security controls must avoid inspecting product data when metadata, declared destinations, aggregate usage, or bounded samples suffice.

## Platform operator boundary

Platform operation is not implicit project, Tenant, Runtime-Instance-admin, end-user, or connection-owner authority. An operator action has one effective `service` Principal exercising a narrowly scoped, time-bounded operator role; `operator` is not a fifth Principal kind.

Operators may normally:

- observe service health and bounded metadata;
- enforce infrastructure quotas and abuse policy;
- suspend hosted scheduling, egress, notification delivery, or an instance;
- rotate platform keys and repair infrastructure; and
- inspect tamper-evident operational receipts appropriate to their role.

Operators may not normally:

- read project source, instance records, principal-private storage, resource contents, Chat data, or credentials;
- impersonate a principal or manufacture consent;
- grant a feature new destinations, files/objects, connections, or jobs;
- alter immutable release bytes; or
- erase audit evidence to hide an intervention.

Break-glass access, if ever offered, requires a named incident/purpose, least-privilege scope, time limit, strong authentication, approval policy, receipts naming the one effective `service` Principal and authorizer, Tenant-visible disclosure where legally and operationally possible, and later review. Customer-managed encryption or self-hosting may further reduce operator access; those are deployment options, not excuses to weaken the core authority model.

## Local Electron and hosted web adapters

| Concern | Local Electron adapter | Hosted web adapter |
| --- | --- | --- |
| Principal binding | Trusted main process binds one human, agent, service, or system Principal to the sender, Assistant turn, or event. | Authenticated human/agent/service/system Principal plus Tenant and Runtime Instance authorization. |
| Feature binding | Verified staged digest, sender-bound ephemeral origin, and complete host-owned `AuthorityStamp`. | Immutable artifact digest, installation record, worker/image identity, and complete durable `AuthorityStamp`. |
| Views | Sandboxed `WebContentsView`, rail navigator, Space-owned tabs. | Sandboxed browser frame/document and host-owned route/navigation shell. |
| Storage | Bounded local host-owned JSON namespace. | Tenant-aware database/service with the same revision/transaction contract. |
| Resources | Explicit Space-relative file grants; atomic History-covered writes. | Explicit object/document collection grants; revisioned writes and audit. |
| Network | Main-process public-HTTPS or development loopback broker; OS-encrypted connections. | Egress proxy/service; cloud secret/connection service; destination and tenant policy. |
| Jobs | In-process scheduler while work-fold runs. | Durable scheduler, queue, leases, fenced workers, retries, and regional policy. |
| Notifications | Static reviewed Windows notifications. | Separately configured web push/email/mobile adapters. |
| Offline | Internal local governance policy by default; optional linked authority lease later. UI describes the resulting availability and expiry. | Online authority plane; clients may cache display data but do not become workers. |
| Isolation | Chromium sandbox plus host broker; Electron exploit/DoS risk remains. | Browser isolation plus worker/container/process limits; platform exploit/DoS risk remains. |

Both adapters should pass one semantic conformance suite. Host-specific security and integration probes remain separate release gates.

## Immutable closure, attestations, and live policy

The immutable App Release closure and mutable trust/policy records answer different questions and must never be collapsed into one “verified” flag.

The content-addressed release closure contains or content-addresses the immutable evidence needed to verify what will execute: exact Feature Revision bytes, canonical declarations and declaration digests, runtime compatibility requirements, schemas, exact migration digests, dependency inventory, selected source/build-provenance evidence objects, and deterministic closure metadata. Changing any included evidence changes the release digest.

Attestations are immutable sidecars that name an already computed release or Feature Revision digest. Examples include feature review, release review, independent rebuild, malware-scan result, and publisher signature. They are outside the release digest so a signature or later review does not create a circular hash or rewrite historical bytes. An attestation proves only its stated evidence and signer; it does not create a grant or make code safe.

Policy sidecars are mutable control-plane state keyed to immutable digests and scoped audiences. Examples include publisher/key status, required attestation policy, delisting, block-new-install, block-new-launch, hosted suspension, incident exception, region eligibility, and artifact-retention status. Changing policy advances the applicable fields of the complete `AuthorityStamp`; it never mutates or silently substitutes release bytes.

The boundaries are enforced at four moments:

1. **Publish:** verify the complete closure and canonical digest, verify current review/publisher authority, then issue review/publication/signature attestations over that digest and record initial policy sidecars.
2. **Install or deploy:** verify closure bytes and digest independently, evaluate the target Tenant/host's current attestation and policy requirements, and create the Runtime Instance with live grants, connections, and jobs off.
3. **Launch or update activation:** re-verify the staged closure/revision identity and current compatibility, then consult current block-launch, suspension, key-compromise, Tenant, and authority-generation policy. A previously valid install attestation is not an eternal launch lease.
4. **Offline authority lease:** bind the lease to Tenant, `runtimeInstanceId`, release and Feature Revision digests, declaration digest, complete `AuthorityStamp`, allowed powers, policy-decision reference, issuance, and expiry. The lease is a time-bounded policy sidecar; it neither enters nor changes the immutable closure and cannot outlive its explicit expiry.

Offline closure verification can prove bytes. It cannot prove that mutable remote policy has not changed beyond the documented lease window.

## Compatibility and versioning

The runtime API uses explicit major/minor negotiation:

- a release declares one supported major, minimum minor, required capabilities, and optional capabilities;
- a host advertises its major/minor and capability identifiers before execution;
- a major mismatch or missing required capability blocks launch with a reviewable compatibility error;
- optional capabilities produce explicit unavailable state rather than silent polyfills;
- minor versions add operations, fields, capabilities, or error codes without widening existing authority;
- security-sensitive declarations remain closed and reject unknown fields;
- response readers ignore documented additive fields but never ignore an unknown grant, owner class, authority domain, or executable behavior; and
- hosts do not silently downgrade a release to a weaker security contract.

Capability names should be granular, for example `storage.instance.transactions`, `storage.principal`, `resources.tree.write`, `resources.objects.put`, `connections.principal`, `jobs.interval`, or `notifications.static`. A capability says the host implements semantics, not that the feature currently has a grant.

Feature revisions record the runtime contract and declaration digests in the immutable release closure. Updates that change a required API major, data schema, resource kind, connection owner class, job identity, or permission maximum receive explicit review and migration handling.

The current local `agent-app.json` version uses runtime API
`work-fold.restricted-app-bridge` and the frozen `workFoldRestrictedApp` global.
They are inputs to a future portable adapter, not aliases for this candidate
`feature-runtime/v1` contract. No compatibility promise exists until a
normative contract and conformance tests are accepted.

## Targeted throwaway distributed-systems spikes

The three spikes below were executed with synthetic in-memory inputs and all
required invariants were demonstrated without a global clock or exactly-once
queue. Their models, observed transitions, limitations, and contract
consequences are recorded in
[App platform runtime spike evidence](app-platform-runtime-spike-evidence.md).
No experiment code or temporary artifact was retained.

Paper reasoning is insufficient for three failure classes. These spikes may inform Gate 4, subject to the exploration's constraints: no production or personal data, no product integration, no durable schema, no compatibility promise, unmerged and unshipped, question/result recorded, and code destroyed after evidence is captured.

### Spike A: lease and fencing race

Run two fake schedulers and two fake workers against one minimal authoritative effect broker. Pause worker A after lease acquisition, expire/reassign the lease to worker B, advance the affected fields in the complete `AuthorityStamp`, then resume A.

Evidence required:

- stale worker A cannot commit storage, object, network, connection, or notification effects;
- worker B can complete under the new fence;
- duplicate attempt and cancellation receipts link to one occurrence/run;
- restart and simulated backup restore cannot make A's fence current; and
- the test identifies the exact authoritative compare-and-commit point for each effect class.

### Spike B: clocks, cadence, and catch-up

Use controllable scheduler, database, and worker clocks with forward/backward wall-clock jumps, timezone and DST transitions, sleep/resume, queue delay, lease expiry, and duplicate delivery.

Evidence required:

- cadence anchors and occurrence ids remain deterministic;
- wall-clock rollback does not extend a lease or repeat an already accepted occurrence silently;
- `none` and `latest` catch-up produce bounded, explained results;
- manual runs do not shift cadence; and
- receipts distinguish intended schedule time, acceptance, attempt start, and completion.

### Spike C: offline authority expiry and replay

Issue a short signed authority lease to a fake local adapter, disconnect it, revoke a grant/role/connection and block launches remotely, manipulate the client wall clock, queue effects, expire the lease, and reconnect.

Evidence required:

- untrusted clock changes cannot prolong authority;
- privileged broker effects stop at expiry;
- queued work does not replay before reauthorization and idempotency checks;
- the UI can explain which local-only powers remain, which remotely governed powers paused, and the concrete expiry or reconnection condition without exposing internal governance enum labels; and
- reconnect produces one auditable transition without resurrecting stale connection refresh or job leases.

If these spikes cannot demonstrate the invariants without a shared global clock or exactly-once queue, the contract must change rather than hide the limitation.

## Accepted Gate 4 decisions

The normative foundation accepts these semantic decisions. Candidate record
shapes elsewhere in this memo remain non-public until versioned code and
conformance fixtures implement them:

1. **One semantic broker, separate adapters.** Desktop Electron and hosted web implement one product-level runtime contract; neither transport becomes the contract.
2. **Host-owned identity.** Tenant, discriminated Runtime Instance, Feature Installation/Revision, Data Namespace, effective Principal, invocation, and authority are always host-resolved and never caller-selected. A Development Instance is source-bound and release-less; an App Instance is release-backed and locally or remotely hosted.
3. **Installation incarnation and data identity are separate.** A new install creates a new `featureInstallationId`, a reviewed update preserves it, and `dataNamespaceId` follows an explicit retention/migration lifecycle rather than executable identity.
4. **Feature revision as continuity unit.** Authority continuity across an App Release update is eligible only for the unchanged Feature Revision and relevant declaration digests, stable target identity, no expansion, and explicit Runtime Instance policy.
5. **Declarations are maxima.** Every dispatch and effect uses the intersection of reviewed declarations, current grants, declared role access policy, invocation subset, connection consent, Principal scope, authority lifetime, and host policy.
6. **Two resource semantics.** Tree/file and object-collection access share grant/fencing rules but remain distinct APIs. Development publish-input commits crash-safely advance source generation and invalidate stale proposals before success.
7. **Connection owner class is mandatory.** Instance-owned and Principal-owned connections never substitute for each other; unattended Principal use needs explicit bounded delegation, and Tenant transfer requires disconnect/rebind decisions.
8. **Automation is occurrence/attempt based.** Named jobs are explicitly enabled, at-least-once, idempotency-aware, receipt-backed, and honest about host-specific scheduling/retry policy.
9. **Migration is a restricted execution class.** Management invokes exact reviewed migration/schema digests with data-only namespace access, separate fencing and receipts, and no inherited Feature powers.
10. **One authority stamp fences everything.** Queue, lease, worker, broker, connection refresh, data commit, migration, and notification paths carry the complete `AuthorityStamp` and reject stale relevant fields; cancellation alone is insufficient.
11. **Offline authority is internal and bounded.** Internal governance policy determines local/cloud lease behavior; the UI explains outcomes and remote revocation claims stop at bounded lease expiry for disconnected clients.
12. **Receipts have one effective Principal.** Delegation/authorizer and bounded non-secret effect attribution are supplemental; Feature code is an installation identity, and operators are scoped service Principals.
13. **Closure and live policy remain distinct.** Immutable evidence is content-addressed; attestations and mutable policy sidecars are evaluated at publish, install/deploy, launch/activation, and lease issuance.
14. **Abuse and operator controls are constrained powers.** They use scoped service Principals and receipts and do not imply access to product data or secrets.
15. **Compatibility is negotiated.** Required capabilities and major/minor versions block incompatible releases before execution instead of failing unpredictably at first use.
16. **Management stays separate.** Installation, grant, connection, job enablement, roles, migration, publication, deployment, and update remain authenticated management-plane mutations, not Feature-runtime calls.

## Gate 4 implementation and launch criteria

The semantic contract is normative through the foundation. The criteria below
gate the implementation scope that depends on them: the local foundation must
meet its identity, authority, receipt, compatibility, and fixture subset; a
production hosted runtime must meet every applicable criterion with real
adapters and operational evidence:

- every current Connected inbox power maps to this contract without broader authority: navigator/tabs, storage, granted exports, exact network destinations, connection injection, action, named refresh job, notification, and receipt;
- the community-garden fixture maps shared instance data, principal-private data, document/object access, role-bound actions, and a reminder job without assuming an IDE or cloud account;
- a no-account local Development Instance remains source-bound and release-less, while every App Instance is release-backed and explicitly locally or remotely hosted;
- a no-account local Development Instance retains current review, sender binding, default-off grants, explicit connection, History, and automation behavior;
- host context and ids cannot be replayed or supplied by Feature code to cross Tenant, Runtime Instance, Feature Installation, Data Namespace, Principal, or view boundaries;
- new installation versus reviewed update tests prove the required `featureInstallationId` transition, while retention/migration tests prove `dataNamespaceId` is separate;
- every dispatch, lease, receipt, migration, and sensitive broker carries the complete `AuthorityStamp` and validates the relevant current fields immediately before its effect/commit;
- role-shared storage collections and role-bound actions are denied when host policy changes even if UI capability hints are stale;
- update continuity rules preserve an unchanged feature only under unchanged declarations/targets and reset every changed or expanded authority;
- an instance-owned connection can support an explicitly enabled tenant job, while a principal-owned connection cannot run for another principal or unattended without bounded consent;
- Tenant-transfer fixtures disconnect or explicitly rebind each connection without changing owner class, leaking secret access, or preserving stale job authority;
- accepted actions, occurrences, attempts, migrations, brokered mutations, cancellations, stale-authority denials, and administrative transitions produce bounded payload-free receipt lineage with exactly one effective Principal and optional delegation/authorizer reference;
- network/connection receipt attribution remains bounded and non-secret, and Feature code is attributed as the installation executing for the effective Principal rather than another Principal;
- migration fixtures bind exact migration/source/target schema digests, preserve Principal-private partitions, expose no network/connection/notification/view/action/job authority by default, and fail fenced or recoverably;
- a successful Development Instance write to a selected publish input crash-safely commits History, advances project-source generation, and invalidates stale proposals in the same serialized mutation;
- duplicate/retried job attempts are visible and have stable idempotency identity; no design claim depends on exactly-once execution;
- cancellation, timeout, crash, quota, denial, rate limit, conflict, unsupported capability, stale authority, and offline expiry have stable codes and honest effect semantics;
- revocation prevents queued, retried, newly brokered, and post-cancellation effects; already externalized effects and disconnected latency are explicitly bounded rather than misrepresented;
- the clock/lease/fencing spikes produce the required evidence before their
  results are incorporated into versioned implementation;
- hosted abuse budgets and emergency controls are scoped by tenant/principal/instance/feature and cannot be reset by remounting or renaming;
- operator health, suspension, incident, and break-glass powers are separated from project, instance, end-user, and credential authority;
- immutable closure verification and attestation/policy-sidecar evaluation are separately tested at publish, install/deploy, launch/activation, and offline-lease issuance;
- runtime version/capability negotiation rejects incompatible releases before code runs;
- a desktop semantic conformance suite and hosted semantic conformance suite can share fixtures while each host keeps its own security/isolation tests; and
- accepting this contract triggers aligned normative updates to product, runtime/authoring, management, architecture, security, privacy, release-manifest, and threat-model documents before implementation.

The checked-in local and hosted semantic code is conformance evidence, not a
public `feature-runtime/v1` transport. No host may advertise that protocol until
the remaining shared-fixture, Principal-connection, migration, Development
write, abuse/operator, offline-lease, and production-adapter criteria pass.
