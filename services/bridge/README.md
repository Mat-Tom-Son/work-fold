# work-fold remote bridge

This service hosts the private-alpha web surface at
`<name>.work-fold.com`. It is a relay to a person's running work-fold desktop,
not a cloud copy of their Spaces or management conversation.

The durable PostgreSQL records contain the address and password verifier,
device/browser public keys and revocation generations, hashed session tokens,
pairing certificates, and bounded operation metadata. Prompt text, transcript
content, file names, file contents, and Assistant results cross the service only
inside signed AES-GCM envelopes whose private keys remain in the approved
browser and desktop app. Completed envelope bodies are not written to the
database. This is application-layer protection against passive handling and
plaintext persistence, not an untrusted-origin guarantee: the service also
serves the browser JavaScript, so the hosted client and bridge are trusted parts
of this alpha's full-authority boundary.

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
bound.

The browser can open bounded saved management Chats, invoke that one canonical
management Assistant, inspect filtered relative Space trees, and attach at most
six files (6 MB each, 8 MB total) per message. Selecting a Space changes only
the Files tree; the management Assistant performs or delegates Space work
through the desktop's attributed act path. The bridge only relays the encrypted
upload envelope, and the desktop keeps uploads in quota- and expiry-bounded
app-owned staging until the Assistant explicitly uses or places them. No
operation is a direct Space Chat, generic local-HTTP tunnel, or direct
capability/settings endpoint.

## Local development

Node 22.19.0 or newer and PostgreSQL are required.

```bash
npm install
DATABASE_URL=postgresql://localhost/work_fold_bridge \
WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1 \
npm start
```

For a local desktop build, set `WORKFOLD_REMOTE_BRIDGE_URL` to the local bridge
origin. The production bridge uses `WORKFOLD_BRIDGE_DOMAIN=work-fold.com`.

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
npm run railway -- up services/bridge --path-as-root --service bridge
```

Roll out the bridge and hosted browser client before distributing a desktop
build that enforces key-bound pairing codes. New bridge code remains compatible
with older desktops, while the hardened desktop deliberately rejects a legacy
bridge's random pairing code. Wait at least the 10-minute pending-pairing TTL
after the bridge rollout (or otherwise confirm that no legacy approval remains)
before the desktop release, and ask anyone with an approval already open to
refresh and start it again.

Railway must route `*.work-fold.com` to this service; that certificate includes
`www.work-fold.com`. GoDaddy needs the Railway traffic CNAME plus the ownership
TXT and wildcard-certificate challenge CNAME shown by Railway. The desktop
remains the local execution endpoint and must be online for pairing or remote
operations. Set `WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1` in Railway only while new
address creation should be available, and verify the metrics record reports
`publicEnrollment: false` again when that window closes. The Railway service
uses a 30-second drain window so reconnect and same-request recovery can run
during deployments.
