# work-fold remote bridge

The remote client presents the **work-fold agent** and the registered
**work-folders**. The paired-web protocol keeps its existing `management.*`
operation names.

This service hosts the private-alpha web surface at
`<name>.work-fold.com`. It is a relay to a person's running work-fold desktop,
not a cloud copy of their work-folders or work-fold agent.

The durable PostgreSQL records contain the address and password verifier,
device/browser public keys and revocation generations, hashed session tokens,
pairing certificates, and bounded operation metadata. Prompt text, transcript
content, file names, file contents, and agent results cross the service only
inside signed AES-GCM envelopes whose private keys remain in the paired
browser and desktop app. Completed envelope bodies are not written to the
database. This is application-layer protection against passive handling and
plaintext persistence, not an untrusted-origin guarantee: the service also
serves the browser JavaScript, so the hosted client and bridge are trusted parts
of this alpha's full-authority boundary.

The `pages` and `pages-*` labels under the base domain are reserved.
Enrollment rejects the exact slug `pages` and any slug beginning `pages-` as
real prefix logic, and such a host is answered before personal-slug resolution
with a plain not-found response — never the management client, its sign-in,
its cookies, or the device lane.

Unauthenticated password work has its own process-local admission boundary.
Malformed or reserved addresses are rejected before password verification;
well-formed unknown addresses still use the same dummy scrypt verifier as a
known address so login does not become an address-enumeration oracle. An
IP-only fixed-window budget runs before scrypt, and accepted checks enter a
bounded round-robin queue with one active check per IP. Queue and rate-limit
maps fail closed at their fixed bounds instead of evicting another caller's
active protection. There is deliberately no attacker-triggerable account-wide
pre-verification lockout: a correct password can still succeed after
distributed failures against a known address.

Pairing uses a browser-contributed random id and a six-digit short
authentication string derived independently by the browser and desktop from
that id, the browser identity, and both validated P-256 public keys. The bridge
stores and relays the derived value for protocol consistency, but neither
client treats the relay as its authority. Device protocol errors are finite and
terminal, unknown typed frames are ignored for version skew, and displaced
device generations are fenced. Browser event streams tolerate ordinary Node
backpressure and drop a slow client only after an explicit 8 MiB queued-byte
bound. Envelope ciphertext is bounded at 12 MiB × 1.4 characters for a
message with uploads, 2 MiB × 1.4 for every other browser request, and
3 MiB × 1.4 for each desktop response. The desktop and the web client check
these first, so an oversized result arrives as a typed `RESPONSE_TOO_LARGE`
refusal rather than a device protocol error; see
[transport limits](../../docs/browser-apps.md#transport-limits).

The browser can open and rename bounded saved work-fold agent Chats, invoke that one
canonical management agent, and attach at most six files (6 MB each, 8 MB
total) per message. The agent performs or delegates work-folder work through
the desktop's attributed act path. Questions remain in their owning Chats.
Uploads travel encrypted and stay in quota- and expiry-bounded desktop staging
until explicitly used or placed. The client has no Files/work-folder browsing
screen, file-tree state, or inline preview. Older semantic tree operations remain
available for client compatibility; no operation tunnels arbitrary local HTTP.

The workspace uses a neutral light/dark surface, plain saved-chat titles and a
title filter that preserves the open Chat and its draft. Person messages appear
as right-aligned bubbles; agent replies remain unboxed. The header shows the
title and one **Chat options** menu for Rename/Delete. Result files and apps sit
behind a **Files and apps** disclosure. A compact pill composer expands as
needed, with Attach and Send/Stop at its edges. Navigation, menus and secondary
actions use the same restrained hover surface. On phones the same sidebar
becomes a focus-trapped drawer.

## Online pages

The bridge is the front door to the page service for publishers
([Pages, "Publishing (stage 2)"](../../docs/pages.md#bridge)). The desktop
publishes, unpublishes, checks in, and changes online entries under
`/api/device/pages` with its device token. The owner's browser reads pages and
entries, exports a spreadsheet, and unpublishes under `/api/pages` with the
password session alone — no paired browser and no running desktop — and
unpublishing also needs the same origin and the session's CSRF token. The web
client's **Published** view uses those routes; it opens from the offline and
pairing screens and from the paired sidebar, next to Settings.

Each route calls the page service's internal API with the authenticated
account's id in the path and the shared secret in `x-work-fold-pages-secret`.
Page ids must be `pg_` plus 26 lowercase base32 characters (`a`–`z`, `2`–`7`)
before anything is proxied. Publish bodies stream through up to 26 MiB and
data changes up to 8 MiB (the page service's own bound); every other page
route keeps the ordinary 96 KiB JSON bound. Snapshots and
spreadsheets stream back without being held whole. The page service's status
and `{ error, code, message, field }` pass through; when it can't be reached
the answer is a 502 with a plain message, and without configuration every page
route answers 503 "Online pages aren't available yet." Owner reads, exports,
and unpublishes, and device publishes and other device page calls, have their
own process-local rate limits. Page ids and links are never logged.

## Local development

The inert `?fixture=chat` preview opens a finished conversation. Four saved Chats
have distinct transcripts and keep their own drafts; Rename/Delete only change
the in-memory fixture. Use `activity=running` explicitly to review streaming and
Stop, or `work=question|saved-answer|partial|interrupted` for the durable-question
states. Fixture navigation never calls the desktop or relay API.

Use Node 24 (matching the root `.nvmrc`) and a local PostgreSQL database.
Run these commands from the repository root:

```bash
npm ci --prefix services/bridge
DATABASE_URL=postgresql://localhost/work_fold_bridge \
WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1 \
npm start --prefix services/bridge
```

Without PostgreSQL, run the bridge on the in-memory database the tests use. It
listens on `127.0.0.1:$PORT` (8790 by default) with public enrollment on, and
forgets every address and session when it stops:

```bash
npm ci --prefix services/bridge
PORT=8790 npm run dev:memory --prefix services/bridge
```

To run the whole online-pages flow locally, start the page service and pass the
same `WORKFOLD_PAGES_*` settings to the runner, for example
`WORKFOLD_PAGES_INTERNAL_URL=http://127.0.0.1:8792`,
`WORKFOLD_PAGES_INTERNAL_SECRET=<the page service's secret>`, and
`WORKFOLD_PAGES_PUBLIC_ORIGIN=http://127.0.0.1:8791`. `?fixture=chat&published=1`
(or `published=page`) previews the Published view with canned pages.

For a local desktop build, set `WORKFOLD_REMOTE_BRIDGE_URL` to the local bridge
origin. Loopback browser URLs use `http://127.0.0.1:<port>/?slug=<address>`
(or `localhost`); the browser retains that account query on API and event
requests. Production resolves the account from its subdomain and uses
`WORKFOLD_BRIDGE_DOMAIN=work-fold.com`.

Configuration:

- `DATABASE_URL` — required PostgreSQL connection string.
- `WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1` — server-side switch permitting new
  private-alpha address creation. When absent or disabled, existing addresses
  keep working but new enrollment receives a closed response.
- `WORKFOLD_BRIDGE_DOMAIN` — base domain; defaults to `work-fold.com`.
- `WORKFOLD_TRUST_PROXY=1` — trust Railway's forwarded host/IP headers.
- `WORKFOLD_BRIDGE_DB_POOL` — PostgreSQL pool size, from 1 through 50.
- `WORKFOLD_BRIDGE_DB_SSL=disable|require|verify-full` — optional explicit SSL
  override. If omitted, the PostgreSQL connection string and driver defaults
  apply.
- `WORKFOLD_PAGES_INTERNAL_URL` — the page service's internal address, reached
  over Railway's private network (for example
  `http://pages.railway.internal:8081`). No credentials, query, or fragment.
- `WORKFOLD_PAGES_INTERNAL_SECRET` — the shared secret the page service checks
  in `x-work-fold-pages-secret`; 16 to 512 visible ASCII characters, the same
  value on both services.
- `WORKFOLD_PAGES_PUBLIC_ORIGIN` — the origin visitors open pages at (for
  example `https://pages.work-fold.com`; `http:` only on loopback). The page
  list and a publish's answer carry it as `pagesOrigin`; clients build links
  as `<origin>/p/<pageId>`.
  Set all three page settings or none. A partial or invalid set leaves online
  pages off with one startup warning that never repeats the values.

Run the relay integration suite with `npm test`.

## Deployment shape

The current private alpha intentionally runs one bridge replica. Identity,
sessions, grants, and operation state are durable in PostgreSQL; live desktop
WebSockets, browser event streams, rate-limit buckets, and bounded encrypted
response buffers are process-local. Scheduled cleanup, active-row expiry,
per-grant operation caps, SSE caps, and a global ciphertext budget bound the
single process. Horizontal scaling therefore requires a shared
presence/event backplane and distributed rate limiter before replicas are
increased.

At startup and once per minute the service writes a structured, aggregate
`work-fold.bridge.metrics.v1` record. It covers HTTP request and device-frame
rates, password-check active and queued counts, event-loop lag, device/SSE
counts, and the public-enrollment switch. Saturated password admission,
excessive device-frame rate, or high event-loop lag emits a warning. Metrics
contain no account/browser ids, address or network identifiers, tokens,
ciphertext, or content. Alert on warning records and retain enough history to
establish normal single-replica headroom.

Deploy this directory with:

```bash
npm --prefix . run railway -- up services/bridge --path-as-root --service bridge
```

Roll out the bridge and hosted browser client before distributing a desktop
build that depends on new bridge behavior. New bridge code stays compatible with
older desktops, while a hardened desktop deliberately rejects an older bridge.
When a rollout changes pairing, let the 10-minute pending-pairing TTL elapse
after the bridge deploy and before the desktop release so no browser is left
part-way through pairing, and ask anyone holding an open pairing prompt to
refresh and start it again.

History: the key-bound pairing-code rollout followed this order in August 2026
and finished before the desktop release that requires it, so no bridge serving
random pairing codes remains in service.

Railway must route `*.work-fold.com` to this service; that certificate includes
`www.work-fold.com`. GoDaddy needs the Railway traffic CNAME plus the ownership
TXT and wildcard-certificate challenge CNAME shown by Railway. The desktop
remains the local execution endpoint and must be online for pairing or remote
operations. Set `WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1` in Railway only while new
address creation should be available, and verify the metrics record reports
`publicEnrollment: false` again when that window closes. The Railway service
uses a 30-second drain window so reconnect and same-request recovery can run
during deployments.
