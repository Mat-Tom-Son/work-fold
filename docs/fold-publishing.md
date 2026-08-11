# The fold: the publishing ladder and the viewer

**Status: proposal.** Nothing in this document is implemented or decided.
[Product model](product-model.md) remains the decision register (with
[App platform foundation](app-platform-foundation.md) for rung 3's App
semantics); when this ships, decisions are promoted there and this document
shrinks.

This is one of the fold design set: [the fold](fold.md) (naming and doctrine),
[act ledger](fold-act-ledger.md) (direct verbs, journal, receipts),
[consecrations](fold-consecrations.md) (staged acts, needs-you decisions,
standing policies, the never-list), [routings](fold-routings.md),
[glance](fold-glance.md), and [integration](fold-integration.md) (amendments
to canonical docs). Amendments to `README.md`, `SECURITY.md`, `PRIVACY.md`,
and `docs/product-model.md` implied here are drafted in
[fold-integration.md](fold-integration.md), not applied by this document.

## What we are trying to accomplish

The fold is the one door to all your Spaces: material comes in through it, and
with this design, pages go out through it. Today the only people who can see
anything through the bridge are you — on this desktop or in a browser you
explicitly approved with a matched six-digit code. That is the right boundary
for management authority, and it stays. But "show this one report to my
client" should not require handing anyone management authority, and it should
not require a cloud copy of your Space.

The destination is a three-rung ladder, where each rung reuses the trust
machinery beneath it and adds the smallest new thing:

| Rung | What a person gets | New trust surface |
|---|---|---|
| 1 | The glance on your phone | None — existing approved-browser grant |
| 2 | One file served as a rendered page at your address | The **viewer**: link-scoped, read-only, per-published-item |
| 3 | A restricted-app Release served to viewers at your address | The same viewer class over a narrow, desktop-enforced broker subset |

The honest sentence for all three rungs is **"pages your fold serves"** —
served live from your desktop, through the relay, while your desktop is
online. It is never "host your website": there is no uptime promise, no
public discovery, no App Store, and an offline desktop is honestly asleep,
not silently stale.

## The viewer: a new audience class

A **viewer** is anyone holding a share link. Viewers are deliberately not a
smaller kind of approved browser; they are a different species:

| | Approved browser | Viewer |
|---|---|---|
| Identity | Non-exportable P-256 keys, desktop-signed grant | None — possession of one link |
| Scope | The whole management conversation and Space trees | Exactly one published item |
| Direction | Can prompt a full-trust Assistant | Read-only, always |
| Pairing | Password + matched six-digit code + desktop click | None |
| Management lane | Yes — `management.*`, `spaces.*` operations | Never — a disjoint operation set on a disjoint origin |
| Revocation | Per browser, per generation, whole connection | Per published item, instantly, regardless of who holds links |

A **viewer grant** is the desktop-side authority record behind one published
item. Its properties, all load-bearing:

- **Per-published-item.** One grant covers one publication slot (rung 2) or
  one hosted App Instance's viewer surface (rung 3). There is no account-wide
  viewer authority and no "publish everything" switch.
- **Read-only.** No operation reachable by a viewer mutates anything on the
  desktop. Rung 3 enforces this in the broker, not in app code.
- **Link-scoped.** The link is the whole credential. Forwarding the link
  forwards the access; that is the intended semantics, stated plainly in the
  publish decision card. There are no viewer accounts, sessions, or cookies.
- **Revocable.** Revoking the grant kills every copy of the link at once,
  desktop-first (ordering below). Possession of a revoked link is possession
  of nothing.
- **Receipted.** Creating, rebinding, re-budgeting, and revoking a grant are
  journaled acts with durable receipts under the
  [act ledger](fold-act-ledger.md) contract. Serving a page to a viewer is a
  read, not a mutation: it is **counted** (bounded aggregate tallies the
  glance can show), never journaled per-request — an unbounded receipt stream
  would be its own denial-of-service.

A viewer is not a Principal. The App platform's Principal kinds (human,
agent, service, system) all name authenticated actors; a viewer is an
unauthenticated audience. Rung 3 therefore never resolves a viewer to a
Principal, never evaluates roles for one, and never lets one reach
Principal- or role-owned data (`src/local/agent/private-hosted-app-service.ts`
keeps its host-derived-Principal rule untouched).

## Publishing is a consecration

The brief flags outward exposure as power-widening. This document lands it:
**creating outward viewer exposure is consecration 2 — widen a power.** The
set of principals who can reach content your desktop serves widens from "you
and browsers you approved by matched code" to "anyone holding a link." That
is precisely the shape of the existing grant family (a network destination in
reverse: an ingress audience instead of an egress origin), and it gets the
same ceremony: the fold may **stage** a publication — fully prepared,
inspectable, inert — and a person approves it as a needs-you decision with an
unforgeable click. Staged publications expire; expiry is not approval; denial
is recorded, not retried.

Two verbs unfortunately share the English word "publish" and must not share a
ceremony:

- **Publish a Release** (App Studio) is a local state transition — it marks a
  prepared Release eligible for local installation and uploads, hosts, lists,
  and grants nothing (`docs/app-platform-foundation.md`, "Publish is not
  sync"). It stays a **direct receipted verb** in the fold's ledger. Nothing
  leaves the machine; no audience widens.
- **Serving to viewers** — activating a rung-2 page slot, or installing a
  rung-3 App Instance hosted at your address — is the consecration. UI copy
  avoids the collision: App Studio keeps "Publish Release"; the outward act
  is **"Share a page"** / **"Put this app at your address."**

Consequences, consistent with the rest of the fold doctrine:

- **Remote clicks count.** A publish decision may be approved from the
  desktop or from any approved browser. The decision receipt records the
  approving surface and exact browser grant; revoking a browser cancels its
  pending decisions, including pending publish decisions.
- **The never-list is untouched.** Publishing rides the existing Remote
  access account. Enrollment, address changes, browser approval, and
  disabling Remote access remain desktop-human-only. The fold cannot
  bootstrap an address in order to publish to it: staging a publication with
  no enrolled address fails with a typed `no-address` state and the needs-you
  card never appears. Setting up "your fold on the web" is a person-only
  prerequisite.
- **Not policy-eligible.** Standing policies can pre-approve narrow
  consecration categories, but outward exposure is deliberately excluded:
  it is the one category whose blast radius includes people who are not you.
  Every new exposure takes a click. (Revocation, as always, takes none.)
  [Consecrations](fold-consecrations.md) encodes this in the policy schema
  itself — `publish.viewer.expose` is not a policy-eligible kind, and the
  policy store rejects it.
- **Narrowing never needs a click.** Revoking a publication, cutting its
  budgets, and turning snapshot caching off are direct receipted verbs.
  Widening — a new slot, a rebound source, raised budgets, snapshot caching
  on — is a fresh consecration.

## Rung 1 — the glance on your phone

Rung 1 is not a publishing feature and introduces no viewer. It is the
[glance](fold-glance.md) — the deterministic digest of running work,
needs-you items, and what changed — rendered at the top of the approved
remote client's home. Same approved-browser grant, same envelope encryption,
zero new audience. It is the ladder's floor because it proves the value of
"see your fold from your phone" with no new trust surface at all, and because
its needs-you cards are where remote publish approvals (above) surface.

## Rung 2 — share a page

### The publication object

A **publication** is a machine-local record binding:

- a **slot**: a high-entropy `publicationId`, minted at activation, which is
  the stable path segment of the share link;
- a **source**: one exact Space-relative file in one registered Space,
  designated explicitly at staging (`--space` plus relative path — never a
  folder, never a glob, never "the Space");
- a **key**: a 256-bit AES-GCM publication key generated desktop-side at
  activation and stored with the other Remote access material in
  operating-system-encrypted secure settings (`desktop/src/settings.ts`);
- a **title**: person-visible page title, shown in the decision card,
  carried inside the encrypted payload — the bridge never stores it;
- **budgets and flags**: serve-rate and byte budgets, optional expiry,
  snapshot opt-in (default off).

The share link — viewer origin, path, and fragment key — is composed on
demand from secure settings and shown transiently to the person. Because the
link is the whole credential, it is treated as one: the full link and the
key appear in no receipt, journal, log, glance item, or management-request
action trail, per the act ledger's rule that receipts never contain
credentials. Receipts and listings identify a publication by
`publicationId` and its viewer origin and path only.

The page a viewer sees is the **current** content of the designated file,
rendered at serve time. That is the product's point — a live page, not an
upload — and it is also the exposure statement: the person is exposing that
file's evolving content, exactly as designating a file for a Check exposes
that file to a sensor. Content evolution is not a new consecration; changing
**which** file backs the slot is. The fold rewriting the designated file is
an ordinary in-Space mutation already covered by the act ledger and History
restore points, so it is visible and reversible.

First-slice rendered types are a closed set: Markdown and plain text
(rendered desktop-side into one self-contained HTML body), PNG, JPEG, and
PDF. Person-authored HTML and anything interactive is deliberately deferred
to rung 3 — an app is the vehicle for script, so rung 2 pages can stay inert.
SVG is excluded from the first slice because it is scriptable.

Publication records are machine-local application state, like the Space
registry and Remote access settings. Nothing about a publication is written
into the Space folder: a synchronized folder must not leak "this file was
shared," and portable data must never carry authority. History does not
capture publication records. Unregistering or deleting a Space that backs
live publications is blocked until they are revoked, and the removal flow
names them — the same shape as the existing App Instance removal block.

### The serving path

1. A viewer opens `https://pages-<slug>.work-fold.com/p/<publicationId>#<key>`.
2. The bridge serves the static **viewer shell** from a new
   `services/bridge/public/viewer/` bundle: no cookies, no storage, strict
   CSP, `robots.txt` disallowing everything.
3. The shell requests `GET /api/viewer/pages/<publicationId>`. The fragment
   never leaves the browser.
4. The bridge checks the slot row (exists, active, within budgets) and the
   desktop socket. Offline → typed `asleep` (or the snapshot, if opted in).
   Online → it forwards a `viewer.fetch` frame on the existing device
   WebSocket.
5. The desktop **rechecks the local grant immediately before serving**
   (the same effect-time discipline as `WorkFoldRemoteFacade` and the
   restricted-app brokers), re-reads the designated file with the ordinary
   no-follow/identity checks, renders within hard bounds, encrypts with the
   publication key (fresh IV; AAD binds `publicationId`, the rendered-content
   digest, and the serve timestamp), signs the envelope with the device
   signing key, and returns a `work-fold.viewer-page.v1` response frame.
6. The bridge verifies the device signature (admission hygiene, exactly as it
   verifies `work-fold.remote-response.v1` today), buffers the bounded
   ciphertext briefly, and completes the viewer's request.
7. The shell decrypts with the fragment key and renders the inert document.

The viewer's authenticity anchor is the publication key itself: a payload
that authenticates under AES-GCM with the key from the person's own link came
from the holder of that key — the desktop. The device signature exists for
the bridge's admission and caching hygiene, not as a viewer-side trust chain.

### The key design decision: fragment keys with relayed ciphertext

Three candidate designs, judged against the bridge's current posture —
content crosses the bridge only inside signed application-encrypted
envelopes, protecting persisted relay state and passive handling, explicitly
not an actively compromised hosted origin (`services/bridge/README.md`,
`SECURITY.md`):

1. **URL-fragment keys, bridge-relayed ciphertext** (chosen). The key rides
   in the link fragment; the bridge sees slot metadata and ciphertext sizes,
   never page bytes. Page content stays out of the database, logs, and every
   passive handling path — the exact property the envelope design already
   buys for management traffic, extended to viewers without inventing viewer
   key exchange.
2. **Bridge-visible content with explicit labeling.** Simplest, but it breaks
   the content-free-by-default culture for an entire traffic class and makes
   every page transit plaintext at the relay. Rejected as the default. The
   snapshot cache below is the one deliberate, opt-in, labeled instance of
   relay retention — and even it stores ciphertext.
3. **Desktop-signed short-lived viewer tokens.** Tokens change *who may ask*
   the bridge to relay, not *what the bridge sees*; content would still
   transit in plaintext unless combined with option 1, minting requires the
   desktop online (which a viewer fetch requires anyway), and it pushes
   authorization logic into the bridge that the desktop-first recheck already
   owns. Nothing it buys is needed by a link-scoped grant; revocation
   granularity is already per-publication.

**Residual risk, stated honestly.** The bridge serves the viewer shell's
JavaScript, so an actively compromised bridge or hosted origin can serve a
shell that exfiltrates `location.hash` and read pages fetched from then on —
and, combined with stored snapshot ciphertext, pages cached earlier. This is
the same class of first-load-web-trust risk the alpha already accepts and
documents for the approved-browser client, with strictly smaller blast
radius: a stolen publication key opens one published page, never management
authority. Separately, anyone who obtains a full link (forwarded mail, chat
history) is a legitimate viewer until revocation — that is the meaning of
link-scoped, and the publish card says so. A public/full-trust release of
publishing inherits the same requirement already recorded for Remote access:
a pinned client or an authority design that does not grant mutable first-load
web code this power.

### Origin isolation is a hard requirement

Published viewer content must not share origin, cookies, or keys with the
approved-browser client. The management client's authority material is
origin-scoped: the `__Host-` session cookie is host-only, and the approved
browser's non-exportable keys live in IndexedDB for `<slug>.work-fold.com` —
any script on that origin could *use* them. So viewer content never appears
on that origin, structurally:

- **Viewer origin:** `https://pages-<slug>.work-fold.com`. One extra label
  keeps it inside the existing `*.work-fold.com` wildcard certificate.
  Because slugs may contain hyphens, the bridge must reserve the namespace:
  enrollment rejects the exact slug `pages` and any slug beginning `pages-`,
  as real prefix logic in `isValidSlug` — not merely new entries in the
  exact-match `reservedSlugs` set (`services/bridge/database.mjs`).
- **Host routing diverts `pages-*` first.** The bridge routes every
  `pages-*` host to the viewer plane **before** personal-account slug
  resolution — today `requestSlug` (`services/bridge/server.mjs`) would
  resolve `pages-foo.work-fold.com` to a personal account named `pages-foo`
  and serve the management sign-in there, which is exactly the
  origin/cookie/key co-location this section forbids. A `pages-*` host
  serves viewer routes or nothing; the management client is never served on
  one. Enrollment has been switch-controlled for the whole private alpha, so
  no colliding `pages-` address is expected; if a legacy `pages-<slug>`
  account exists anyway, the viewer origin for account `<slug>` is contested
  and the migration fails closed for **both** accounts — neither
  `pages-<slug>` nor `<slug>` can publish until the `pages-` account is
  renamed. Both keep every non-publishing capability.
- The viewer origin never sets a cookie, never offers sign-in or pairing,
  never serves the management client bundle, and writes no browser storage.
  The management origin never serves viewer content. The `__Host-` cookie
  cannot be sent cross-host by construction; the browser keys cannot be
  reached from an origin that never runs with them.
- Within one account, rung 2 pages are inert documents. Rung 3 app content
  additionally runs inside a sandboxed iframe **without**
  `allow-same-origin`, so each app instance renders with an opaque origin:
  no shared storage between two published apps, and no origin-scoped state
  at all — app state lives desktop-side behind the broker, where it already
  is.

### Honest states

- **Asleep.** Desktop offline, no snapshot: the shell renders "This page is
  served by `<slug>`'s work-fold desktop, which is asleep right now. Try
  again later." HTTP 200, typed state, no pretending.
- **As of.** Desktop offline, snapshot opted in: the cached page renders
  under a persistent "as of `<time>`" banner. Never presented as live.
- **Not available.** Desktop online but the source file is missing, moved,
  oversized, or failed identity checks: viewers get a deliberately vague
  "This page isn't available right now." The person gets the precise reason
  as a change item in the [glance](fold-glance.md) — the page's problem is
  the publisher's information, not the audience's.
- **Resting.** A budget is exhausted: "This page has had a lot of visitors
  today. Try again later." Also surfaced to the person in the glance.
- **Nothing here.** Unknown `publicationId`, revoked slot, or a viewer host
  whose account does not exist: one identical "Nothing is published here."
  page. Slot ids are high-entropy, and this mirrors the login surface's
  address-enumeration posture — an outsider cannot distinguish revoked,
  never-existed, or wrong-account.

### Snapshot caching: explicitly labeled, default off

By default the bridge retains viewer content only as an in-flight response
buffer with a short expiry, exactly like operation events today. Opting a
publication into **snapshot caching** stores the latest served ciphertext
(one bounded row per publication) so the page survives desktop sleep. The
opt-in lives in the publish decision card and in the publication's settings,
labeled plainly: "Keep an encrypted copy at the relay so this page stays
readable while your desktop sleeps. The relay stores it encrypted and cannot
read it; anyone with the link still can." Turning it on is a widening
(consecration); turning it off is a direct verb and deletes the stored row.
After a successful live serve, the desktop refreshes the snapshot in the same
device-frame exchange — a counter-tracked sync, not a separate receipted act.
Revocation and address removal delete snapshots with confirmation semantics
(below). The trust section's residual-risk sentence applies to snapshots
verbatim: ciphertext at rest protects against persisted-state and passive
compromise, not an actively malicious origin that has also captured keys from
later viewer loads.

### Revocation ordering

Same discipline as browser-grant revocation — desktop-local authority first,
server state second, cleanup lanes independent:

1. Mark the grant revoked in the desktop's publication store. From this
   instant the effect-time recheck refuses every new `viewer.fetch`,
   regardless of bridge state. An in-flight render may complete its already
   bounded response, mirroring the late-signed-result rule for operations.
2. Delete the bridge slot row and any snapshot row. New viewer requests now
   get "Nothing is published here" without waking the desktop.
3. Write the terminal receipt. If bridge cleanup could not be confirmed, the
   receipt honestly records `bridgeCleanup: pending` and the desktop retries
   on reconnect and at startup — the same posture as address removal, which
   keeps its device credential until server deletion is confirmed. A pending
   snapshot deletion is named in the receipt because it is the one case
   where relayed bytes could outlive desktop authority.

Disabling Remote access or deleting the address revokes every publication as
part of its existing cleanup lanes; publications cannot outlive the account
they are addressed under.

### Abuse bounds

Viewer traffic is unauthenticated by design, so the bridge's
bounded-everything culture applies before anything reaches the desktop.
Starting bounds (tunable constants beside the existing envelope and SSE
budgets in `services/bridge/server.mjs`, enforced per process like today's
single-replica limits):

| Bound | Starting value |
|---|---|
| Viewer requests per IP | 60/min across an account's publications |
| Concurrent `viewer.fetch` per publication | 4 |
| Dispatched `viewer.fetch` per account | 120/min |
| Rendered page ciphertext | 2 MiB per response |
| Viewer in-flight ciphertext, global | 64 MiB |
| Bytes served per publication per day | 256 MiB, then `resting` |
| Snapshot rows | 1 per publication, ≤ 2 MiB, ≤ 16 MiB per account |
| Publications per account | 32 |

Desktop-side bounds: source file ≤ 8 MiB pre-render, bounded render time
under the ordinary abort discipline, and one render at a time per publication
(concurrent viewer fetches for the same slot coalesce onto one render).
Budget exhaustion is a typed viewer state and a glance item, never a silent
drop. The minute-interval `work-fold.bridge.metrics.v1` record gains
aggregate viewer counters (request rate, active fetches, snapshot bytes,
budget exhaustions) with the existing rule intact: no ids, addresses,
tokens, ciphertext, or content.

### The mutation ledger

Every publishing mutation answers the five questions from the
[act ledger](fold-act-ledger.md). Serving is a read and appears here only
where it touches durable state (snapshot refresh).

| Mutation | Kind | Journaled | Receipt contains | Revocation / undo | Mid-act failure | Replay prevention |
|---|---|---|---|---|---|---|
| Stage a page publication | Fold act (inert) | `accepted` before staging | Staged-decision id, Space id, relative path, title, budgets, snapshot flag | Staged act expires or is withdrawn; denial recorded | Nothing external exists; a lost stage is re-staged | Act-lane request ids, journal-first at-most-once (`src/local/cli/act-receipts.ts`) |
| Approve / deny the publish decision (page or hosted app) | Human click (desktop or approved browser) | Decision record | Decision, approving surface + browser grant id, staged-act digest | A denial is terminal; browser revocation cancels its pending decisions | Unclicked decisions expire | Decision ids single-use; the click binds the exact staged digest |
| Activate publication | Host act after approval | Durable intent before key mint and bridge sync | `publicationId`, source, viewer origin and path — never the fragment key or the full link, which is shown to the person transiently and journaled nowhere — budgets, bridge sync outcome | Revoke verb, any time | Two-phase: local record commits first; bridge slot creation retried by operation id; not presented as live until bridge confirms | Bridge slot upsert idempotent by operation id (`UNIQUE` on it); startup recovery re-drives or cancels the intent |
| Rebind source / raise budgets / snapshot on | Consecration (widen) | As stage + decision above | Old and new binding, old and new budgets | The previous binding's receipt chain is the undo reference; narrowing back is a direct verb | Same two-phase as activation | Same as activation |
| Cut budgets / snapshot off | Direct verb | `accepted` before mutation | Old and new values; snapshot-deletion outcome | Raising again is a consecration | Bridge sync retried; local narrowing already effective | Operation-id idempotence |
| Revoke publication | Direct verb | `accepted` before mutation | `publicationId`, ordering outcomes, `bridgeCleanup: ok\|pending` | This is the undo; re-publishing mints a new slot, key, and link | Desktop-first; bridge cleanup retried until confirmed | Revocation is idempotent; a second revoke is a no-op receipt |
| Snapshot refresh (serve-time) | Bounded sync, not an act | Not journaled; counter-tracked | — (aggregate counters only) | Snapshot off / revoke deletes the row | A failed refresh leaves the previous snapshot; staleness is visible in "as of" | Refresh carries the serve's content digest; the bridge keeps newest-wins by digest + timestamp |
| Stage hosted-app exposure (rung 3) | Fold act (inert) | `accepted` before staging | Staged-decision id, App Instance id (or the prepared install operation id when staged with an install), exact Release digest, viewer entry, the complete viewer-readable surface, budgets | Staged act expires or is withdrawn; denial recorded | Nothing external exists; a lost stage is re-staged | Act-lane request ids, journal-first at-most-once |
| Activate hosted-app exposure | Host act after approval | Durable intent before bridge slot creation (kind `app`) | `publicationId`, App Instance id, Release digest, viewer origin and path — never keys or full links — bridge sync outcome | Revoke verb, any time | Same two-phase as page activation | Same operation-id idempotence |
| Widen a hosted app's viewer surface (update) | Consecration (widen) — a reviewed update that widens the viewer-readable surface or changes the viewer entry stages a fresh `publish.viewer.expose`; an unchanged viewer surface rides the normal update-review lane | As stage + decision above | Old and new viewer surface, old and new Release digests | Rolling the update back narrows again; narrowing is a direct verb | Same two-phase as activation | Same as activation |
| Revoke hosted-app exposure | Direct verb | `accepted` before mutation | `publicationId`, ordering outcomes, `bridgeCleanup: ok\|pending` | This is the undo; the Instance keeps running locally without an audience, and re-exposing is a fresh consecration | Desktop-first; bridge cleanup retried until confirmed | Idempotent, as page revocation |

Re-publishing after revocation deliberately creates a **new** slot, key, and
link. Old links stay dead. Key rotation is therefore spelled
"revoke, then share again."

## Rung 3 — an app at your address

Rung 3 installs a restricted-app Release as an App Instance whose placement
is **hosted at your address**: the reviewed app's UI is served to viewers
through the same desktop → relay → viewer path as rung 2, and every power the
app exercises is brokered desktop-side. It is the App platform's
`host: local | hosted` distinction with the desktop as the host — no
work-fold cloud runtime is introduced.

Installing a hosted-at-address Instance follows the existing App Studio
two-phase prepare/activate operation, plus the outward-exposure consecration:
the decision card names the app, the exact Release digest, the viewer
address, and the complete viewer-readable surface (below). All other powers
start off, exactly as local installs already behave. The install itself
answers the five mutation questions through the App Studio rows of the
[act ledger](fold-act-ledger.md); the exposure — staging, decision,
activation, widening on update, and revocation — answers them in the
mutation ledger above, with the hosted-app pin shape
(`publish.viewer.expose` pins App Instance id, exact Release digest, viewer
entry, and the complete viewer-readable surface).

### Which broker domains are viewer-safe

Enforced in the desktop's viewer adapter, never in app code, and checked at
effect time like every other broker:

| Broker domain | Viewer-safe? | Rule |
|---|---|---|
| Reviewed static assets | Yes | Serve exact staged bytes of the installed Release revision, nothing else |
| Storage / data **reads** | Narrowly | Only collections the reviewed manifest explicitly marks viewer-readable, and only **instance-owned** data. Principal-owned and role-owned data: never |
| Storage / data **writes** | Never | Viewers mutate nothing |
| Assistant actions | Never | Actions are mutations executed with the person's runtime |
| Network broker (egress) | Never | A viewer must not be able to make the desktop send requests anywhere — audience-triggered egress is server-side request forgery with extra steps |
| Connections / credentials | Never | A viewer must never cause the desktop to spend a saved credential |
| Space files | Never | File grants exist for the person's own use of the app; the only file exposure lane is rung 2's explicit per-file publication |
| Notifications | Never | Viewer-triggered OS notifications are an abuse surface with no product story |
| Automations / jobs | Never | Viewers cannot run, schedule, or observe jobs |
| OAuth | Never | Follows from connections |
| Tabs / host UI powers | Never | Meaningless outside the desktop shell |

The viewer-readable data flag is a new reviewed declaration field
(`src/local/agent/restricted-app-manifest.ts`), so it appears in review copy
and in the install consecration; a reviewed update that widens the
viewer-readable surface or changes the viewer entry is a fresh
outward-exposure consecration, while an update with an unchanged viewer
surface rides the normal update-review lane.

### What is already proven, and what is new

The checked-in private hosted semantic core
(`src/local/agent/private-hosted-app-service.ts`,
`tests/private-hosted-app-service.test.ts`) already proves the semantics rung
3 must not reinvent: opaque identity tuples and `AuthorityStamp` fencing at
effect time, default-off grants, instance-owned connections, enable/run/
receipt for jobs, update review with per-Feature authority transitions,
suspend/resume, delete/purge with revocation high-water marks, data owner
classes with role-bound access, exports, and bounded receipts.

New for rung 3, in order of risk: the principal-less viewer read path and its
manifest flag; the transport adapter that serves staged Release assets
(`src/local/agent/local-app-release-store.ts`) and brokered reads over the
relay; per-publication viewer budgets applied to app traffic; the opaque-
origin iframe hosting in the viewer shell; and asleep semantics for an app
("the app this page belongs to is asleep"). Rung 3 deliberately does **not**
require the foundation's full private hosted milestone — viewers are not
authenticated Principals, so accounts, role realms, and a hosted data service
stay out of scope. It ships only after rung 2 has burned in, because every
rung-3 problem contains a rung-2 problem.

## Bridge changes, content-free by default

Schema (`services/bridge/database.mjs`):

- `bridge_publications`: id, account id, kind (`page` | `app`), state,
  budgets, rolling served-byte counters, snapshot flag, created/updated/
  expires timestamps, and the creating operation id (`UNIQUE`). No titles, no
  file names, no source paths, no content.
- `bridge_publication_snapshots`: publication id, ciphertext, IV, content
  digest, captured-at, byte size. Ciphertext only, present only for opted-in
  publications, deleted with the slot.
- Reserved-slug change: exact `pages` plus the `pages-` prefix.

Endpoints and frames (`services/bridge/server.mjs`):

- Viewer plane, on `pages-<slug>` hosts only, diverted before personal-slug
  resolution (the management client is never served on a `pages-*` host):
  the static shell, `GET /api/viewer/pages/:id`, and rung 3's
  `GET /api/viewer/apps/:id/...` asset/read routes. No cookies, no CSRF (no
  sessions to protect), IP rate limits before any dispatch.
- Device plane: `viewer.fetch` → desktop; desktop returns a signed
  `work-fold.viewer-page.v1` envelope; unknown frame types remain ignored for
  forward compatibility, and the existing finite protocol-error budget
  applies. Device HTTP gains `PUT`/`DELETE /api/device/publications/:id` and
  snapshot upload/delete, all idempotent by operation id, authenticated by
  the existing device bearer token.
- The management-plane `allowedOperations` set is untouched: viewer traffic
  never enters `/api/operations`, and no viewer endpoint exists on the
  management origin.

The bridge stays one replica; viewer traffic lives inside the same
process-local budget model as SSE and operation events and is one more
reason the shared backplane precedes horizontal scaling. Metrics stay
aggregate and identifier-free.

## Copy

User-facing copy says **Share a page**, **Stop sharing**, **your fold's web
address**, and "pages your fold serves." The share link is shown with its
plain meaning: "Anyone with this link can read this page while your desktop
is online." Contract identifiers stay technical and unrenamed:
`work-fold.viewer-page.v1`, `bridge_publications`, `viewer.fetch`,
`publicationId`. The words "host," "hosting," and "website" do not appear in
product copy; "publish" without qualification is reserved for App Studio's
local Release transition.

## Deliberately not in this design

- **Public discovery.** No directory, no search indexing (the viewer origin
  serves a disallow-all `robots.txt`), no "explore pages."
- **An App Store.** Rung 3 serves the person's own reviewed Releases to
  their own audience; distribution between people stays out.
- **Uptime promises.** Asleep is a feature. No keep-alive farm, no SLA, no
  "your page is always up" claim anywhere in copy or docs.
- **Custom domains and TLS termination for them.** One wildcard, one
  address scheme.
- **Viewer identity of any kind**: accounts, passwords, per-viewer links,
  comments, or per-viewer analytics. Counters are aggregate.
- **Live viewer channels.** No WebSockets or SSE to viewers in the first
  slice; a page is fetched, not subscribed to.
- **Multi-file sites on rung 2.** One slot serves one designated file;
  anything richer is an app (rung 3).
- **Publishing from routings.** No routing step may create or widen viewer
  exposure ([routings](fold-routings.md)); a routing may at most write files
  that an already-consecrated publication serves.
- **Standing-policy pre-approval of exposure**, per the decision above.

## Implementation plan

Dependency-ordered work items, not phases. Every desktop item runs
`npm run check` and `npm test`; bridge items run the bridge suite
(`services/bridge/` `npm test`); Electron-touching items run
`npm run desktop:prepare` before handoff.

1. **Reserve the viewer namespace and slot schema.** Extend `isValidSlug` in
   `services/bridge/database.mjs` with real prefix logic (exact `pages`,
   prefix `pages-`; the exact-match `reservedSlugs` set alone is
   insufficient), add `bridge_publications` +
   `bridge_publication_snapshots` with idempotent device-plane accessors and
   account-scoped cleanup. Grow `services/bridge/server.test.mjs` and
   `services/bridge/database-security.test.mjs` (reservation, idempotence,
   cascade deletion, snapshot bounds).
2. **Viewer plane at the bridge.** Host routing for `pages-<slug>` origins
   ahead of personal-slug resolution (never the management client on these
   hosts), the static viewer shell under `services/bridge/public/viewer/`
   (decrypt-and-render, and the asleep / as-of / not-available / resting /
   nothing-here states), `GET /api/viewer/pages/:id`, IP and per-account
   rate limits, in-flight ciphertext budget, and `viewer.fetch` /
   `work-fold.viewer-page.v1` device frames with signature admission. Viewer
   counters in `services/bridge/metrics.mjs`
   (`services/bridge/metrics.test.mjs`). Integration coverage in
   `services/bridge/server.test.mjs`.
3. **Desktop publication authority and serving.** New
   `src/local/publications.ts` service owning grant records (keys in secure
   settings via `desktop/src/settings.ts`), source binding and identity
   checks, the bounded closed-set renderer, effect-time recheck, and the
   Space-removal block. Wire `viewer.fetch` dispatch and envelope
   encrypt/sign into `desktop/src/remote-access.ts`; expose the service on
   the local API in `src/local/server.ts`. New
   `tests/work-fold-publications.test.ts`; extend
   `tests/desktop-remote-access.test.ts` (frames, recheck-before-serve,
   revocation ordering, snapshot confirmation).
4. **Act verbs and receipts.** `pages stage|list|status|revoke` (and the
   narrowing verbs) in `src/local/cli/act-commands.ts`, dispatched through
   `src/local/cli/act-facade.ts` and `src/local/server.ts`, journaled by
   `src/local/cli/act-receipts.ts` with the receipt fields from the mutation
   table. Staging/decision flow lands on the
   [consecrations](fold-consecrations.md) machinery and inherits its remote-
   click and browser-revocation-cancels-decisions rules. Extend
   `tests/work-fold-cli-act-protocol.test.ts`,
   `tests/work-fold-act-facade.test.ts`,
   `tests/work-fold-cli-act-receipts.test.ts`, and
   `tests/desktop-work-fold-cli-host.test.ts`.
5. **Desktop surfaces.** Publications list, share-link reveal, budget and
   snapshot controls, and revoke in Settings → The fold (decision F15 —
   beside its "Your fold on the web" subsection); needs-you publish cards in
   the popover/glance surfaces; glance
   change items for not-available and resting. Contract coverage in
   `tests/web-ui-contract.test.ts` and
   `tests/frontend-interaction-contract.test.ts`.
6. **Snapshot opt-in lane.** Snapshot push/delete in
   `desktop/src/remote-access.ts`, bridge storage from item 1, "as of"
   rendering from item 2, label copy in the decision card, deletion
   confirmation in revocation receipts.
7. **Rung 3 viewer surface.** Viewer-readable declaration flag and review
   copy in `src/local/agent/restricted-app-manifest.ts`; a desktop viewer
   adapter enforcing the viewer-safe table over
   `src/local/agent/private-hosted-app-service.ts` semantics with assets
   from `src/local/agent/local-app-release-store.ts`; hosted-at-address
   placement and its consecration in the App Studio install flow; opaque-
   origin iframe hosting in the viewer shell. Extend
   `tests/private-hosted-app-service.test.ts`,
   `tests/restricted-app-product-contract.test.ts`, and the real-Electron
   preparation probe with viewer-scope denial cases (actions, egress,
   connections, files, writes).
8. **Docs and canonical promotion.** Apply the `SECURITY.md`, `PRIVACY.md`,
   `README.md`, and `docs/product-model.md` amendment blocks drafted in
   [fold-integration.md](fold-integration.md); promote shipped decisions
   into the registers and shrink this document.
