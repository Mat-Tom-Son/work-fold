# Online pages

> **Archived 2026-11-07:** the desktop no longer has Web Access or Publish; kept as history. Page folders, Preview, and `pages validate` remain; see [Pages](../pages.md).

> **Status:** Plan, 2026-11-05. Stages 0 (removing the old sharing), 1 (page
> folders, locally) and 2 (publishing online) are built; the contract is in
> [Pages](../pages.md). Stage 2 has been run end to end on one computer and is
> not deployed yet. "Ask the Worker about this data" is still to come. Decisions marked **Owner decision** were made
> by Mat on 2026-11-05; the rest is the proposed approach and can change as
> the build teaches us something.

## What we're building

Publish a page, including a working web page with a form and saved data, as
simply as **Publish → Copy link**. The page keeps working when the computer
is off. People understand one model, not several.

Example: "Make me an RSVP page for the garden party." The Worker builds it, you
try it in a tab, you click **Publish**, you send the link. Guests register
while your laptop is closed. Next time you open work-fold, their answers are in
the page's folder and in its Data tab, and you can ask the Worker "who's
bringing food?"

## The model

- **Pages are for other people.** They live online and work with the computer
  off. They can't touch your files, your Worker, or your computer.
- **Apps are tools for you.** They run inside work-fold and can use your files,
  the Worker, notifications, and connections. Nothing about apps changes here.

**Owner decision:** single-file publishing (Share a page from a file tab) and
**Share at your address** for apps are removed, along with Settings → Shared
Pages, the paired web client's Shared pages popup, and the bridge's page
serving. To share a document, ask the Worker to make a page from it.

### Every page is a page folder

```
Garden Party RSVP/
  index.html
  page.json      what the page collects and who can see it
  style.css, images, scripts
  data.sqlite    only if the page saves data
```

- The folder is exactly what goes online, minus `data.sqlite`. The Publish
  result lists every file that was uploaded, so a stray private file dropped
  into the folder doesn't go out unnoticed.
- A work-folder can hold any number of page folders. Pages don't use App
  Studio, App Projects, Releases, or installs.
- A page opens in a tab, like a file, not in the sidebar like an app. Its tab
  has the page preview and its Data view.
- `page.json` is what makes a folder a page. A loose HTML file is just a file.

## What the Worker gets (not user-facing)

Some things can't be trusted to page code, because it runs in a stranger's
browser. Those are declared in `page.json` and enforced by work-fold:

```
table rsvps: name (required), email (unique), guests (number), bringing
visitors: can add, can see their own
limit: 50 rows
```

- **Rules:** who can add, see, or change which rows; row limits; unique and
  required fields.
- **Browser calls:** add a row, get my rows, count rows, is this the owner. A
  form helper wires an ordinary HTML form to a table, with a built-in thank-you
  state and duplicate-submission protection.
- **Browsers never send SQL.** SQL is for the owner side only: the Data tab and
  the Worker querying the folder copy (macOS ships `sqlite3`).
- **work-fold provides the rest for every page:** the Data tab, export, check-in,
  "N new" notices, spam limits, and safe updates. The Worker doesn't build an
  admin screen.
- **Recipes** in the Worker guide: RSVP form, sign-up sheet with a cap, poll,
  shared checklist, status page an Automation keeps updated.

## Data

- **One SQLite database per page.** Online is the real copy while the page is
  collecting.
- **Checking in:** while work-fold is running it pulls changes down within
  moments, nudged over the connection it already keeps with work-fold.com, and
  catches up after the computer wakes.
- **The folder copy:** work-fold writes a complete `data.sqlite` into the page
  folder in one step, and only when something changed. One finished file is
  safe in Google Drive and Dropbox folders and keeps History from filling up
  with near-identical copies.
- **One way only:** online → folder. Editing the file changes nothing online.
  Changes to online data (delete spam, fix a typo, close a form) go through the
  Data tab or receipted Worker verbs.
- **Test data stays private.** Entries made while previewing go to a separate
  preview database in work-fold's own storage, never into `data.sqlite` and
  never online.
- **Updates never drop data silently.** A changed page can add tables and
  columns automatically; removing or renaming one needs an explicit step.
- **Automations:** a folder trigger can react when `data.sqlite` changes.
  Automations still can't publish, and page code can't publish.
- **Deliberate rule change:** app data today is machine-local and never enters
  a work-folder. Page data does, because getting it back is the point.

## The Data tab

- Browse each table: sort, search, filter, pick columns, open one row.
- What's new since you last looked, and when it last checked in.
- Delete or edit a row; the change goes online with a receipt.
- **Export as spreadsheet.**
- **Ask the Worker about this data** starts a Chat with the page's data in hand.
- Later: saved views such as "Attending only", which the Worker could create.

In Files, `data.sqlite` shows as **Data** and opens this tab. Nobody has to see
a raw `.sqlite` file.

## Hosting

**Owner decision (2026-11-05):** pages are hosted on Railway, in a new
service next to the bridge. No second provider.

- **One small service** serves the page shell, each page's files, and its
  page calls. It runs the same rules code as the preview in work-fold
  (`src/shared/pages` on Node's built-in SQLite), so the online page behaves
  exactly like the one you tested. Page code never runs on our servers, so
  there is no untrusted server code to sandbox.
- **Page data** is one SQLite file per page on a Railway volume; page files sit
  beside it. The service is separate from the bridge, so a bridge restart
  doesn't take pages down.
- **Backups are ours to run.** Railway's built-in volume backups appear to
  need the Pro plan, so the service copies each changed page database to a
  Railway storage bucket every few minutes. Each owner's `data.sqlite` in their
  own folder is a second copy.
- **One server in one region.** If it is down, pages are down. That's
  acceptable for an invited group; growing past it is a later decision.
- **Cost:** for a small group this should stay near the Hobby plan's included
  $5 of usage. Watch it once real visitors arrive.
- **Visitors' browsers** run the page in an opaque sandboxed frame inside a
  work-fold shell, the pattern shared apps already used. The sandbox keeps
  pages apart from each other and from work-fold. The shell carries a
  **Report** link the page can't hide.
- **Publisher account:** the existing work-fold.com address and password. From
  any browser, with the computer off, the owner can see the data, export it, or
  unpublish.
- **Visitors** get a lasting identity per browser, so they can come back and
  see their own entries. A different browser is a new visitor.
- **Privacy change:** unlike the retired shared pages, new pages and their data
  are readable by work-fold's service. It has to serve the files and enforce
  the rules. Say so in [Privacy](../../PRIVACY.md) when this ships.

## Controls and statuses

- **Publish**, **Copy link**, **Publish changes** (new snapshot, same link, data
  kept; a failed update leaves the old version up), **Unpublish**.
- One **Published** list in Settings for every page.
- Statuses: **Publishing**, **Online**, **Changes available**, **Could not
  publish**, **Paused** (a limit ran out; says which and when it resets),
  **Suspended** (an operator took it down; shows a reference and how to
  appeal; ordinary publishing can't clear it), **Unpublished**.

## Responsibilities

| Item | When it's needed |
| --- | --- |
| Only invited publishers | First invited release |
| Report link in the shell | First invited release |
| Suspend command and a short runbook | First invited release |
| Per-page limits on requests, rows, and storage | First invited release |
| Suspended status separate from Paused | First invited release |
| Terms of service and content policy | Before public launch |
| Bot challenge on submissions | Before public launch |
| Fuller abuse handling (case records, appeals process) | Before public launch |

## Naming

**Owner decision:** "Publish" only ever means putting a page on the web.

- App Studio merges **Prepare Release** and **Publish locally** into one **Save
  version** step, followed by **Install in work-folder**. The CLI verb `apps
  release publish` is renamed to match, and the
  [vocabulary glossary](../../scripts/vocabulary/GLOSSARY.md) updated.
- The `pages` CLI family returns with new verbs: `pages publish`,
  `pages unpublish`, `pages data …`. Every verb executes on first call and
  leaves a receipt ([Receipts, not gates](../receipts-not-gates.md)).

## Stages

**0. Remove the old sharing.** Single-file pages, Share at your address, Shared
Pages settings, the web client popup, the old `pages` verbs, and the bridge's
page serving.
*Done when:* none of it remains in the desktop, CLI, web client, or bridge, the
paired-browser private app views still work, and all checks pass.

**1. Page folders, locally.** The page folder format and `page.json`, the
browser calls and form helper, the local preview with its private preview
database, the page tab, the Data tab, and the Worker recipes. No hosting yet.
*Done when:* the Worker builds an RSVP page from one request, you can submit to
it in the preview and explore the entries in the Data tab, and test entries
never appear in `data.sqlite`.

**2. Publish online.** Hosting, the link, Publish changes, Unpublish, the
Published list, checking in to the page folder, and owner access from
work-fold.com.
*Done when:* you publish a page, quit work-fold, it still loads elsewhere;
Publish changes keeps the link; you unpublish from a phone with the computer
off; reopening work-fold brings the latest data into the folder.

**3. Forms for real visitors.** Visitor identity, enforced rules, spam limits,
Report, and suspend.
*Done when* the event-registration test passes: quit work-fold; two browsers
register; neither can see the other's entry; the owner sees and exports both;
an update keeps the data and the link; unpublish stops it.

**4. Later.** Server logic by running the app's worker online (sending emails,
taking payments, calling outside services, schedules), and private pages for
invited people.

## Left out for now

- Single-file publishing (removed; see above).
- A separate content domain and Public Suffix List entry. The sandboxed frame
  does that job.
- A second hosting provider. Cloudflare comes back only if pages need their
  own server code (stage 4, which needs a sandbox for untrusted code) or
  protection from heavy traffic (its free proxy can sit in front of Railway
  without moving anything).
- PostgreSQL and a database comparison. One SQLite file per page fits the
  one-database-per-page model and reuses the stage 1 code.
- Passkeys and an encrypted key vault. The existing work-fold.com sign-in is the
  publisher account.
- Any page code running on our servers, until stage 4.

## Open decisions

- The page link's domain.
- How much the Data tab edits online data beyond delete and simple edits.
- How often to copy page databases to the bucket, and how long to keep the
  copies.

## Publishing (stage 2) as built

> Moved here from [Pages](../pages.md) on 2026-11-07, when Publish was removed
> from the desktop. The page service and the bridge it describes are still in
> the repository and deployed separately; the desktop never connects to them.

> Built and run end to end locally; not deployed yet. Hosting is a Railway
> service next to the bridge (owner decision 2026-11-05; see [Hosting](#hosting)).

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
