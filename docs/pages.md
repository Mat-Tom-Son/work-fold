# Pages

> **Status:** Contract, 2026-11-05; Publish removed 2026-11-07. Pages are
> built, previewed, and their entries explored inside work-fold, on this
> computer. Nothing in this document uploads anything. The earlier plan to put
> pages online is [archived](archive/online-pages-plan.md).

A **page** is a small interactive web page kept in a folder: an announcement,
an RSVP form, a sign-up sheet, a poll. It runs in its page tab on this
computer. An **app** is a tool for you inside work-fold. Both are web pages
underneath, but pages never use your files, your Worker, your connections, or
your computer, and they never go through App Studio.

## A page is a folder

A page is any folder inside a work-folder that contains a `page.json` file.

```
Garden Party RSVP/
  page.json      what the page is and what it collects
  index.html     the page itself
  style.css, app.js, images/…
```

- Everything in the folder except hidden files, `.work-fold/`, `.pi/`, and a
  `data.sqlite` (with its `-journal`/`-wal`/`-shm` side files) left by an
  earlier version is part of the page.
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

A page runs in an opaque-origin sandbox.

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
  `workFoldPage` over a per-view message channel through a sandbox
  intermediary (`/page-frame.html`). One gap remains: no policy covers WebRTC,
  so a page could still reach a STUN server.
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
  work-folder. Renaming the page folder starts a fresh test
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
- The view is labeled "Entries made in Preview. Only you can see them."

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
  SQL interface (`exec`, `run`, `all`, `get` with bound parameters). It lives
  under `src/shared/pages/`. The separately deployed page service in
  `services/pages/` still bundles it; the desktop never connects to that
  service. The Node adapter uses the built-in `node:sqlite`
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
