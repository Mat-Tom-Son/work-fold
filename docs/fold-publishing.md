# The fold: the publishing ladder and the viewer

**Status: shipped contract reference.** The publishing ladder shipped with
the fold build through rung 3 — `src/local/publications.ts`,
`src/local/agent/restricted-app-viewer.ts`, `desktop/src/remote-access.ts`,
and the bridge's viewer plane in `services/bridge/` with their suites are
the implementation authority — and its decisions were promoted on
2026-08-11 into [the fold](fold.md) decision register (F11),
[Product model](product-model.md) (the Viewer noun and the share/revoke
context rows), [the management layer](management-layer.md), `README.md`,
`SECURITY.md` (the Published viewer pages subsection), and `PRIVACY.md`
(the Published pages subsection), with the reviewed `viewer` manifest field
documented in [Restricted app authoring](restricted-app-authoring.md) and
[Restricted app runtime](restricted-app-runtime.md). This document retains
what canon does not carry: the viewer class contract, the serving path, the
key design decision, origin isolation, honest states, the mutation ledger,
the viewer-safe broker table, and the bounds. The promotion record is
[Fold integration](fold-integration.md).

The fold is the one door to all Spaces: material comes in through it, and
pages go out through it. The ladder has three rungs, each reusing the trust
machinery beneath it:

| Rung | What a person gets | New trust surface |
|---|---|---|
| 1 | The glance on your phone | None — existing approved-browser grant |
| 2 | One file served as a rendered page at your address | The **viewer**: link-scoped, read-only, per-published-item |
| 3 | A restricted-app Release served to viewers at your address | The same viewer class over a narrow, desktop-enforced broker subset |

The honest sentence for all three rungs is **"pages your fold serves"** —
served live from your desktop, through the relay, while your desktop is
online. It is never "host your website": no uptime promise, no public
discovery, no App Store, and an offline desktop is honestly asleep, not
silently stale.

## The viewer: a new audience class

A **viewer** is anyone holding a share link — deliberately not a smaller
kind of approved browser but a different species:

| | Approved browser | Viewer |
|---|---|---|
| Identity | Non-exportable P-256 keys, desktop-signed grant | None — possession of one link |
| Scope | The whole management conversation and Space trees | Exactly one published item |
| Direction | Can prompt a full-trust Assistant | Read-only, always |
| Pairing | Password + matched six-digit code + desktop click | None |
| Management lane | Yes — `management.*`, `spaces.*` operations | Never — a disjoint operation set on a disjoint origin |
| Revocation | Per browser, per generation, whole connection | Per published item, instantly, regardless of who holds links |

A **viewer grant** is the desktop-side authority record behind one
published item. Its properties, all load-bearing: **per-published-item**
(no account-wide viewer authority, no "publish everything" switch),
**read-only** (no viewer-reachable operation mutates anything; rung 3
enforces this in the broker, not app code), **link-scoped** (the link is
the whole credential; forwarding the link forwards the access — the
intended semantics, stated plainly on the publish decision card; no viewer
accounts, sessions, or cookies), **revocable** (revoking kills every copy
of the link at once, desktop-first), and **receipted** (creating,
rebinding, re-budgeting, and revoking are journaled acts; serving a page is
a read — counted in bounded aggregate tallies the glance can show, never
journaled per-request, because an unbounded receipt stream would be its own
denial-of-service).

A viewer is not a Principal. The App platform's Principal kinds all name
authenticated actors; a viewer is an unauthenticated audience. Rung 3 never
resolves a viewer to a Principal, never evaluates roles for one, and never
lets one reach Principal- or role-owned data.

## Publishing is a consecration

**Creating outward viewer exposure is consecration 2 — widen a power.** The
set of principals who can reach content the desktop serves widens from "you
and browsers you approved by matched code" to "anyone holding a link" — a
network destination in reverse: an ingress audience instead of an egress
origin. The fold may **stage** a publication; a person approves it as a
needs-you decision. Two verbs share the English word "publish" and must not
share a ceremony: **Publish a Release** (App Studio) is a local state
transition and stays a direct receipted verb; **serving to viewers** —
activating a page slot, or exposing a hosted App Instance — is the
consecration, and UI copy avoids the collision ("Share a page" / "Put this
app at your address").

Consequences, consistent with the fold doctrine:

- **Remote clicks count.** A publish decision may be approved from the
  desktop or any approved browser; the receipt records the approving
  surface and exact grant, and revoking a browser cancels its pending
  decisions, including pending publish decisions.
- **The never-list is untouched.** Publishing rides the existing Remote
  access account. The fold cannot bootstrap an address in order to publish
  to it: staging with no enrolled address fails with a typed `no-address`
  state and no card appears. Setting up "your fold on the web" is a
  person-only prerequisite.
- **Not policy-eligible.** `publish.viewer.expose` is excluded from
  standing policies in the policy schema itself — outward exposure is the
  one category whose blast radius includes people who are not the person.
  Every new exposure takes a click; revocation, as always, takes none.
- **Narrowing never needs a click.** Revoking a publication, cutting its
  budgets, and turning snapshot caching off are direct receipted verbs.
  Widening — a new slot, a rebound source, raised budgets, snapshot on —
  is a fresh consecration.

## Rung 1 — the glance on your phone

Rung 1 is not a publishing feature and introduces no viewer: it is
[the glance](fold-glance.md) rendered at the top of the approved remote
client's home. Same approved-browser grant, same envelope encryption, zero
new audience — and its needs-you cards are where remote publish approvals
surface.

## Rung 2 — share a page

### The publication object

A **publication** binds: a **slot** (a high-entropy `publicationId`, the
stable path segment of the share link); a **source** (one exact
Space-relative file in one registered Space, designated explicitly at
staging — never a folder, never a glob, never "the Space"); a **key** (a
256-bit AES-GCM publication key generated desktop-side at activation,
stored with the other Remote access material in operating-system-encrypted
secure settings); a **title** (shown on the decision card, carried inside
the encrypted payload — the bridge never stores it); and **budgets and
flags** (serve-rate and byte budgets, optional expiry, snapshot opt-in,
default off).

The share link — viewer origin, path, and fragment key — is composed on
demand from secure settings and shown transiently to the person. The link
is the whole credential and is treated as one: the full link and the key
appear in no receipt, journal, log, glance item, or management-request
action trail; receipts and listings identify a publication by
`publicationId` and its viewer origin and path only.

The page a viewer sees is the **current** content of the designated file,
rendered at serve time — a live page, not an upload, and the exposure
statement: the person is exposing that file's evolving content, exactly as
designating a file for a Check exposes it to a sensor. Content evolution is
not a new consecration; changing **which** file backs the slot is. Rendered
types are a closed set: Markdown and plain text (rendered desktop-side into
one self-contained HTML body), PNG, JPEG, and PDF. Person-authored HTML and
anything interactive is deferred to rung 3 — an app is the vehicle for
script, so rung 2 pages stay inert; SVG is excluded because it is
scriptable.

Publication records are machine-local application state. Nothing about a
publication is written into the Space folder — a synchronized folder must
not leak "this file was shared," and portable data must never carry
authority — and History does not capture publication records. Unregistering
or deleting a Space that backs live publications is blocked until they are
revoked, and the removal flow names them.

### The serving path

1. A viewer opens `https://pages-<slug>.work-fold.com/p/<publicationId>#<key>`.
2. The bridge serves the static **viewer shell** from
   `services/bridge/public/viewer/`: no cookies, no storage, strict CSP,
   `robots.txt` disallowing everything.
3. The shell requests `GET /api/viewer/pages/<publicationId>`. The fragment
   never leaves the browser.
4. The bridge checks the slot row (exists, active, within budgets) and the
   desktop socket. Offline → typed `asleep` (or the snapshot, if opted in).
   Online → it forwards a `viewer.fetch` frame on the existing device
   WebSocket.
5. The desktop **rechecks the local grant immediately before serving** (the
   same effect-time discipline as `WorkFoldRemoteFacade` and the
   restricted-app brokers), re-reads the designated file with the ordinary
   no-follow/identity checks, renders within hard bounds, encrypts with the
   publication key (fresh IV; AAD binds `publicationId`, the
   rendered-content digest, and the serve timestamp), signs the envelope
   with the device signing key, and returns a `work-fold.viewer-page.v1`
   response frame.
6. The bridge verifies the device signature (admission hygiene), buffers
   the bounded ciphertext briefly, and completes the viewer's request.
7. The shell decrypts with the fragment key and renders the inert document.

The viewer's authenticity anchor is the publication key itself: a payload
that authenticates under AES-GCM with the key from the person's own link
came from the holder of that key — the desktop. The device signature exists
for the bridge's admission and caching hygiene, not as a viewer-side trust
chain.

### The key design decision: fragment keys with relayed ciphertext

Three candidate designs were judged against the bridge's posture (content
crosses only inside signed application-encrypted envelopes, protecting
persisted relay state and passive handling, explicitly not an actively
compromised hosted origin). **Chosen: URL-fragment keys with bridge-relayed
ciphertext** — the key rides in the link fragment; the bridge sees slot
metadata and ciphertext sizes, never page bytes, extending the exact
property the envelope design buys for management traffic without inventing
viewer key exchange. Rejected: bridge-visible content with explicit
labeling (breaks the content-free-by-default culture for an entire traffic
class; the snapshot cache is the one deliberate, opt-in, labeled instance
of relay retention, and even it stores ciphertext), and desktop-signed
short-lived viewer tokens (they change who may ask, not what the bridge
sees; minting needs the desktop online, which a viewer fetch requires
anyway; and revocation is already per-publication).

**Residual risk, stated honestly.** The bridge serves the viewer shell's
JavaScript, so an actively compromised bridge or hosted origin can serve a
shell that exfiltrates `location.hash` and read pages fetched from then on
— and, combined with stored snapshot ciphertext, pages cached earlier. This
is the same first-load-web-trust class the alpha already accepts for the
approved-browser client, with strictly smaller blast radius: a stolen
publication key opens one published page, never management authority.
Separately, anyone who obtains a full link is a legitimate viewer until
revocation — the meaning of link-scoped, and the publish card says so. A
public/full-trust release of publishing inherits the requirement already
recorded for Remote access: a pinned client or an authority design that
does not grant mutable first-load web code this power.

### Origin isolation is a hard requirement

Published viewer content must not share origin, cookies, or keys with the
approved-browser client, whose authority material is origin-scoped (the
`__Host-` session cookie; the approved browser's non-exportable keys in
IndexedDB for `<slug>.work-fold.com`). Structurally:

- **Viewer origin:** `https://pages-<slug>.work-fold.com` — one extra label
  inside the existing wildcard certificate. The bridge reserves the
  namespace with real prefix logic in `isValidSlug`: enrollment rejects the
  exact slug `pages` and any slug beginning `pages-`.
- **Host routing diverts `pages-*` first**, before personal-account slug
  resolution; a `pages-*` host serves viewer routes or nothing, and the
  management client is never served on one. If a legacy `pages-<slug>`
  account exists, the viewer origin for account `<slug>` is contested and
  publishing fails closed for **both** accounts until the `pages-` account
  is renamed; both keep every non-publishing capability.
- The viewer origin never sets a cookie, never offers sign-in or pairing,
  never serves the management client bundle, and writes no browser
  storage. The management origin never serves viewer content.
- Rung 2 pages are inert documents. Rung 3 app content additionally runs
  inside a sandboxed iframe **without** `allow-same-origin`, so each app
  instance renders with an opaque origin: no shared storage between two
  published apps, and no origin-scoped state at all — app state lives
  desktop-side behind the broker, where it already is.

### Honest states

- **Asleep.** Desktop offline, no snapshot: "This page is served by
  `<slug>`'s work-fold desktop, which is asleep right now. Try again
  later." HTTP 200, typed state, no pretending.
- **As of.** Desktop offline, snapshot opted in: the cached page renders
  under a persistent "as of `<time>`" banner. Never presented as live.
- **Not available.** Desktop online but the source file is missing, moved,
  oversized, or failed identity checks: viewers get a deliberately vague
  "This page isn't available right now." The person gets the precise
  reason as a change item in [the glance](fold-glance.md) — the page's
  problem is the publisher's information, not the audience's.
- **Resting.** A budget is exhausted: "This page has had a lot of visitors
  today. Try again later." Also surfaced to the person in the glance.
- **Nothing here.** Unknown `publicationId`, revoked slot, or a viewer
  host whose account does not exist: one identical "Nothing is published
  here." page — slot ids are high-entropy, and this mirrors the login
  surface's address-enumeration posture.

### Snapshot caching: explicitly labeled, default off

By default the bridge retains viewer content only as an in-flight response
buffer with a short expiry. Opting a publication into **snapshot caching**
stores the latest served ciphertext (one bounded row per publication) so
the page survives desktop sleep. The opt-in lives in the publish decision
card and the publication's settings, labeled plainly: "Keep an encrypted
copy at the relay so this page stays readable while your desktop sleeps.
The relay stores it encrypted and cannot read it; anyone with the link
still can." Turning it on is a widening (consecration); turning it off is a
direct verb and deletes the stored row. After a successful live serve, the
desktop refreshes the snapshot in the same device-frame exchange — a
counter-tracked sync, not a separate receipted act. The residual-risk
sentence above applies to snapshots verbatim.

### Revocation ordering

Same discipline as browser-grant revocation — desktop-local authority
first, server state second, cleanup lanes independent:

1. Mark the grant revoked in the desktop's publication store. From this
   instant the effect-time recheck refuses every new `viewer.fetch`,
   regardless of bridge state. An in-flight render may complete its already
   bounded response, mirroring the late-signed-result rule for operations.
2. Delete the bridge slot row and any snapshot row. New viewer requests now
   get "Nothing is published here" without waking the desktop.
3. Write the terminal receipt. If bridge cleanup could not be confirmed,
   the receipt honestly records `bridgeCleanup: pending` and the desktop
   retries on reconnect and at startup; a pending snapshot deletion is
   named in the receipt because it is the one case where relayed bytes
   could outlive desktop authority.

Disabling Remote access or deleting the address revokes every publication
as part of its existing cleanup lanes; publications cannot outlive the
account they are addressed under. Re-publishing after revocation creates a
**new** slot, key, and link — old links stay dead, and key rotation is
spelled "revoke, then share again."

### Abuse bounds

Viewer traffic is unauthenticated by design, so the bridge's
bounded-everything culture applies before anything reaches the desktop.
The bounds are owner-tunable constants beside the existing envelope and SSE
budgets in `services/bridge/server.mjs`, enforced per process:

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
under the ordinary abort discipline, and one render at a time per
publication (concurrent fetches for the same slot coalesce onto one
render). Budget exhaustion is a typed viewer state and a glance item, never
a silent drop. The minute-interval bridge metrics record gains aggregate
viewer counters with the existing rule intact: no ids, addresses, tokens,
ciphertext, or content.

### The mutation ledger

Every publishing mutation answers the five questions from the
[act ledger](fold-act-ledger.md). Serving is a read and appears only where
it touches durable state (snapshot refresh).

| Mutation | Kind | Journaled | Receipt contains | Revocation / undo | Mid-act failure | Replay prevention |
|---|---|---|---|---|---|---|
| Stage a page publication | Fold act (inert) | `accepted` before staging | Staged-decision id, Space id, relative path, title, budgets, snapshot flag | Staged act expires or is withdrawn; denial recorded | Nothing external exists; a lost stage is re-staged | Act-lane request ids, journal-first at-most-once |
| Approve / deny the publish decision (page or hosted app) | Human click (desktop or approved browser) | Decision record | Decision, approving surface + browser grant id, staged-act digest | A denial is terminal; browser revocation cancels its pending decisions | Unclicked decisions expire | Decision ids single-use; the click binds the exact staged digest |
| Activate publication | Host act after approval | Durable intent before key mint and bridge sync | `publicationId`, source, viewer origin and path — never the fragment key or the full link — budgets, bridge sync outcome | Revoke verb, any time | Two-phase: local record commits first; bridge slot creation retried by operation id; not presented as live until bridge confirms | Bridge slot upsert idempotent by operation id; startup recovery re-drives or cancels the intent |
| Rebind source / raise budgets / snapshot on | Consecration (widen) | As stage + decision above | Old and new binding, old and new budgets | The previous binding's receipt chain is the undo reference; narrowing back is a direct verb | Same two-phase as activation | Same as activation |
| Cut budgets / snapshot off | Direct verb | `accepted` before mutation | Old and new values; snapshot-deletion outcome | Raising again is a consecration | Bridge sync retried; local narrowing already effective | Operation-id idempotence |
| Revoke publication | Direct verb | `accepted` before mutation | `publicationId`, ordering outcomes, `bridgeCleanup: ok\|pending` | This is the undo; re-publishing mints a new slot, key, and link | Desktop-first; bridge cleanup retried until confirmed | Revocation is idempotent; a second revoke is a no-op receipt |
| Snapshot refresh (serve-time) | Bounded sync, not an act | Not journaled; counter-tracked | — (aggregate counters only) | Snapshot off / revoke deletes the row | A failed refresh leaves the previous snapshot; staleness is visible in "as of" | Refresh carries the serve's content digest; the bridge keeps newest-wins by digest + timestamp |
| Stage hosted-app exposure (rung 3) | Fold act (inert) | `accepted` before staging | Staged-decision id, App Instance id (or the prepared install operation id when staged with an install), exact Release digest, viewer entry, the complete viewer-readable surface, budgets | Staged act expires or is withdrawn; denial recorded | Nothing external exists; a lost stage is re-staged | Act-lane request ids, journal-first at-most-once |
| Activate hosted-app exposure | Host act after approval | Durable intent before bridge slot creation (kind `app`) | `publicationId`, App Instance id, Release digest, viewer origin and path — never keys or full links — bridge sync outcome | Revoke verb, any time | Same two-phase as page activation | Same operation-id idempotence |
| Widen a hosted app's viewer surface (update) | Consecration (widen) — a reviewed update that widens the viewer-readable surface or changes the viewer entry stages a fresh `publish.viewer.expose`; an unchanged viewer surface rides the normal update-review lane | As stage + decision above | Old and new viewer surface, old and new Release digests | Rolling the update back narrows again; narrowing is a direct verb | Same two-phase as activation | Same as activation |
| Revoke hosted-app exposure | Direct verb | `accepted` before mutation | `publicationId`, ordering outcomes, `bridgeCleanup: ok\|pending` | This is the undo; the Instance keeps running locally without an audience, and re-exposing is a fresh consecration | Desktop-first; bridge cleanup retried until confirmed | Idempotent, as page revocation |

## Rung 3 — an app at your address

Rung 3 installs a restricted-app Release as an App Instance whose placement
is **hosted at your address**: the reviewed app's UI is served to viewers
through the same desktop → relay → viewer path as rung 2, and every power
the app exercises is brokered desktop-side. It is the App platform's
`host: local | hosted` distinction with the desktop as the host — no
work-fold cloud runtime. Installing follows the existing App Studio
two-phase prepare/activate operation plus the outward-exposure
consecration; the decision card names the app, the exact Release digest,
the viewer address, and the complete viewer-readable surface. All other
powers start off, exactly as local installs behave.

### Which broker domains are viewer-safe

Enforced in the desktop's viewer adapter
(`src/local/agent/restricted-app-viewer.ts`), never in app code, and
checked at effect time like every other broker:

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

The viewer-readable flag is the reviewed `viewer` declaration in
`src/local/agent/restricted-app-manifest.ts`, so it appears in review copy
and in the exposure consecration; a reviewed update that widens the
viewer-readable surface or changes the viewer entry is a fresh
outward-exposure consecration, while an update with an unchanged viewer
surface rides the normal update-review lane. Rung 3 reuses the semantics
the private hosted core already proves (identity tuples, effect-time
authority stamps, default-off grants) and deliberately does not require the
foundation's full private hosted milestone — viewers are not authenticated
Principals, so accounts, role realms, and a hosted data service stay out of
scope. The real-Electron probe carries the viewer-scope denial cases
(actions, egress, connections, Space files, storage writes) and stays
release-gating.

## Bridge changes, content-free by default

Schema (`services/bridge/database.mjs`): `bridge_publications` (id, account
id, kind `page`|`app`, state, budgets, rolling served-byte counters,
snapshot flag, timestamps, creating operation id `UNIQUE` — no titles, file
names, source paths, or content) and `bridge_publication_snapshots`
(ciphertext, IV, content digest, captured-at, byte size — present only for
opted-in publications, deleted with the slot); reserved slugs: exact
`pages` plus the `pages-` prefix. Endpoints (`services/bridge/server.mjs`):
the viewer plane on `pages-<slug>` hosts only — static shell,
`GET /api/viewer/pages/:id`, rung 3's `GET /api/viewer/apps/:id/...`
routes, no cookies, no CSRF, IP rate limits before any dispatch — and the
device plane's `viewer.fetch` / `work-fold.viewer-page.v1` frames plus
idempotent `PUT`/`DELETE /api/device/publications/:id` and snapshot
upload/delete. The management-plane `allowedOperations` set is untouched:
viewer traffic never enters `/api/operations`, and no viewer endpoint
exists on the management origin. The bridge stays one replica; viewer
traffic lives inside the same process-local budget model, and metrics stay
aggregate and identifier-free.

## Copy

User-facing copy says **Share a page**, **Stop sharing**, **your fold's web
address**, and "pages your fold serves." The share link is shown with its
plain meaning: "Anyone with this link can read this page while your desktop
is online." Contract identifiers stay technical and unrenamed:
`work-fold.viewer-page.v1`, `bridge_publications`, `viewer.fetch`,
`publicationId`. The words "host," "hosting," and "website" do not appear
in product copy; "publish" without qualification is reserved for App
Studio's local Release transition.

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
- **Live viewer channels.** No WebSockets or SSE to viewers; a page is
  fetched, not subscribed to.
- **Multi-file sites on rung 2.** One slot serves one designated file;
  anything richer is an app (rung 3).
- **Publishing from routings.** No routing step may create or widen viewer
  exposure ([routings](fold-routings.md)); a routing may at most write
  files that an already-consecrated publication serves.
- **Standing-policy pre-approval of exposure**, per the decision above.

## Implementation record

The plan items shipped as follows (numbering preserved for references):

1. Viewer namespace and slot schema at the bridge — `services/bridge/database.mjs`; `services/bridge/server.test.mjs`, `services/bridge/database-security.test.mjs`.
2. Viewer plane at the bridge — host routing, the shell under `services/bridge/public/viewer/`, rate limits, `viewer.fetch` frames; the bridge suite and `services/bridge/metrics.test.mjs`.
3. Desktop publication authority and serving — `src/local/publications.ts`, `desktop/src/remote-access.ts`, `desktop/src/settings.ts`; `tests/work-fold-publications.test.ts`, `tests/desktop-remote-access.test.ts`.
4. Act verbs and receipts — `pages stage|stage-app|list|status|revoke|narrow|snapshot-off` in `src/local/cli/act-commands.ts` and `src/local/cli/act-facade.ts`; `tests/work-fold-cli-act-protocol.test.ts`, `tests/work-fold-act-facade.test.ts`.
5. Desktop surfaces — publications list, share-link reveal, budget and snapshot controls, and revoke in Settings → The fold; needs-you publish cards; glance change items; `tests/fold-publication-settings.test.ts`, `tests/web-ui-contract.test.ts`, `tests/frontend-interaction-contract.test.ts`.
6. Snapshot opt-in lane — push/delete in `desktop/src/remote-access.ts`, bridge storage, "as of" rendering, label copy.
7. Rung 3 viewer surface — the `viewer` manifest declaration in `src/local/agent/restricted-app-manifest.ts`, the viewer adapter in `src/local/agent/restricted-app-viewer.ts`, opaque-origin iframe hosting in the shell, probe denial cases in `scripts/restricted-app-electron-smoke.mjs`; `tests/restricted-app-manifest.test.ts`, `tests/restricted-app-product-contract.test.ts`, `tests/work-fold-publications.test.ts`.
8. Docs and canonical promotion — recorded in [Fold integration](fold-integration.md).
