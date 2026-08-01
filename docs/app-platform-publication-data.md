# App platform publication and data contracts

> **Status:** Accepted Gate 2 and Gate 3 supporting contract
>
> **Scope:** Detailed publication, mutable-data, connection, migration, export,
> deletion, and non-sync semantics accepted by
> [App platform foundation](app-platform-foundation.md).
>
> **Authority:** [Product model](product-model.md) and
> [App platform foundation](app-platform-foundation.md) are normative. JSON
> records labeled candidate remain design guidance until a versioned code format
> and conformance fixture implements them. The declaration/artifact digest and
> immutable Release-envelope subset now has versioned code plus independent
> conformance, and the current work-fold build implements its local Project/Release/Instance
> lifecycle; other candidate records remain guidance.

This document defines the accepted semantic boundaries for App Project, App
Release, Development Instance, and App Instance implementation. **Runtime
Instance** is the internal union used only when a rule
applies to both a source-bound, release-less Development Instance and a
release-backed local or hosted App Instance. It does not by itself claim a
server, sync path, broad terminology change, or compatibility promise for
candidate record examples.

## Baseline carried forward

The current restricted-app implementation establishes useful safety properties:

- inspection does not evaluate package code, resolve dependencies, or run build
  scripts;
- every package byte participates in one SHA-256 digest, and installation stages
  and verifies the exact reviewed bytes;
- a proposal receipt is bound to one Space, Chat, source path, and digest;
- installing a digest grants no destination, file root, notification category,
  connection, or automation;
- host-owned JSON storage is keyed by Tenant, Runtime Instance, Feature
  Installation, and Data Namespace, so data lineage is separate from a package
  digest;
- connections and automation execution bind the exact runtime, installation,
  revision, declaration, target, owner, and relevant authority; and
- Development-preview updates and changed App-Release revisions stop the old
  runtime, preserve the Feature/Data lineage, and reset grants, connections,
  schedules, and current-revision run history.

The release-backed local model makes continuity more selective, and future
hosts must preserve that rule: review is never equivalent to a live grant and a
friendly id never substitutes for reviewed bytes.

## Candidate identity model

Each identifier has exactly one job. Possessing or copying an id never proves
ownership or authority.

| Identifier | Meaning | Stability and security use |
| --- | --- | --- |
| `spaceId` | Portable identity of one ordinary folder-backed Space | Survives a folder move; is not a cloud credential, tenant id, or project role |
| `projectId` | Local/project identity of one App Project and its App lineage | Stable across releases; machine-local in the current product, and never a cloud credential or ownership proof; a future portable form needs explicit import/collision rules |
| `cloudProjectId` | Registry identity of one remotely registered App Project | Bound to `projectId` only through an authenticated, revocable record; excluded from the immutable release identity |
| `featureId` | Stable logical slot for one feature within the project's App lineage | Names storage and update comparison; cannot prove code or declaration continuity |
| `featureRevisionDigest` | Content digest of one closed feature artifact | Exact executable identity and the first continuity requirement |
| `declarationDigest` | Digest of the feature's canonical requested-power and runtime declaration | Makes authority-surface comparison explicit even though the declaration is also inside the artifact closure |
| `releaseDigest` | Content address of the canonical release manifest and its complete referenced closure | Canonical immutable release identity; a registry locator or display version is not a substitute |
| `runtimeInstanceId` | Identity of one Development Instance or release-backed App Instance | Owns one runtime boundary; never derived from a copied project id or reused across the two instance kinds |
| `featureInstallationId` | Opaque incarnation of one installed Feature in one Runtime Instance | Stable across reviewed revision updates; a remove/reinstall creates a new value |
| `dataNamespaceId` | Mutable data lineage used by one Feature Installation | Separate from installation incarnation so retained data requires explicit retain, adopt, export, or purge policy |
| `tenantId` | Runtime data and policy boundary | Derived by the host from authenticated context, never trusted from feature code |
| `principalId` | Human, agent, service, or system actor identity | Used with current roles and consent; not interchangeable with tenant or instance identity |

The no-account local path uses a machine-local tenant and host-resolved local
principal as described in the exploration memo. Those values are not promoted
into cloud identities. An App Project is owned through its own project roles by
a Principal or optional Organization, never by a runtime Tenant. Linking a
local project to a registry creates a distinct `cloudProjectId` binding that
records the authorizing Principal and current project role. Creating or linking
an App Instance separately chooses its runtime Tenant.

### Shipped local registry and placement

work-fold implements the account-free local subset without creating the
candidate cloud binding above:

- one source Space has at most one machine-local App Project and one
  Development Instance;
- Project presentation is an explicit `{ title, description, icon }` record in
  work-fold application data, not a new `.work-fold/` file. The first reviewed
  preview may seed it from the Feature declaration, and App Studio can update it;
- preparing a Release snapshots all current reviewed Development Features into
  an immutable format-version-2 envelope and stores it by `releaseDigest`;
- prepared and published are separate durable states. Local publication
  rechecks the source Feature Installation, package, and artifact stamps and
  creates eligibility for local installation only;
- install and update preparation are durable operation records with exact
  allocated ids and plan content. Activation re-reads the Release, rechecks
  conflicts or the current active pointer, and consumes the operation only when
  the registry transition commits;
- one release-backed local App Instance may exist for a `(projectId, target
  Space)` pair. A target with any Development or App Feature using the same
  `featureId` is rejected instead of silently merging runtimes; and
- the target Space supplies navigation attachment and eligibility for explicit
  file grants. Release bytes, live authority, connections, schedules, receipts,
  operation journals, and mutable data remain host-owned application data.

Local “publish” is not upload, registry publication, signing, hosting, sync, or
App Store submission. Removing either a source Space whose Project has an
active release-backed instance or that instance's target Space is blocked until
the App Instance is explicitly uninstalled. A retain choice keeps the source
registered until its inactive Data Namespaces are explicitly purged; the former
target may then be removed. Source removal without live or retained data clears
the machine-local Project and its Release lineage, while target removal cancels
prepared operations aimed at that registration.

The local registry is a clean work-fold registry. Legacy Workspace profiles,
portable `.workspace/` records, restricted-app registries, storage,
connections, receipts, and artifacts are never opened, imported, upgraded, or
adopted into these identities. They remain preserved and inert, and possession
of one cannot satisfy any work-fold digest, Project, Tenant, or authority check.

The shared candidate authority stamp is a typed set of independently advancing
domains, not one global counter:

```text
AuthorityStamp {
  runtimeInstanceGeneration
  featureInstallationGeneration
  grantGeneration
  connectionGeneration
  jobGeneration
  principalGeneration
  dataGeneration
}
```

Records carry the complete stamp or the explicitly named relevant fields. No
scalar `authorityGeneration` may imply a total order across unrelated domains.

Canonical digest input must specify byte encoding, path normalization, ordering,
duplicate handling, Unicode treatment, and manifest serialization. A digest
claim is invalid if two conforming implementations can serialize the same record
differently. Human versions such as `1.4.0` remain labels and ordering hints;
they are never the identity checked at launch.

A candidate registry binding is separate from release content and Runtime
Instance authority:

```json
{
  "recordVersion": 1,
  "projectId": "project_opaque",
  "cloudProjectId": "cloud-project_opaque",
  "ownerSubject": {
    "kind": "principal",
    "principalId": "principal_opaque"
  },
  "authorizingPrincipalId": "principal_opaque",
  "projectRole": "owner",
  "projectBindingGeneration": 3,
  "status": "active"
}
```

`ownerSubject.kind` may instead be `organization` with an Organization id. The
effective actor is still the authenticated `authorizingPrincipalId`. No
`tenantId` appears because runtime tenancy does not confer project ownership,
review, or publication authority.

## Gate 2: publication boundary

### Accepted semantic decisions

1. **Publishing consumes an explicit reviewed snapshot, not a live folder.** A
   publish proposal identifies selected inputs and exact digests. Any selected
   input change makes that proposal stale.
2. **A release is immutable and closed.** It contains, or content-addresses, all
   executable UI, worker code, static assets, schemas, declarations, migrations,
   and required runtime metadata. It has no ambient local dependency.
3. **Feature review and release review are distinct.** Feature review approves
   exact bytes and requested power maxima. Release review approves composition,
   closure, provenance, compatibility, migrations, and policy. Neither creates
   an instance grant.
4. **Publication authority is separate from review authority.** One person may
   hold both roles, but the receipt records which authority justified each act.
5. **A release may contain multiple independently identified feature revisions.**
   Feature authority stays namespaced; the enclosing app receives no ambient
   union of its features' powers.
6. **Restricted release features cannot depend on ambient Skills or Extensions.**
   Full-trust Pi resources may help build or operate a project, but they do not
   enter or execute as dependencies of the restricted end-user artifact.
7. **Release installation and deployment start default-off.** Runtime grants,
   connection bindings, notification categories, and named jobs are instance
   decisions after review.
8. **Continuity is evaluated per feature and per declaration.** An unchanged
   feature revision may qualify for narrowly defined continuity; a stable
   `featureId`, `projectId`, display version, or publisher is insufficient.

### Immutable release closure

A closed release has a finite, verifiable dependency graph rooted at its
canonical release manifest. Its closure includes:

- every feature artifact and its complete prebuilt runtime assets;
- canonical feature runtime, navigation, action, requested-power, notification,
  and named-job declarations;
- data schema descriptors and every migration needed from supported predecessor
  schemas;
- portable broker API compatibility requirements;
- content type, size, and digest metadata for every referenced blob;
- a dependency inventory and applicable license notices;
- immutable inspection evidence and bounded findings over the exact closure;
- build and source provenance over the selected inputs and produced feature
  artifacts, at the confidence level actually verified; and
- policy and format versions needed to reproduce inspection decisions.

A release closure excludes:

- mutable URLs, floating package versions, CDN assets, or deploy-time downloads;
- install, postinstall, or deploy-time build scripts;
- credentials, refresh tokens, signing private keys, connection values, or
  environment secrets;
- machine paths, a local Space registry entry, local History objects, or runtime
  data;
- raw `.work-fold/` metadata or conversations;
- `.pi/` and other executable project configuration; and
- the personal Library or a pointer that can read from it later.

A Library item explicitly copied into a Space becomes an independent ordinary
file. It can enter a release only if the person then selects that copied file as
a publish input and its licensing permits distribution. Its origin in Library
does not create a live dependency or silently select it.

A raw numeric-loopback destination may remain valid for a local Development
Instance, but it does not describe a closed hosted dependency. Hosted publication
must reject it, mark the feature local-only, or replace it with a separately
reviewed managed-service contract. Renaming an arbitrary port grant does not prove
service ownership.

### Provenance and attestations

Provenance records evidence; it must not claim more than the pipeline verified.
Immutable closure evidence contains build inputs, produced artifacts, dependency
inventory, inspection findings, and the policy versions used to calculate those
findings. Append-only sidecars separately record human or service review,
publisher signatures, registry policy, incident response, and supersession over
the already computed `releaseDigest`. The candidate records should distinguish:

- source snapshot identifiers and digests for selected publish inputs;
- builder identity and builder environment or service version;
- build recipe digest and dependency lock/inventory digest;
- produced feature and release digests;
- inspection policy version and findings;
- feature reviewer, release reviewer, publisher, decisions, and timestamps;
- signature and key identifiers where signing exists; and
- supersession, key rotation, compromise, delisting, and launch-block status.

A reproducibility claim requires an independent rebuild that produced the same
artifact digest. Feature-review, release-review, publication, signature, and
registry-policy attestations are sidecars that name the already computed
`releaseDigest` or one of its exact Feature Revision digests. They are not
included in the release digest and therefore do not create a circular hash. A
sidecar may be appended, superseded, or revoked without rewriting historical
release bytes. A signature proves control of a key, not safety, ownership of
third-party code, or correctness. Review, malware scanning, policy evaluation,
signature verification, and publisher reputation remain separate signals.

Checks occur at four explicit boundaries:

1. **Publish:** verify the complete immutable closure, all required current
   Feature reviews, release review, publisher role, and registry policy, then
   append the publication/signature sidecars over the exact `releaseDigest`.
2. **Install or deploy:** verify the closure and digest again, require the
   configured review/signature policy, and consult current delist, block-install,
   compromise, and compatibility sidecars before creating runtime state.
3. **Launch:** verify the staged digest and current block-launch/instance policy.
   Local-sovereign instances use their explicit local policy; cloud-governed and
   hybrid powers require current hosted policy or an unexpired authority lease.
4. **Lease issuance or renewal:** revalidate sidecar status, Tenant policy,
   Principal roles, and the typed Authority Stamp before minting more offline
   authority.

No sidecar is a runtime grant. Install/deploy, each live grant, connection,
job enablement, and authority lease remain separate instance decisions.

### Review is not a grant

The paper lifecycle is:

1. inspect selected feature bytes without evaluation;
2. review exact bytes, declarations, permission composition, and migrations;
3. assemble and verify a closed release;
4. approve and publish that immutable release;
5. inspect the release for the target runtime and instance policy;
6. install or deploy it with external powers and named jobs off; then
7. grant each destination, file/object root, notification category, connection,
   and automation separately.

The review UI must expose dangerous composition. A feature that can read a
sensitive object and contact an external origin can exfiltrate the object even
when each declaration appears modest alone. Release review must also show
cross-feature composition without pooling grants between features.

### Multi-feature update continuity

For a release-backed App Instance moving from release `R1` to `R2`, continuity
is computed for each existing Feature Installation. The installation incarnation
survives a reviewed revision update; removing and later reinstalling the same
`featureId` creates a new incarnation. The candidate eligibility key is:

```text
runtimeInstanceId
+ featureInstallationId
+ featureId
+ featureRevisionDigest
+ declarationDigest
+ declaration-specific target identity
+ connection owner class and owner id, when applicable
+ relevant fields from the current AuthorityStamp
```

The feature revision digest and relevant declaration digest must both be exact
matches. The explicit declaration comparison makes the authority reason visible
and prevents a future artifact-format change from weakening the rule. Target
identity includes values that matter to the power: canonical network origin and
auth declaration, selected file/object root identity and access, notification
copy/category, or job handler, schedule intent, permission subset, and runtime
compatibility.

| State | Candidate transition rule |
| --- | --- |
| Network/file/object/notification grant | May continue only when the feature revision, relevant declaration, target identity, and instance policy are unchanged; otherwise reset |
| Instance-owned connection | May continue only within the same Runtime Instance and Feature Installation when the feature revision, destination declaration, canonical target, auth kind, and binding policy are unchanged |
| Principal-owned connection | Requires the instance-owned checks plus the same principal and unrevoked consent; never changes owner through update |
| Automation enablement and cadence | May continue only when the exact feature revision and complete job declaration are unchanged and every referenced grant/connection remains valid |
| Feature data | The installation retains its `dataNamespaceId`, but changed code may access it only after schema compatibility or an approved migration succeeds |
| Run receipts and audit | Never reset as a continuity convenience; retain immutable predecessor installation/revision lineage and label the active installation, feature, and release digests |
| Open views and in-flight work | Stop or fence before activation; a prior revision cannot keep issuing brokered effects after the relevant Authority Stamp fields change |

Continuity is an eligibility decision, not an entitlement. Instance policy or a
human administrator may choose a stricter reset. No rule may carry an expanded
power forward silently. Added features start new. Removed features lose launch
authority and close their installation incarnation. Their `dataNamespaceId`
enters the declared retain/export/purge path rather than becoming available to
another installation. A later reinstall receives a new `featureInstallationId`
and new data namespace unless an administrator explicitly adopts a compatible
retained namespace through a reviewed, receipted migration decision.

The current local build implements the no-schema subset. Its persisted planner treats an
exact Feature artifact and declaration as `keep`: eligible grants,
instance-owned connections, enabled jobs, the Feature Installation, and the Data
Namespace can continue unless the person chooses the stricter reset policy. A
changed revision is `update`: the installation and data namespace remain, while
grants, connections, jobs, current-revision runs, and stale hosts reset. Added
Features receive freshly reserved installation/data ids. Removed Features are
fenced and their data is retained as inactive data pending an explicit purge.
Choosing an older published Release uses the same planner and activation path,
so rollback is not a byte-copy exception. Releases containing a data schema or
migration are rejected by the current local restricted runtime; no migration is
executed or implied.

### Release envelope

The exact versioned schema is implemented in `app-platform-release.ts`; this
abbreviated shape remains illustrative. `releaseDigest` is outside the canonical
manifest it identifies, avoiding a self-referential hash. Release review and
publisher attestations are sidecars over that digest. Format version 2 adds the
App-level presentation snapshot to the immutable manifest; the local restricted
runtime uses `work-fold.restricted-app-bridge` compatibility `2.x`.

```json
{
  "recordVersion": 1,
  "releaseDigest": "sha256:release-content-address",
  "manifest": {
    "format": "work-fold.app-release",
    "formatVersion": 2,
    "projectId": "project_opaque",
    "presentation": {
      "title": "Connected inbox",
      "description": "A reviewed inbox for this App.",
      "icon": "mail"
    },
    "displayVersion": "1.2.0",
    "runtimeApi": {
      "name": "work-fold.restricted-app-bridge",
      "compatibleRange": "2.x"
    },
    "features": [
      {
        "featureId": "connected-inbox",
        "featureRevisionDigest": "work-fold.artifact.v1:sha256:<64-lowercase-hex>",
        "declarationDigest": "sha256:canonical-declarations",
        "artifact": {
          "mediaType": "application/vnd.work-fold.feature+bundle",
          "sizeBytes": 48172
        },
        "dataSchema": {
          "schemaId": "connected-inbox-data",
          "version": 2,
          "digest": "sha256:data-schema"
        },
        "migrationDigests": ["sha256:migration-v1-to-v2"]
      }
    ],
    "dependencyInventoryDigest": "sha256:dependency-inventory",
    "buildProvenanceDigest": "sha256:build-provenance-record",
    "inspectionEvidenceDigest": "sha256:closure-inspection-evidence",
    "createdAt": "2026-07-15T12:00:00.000Z"
  },
  "sidecars": [
    {
      "kind": "feature-review",
      "digest": "sha256:feature-review-sidecar"
    },
    {
      "kind": "release-review",
      "digest": "sha256:release-review-sidecar"
    },
    {
      "kind": "publisher-signature",
      "digest": "sha256:publisher-signature-sidecar"
    },
    {
      "kind": "registry-policy",
      "digest": "sha256:registry-policy-sidecar"
    }
  ]
}
```

Feature entries and all set-like fields are canonically ordered. Every digest
reference must resolve to bytes whose media type, length, and digest match. The
release digest covers the canonical manifest plus a deterministic root of every
referenced closure object, not the sidecar attestations, a registry response, or
mutable listing metadata. Each release attestation independently identifies the
release digest it reviewed or signed.

### Candidate review record

```json
{
  "recordVersion": 1,
  "reviewId": "review_opaque",
  "kind": "feature",
  "subject": {
    "featureId": "connected-inbox",
    "featureRevisionDigest": "work-fold.artifact.v1:sha256:<64-lowercase-hex>",
    "declarationDigest": "sha256:canonical-declarations"
  },
  "projectId": "project_opaque",
  "reviewerPrincipalId": "principal_opaque",
  "decision": "approved",
  "inspectionPolicyVersion": "policy-1",
  "findingsDigest": "sha256:bounded-findings",
  "createdAt": "2026-07-15T11:30:00.000Z"
}
```

The record intentionally contains no runtime grants, credential values, role
claims supplied by a client, or promise that approval remains valid after a
different digest is produced.

### Gate 2 risks

- Canonicalization errors can make digest identity ambiguous across clients.
- A closed artifact can still be malicious, vulnerable, or legally
  undistributable.
- Multi-feature composition can hide dangerous combined authority.
- Reusing a stable feature id can be mistaken for code continuity.
- Build provenance can become security theater if evidence is optional or
  unverifiable.
- Signing-key compromise and malicious approved updates need emergency response,
  not only happy-path verification.
- An irreversible migration can make code rollback dishonest.
- Artifact retention and offline copies prevent “unpublish” from meaning erasure.

### Gate 2 acceptance criteria

The foundation accepts Gate 2 as normative semantic design. These criteria gate
the publication product scope that depends on them. The current local product meets
the digest/offline-closure boundary plus separately durable
prepare/publish/install/update acts, while a public registry must satisfy all
applicable hosted and public-distribution items before launch:

- two independent implementations produce the same digest for every conformance
  fixture, including Unicode and path edge cases;
- a release can be verified offline from its envelope and closure;
- no package code, dependency installer, lifecycle hook, or migration executes
  during inspection;
- the release format has no ambient file, network, credential, Library, Chat, or
  `.pi` dependency;
- feature review, release review, publication, installation, and live grants have
  distinct actors and receipts;
- every requested power is attributable to one feature revision and canonical
  declaration;
- the continuity matrix produces an explicit retain/reset/migrate decision for
  every Feature Installation incarnation, grant, connection, job, data
  namespace, view, and receipt;
- failure, key compromise, delisting, block-new-install, block-new-launch, hosted
  suspension, and artifact-purge semantics are distinct; and
- the Connected inbox fixture and the community-garden fixture both produce
  finite, closed releases without importing full-trust project configuration.

## Development Instance boundary

A Development Instance is the only sanctioned overlap between the editable
project plane and a Runtime Instance. It is source-bound and release-less; a
release-backed local or hosted App Instance is a different object. It follows
these candidate rules:

1. It is local, belongs to one registered Space and App Project, and requires no
   account.
2. It executes only a staged, inspected, approved feature revision. Editing
   source does not hot-replace installed bytes.
3. Each installed Feature receives a `featureInstallationId` and separate
   `dataNamespaceId`; host-owned runtime data is not written into source or
   included in publication.
4. Access to project files requires an explicit development file grant. Raw
   `.work-fold/`, preserved legacy `.workspace/`, conversations, `.pi/`, and other excluded metadata roots remain
   ungrantable.
5. A granted resource commit is serialized through the host-owned project
   mutation authority. In one crash-safe operation it writes the file, creates
   project History, advances a durable project-source revision, and invalidates
   every dependent Feature review or publish proposal before acknowledging the
   commit. Recovery must complete or roll back that sequence without exposing a
   new file under an old source revision.
6. A publish operation pins one immutable selected snapshot and source revision,
   never a file concurrently being modified by the development runtime. Its
   final commit rechecks that every selected input and dependent review still
   names that snapshot.
7. Development grants, connections, schedules, and data never transfer to a
   release or release-backed local/hosted App Instance.
8. The development worker, scheduler, broker, and receipts use
   `runtimeInstanceId`, Feature Installation identity, and the typed Authority
   Stamp just like any other runtime.
9. Removing the Development Instance follows its explicit data-retention choice;
   it never deletes project files. Removing or unregistering the Space revokes
   future Development Instance launches.

This preserves a tight edit-review-run loop without pretending source and a
running instance are the same object.

## Gate 3: mutable data and sync

### Accepted semantic decisions

1. **Do not build a work-fold-owned generic “sync the Space.”** Publication,
   project collaboration, instance-data replication, secret storage,
   operational control, and Chat sharing are separate protocols.
2. **Each App Instance belongs to exactly one tenant in the first model.** An
   instance may serve multiple principals, but tenant policy owns its runtime
   boundary.
3. **Feature data uses an explicit data lineage.** A Feature Installation owns a
   separate `dataNamespaceId`; access by a new feature revision or installation
   requires compatibility or an approved migration/adoption, and another
   Feature receives no ambient access.
4. **Data declares an ownership class.** The minimum classes are instance-shared,
   principal-private, and explicitly shared-to-role. “App data” without an owner
   class is invalid for hosted publication.
5. **Connections declare an owner class.** Instance-owned and principal-owned
   bindings have different consent, unattended-use, transfer, and deletion
   semantics.
6. **Secrets do not sync as app data.** A host-owned secret service binds an
   opaque secret reference to the current Runtime Instance, Feature Installation
   and revision, declaration, target, owner, and relevant Authority Stamp fields.
7. **Project source and instance data never share a conflict algorithm.** Project
   collaboration may use file/version-control semantics; instance data uses a
   declared schema, record identity, and concurrency policy.
8. **The first hosted milestone needs publication plus one hosted data service,
   not generalized source sync.** Offline or multi-writer replication remains a
   later, explicitly designed capability.

### Project and Runtime Instance planes

| Concern | Project plane | Runtime Instance plane |
| --- | --- | --- |
| Primary identity | `projectId`, plus an optional authenticated `cloudProjectId` registry binding | `tenantId` and `runtimeInstanceId` |
| Mutable content | Ordinary selected source files and assets | Typed feature records, attachments, preferences, and operational state |
| Executable content | Builder-side `.pi` resources under Space-registration trust; restricted feature source before review | Exact reviewed Feature Revisions staged from source for a Development Instance or pinned by one immutable Release for an App Instance |
| Secrets | No release or runtime secrets | Host-owned instance- or principal-owned bindings |
| History | Source edits and History checkpoints | Data revisions, migrations, grants, jobs, and audit receipts |
| Collaboration | Explicit source roles and selected material | Instance roles and data access policy |
| Deletion | Linked-folder removal versus explicit managed-folder deletion | Instance lifecycle and retention policy; never an implicit project-folder deletion |
| Replication | Optional future project collaboration contract | Optional per-data-class instance replication contract |

No Runtime Instance action may mutate project source except through a separately
granted Development Instance resource operation. No project collaborator gains
runtime data, connections, or administration merely by editing source. Tenant
administration grants no project edit, review, or publish role. Publishing a
release copies no mutable runtime state.

### Tenancy and data ownership

The trusted host derives Tenant, Runtime Instance, Feature Installation,
Principal, Feature Revision, and role from the authenticated execution context.
Feature code may receive bounded descriptive values but cannot choose the
authority scope of a request.

| Data class | Candidate owner | Default visibility | Notes |
| --- | --- | --- | --- |
| Feature shared records | Runtime Instance/Tenant | Allowed instance roles | Stable `dataNamespaceId`; cross-feature reads require a separate declaration and grant |
| Principal-private records | Principal within one instance | Owning principal | Tenant operator access requires a declared support/legal path and audit |
| Role-shared records | Instance with an access policy | Named instance roles or groups | Policy changes are auditable mutations, not data copying |
| Feature preferences | Principal or instance, declared per key/collection | Owner class | Must not drift between classes implicitly across an update |
| Attachments/objects | Same owner as their parent record | Parent policy | Content digest, size, media type, quota, and deletion linkage required |
| Automation state | Instance plus feature/job identity | Instance admins; bounded user status | Control-plane state, not feature JSON storage |
| Run/audit receipts | Tenant control plane | Authorized admins and affected principal where appropriate | Immutable lineage with bounded payloads; never credential values |
| Connections | Instance or principal | Status only to authorized UI; secret never to feature code | Owner class determines unattended-use and deletion rules |
| Telemetry/support evidence | Platform operator under a declared policy | Least-privilege operational access | Separate from product records and disabled/limited according to product policy |

Role-shared data requires a host-enforced declared collection rather than trust
in Feature JavaScript. Each protected collection declaration names a stable
`collectionId`, `dataNamespaceId`, schema digest, owner class (`instance`,
`principal`, or `role-policy`), allowed actions, and one closed policy id. The
release defines each action's maximum (`list`, `read`, `create`, `update`, or a
future separately reviewed `delete`); the App Instance maps policy roles to
Principals. The host derives the effective Principal and roles, evaluates the
declared collection/action policy on every operation, applies data and Principal
generations at commit, and records a bounded receipt. Feature code cannot pass a
role claim, select another owner, or use generic instance storage to bypass a
collection advertised as role- or Principal-isolated. If the portable runtime
cannot enforce these semantics, hosted publication must expose only
instance-shared data and must not promise role isolation.

The data contract must also name controller/operator responsibilities, region,
quota, backup behavior, support access, and data-subject handling before public
hosting. This memo defines product boundaries, not legal compliance.

### Instance-owned and principal-owned connections

An **instance-owned connection** represents a tenant-controlled service account,
webhook, database, or shared integration. An instance admin creates it for one
declared destination. It may support unattended jobs only when the job separately
remains enabled and authorized. It belongs to the current App Instance/Tenant,
not the admin who entered the credential. A Tenant or App Instance ownership
transfer advances the Runtime Instance and connection generations, fences use,
and disconnects the binding by default. The receiving Tenant must create or
rebind its own connection. A provider-supported credential transfer is an
exceptional, explicit, separately consented and receipted transition that creates
a new binding; it is never inferred from instance ownership.

A **principal-owned connection** represents an individual's mailbox, storage,
calendar, or other personal authorization. The principal consents to one feature,
destination, scope set, and instance. It cannot be used as another principal or
silently converted into a tenant connection.

Principal-owned connections are interactive by default. Unattended use requires
a second explicit delegation to one named job, with bounded purpose, current
feature/job declarations, expiry or review cadence, and receipts attributed to
the delegating principal. Removing the principal from the instance, revoking the
delegation, changing the relevant feature/job declaration, disconnecting, or
provider revocation stops new attempts. Queued and retried work revalidates the
current connection and relevant Authority Stamp fields.

Principal-owned connections never transfer with an App Instance, Tenant,
project, or Organization. A transfer or owner removal fences them immediately
and begins their disconnect/provider-revocation workflow according to policy.

Deleting a work-fold binding is not the same as provider-side revocation. The UI
and receipt must say which occurred. Secret values never appear in manifests,
exports, logs, receipts, worker inputs/results, or feature storage.

### Candidate connection binding

```json
{
  "recordVersion": 1,
  "connectionId": "connection_opaque",
  "tenantId": "tenant_opaque",
  "runtimeInstanceId": "runtime-instance_opaque",
  "featureId": "connected-inbox",
  "featureInstallationId": "feature-installation_opaque",
  "featureRevisionDigest": "work-fold.artifact.v1:sha256:<64-lowercase-hex>",
  "declarationId": "mail-api",
  "declarationDigest": "sha256:mail-api-declaration",
  "targetIdentity": "https://api.example.com",
  "owner": {
    "kind": "principal",
    "principalId": "principal_opaque"
  },
  "secretRef": "secret-service-opaque-reference",
  "authorityStamp": {
    "runtimeInstanceGeneration": 4,
    "featureInstallationGeneration": 3,
    "grantGeneration": 7,
    "connectionGeneration": 9,
    "jobGeneration": 2,
    "principalGeneration": 6,
    "dataGeneration": 5
  },
  "status": "active"
}
```

For `owner.kind: "instance"`, the owner carries `runtimeInstanceId` rather than
a Principal id. `secretRef` is meaningful only to the trusted secret service
and must not grant access when copied into another record. A service may persist
only the Authority Stamp fields relevant to the binding, but their field names
and domains remain explicit.

### Publish is not sync

| Operation | Mutable? | Candidate behavior |
| --- | --- | --- |
| Publish | No | Select and review a project snapshot; produce one immutable closed release |
| Install/deploy | App Instance pointer changes | Create or transition a release-backed App Instance with grants off or explicitly continued |
| Project collaboration | Yes | Exchange selected source under project roles and a declared file/version conflict model |
| Instance-data replication | Yes | Replicate declared typed records under tenant, owner, schema, and conflict policy |
| Share | Role state changes | Grant a current principal a project or instance role; copy no content implicitly |
| Export | Snapshot | Produce a bounded portable copy of selected data and metadata without secrets |
| Backup | Snapshot/operational | Service-controlled recovery copy with retention and restore authority, not a user collaboration stream |

The following stay out of work-fold-owned publication, project collaboration,
and instance-data synchronization streams:

- `.pi/` and all other executable project configuration. A future collaboration
  path for it must be a separate full-trust act with code-execution consequences.
- `.work-fold/conversations/`, preserved legacy `.workspace/` content, Chat attachments, compaction state, and Pi
  sessions. Chat sharing requires its own consent, participant, model-provider,
  retention, and deletion contract.
- raw `.work-fold/space.json`. It can help reconcile a moved folder locally but
  cannot claim a cloud project, tenant, role, or publication right.
- personal Library storage. Only an explicit independent copy into the Space may
  later be selected as ordinary project input.
- provider credentials, app connection values, local encrypted stores, instance
  secrets, and signing material.
- local History objects, machine registry state, cached views, run queues, and
  updater state.

These exclusions govern work-fold-owned streams only. A Space remains an
ordinary folder: Google Drive for desktop, source control, backup software, or
another third-party synchronization tool may still copy `.work-fold/`, its
conversations, `.pi/`, and any other folder content under that tool's settings.
work-fold must retain the current privacy warning and must not describe those
third-party copies as native work-fold sync.

The first source-collaboration design should explicitly select paths and either
use an existing version-control model or define per-file base versions and
conflict artifacts. It must not silently choose last-writer-wins for arbitrary
ordinary files. The first instance-data model should declare record ids,
revisions, ownership, and whether writes use compare-and-swap, server ordering,
or a domain-specific merge. “Eventually consistent” is not a conflict policy.

## Data migrations, activation, and rollback

A data migration is executable authority and its exact artifact is part of the
reviewed release closure. Execution depends on Gate 4 defining a separate,
restricted **Migration Invocation**. It is not a normal Feature worker, App
Instance grant, reviewer privilege, or instance-admin data-reading session.
Each migration declares:

- one feature id and exact source/target schema ids, versions, and digests;
- its own artifact digest and runtime compatibility;
- whether it is online or requires a maintenance fence;
- resource and time bounds;
- the data namespaces it may read and write;
- no network, connection, or notification access by default;
- idempotency/resume behavior;
- verification steps and observable receipt states; and
- whether a reviewed reverse migration exists, without claiming reversibility
  merely because one is declared.

The trusted host creates each Migration Invocation from the accepted update
plan. Its envelope binds `runtimeInstanceId`, `featureInstallationId`, current
and target Feature Revision digests, exact migration artifact digest, exact
source/target schema digests, enumerated `dataNamespaceId` values, owner classes,
resource/time bounds, invocation id, cancellation signal, and the typed
Authority Stamp. The migration sandbox receives only host-brokered reads/writes
inside those namespaces. Every commit revalidates the Runtime Instance, Feature
Installation, Principal, data, and grant generations and produces a bounded
receipt. Cancellation fences future commits; termination follows a bounded host
grace period.

Owner-class protection remains active during migration. Instance-shared and
role-policy collections are processed under a scoped host service Principal and
the reviewed collection policy. Principal-private namespaces are enumerated and
processed by the host without exposing their contents to the instance admin or
another Principal; the release's data policy must disclose this schema-processing
path before those records are created. A migration cannot change an owner class,
merge Principal namespaces, or adopt a retained `dataNamespaceId` unless the
reviewed plan explicitly names that transition and its authorization. Gate 4 is
incomplete until its broker, cancellation, fencing, and receipts can enforce
these rules.

Cross-feature migrations require an explicit dependency graph and review of the
combined authority. Cycles are rejected. A release transition activates as one
instance-level change: feature bytes do not become independently live while the
instance is half-migrated.

The candidate update sequence is:

1. verify the target release closure, policy status, and runtime compatibility;
2. compute a per-feature continuity/reset/migration plan and show it before
   mutation;
3. fence old jobs, workers, broker calls, and conflicting writes with a new
   typed Authority Stamp;
4. create the declared recovery snapshot or backup and record its limitations;
5. run migrations in the reviewed order with bounded receipts;
6. verify target schemas and invariants;
7. atomically switch the active release pointer and authority plan; then
8. resume eligible views and jobs under freshly validated authority.

Rollback has three honest modes:

- **code rollback:** the prior release can read the current schema without data
  change;
- **reverse migration:** an explicitly reviewed reverse path succeeds before the
  old code is activated; or
- **snapshot restore/fail-forward:** restore a pre-update snapshot with a stated
  data-loss window, or keep the instance fenced while a corrective release is
  prepared.

If none is safe, the product must not offer a one-click rollback. A failed
irreversible migration leaves the instance in a visible maintenance or recovery
state rather than running a mismatched mixture of code and data.

### Candidate update plan record

```json
{
  "recordVersion": 1,
  "runtimeInstanceId": "runtime-instance_opaque",
  "fromReleaseDigest": "sha256:release-one",
  "toReleaseDigest": "sha256:release-two",
  "features": [
    {
      "featureId": "connected-inbox",
      "featureInstallationId": "feature-installation-inbox",
      "dataNamespaceId": "data-namespace-inbox",
      "plannedAuthorityStamp": {
        "runtimeInstanceGeneration": 10,
        "featureInstallationGeneration": 8,
        "grantGeneration": 12,
        "connectionGeneration": 6,
        "jobGeneration": 9,
        "principalGeneration": 4,
        "dataGeneration": 11
      },
      "revisionDecision": "changed",
      "grants": "reset",
      "connections": "reset",
      "jobs": "reset",
      "data": {
        "decision": "migrate",
        "migrationDigest": "sha256:migration-v1-to-v2"
      }
    },
    {
      "featureId": "garden-calendar",
      "featureInstallationId": "feature-installation-calendar",
      "dataNamespaceId": "data-namespace-calendar",
      "plannedAuthorityStamp": {
        "runtimeInstanceGeneration": 10,
        "featureInstallationGeneration": 5,
        "grantGeneration": 3,
        "connectionGeneration": 2,
        "jobGeneration": 7,
        "principalGeneration": 4,
        "dataGeneration": 6
      },
      "revisionDecision": "unchanged",
      "grants": "eligible-to-retain",
      "connections": "eligible-to-retain",
      "jobs": "eligible-to-retain",
      "data": {
        "decision": "compatible"
      }
    }
  ],
  "rollback": {
    "mode": "snapshot-restore",
    "maximumDataLossSeconds": 0
  }
}
```

“Eligible to retain” still requires current instance policy and current owner
consent at activation time. It never means a publisher can force continuity.

## Retention, export, and deletion

Lifecycle verbs remain distinct:

- **suspend** stops new hosted execution while retaining declared state;
- **disconnect** deletes a work-fold-held connection binding but may not revoke
  the provider credential;
- **uninstall** removes one release-backed local App Instance and applies its
  runtime-data policy without deleting project source, user-selected resource
  targets, or remote provider data;
- **delete instance** fences execution and begins the instance's data-retention
  workflow;
- **delist** removes discovery without deleting releases or existing instances;
- **block new installs** and **block new launches** are separate safety actions;
- **purge** irreversibly removes eligible service-held bytes after retention and
  backup obligations permit it.

Every hosted data class needs an explicit record of owner class, region, quota,
active retention, soft-delete window if any, backup retention, export format,
and final purge behavior. Defaults must be visible before an instance is created.

| Data | Export candidate | Delete behavior candidate |
| --- | --- | --- |
| Project source | Ordinary selected files plus a manifest of paths/digests | Cloud collaboration copy follows project policy; linked local folder is never deleted implicitly |
| Release | Release envelope, closure, provenance, and public review metadata | Immutable registry retention/delisting policy; cannot recall offline copies |
| Feature records | Versioned JSON/NDJSON plus content-addressed attachments and schema metadata | Tombstone/fence, retention window, backup expiry, then purge |
| Principal-private data | Same portable format, filtered to the principal and instance | Delete/anonymize according to declared app and tenant policy without deleting shared records owned by others |
| Connections | Non-secret status, owner class, destination, and timestamps | Destroy local/service secret reference; separately report provider revocation status |
| Jobs and receipts | Versioned bounded receipt stream | Retain under audit policy after payload data deletion; never retain secrets or request bodies |
| Backups | Recovery metadata, not ordinary end-user export | Expire on a documented schedule; restores must reapply current tombstones and advance the relevant Authority Stamp fields |

Exports include record/schema versions, `runtimeInstanceId`,
`featureInstallationId`, `dataNamespaceId`, owner scope, release and Feature
Revision digests, timestamps, attachment hashes, and pagination/completeness
metadata. They exclude secret values, access tokens, internal encryption keys,
unrelated Principals' private data, and platform-only abuse signals. Export
generation is itself an authorized, auditable action with bounded staging and
expiry.

Instance deletion should fence launches, queued jobs, retries, notifications,
and connection use before acknowledging the request. It then records a deletion
receipt, destroys or schedules destruction of connection bindings, applies each
data class's retention policy, handles domains and webhooks, and makes backup
expiry visible. Restoring a backup must not restore revoked roles, grants,
connections, jobs, installation incarnations, or old Authority Stamp values.

Local behavior remains understandable without assuming that a release-backed
local App Instance owns, lives inside, or even has a project folder. Uninstalling
it always removes host-owned runtime authority and local connection records and
then applies the confirmed retain-or-purge choice to each local Data Namespace;
it never deletes separately selected ordinary resource targets. Retained local
namespaces are inactive and visible to the source Project for a later explicit
purge; adoption and export are not implemented. Only a Development Instance is
source-bound to an App Project and source Space, while a local App Instance is
attached to its chosen target Space. work-fold blocks removing either
registration while that release-backed Instance remains active and directs the
person to uninstall first. Retained data continues to bind the source Project
until explicit purge, but not the former target. A future hosted contract must
not weaken those distinctions.

### Gate 3 risks

- A work-fold-owned generic sync engine can accidentally upload Chats,
  executable `.pi` configuration, credentials, or unrelated ordinary files.
- Incorrect tenant derivation or cache keys can create cross-tenant disclosure.
- Principal-owned credentials can become de facto shared service accounts through
  unattended jobs.
- Migrations can cause irreversible loss or make rollback impossible.
- Offline replicas and stale queues can replay writes after role or grant
  revocation.
- Backup restore can resurrect deleted data or stale authority.
- Ambiguous ownership makes export and deletion incomplete or destructive to
  another principal's shared data.
- Retained audit records can become an undeclared secondary store of sensitive
  payloads.
- Region, provider, and support-access choices can create promises the first
  hosted service cannot keep.

### Gate 3 acceptance criteria

The foundation accepts these as semantic design and product-launch criteria.
The local foundation implements only the criteria named for its scoped
milestone; a production hosted product must satisfy every applicable item with
real adapters and operating policy before launch:

- every stored or transmitted data class has an owner, tenant, scope, region,
  `dataNamespaceId` or declared collection where applicable, quota, schema,
  retention, export, and deletion rule;
- project source, release artifacts, instance data, secrets, Chats, Library,
  History, and operational receipts have separate flows and authorities;
- `projectId`/project roles and `cloudProjectId` registry binding remain separate
  from Tenant/runtime roles, and Tenant never owns source authority;
- a client-supplied Tenant, Principal, Runtime Instance, Feature Installation,
  Feature, data namespace, collection, or owner id cannot select authority;
- role-shared collections and actions are enforced by the host from declared
  policy and current roles rather than by Feature code alone;
- instance-owned and principal-owned connection journeys cover consent,
  unattended use, revocation, role removal, Tenant transfer, update, export, and
  deletion;
- Development Instance writes cannot alter reviewed bytes or publish inputs
  without one crash-safe serialized commit advancing project source revision,
  invalidating the affected proposal, and creating History;
- update fixtures prove unchanged-feature continuity and changed-feature reset,
  including installation incarnation, data namespace disposition, and
  target/declaration changes under stable ids;
- migration tests cover success, crash, retry, cancellation, concurrency,
  owner-class isolation, irreversible change, snapshot restore, and fail-forward
  recovery through the Gate 4 Migration Invocation contract;
- deleting a Runtime Instance fences effects before acknowledgment and a backup
  restore cannot resurrect revoked Authority Stamp values, installation
  incarnations, or data access;
- exports are complete, versioned, integrity-checkable, and secret-free;
- offline and queued operations have documented expiry, fencing, conflict, and
  reconnection behavior; and
- the first private hosted journey works without generalized folder sync or an
  account requirement for unrelated local Spaces.

## Design and implementation fixtures

The design was evaluated with all five paper fixtures. Versioned implementation
must turn each fixture into executable evidence before the product behavior that
depends on it ships:

1. **Connected inbox:** one feature changes its worker and mail declaration while
   a second feature stays byte-for-byte unchanged; verify per-feature grant,
   connection, job, storage, migration, and receipt decisions.
2. **Community garden:** coordinators share instance-owned supplier data, members
   keep principal-private contact preferences, one reminder job uses an
   instance-owned notification adapter, and no account is needed for the local
   folder or Development Instance.
3. **Hostile continuity fixture:** reuse the same feature and declaration ids while
   changing bytes, origin, OAuth scopes, notification copy, or a job permission
   subset; every affected authority must reset.
4. **Deletion and restore fixture:** delete one Principal, then the App Instance;
   restore an old backup and prove tombstones, role revocation, secret deletion,
   installation incarnation, and typed Authority Stamp values prevent
   resurrection.
5. **Excluded-content fixture:** place `.pi`, `.work-fold/conversations`, preserved legacy `.workspace/`, local
   History, a Library pointer, a credential-like value, a symlink, and a mutable
   external asset near selected source; release closure must exclude or reject
   them with an understandable reason.

Passing a paper fixture does not authorize a hosted product claim. The accepted
decisions have moved into the authoritative product, runtime, architecture,
security, privacy, and release contracts, while the foundation document records
which executable subset exists and which launch gates remain open.
