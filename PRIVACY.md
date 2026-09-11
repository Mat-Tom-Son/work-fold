# Privacy

Last updated: September 7, 2026

work-fold is a local-first desktop application. Core Space use does not require a work-fold account; a person may optionally create a private work-fold Remote access address. The current application does not include first-party analytics, advertising, or usage telemetry.

This document describes the behavior of the open-source work-fold application. Model providers, GitHub, package hosts, cloud-sync software, and third-party Skills or Extensions have their own privacy terms.

## What stays on this computer

By default, work-fold stores:

- Space files in the ordinary folders the user creates or registers.
- A hidden `.work-fold/` directory inside each Space. Its `space.json` file stores the portable Space identity, and its `conversations/` directory stores that Space's append-only Chat records, including title, archive, and snooze lifecycle events.
- Library materials, the Space registry, History objects, ignore rules, application settings, per-Space model defaults and Space instructions, and machine-local Chat attention acknowledgements under the local work-fold application-data directory or browser-backed application storage.
- Pi settings, sessions, Pi's independent trust decisions, personal Skills, Extensions, and packages under the configured Pi agent directory, normally `~/.pi/agent`.
- Provider credentials in an application-scoped file encrypted through Electron's operating-system-backed `safeStorage`. work-fold refuses credential operations when that encryption is unavailable.
- Restricted-app Development-preview receipts and package snapshots; machine-local App Project identity and presentation; immutable content-addressed Release envelopes; prepared/published state; install/update operation journals; local App Instance records; per-automation enablement/cadence state and bounded run receipts; retained-data records; and Tenant-and-Data-Namespace-owned JSON storage under the application-data `restricted-apps` directory. Separately encrypted restricted-app connections bind their exact runtime and installation identities in `restricted-app-connections.bin`.
- Short-lived CLI request, claim, and response files under the owning app's application-data directory: `%APPDATA%\work-fold\cli` for an installed Windows app, `%APPDATA%\work-fold Development\cli` for an uninstalled Windows package, and the corresponding production or separately identified smoke-app directory on macOS.
- The management conversation's machine-local transcript under the application-data `management/` root. When a request includes attachments, its user message stores their typed absolute local paths or http(s) links; remote uploads land in an app-owned holding folder under `management/Incoming/Remote/`. Request records — the turns and Spaces one ask spans, its questions and answers, and the results handed back — are durable machine-local app state under the application-data `requests/` directory, reconciled after a restart and never replayed, and kept for 30 days after the request settles; act lineage stays metadata in the receipt journal. Like the other records below, nothing in `requests/` is written into a Space folder, captured by History, or synchronized by anything that synchronizes a Space.
- Unsent answers to Assistant questions in the current renderer or browser tab’s session storage. They survive refresh/reconnect, clear when accepted or when the tab session ends, and are not sent to the host or model until submitted. The paired browser also clears these drafts on sign-out or when its grant is removed.
- Optional Remote access device credentials, P-256 private keys, paired-browser public keys, and revocation state in the same operating-system-encrypted secure settings file as other application credentials. A paired browser keeps its own non-exportable private keys and grant identity in that browser's IndexedDB; it does not store a transcript or Space file cache there.
- Act receipts; Recently deleted items under the application-data `trash/` directory, each holding the moved bytes or a recovered copy plus a manifest (source Space id, original Space-relative path, kind, size, deleted-at, restore-by, and the receipt that produced it), kept for the retention window — 30 days by default, changed in Settings → The fold → Recently deleted — and then removed; routing declarations with their exact-declaration enablement receipts, cadence anchors, and run receipts; request records with their questions, answers, and results under the application-data `requests/` directory; publication records; and per-surface glance last-seen markers — all under the work-fold application-data directory. Receipts record the initiating surface and, for remote-originated acts, the initiating browser and grant. Publication encryption keys live in the same operating-system-encrypted secure settings as other credentials. None of these records is written into any Space folder, captured by History, or synchronized by anything that synchronizes a Space.

work-fold uses a new application profile and does not inspect, import, migrate, rewrite, wipe, or delete legacy Workspace application data or `.workspace/` folder metadata. Legacy bytes remain where they already are and are not authoritative in work-fold. The app keeps `.workspace/` hidden and excludes it from History, Search, Checks, and restricted-app file grants. Pi's personal resources and authentication may still be read from the configured Pi agent directory, while work-fold keeps its Pi sessions in the separate `sessions/work-fold/` namespace.

Registering an existing folder does not upload, move, duplicate, or rename the user's files. It does add the documented hidden `.work-fold/` identity and Chat storage. Removing a linked Space from work-fold leaves both the ordinary files and `.work-fold/` in place. Deleting a work-fold-managed Space unregisters it and moves its managed folder into Recently deleted, where it stays restorable for the retention window. If a Space is the source or target of an active release-backed App Instance, work-fold blocks either removal until that App is explicitly uninstalled. Retained App data continues to block its source Space until explicit purge, but does not block removal of the former target. Once those obligations are gone, source removal also deletes that Project's machine-local App Studio metadata and marks unreferenced Release objects for safe reconciliation; transient cleanup failure is retried before later App mutations and at startup. Target removal cancels prepared operations aimed at it. Uninstalling work-fold does not itself delete linked Space folders.

Managed-folder deletion is also blocked when the claimed tree contains preserved
`.workspace/` metadata. The person may remove the work-fold registration without
deleting the ordinary folder; work-fold never uses managed deletion to erase
legacy product data.

## When data leaves this computer

The development branch supports named [app-requested Assistant tasks](docs/app-assistant-tasks.md).
A request starts a Chat in the owning Space at once, sending the app's
instructions and input through that Space's usual model and tools; the Apps tab
shows its status and can open or stop it. The successful reply is shared with the
requesting app, which may use its separately granted capabilities. An app can
also make one bounded model call with no tools and no transcript, on the Space's
configured model. Request, inference, and result receipts are kept in
machine-local app data and name the effective model; the sent prompt and normal
reply also belong to that Space's portable Chat. No other Chat or fold transcript
is shared with the app. Failed and interrupted tasks expose no partial reply or
provider error.

When the Assistant above your Spaces hands work to a Space, the assignment it
writes becomes an ordinary message in that Space's portable Chat and goes to
that Space's configured model provider with the rest of the turn. The same is
true of an answer to a question that Space asked, and of the message and files
handed over when one Space asks another for help — copied files land in the
destination Space with a restore point, exactly like adding a file yourself. A
result handed back — its summary, its structured details, and the list of files
it chose — is recorded machine-locally and reaches another Space's Chat only
when someone deliberately puts it there. Questions, answers, results, and the
request graph are not sent anywhere else by work-fold.

The development version adds **Export data**, **Restore…**, and recoverable
**Clear data** to app details. Exports contain the app's complete JSON data and
its non-secret installation identity, saved to the location chosen in the
download dialog; work-fold does not upload them. Host-held connections, grants,
Chats and ordinary Space files are excluded. Clear and restore retain one
previous data snapshot on this computer for Undo. A later clear/restore replaces
that snapshot; uninstall with purge removes it with the namespace. Retained
data can be exported from its source Project without reactivating the app.
See [App data recovery](docs/app-data-recovery.md) for exact limits and retention.

App data and management controls carry the non-secret installation identity
as well as the installed revision. Removing and reinstalling the same code does
not let an old control read or modify the new installation's data.

The development branch's **Change this app** copies only the verified installed
package into its source Space, where ordinary folder backup/synchronization rules
apply. Its machine-local provenance records the source working path, exact app
revision and installation identities, and a building Chat id when available.
Runtime data, credentials, grants, target files, and Chat content are excluded.
The initial draft is unsent; model use begins only when the person sends it.
See [Changing an installed app](docs/app-changes.md).

### Optional Remote access bridge

When Remote access is enabled, the desktop maintains an authenticated WebSocket
to the work-fold bridge and the browser connects to its private
`<name>.work-fold.com` address. The bridge can receive the chosen address,
network metadata such as IP address and user agent, a scrypt password verifier,
device and browser public keys, desktop-signed pairing certificates, hashed
session/CSRF tokens, grant status, operation names/ids/timestamps, and encrypted
envelope sizes. The six-digit pairing display is derived from a fresh
browser-contributed pairing id, the browser identity, and its public keys; the
browser and desktop compute it independently. It may temporarily buffer signed
encrypted envelopes and events in process memory. It stores identity, session,
grant, and bounded operation
metadata in PostgreSQL, but it does not durably store prompt text, conversation
text, Assistant results, Space names, file names, file metadata, or file
contents.

Content-bearing browser and desktop payloads use signed application-layer
envelopes encrypted with keys held by the paired browser and desktop. The
normal bridge path therefore routes ciphertext rather than durably recording
plaintext, and this does not hide ordinary network metadata. Remote access is
currently a private alpha whose hosted client and bridge are
trusted parts of the authority boundary: because that origin serves the web
code which may use a paired browser's non-exportable key, an active compromise
of the hosted service can read displayed content or issue authorized requests.
The envelope design protects passive relay handling and persisted state; it is
not a guarantee against a malicious hosted origin. The browser renders bounded
saved management transcripts and filtered, bounded Space-relative file-tree
projections in memory and starts fresh by fetching them again after sign-in.
Explicit file previews read bounded text or images from a selected visible
Space-relative path without invoking a model or publishing the file. They use
the same encrypted lane, remain in browser memory and clear on close, sign-out
or detected disconnection; reconnect requires Refresh. See
[file preview limits](docs/fold-file-previews.md).
Private app views likewise use signed encrypted reads of exact declared assets
and declared instance-owned data prefixes. They do not create a public link,
copy a Space to the bridge or send content to a model. Their sandboxed frame is
destroyed on close, sign-out or detected disconnection; see
[browser app views](docs/fold-browser-apps.md).
The browser-action foundation keeps exact requests and bounded results in a
private machine-local journal, separate from content-free receipt summaries.
Requests are limited to 16 KiB and results to 128 KiB; the journal has record
and byte limits and prunes terminal records older than a day on new admission.
Only the requesting paired browser and exact app authority can retrieve a
result. A request runs the installed worker with its existing grants as soon as
the desktop accepts it; it does not publish data or start a model. Only the
requesting app view and the trusted browser UI outside the frame can stop a
request, and shared viewers remain read-only.
Selecting a Space changes only the displayed file tree; it does not select a
different Assistant or transcript.
Removing Remote access deletes its server-side account records; browser
IndexedDB may retain an unusable local key until that site's data is cleared.

A prompt sent from Remote access enters the selected local management Chat and
is then sent to the configured model provider under the behavior below. The
management Assistant may delegate to a Space Assistant through the same
attributed desktop act path used locally. An upload becomes a temporary local
reference under app-owned `management/Incoming/Remote/`, subject
to a 64 MB retained cap and a 24-hour retention window; it is purged for a revoked browser
or when Remote access is disabled. If the Assistant explicitly places it into a
Space, the ordinary restore-pointed file path applies; revocation does not
delete that placed copy. work-fold does not terminate or proxy the
model-provider request at the bridge.

The bridge emits aggregate operational metrics for request and device-frame
rates, password-check concurrency and queue depth, event-loop lag, connection
counts, and whether enrollment is open. Those records intentionally omit
account and browser ids, addresses, IP addresses, user agents, tokens, public
keys, ciphertext, prompts, file names, and Assistant results.

### Published pages (share links)

Sharing a page serves the current content of one explicitly designated Space file, rendered on this desktop, to anyone holding its link while the desktop is online. The page crosses the bridge as ciphertext encrypted with a key carried in the link fragment; the key is kept in operating-system-encrypted secure settings, the full link is shown transiently and written to no receipt or log, and the bridge durably stores publication identifiers, budgets, and aggregate counters — not titles, file names, paths, or page content. Opting one publication into snapshot caching stores the latest served ciphertext at the bridge so the page stays readable while the desktop sleeps; the opt-in is labeled where it is turned on, defaults off, and its stored row is deleted on revocation. Anyone who obtains the full link can read that page until the publication is revoked; revoking kills every copy of the link, and sharing again creates a new link. Viewer requests are counted in aggregate; work-fold keeps no per-viewer identity, accounts, or analytics.

### Model providers

When a user sends an Assistant message, Pi sends the request to the provider and model selected in Settings → Assistant. The request can include the message, relevant conversation history and instructions, explicitly selected text attachments, and tool results produced during the turn. A Space's optional **Space instructions** stay in machine-local application state rather than the Space folder, but they are appended to every subsequent model request for that Space and therefore sent to the selected provider. Management attachments are references: readable text files can be included directly within the shared context budget; folders, binaries, and oversized files are initially path-only; and attached links are listed as data. If the Assistant later inspects one with filesystem or network tools, information those tools return may become part of model context. If the Assistant uses filesystem, Extension, or restricted-app tools, information those tools return may likewise become part of later model context. A restricted-app tool receives a bounded action input selected by the Assistant, and its bounded result can therefore be sent to the model provider as part of the tool exchange or later context.

work-fold does not proxy these requests through a work-fold account service. The selected provider receives and processes them under that provider's terms and settings. Do not send sensitive material to a provider unless its handling is acceptable for that material.

### Application updates

Installed Mac builds check the public `Mat-Tom-Son/work-fold-mac-releases` feed shortly after startup, every four hours while running, and when the platform update command is selected. Dormant Windows updater code targets the source repository feed, but no Windows publication lane is active. A check sends a normal network request to GitHub, which can receive standard request metadata such as an IP address and user agent. The frozen legacy Workspace feeds are not queried by work-fold.

Update checks do not download an installer. When an update is available, the user chooses **Download update**; work-fold downloads it, performs its update-specific shutdown, and asks the updater to relaunch the app. If an already-downloaded update becomes ready outside that immediate action, work-fold can offer **Restart now** or **Later**; a ready update deferred with Later installs on explicit application quit. Windows unpacked development/release-smoke packages have no update manifest. The ad hoc Mac structural package retains updater metadata for verification but is named `work-fold Local Smoke`, has a separate bundle identity and application-data directory, and never starts the updater or contacts the production feed.

### Packages and external capabilities

Installing or updating a Pi package can contact its npm, git, HTTPS, or other configured source. Package tools receive the normal network and repository metadata required for that operation.

Skills may include scripts, and Extensions or packages can make their own network requests or open external sites. Their data handling is determined by their code and the services they contact, not by this document. Review the source and documentation before installing an unfamiliar capability.

An Extension can contribute a local declarative surface through `surface.json`. work-fold reads and displays that manifest only after Pi loads the Extension. Surface version 1 contains static text and data and has no direct account, network, or credential bridge. Do not put credentials or sensitive remote records in a surface manifest, especially when the Space is synchronized by another application.

The restricted-app service copies an exactly inspected package digest into content-addressed work-fold application storage and records the inspection and Development preview outside the Space. App Studio can snapshot inspected previews into an immutable format-version-2 Release, whose digest covers exact Feature bytes, declarations, App presentation, dependency inventory, provenance, and inspection evidence. The Project declaration and Release store remain on this computer and the store is limited to four GiB of owned Release-object bytes. Preparing or locally publishing a Release does not upload it, contact a work-fold service, synchronize it, deploy it, or list it in an App Store. Deleting an unused Release removes its machine-local lifecycle record and then prunes its immutable object; work-fold blocks deletion while an active Instance, a prepared operation, or retained App data still requires it, and retries interrupted pruning. Inspection, preparation, publication, and installation do not execute package JavaScript or contact declared destinations. Visible UI and Assistant-action/automation work use separate ephemeral sandbox renderers. Direct renderer networking is denied; a host broker can contact only a separately granted public HTTPS origin or numeric loopback address and port. Loopback access does not verify process ownership. Grants can be combined: app code with both file and network access can send user input, app storage, Assistant-action data, or content read from a granted Space file or folder to a granted destination. The broker limits the destination, method, headers, redirects, size, and time, but does not determine whether the request body is sensitive. An enabled automation can use only current grants included in its declared permission subset while work-fold is running, even when its visible app view is not open.

API-key, bearer, basic, and OAuth PKCE connections are stored in a separate operating-system-encrypted file bound to the exact Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, destination, canonical origin, and current Runtime Instance owner. The local product does not yet offer Principal-owned connection consent or unattended delegation. OAuth uses the system browser and a one-shot loopback callback; tokens are not returned to app code. Replacing or disconnecting a connection, or updating or removing its app, invalidates in-flight OAuth connection and refresh work before deleting the affected local token record. Revoking network access does not delete a separately stored connection; choosing **Disconnect** deletes the local encrypted record. Neither action rotates an API key or bearer credential or revokes authorization at the remote provider, so provider-side revocation may still be necessary. Legacy Workspace connection stores are never opened or imported; connecting in work-fold creates a new work-fold-owned binding.

App JSON storage is machine-local, bounded, and owned by a Tenant and Data Namespace. It is preserved across preview updates and exact or changed release transitions according to the persisted continuity plan; it is never placed in the Space or included in a Release. Legacy Workspace app storage, registries, artifacts, and receipts are not adopted or imported. Removing a Development preview leaves a recoverable copy of its data in Recently deleted and then purges its namespace; unregistering a Space does the same for every preview installed in it. Uninstalling a release-backed App Instance always removes live runtime and connection authority and requires an explicit choice: **purge** leaves a recoverable copy in Recently deleted and then queues physical deletion of the live data, while **retain** leaves an inactive namespace recorded in App Studio for a later explicit purge. Clearing an app's storage or purging retained data likewise leaves a recoverable copy in Recently deleted first. That disposition is stored in the bounded administrative receipt ledger. The current local product does not adopt retained data into a reinstall or export it. Storage-change hints contain bounded key names and go only to the active visible owning app view. Automation state, App Studio operation journals, administrative receipts, and run receipts are machine-local metadata outside the Space. Run receipts contain the accepting runtime, installation, revision, namespace, effective Principal, seven-domain authority, occurrence and attempt identities, reason, timestamps, outcome, and a bounded error string. An installation-independent accepted record is persisted before the worker starts, then terminalized by run id even after update or removal. On startup, an accepted record whose worker result was lost becomes an explicit `interrupted`/`expired` receipt stating that external-effect completion is unknown; work-fold does not guess success, failure, or cancellation. Receipts do not contain worker inputs, outputs, storage values, file contents, request bodies, or credentials.

System notifications use only the static title and body declared in the manifest, are granted when the app is installed, and can be shown only by an enabled automation that includes that category; clicking one opens its owning Space and app. work-fold does not send these notifications through a work-fold cloud service. The operating system receives and displays them according to the computer's notification and lock-screen settings, which may expose their declared text outside the app window. A declared Space file or folder permission — granted when the app is installed, and covering the whole Space when it names a folder — remains ordinary user content; reads and writes are grant-relative and writes create a targeted History checkpoint. Removing or updating an app commits a durable cleanup obligation with the authority transition; credential, storage, and placed-package cleanup is retried after interruption and cannot reactivate the old installation. Removing an app does not delete Space files. Secret values are not returned to app code, stored in manifests or Space files, included in tool payloads, or intentionally logged.

## Local CLI and development harness

The packaged `work-fold` command writes an atomic request beneath the owning app's production or isolated development profile containing its arguments, the terminal's current working directory, a random request id, protocol version, and timestamp. The desktop host returns stdout, stderr, exit status, and a structured result. For read commands that result stays compact and content-free: local Space names and paths, running Assistant/compaction task metadata, and capability names, scope, source, and status — never file contents, conversation text, or credentials. A CLI-only environment value routes requests to that exact broker root but is not accepted as desktop-state authorization.

Act commands carry more. A `chat send` or `manage send` request includes the message text (a `--message-file` is embedded into the bounded request payload by the shim), `manage send --attach` places the typed path or link strings in argv, `search` places its query in argv, and `spaces assistant instructions` places the bounded instruction text in argv. Content-bearing act responses — chat results, search matches, Space instructions, glance, History, Library, and app listings — travel through the same bounded, short-lived request/response files and are deleted after the command. Those files do not contain referenced local file contents beyond what the command itself returns. `chat`/`manage` status, result, wait, and list responses include Chat titles, states, and message content. Sending a message routes that prompt and its turn through the configured model provider exactly like an interactive desktop Chat, so treat CLI prompts, attachments, and Space instructions with the same privacy care. The management conversation's transcript is machine-local application state under the app profile (`management/.work-fold/conversations/`), not portable Space data; it never moves with any folder. Act commands work only while the work-fold app is running: the app mints a per-launch token into `cli/act-token.json` (removed on quit), and every act command appends metadata-only records to the local `cli/receipts/act.jsonl` journal — timestamps, command names, Space/Chat/task ids (including an explicit management parent task id when present), outcomes, error codes, restore-point ids, the initiating surface, and receipt, Recently deleted item, and typed prior-state identifiers, never instruction text, message content, file contents, search queries, or credentials. The journal is size-rotated and stays on this computer.

Optional Check declarations are code-free portable data under `.work-fold/checks/` and may therefore be synchronized or shared with the rest of a Space by another desktop application. They contain the Check title, exact designated Space-relative paths or bounded selectors, sensor identity and typed parameters (including a text Check's reviewed criteria), but no enablement, finding, decision, provider credential, host system prompt, or raw model exchange. Exact-digest grants, run inputs, admitted findings/evidence, decisions, errors, and available model cost details remain in work-fold application state on this computer; removing the Space purges the primary and backup copy of that Check state before its removal intent can complete. `checks status` returns aggregate counts only; contentful `checks result` and `checks problems` travel through bounded act request/response files and are deleted after the command. The desktop renderer uses its separate per-launch-authenticated local session to fetch bounded current target paths for Files decorations and contentful finding/evidence details only after the person opens the Space-owned Checks tab. The initial file-presence sensor inspects path state and size metadata without reading file contents or contacting a provider, and opening the tab does not run it. The optional `work-fold.text-review` sensor requires explicit enablement of its selected text files and review criteria. Requested runs send only those UTF-8 primary/reference snapshots and criteria through the fold’s selected model provider (up to 16 files, 128 KiB per file, 256 KiB total); provider charges may apply. The fold transcript is not included. The runner stores admitted quotes, input hashes, model identifiers and available token/cost detail in machine-local Check state, without persisting raw model requests or responses. Opening the tab and refreshing status re-read and hash designated text locally for freshness, return bounded projections, and make no model request.

The shim removes its request and response after completion, and the broker cleans stale bounded files during initialization. All of these files remain local and are not sent to a work-fold service, but another process running as the same operating-system user may be able to read or submit them. See [work-fold management layer](docs/management-layer.md) and [Security](SECURITY.md).

`npm run work-fold:drive` is a developer test harness, not the installed management CLI. It sends the supplied prompt and any explicitly selected context through the configured model provider by the same Pi/local-API path as a desktop Chat. In-process runs use temporary work-fold application state unless `WORKFOLD_STATE_DIR` is set; `--agent-dir` can isolate Pi state. Treat its prompts, reports, and provider traffic with the same privacy care as an interactive Chat.

## Space authorization and Assistant context

Creating or registering a Space authorizes work-fold to load project Skills, Extensions, packages, scripts, settings, and instructions from Pi-supported locations in that exact folder. This does not upload the whole folder and does not certify its code as safe. Removing the Space revokes work-fold's authorization; the folder and its portable `.work-fold/` data remain according to the linked-versus-managed removal rules above.

Library materials are passive personal files. Adding one to a Space creates an independent local copy under `From Library`; it is not shared with the Assistant until the user attaches it or the Assistant accesses it through an authorized tool.

The folder's executable configuration can later change through local edits, source control, or a desktop synchronization tool without another registration prompt. Review native Pi Extensions and package changes with the same care as other current-user code. See [Assistant capabilities](docs/assistant-capabilities.md) for the complete distinction.

When the app is launched from the Dock, Finder, Spotlight, or `open` rather than a terminal, it runs the current user's login shell once at startup (`$SHELL -ilc`, so the same profile files a new terminal tab reads) to learn the environment those profiles define, and adopts it for the Assistant's shell tools: `PATH` entries for tools such as Homebrew or nvm, plus ordinary exported variables. The probe runs only on this computer, nothing it reads is sent anywhere by work-fold itself, and it is skipped entirely when `WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1` is set or the app was launched from a terminal. Pi's `httpProxy` setting and the `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables are honored for provider requests, exactly as in the Pi CLI; a proxy configured that way sees the provider traffic it relays.

A Space image attached to a Chat turn (PNG, JPEG, GIF, or WebP) is sent to the configured model provider as image content with that message, resized locally first when it exceeds Pi's inline image bounds. A pasted screenshot is first written into the Space's dated `Dropped/` folder, like a dropped file, and stays there as ordinary user content. A message sent while a turn is running is delivered to the model after its current step and recorded in the Chat transcript as sent mid-turn.

## Google Drive and other synchronized folders

work-fold does not currently connect to the Google Drive API or run its own cloud mirror. It can register an ordinary local folder managed by Google Drive for desktop or another sync application. That separate application may upload and synchronize the folder—including `.work-fold/space.json`, `.work-fold/conversations/`, preserved legacy `.workspace/` content, and any `.pi/` project configuration—under its own settings and privacy terms. Do not place a Space in a synchronized folder unless synchronizing its Chat history and hidden metadata is acceptable.

## User choices

Users choose which folders become Spaces, which files are attached to Chats, which model provider receives Assistant requests, and which Personal or This Space capabilities are installed. Registering the folder is the local Pi authorization. Creating a Remote access address, pairing each browser, revoking one or every browser, disabling the connection, and removing the address are separate choices. Restricted-app preview installation, Release preparation, local publication, target-Space installation, update/rollback activation, App uninstall, and the retain-or-purge choice are also separate choices. Installing an app grants what its manifest declares and turns on its automations; revoking a network destination, file, or notification grant, disconnecting a stored connection, and turning off a named automation are separate choices afterwards. Everything the fold, a Space Assistant, an app, or the command line does runs at once and leaves a receipt; nothing waits for a further click. Deletions stay recoverable from Recently deleted for the retention window. Enabling each routing, sharing each page, opting one publication into snapshot caching, and revoking any of them remain separately recorded effects. Revoking one authority does not imply revoking the others or invalidating a credential at its remote provider.

Because this project is early stage, not every data-management action has a dedicated UI yet. Application and Pi data remain ordinary local files, but manual changes should be made only while work-fold is closed and after creating a backup.

## Changes and questions

Material privacy behavior changes should update this file in the same release. General questions can use [GitHub Issues](https://github.com/Mat-Tom-Son/work-fold/issues), but do not include private data or credentials. Report security concerns privately through [SECURITY.md](SECURITY.md).


An explicitly enabled folder-change routing scans metadata only for its named folder and file types. It does not read file contents or attach files to Chat. Observer baselines are in memory; run receipts retain the source Space, snapshot digest, and change count. It pauses while routing work runs and restarts from a fresh baseline after work, wake, or launch, without replaying missed edits. Each Chat step still sends only its declared message with the host-resolved placeholders it names; a separate files step is the explicit cross-Space transfer.

### Check proposal and correction review

Fold-led setup prepares an unsent draft and materializes inert Check proposals. One-time trials use exact declared shapes, can transmit designated text to the configured model provider, and never grant standing authority or replace live findings. Passive fold attention starts no agent turn. Corrections retain bounded proposed replacement text in machine-local Check state. Applying is a separate human action that re-verifies primary/reference evidence, preserves exact original bytes in History, journals before writing, and refuses stale or repeated application. An interrupted correction is recorded as failed and never replayed automatically. Space removal purges the same primary/backup Check state, including corrections. See [Checks](docs/checks.md).

Restricted app Check-result access is separately selected per exact installation
and Check revision. It shares only that Check's status, bounded finding details,
relative paths and quoted evidence. It never runs a sensor or contacts a model,
and grants no general file access. Changed declarations refuse; changed app
revisions reset selections. Workers and shared viewers cannot read Check results.

### Fold task result links

Recent machine-local turn records may retain up to 64 changed/new relative file
paths, hashes and sizes with pre/post History checkpoint ids. This is metadata
about observed changes during a turn, not additional file content or a model
request. The current fold request exposes at most 12 currently visible paths
to its owning paired browser; app result links contain installation identity,
title, version and digest. Other browsers' aggregate request summaries exclude
these references. Opening a file reads its current bounded contents through
the encrypted preview lane. See [file previews](docs/fold-file-previews.md).


The [collaboration contract](docs/collaboration-contract.md#completion-delivery-and-recovery)
tracks work across model turns: durable questions and answer delivery, bounded
continuations for each owner, and selected request results. The request graph
and original assignments remain machine-local. Only deliberately released
child reports enter a Space Chat; app task reads remain pinned to their own
installation. See the contract for stop, expiry and restart behavior.

The fold popover keeps per-chat text and attachment drafts in renderer memory while switching saved conversations. The current paired web client shows questions in their owning Chat and does not read or acknowledge the aggregate glance feed. Space/file reference drafts use the existing browser draft storage; preview bytes remain transient and use the same read-only preview limits as Chat result links.
