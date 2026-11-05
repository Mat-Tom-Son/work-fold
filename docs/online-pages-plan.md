# Online pages

> **Status:** Plan, 2026-11-05. Stage 0 (removing the old sharing) and
> stage 1 (page folders, locally; contract in [Pages](pages.md)) are built.
> "Ask the Worker about this data" waits for stage 2, when the data is in the
> page folder. Decisions marked **Owner decision** were made
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
  the rules. Say so in [Privacy](../PRIVACY.md) when this ships.

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
  [vocabulary glossary](../scripts/vocabulary/GLOSSARY.md) updated.
- The `pages` CLI family returns with new verbs: `pages publish`,
  `pages unpublish`, `pages data …`. Every verb executes on first call and
  leaves a receipt ([Receipts, not gates](receipts-not-gates.md)).

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
