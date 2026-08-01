# Product model and roadmap

This document is the durable product brief for Workspace. It exists so design, implementation, and release decisions stay aligned as the app grows.

## Product promise

Workspace makes an ordinary folder understandable as a place for getting something done, then gives that place a capable Assistant.

Many people already have the right raw material—folders, files, cloud-synchronized directories, and repeatable ways of working—but do not think of a folder as an environment they can return to. A **Space** closes that gap. It adds a human mental model and an Assistant without turning the folder into a proprietary format.

Workspace is for general computer work. Coding is one valid use, not the organizing metaphor.

## The nouns

| Concept | User promise | Boundary |
|---|---|---|
| **Workspace** | The desktop product that brings places, conversations, materials, and an Assistant together. | It is not the name of each folder-backed activity. |
| **Space** | One understandable place for an activity, backed by an ordinary folder. | Registering a folder does not move or convert it. |
| **Files** | The ordinary folder contents visible for the selected Space. | Files are not a separate container or proprietary format. |
| **Chats** | Conversations grounded in the selected Space. | A chat does not automatically receive every file in the Space. |
| **Library** | Personal materials worth reusing across Spaces. | Items are passive and are copied explicitly; they are not prompt context. |
| **History** | Checkpoints and recoverable changes associated with a Space. | It should remain distinct from chat history. |
| **Assistant** | The Pi-powered helper. | Its provider and model are configured in Settings, independently from Space content. |
| **Assistant tools** | One on-demand work tab to discover and manage what the Assistant can do. | It groups Skills, Extensions, and Space-app management without making executable tools look like passive Library materials. |
| **Skill** | A reusable way of working that helps the Assistant approach a task. | A Skill may contain executable scripts and is not merely a document. |
| **Extension** | An executable capability or connection available to the Assistant. | It has a stronger trust implication than a Library item. |
| **App Project** | An optional build-and-publication identity declared for one Space. | Its 0.4 presentation and identity are machine-local application state, not another portable file or cloud ownership record. |
| **Feature** | One stable reviewed contribution to an App Project. | A Feature id names a slot; only an exact reviewed revision identifies executable bytes. |
| **Release** | An immutable content-addressed snapshot of reviewed Features and App presentation. | Preparing, publishing, and installing it are separate local acts; a display version is not executable identity. |
| **App Instance** | One published Release installed into a chosen Space with its own runtime, data, grants, connections, jobs, and receipts. | It is distinct from the source-bound Development preview and does not live in or own the Space folder. |

The Space-identity header menu chooses the active root-folder entity and provides compact actions to register, create, or manage Spaces. The stable primary navigation then follows these everyday surface nouns:

- **Files**
- **Chats**
- **History**

The bottom-rail **Add** action opens a short menu for Library materials, Skills and Extensions, or building an app. Library opens as one persistent tab per Space without turning the passive personal collection into Space content; all of those tabs read the same collection. The owning Space is the default copy target, while a destination selector can explicitly send an independent copy to any registered Space. Skills, Extensions, packages, core tools, and installed-app authority are managed in a separate Space-owned **Assistant tools** work tab so infrequent administration does not occupy a permanent rail destination or get compressed into the navigator. The Assistant's model provider, model, API key, and supported provider OAuth connection live in **Settings → Assistant**. A restricted Space app's connection is a different, app-scoped object managed with that app in **Assistant tools**.

Each open tab belongs to one Space. Selecting a tab takes the user back to that Space and its identity; selecting a Space restores its most recent tab. A Chat that is working remains alive when another tab is selected, when Workspace is minimized, when the Windows window is hidden to the tray, and when the last macOS window is closed and later recreated from the Dock.

Chats have a lightweight lifecycle for keeping a growing conversation list usable. **Active** is current work, **Snoozed** is deferred until a future local time, and **Archived** is retained reference material. A due snooze resurfaces automatically in Active. The selected Space's Chats remain the primary list; matching Chats from other Spaces appear below as compact, collapsed groups with aggregate activity visible, and search may expand those groups to expose results. Snoozing or archiving a Chat closes its open tab but never deletes or rewrites its transcript; the state is an append-only lifecycle event in that Chat's portable `.workspace/conversations/` log. A snoozed or archived Chat may be opened for reading, but it must be resumed or restored before another message can be sent. Lifecycle changes are unavailable while its Assistant turn or compaction is active.

A new Chat begins with a temporary **New Chat** label. After its first successful
turn, Workspace persists a generated title based on the first user request so
the title remains stable across tabs, restarts, and machines. An explicit
person-authored rename always wins, including an intentional rename to
**New Chat**. Title and lifecycle summaries may be cached in machine-local
application state, but those caches are disposable and versioned independently
from the portable append-only transcript.

Background state is quieter and machine-local: a small running marker follows an accepted Assistant turn across the Chat navigator and tab strip, and becomes an attention marker only when the turn settles out of view. Viewing the Chat clears that marker. This acknowledgement state is an app preference on the current computer, not portable conversation content.

The configured provider and model remain visible in the Chat composer before the first message is sent. Transient provider failures use Pi's bounded retry path, which removes only the failed assistant attempt and continues from completed tool results instead of replaying them. If that retry budget is exhausted, Workspace appends the latest partial response and completed activity to the portable Chat transcript with an interruption marker. The same Pi session remains available so the next user message can continue from the surviving work.

## A Space is a view of a folder, not a new file format

There are two honest ways to create a Space:

1. **Create a Space:** Workspace creates a normal folder under its managed local content location.
2. **Turn an existing folder into a Space:** Workspace registers the folder in place.

Both routes should lead to the same product experience. Registration must not move, duplicate, or rename user files. Workspace adds one intentionally narrow, hidden metadata layer: `.workspace/space.json` preserves the Space identity when its folder moves, and `.workspace/conversations/` keeps that Space's Chats with it. The Files and History surfaces hide this directory. Provider credentials, the Space registry, History objects, Pi sessions, ignore rules, and other machine-specific app state remain in application storage. Portable executable Pi configuration remains separate under `.pi/`. Creating or registering the Space is the user's authorization for Workspace to load that local configuration; removing the Space revokes that authorization.

A Space may also have a personal visual identity: accent colors, a compact banner, and a Fluent icon. Those preferences help distinguish Spaces inside Workspace, but they currently remain application state on this computer. The versioned `space.json` schema can grow deliberately if portable appearance is introduced later; current code must not smuggle machine-specific state into it.

The same portability rule applies to the 0.4 App Project declaration. Its
`projectId`, source-Space binding, title, description, and icon live in Workspace
application data. A Release captures an immutable presentation snapshot, but
Workspace does not create `.workspace/app-project.json` or imply that copying a
folder transfers Project ownership. Portable Project metadata, import, and
collision handling require a later explicit design.

The user should always be able to reveal a Space in the operating system, open its files with other applications, back it up normally, or synchronize it with a desktop sync tool. A Google Drive for desktop folder works because it is a local folder; that is not the same as direct Google Drive API integration.

## Context is explicit

Registering a folder is also the host authorization for its existing local Pi configuration. Assistant context, new package installation, restricted-app permissions, and external connections remain separate states:

| Action | What changes | What does not happen implicitly |
|---|---|---|
| Register a folder as a Space | The folder appears in Workspace and its local Pi configuration may load. | Files are not uploaded or converted, and local code is not certified as safe. |
| Add a Library item to a Space | An independent copy is written under `From Library`. | The original is not changed and the copy is not attached to a chat. |
| Attach a file to a Chat | That file is made available to the conversation. | Other Space files are not included automatically. |
| Install a personal Skill or Extension | It becomes available through the user's Pi scope. | It is not copied into every Space. |
| Ask the Assistant to build a Space app | The Assistant may write an ordinary restricted-app package and ask Workspace to inspect it for review. | A proposal does not execute or install code, grant network access, or store a credential. |
| Add a reviewed Space app | The exact reviewed digest becomes a Local preview in that Space's Development Instance. | It is not a Release or App Instance; network destinations, Space files, notification categories, saved connections, and every named automation remain off. |
| Declare an App Project | Workspace records an explicit machine-local title, description, icon, Project identity, and source-Space binding. | No file is added to `.workspace/`, no account or cloud Project is created, and source is not uploaded. |
| Prepare a Release | Workspace snapshots every current reviewed Development preview into one verified, immutable, content-addressed v2 Release and records a prepared state. | It is not yet eligible to install, and later source edits cannot alter its bytes. |
| Publish a prepared Release | Workspace rechecks that the reviewed previews are still exact, then records a separate local publication receipt. | Nothing is uploaded, signed, listed, hosted, granted, or installed. |
| Delete an unused Release | Workspace removes its machine-local lifecycle record, then safely prunes the unreferenced immutable object. | A Release required by an active App Instance, either side of a prepared install/update/rollback, or retained data cannot be deleted. Project source and App data are not removed. |
| Prepare and activate an App install | Workspace durably allocates one new App Instance and its Feature/Data identities, then installs the exact published Release into the chosen registered Space. | It does not convert the Development Instance or carry preview grants, connections, jobs, or data forward. All powers start disabled. |
| Prepare and activate an update or rollback | Workspace records a deterministic plan, rechecks it at activation, fences the old runtime, and atomically changes the active Release and authority. | A friendly version cannot override digest identity. Only exact unchanged content is eligible for continuity; schema/migration execution is not supported locally. |
| Uninstall an App Instance | Workspace fences the whole release-backed runtime and requires an explicit retain-or-purge choice for local data. | Project source and separately selected Space files are never deleted. Retained namespaces do not remain runnable and require a later explicit purge. |
| Allow one app destination, file root, or notification category | That exact reviewed declaration becomes usable by the installed digest. | Other declarations, saved connections, automations, and other Spaces receive no authority. |
| Save or remove an app connection | Workspace adds or deletes one operating-system-encrypted binding for the host-derived Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, target, and current Runtime Instance owner. | Destination access is not implicitly granted, and deleting the local record does not revoke the credential at its provider. Principal-owned connections remain a future portable-runtime journey, not a current local UI. |
| Enable one app automation | Workspace may run that reviewed named job on its bounded schedule while Workspace is running. | Other jobs stay off, and this run receives only the intersection of current grants and its reviewed permission subset. |
| Run an app automation now | Workspace runs that named job once and records a durable receipt, even if its schedule is off. | It does not enable or shift the schedule; a disabled job has no notification authority. |

This separation is a core product rail. “Available,” “in this Space,” “in this chat,” and “allowed to execute” must never collapse into one invisible state.

## Assistant model

Workspace hosts Pi instead of recreating an agent framework. Pi owns model/provider behavior, built-in tools, standard resource discovery, packages, Skills, Extensions, and project trust mechanics. Workspace supplies the desktop experience: setup, catalog surfaces, secure credential persistence, folder selection, the registered-Space authorization override, extension UI bridges, and clear execution/permission explanations.

There are two capability scopes:

- **Personal:** available across Spaces from the user's Pi agent directory.
- **This Space:** portable configuration stored under the Space's `.pi/` directory and authorized while the folder is registered as a Space.

The **Assistant tools** work tab unifies discovery and management without erasing the distinctions that matter. It identifies whether an item is a Skill or Extension, Personal or This Space, active or merely available, direct-imported or package-provided, and healthy or diagnostic-failing. Installed items can be searched, filtered by type and scope, and sorted by name, type, scope, or source. Discover results can be searched, filtered, and sorted by first-party/reference status, downloads, recency, or name.

Packages can distribute Skills, Extensions, prompts, themes, and related Pi resources. They remain installation and lifecycle plumbing; the primary UI should describe the capability a person is gaining, show inspected resource types and lifecycle scripts when registry metadata is available, and label unavailable details as unknown rather than absent. A package that includes Extensions or install scripts is a code-execution decision and must not be presented as a harmless Skill-only import. See [Assistant capabilities](assistant-capabilities.md) for the complete compatibility and safety model.

Workspace has two deliberately different executable lanes inside the broader Extension product concept:

| Lane | Trust and distribution | UI and authority |
|---|---|---|
| Native Pi Extension | Standard Pi package/resource locations; full current-user execution after Personal install or Space registration. | May add Pi tools, commands, providers, events, and a static host-rendered `surface.json` contribution. Its code owns its network and operating-system access. |
| Restricted Space app | A complete, Space-local reviewed-web package proposed by the Assistant or selected through advanced local preview. It never enters Pi's package manager or loaded catalog. | Runs reviewed UI and worker code in separate sandboxed Electron hosts. Tabs, network, storage, files, connections, notifications, and named automations exist only through narrow host contracts. |

The model experiences either lane as a package-shaped capability, but the product must not flatten their execution boundaries. Native Pi compatibility remains the full-trust ecosystem lane; restricted apps are the flexible app canvas for generated inboxes, dashboards, extractors, project-service panels, and other Space-specific tools. See [Restricted app authoring](restricted-app-authoring.md) and [Restricted app runtime](restricted-app-runtime.md).

## Apps without turning every Space into an App

Workspace is growing from a local Space tool into a local-first App studio and
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
tab reached from Assistant tools, not a fifth top-level rail destination.

## Management layer

Workspace also needs a semantic layer above its individual screens so the same product can be understood by the renderer, command line, scripts, Pi, and eventually a higher-level Assistant. `WorkspaceKernel` is that shared in-process read authority. It resolves actor context to the most-specific Space, exposes versioned snapshots of registered Spaces and running Assistant work, and projects Pi's authoritative capability catalog without creating another registry.

The installed `workspace` command is the first adapter over that layer. Its read lane reports context, Spaces, active Assistant turns and compactions, and available Skills, Extensions, tools, packages, prompts, themes, and commands in human or stable JSON form, and stays deliberately content-free. A separately versioned act lane — authenticated per app launch and recorded with durable receipts — additionally lets a shell-capable agent create or register Spaces, copy outside material into a Space with a History restore point, and start, continue, await, or abort Space Chats while the app is running. Act commands reuse the same trust, conflict, History, and task rules as the desktop surfaces; they do not touch capabilities, tabs, panes, or application settings.

The **management conversation** is the first in-product consumer of that layer: one conversation scope that sits above all Spaces. It runs on the same Pi runtime and turn orchestration as Space Chats but is deliberately not a Space — its transcript is machine-local application state (it describes this computer's Space registry, which is itself machine-local), and its Pi session loads personal-scope capabilities plus two app-materialized management instructions (an `AGENTS.md` context file and the `manage-workspaces` Skill). It is a full-trust Assistant, taught rather than caged: it keeps ordinary local tools like every Workspace Assistant, and the instructions teach it to prefer the `workspace` read and act commands — which carry trust, restore points, receipts, and conflict rules — for anything that touches Spaces. It is reached today through `workspace manage …` with a default single conversation (`--new` permits additional threads as an explicit act). Giving it a visible desktop or web surface is a separate, deliberate decision: any management tab must amend the Space-bound tab contract explicitly instead of silently inheriting it.

This is infrastructure over the existing nouns, not a new user-facing concept. A future cross-Space Assistant and controlled Space runtimes should build on the same typed actor, scope, task, and capability contracts instead of scraping renderer state or bypassing domain policy. See [Workspace management layer](management-layer.md) for the exact contract and security boundary.

## Product rails

When a design is ambiguous, prefer the option that best preserves these properties:

1. **Local first:** core work does not require an account or cloud service.
2. **Ordinary files:** user content stays portable and directly accessible.
3. **Clear language:** expose the Space mental model before filesystem or package-manager jargon.
4. **Explicit context:** people can tell what the Assistant can see in the current chat.
5. **Layered authorization:** Space registration authorizes local Pi configuration; package installation, restricted-app permissions, connections, and Chat context stay explicit and separately revocable.
6. **Pi compatibility:** use standard Pi behavior and formats instead of parallel Workspace-only systems.
7. **Capability transparency:** show source, scope, status, and diagnostics for executable additions.
8. **Provider neutrality:** cloud and model integrations should use replaceable adapters rather than shape the core model.

## Roadmap and known gaps

### Foundation now

- Create a folder-backed Space or register an existing folder without conversion.
- Rename a Space, remove a linked-folder registration without deleting its files, or delete a managed Space with an explicit destructive warning.
- Browse and upload Space files, run Space-scoped Chats, use the Library, and view History.
- Search a Space by content as well as by name: matches inside ordinary files and inside Chat transcripts, honouring the Space's ignore rules, skipping binary and oversized files, and disclosing when a bound stopped the search rather than implying a complete answer.
- Restore content-addressed History checkpoints created around file mutations and Assistant turns.
- Configure a Pi provider/model with an API key or an advertised Pi provider OAuth flow and use Pi's built-in tools.
- Discover installed Skills, prompts, Extension commands, and supported built-ins from the Chat composer, and inspect the active model and context-window pressure during a conversation.
- Show the configured provider/model before a Chat's first send, safely retry transient provider stream failures from completed tool results, and preserve terminal partial output and activity as a resumable interruption in the portable transcript.
- Discover and search Personal and registered-Space Skills and Extensions in one Assistant tools work tab, with accurate source, scope, load state, and diagnostics.
- Browse curated first-party/reference Skills and Extensions alongside community Pi packages, with type filters and explicit provenance.
- Import standard Skills and compatible skill bundles while preserving their supporting files.
- Install, update, and remove Pi packages at Personal or registered-Space scope.
- Customize each Space with semantic light/dark accent roles, a compact banner, paired colours, and a searchable Fluent icon catalog without changing its folder; machine-local service storage, dual previews, contrast auditing, undo/reset, and inert proposal import/export keep the same typed contract available to people, Codex, and Claude Code.
- Inspect Space context, registered Spaces, active Assistant/compaction tasks, and Pi capabilities through one versioned `WorkspaceKernel` and the installed `workspace` CLI's content-free read lane.
- Operate the product from any shell-capable agent through the CLI's per-launch-authenticated act lane while the app is running: create or register Spaces, copy outside material into a Space with a History restore point, and start, continue, await, or abort Space Chats — every action journaled before it runs and every CLI-initiated turn tracked as a kernel task with a task-scoped outcome.
- Talk to the management conversation above all Spaces through `workspace manage send|status|result|wait|abort|list`: the same Assistant runtime with personal capabilities plus Workspace's two app-owned management resources, a machine-local transcript, default single-conversation behavior, and task-scoped outcomes.
- Drop native OS files onto any Chat composer to upload them into that Space's dated `Dropped/` folder and attach them as context in one explicit act; uploads and Library copy-ins record additive History restore points.
- Drive one real Pi turn through the local API with the harness-neutral `workspace:drive` test driver.
- Render validated declarative `surface.json` contributions from loaded Pi Extensions as a contributed rail destination, left-pane navigator, and Space-bound view tabs without injecting Extension code into the renderer.
- Let the Assistant submit a completed, Space-relative restricted-app package through a host-owned proposal tool. Workspace persists a Space-and-Chat-bound, digest-pinned review without evaluating JavaScript; only a later human approval installs it, with network, Space-file, and notification access off, no saved connection, and every automation disabled.
- Give each installed Space app arbitrary reviewed web UI in a sandboxed rail navigator and host-derived persistent Space-owned right tabs, plus optional bounded Assistant actions and named automations in a separate worker sandbox. A machine-wide scheduler shared across Spaces provides two execution slots, FIFO admission, same-job non-overlap, durable cadence, bounded catch-up, and run receipts. Assistant tools manages each job independently alongside exact network/file/notification grants, host-owned encrypted connections, local data, reviewed updates, removal, and the secondary advanced local-package path.
- Provide bounded host-owned JSON storage with active-visible-view invalidation hints, History-covered Space-file grants, exact public-HTTPS or numeric-loopback requests, API-key/bearer/basic/OAuth PKCE connection adapters, and static reviewed system notifications from enabled automation runs.
- Carry host-owned local App Project, Development Instance, Feature Installation,
  Data Namespace, canonical Feature Revision, and seven-domain authority identity
  through the restricted-app UI. The first approved Space-app preview may
  establish the Space's machine-local App Project/Development Instance scaffold;
  App Studio exposes its explicit presentation and lifecycle.
- Produce portable, authority-captured receipts for new local automation runs;
  schema-2 receipts survive migration only as explicitly legacy-unverified
  lineage. Post-update and uninstall cleanup is a durable, restart-retried
  outbox, so stale secret/data bytes never regain live authority after partial
  cleanup failure.
- Provide canonical declaration/artifact conformance and a durable local App
  Studio: immutable v2 Release assembly and verification; a content-addressed
  Release store; separate prepared and published states; persisted
  install/update operations; release-backed App Instance
  install/update/rollback; and explicit uninstall retain/purge plus later purge.
- Attach each local App Instance to one chosen registered Space while keeping its
  bytes, data, grants, connections, schedules, journals, and receipts in
  Workspace application data. Enforce one instance per `(projectId, target
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
- Build a Windows installer and deliver updates through GitHub Releases.
- Build, Developer ID-sign, notarize, and publish macOS arm64 app, DMG, ZIP, blockmap, and update metadata from the same source version as Windows, with a verified installed two-version updater lane.

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
- Add per-resource enable/disable and package filtering controls without confusing availability with activation.
- Add receipts and safe removal for directly imported Skills, independently from package lifecycle.
- Add named-pack selection for Anthropic marketplace bundles instead of importing every discovered Skill in an archive.
- Extend the Chat's current attachment, command, Skill, model, and context visibility into a complete “what this Chat can see and use” inspector.
- Extend the shipped personal act lane with Chat-scoped grants, confirmation and revocation ceremonies, and headless execution, if the surface ever outgrows the per-launch single-user token.
- Add event subscriptions and a scoped cross-Space Assistant that can manage the product only through those authorized contracts.
- Add restricted-app remote subscriptions and arbitrary push adapters, finer web-runtime resource controls, and a verified Space-service registry backed by a trusted launcher, per-instance challenge, and process-generation lifecycle. Raw numeric loopback grants remain useful for development but do not prove which process owns a port.
- Strengthen onboarding, keyboard/accessibility behavior, renderer interaction tests, recovery, export, and diagnostics.

### Later adapters and distribution maturity

- Prove one private hosted-web App Instance end to end—publish, deploy, explicit
  destination and connection grant, named automation and receipt, update, and
  revocation—before public discovery, an App Store, or generalized sync.
- Verify and document supported provider OAuth flows account tier by account tier in packaged desktop releases; do not turn Pi's generic OAuth hook support into a blanket compatibility claim.
- Add direct cloud-storage integrations behind a provider-neutral model with stable remote IDs, offline behavior, explicit conflicts, and no surprise deletion.
- Move from personal or unsigned Windows artifacts to a publicly trusted code-signing identity.
- Consider additional Windows architectures after the x64 release lane is stable.

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
