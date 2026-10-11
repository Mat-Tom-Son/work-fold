# Product model and roadmap

This document is the durable product brief for work-fold. It exists so design, implementation, and release decisions stay aligned as the app grows.

## Product promise

work-fold makes an ordinary folder understandable as a place for getting something done, then gives that place a capable Worker.

Many people already have the right raw material—folders, files, cloud-synchronized directories, and repeatable ways of working—but do not think of a folder as an environment they can return to. A **work-folder** closes that gap. It adds a human mental model and a Worker without turning the folder into a proprietary format.

work-fold is for general computer work. Coding is one valid use, not the organizing metaphor.

Workers are taught to keep temporary working files in an ordinary `.worker/<task-id>/`
folder, created only when needed, and deliver requested files outside it.
The Files tab gives that top-level folder a muted name and icon while keeping
it fully usable. It follows normal file, Search, History, attachment and Check
policies, including the person's ignore choices. It is not hidden metadata,
private storage or an automatic cleanup area, and existing project edits stay
in their original locations. work-folder registration creates no scratch files.

## The nouns

| Concept | User promise | Boundary |
|---|---|---|
| **work-fold** | The desktop product that brings folders, conversations, materials, and Workers together. | It is not the name of each folder-backed activity. |
| **work-folder** | One understandable place for an activity, backed by an ordinary folder. | Registering a folder does not move or convert it. |
| **Files** | The ordinary folder contents visible for the selected work-folder. | Files are not a separate container or proprietary format. |
| **Chats** | Conversations grounded in the selected work-folder. | A chat does not automatically receive every file in the work-folder. |
| **History** | Checkpoints and recoverable changes associated with a work-folder. | It should remain distinct from chat history. |
| **Checks** | Optional, manual expectations over exact files or bounded file sets a person deliberately designates. | They are not ambient scanning, a permanent rail destination, or proof that an unconfigured work-folder is healthy. |
| **Worker** | The Pi-powered helper in a work-folder. | Provider connections are configured in Settings and stay machine-local; model choices are saved separately for each work-folder and for the work-fold agent, independently from work-folder content. |
| **Skills & Extensions** | One popup dialog, opened by the rail's Add button, to discover and manage what the Workers and the work-fold agent can do. | It groups Skills and Extensions and is pinned to the work-folder it was opened from; installed work-folder apps are managed in Settings → Apps. |
| **Skill** | A reusable way of working that helps the agent approach a task. | A Skill may contain executable scripts and is not merely a document. |
| **Extension** | An executable capability or connection available to the agent. | It has a stronger trust implication than an ordinary file. |
| **App Project** | An optional build-and-publication identity declared for one work-folder. | Its presentation and identity are machine-local application state, not another portable file or cloud ownership record. |
| **Feature** | One stable reviewed contribution to an App Project. | A Feature id names a slot; only an exact reviewed revision identifies executable bytes. |
| **Release** | An immutable content-addressed snapshot of reviewed Features and App presentation. | Preparing, publishing, and installing it are separate local acts; a display version is not executable identity. |
| **App Instance** | One published Release installed into a chosen work-folder with its own runtime, data, grants, connections, jobs, and receipts. | It is distinct from the source-bound Development preview and does not live in or own the work-folder's folder. |
| **work-fold agent** | The agent above all work-folders: one conversation scope, shown in the menu-bar/tray popover, the main window's agent panel, and the Web Access client under one name. | It is not a work-folder, a second Worker, or a renamed contract; "work-fold agent" stays the technical term. |
| **Automation** | A declared, inert-until-enabled set of deterministic steps that move work between work-folders on a reviewed trigger. | It is executed by app code, never by a Worker conversation, and nothing automation-shaped is written into any work-folder. The technical contract remains `automation`. |
| **Viewer** | Someone reading one published page or app through a share link while the desktop is online. | A viewer is not a paired browser, never touches the management lane, and is never a Principal. |
| **Recently deleted** | The machine-local holding place for anything work-fold removed that History could not restore — files, folders, a managed work-folder's folder, app storage and retained-data exports — kept for a retention window and restorable from Settings or the CLI. | It is not a work-folder, not portable, not a backup, and never empties on a verb; only retention purges it. |

The work-folder header chooses the active working folder and provides compact
actions to use an existing folder, create a work-folder, or manage work-folders. The
stable primary navigation then follows these everyday surface nouns:

- **Files**
- **Chats**
- **History**

An **Automations** entry follows History while an automation's trigger or
step names the active work-folder. It opens that work-folder's read-mostly Automations
tab; **Settings → Automations** remains the place to manage declarations
(the 2026-09-24 amendment in [Automations](automations.md)).

The bottom-rail **Add** button opens the **Skills & Extensions** popup directly
(2026-09-25). There is no Add menu and no Library (desktop 2026-09-25, CLI 2026-10-10); the work-folder-owned Apps tab is retired too. App building is not an Add
destination and has no button: a person asks a Worker to build an app in a
Chat. Skills, Extensions, packages, and core tools are managed in the
**Skills & Extensions** popup, a dialog like Settings and Keyboard shortcuts
that is pinned to the work-folder it was opened from. Its Installed view starts with
an **Included with work-fold** strip holding the five included tools, then shows
**Everywhere** tools for the work-fold agent and every work-folder beside
**This folder only** tools that travel with one work-folder; the two groups stack on
narrow widths. Installed work-folder apps open from their contributed rail region,
while **Settings → Apps** lists apps by work-folder and owns their grants,
connections, named automations and run history, local data, update review,
removal, Worker requests, and the receipts of their model use. Provider connections,
API keys, supported provider OAuth, scoped model choices, and per-work-folder
**Worker instructions** live in **Settings → AI Models**. Credentials are shared
machine-wide, while model choices and Worker instructions are machine-local
preferences keyed by portable work-folder identity; the work-fold agent has its own
model choice but no editable Worker instructions. A model change becomes the
default for new Chats because a live Pi session retains its session model. A
Worker-instruction change reloads that work-folder's idle clients and applies to
subsequent turns, including existing Chats. OpenRouter has an explicit live
refresh backed by its tool-capable text-model API; the last good result is
cached outside every work-folder and Pi's built-in catalog remains a fallback. A
restricted work-folder app's connection is managed with that app in **Settings → Apps**.

Azure OpenAI setup in AI Models takes an endpoint, an API key, and the names
of the person's deployed models (separated by commas or new lines). These
names become the available Azure choices; choosing a built-in Pi model or
writing a mapping is not required. One deployment is selected separately for
each work-folder and the work-fold agent. Connection settings are machine-wide,
use Pi's existing provider credential storage, and can be edited without
re-entering the key. Pasted Responses URLs normalize to the v1 endpoint.
Saving configures existing deployments at one endpoint; it does not test
inference, sign in to Azure, or discover deployments.

AI Models lists Pi's complete provider catalog and uses its advertised sign-in
methods and labels. Providers with no chat models can connect without changing
the Worker's model. Guided setup runs Pi's native credential prompts, including
provider-specific configuration and cloud credential choices. ChatGPT sign-in
uses the installation UUID Pi saves in global settings, never a project identity.
Connections retain the complete credential in encrypted machine-local storage;
only non-secret connection status and model metadata reach Settings.

Each open tab belongs to one work-folder. Selecting a tab takes the user back to
that work-folder; selecting a work-folder restores its most recent tab. With four or more
tabs open, tabs narrow but keep their work-folder icon and a normal close button.
Tabs can be dragged to reorder, or moved with Alt+Shift+Left/Right while focused.
The order is saved on this computer; grouping by work-folder confines moves to
the owning work-folder, and reordering preserves the active tab and mounted work. A
working Chat remains alive when another tab is selected, work-fold is minimized, the Windows
window is hidden to the tray, or the last macOS window closes and is recreated.
Every accepted Worker turn has one stable request id through the transcript,
kernel task, and bounded machine-local turn journal. Retrying an uncertain
delivery returns that original acceptance rather than running the Worker twice.
The live event stream carries resumable cursors and an authoritative
running/text snapshot, so sleep, renderer reload, and short local-service
disconnects reconcile without losing or duplicating the visible response.
When a settled turn's transcript read fails, the Chat retains its reply and
steps while retrying transient failures. It shows the Worker as idle; only a
successful read for the same conversation and turn replaces the preview.

Chats have a lightweight lifecycle for keeping a growing conversation list usable. **Active** is current work, **Snoozed** is deferred until a future local time, and **Archived** is retained reference material. A due snooze resurfaces automatically in Active. The selected work-folder's active Chats lead the list, followed by the work-folders nested inside it, each indented under it with its own Chats; every other registered work-folder appears below as a compact, collapsed group, including a zero count when it has no active Chats. Snoozed and Archived are closed rows at the bottom of the list, each listing those Chats across every work-folder with the work-folder's name and time (2026-10-01; earlier the three views were tabs). Aggregate activity remains visible, and search covers active, snoozed, and archived Chats alike and may expand those groups to expose results. Snoozing or archiving a Chat closes its open tab but never deletes or rewrites its transcript; the state is an append-only lifecycle event in that Chat's portable `.work-fold/conversations/` log. A snoozed or archived Chat may be opened for reading, but it must be resumed or restored before another message can be sent. Lifecycle changes are unavailable while its agent turn or compaction is active. A work-folder Chat can also be deleted: its transcript moves to Recently deleted and can be restored from there, and the delete refuses while the Chat has a running turn or unfinished request work.

A new Chat begins with a temporary **New Chat** label. After its first successful
turn, work-fold asks that Chat's active Pi model for a short title based on the
first request and reply, then persists the result so it remains stable across
tabs, restarts, and machines. The title request uses the same authenticated Pi
model transport as the turn, including live provider catalogs and stored Azure
endpoint, key, and deployment settings. For reasoning models it prefers the
lowest ordinary reasoning level exposed by Pi, avoiding `minimal` when another
level is available because some providers reject it. If that one
bounded request fails, the Chat remains **New Chat** rather than presenting its
first message as though it were a generated title; naming can never fail the
otherwise successful turn, and the failed attempt is not repeated. Previously saved titles remain authoritative, including titles made by older
versions; rebuilding a cache must not replace them with **New Chat**. An explicit
person-authored rename always wins, including an intentional rename to
**New Chat**. Title and lifecycle summaries may be cached in machine-local
application state, but those caches are disposable and versioned independently
from the portable append-only transcript.

The work-fold agent's menu-bar chat history offers **Rename** and **Delete** in
each chat's actions. The paired web chat offers those actions in its **Chat options** menu.
Deleting an idle chat moves its transcript to **Recently deleted**; restoring it
returns it to the chat list. Chats with outstanding work must be stopped or
finished before deletion, and stopped turns must finish draining first.

File deletion and work-folder removal likewise refuse until the affected
work-folder's requests and delegated work have settled or been stopped and
drained. Running turns, compaction, Checks, app jobs with file access, and
Automation file work hold the same backend reservation across deletion. A waiting question still
counts as unfinished work. This applies to desktop and CLI calls, including a
Worker deleting from its own running turn; a busy refusal must not be bypassed
with raw filesystem tools.

Background state is quieter and machine-local: a small running marker follows an accepted agent turn across the Chat navigator and tab strip, and becomes an attention marker only when the turn settles out of view. Viewing the Chat clears that marker. This acknowledgement state is an app preference on the current computer, not portable conversation content.

The configured provider and model remain visible in the Chat composer before the first message. Clicking that label opens an inline model picker with the work-folder’s saved model pinned first and search when more than eight connected models are available. A selection saves the work-folder default for new Chats; existing Chat sessions keep their model. The picker’s **Model settings** link opens **Settings → AI Models** scoped to that work-folder. The label always names the provider/model, never the product. The adjacent reasoning control is hydrated before the first send from Pi's saved default and lists only supported levels; a live Pi session becomes authoritative. Successful and interrupted Worker messages persist their bounded tool trail with terminal states, so tab switches and relaunches restore it without a ghost spinner or replay of completed tools. In the Chat that trail is the Worker's steps: while a turn runs, each step appears in the order it happened with the active one shimmering and live reasoning in a short panel; once the reply starts, the steps fold into one plain line such as "Read a file, edited a file, ran commands" that opens on click, and a "Thought" row opens its reasoning. Reasoning a model keeps hidden still shows as "Thought for 3s", so a saved thinking entry records its duration. Provider failures use Pi's bounded retry path, preserving completed tool results; exhausted retries, setup failures, stops, terminal failures, and recovery append typed user-safe results. Startup never reruns a Worker turn that reached the runtime. The portable transcript is the content authority and the local journal supplies acceptance deduplication and reconciliation.

Attaching a file from Files stages a reference to its work-folder-relative path for
the next message. A quiet file icon, filename, and remove control above the
composer show that selection; attaching does not produce a success toast or
an extraction-status warning. Documents and other non-image files are not
extracted or copied into the model prompt: the Worker is told which paths the
person attached and uses its file or document tools to inspect the originals
as the task needs. Staging checks that each path names an available file;
missing files and invalid paths remain errors. Supported images still use
Pi's existing bounded vision pipeline when sending.

## A work-folder is a view of a folder, not a new file format

There are two honest ways to create a work-folder:

1. **Create a work-folder:** work-fold creates a normal folder under its managed local content location.
2. **Use an existing folder:** work-fold registers the folder in place.

Both routes should lead to the same product experience. Registration must not move, duplicate, or rename user files. work-fold adds one intentionally narrow, hidden metadata layer: `.work-fold/work-folder.json` preserves the work-folder identity when its folder moves, and `.work-fold/conversations/` keeps that work-folder's Chats with it. The Files and History surfaces hide this directory. Provider credentials, the work-folder registry, History objects, Pi sessions, ignore rules, and other machine-specific app state remain in application storage. Portable executable Pi configuration remains separate under `.pi/`. Creating or registering the work-folder is the user's authorization for work-fold to load that local configuration; removing the work-folder revokes that authorization.

work-fold starts from a clean profile. It does not parse, import, migrate, rewrite, wipe, or delete legacy Workspace application state, `.workspace/` metadata, restricted-app data, connections, receipts, or artifacts. Preserved `.workspace/` content is non-authoritative and remains hidden and excluded from History, Search, Checks, and restricted-app file grants. Pi's personal resources and authentication may remain shared at the configured Pi root, but work-fold sessions are isolated under `sessions/work-fold/`.

Deleting a managed work-folder moves its folder into Recently deleted and
unregisters it; removing a linked work-folder only unregisters. The clean-break rule
holds inside Recently deleted: an entry whose tree carries preserved
`.workspace/` metadata is marked held, so neither the retention window nor
**Delete now** erases it, and work-fold still never parses, migrates, or
rewrites that metadata.

A work-folder may also have a personal visual identity: accent colors, a compact banner, and a Fluent icon. Those preferences help distinguish work-folders inside work-fold, but they currently remain application state on this computer. The versioned `work-folder.json` schema can grow deliberately if portable appearance is introduced later; current code must not smuggle machine-specific state into it.

The same portability rule applies to the App Project declaration. Its
`projectId`, source-work-folder binding, title, description, and icon live in work-fold
application data. A Release captures an immutable presentation snapshot, but
work-fold does not create `.work-fold/app-project.json` or imply that copying a
folder transfers Project ownership. Portable Project metadata, import, and
collision handling require a later explicit design.

The user should always be able to reveal a work-folder in the operating system, open its files with other applications, back it up normally, or synchronize it with a desktop sync tool. A Google Drive for desktop folder works because it is a local folder; that is not the same as direct Google Drive API integration.

Settings uses one preferences window with **Appearance**, **AI Models**,
**Web Access**, **Shared pages**, **Automations**, **Recently deleted**, and **About** navigation,
plus an **Apps** page (2026-09-25) that lists installed work-folder apps by work-folder and
owns their management. Automations also carries **Limits**, collapsed by default
under a Limits disclosure and unchanged in meaning; **Closing the window**, where supported,
lives in Appearance → Interface, and updates live in About. The navigation becomes a single horizontally scrollable row in
narrow windows; keyboard selection brings the selected item into view. AI Models
settings separate model defaults, shared provider
connections, and work-folder instructions; the scope is chosen with two large buttons —
**This worker**, naming the work-folder, and **work-fold agent** — and the model is a
dropdown: closed, it shows the chosen model; open, it starts with a search box
and groups every connected provider's chat models by provider and vendor (for
OpenRouter, the vendor prefix of the model name), and choosing a model closes
it. **Provider connections** is separate, with saved connections grouped above
available providers. Connection setup preserves the model choice and draft;
this includes Azure endpoint and deployment setup (2026-10-09).
Unsaved model/instruction drafts survive
page and scope changes while that window stays open; credentials are not cached
across scope changes. Accepted saves retain their completion ownership if the
window closes, so reopening waits for their result. External settings changes
refresh clean forms and offer an explicit reload when drafts are present.

[Application appearance](application-appearance.md) adds editable presets,
application palettes and accent, separate interface/conversation typography,
reading width and spacing, list density, quiet messages, which Worker steps
stay visible while a turn runs, and accessibility preferences. The desktop and menu-bar chat share device-local preferences;
the paired web fold retains its browser appearance. Typed appearance files are
inert data. Undo and reset operate on these preferences without changing work-folder
colors, icons, or banners. **Customize work-folder** opens a popup from the work-folder header,
Manage work-folders, or Settings → Appearance, pinned to that work-folder while the existing work tab stays
in place. It shares the focus, Escape, and outside-click behavior of the other popup dialogs.
Its compact Banner, Icon, and Color sections include four offline image presets, draggable image
framing, and categorized Fluent icons. Model and Instructions shortcuts open that work-folder's existing
Worker settings; appearance stays personal application state outside the ordinary folder.

## Context is explicit

Registering a folder is also the host authorization for its existing local Pi configuration. Agent context, new package installation, restricted-app permissions, and external connections remain separate states:

| Action | What changes | What does not happen implicitly |
|---|---|---|
| Register a folder as a work-folder | The folder appears in work-fold and its local Pi configuration may load. | Files are not uploaded or converted, and local code is not certified as safe. |
| Attach a file to a Chat | That file is made available to the conversation. | Other work-folder files are not included automatically. |
| Create a Check proposal | An inert, typed expectation names one sensor and exact primary/reference targets for review. | It is not enabled, run, scheduled, or treated as executable configuration. |
| Enable a Check | work-fold writes the portable code-free declaration and records an exact-digest, exact-sensor machine grant. | Registration, proposal discovery, and a one-off request never enable standing behavior. |
| Run a Check | work-fold inspects only its designated targets within hard host limits and admits only independently re-verifiable evidence. | No other work-folder files are scanned; health failures and stale results never become content findings or a clear state. |
| Install a personal Skill or Extension | It becomes available through the user's Pi scope. | It is not copied into every work-folder. |
| Ask a Worker to build a work-folder app | The agent writes an ordinary restricted-app package and asks work-fold to inspect it; the inspected digest is installed at once as a Local preview with every declared destination, file permission, notification category, Check-result slot, and automation, and the proposal record is the receipt. | No JavaScript is evaluated during inspection, no secret is collected, and destinations that need a secret are named for the person to connect in Settings → Apps. |
| Add a reviewed work-folder app | The exact reviewed digest becomes a Local preview in that work-folder's Development Instance, able to reach everything its package declares. | It is not a Release or App Instance, and a destination that needs a secret stays unusable until the person connects it. |
| Declare an App Project | work-fold records an explicit machine-local title, description, icon, Project identity, and source-work-folder binding. | No file is added to `.work-fold/`, no account or cloud Project is created, and source is not uploaded. |
| Prepare a Release | work-fold snapshots every current reviewed Development preview into one verified, immutable, content-addressed v2 Release and records a prepared state. | It is not yet eligible to install, and later source edits cannot alter its bytes. |
| Publish a prepared Release | work-fold rechecks that the reviewed previews are still exact, then records a separate local publication receipt. | Nothing is uploaded, signed, listed, hosted, granted, or installed. |
| Delete an unused Release | work-fold removes its machine-local lifecycle record, then safely prunes the unreferenced immutable object. | A Release required by an active App Instance, either side of a prepared install/update/rollback, or retained data cannot be deleted. Project source and App data are not removed. |
| Prepare and activate an App install | work-fold durably allocates one new App Instance and its Feature/Data identities, then installs the exact published Release into the chosen registered work-folder. | It does not convert the Development Instance. Declared powers are granted and declared automations enabled on install; connections with a byte-identical destination declaration, automation enabled states by id, and run receipts carry forward across a changed digest; an identical digest is idempotent. |
| Prepare and activate an update or rollback | work-fold records a deterministic plan, rechecks it at activation, fences the old runtime, and atomically changes the active Release and authority. | A friendly version cannot override digest identity. Only exact unchanged content is eligible for continuity; schema/migration execution is not supported locally. |
| Uninstall an App Instance | work-fold fences the whole release-backed runtime and requires an explicit retain-or-purge choice for local data. A purge first writes a recovery export into Recently deleted. | Project source and separately selected work-folder files are never deleted. Retained namespaces do not remain runnable and require a later explicit purge. |
| Re-allow or revoke one app destination, file root, notification category, or Check slot | Declared powers are on from install; the person narrows them and can re-allow them, and each control names one exact reviewed declaration. | Other declarations, saved connections, automations, and other work-folders receive no authority. |
| Save or remove an app connection | work-fold adds or deletes one operating-system-encrypted binding for the host-derived Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, target, and current Runtime Instance owner. | Destination access is not implicitly granted, and deleting the local record does not revoke the credential at its provider. Principal-owned connections remain a future portable-runtime journey, not a current local UI. |
| Disable or re-enable one app automation | Declared automations run from install on their bounded schedules while work-fold is running; disabling stops one, and re-enabling starts it again. | A disabled job does not run, and every run receives only the intersection of current grants and its reviewed permission subset. |
| Run an app automation now | work-fold runs that named job once and records a durable receipt, even if its schedule is off. | It does not enable or shift the schedule; a disabled job has no notification authority. |
| Delete a file or folder | work-fold records a safety restore point; anything the restore point cannot cover moves into Recently deleted with a manifest naming its work-folder, path, size, deleted-at, restore-by, and receipt. | Nothing is permanent at the moment it happens; `.work-fold/`, `.pi/`, and `.workspace/` are never valid endpoints. |
| Restore from Recently deleted | work-fold puts the entry back at its recorded work-folder path, or re-registers a deleted managed work-folder, and receipts the restore. | The retention clock is the only thing that empties Recently deleted; no agent or CLI verb does. |
| Ask an app for agent work or a model call | `assistant.request` starts a fresh full-tools Chat in the owning work-folder immediately; `assistant.infer` returns bounded text or schema-validated JSON from the work-folder's model with no tools or transcript. Both leave receipts naming the effective model and usage. | No grant beyond installation is needed; viewers and remote app views get neither; model selection stays with the person. |
| Enable an automation | work-fold records an exact-digest machine grant over one reviewed declaration on a single receipted call. | Proposal authoring, registration, and run-now never enable standing behavior; an edited declaration returns to proposed. |
| Run an automation | App code executes the reviewed steps in order with per-hop receipts inside the shared scheduler bounds. A declared `fold` step may message the work-fold agent, and a closed set of host-resolved placeholders may fill a step's message. | No model composes glue, an automation never moves or deletes source files, and no work-folder's folder learns another work-folder exists. |
| Share a page | One explicitly designated file is served as a rendered page at the person's address while the desktop is online, on a single receipted call; the share is revocable at any time. | Nothing else in the work-folder is exposed, the bridge stores no page content by default, and App Studio's local "publish a Release" grants no audience. |
| Revoke a publication | work-fold refuses new viewer fetches desktop-first, then deletes the bridge slot and any snapshot. | Old links die; sharing again mints a new slot, key, and link rather than reviving the old one. |

This separation is a core product rail. “Available,” “in this work-folder,” “in this chat,” and “allowed to execute” must never collapse into one invisible state.

## Agent model

work-fold hosts Pi instead of recreating an agent framework. Pi owns model/provider behavior, built-in tools, standard resource discovery, packages, Skills, Extensions, and project trust mechanics. work-fold supplies the desktop experience: setup, catalog surfaces, secure credential persistence, folder selection, the registered-work-folder authorization override, extension UI bridges, and clear execution/permission explanations.

Supported native Extension questions stay inline in their owning Chat,
including the work-fold agent, with transient reconnect recovery and Stop. They are live
Pi callbacks rather than durable agent questions. Included capabilities
use this same native Extension path; inclusion describes work-fold's
maintenance responsibility, not another trust or runtime tier.
See [Extensions and computer work](extension-foundation.md) for the design,
compatibility requirements, and work still required before inclusion.

The [tool feedback contract](tool-feedback.md) applies across general computer
work: native tools return observations, and the agent uses Pi's ordinary
loop to verify or correct its result. Context inspection is a developer-only
local diagnostic at `?dev-context`, outside ordinary Chats and Settings. Its
optional memory-only recording captures assembled model context and observable
provider payloads with provenance; recording is off by default. It does not
add a new navigation concept or execution framework.

There are two capability scopes:

- **Everywhere** (everywhere scope): available to the work-fold agent and every work-folder from the user's Pi agent directory.
- **This work-folder only** (project scope): portable configuration stored under the work-folder's `.pi/` directory and authorized while the folder is registered as a work-folder.

The **Skills & Extensions** popup unifies discovery and management without erasing the distinctions that matter. Its Installed view starts with the **Included with work-fold** strip, then shows **Everywhere** and **This folder only** side by side; a row opens its details on click, and adding starts from one Add dialog that asks **Where should it live?** first. It identifies whether an item is a Skill or Extension, Everywhere or This work-folder only, active or merely available, direct-imported or package-provided, and healthy or diagnostic-failing. Installed items can be searched, filtered by type and scope, and sorted by name, type, scope, or source. Discover results can be searched, filtered, and sorted by first-party/reference status, downloads, recency, or name.

Packages can distribute Skills, Extensions, prompts, themes, and related Pi resources. They remain installation and lifecycle plumbing; the primary UI should describe the capability a person is gaining, show inspected resource types and lifecycle scripts when registry metadata is available, and label unavailable details as unknown rather than absent. A package that includes Extensions or install scripts is a code-execution decision and must not be presented as a harmless Skill-only import. See [Skills & Extensions](skills-and-extensions.md) for the complete compatibility and safety model.

work-fold has two deliberately different executable lanes:

| Lane | Trust and distribution | UI and authority |
|---|---|---|
| Native Pi Extension | Standard Pi package/resource locations; full current-user execution after Everywhere install or work-folder registration. | May add Pi tools, commands, providers, events, and a static host-rendered `surface.json` contribution. Its code owns its network and operating-system access. |
| Restricted work-folder app | A complete, work-folder-local reviewed-web package proposed by the agent or selected through advanced local preview. It never enters Pi's package manager or loaded catalog. | Runs reviewed UI and worker code in separate sandboxed Electron hosts. Tabs, network, storage, files, connections, notifications, and named automations exist only through narrow host contracts. |

The model experiences either lane as a package-shaped capability, but the product must not flatten their execution boundaries. Native Pi compatibility remains the full-trust ecosystem lane; restricted apps are the flexible app canvas for generated inboxes, dashboards, extractors, project-service panels, and other work-folder-specific tools. See [Restricted app authoring](restricted-app-authoring.md) and [Restricted app runtime](restricted-app-runtime.md).

## Apps without turning every work-folder into an App

work-fold is growing from a local work-folder tool into a local-first App studio and
runtime, but **work-folder** and **App** are not synonyms. A work-folder remains the ordinary
folder-backed context for general work and may never produce an App. A work-folder may
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
Publication is not folder sync, an App Release contains no ambient work-folder or Pi
authority, and hosted web must implement the same semantic broker restrictions
as the desktop runtime. The accepted identities, authority rules, implementation
order, and private hosted milestone are defined in
[App platform foundation](app-platform-foundation.md).

In the shipped local path, the existing Chat-bound or advanced direct preview
is explicitly a **Local preview** in the source work-folder's Development Instance.
App Studio separately declares Project presentation, prepares, publishes, and
deletes unused Releases, installs one into a chosen registered work-folder, and
manages update, rollback, uninstall, retained data, and purge. App Studio is a work-folder-bound work
tab reached from an app's details in Settings → Apps, not a fifth top-level rail destination.

## Shared semantic layer

work-fold also needs a semantic layer above its individual screens so the same product can be understood by the renderer, command line, scripts, Pi, and eventually a higher-level agent. `WorkFoldKernel` is that shared in-process read authority. It resolves actor context to the most-specific work-folder, exposes versioned snapshots of registered work-folders and running agent work, and projects Pi's authoritative capability catalog without creating another registry.

The installed `work-fold` command is the first adapter over that layer. Its read lane reports context, work-folders, active agent turns and compactions, and available Skills, Extensions, tools, packages, prompts, themes, and commands in human or stable JSON form, and stays deliberately content-free. A separately versioned act lane — authenticated per app launch and recorded with durable receipts — additionally gives a shell-capable agent the product's receipted verbs while the app is running: work-folder lifecycle and appearance, per-work-folder model defaults and instructions, Chats and their lifecycle, History restore points and restores, restore-pointed file operations, Library copies, content search, Checks, App Studio's authority-neutral lifecycle, Recently deleted, fold-side app listing and tool invocation (`apps list|invoke`), the collaboration verbs and request reads (`chat report|ask|answer|handoff`, `requests list|show`), and the work-fold agent itself. `work-folders assistant show` is a content-bearing act read because it returns the instruction text and only already-connected model choices; its model and instruction setters are direct, work-folder-scoped, metadata-receipted acts fenced against active work-folder work. Provider credentials and provider connection setup remain unavailable. Act commands reuse the same trust, conflict, History, and task rules as the desktop surfaces. Acts that make bytes runnable, widen a standing power, or destroy run immediately through the same prepare, pin, journal-first, fenced execution path and return a receipt; destruction is reversible through History or Recently deleted (`recently-deleted list|restore`). The act lane has no approval state. Tabs, panes, other application settings, pairing, and secret entry stay outside it.

The **work-fold agent** is the first in-product consumer of that layer: one conversation scope above all work-folders and the door through which material enters them. Its transcript is machine-local, and its Pi session loads Everywhere capabilities plus two app-materialized work-fold agent instructions. It is a full-trust agent with ordinary local tools, taught to prefer receipted `work-fold` read and act commands for work that touches work-folders. It is reached through `work-fold agent …`, with a default single saved conversation and `--new` creating another thread, and through the menu-bar popover. The popover is a compact conventional chat: person messages are colored bubbles on the right and agent replies are unboxed on the left. Its header shows the current Chat title, **Previous**, and **New chat**; it has no **Open app** action, brand lockup, conversation disclosure, overflow menu, or phase badge. **New chat** makes a clean slate, creates a saved transcript on first send, and never deletes a prior transcript. The popover remains a separate window rather than a work-folder-bound tab. Dragging files, folders, or links over it stages inert reference chips; the person adds an instruction and send remains the explicit act. Its composer is an expanding field with a centered circular send action; the model label opens **Settings → Agents** scoped to the work-fold agent and the reasoning selector saves the next-session default before a Chat exists and changes a live management session when one exists. While a turn runs, the action becomes **Stop**, the draft remains usable, and incremental agent text streams before the persisted reply replaces it. A request whose delegated work-folder turn is still running shows **handed off**, never done; a failed child fails the request, Stop names every recorded child it aborts, and every attachment receives a final disposition.

A person's ask is a **request**: one durable, machine-local record that owns the outcome across however many turns and work-folders it takes ([the collaboration contract](collaboration-contract.md)). The work-fold agent hands a piece of it to a work-folder's own agent, that agent hands one result shape back — a plain-language summary, optional structured details, the files it chose, and whether it finished, finished partly, or failed — and either side can ask a question instead of guessing. A question stops that task rather than the person's day: the turn ends, the request says it is waiting, and one accepted answer starts exactly one continuation turn carrying it. A parent turn never sits on a waiting child; it finishes and says what is outstanding, and when the work it handed out settles, work-fold starts at most one follow-up turn in the work-fold agent carrying the collected reports, within that request's bounds and switchable off in Settings → Automations → Limits. A work-folder that needs another work-folder asks for a handoff, and work-fold starts that Chat with the message and copies of the named files through the ordinary restore-pointed path; no model turn is needed to move a result. What crosses into a work-folder Chat is only its assignment, payloads someone deliberately released to it, and answers to its own questions — the request graph, other work-folders' results, and the work-fold agent's transcript stay above work-folders. The same verbs are available to the work-fold agent, to a Worker, to an app's requested task, and to any shell-capable agent on the CLI, with the same receipts and the same named limits.

**Web Access** (technically the remote-access bridge) is a private-alpha connected surface over the canonical work-fold agent, not a second agent, a work-folder-chat selector, or a cloud-synchronized work-folder. A person chooses one private `<name>.work-fold.com` address and password in Settings; new-address enrollment is controlled by the hosted bridge rather than an invitation code or a credential embedded in the public app. Password sign-in establishes only a short-lived browser session; the desktop must separately confirm that browser by matching a six-digit code, after which a non-exportable browser key and revocable desktop-signed grant authorize the surface. This is a full-trust grant to the management agent, which keeps its ordinary local tools and can delegate work to registered Workers through the explicitly attributed management act path. The browser lists bounded saved management-chat summaries, opens bounded recent transcripts, sends to a selected saved work-fold agent Chat or starts a new one, and stops only a work-fold agent request accepted by that exact browser grant; request-level stop also covers its recorded child turns. While a work-fold agent turn runs, a current desktop additionally streams bounded live response text and its current activity line to the paired browser as throttled signed encrypted progress events over the same operation lane. The durable transcript replaces that transient projection when the turn settles; the desktop advertises the watch capability in its summary projection, so an older desktop is simply never asked, and every streamed tick rechecks the grant before it leaves the desktop. The current browser focuses on New chat and saved Chats; it has no Files/work-folder browser. A **Shared pages** popup in the sidebar footer lists existing active page/app publications from the desktop. Titles and health cross the encrypted management lane without keys; a click transiently reveals one current key and opens its exact isolated viewer origin in a new tab, with the key only in the fragment and no opener. This does not share new content or change publication authority. Chat result links retain bounded file previews and exact-installation app views. Older file-tree operations remain compatible, but are unused by the current client. Absolute roots and ignored paths never cross the adapter.

Remote uploads are a separate explicit act. Each message accepts up to 64 plain-named files, 6 MB each and 8 MB total (the relay envelope's size), carried inside the signed encrypted envelope. The work-fold agent Chat holds them under app-owned `management/Incoming/Remote/` so the management agent can explicitly use them or place them into a work-folder through the restore-pointed `files add` path; that holding area is limited to 64 MB, expires after 24 hours, is purged for a revoked browser and on Web Access disablement, and never exposes the holding path back to the browser. The remote adapter still cannot attach arbitrary desktop paths, tunnel the local HTTP API, receive absolute roots, directly manage capabilities/settings, invoke a work-folder Chat directly, or call an open-ended method. The bridge persists account/session/grant/operation metadata but never durable message or file content; content projections and uploads cross it as signed application-encrypted envelopes. That protects persisted relay state and passive payload handling, not an actively compromised hosted client or bridge: the hosted origin serves the code that may use a paired browser key and is therefore inside this alpha's authority boundary. Revocation withdraws the desktop-local grant before the server mutation, is serialized with dispatch, and stops locally tracked work-fold agent requests and their recorded child work. Revoking one browser, revoking every generation, disabling Web Access, or deleting the address are separate desktop actions. Core work-folder use stays local and account-free.

This is infrastructure over the existing nouns, not a new user-facing concept. A future cross-Worker and controlled work-folder runtimes should build on the same typed actor, scope, task, and capability contracts instead of scraping renderer state or bypassing domain policy. See [work-fold agent and CLI](work-fold-agent-and-cli.md) for the exact contract and security boundary.

## Product rails

When a design is ambiguous, prefer the option that best preserves these properties:

1. **Local first:** core work does not require an account or cloud service.
2. **Ordinary files:** user content stays portable and directly accessible.
3. **Clear language:** expose the work-folder mental model before filesystem or package-manager jargon.
4. **Explicit context:** people can tell what the agent can see in the current chat.
5. **Layered authorization:** work-folder registration authorizes local Pi configuration; package installation, restricted-app permissions, connections, and Chat context stay explicit and separately revocable.
6. **Pi compatibility:** use standard Pi behavior and formats instead of parallel work-fold-only systems.
7. **Capability transparency:** show source, scope, status, and diagnostics for executable additions.
8. **Provider neutrality:** cloud and model integrations should use replaceable adapters rather than shape the core model.
9. **Receipts, not gates:** every verb executes on first call, journaled before and receipted after; verbs that make bytes runnable, widen a power, or destroy keep their identity pins, effect-time rechecks, and at-most-once execution as attribution and recovery. No surface offers an authority mode, a standing rule, or an approval card.
10. **Reversible destruction, setup-only secrets:** History covers ordinary deletion; what it cannot cover goes to Recently deleted with a retention window; exposure and grants are revocable. Web Access administration, pairing machinery, and provider credentials are local desktop Settings acts with no agent, CLI, or remote verb, and no task waits on them. Per-work-folder model defaults and work-folder instructions are configuration with the narrow receipted fold verbs described above.
11. **Agency on a cadence lives in work-folders:** above work-folders, only declared deterministic automations run unattended; enabling one is a single receipted call that pins the declaration digest; an automation may message the work-fold agent only through its declared `fold` step; cross-work-folder work never runs inside a work-folder chat because work-folder transcripts travel — what enters a work-folder Chat from above is its assignment, released payloads, and answers to its own questions. The one bounded exception is a person-initiated request's follow-up turn: when the work it handed out settles, the host may continue that request in the work-fold agent once per settle batch, within the request's own limits.

## Roadmap and known gaps

### Foundation now

- Create a folder-backed work-folder or register an existing folder without conversion.
- Rename a work-folder, remove a linked-folder registration without deleting its files, or delete a managed work-folder into Recently deleted.
- Browse and upload work-folder files, run work-folder-scoped Chats, and view History.
- Search a work-folder by content as well as by name: matches inside ordinary files and inside Chat transcripts, honouring the work-folder's ignore rules, skipping binary and oversized files, and disclosing when a bound stopped the search rather than implying a complete answer.
- Restore content-addressed History checkpoints created around file mutations and agent turns. A full checkpoint hashes real bytes rather than trusting metadata, and keeps that cost proportional to the person's own work: it skips version-control internals, installed dependencies, Python virtual environments, self-declared caches (`CACHEDIR.TAG`), work-fold's hidden support directories, directories the person ignored in Files, and directories a `.gitignore` excludes — while every individual file, including a gitignored `.env` or a file hidden from Files, remains recovery material. A targeted mutation checkpoint captures exactly the paths it is asked about.
- Configure a Pi provider/model with an API key or an advertised Pi provider OAuth flow and use Pi's built-in tools.
- Discover installed Skills, prompts, Extension commands, and supported built-ins from the Chat composer, and inspect the active model and context-window pressure during a conversation.
- Show the configured provider/model before a Chat's first send, safely retry transient provider stream failures from completed tool results, preserve terminal partial output and activity as a resumable interruption, and save sanitized setup or unexpected failures in the transcript. A saved reply keeps every text segment the turn produced — what the agent said before, between, and after its tool calls — joined as paragraphs in the order it streamed, so a reopened Chat reads the way it did live.
- Discover and search Personal and registered-work-folder Skills and Extensions in the Skills & Extensions popup, with accurate source, scope, load state, and diagnostics.
- Browse curated first-party/reference Skills and Extensions alongside community Pi packages, with type filters and explicit provenance.
- Import standard Skills and compatible skill bundles while preserving their supporting files.
- Install, update, and remove Pi packages at Personal or registered-work-folder scope.
- Customize each work-folder with semantic light/dark accent roles, a compact banner, paired colours, and a searchable Fluent icon catalog without changing its folder; machine-local service storage, dual previews, contrast auditing, undo/reset, and inert proposal import/export keep the same typed contract available to people, Codex, and Claude Code.
- Inspect work-folder context, registered work-folders, active agent/compaction tasks, and Pi capabilities through one versioned `WorkFoldKernel` and the installed `work-fold` CLI's content-free read lane.
- Operate the product from any shell-capable agent through the CLI's per-launch-authenticated act lane while the app is running: create or register work-folders, copy outside material into a work-folder with a History restore point, and start, continue, await, or abort work-folder Chats — every action journaled before it runs and every CLI-initiated turn tracked as a kernel task with a task-scoped outcome.
- Talk to the work-fold agent above all work-folders through `work-fold agent send|status|result|wait|abort|stop|list`: the same agent runtime with personal capabilities plus work-fold's two app-owned management resources, reference attachments, an explicit request/child action trail, machine-local saved transcripts, default single-conversation behavior with an explicit New chat clean slate, and task-scoped outcomes; the menu-bar/tray popover is its visible desktop surface.
- In the private alpha, optionally reach the saved work-fold agent at a chosen private `<name>.work-fold.com` address while the desktop is online, after password sign-in and an explicit one-time full-trust desktop confirmation of that browser; open existing shared pages from the sidebar popup, delegate through the one management agent, and attach bounded uploads, with content-bearing operations carried in signed application-encrypted envelopes through a trusted hosted client and bridge. While a work-fold agent turn runs, stream bounded live response text and its current activity line to the paired browser, then reconcile the durable reply when it settles; the capability is advertised by the desktop's summary projection, never probed, so an older desktop keeps the polling cadence.
- Define optional file-presence or model-backed text Checks over designated files through the desktop setup form or inert proposals and explicit machine-local enablement; run, await, inspect evidence-backed problems, and record fingerprint-scoped decisions through the installed CLI, work-fold agent, and one work-folder-owned desktop work tab. A conditional Files-toolbar summary and quiet exact-file markers appear only for configured state; unconfigured means unknown, portable declarations remain inert, and opening Checks never starts a model or enables automation. A separately reviewed automation may run Checks on a schedule or after an explicitly designated folder changes.
- Drop native OS files onto any Chat composer to upload them into that work-folder's dated `Dropped/` folder and attach them as context in one explicit act; uploads record additive History restore points.
- Steer a running agent turn: Enter mid-turn delivers the message through Pi's steering queue, the agent reads it after its current step, and the transcript records it as sent mid-turn; if the turn settles first the message becomes the queued draft instead. ⌘/Ctrl+Enter queues one follow-up message behind the running turn as a visible, cancellable draft that sends when the turn settles; Stop returns it to the composer instead of firing it into the stopped turn's aftermath.
- Attach images to a turn: an attached PNG, JPEG, GIF, or WebP work-folder file reaches the model as image content (resized locally by Pi's own image pipeline when needed) rather than as a path-only reference, and a pasted screenshot lands in the work-folder's dated `Dropped/` folder through the same explicit upload path as a dropped file before it is attached.
- Choose the reasoning level for a work-folder or fold Chat from its text-only composer control (or `/thinking` in a work-folder Chat), limited to what the current model supports, persisted in the Pi session, and remembered as the default for new sessions exactly as Pi's own TUI does.
- Run an agent turn without a wall-clock cap, as native Pi does; Pi's own HTTP idle timeout still catches a provider that stops answering, and a host may opt into an explicit cap with `WORKFOLD_PI_TURN_TIMEOUT_MS`.
- Give the agent's shell tools the person's real login-shell environment: a Dock, Finder, Spotlight, or `open` launch asks the login shell for its environment once at startup (profile-provided `PATH` entries such as Homebrew or nvm included) before any Pi session exists, while a terminal launch keeps the environment it was given; `WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1` opts out.
- Reach model providers through the same transport as the Pi CLI: Pi's `httpProxy` setting and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are honored, Pi's HTTP idle timeout applies to headers and bodies, and the guarded dispatcher is installed before the first provider request.
- Preview bounded text and common image files inline in the file tab — truncation disclosed, binary or oversized content declined with its reason — under the same work-folder path policy as every file route.
- Reach tabs, files, and running work from the keyboard: close, cycle, and jump between surface tabs, open a new Chat tab, stop the running turn, move the Files selection with arrow keys, rename and delete from the tree into the existing undo window, and answer Settings groups with arrows.
- Drive one real Pi turn through the local API with the harness-neutral `work-fold:drive` test driver.
- Render validated declarative `surface.json` contributions from loaded Pi Extensions as a contributed rail destination, left-pane navigator, and work-folder-bound view tabs without injecting Extension code into the renderer.
- Let the agent submit a completed, work-folder-relative restricted-app package through a host-owned proposal tool. work-fold persists a work-folder-and-Chat-bound, digest-pinned review without evaluating JavaScript; the inspected package is installed at once as a Local preview with every declared power and automation, and destinations needing a secret are named for the person.
- Give each installed work-folder app arbitrary reviewed web UI in a sandboxed rail navigator and host-derived persistent work-folder-owned right tabs, plus optional bounded agent actions and named automations in a separate worker sandbox. A machine-wide scheduler shared across work-folders provides four execution slots, FIFO admission, same-job non-overlap, durable cadence, bounded catch-up, and run receipts. Settings → Apps manages each job independently alongside exact network/file/notification grants, host-owned encrypted connections, local data, updates that carry eligible authority forward, removal, and the secondary advanced local-package path.
- Provide bounded host-owned JSON storage with active-visible-view invalidation hints, History-covered work-folder-file grants, exact public-HTTPS or numeric-loopback requests, API-key/bearer/basic/OAuth PKCE connection adapters, and static reviewed system notifications from enabled automation runs.
- Carry host-owned local App Project, Development Instance, Feature Installation,
  Data Namespace, canonical Feature Revision, and seven-domain authority identity
  through the restricted-app UI. The first work-folder-app preview may
  establish the work-folder's machine-local App Project/Development Instance scaffold;
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
- Attach each local App Instance to one chosen registered work-folder while keeping its
  bytes, data, grants, connections, schedules, journals, and receipts in
  work-fold application data. Enforce one instance per `(projectId, target
  work-folder)` and reject Feature-id collisions with previews or other installed Apps
  in that work-folder.
- Preserve only exact eligible authority across a release change. A changed
  Feature revision keeps its installation/data lineage but resets grants,
  connections, and jobs; the current local runtime rejects schema-bearing
  Releases and migration execution rather than applying them partially.
- Block removal of a Project's source work-folder or an App Instance's target work-folder
  while a release-backed instance remains active, directing the person to
  uninstall it with an explicit data choice first. Keep the source blocked while
  its Project owns retained data; after explicit purge, source removal clears the
  machine-local Project/Release lineage and target removal cancels prepared
  operations aimed at that work-folder.
- Build, Developer ID-sign, notarize, and publish the macOS arm64 app, DMG, ZIP, blockmap, and update metadata, with a verified installed two-version updater lane. This is the only active desktop distribution lane.

- Meet the whole product through the **work-fold agent** — the work-fold agent above all work-folders, its menu-bar/tray popover, and paired web chat — with capture in and publishing out. See [the work-fold agent](work-fold-agent-decisions.md).
- Perform every product verb through the work-fold agent's receipted act lane at human parity: chat lifecycle and compaction, History restore with automation-aware fencing, file operations, content search, work-folder rename/unregister and appearance, capability removal, and App Studio's authority-neutral lifecycle — each act journaled before it runs, receipted after, with typed undo references.
- Run every verb — including those that make bytes runnable, widen a standing power, or delete — on first call with identity pins, journal-first receipts, and at-most-once execution; keep every deletion reversible through History or Recently deleted, restorable from Settings → Recently deleted and `work-fold recently-deleted`.
- Declare deterministic cross-work-folder automations — a schedule, explicitly designated folder change, or settled Check or automation run driving fixed Chat, files, Check, and agent steps on a separate eight-slot automation scheduler with per-hop receipts and host-resolved placeholders; enablement is one receipted call, and nothing above work-folders runs an unattended conversation.
- Read the overview — the app-composed digest of running work, needs-you questions and due snoozes, and changes since each surface last looked — through `work-fold agent overview --json` and narration on demand, neither of which advances seen markers. The compact popover stays focused on the live conversation and capture.
- Share "pages your fold serves": one designated file or one reviewed hosted App Instance served live from the desktop at the person's `<name>.work-fold.com` address to link-scoped, read-only viewers — end-to-end encrypted with URL-fragment keys, rate- and byte-budgeted, snapshot caching an explicit labeled opt-in, and revocable desktop-first.

- Follow an explicit request across agent turns and delegated work. The
  [collaboration contract](collaboration-contract.md) provides durable questions,
  selected result envelopes, non-blocking waits and bounded continuations.
  Chats, the work-fold agent, Apps and the paired browser share the
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
- Make work-folder location, storage ownership, History coverage, and executable capability class easier to inspect at a glance.
- Add named-pack selection for Anthropic marketplace bundles instead of importing every discovered Skill in an archive.
- Extend the shipped personal act lane with Chat-scoped grants, confirmation and revocation ceremonies, and headless execution, if the surface ever outgrows the per-launch single-user token.
- Extend the shipped fold and bounded Automation triggers only through deliberate contracts for any new event source, handoff condition, or recovery behavior. Cross-work-folder coordination stays in the work-fold agent; work-folder Chats remain local to their own work.
- Add restricted-app remote subscriptions and arbitrary push adapters, finer web-runtime resource controls, and a verified work-folder-service registry backed by a trusted launcher, per-instance challenge, and process-generation lifecycle. Raw numeric loopback grants remain useful for development but do not prove which process owns a port.
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

The completed [App platform exploration](archive/app-platform-exploration.md) and its
Gate 1–4 memos preserve the rationale and rejected ambiguities behind the
accepted [App platform foundation](app-platform-foundation.md). Roadmap wording
must continue to distinguish accepted direction from shipped behavior.

## Decision test

Before adding a new top-level concept, ask:

1. Can it fit cleanly as work-folder content, a Chat, a Skill, or an Extension?
2. Is its scope obvious: personal, one work-folder, or one Chat?
3. Can a person understand what it can read, change, or execute?
4. Does it preserve normal folders and standard Pi compatibility?
5. Would it still make sense for non-coding computer work?

If those answers are unclear, the feature needs a sharper mental model before it needs another navigation item.


### September 2026 recovery and automation expansion

History refuses a restore that would overwrite or delete content its new safety checkpoint cannot capture. Protected metadata and nested registered work-folders remain outside parent recovery, and historical exclusion of a directory protects its descendants even after ignore rules change. Relinking a moved work-folder on the same computer relocates its existing machine-local recovery state before committing the new registration. The desktop shows an effect preview; desktop and CLI hold the same active-work reservation through restore. History is bounded local recovery, not a complete or external-writer-transactional backup.

An automation version-3 `files-changed` trigger observes one explicitly reviewed folder and file-type set. Stable edits coalesce after debounce, with a cooldown; enablement is one receipted call and every run is receipted. Observers start from a baseline and pause during any automation work, sleep, or shutdown; changes during those pauses are not replayed. This prevents automation-generated edits from looping. Complete handoffs use one automation's ordered steps (A's Chat → its output files → B's Chat or Check). See [Automations](automations.md).

Text Checks use the work-fold agent's configured model in a bounded review request containing only designated UTF-8 files, optional reference text, and reviewed criteria. They return quoted suggestions, cannot run tools or edit files, and become stale when any input changes. The model's assessment is judgment; the host verifies quotations and freshness. See [Checks](checks.md).


### 2026-09-25 information architecture amendment

Owner decisions, recorded here in dated form; the body of this document and
`AGENTS.md` carry them:

- The rail's **Add** button opens the **Skills & Extensions** popup directly.
  There is no Add menu, and "Agent tools" is no longer a rail or tab concept.
- The **Library** is retired from the desktop: no Library tab, no Add entry, no
  copy-to-work-folder control, no "Your Library". The CLI act-lane `library` family
  and its server routes stay unchanged for now as a compatibility contract,
  pending a deliberate removal in a later change. *(Removed 2026-10-10.)*
- The work-folder-owned **Apps** tab is retired. Installed work-folder apps still appear
  in their contributed rail region and open there. Per-app management — grants,
  connections, named automations and run history, local data, update review,
  removal, Worker requests, and the receipts of the app's model use — lives in
  **Settings → Apps**, which lists apps by work-folder. **Build with Worker** is
  gone; a person asks a Worker to build an app in a Chat.
- **Skills & Extensions** is a popup dialog like Settings and Keyboard
  shortcuts, pinned to the work-folder it was opened from. Its Installed view starts
  with an **Included with work-fold** strip holding exactly the five included
  tools (Chrome, Computer Control, Web, Documents, Service Connections), each
  with one status word (Ready, Setup needed, Unavailable, Not checked, Turned
  off; Chrome shows Connected or Not connected) and a **Set up** button only
  when a person can act. Below the strip, **Everywhere** and **This folder
  only** sit side by side and stack on narrow widths; rows open their details
  on click; the per-group Add buttons are gone. The Add dialog asks **Where
  should it live?** first with the same two-card chooser, then offers a Skill
  or pack (files) or a Pi package (source). The Discover details dialog shows
  the description, the where-chooser, what is inside (the Skills and Extensions
  found), one plain warning when the install can run code on the computer, and
  a collapsed **Technical details** section holding source, version and
  license, provenance, dependencies, and install scripts. Package review still
  discloses install scripts and Extensions before installation.
- **Settings → AI Models** chooses its scope with two large buttons — **This
  worker**, naming the work-folder, and **work-fold agent** — instead of radio
  circles; the model is a dropdown that shows the chosen model closed and opens
  with a search box and vendor headings (for OpenRouter, the vendor prefix of
  the model name), closing again on a choice.
- **Settings → Automations** collapses its limits under a **Limits**
  disclosure by default; they stay visible on demand and unchanged in meaning.
- With four or more tabs open, tabs narrow but keep their work-folder icon and a
  normal close button.

### 2026-10-11 window strip, agent panel, and Files sort

- The window's top strip carries two controls and no labels. Beside the
  window buttons, a sidebar toggle hides the navigation pane (Files, Chats,
  History) while the rail stays; every rail destination except **Add** and
  **Settings** brings the pane back. At the far right, the menu-bar mark
  opens the **work-fold agent** in a panel beside the work area. It is not a
  work-folder and not a tab: it has no files or History of its own, and it
  stays where it is when you switch work-folders. While it is open, icon-only
  **Chats** and **New Chat** sit beside the mark. The panel and the menu-bar
  popover are one component showing one conversation, including each turn's
  thinking and tool steps as they happen. The View menu toggles both
  (⌘B and ⌘J), and the panel keeps its width.
- Files has a sort control beside its search: Name, Date modified, Size, or
  Kind, with folders first; choosing the current option again reverses it.


### 2026-10-01 work-folders inside work-folders

A work-folder may be registered inside another, and the deepest containing work-folder
is its parent. The screen tells that story without new words: the work-folder
switcher indents nested work-folders under their parent; the header shows the
containing work-folders above the title as links back up (the nearest two, with
anything further folded into "…", which opens the switcher); Files stops at a
nested work-folder and shows it as its own row in its color, which opens that work-folder
instead of expanding. Right-clicking a plain folder in Files offers **Make a
work-folder** (with the menu-bar mark), which registers it as a nested work-folder in place: no files move,
and the click is that work-folder's registration act. A folder that holds a nested
work-folder is not offered Rename or Delete.
Parent writes, creates, uploads, and copies also stop at the registered
child's root. Deleting a managed parent work-folder requires removing its
nested registrations first, even when their Workers are idle. A pending
managed deletion refuses new nested registrations before any folder move.
History, Search, Checks, and automations already treated nested work-folders as
separately owned; the Files tree now agrees.

Typing `@` in a Chat or in the work-fold agent's box offers work-folder Workers
(nested work-folders first) and addresses each one named. One activity mark is
used everywhere: a soft pulse while a Worker runs, including runs no Chat tab
is showing, and a still green dot when its reply is waiting to be seen. A
parent work-folder's header shows that mark for the work-folders inside it. See
[the collaboration contract](collaboration-contract.md) for what each Worker
hears.

On 2026-10-02 the product copy renamed this concept **work-folder**, always
lowercase like "work-fold", while ordinary directories stay plain "folder".
On 2026-10-10 the code, CLI, and stored records took the same words
([the vocabulary glossary](../scripts/vocabulary/GLOSSARY.md)).

### Included tool readiness, 2026-10-02

The included tools show observed readiness separately from native loading.
Visible Skills & Extensions surfaces refresh cold host status automatically;
opening them never launches a helper or connects a server. Successful use can
supply readiness evidence. Older computer permission evidence remains visible
as Last Check Passed with its original timestamp, while bundled Documents proof
belongs to the running build. Service Connections says No Connections or
Configured and leaves actual health to each connection. A selected Chrome
profile reconnects automatically and does not need repeated Store setup.
Check observes; helper repair is a separate explicit setup operation and cannot
silently dispose idle Chats. The [extension contract](extension-foundation.md)
records observation ordering, freshness and cancellation boundaries.
