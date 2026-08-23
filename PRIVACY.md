# Privacy

Last updated: August 4, 2026

work-fold is a local-first desktop application. Core Space use does not require a work-fold account; a person may optionally create a private work-fold Remote access address. The current application does not include first-party analytics, advertising, or usage telemetry.

This document describes the behavior of the open-source work-fold application. Model providers, GitHub, package hosts, cloud-sync software, and third-party Skills or Extensions have their own privacy terms.

## What stays on this computer

By default, work-fold stores:

- Space files in the ordinary folders the user creates or registers.
- A hidden `.work-fold/` directory inside each Space. Its `space.json` file stores the portable Space identity, and its `conversations/` directory stores that Space's append-only Chat records, including title, archive, and snooze lifecycle events.
- Library materials, the Space registry, History objects, ignore rules, application settings, and machine-local Chat attention acknowledgements under the local work-fold application-data directory or browser-backed application storage.
- Pi settings, sessions, Pi's independent trust decisions, personal Skills, Extensions, and packages under the configured Pi agent directory, normally `~/.pi/agent`.
- Provider credentials in an application-scoped file encrypted through Electron's operating-system-backed `safeStorage`. work-fold refuses credential operations when that encryption is unavailable.
- Restricted-app Development-preview receipts and package snapshots; machine-local App Project identity and presentation; immutable content-addressed Release envelopes; prepared/published state; install/update operation journals; local App Instance records; per-automation enablement/cadence state and bounded run receipts; retained-data records; and Tenant-and-Data-Namespace-owned JSON storage under the application-data `restricted-apps` directory. Separately encrypted restricted-app connections bind their exact runtime and installation identities in `restricted-app-connections.bin`.
- Short-lived CLI request, claim, and response files under the owning app's application-data directory: `%APPDATA%\work-fold\cli` for an installed Windows app, `%APPDATA%\work-fold Development\cli` for an uninstalled Windows package, and the corresponding production or separately identified smoke-app directory on macOS.
- The management conversation's machine-local transcript under the application-data `management/` root. When a request includes attachments, its user message stores their typed absolute local paths or http(s) links; remote uploads use an app-owned staging path under `management/Incoming/Remote/`. Request/action projections remain in memory for the app run, while act lineage is metadata in the receipt journal.
- Optional Remote access device credentials, P-256 private keys, approved-browser public keys, and revocation state in the same operating-system-encrypted secure settings file as other application credentials. An approved browser keeps its own non-exportable private keys and grant identity in that browser's IndexedDB; it does not store a transcript or Space file cache there.
- Staged needs-you decisions and their bounded terminal history, standing policies with their content-attestation digest, routing declarations with exact-digest grants, cadence anchors, and run receipts, publication records, and per-surface glance last-seen markers — all under the work-fold application-data directory. Publication encryption keys live in the same operating-system-encrypted secure settings as other credentials. None of these records is written into any Space folder, captured by History, or synchronized by anything that synchronizes a Space.

work-fold uses a new application profile and does not inspect, import, migrate, rewrite, wipe, or delete legacy Workspace application data or `.workspace/` folder metadata. Legacy bytes remain where they already are and are not authoritative in work-fold. The app keeps `.workspace/` hidden and excludes it from History, Search, Checks, and restricted-app file grants. Pi's personal resources and authentication may still be read from the configured Pi agent directory, while work-fold keeps its Pi sessions in the separate `sessions/work-fold/` namespace.

Registering an existing folder does not upload, move, duplicate, or rename the user's files. It does add the documented hidden `.work-fold/` identity and Chat storage. Removing a linked Space from work-fold leaves both the ordinary files and `.work-fold/` in place. Deleting a work-fold-managed Space deletes its managed folder after confirmation. If a Space is the source or target of an active release-backed App Instance, work-fold blocks either removal until that App is explicitly uninstalled. Retained App data continues to block its source Space until explicit purge, but does not block removal of the former target. Once those obligations are gone, source removal also deletes that Project's machine-local App Studio metadata and marks unreferenced Release objects for safe reconciliation; transient cleanup failure is retried before later App mutations and at startup. Target removal cancels prepared operations aimed at it. Uninstalling work-fold does not itself delete linked Space folders.

Managed-folder deletion is also blocked when the claimed tree contains preserved
`.workspace/` metadata. The person may remove the work-fold registration without
deleting the ordinary folder; work-fold never uses managed deletion to erase
legacy product data.

## When data leaves this computer

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
envelopes encrypted with keys held by the approved browser and desktop. The
normal bridge path therefore routes ciphertext rather than durably recording
plaintext, and this does not hide ordinary network metadata. Remote access is
currently a private alpha whose hosted client and bridge are
trusted parts of the authority boundary: because that origin serves the web
code which may use a non-exportable approved browser key, an active compromise
of the hosted service can read displayed content or issue authorized requests.
The envelope design protects passive relay handling and persisted state; it is
not a guarantee against a malicious hosted origin. The browser renders bounded
saved management transcripts and filtered, bounded Space-relative file-tree
projections in memory and starts fresh by fetching them again after sign-in.
Selecting a Space changes only the displayed file tree; it does not select a
different Assistant or transcript.
Removing Remote access deletes its server-side account records; browser
IndexedDB may retain an unusable local key until that site's data is cleared.

A prompt sent from Remote access enters the selected local management Chat and
is then sent to the configured model provider under the behavior below. The
management Assistant may delegate to a Space Assistant through the same
attributed desktop act path used locally. An upload becomes a temporary local
reference under app-owned `management/Incoming/Remote/`, subject
to a 64 MB retained cap and 24-hour expiry; it is purged for a revoked browser
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

Sharing a page serves the current content of one explicitly designated Space file, rendered on this desktop, to anyone holding its link while the desktop is online. The page crosses the bridge as ciphertext encrypted with a key carried in the link fragment; the key is kept in operating-system-encrypted secure settings, the full link is shown transiently and written to no receipt or log, and the bridge durably stores publication identifiers, budgets, and aggregate counters — not titles, file names, paths, or page content. Opting one publication into snapshot caching stores the latest served ciphertext at the bridge so the page stays readable while the desktop sleeps; the opt-in is labeled at the decision, defaults off, and its stored row is deleted on revocation. Anyone who obtains the full link can read that page until the publication is revoked; revoking kills every copy of the link, and sharing again creates a new link. Viewer requests are counted in aggregate; work-fold keeps no per-viewer identity, accounts, or analytics.

### Model providers

When a user sends an Assistant message, Pi sends the request to the provider and model selected in Settings → Assistant. The request can include the message, relevant conversation history and instructions, explicitly selected text attachments, and tool results produced during the turn. Management attachments are references: readable text files can be included directly within the shared context budget; folders, binaries, and oversized files are initially path-only; and attached links are listed as data. If the Assistant later inspects one with filesystem or network tools, information those tools return may become part of model context. If the Assistant uses filesystem, Extension, or restricted-app tools, information those tools return may likewise become part of later model context. A restricted-app tool receives a bounded action input selected by the Assistant, and its bounded result can therefore be sent to the model provider as part of the tool exchange or later context.

work-fold does not proxy these requests through a work-fold account service. The selected provider receives and processes them under that provider's terms and settings. Do not send sensitive material to a provider unless its handling is acceptable for that material.

### Application updates

Installed Windows builds check the public `Mat-Tom-Son/work-fold` GitHub release feed. Installed Mac builds check the separate public `Mat-Tom-Son/work-fold-mac-releases` feed. Both check shortly after startup, every four hours while running, and when the platform update command is selected. A check sends a normal network request to GitHub, which can receive standard request metadata such as an IP address and user agent. The frozen legacy Workspace feeds are not queried by work-fold.

Checks do not download an installer. When an update is available, the user chooses **Update now**; work-fold downloads it, performs its update-specific shutdown, and asks the updater to relaunch the app. If an already-downloaded update becomes ready outside that immediate action, work-fold can offer **Restart now** or **Later**; a ready update deferred with Later installs on explicit application quit. Windows unpacked development/release-smoke packages have no update manifest. The ad hoc Mac structural package retains updater metadata for verification but is named `work-fold Local Smoke`, has a separate bundle identity and application-data directory, and never starts the updater or contacts the production feed.

### Packages and external capabilities

Installing or updating a Pi package can contact its npm, git, HTTPS, or other configured source. Package tools receive the normal network and repository metadata required for that operation.

Skills may include scripts, and Extensions or packages can make their own network requests or open external sites. Their data handling is determined by their code and the services they contact, not by this policy. Review the source and documentation before installing an unfamiliar capability.

An Extension can contribute a local declarative surface through `surface.json`. work-fold reads and displays that manifest only after Pi loads the Extension. Surface version 1 contains static text and data and has no direct account, network, or credential bridge. Do not put credentials or sensitive remote records in a surface manifest, especially when the Space is synchronized by another application.

The restricted-app service copies an explicitly reviewed package digest into content-addressed work-fold application storage and records the review and Development preview outside the Space. App Studio can snapshot reviewed previews into an immutable format-version-2 Release, whose digest covers exact Feature bytes, declarations, App presentation, dependency inventory, provenance, and inspection evidence. The Project declaration and Release store remain on this computer and the store is limited to four GiB of owned Release-object bytes. Preparing or locally publishing a Release does not upload it, contact a work-fold service, synchronize it, deploy it, or list it in an App Store. Deleting an unused Release removes its machine-local lifecycle record and then prunes its immutable object; work-fold blocks deletion while an active Instance, a prepared operation, or retained App data still requires it, and retries interrupted pruning. Inspection, preparation, publication, and installation do not execute package JavaScript or contact declared destinations. Visible UI and Assistant-action/automation work use separate ephemeral sandbox renderers. Direct renderer networking is denied; a host broker can contact only a separately granted public HTTPS origin or numeric loopback address and port. Loopback access does not verify process ownership. Grants can be combined: app code with both file and network access can send user input, app storage, Assistant-action data, or content read from a granted Space file or folder to a granted destination. The broker limits the destination, method, headers, redirects, size, and time, but does not determine whether the request body is sensitive. An enabled automation can use only current grants included in its reviewed permission subset while work-fold is running, even when its visible app view is not open.

API-key, bearer, basic, and OAuth PKCE connections are stored in a separate operating-system-encrypted file bound to the exact Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, destination, canonical origin, and current Runtime Instance owner. The local product does not yet offer Principal-owned connection consent or unattended delegation. OAuth uses the system browser and a one-shot loopback callback; tokens are not returned to app code. Replacing or disconnecting a connection, or updating or removing its app, invalidates in-flight OAuth connection and refresh work before deleting the affected local token record. Revoking network access does not delete a separately stored connection; choosing **Disconnect** deletes the local encrypted record. Neither action rotates an API key or bearer credential or revokes authorization at the remote provider, so provider-side revocation may still be necessary. Legacy Workspace connection stores are never opened or imported; connecting in work-fold creates a new work-fold-owned binding.

App JSON storage is machine-local, bounded, and owned by a Tenant and Data Namespace. It is preserved across reviewed preview updates and exact or changed release transitions according to the persisted continuity plan; it is never placed in the Space or included in a Release. Legacy Workspace app storage, registries, artifacts, and receipts are not adopted or imported. Removing a Development preview purges its namespace. Uninstalling a release-backed App Instance always removes live runtime and connection authority and requires an explicit choice: **purge** queues physical data deletion, while **retain** leaves an inactive namespace recorded in App Studio for a later explicit purge. That disposition is stored in the bounded administrative receipt ledger. The current local product does not adopt retained data into a reinstall or export it. Storage-change hints contain bounded key names and go only to the active visible owning app view. Automation state, App Studio operation journals, administrative receipts, and run receipts are machine-local metadata outside the Space. Run receipts contain the accepting runtime, installation, revision, namespace, effective Principal, seven-domain authority, occurrence and attempt identities, reason, timestamps, outcome, and a bounded error string. An installation-independent accepted record is persisted before the worker starts, then terminalized by run id even after update or removal. On startup, an accepted record whose worker result was lost becomes an explicit `interrupted`/`expired` receipt stating that external-effect completion is unknown; work-fold does not guess success, failure, or cancellation. Receipts do not contain worker inputs, outputs, storage values, file contents, request bodies, or credentials.

Separately granted system notifications use only the static title and body reviewed in the manifest and can be shown only by an enabled automation that includes that category; clicking one opens its owning Space and app. work-fold does not send these notifications through a work-fold cloud service. The operating system receives and displays them according to the computer's notification and lock-screen settings, which may expose their reviewed text outside the app window. A separately granted Space file or folder remains ordinary user content; reads and writes are grant-relative and writes create a targeted History checkpoint. Removing or updating an app commits a durable cleanup obligation with the authority transition; credential, storage, and staged-package cleanup is retried after interruption and cannot reactivate the old installation. Removing an app does not delete Space files. Secret values are not returned to app code, stored in manifests or Space files, included in tool payloads, or intentionally logged.

## Local CLI and development harness

The packaged `work-fold` command writes an atomic request beneath the owning app's production or isolated development profile containing its arguments, the terminal's current working directory, a random request id, protocol version, and timestamp. The desktop host returns stdout, stderr, exit status, and a structured result. For read commands that result stays compact and content-free: local Space names and paths, running Assistant/compaction task metadata, and capability names, scope, source, and status — never file contents, conversation text, or credentials. A CLI-only environment value routes requests to that exact broker root but is not accepted as desktop-state authorization.

Act commands carry more. A `chat send` or `manage send` request includes the message text (a `--message-file` is embedded into the bounded request payload by the shim), `manage send --attach` places the typed path or link strings in argv, and `search` places its query in argv. Content-bearing act responses — chat results, search matches, glance, History, Library, and app listings — travel through the same bounded, short-lived request/response files and are deleted after the command. Those files do not contain referenced local file contents beyond what the command itself returns. `chat`/`manage` status, result, wait, and list responses include Chat titles, states, and message content. Sending a message routes that prompt and its turn through the configured model provider exactly like an interactive desktop Chat, so treat CLI prompts and attachments with the same privacy care. The management conversation's transcript is machine-local application state under the app profile (`management/.work-fold/conversations/`), not portable Space data; it never moves with any folder. Act commands work only while the work-fold app is running: the app mints a per-launch token into `cli/act-token.json` (removed on quit), and every act command appends metadata-only records to the local `cli/receipts/act.jsonl` journal — timestamps, command names, Space/Chat/task ids (including an explicit management parent task id when present), outcomes, error codes, restore-point ids, the initiating surface, and decision, policy, and typed prior-state identifiers, never message content, file contents, search queries, or credentials. The journal is size-rotated and stays on this computer.

Optional Check declarations are code-free portable data under `.work-fold/checks/` and may therefore be synchronized or shared with the rest of a Space by another desktop application. They contain the Check title, exact designated Space-relative paths or bounded selectors, sensor identity and typed parameters, but no enablement, finding, decision, provider credential, prompt, or raw model exchange. Exact-digest grants, run inputs, admitted findings/evidence, decisions, errors, and any future model cost details remain in work-fold application state on this computer; removing the Space purges the primary and backup copy of that Check state before its removal intent can complete. `checks status` returns aggregate counts only; contentful `checks result` and `checks problems` travel through bounded act request/response files and are deleted after the command. The desktop renderer uses its separate per-launch-authenticated local session to fetch bounded current target paths for Files decorations and contentful finding/evidence details only after the person opens the Space-owned Checks tab. The initial file-presence sensor inspects path state and size metadata without reading file contents or contacting a provider, and opening the tab does not run it. Future model-backed sensors require a separate explicit capability and privacy decision; none are enabled by this contract.

The shim removes its request and response after completion, and the broker cleans stale bounded files during initialization. All of these files remain local and are not sent to a work-fold service, but another process running as the same operating-system user may be able to read or submit them. See [work-fold management layer](docs/management-layer.md) and [Security](SECURITY.md).

`npm run work-fold:drive` is a developer test harness, not the installed management CLI. It sends the supplied prompt and any explicitly selected context through the configured model provider by the same Pi/local-API path as a desktop Chat. In-process runs use temporary work-fold application state unless `WORKFOLD_STATE_DIR` is set; `--agent-dir` can isolate Pi state. Treat its prompts, reports, and provider traffic with the same privacy care as an interactive Chat.

## Space authorization and Assistant context

Creating or registering a Space authorizes work-fold to load project Skills, Extensions, packages, scripts, settings, and instructions from Pi-supported locations in that exact folder. This does not upload the whole folder and does not certify its code as safe. Removing the Space revokes work-fold's authorization; the folder and its portable `.work-fold/` data remain according to the linked-versus-managed removal rules above.

Library materials are passive personal files. Adding one to a Space creates an independent local copy under `From Library`; it is not shared with the Assistant until the user attaches it or the Assistant accesses it through an authorized tool.

The folder's executable configuration can later change through local edits, source control, or a desktop synchronization tool without another registration prompt. Review native Pi Extensions and package changes with the same care as other current-user code. See [Assistant capabilities](docs/assistant-capabilities.md) for the complete distinction.

When the app is launched from the Dock, Finder, Spotlight, or `open` rather than a terminal, it runs the current user's login shell once at startup (`$SHELL -ilc`, so the same profile files a new terminal tab reads) to learn the environment those profiles define, and adopts it for the Assistant's shell tools: `PATH` entries for tools such as Homebrew or nvm, plus ordinary exported variables. The probe runs only on this computer, nothing it reads is sent anywhere by work-fold itself, and it is skipped entirely when `WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1` is set or the app was launched from a terminal. Pi's `httpProxy` setting and the `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables are honored for provider requests, exactly as in the Pi CLI; a proxy configured that way sees the provider traffic it relays.

A Space image attached to a Chat turn (PNG, JPEG, GIF, or WebP) is sent to the configured model provider as image content with that message, resized locally first when it exceeds Pi's inline image bounds. A pasted screenshot is first written into the Space's dated `Dropped/` folder, like a dropped file, and stays there as ordinary user content. A message sent while a turn is running is delivered to the model after its current step and recorded in the Chat transcript as sent mid-turn.

## Google Drive and other synchronized folders

work-fold does not currently connect to the Google Drive API or run its own cloud mirror. It can register an ordinary local folder managed by Google Drive for desktop or another sync application. That separate application may upload and synchronize the folder—including `.work-fold/space.json`, `.work-fold/conversations/`, preserved legacy `.workspace/` content, and any `.pi/` project configuration—under its own settings and privacy policy. Do not place a Space in a synchronized folder unless synchronizing its Chat history and hidden metadata is acceptable.

## User choices

Users choose which folders become Spaces, which files are attached to Chats, which model provider receives Assistant requests, and which Personal or This Space capabilities are installed. Registering the folder is the local Pi authorization. Creating a Remote access address, approving each browser, revoking one or every browser, disabling the connection, and removing the address are separate choices. Restricted-app preview installation, Release preparation, local publication, target-Space installation, update/rollback activation, each network destination, file or notification grant, named automation, stored connection, App uninstall, and retain/purge decision are also separate choices. Approving or denying each staged needs-you decision, authoring each standing policy in Settings, enabling each routing, sharing each page, opting one publication into snapshot caching, and revoking any of them are separate choices as well. Revoking one authority does not imply revoking the others or invalidating a credential at its remote provider.

Because this project is early stage, not every data-management action has a dedicated UI yet. Application and Pi data remain ordinary local files, but manual changes should be made only while work-fold is closed and after creating a backup.

## Changes and questions

Material privacy behavior changes should update this file in the same release. General questions can use [GitHub Issues](https://github.com/Mat-Tom-Son/work-fold/issues), but do not include private data or credentials. Report security concerns privately through [the security policy](SECURITY.md).
