# work-fold page service

Serves published pages to visitors and keeps each page's entries. The contract
is [Pages: Page service](../../docs/archive/online-pages-plan.md#page-service); the background is
the [Online pages plan](../../docs/archive/online-pages-plan.md).

- **Public port** (`PORT`): the trusted shell at `/p/<pageId>`, the page's
  document, page calls for the visitor, the sandbox intermediary
  (`/page-frame.html`, `/page-frame.js`), `/health`, and `robots.txt`.
- **Internal port** (`WORKFOLD_PAGES_INTERNAL_PORT`): the publisher and owner
  API under `/internal/accounts/<accountId>/pages`, reached only from the
  [bridge](../bridge/README.md) over the private network. Every request needs
  `x-work-fold-pages-secret`. Without a secret of at least 16 characters the
  internal routes don't start, and `/health` reports `"internal": "off"`.

The service runs the same rules engine as the desktop's Preview
(`src/shared/pages` on Node's built-in `node:sqlite`) and the same sandbox
intermediary (`src/local/pages/frame/page-frame-assets.ts`). It has no npm
dependencies at runtime: a build step bundles everything into
`dist/server.mjs`, which is not committed.

## Build

From the repository root, with Node 24:

```bash
npm --prefix . run pages:build     # writes services/pages/dist/server.mjs
npm --prefix . run pages:check     # type-checks the service and its tests
```

## Run locally

```bash
npm --prefix . run pages:build
export SECRET="$(openssl rand -hex 32)"
PORT=4330 \
WORKFOLD_PAGES_INTERNAL_PORT=4331 \
WORKFOLD_PAGES_INTERNAL_SECRET="$SECRET" \
WORKFOLD_PAGES_DATA_DIR="$TMPDIR/work-fold-pages" \
WORKFOLD_PAGES_PUBLIC_ORIGIN=http://127.0.0.1:4330 \
npm --prefix services/pages start
```

`npx tsx services/pages/src/main.ts` runs the same thing from source. To try
it with a local bridge, give the bridge `WORKFOLD_PAGES_INTERNAL_URL=http://127.0.0.1:4331`,
the same secret, and the same `WORKFOLD_PAGES_PUBLIC_ORIGIN`. Without a
bridge, publish directly on the internal port:

```bash
curl -X PUT http://127.0.0.1:4331/internal/accounts/11111111-2222-4333-8444-555555555555/pages/pg_abcdefghijklmnopqrstuvwxyz \
  -H "x-work-fold-pages-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"title":"Hello","html":"<!doctype html><p>Hello</p>","contentDigest":"0123456789abcdef","declaration":{"format":"work-fold.page/1","title":"Hello"}}'
open http://127.0.0.1:4330/p/pg_abcdefghijklmnopqrstuvwxyz
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Public port (default 8080). |
| `WORKFOLD_PAGES_INTERNAL_PORT` | Internal port for the bridge; must differ from `PORT`. Never give it a public domain. |
| `WORKFOLD_PAGES_INTERNAL_SECRET` | Shared with the bridge; at least 16 characters (use `openssl rand -hex 32`). |
| `WORKFOLD_PAGES_DATA_DIR` | Required. The volume holding everything below. |
| `WORKFOLD_PAGES_PUBLIC_ORIGIN` | The pages origin, e.g. `https://pages.work-fold.com`; page calls from it are accepted. |
| `WORKFOLD_TRUST_PROXY=1` | Behind Railway's proxy: take the visitor's address from `x-real-ip` and the host from `x-forwarded-host`, as the bridge does. |
| `WORKFOLD_PAGES_BACKUP_ENDPOINT` | Bucket endpoint, e.g. `https://storage.railway.app`. |
| `WORKFOLD_PAGES_BACKUP_REGION` | Signing region; default `auto`. |
| `WORKFOLD_PAGES_BACKUP_BUCKET` | Bucket name. |
| `WORKFOLD_PAGES_BACKUP_ACCESS_KEY_ID` | Bucket access key id. |
| `WORKFOLD_PAGES_BACKUP_SECRET_ACCESS_KEY` | Bucket secret key. |
| `WORKFOLD_PAGES_BACKUP_PREFIX` | Key prefix; default `work-fold-pages/`. |
| `WORKFOLD_PAGES_BACKUP_PATH_STYLE=1` | Address the bucket as `endpoint/bucket/key` instead of `bucket.endpoint/key`. |

Backups are on only when endpoint, bucket, access key id, and secret are all
set. With none, they are off; with only some, they are off and `/health` names
what is missing.

## Storage

Under `WORKFOLD_PAGES_DATA_DIR`:

```
registry.sqlite                 every page: account, title, status, active revision,
                                timestamps, data revision, entry count
pages/<pageId>/rev-<n>.html     the assembled document; the active revision and the one before it are kept
pages/<pageId>/data.sqlite      the page's entries, in the rules engine's layout
tmp/                            temporary files (uploads, snapshots); emptied at startup
```

A page belongs to the account that first published it, forever. The data
revision lives in each page database's `_page_meta` and moves in the same
transaction as the change: visitor calls that change rows, the owner's
edits, deletes, and restores, the 30-day purge of deleted rows, and a publish
that adds tables or columns. `GET …/data.sqlite` answers with a `VACUUM INTO`
snapshot and `x-work-fold-data-revision`.

## Backups and restoring

Every five minutes the service uploads, with a signed S3 `PutObject`:

- `<prefix>pages/<pageId>/data.sqlite` for each page whose data revision moved,
- `<prefix>pages/<pageId>/rev-<n>.html` once for each new active revision,
- `<prefix>registry.sqlite` when the registry changed.

Each key holds the latest copy; turn on bucket versioning or lifecycle rules to
keep older ones. `/health` shows the last run, the last success, and the last
error. To restore, stop the service, copy the objects into the volume at the
same paths (without the prefix), and start it again.

## Deploy on Railway

One replica in the bridge's Railway project, with a volume. The service has
no build step on Railway: its bundle needs the repository's shared source,
so it is built locally and uploaded. `.railwayignore` re-includes `dist/`,
which the repository's `.gitignore` leaves out.

1. Create a service named `pages`. Attach a volume mounted at `/data` and set
   `WORKFOLD_PAGES_DATA_DIR=/data`.
2. Set `WORKFOLD_PAGES_INTERNAL_PORT` (e.g. `8081`), `WORKFOLD_PAGES_INTERNAL_SECRET`,
   `WORKFOLD_PAGES_PUBLIC_ORIGIN=https://pages.work-fold.com`, and
   `WORKFOLD_TRUST_PROXY=1`. Railway provides `PORT`.
3. Give the public domain to `PORT` only. The internal port is reached over the
   private network.
4. On the bridge, set `WORKFOLD_PAGES_INTERNAL_URL=http://pages.railway.internal:8081`,
   the same secret, and the same public origin.
5. Create a storage bucket and set the `WORKFOLD_PAGES_BACKUP_*` variables from
   its credentials.
6. Build and deploy from the repository root:

   ```bash
   npm --prefix . run pages:build
   npm --prefix . run railway -- up services/pages --path-as-root --service pages
   ```

7. Check that the deploy log shows `dist/server.mjs` starting, and that
   `https://pages.work-fold.com/health` reports `"internal": "on"` and
   `"backups": { "enabled": true, … }`.

The volume can be mounted by one deployment at a time, so a deploy has a
short gap while the old one stops.

## Tests

```bash
npm test -- tests/page-service-publish.test.ts tests/page-service-visitors.test.ts tests/page-service-shell.test.ts tests/page-service-backup.test.ts
```

The suites start the service in-process on random loopback ports with a
temporary data folder; the backup suite uses a stand-in S3 server and checks
the request signing against the AWS Signature Version 4 examples.
