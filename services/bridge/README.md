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

The browser can open bounded saved management or Space Chats, invoke the
selected canonical Assistant, inspect filtered relative Space trees, choose
visible context, and attach at most six files (6 MB each, 8 MB total) per
message. The bridge only relays the encrypted upload envelope. The desktop
places Space uploads in a dated `Dropped/` folder with a restore point and keeps
management uploads in quota- and expiry-bounded app-owned staging. No operation
is a generic local-HTTP tunnel or a direct capability/settings endpoint.

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

Deploy this directory with:

```bash
npm run railway -- up services/bridge --path-as-root --service bridge
```

Railway must route `*.work-fold.com` to this service; that certificate includes
`www.work-fold.com`. GoDaddy needs the Railway traffic CNAME plus the ownership
TXT and wildcard-certificate challenge CNAME shown by Railway. The desktop
remains the local execution endpoint and must be online for pairing or remote
operations. Set `WORKFOLD_ALLOW_PUBLIC_ENROLLMENT=1` in Railway only while new
address creation should be available. The Railway service uses a 30-second
drain window so reconnect and same-request recovery can run during deployments.
