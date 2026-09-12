# Product model and roadmap

This document is the durable product brief for work-fold. It exists so design, implementation, and release decisions stay aligned as the app grows.

## Product promise

work-fold makes an ordinary folder understandable as a place for getting something done, then gives that place a capable Worker.

Many people already have the right raw material—folders, files, cloud-synchronized directories, and repeatable ways of working—but do not think of a folder as an environment they can return to. A **Folder** closes that gap. It adds a human mental model and a Worker without turning the folder into a proprietary format.

work-fold is for general computer work. Coding is one valid use, not the organizing metaphor.

## The nouns

| Concept | User promise | Boundary |
|---|---|---|
| **work-fold** | The desktop product that brings folders, conversations, materials, and Workers together. | It is not the name of each folder-backed activity. |
| **Folder** | One understandable place for an activity, backed by an ordinary folder. | Registering a folder does not move or convert it. |
| **Files** | The ordinary folder contents visible for the selected Folder. | Files are not a separate container or proprietary format. |
| **Chats** | Conversations grounded in the selected Folder. | A chat does not automatically receive every file in the Folder. |
| **Library** | Personal materials worth reusing across Folders. | Items are passive and are copied explicitly; they are not prompt context. |
| **History** | Checkpoints and recoverable changes associated with a Folder. | It should remain distinct from chat history. |
| **Checks** | Optional, manual expectations over exact files or bounded file sets a person deliberately designates. | They are not ambient scanning, a permanent rail destination, or proof that an unconfigured Folder is healthy. |
| **Worker** | The Pi-powered helper in a Folder. | Provider connections are configured in Settings and stay machine-local; model choices are saved separately for each Folder and for the work-fold agent, independently from Folder content. |
| **Agent tools** | One on-demand work tab to discover and manage what the work-fold agents can do. | It groups Skills and Extensions; restricted Folder apps have a separate Apps tab. |
| **Skill** | A reusable way of working that helps the Assistant approach a task. | A Skill may contain executable scripts and is not merely a document. |
| **Extension** | An executable capability or connection available to the Assistant. | It has a stronger trust implication than a Library item. |
| **App Project** | An optional build-and-publication identity declared for one Space. | Its presentation and identity are machine-local application state, not another portable file or cloud ownership record. |
| **Feature** | One stable reviewed contribution to an App Project. | A Feature id names a slot; only an exact reviewed revision identifies executable bytes. |
| **Release** | An immutable content-addressed snapshot of reviewed Features and App presentation. | Preparing, publishing, and installing it are separate local acts; a display version is not executable identity. |
| **App Instance** | One published Release installed into a chosen Space with its own runtime, data, grants, connections, jobs, and receipts. | It is distinct from the source-bound Development preview and does not live in or own the Space folder. |
| **work-fold agent** | The management agent above all Folders: the management conversation, its menu-bar/tray popover, and the Remote access web client under one user-facing name. | It is not a Folder, a second Worker, or a renamed contract; "management conversation" stays the technical term. |
| **Automation** | A declared, inert-until-enabled set of deterministic steps that move work between Folders on a reviewed trigger. | It is executed by app code, never by a Worker conversation, and nothing routing-shaped is written into any Folder. The technical contract remains `routing`. |
| **Viewer** | Someone reading one published page or app through a share link while the desktop is online. | A viewer is not a paired browser, never touches the management lane, and is never a Principal. |
| **Recently deleted** | The machine-local holding place for anything work-fold removed that History could not restore — files, folders, a managed Folder's folder, app storage and retained-data exports — kept for a retention window and restorable from Settings or the CLI. | It is not a Folder, not portable, not a backup, and never empties on a verb; only retention purges it. |

The Folder header chooses the active working folder and provides compact
actions to use an existing folder, create a Folder, or manage Folders. The
stable primary navigation then follows these everyday surface nouns:

- **Files**
- **Chats**
- **History**

The bottom-rail **Add** action opens **Your Library**, **Skills & Extensions**,
and **Apps**. App building is not an Add destination: **Build with Worker** on
Apps opens a fresh Chat seeded with starter text. Library opens as one persistent
tab per Folder without turning the passive personal collection into Folder
content; a destination selector can explicitly send a copy to any registered
Folder. Skills, Extensions, packages, and core tools are managed in the
Folder-owned **Agent tools** work tab, titled **Skills & Extensions**, while
installed-app authority lives in the separate Folder-owned **Apps** tab. That
tab shows **Everywhere** tools for the work-fold agent and every Folder above
**This Folder only** tools that travel with one Folder. Provider connections,
API keys, supported provider OAuth, scoped model choices, and per-Folder
**Worker instructions** live in **Settings → Agents**. Credentials are shared
machine-wide, while model choices and Worker instructions are machine-local
preferences keyed by portable Folder identity; the work-fold agent has its own
model choice but no editable Worker instructions. A model change becomes the
default for new Chats because a live Pi session retains its session model. A
Worker-instruction change reloads that Folder's idle clients and applies to
subsequent turns, including existing Chats. OpenRouter has an explicit live
refresh backed by its tool-capable text-model API; the last good result is
cached outside every Folder and Pi's built-in catalog remains a fallback. A
restricted Folder app's connection is managed with that app in **Apps**.

Each open tab belongs to one Folder. Selecting a tab takes the user back to
that Folder; selecting a Folder restores its most recent tab. A working Chat
remains alive when another tab is selected, work-fold is minimized, the Windows
window is hidden to the tray, or the last macOS window closes and is recreated.
Every accepted Worker turn has one stable request id through the transcript,
kernel task, and bounded machine-local turn journal. Retrying an uncertain
delivery returns that original acceptance rather than running the Worker twice.
The live event stream carries resumable cursors and an authoritative
running/text snapshot, so sleep, renderer reload, and short local-service
disconnects reconcile without losing or duplicating the visible response.

Chats have a lightweight lifecycle for keeping a growing conversation list usable. **Active** is current work, **Snoozed** is deferred until a future local time, and **Archived** is retained reference material. A due snooze resurfaces automatically in Active. The selected Space's Chats remain the primary list; every other registered Space appears below as a compact, collapsed group, including a zero count when it has no Chats in the current view. Aggregate activity remains visible, and search may expand those groups to expose results. Snoozing or archiving a Chat closes its open tab but never deletes or rewrites its transcript; the state is an append-only lifecycle event in that Chat's portable `.work-fold/conversations/` log. A snoozed or archived Chat may be opened for reading, but it must be resumed or restored before another message can be sent. Lifecycle changes are unavailable while its Assistant turn or compaction is active.

A new Chat begins with a temporary **New Chat** label. After its first successful
turn, work-fold asks that Chat's active Pi model for a short title based on the
first request and reply, then persists the result so it remains stable across
tabs, restarts, and machines. The title request uses the same authenticated Pi
model transport as the turn, including live provider catalogs. If that one
bounded request fails, the Chat remains **New Chat** rather than presenting its
first message as though it were a generated title; naming can never fail the
otherwise successful turn, and the failed attempt is not repeated. Previously saved titles remain authoritative, including titles made by older
versions; rebuilding a cache must not replace them with **New Chat**. An explicit
person-authored rename always wins, including an intentional rename to
**New Chat**. Title and lifecycle summaries may be cached in machine-local
application state, but those caches are disposable and versioned independently
from the portable append-only transcript.

The work-fold agent's menu-bar chat history offers **Rename** and **Delete** in
each chat's actions. The paired web chat offers those actions beside its title.
Deleting an idle chat moves its transcript to **Recently deleted**; restoring it
returns it to the chat list. Chats with outstanding work must be stopped or
finished before deletion.

Background state is quieter and machine-local: a small running marker follows an accepted Assistant turn across the Chat navigator and tab strip, and becomes an attention marker only when the turn settles out of view. Viewing the Chat clears that marker. This acknowledgement state is an app preference on the current computer, not portable conversation content.

The configured provider and model remain visible in the Chat composer before the first message. Clicking that label opens **Settings → Agents** scoped to the owning Folder and its model selector; it always names the provider/model, never the product. The adjacent reasoning control is hydrated before the first send from Pi's saved default and lists only supported levels; a live Pi session becomes authoritative. Successful and interrupted Worker messages persist their bounded tool trail with terminal states, so tab switches and relaunches restore it without a ghost spinner or replay of completed tools. Provider failures use Pi's bounded retry path, preserving completed tool results; exhausted retries, setup failures, stops, terminal failures, and recovery append typed user-safe results. Startup never reruns a Worker turn that reached the runtime. The portable transcript is the content authority and the local journal supplies acceptance deduplication and reconciliation.

## A Folder is a view of a folder, not a new file format

There are two honest ways to create a Folder:

1. **Create a Folder:** work-fold creates a normal folder under its managed local content location.
2. **Use an existing folder:** work-fold registers the folder in place.

Both routes should lead to the same product experience. Registration must not move, duplicate, or rename user files. work-fold adds one intentionally narrow, hidden metadata layer: `.work-fold/space.json` preserves the Space identity when its folder moves, and `.work-fold/conversations/` keeps that Space's Chats with it. The Files and History surfaces hide this directory. Provider credentials, the Space registry, History objects, Pi sessions, ignore rules, and other machine-specific app state remain in application storage. Portable executable Pi configuration remains separate under `.pi/`. Creating or registering the Space is the user's authorization for work-fold to load that local configuration; removing the Space revokes that authorization.

work-fold starts from a clean profile. It does not parse, import, migrate, rewrite, wipe, or delete legacy Workspace application state, `.workspace/` metadata, restricted-app data, connections, receipts, or artifacts. Preserved `.workspace/` content is non-authoritative and remains hidden and excluded from History, Search, Checks, and restricted-app file grants. Pi's personal resources and authentication may remain shared at the configured Pi root, but work-fold sessions are isolated under `sessions/work-fold/`.

Deleting a managed Space moves its folder into Recently deleted and
unregisters it; removing a linked Space only unregisters. The clean-break rule
holds inside Recently deleted: an entry whose tree carries preserved
`.workspace/` metadata is marked held, so neither the retention window nor
**Delete now** erases it, and work-fold still never parses, migrates, or
rewrites that metadata.

A Space may also have a personal visual identity: accent colors, a compact banner, and a Fluent icon. Those preferences help distinguish Spaces inside work-fold, but they currently remain application state on this computer. The versioned `space.json` schema can grow deliberately if portable appearance is introduced later; current code must not smuggle machine-specific state into it.

The same portability rule applies to the App Project declaration. Its
`projectId`, source-Space binding, title, description, and icon live in work-fold
application data. A Release captures an immutable presentation snapshot, but
work-fold does not create `.work-fold/app-project.json` or imply that copying a
folder transfers Project ownership. Portable Project metadata, import, and
collision handling require a later explicit design.

The user should always be able to reveal a Space in the operating system, open its files with other applications, back it up normally, or synchronize it with a desktop sync tool. A Google Drive for desktop folder works because it is a local folder; that is not the same as direct Google Drive API integration.

Settings uses one preferences window with **Appearance**, **AI Models**,
**Web access**, **Shared pages**, **Desktop**, and **About** navigation.
Desktop groups **Automations**, **Recently deleted**, and **Limits**; updates
live in About. The navigation becomes a single horizontally scrollable row in
narrow windows; keyboard selection brings the selected item into view. AI Models
settings separate model defaults, shared provider
connections, and Space instructions. Unsaved model/instruction drafts survive
page and scope changes while that window stays open; credentials are not cached
across scope changes. Accepted saves retain their completion ownership if the
window closes, so reopening waits for their result. External settings changes
refresh clean forms and offer an explicit reload when drafts are present.

[Application appearance](application-appearance.md) adds editable presets,
application palettes and accent, separate interface/conversation typography,
reading width and spacing, list density, quiet messages, and accessibility
preferences. The desktop and menu-bar chat share device-local preferences;
the paired web fold retains its browser appearance. Typed appearance files are
inert data. Undo and reset operate on these preferences without changing Space
colors, icons, or banners; Customize this Space opens the existing work tab.

## Context is explicit

Registering a folder is also the host authorization for its existing local Pi configuration. Assistant context, new package installation, restricted-app permissions, and external connections remain separate states:

| Action | What changes | What does not happen implicitly |
|---|---|---|
| Register a folder as a Space | The folder appears in work-fold and its local Pi configuration may load. | Files are not uploaded or converted, and local code is not certified as safe. |
| Add a Library item to a Space | An independent copy is written under `From Library`. | The original is not changed and the copy is not attached to a chat. |
| Attach a file to a Chat | That file is made available to the conversation. | Other Space files are not included automatically. |
| Create a Check proposal | An inert, typed expectation names one sensor and exact primary/reference targets for review. | It is not enabled, run, scheduled, or treated as executable configuration. |
| Enable a Check | work-fold writes the portable code-free declaration and records an exact-digest, exact-sensor machine grant. | Registration, proposal discovery, and a one-off request never enable standing behavior. |
| Run a Check | work-fold inspects only its designated targets within hard host limits and admits only independently re-verifiable evidence. | No other Space files are scanned; health failures and stale results never become content findings or a clear state. |
| Install a personal Skill or Extension | It becomes available through the user's Pi scope. | It is not copied into every Space. |
| Ask the Assistant to build a Space app | The Assistant writes an ordinary restricted-app package and asks work-fold to inspect it; the inspected digest is installed at once as a Local preview with every declared destination, file permission, notification category, Check-result slot, and automation, and the proposal record is the receipt. | No JavaScript is evaluated during inspection, no secret is collected, and destinations that need a secret are named for the person to connect in the Apps tab. |
| Add a reviewed Space app | The exact reviewed digest becomes a Local preview in that Space's Development Instance, able to reach everything its package declares. | It is not a Release or App Instance, and a destination that needs a secret stays unusable until the person connects it. |
| Declare an App Project | work-fold records an explicit machine-local title, description, icon, Project identity, and source-Space binding. | No file is added to `.work-fold/`, no account or cloud Project is created, and source is not uploaded. |
| Prepare a Release | work-fold snapshots every current reviewed Development preview into one verified, immutable, content-addressed v2 Release and records a prepared state. | It is not yet eligible to install, and later source edits cannot alter its bytes. |
| Publish a prepared Release | work-fold rechecks that the reviewed previews are still exact, then records a separate local publication receipt. | Nothing is uploaded, signed, listed, hosted, granted, or installed. |
| Delete an unused Release | work-fold removes its machine-local lifecycle record, then safely prunes the unreferenced immutable object. | A Release required by an active App Instance, either side of a prepared install/update/rollback, or retained data cannot be deleted. Project source and App data are not removed. |
| Prepare and activate an App install | work-fold durably allocates one new App Instance and its Feature/Data identities, then installs the exact published Release into the chosen registered Space. | It does not convert the Development Instance. Declared powers are granted and declared automations enabled on install; connections with a byte-identical destination declaration, automation enabled states by id, and run receipts carry forward across a changed digest; an identical digest is idempotent. |
| Prepare and activate an update or rollback | work-fold records a deterministic plan, rechecks it at activation, fences the old runtime, and atomically changes the active Release and authority. | A friendly version cannot override digest identity. Only exact unchanged content is eligible for continuity; schema/migration execution is not supported locally. |
| Uninstall an App Instance | work-fold fences the whole release-backed runtime and requires an explicit retain-or-purge choice for local data. A purge first writes a recovery export into Recently deleted. | Project source and separately selected Space files are never deleted. Retained namespaces do not remain runnable and require a later explicit purge. |
| Re-allow or revoke one app destination, file root, notification category, or Check slot | Declared powers are on from install; the person narrows them and can re-allow them, and each control names one exact reviewed declaration. | Other declarations, saved connections, automations, and other Spaces receive no authority. |
| Save or remove an app connection | work-fold adds or deletes one operating-system-encrypted binding for the host-derived Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, target, and current Runtime Instance owner. | Destination access is not implicitly granted, and deleting the local record does not revoke the credential at its provider. Principal-owned connections remain a future portable-runtime journey, not a current local UI. |
| Disable or re-enable one app automation | Declared automations run from install on their bounded schedules while work-fold is running; disabling stops one, and re-enabling starts it again. | A disabled job does not run, and every run receives only the intersection of current grants and its reviewed permission subset. |
| Run an app automation now | work-fold runs that named job once and records a durable receipt, even if its schedule is off. | It does not enable or shift the schedule; a disabled job has no notification authority. |
| Delete a file or folder | work-fold records a safety restore point; anything the restore point cannot cover moves into Recently deleted with a manifest naming its Space, path, size, deleted-at, restore-by, and receipt. | Nothing is permanent at the moment it happens; `.work-fold/`, `.pi/`, and `.workspace/` are never valid endpoints. |
| Restore from Recently deleted | work-fold puts the entry back at its recorded Space path, or re-registers a deleted managed Space, and receipts the restore. | The retention clock is the only thing that empties Recently deleted; no Assistant or CLI verb does. |
| Ask an app for Assistant work or a model call | `assistant.request` starts a fresh full-tools Chat in the owning Space immediately; `assistant.infer` returns bounded text or schema-validated JSON from the Space's model with no tools or transcript. Both leave receipts naming the effective model and usage. | No grant beyond installation is needed; viewers and remote app views get neither; model selection stays with the person. |
| Enable a routing | work-fold records an exact-digest machine grant over one reviewed declaration on a single receipted call. | Proposal authoring, registration, and run-now never enable standing behavior; an edited declaration returns to proposed. |
| Run a routing | App code executes the reviewed steps in order with per-hop receipts inside the shared scheduler bounds. A declared `fold` step may message the fold, and a closed set of host-resolved placeholders may fill a step's message. | No model composes glue, a routing never moves or deletes source files, and no Space folder learns another Space exists. |
| Share a page | One explicitly designated file is served as a rendered page at the person's address while the desktop is online, on a single receipted call; the share is revocable at any time. | Nothing else in the Space is exposed, the bridge stores no page content by default, and App Studio's local "publish a Release" grants no audience. |
| Revoke a publication | work-fold refuses new viewer fetches desktop-first, then deletes the bridge slot and any snapshot. | Old links die; sharing again mints a new slot, key, and link rather than reviving the old one. |

This separation is a core product rail. “Available,” “in this Space,” “in this chat,” and “allowed to execute” must never collapse into one invisible state.

## Assistant model

work-fold hosts Pi instead of recreating an agent framework. Pi owns model/provider behavior, built-in tools, standard resource discovery, packages, Skills, Extensions, and project trust mechanics. work-fold supplies the desktop experience: setup, catalog surfaces, secure credential persistence, folder selection, the registered-Space authorization override, extension UI bridges, and clear execution/permission explanations.

Supported native Extension questions stay inline in their owning Chat,
including the fold, with transient reconnect recovery and Stop. They are live
Pi callbacks rather than durable Assistant questions. Included capabilities
use this same native Extension path; inclusion describes work-fold's
maintenance responsibility, not another trust or runtime tier.
See [Extensions and computer work](extension-foundation.md) for the design,
compatibility requirements, and work still required before inclusion.

The [tool feedback contract](tool-feedback.md) applies across general computer
work: native tools return observations, and the Assistant uses Pi's ordinary
loop to verify or correct its result. Context inspection is a developer-only
local diagnostic at `?dev-context`, outside ordinary Chats and Settings. Its
optional memory-only recording captures assembled model context and observable
provider payloads with provenance; recording is off by default. It does not
add a new navigation concept or execution framework.

There are two capability scopes:

- **Everywhere** (personal scope): available to the fold and every Space from the user's Pi agent directory.
- **This Space only** (project scope): portable configuration stored under the Space's `.pi/` directory and authorized while the folder is registered as a Space.

The **Agent tools** work tab unifies discovery and management without erasing the distinctions that matter. It identifies whether an item is a Skill or Extension, Everywhere or This Space only, active or merely available, direct-imported or package-provided, and healthy or diagnostic-failing. Installed items can be searched, filtered by type and scope, and sorted by name, type, scope, or source. Discover results can be searched, filtered, and sorted by first-party/reference status, downloads, recency, or name.

Packages can distribute Skills, Extensions, prompts, themes, and related Pi resources. They remain installation and lifecycle plumbing; the primary UI should describe the capability a person is gaining, show inspected resource types and lifecycle scripts when registry metadata is available, and label unavailable details as unknown rather than absent. A package that includes Extensions or install scripts is a code-execution decision and must not be presented as a harmless Skill-only import. See [Assistant capabilities](assistant-capabilities.md) for the complete compatibility and safety model.

work-fold has two deliberately different executable lanes:

| Lane | Trust and distribution | UI and authority |
|---|---|---|
| Native Pi Extension | Standard Pi package/resource locations; full current-user execution after Personal install or Space registration. | May add Pi tools, commands, providers, events, and a static host-rendered `surface.json` contribution. Its code owns its network and operating-system access. |
| Restricted Space app | A complete, Space-local reviewed-web package proposed by the Assistant or selected through advanced local preview. It never enters Pi's package manager or loaded catalog. | Runs reviewed UI and worker code in separate sandboxed Electron hosts. Tabs, network, storage, files, connections, notifications, and named automations exist only through narrow host contracts. |

The model experiences either lane as a package-shaped capability, but the product must not flatten their execution boundaries. Native Pi compatibility remains the full-trust ecosystem lane; restricted apps are the flexible app canvas for generated inboxes, dashboards, extractors, project-service panels, and other Space-specific tools. See [Restricted app authoring](restricted-app-authoring.md) and [Restricted app runtime](restricted-app-runtime.md).

## Apps without turning every Space into an App

work-fold is growing from a local Space tool into a local-first App studio and
runtime, but **Space** and **App** are not synonyms. A Space remains the ordinary
folder-backed context for general work and may never produce an App. A Space may
instead declare one optional **App Project**: a source-and-publication role that
defines reviewed **Features** such as the current restricted sidebar app.

Preparing selected reviewed material creates an immutable **App Release**;
publishing it is a separate local decision. Installing or hosting a Release creates a release-backed **App Instance** with
its own mutable data, grants, connections, jobs, users, and receipts. Local
builder preview runs in a separate, release-less **Development Instance** so
editable source never becomes running bytes implicitly. Internally both runtime
forms share a tightly scoped broker contract, but Development and App Instances
never convert into one another.

Project ownership and runtime tenancy are separate. `projectId` is the local App
lineage; an optional registry `cloudProjectId` is only an authenticated binding.
A Principal or Organization owns project roles, while a Tenant owns Runtime
Instance policy and data. Every effect is attributed to one human, agent,
service, or system Principal and the exact Feature Installation executing for
it.

Review, publication, installation, every live grant, connection, named
automation, role, migration, and data-retention decision remain separate acts.
Publication is not folder sync, an App Release contains no ambient Space or Pi
authority, and hosted web must implement the same semantic broker restrictions
as the desktop runtime. The accepted identities, authority rules, implementation
order, and private hosted milestone are defined in
[App platform foundation](app-platform-foundation.md).

In the shipped local path, the existing Chat-bound or advanced direct preview
is explicitly a **Local preview** in the source Space's Development Instance.
App Studio separately declares Project presentation, prepares, publishes, and
deletes unused Releases, installs one into a chosen registered Space, and
manages update, rollback, uninstall, retained data, and purge. App Studio is a Space-bound work
tab reached from Apps, not a fifth top-level rail destination.

## Management layer

work-fold also needs a semantic layer above its individual screens so the same product can be understood by the renderer, command line, scripts, Pi, and eventually a higher-level Assistant. `WorkFoldKernel` is that shared in-process read authority. It resolves actor context to the most-specific Space, exposes versioned snapshots of registered Spaces and running Assistant work, and projects Pi's authoritative capability catalog without creating another registry.

The installed `work-fold` command is the first adapter over that layer. Its read lane reports context, Spaces, active Assistant turns and compactions, and available Skills, Extensions, tools, packages, prompts, themes, and commands in human or stable JSON form, and stays deliberately content-free. A separately versioned act lane — authenticated per app launch and recorded with durable receipts — additionally gives a shell-capable agent the product's receipted verbs while the app is running: Space lifecycle and appearance, per-Space model defaults and instructions, Chats and their lifecycle, History restore points and restores, restore-pointed file operations, Library copies, content search, Checks, App Studio's authority-neutral lifecycle, Recently deleted, fold-side app listing and tool invocation (`apps list|invoke`), the collaboration verbs and request reads (`chat report|ask|answer|handoff`, `requests list|show`), and the management conversation itself. `spaces assistant show` is a content-bearing act read because it returns the instruction text and only already-connected model choices; its model and instruction setters are direct, Space-scoped, metadata-receipted acts fenced against active Space work. Provider credentials and provider connection setup remain unavailable. Act commands reuse the same trust, conflict, History, and task rules as the desktop surfaces. Acts that make bytes runnable, widen a standing power, or destroy run immediately through the same prepare, pin, journal-first, fenced execution path and return a receipt; destruction is reversible through History or Recently deleted (`trash list|restore`). The act lane has no approval state. Tabs, panes, other application settings, pairing, and secret entry stay outside it.

The **work-fold agent** (technically: the management conversation) is the first in-product consumer of that layer: one conversation scope above all Folders and the door through which material enters them. Its transcript is machine-local, and its Pi session loads personal-scope capabilities plus two app-materialized management instructions. It is a full-trust Assistant with ordinary local tools, taught to prefer receipted `work-fold` read and act commands for work that touches Folders. It is reached through `work-fold manage …`, with a default single saved conversation and `--new` creating another thread, and through the menu-bar popover. The popover is a compact conventional chat: person messages are colored bubbles on the right and Assistant replies are unboxed on the left. Its header shows the current Chat title, **Previous**, and **New chat**; it has no **Open app** action, brand lockup, conversation disclosure, overflow menu, or phase badge. **New chat** makes a clean slate, creates a saved transcript on first send, and never deletes a prior transcript. The popover remains a separate window rather than a Folder-bound tab. Dragging files, folders, or links over it stages inert reference chips; the person adds an instruction and send remains the explicit act. Its composer is an expanding field with a centered circular send action; the model label opens **Settings → Agents** scoped to the work-fold agent and the reasoning selector saves the next-session default before a Chat exists and changes a live management session when one exists. While a turn runs, the action becomes **Stop**, the draft remains usable, and incremental Assistant text streams before the persisted reply replaces it. A request whose delegated Folder turn is still running shows **handed off**, never done; a failed child fails the request, Stop names every recorded child it aborts, and every attachment receives a final disposition.

A person's ask is a **request**: one durable, machine-local record that owns the outcome across however many turns and Spaces it takes ([the collaboration contract](collaboration-contract.md)). The fold hands a piece of it to a Space's own Assistant, that Assistant hands one result shape back — a plain-language summary, optional structured details, the files it chose, and whether it finished, finished partly, or failed — and either side can ask a question instead of guessing. A question stops that task rather than the person's day: the turn ends, the request says it is waiting, and one accepted answer starts exactly one continuation turn carrying it. A parent turn never sits on a waiting child; it finishes and says what is outstanding, and when the work it handed out settles, work-fold starts at most one follow-up turn in the fold carrying the collected reports, within that request's bounds and switchable off in Settings → General → Limits. A Space that needs another Space asks for a handoff, and work-fold starts that Chat with the message and copies of the named files through the ordinary restore-pointed path; no model turn is needed to move a result. What crosses into a Space Chat is only its assignment, payloads someone deliberately released to it, and answers to its own questions — the request graph, other Spaces' results, and the fold's transcript stay above Spaces. The same verbs are available to the fold, to a Space Assistant, to an app's requested task, and to any shell-capable agent on the CLI, with the same receipts and the same named limits.

**Remote access** — presented in Settings as **Web access** — is a private-alpha connected surface over the canonical management conversation, not a second Assistant, a Space-chat selector, or a cloud-synchronized Space. A person chooses one private `<name>.work-fold.com` address and password in Settings; new-address enrollment is controlled by the hosted bridge rather than an invitation code or a credential embedded in the public app. Password sign-in establishes only a short-lived browser session; the desktop must separately confirm that browser by matching a six-digit code, after which a non-exportable browser key and revocable desktop-signed grant authorize the surface. This is a full-trust grant to the management Assistant, which keeps its ordinary local tools and can delegate work to registered Space Assistants through the explicitly attributed management act path. The browser lists bounded saved management-chat summaries, opens bounded recent transcripts, sends to a selected saved management Chat or starts a new one, and stops only a management request accepted by that exact browser grant; request-level stop also covers its recorded child turns. While a management turn runs, a current desktop additionally streams bounded live response text and its current activity line to the paired browser as throttled signed encrypted progress events over the same operation lane. The durable transcript replaces that transient projection when the turn settles; the desktop advertises the watch capability in its summary projection, so an older desktop is simply never asked, and every streamed tick rechecks the grant before it leaves the desktop. A **Folders** picker anchored in the web sidebar selects a registered Folder and opens its bounded, ignored-file-aware file tree and apps. Changing that selection changes only the tree being viewed, never the Assistant or conversation; actual delegated child work may appear as a compact in-conversation activity sourced from the request record. Absolute roots and ignored paths never cross the adapter.

Remote uploads are a separate explicit act. Each message accepts at most six plain-named files, 6 MB each and 8 MB total, carried inside the signed encrypted envelope. The management Chat holds them under app-owned `management/Incoming/Remote/` so the management Assistant can explicitly use them or place them into a Space through the restore-pointed `files add` path; that holding area is limited to 64 MB, expires after 24 hours, is purged for a revoked browser and on Remote access disablement, and never exposes the holding path back to the browser. The remote adapter still cannot attach arbitrary desktop paths, tunnel the local HTTP API, receive absolute roots, directly manage capabilities/settings, invoke a Space Chat directly, or call an open-ended method. The bridge persists account/session/grant/operation metadata but never durable message or file content; content projections and uploads cross it as signed application-encrypted envelopes. That protects persisted relay state and passive payload handling, not an actively compromised hosted client or bridge: the hosted origin serves the code that may use a paired browser key and is therefore inside this alpha's authority boundary. Revocation withdraws the desktop-local grant before the server mutation, is serialized with dispatch, and stops locally tracked management requests and their recorded child work. Revoking one browser, revoking every generation, disabling Remote access, or deleting the address are separate desktop actions. Core Space use stays local and account-free.

This is infrastructure over the existing nouns, not a new user-facing concept. A future cross-Space Assistant and controlled Space runtimes should build on the same typed actor, scope, task, and capability contracts instead of scraping renderer state or bypassing domain policy. See [work-fold management layer](management-layer.md) for the exact contract and security boundary.

## Product rails

When a design is ambiguous, prefer the option that best preserves these properties:

1. **Local first:** core work does not require an account or cloud service.
2. **Ordinary files:** user content stays portable and directly accessible.
3. **Clear language:** expose the Space mental model before filesystem or package-manager jargon.
4. **Explicit context:** people can tell what the Assistant can see in the current chat.
5. **Layered authorization:** Space registration authorizes local Pi configuration; package installation, restricted-app permissions, connections, and Chat context stay explicit and separately revocable.
6. **Pi compatibility:** use standard Pi behavior and formats instead of parallel work-fold-only systems.
7. **Capability transparency:** show source, scope, status, and diagnostics for executable additions.
8. **Provider neutrality:** cloud and model integrations should use replaceable adapters rather than shape the core model.
9. **Receipts, not gates:** every verb executes on first call, journaled before and receipted after; verbs that make bytes runnable, widen a power, or destroy keep their identity pins, effect-time rechecks, and at-most-once execution as attribution and recovery. No surface offers an authority mode, a standing rule, or an approval card.
10. **Reversible destruction, setup-only secrets:** History covers ordinary deletion; what it cannot cover goes to Recently deleted with a retention window; exposure and grants are revocable. Remote access administration, pairing machinery, and provider credentials are local desktop Settings acts with no Assistant, CLI, or remote verb, and no task waits on them. Per-Space model defaults and Space instructions are configuration with the narrow receipted fold verbs described above.
11. **Agency on a cadence lives in Spaces:** above Spaces, only declared deterministic routings run unattended; enabling one is a single receipted call that pins the declaration digest; a routing may message the fold only through its declared `fold` step; cross-Space work never runs inside a Space chat because Space transcripts travel — what enters a Space Chat from above is its assignment, released payloads, and answers to its own questions. The one bounded exception is a person-initiated request's follow-up turn: when the work it handed out settles, the host may continue that request in the fold once per settle batch, within the request's own limits.

## Roadmap and known gaps

### Foundation now

- Create a folder-backed Space or register an existing folder without conversion.
- Rename a Space, remove a linked-folder registration without deleting its files, or delete a managed Space into Recently deleted.
- Browse and upload Space files, run Space-scoped Chats, use the Library, and view History.
- Search a Space by content as well as by name: matches inside ordinary files and inside Chat transcripts, honouring the Space's ignore rules, skipping binary and oversized files, and disclosing when a bound stopped the search rather than implying a complete answer.
- Restore content-addressed History checkpoints created around file mutations and Assistant turns. A full checkpoint hashes real bytes rather than trusting metadata, and keeps that cost proportional to the person's own work: it skips version-control internals, installed dependencies, Python virtual environments, self-declared caches (`CACHEDIR.TAG`), work-fold's hidden support directories, directories the person ignored in Files, and directories a `.gitignore` excludes — while every individual file, including a gitignored `.env` or a file hidden from Files, remains recovery material. A targeted mutation checkpoint captures exactly the paths it is asked about.
- Configure a Pi provider/model with an API key or an advertised Pi provider OAuth flow and use Pi's built-in tools.
- Discover installed Skills, prompts, Extension commands, and supported built-ins from the Chat composer, and inspect the active model and context-window pressure during a conversation.
- Show the configured provider/model before a Chat's first send, safely retry transient provider stream failures from completed tool results, preserve terminal partial output and activity as a resumable interruption, and save sanitized setup or unexpected failures in the transcript. A saved reply keeps every text segment the turn produced — what the Assistant said before, between, and after its tool calls — joined as paragraphs in the order it streamed, so a reopened Chat reads the way it did live.
- Discover and search Personal and registered-Space Skills and Extensions in one Assistant tools work tab, with accurate source, scope, load state, and diagnostics.
- Browse curated first-party/reference Skills and Extensions alongside community Pi packages, with type filters and explicit provenance.
- Import standard Skills and compatible skill bundles while preserving their supporting files.
- Install, update, and remove Pi packages at Personal or registered-Space scope.
- Customize each Space with semantic light/dark accent roles, a compact banner, paired colours, and a searchable Fluent icon catalog without changing its folder; machine-local service storage, dual previews, contrast auditing, undo/reset, and inert proposal import/export keep the same typed contract available to people, Codex, and Claude Code.
- Inspect Space context, registered Spaces, active Assistant/compaction tasks, and Pi capabilities through one versioned `WorkFoldKernel` and the installed `work-fold` CLI's content-free read lane.
- Operate the product from any shell-capable agent through the CLI's per-launch-authenticated act lane while the app is running: create or register Spaces, copy outside material into a Space with a History restore point, and start, continue, await, or abort Space Chats — every action journaled before it runs and every CLI-initiated turn tracked as a kernel task with a task-scoped outcome.
- Talk to the management conversation above all Spaces through `work-fold manage send|status|result|wait|abort|stop|list`: the same Assistant runtime with personal capabilities plus work-fold's two app-owned management resources, reference attachments, an explicit request/child action trail, machine-local saved transcripts, default single-conversation behavior with an explicit New chat clean slate, and task-scoped outcomes; the menu-bar/tray popover is its visible desktop surface.
- In the private alpha, optionally reach the saved management conversation at a chosen private `<name>.work-fold.com` address while the desktop is online, after password sign-in and an explicit one-time full-trust desktop confirmation of that browser; browse filtered relative Space trees, delegate through the one management Assistant, and attach bounded uploads, with content-bearing operations carried in signed application-encrypted envelopes through a trusted hosted client and bridge. While a management turn runs, stream bounded live response text and its current activity line to the paired browser, then reconcile the durable reply when it settles; the capability is advertised by the desktop's summary projection, never probed, so an older desktop keeps the polling cadence.
- Define optional file-presence or model-backed text Checks over designated files through the desktop setup form or inert proposals and explicit machine-local enablement; run, await, inspect evidence-backed problems, and record fingerprint-scoped decisions through the installed CLI, management conversation, and one Space-owned desktop work tab. A conditional Files-toolbar summary and quiet exact-file markers appear only for configured state; unconfigured means unknown, portable declarations remain inert, and opening Checks never starts a model or enables automation. A separately reviewed routing may run Checks on a schedule or after an explicitly designated folder changes.
- Drop native OS files onto any Chat composer to upload them into that Space's dated `Dropped/` folder and attach them as context in one explicit act; uploads and Library copy-ins record additive History restore points.
- Steer a running Assistant turn: Enter mid-turn delivers the message through Pi's steering queue, the Assistant reads it after its current step, and the transcript records it as sent mid-turn; if the turn settles first the message becomes the queued draft instead. ⌘/Ctrl+Enter queues one follow-up message behind the running turn as a visible, cancellable draft that sends when the turn settles; Stop returns it to the composer instead of firing it into the stopped turn's aftermath.
- Attach images to a turn: an attached PNG, JPEG, GIF, or WebP Space file reaches the model as image content (resized locally by Pi's own image pipeline when needed) rather than as a path-only reference, and a pasted screenshot lands in the Space's dated `Dropped/` folder through the same explicit upload path as a dropped file before it is attached.
- Choose the reasoning level for a Space or fold Chat from its text-only composer control (or `/thinking` in a Space Chat), limited to what the current model supports, persisted in the Pi session, and remembered as the default for new sessions exactly as Pi's own TUI does.
- Run an Assistant turn without a wall-clock cap, as native Pi does; Pi's own HTTP idle timeout still catches a provider that stops answering, and a host may opt into an explicit cap with `WORKFOLD_PI_TURN_TIMEOUT_MS`.
- Give the Assistant's shell tools the person's real login-shell environment: a Dock, Finder, Spotlight, or `open` launch asks the login shell for its environment once at startup (profile-provided `PATH` entries such as Homebrew or nvm included) before any Pi session exists, while a terminal launch keeps the environment it was given; `WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1` opts out.
- Reach model providers through the same transport as the Pi CLI: Pi's `httpProxy` setting and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are honored, Pi's HTTP idle timeout applies to headers and bodies, and the guarded dispatcher is installed before the first provider request.
- Preview bounded text and common image files inline in the file tab — truncation disclosed, binary or oversized content declined with its reason — under the same Space path policy as every file route.
- Reach tabs, files, and running work from the keyboard: close, cycle, and jump between surface tabs, open a new Chat tab, stop the running turn, move the Files selection with arrow keys, rename and delete from the tree into the existing undo window, and answer Settings groups with arrows.
- Drive one real Pi turn through the local API with the harness-neutral `work-fold:drive` test driver.
- Render validated declarative `surface.json` contributions from loaded Pi Extensions as a contributed rail destination, left-pane navigator, and Space-bound view tabs without injecting Extension code into the renderer.
- Let the Assistant submit a completed, Space-relative restricted-app package through a host-owned proposal tool. work-fold persists a Space-and-Chat-bound, digest-pinned review without evaluating JavaScript; the inspected package is installed at once as a Local preview with every declared power and automation, and destinations needing a secret are named for the person.
- Give each installed Space app arbitrary reviewed web UI in a sandboxed rail navigator and host-derived persistent Space-owned right tabs, plus optional bounded Assistant actions and named automations in a separate worker sandbox. A machine-wide scheduler shared across Spaces provides four execution slots, FIFO admission, same-job non-overlap, durable cadence, bounded catch-up, and run receipts. The Apps tab manages each job independently alongside exact network/file/notification grants, host-owned encrypted connections, local data, updates that carry eligible authority forward, removal, and the secondary advanced local-package path.
- Provide bounded host-owned JSON storage with active-visible-view invalidation hints, History-covered Space-file grants, exact public-HTTPS or numeric-loopback requests, API-key/bearer/basic/OAuth PKCE connection adapters, and static reviewed system notifications from enabled automation runs.
- Carry host-owned local App Project, Development Instance, Feature Installation,
  Data Namespace, canonical Feature Revision, and seven-domain authority identity
  through the restricted-app UI. The first Space-app preview may
  establish the Space's machine-local App Project/Development Instance scaffold;
  App Studio exposes its explicit presentation and lifecycle.
- Produce portable, authority-captured receipts for local automation runs.
  Unsupported, future, or legacy registries remain inert rather than being
  assigned invented authority. Post-update and uninstall cleanup is a durable, restart-retried
  outbox, so stale secret/data bytes never regain live authority after partial
  cleanup failure.
- Provide canonical declaration/artifact conformance and a durable local App
  Studio: immutable v2 Release assembly and verification; a content-addressed
  Release store; separate prepared and published states; persisted
  install/update operations; release-backed App Instance
  install/update/rollback; and explicit uninstall retain/purge plus later purge.
- Attach each local App Instance to one chosen registered Space while keeping its
  bytes, data, grants, connections, schedules, journals, and receipts in
  work-fold application data. Enforce one instance per `(projectId, target
  Space)` and reject Feature-id collisions with previews or other installed Apps
  in that Space.
- Preserve only exact eligible authority across a release change. A changed
  Feature revision keeps its installation/data lineage but resets grants,
  connections, and jobs; the current local runtime rejects schema-bearing
  Releases and migration execution rather than applying them partially.
- Block removal of a Project's source Space or an App Instance's target Space
  while a release-backed instance remains active, directing the person to
  uninstall it with an explicit data choice first. Keep the source blocked while
  its Project owns retained data; after explicit purge, source removal clears the
  machine-local Project/Release lineage and target removal cancels prepared
  operations aimed at that Space.
- Build, Developer ID-sign, notarize, and publish the macOS arm64 app, DMG, ZIP, blockmap, and update metadata, with a verified installed two-version updater lane. This is the only active desktop distribution lane.

- Meet the whole product through the **work-fold agent** — the management conversation above all Folders, its menu-bar/tray popover, and paired web chat — with capture in and publishing out. See [the fold](fold.md).
- Perform every product verb through the fold's receipted act lane at human parity: chat lifecycle and compaction, History restore with automation-aware fencing, file operations, content search, Library, Space rename/unregister and appearance, capability removal, and App Studio's authority-neutral lifecycle — each act journaled before it runs, receipted after, with typed undo references.
- Run every verb — including those that make bytes runnable, widen a standing power, or delete — on first call with identity pins, journal-first receipts, and at-most-once execution; keep every deletion reversible through History or Recently deleted, restorable from Settings → General and `work-fold trash`.
- Declare deterministic cross-Space routings — a schedule, explicitly designated folder change, or settled Check or automation run driving fixed Chat, files, Check, and fold steps on a separate eight-slot routing scheduler with per-hop receipts and host-resolved placeholders; enablement is one receipted call, and nothing above Spaces runs an unattended conversation.
- Read the glance — the app-composed digest of running work, needs-you questions and due snoozes, and changes since each surface last looked — on the main window and remote client, with narration on demand that never advances seen markers. The compact popover stays focused on the live conversation and capture.
- Share "pages your fold serves": one designated file or one reviewed hosted App Instance served live from the desktop at the person's `<name>.work-fold.com` address to link-scoped, read-only viewers — end-to-end encrypted with URL-fragment keys, rate- and byte-budgeted, snapshot caching an explicit labeled opt-in, and revocable desktop-first.

- Follow an explicit request across Assistant turns and delegated work. The
  [collaboration contract](collaboration-contract.md) provides durable questions,
  selected result envelopes, non-blocking waits and bounded continuations.
  Chats, the fold, Apps and the paired browser share the
  [collaboration experience](collaboration-experience.md): questions answered in
  place, request-wide Stop, visible results and explicit saved-work recovery.

### Next product layer

- Add a deliberate portable App Project declaration, import/relink, and
  collision model only if it can preserve ordinary-folder semantics without
  treating a copied id as ownership.
- Add reviewed schema and migration execution, retained-data adoption, and
  bounded export before allowing a Release that needs those transitions to run
  locally.
- Add richer multi-Feature composition review and instance diagnostics while
  preserving the current per-Feature authority boundary.
- Make Space location, storage ownership, History coverage, and executable capability class easier to inspect at a glance.
- Add Library organization controls such as rename, move, delete, reveal, and bulk operations.
- Add named-pack selection for Anthropic marketplace bundles instead of importing every discovered Skill in an archive.
- Extend the shipped personal act lane with Chat-scoped grants, confirmation and revocation ceremonies, and headless execution, if the surface ever outgrows the per-launch single-user token.
- Extend the shipped fold and bounded Routing triggers only through deliberate contracts for any new event source, handoff condition, or recovery behavior. Cross-Space coordination stays in the fold; Space Chats remain local to their own work.
- Add restricted-app remote subscriptions and arbitrary push adapters, finer web-runtime resource controls, and a verified Space-service registry backed by a trusted launcher, per-instance challenge, and process-generation lifecycle. Raw numeric loopback grants remain useful for development but do not prove which process owns a port.
- Strengthen onboarding, deepen accessibility coverage beyond the shipped keyboard reach, renderer interaction tests, recovery, export, and diagnostics.

### Later adapters and distribution maturity

- Prove one private hosted-web App Instance end to end—publish, deploy, explicit
  destination and connection grant, named automation and receipt, update, and
  revocation—before public discovery, an App Store, or generalized sync.
- Verify and document supported provider OAuth flows account tier by account tier in packaged desktop releases; do not turn Pi's generic OAuth hook support into a blanket compatibility claim.
- Add direct cloud-storage integrations behind a provider-neutral model with stable remote IDs, offline behavior, explicit conflicts, and no surprise deletion.
- Reactivate Windows distribution only as a deliberate future product decision with a publicly trusted code-signing identity, platform-native CI/package evidence, an updater proof, and revised release authority that does not silently gate the Mac lane.
- Consider Windows architectures only after that release lane is deliberately restored and x64 is stable.

Roadmap wording must distinguish shipped behavior from direction. Update this section when a capability moves between layers.

The completed [App platform exploration](app-platform-exploration.md) and its
Gate 1–4 memos preserve the rationale and rejected ambiguities behind the
accepted [App platform foundation](app-platform-foundation.md). Roadmap wording
must continue to distinguish accepted direction from shipped behavior.

## Decision test

Before adding a new top-level concept, ask:

1. Can it fit cleanly as Space content, a Chat, a Library material, a Skill, or an Extension?
2. Is its scope obvious: personal, one Space, or one Chat?
3. Can a person understand what it can read, change, or execute?
4. Does it preserve normal folders and standard Pi compatibility?
5. Would it still make sense for non-coding computer work?

If those answers are unclear, the feature needs a sharper mental model before it needs another navigation item.


### September 2026 recovery and automation expansion

History refuses a restore that would overwrite or delete content its new safety checkpoint cannot capture. Protected metadata and nested registered Spaces remain outside parent recovery, and historical exclusion of a directory protects its descendants even after ignore rules change. Relinking a moved Space on the same computer relocates its existing machine-local recovery state before committing the new registration. The desktop shows an effect preview; desktop and CLI hold the same active-work reservation through restore. History is bounded local recovery, not a complete or external-writer-transactional backup.

A routing version-3 `files-changed` trigger observes one explicitly reviewed folder and file-type set. Stable edits coalesce after debounce, with a cooldown; enablement is one receipted call and every run is receipted. Observers start from a baseline and pause during any routing work, sleep, or shutdown; changes during those pauses are not replayed. This prevents routing-generated edits from looping. Complete handoffs use one routing's ordered steps (A's Chat → its output files → B's Chat or Check). See [Routings](fold-routings.md).

Text Checks use the fold's configured model in a bounded review request containing only designated UTF-8 files, optional reference text, and reviewed criteria. They return quoted suggestions, cannot run tools or edit files, and become stale when any input changes. The model's assessment is judgment; the host verifies quotations and freshness. See [Checks](checks.md).
