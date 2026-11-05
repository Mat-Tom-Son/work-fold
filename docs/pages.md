# Pages

> **Status:** Stage 1 contract (local only), 2026-11-05. Pages can be built,
> previewed, and their test data explored inside work-fold. Publishing them
> online is stage 2 of the [Online pages plan](online-pages-plan.md); nothing
> in this document uploads anything.

A **page** is something you make for other people: an announcement, an RSVP
form, a sign-up sheet, a poll. An **app** is a tool for you inside work-fold.
Both are web pages underneath, but pages never use your files, your Worker,
your connections, or your computer, and they never go through App Studio.

## A page is a folder

A page is any folder inside a work-folder that contains a `page.json` file.

```
Garden Party RSVP/
  page.json      what the page is and what it collects
  index.html     the page itself
  style.css, app.js, images/…
  data.sqlite    real visitors' entries, stage 2 only
```

- Everything in the folder except `data.sqlite` (and its `-journal`/`-wal`/
  `-shm` side files), hidden files, `.work-fold/`, and `.pi/` is part of the
  page.
- A page folder cannot contain another page folder.
- Pages are not App Projects. A work-folder can hold any number of pages.
- A loose HTML file outside a page folder is just a file.

## page.json

```json
{
  "format": "work-fold.page/1",
  "title": "Garden Party RSVP",
  "tables": {
    "rsvps": {
      "columns": {
        "name": { "type": "text", "required": true },
        "email": { "type": "email", "required": true, "unique": true },
        "guests": { "type": "number", "min": 0, "max": 10 },
        "bringing": { "type": "choice", "options": ["Salad", "Dessert", "Drinks"] }
      },
      "visitors": ["add", "see-own", "edit-own"],
      "limit": 50
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `format` | Required, exactly `work-fold.page/1`. |
| `title` | Required, 1–120 characters. |
| `description` | Optional, up to 500 characters. |
| `entry` | Optional relative `.html` path inside the folder; default `index.html`. |
| `tables` | Optional map of up to 16 tables. A page without tables saves nothing. |

Unknown fields anywhere are errors, so a mistake is reported instead of
silently ignored.

**Tables.** Names match `^[a-z][a-z0-9_]{0,40}$` and never start with
`sqlite_`.

- `columns`: 1–64 columns, names matching the same pattern, never starting
  with `_` (work-fold's own columns do) and never `id` or `visitor` (every row
  already has those).
- `visitors`: what a visitor may do, any of `add`, `see-own`, `see-all`,
  `edit-own`, `delete-own`. Default: nothing. The owner may always do
  everything.
- `limit`: maximum live rows, 1–100,000; default 10,000. It applies to the
  owner too.

**Column types.**

| Type | Value | Extra fields |
| --- | --- | --- |
| `text` | string, one line | `max` length (default 500, up to 10,000) |
| `long-text` | string | `max` length (default 10,000, up to 100,000) |
| `number` | finite number | `min`, `max`, `integer: true` |
| `boolean` | true/false | — |
| `date` | `YYYY-MM-DD` or an ISO date-time | — |
| `email` | an email address, stored trimmed and lower-cased | — |
| `url` | an `http:` or `https:` URL | — |
| `choice` | one of `options` | `options`: 1–100 distinct, non-empty strings of up to 500 characters |

Every column also accepts `required` and `unique` (booleans). Empty strings
count as missing. Values for undeclared columns are refused. Values are read
leniently where it is unambiguous: numeric text for a `number`, `"true"`/
`"false"` for a `boolean`; `text` is trimmed and must be one line. One call's
values may be at most 1 MiB of JSON.

## What a page's code can use

work-fold injects `window.workFoldPage` before the page's own scripts. Every
call returns a promise. Visitors' browsers never send SQL; the host checks the
declared rules on every call.

| Call | Allowed when | Returns |
| --- | --- | --- |
| `add(table, values, { requestId })` | visitors have `add` | the new row |
| `mine(table)` | visitors have `see-own` | this visitor's rows, newest first (at most 1,000) |
| `list(table, { limit, newestFirst })` | visitors have `see-all` | rows, oldest first unless `newestFirst` (default limit 100, at most 1,000) |
| `count(table, where?)` | always | number of live rows; `where` is `{ column: value }` equality |
| `update(table, id, values)` | `edit-own` and the row is this visitor's | the updated row |
| `remove(table, id)` | `delete-own` and the row is this visitor's | `true` |
| `isOwner()` | always | whether the viewer is the page's owner |
| `onChange(callback)` | always | an unsubscribe function; `callback({ table })` runs when that table's data changes |

The owner may call everything on every row; rows the owner adds belong to the
owner, and the owner's `mine` returns them. A row is
`{ id, createdAt, updatedAt, ...columns }`; for the owner it also has
`visitor`, an opaque visitor id (`v_` and 32 hex digits, or `owner`).

Failed calls reject with `{ code, message, field? }`. Codes: `NOT_ALLOWED`,
`INVALID`, `DUPLICATE`, `LIMIT_REACHED`, `NOT_FOUND`, `TOO_LARGE`,
`UNAVAILABLE`. `message` is plain English a page can show.

Retries are safe: each `add` carries a request id (generated unless given), and the same visitor's same
id within ten minutes returns the row it already created, even when the table
has since filled up. Another visitor's row is `NOT_ALLOWED`; a missing or
deleted row is `NOT_FOUND`. While `page.json` is broken, page calls answer
`UNAVAILABLE`.

**Form helper.** A form with `data-page-table="rsvps"` saves itself:

- On submit, work-fold collects fields whose `name` is a column of the table
  (checkboxes become booleans, number inputs numbers, empty fields are left
  out), checks them against the declaration, and calls `add`. It keeps one
  request id until the entry is saved, so a retry never adds twice.
- A page's own submit handler that calls `preventDefault()` turns the helper
  off for that form.
- The form's `data-page-state` becomes `sending`, then `sent` or `error`. The
  submit button is disabled while sending. On success the form is reset.
- Any element inside the form with `data-page-message` receives the error
  text, or is emptied on success.
- The form dispatches `page:sent` (detail: the row) or `page:error` (detail:
  the error).

Page CSS styles the states, for example
`form[data-page-state="sent"] .thanks { display: block }`.

## How a page runs

A page runs in an opaque-origin sandbox. That is the same shape it will have
online, so what you preview is what visitors get.

- work-fold assembles the page folder into one self-contained document.
  Stylesheets, scripts, CSS `url()` and `@import` targets, images, media,
  fonts, and icons that point at files inside the folder are inlined (data URLs
  for binary files). `type="module"` scripts are allowed but cannot import
  other files.
- References to files outside the folder, and any `http:`, `https:`, or `//`
  resource (including resource hints such as `preconnect`), are validation
  errors. Libraries must be saved into the folder. A leading `/` means the page
  folder. `<base>`, and `<iframe>`, `<embed>`, or `<object>` that load
  anything, are errors. Deferred and async classic scripts move to the end of
  `<body>` when inlined. Ordinary `<a href="https://…">` links are allowed and
  open outside the page.
- The document runs inside a sandboxed frame (`allow-scripts allow-forms`,
  never `allow-same-origin`) with this policy: `default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
  font-src data:; media-src data: blob:; connect-src 'none';
  form-action 'none'; frame-src 'none'; base-uri 'none'`. Page code cannot
  reach the network, work-fold, or other pages; it talks only to
  `workFoldPage` over a per-view message channel. One gap remains: no policy
  covers WebRTC, so a page could still reach a STUN server; the hosted stage
  must close it. The host follows the
  intermediary pattern already used for paired-browser app views
  (`services/bridge/public/browser-app-frame.*`).
- Limits: up to 500 files, 10 MiB per file, 25 MiB per page.
- Only the entry file is a page; other `.html` files in the folder are
  reported as unused. A page that needs several screens switches them in
  script.

## Preview and test entries

A page opens in a **page tab** with two views, **Preview** and **Data**.

- Preview runs the page as described above. A small bar above it shows
  **Viewing as**: Visitor, Owner, or New visitor (a fresh visitor, to check
  that one visitor can't see another's entries).
- Entries made in Preview are **test entries**. They live in work-fold's own
  storage under the state root (`pages/preview/<workFolderId>/<key>.sqlite`,
  keyed by the page folder's work-folder-relative path), never in the
  work-folder and never online. Renaming the page folder starts a fresh test
  database.
- Edits to the page's files show up in Preview on reload. When `page.json`
  changes, new tables and columns are added automatically. Columns and tables
  that disappear from `page.json` keep their data and show in the Data view as
  no longer collected; nothing is dropped.
- Problems found by validation appear as a short list above the preview
  instead of a broken page.

## The Data view

For each table: a grid of rows with sort, search, per-column filters, column
show/hide, and a row detail panel. The owner can edit a value (checked against
the declaration) or delete rows.

- **Deleting is reversible.** Deleted rows move to a **Deleted** list in the
  same view, where they can be restored; page calls never see them. They are
  purged after 30 days.
- **What's new:** rows added since you last looked are marked, with a count
  per table.
- **Export as spreadsheet** saves a CSV of all the table's live entries,
  whatever is filtered on screen. It starts with a
  byte-order mark so spreadsheets read it as UTF-8, and text beginning with
  `=`, `+`, `-`, or `@` is prefixed with `'` so it is never run as a formula.
- While `page.json` is broken, the view keeps working from the last declaration
  that was applied.
- The view is labeled "Test entries — only you can see these. They're never
  published." Stage 2 adds the real visitors' data next to it.

## For the Worker

- `work-fold pages validate --work-folder <id> --page <path> [--json]` checks a
  page folder: `page.json`, the entry, every reference, sizes, and nested
  pages. It reports problems with the file and a plain message, and a summary
  (title, tables, files, bytes). It exits 0 whenever it could check the page;
  `valid` says whether it passed. The page tab shows the same problems.
- The Worker's guide explains when to make a page or an app, the folder
  layout, `page.json`, the calls, the form helper, the no-network rule, and
  recipes: RSVP form, sign-up sheet with a cap, poll with live counts.

## Storage and code layout

- The rules engine (declaration parsing, validation of values, rule checks,
  additive schema updates, row operations) is plain TypeScript over a small
  SQL interface (`exec`, `run`, `all`, `get` with bound parameters), so the
  same code can later run inside the hosted service. It lives under
  `src/shared/pages/`. The Node adapter uses the built-in `node:sqlite`
  (`DatabaseSync`), available in Node 24 and Electron 42.
- Work-fold's own columns on every table: `_id` (text), `_visitor` (text),
  `_created`, `_updated`, `_deleted` (ISO timestamps; `_deleted` null when
  live), `_request` (the add's request id). A `_page_meta` table records the
  declaration digest and when it was applied.
- Local API routes live in their own module under `src/local/pages/`, mounted
  from `src/local/server.ts`, all scoped to `/api/work-folders/:id/pages/…`
  and requiring the ordinary local session.

## Local API

`:id` is the work-folder id and `page` is the page folder's
work-folder-relative path. Page-call refusals answer
`{ error, code, message, field? }` with status 403 (`NOT_ALLOWED`), 400
(`INVALID`), 409 (`DUPLICATE`, `LIMIT_REACHED`), 404 (`NOT_FOUND`), 413
(`TOO_LARGE`), or 503 (`UNAVAILABLE`). The frame assets are served without a
session, because an iframe cannot send the session header.

| Route | Purpose |
| --- | --- |
| `GET /api/work-folders/:id/pages` | `{ pages: [{ path, title, problemCount, errorCount }], truncated }` for every page folder |
| `GET …/pages/inspect?page=` | `{ page: { path, title, description, entry, tables: [{ name, columns: [{ name, type, … }], visitors, limit }] }, problems: [{ file, message, severity }], summary: { files, bytes } }` |
| `GET …/pages/document?page=` | `{ html, problems }`; `html` is the assembled document, or `null` when errors prevent assembly |
| `POST …/pages/preview/call` | `{ page, viewer: { role: "visitor", visitor } \| { role: "owner" }, call: { op, table, values, id, where, options, requestId } }` → `{ result }` |
| `POST …/pages/preview/visitor` | `{ page, fresh }` → `{ visitor }`, the current or a fresh preview visitor |
| `GET …/pages/preview/data?page=` | `{ tables: [{ name, retired, limit, live, deleted, newCount, lastSeen }] }` |
| `GET …/pages/preview/data?page=&table=&deleted=` | `{ table, retired, limit, deleted, columns: [{ name, type, retired, … }], rows, total, lastSeen }`; rows are `{ id, visitor, createdAt, updatedAt, deletedAt, ...columns }` |
| `POST …/pages/preview/data/update` | `{ page, table, id, values }` → `{ row }` |
| `POST …/pages/preview/data/delete` | `{ page, table, ids }` → `{ deleted }` |
| `POST …/pages/preview/data/restore` | `{ page, table, ids }` → `{ restored }` |
| `POST …/pages/preview/data/seen` | `{ page, table }` → `{ lastSeen }` |
| `GET …/pages/preview/data/export?page=&table=` | CSV of the table's live rows |
| `GET /page-frame.html`, `GET /page-frame.js` | the sandbox intermediary, served with its own policy |

## Publishing (stage 2)

> Built and run end to end locally; not deployed yet. Hosting is a Railway
> service next to the bridge ([Online pages plan](online-pages-plan.md), owner decision
> 2026-11-05).

**For the person.** In a page tab, **Publish** puts the page online and shows
its link with **Copy link**. Later edits change only the preview until
**Publish changes**. **Unpublish** takes it offline and keeps its entries;
publishing again brings back the same link. Settings → **Published** lists
every published page. Publishing needs Web Access (the work-fold.com address)
to be set up; without it, Publish says so and points to Settings. Entries
visitors make online come back into the page folder as `data.sqlite` whenever
work-fold is running, and the Data view switches between **Online entries**
and **Test entries**. From any browser, signed in at the work-fold.com address
with the computer off, the owner can see each page's entries, export them,
and unpublish.

**Pieces.**

```
Desktop (local API) ──device token──▶ Bridge ──private network + secret──▶ Page service
Owner's browser ─────session cookie──▶ Bridge ───────────────────────────▶ Page service
Visitor's browser ─────────────────────────────────────────────────────────▶ Page service
```

- The **page service** (`services/pages/`) serves pages to visitors and keeps
  each page's data. It never handles passwords or device tokens; its
  publisher/owner API is internal, reached only from the bridge.
- The **bridge** authenticates the desktop (device bearer token) and the owner
  (password session cookie, CSRF on changes), then calls the page service with
  the account id.
- The **desktop** publishes, unpublishes, checks in, and shows everything.

**Identity and links.** A page id is `pg_` plus 26 lowercase base32 characters
(130 random bits), chosen by the desktop the first time a page folder is
published and kept for that folder. The link is `<pages origin>/p/<pageId>`;
the id is the only thing that grants access, so receipts, logs, and the
overview never contain the full id or link (they use its first 8 characters).
The local record of a page's id and link lives in work-fold's state root,
never in the work-folder.

### Page service

Configuration: `PORT` (public), `WORKFOLD_PAGES_INTERNAL_PORT`,
`WORKFOLD_PAGES_INTERNAL_SECRET`, `WORKFOLD_PAGES_DATA_DIR` (the volume),
`WORKFOLD_PAGES_PUBLIC_ORIGIN` (e.g. `https://pages.work-fold.com`), and
optional bucket settings for backups (`WORKFOLD_PAGES_BACKUP_*`). It uses the
same rules engine as the preview (`src/shared/pages` on `node:sqlite`) and
has no npm dependencies; a build step bundles it into
`services/pages/dist/server.mjs`.

Storage: `registry.sqlite` (page id, account id, title, status, active
revision, timestamps, data revision) and per page `pages/<pageId>/rev-<n>.html`
(the assembled document) and `pages/<pageId>/data.sqlite`. Every data change
increments the page's data revision. Backups copy each changed `data.sqlite`
and the registry to the bucket every five minutes when configured.

**Public routes** (the pages origin):

| Route | Purpose |
| --- | --- |
| `GET /p/:pageId` | The trusted shell: the page's title and the sandbox, running the page exactly as Preview does. Unknown or unpublished pages get one identical "Nothing is published here." page (404). |
| `GET /p/:pageId/document` | `{ html }` of the active revision |
| `POST /p/:pageId/call` | A page call `{ call }` for this visitor, answered like the preview call route |
| `GET /page-frame.html`, `GET /page-frame.js` | The intermediary, with its policy |

The visitor is a cookie `wfv` (`v_` + 32 hex), `Path=/p/<pageId>`, `HttpOnly`,
`SameSite=Lax`, `Secure` except on loopback, about 400 days; one is created on
the first call. Visitors never see `visitor` on rows. Calls are limited per
page and per address (120 per minute per address, 600 per minute per page;
over that, `UNAVAILABLE` with a plain message). The shell's policy allows only
its own script, its own API, and the intermediary frame.

**Internal routes** (internal port, header `x-work-fold-pages-secret`; the
page must belong to the account in the path, otherwise 404):

| Route | Purpose |
| --- | --- |
| `PUT /internal/accounts/:accountId/pages/:pageId` | Publish or publish changes: `{ title, html, declaration, files, contentDigest }` → `{ page }`. Same digest as the active revision: no new revision. Applies the declaration additively; keeps data; status becomes `online`. |
| `DELETE /internal/accounts/:accountId/pages/:pageId` | Unpublish → `{ page }` with status `unpublished`; data kept |
| `GET /internal/accounts/:accountId/pages` | `{ pages: [page] }` |
| `GET …/pages/:pageId` | `{ page }` |
| `GET …/pages/:pageId/data.sqlite` | A consistent snapshot of the page's database; header `x-work-fold-data-revision` |
| `GET …/pages/:pageId/data[?table=&deleted=]` | Same shapes as the preview data routes |
| `POST …/pages/:pageId/data/update`, `/delete`, `/restore` | Same bodies as the preview data routes |
| `GET …/pages/:pageId/data/export?table=` | CSV, as in preview |

A `page` is `{ pageId, title, status: "online" | "unpublished", revision,
publishedAt, updatedAt, dataRevision, entries }`. Publish bodies may be up to
26 MiB.

### Bridge

Configuration: `WORKFOLD_PAGES_INTERNAL_URL`, `WORKFOLD_PAGES_INTERNAL_SECRET`,
`WORKFOLD_PAGES_PUBLIC_ORIGIN`. Without them every page route answers 503
"Online pages aren't available yet."

| Route | Who | Proxies to |
| --- | --- | --- |
| `GET /api/device/pages` | device token | list, plus `pagesOrigin` |
| `PUT /api/device/pages/:pageId` (≤ 26 MiB) | device token | publish |
| `DELETE /api/device/pages/:pageId` | device token | unpublish |
| `GET /api/device/pages/:pageId/data.sqlite` | device token | snapshot |
| `POST /api/device/pages/:pageId/data/(update\|delete\|restore)` | device token | owner data changes |
| `GET /api/pages` | owner session | list, plus `pagesOrigin` |
| `GET /api/pages/:pageId/data[?table=&deleted=]` | owner session | data |
| `GET /api/pages/:pageId/data/export?table=` | owner session | CSV |
| `POST /api/pages/:pageId/unpublish` | owner session + CSRF | unpublish |

Owner routes need only a signed-in session for that account, not a paired
browser, so they work with the desktop off. The web client gains a
**Published** view reachable right after sign-in: each page's title, status,
link, entries, export, and Unpublish.

### Desktop

| Local API route | Purpose |
| --- | --- |
| `GET /api/work-folders/:id/pages/publication?page=` | `{ available, unavailableReason, publication }`; `publication` is null or `{ url, status, revision, publishedAt, changesAvailable, lastCheckIn, dataRevision }` |
| `POST /api/work-folders/:id/pages/publish` | `{ page }` → `{ publication, uploaded: { files, bytes } }`; refuses with the validation problems when the page has errors, or `WEB_ACCESS_REQUIRED` |
| `POST /api/work-folders/:id/pages/unpublish` | `{ page }` → `{ publication }` |
| `POST /api/work-folders/:id/pages/online/check-in` | `{ page }` → checks in now |
| `GET /api/pages/published` | `{ publications: [{ workFolderId, workFolderName, path, title, url, status, publishedAt, changesAvailable }] }` |
| `…/pages/online/data…` | The preview data routes' shapes, for Online entries: reads come from the folder's `data.sqlite`; changes go online, then check in |

- `changesAvailable` compares the digest of the assembled document plus
  `page.json` with what was last published.
- **Checking in:** at startup, every minute while running, after waking, and
  after any publish or data change, work-fold asks the bridge for the list of
  pages and downloads `data.sqlite` for each page whose data revision moved,
  writing it into the page folder as one finished file (temporary file, then
  rename; never `-wal` or `-journal` files). It never writes when nothing
  changed.
- **Acts:** `work-fold pages publish|unpublish --work-folder <id> --page <path>`
  and `work-fold pages list`. Publish makes the folder's bytes reachable by
  anyone with the link, so it runs as a prepared act (pinned inputs, journal
  first, at most once, receipt), like other widening verbs; unpublish is a
  direct verb. Receipts name the page by path and the first 8 characters of
  its id. Automations can't publish.
- **UI:** the page tab shows **Publish** (or **Online** with **Copy link**,
  **Open**, **Publish changes** when available, and **Unpublish** in its menu);
  the publish result lists the uploaded files; Settings → **Published** lists
  every page; in Files, `data.sqlite` shows as **Data** and opens the Data
  view.

### Left for later in stage 2

A push from the bridge when entries arrive (check-in polls every minute for
now), and an overview notice for new entries.
