# Assistant capabilities

Workspace uses Pi's native capability system for full-trust Skills and Extensions and includes a separate restricted-app package lane for agent-created browser apps. This guide explains how Skills, Extensions, packages, scopes, and authorization fit the product without confusing them with the user-facing Library.

The rail's **Add** menu opens one Space-owned **Assistant tools** work tab. Its **Installed** view answers what is present, where it came from, which scope owns it, and whether Pi loaded it. Its **Discover** view searches first-party/reference sources and community Pi packages. Skills and Extensions remain distinct item types inside both views because their behavior and risk are different. Add also opens one persistent Library tab per Space, all backed by the same passive personal collection. Its explicit destination selector copies to any registered Space. Executable tools are never mixed into its tree or install path.

## Management visibility

`WorkspaceKernel` exposes a read-only, versioned projection of Pi's authoritative catalog so the renderer, installed CLI, and future scoped adapters see the same Skills, Extensions, tools, packages, prompts, themes, commands, project authorization, provenance, and diagnostics. It does not install or remove resources, activate inactive tools, or bypass registered-Space authorization.

```powershell
workspace capabilities list --space "Personal Space" --json
```

The CLI projection is intentionally compact and content-free. Capability writes continue through Pi's package/import operations and Workspace's trust and concurrency policies. See [Workspace management layer](management-layer.md) for the snapshot and protocol boundary.

## Library materials are not Pi resources

The word “resource” has two different possible meanings, so Workspace uses different product language:

| Kind | Examples | Behavior |
|---|---|---|
| **Library material** | A template, reference document, example, image, or reusable file | Passive personal content. It is copied explicitly into a Space and never becomes Chat context automatically. |
| **Pi resource** | A Skill, Extension, prompt template, theme, model/provider configuration, or context instruction | Configuration discovered by Pi. Some resources influence the Assistant or execute code and therefore have scope and trust implications. |

Internal APIs and storage may retain the name `resource` for compatibility. User-facing copy should say **Library** when it means reusable files and use the specific Pi term—**Skill**, **Extension**, prompt, or package—when it means Assistant configuration.

## Skills

A Skill is a reusable way of working. Its interoperable unit is an [Agent Skill](https://agentskills.io): a directory containing `SKILL.md` with `name` and `description` frontmatter. The directory can also contain relative `scripts/`, `references/`, `assets/`, templates, examples, or other supporting files. [Anthropic's public Skills repository](https://github.com/anthropics/skills) provides examples of that structure.

[Pi implements the Agent Skills standard](https://pi.dev/docs/latest/skills) with lenient validation: it warns about most violations and supports some layouts beyond the strict standard. Workspace relies on Pi for discovery and runtime behavior. Workspace's importer accepts:

- A standalone UTF-8 file named `SKILL.md` with a `name` in YAML frontmatter.
- A `.zip` or `.skill` archive containing one Skill.
- An archive containing multiple Skill directories, including the common `skills/<skill-name>/SKILL.md` layout.
- A compatible Anthropic-style plugin or marketplace bundle, from which Workspace imports only the discovered Skill directories.

The last case is deliberately **skill-compatible**, not full plugin compatibility. Workspace preserves each discovered Skill directory so its supporting scripts, references, and assets continue to resolve. It does not activate bundled hooks, agents, MCP servers, plugin commands, binaries, marketplace metadata, or Extensions merely because they share an archive with a Skill.

Anthropic marketplace archives may describe several named packs in `.claude-plugin/marketplace.json`. The current compatible importer discovers and imports Skill directories safely, but does not yet offer named-pack selection. This is a deliberate remaining lifecycle gap rather than a claim of full Claude plugin compatibility.

### Minimal Skill

Create a folder whose name matches the Skill name and add `SKILL.md`:

```text
meeting-notes/
├── SKILL.md
├── references/
└── assets/
```

```markdown
---
name: meeting-notes
description: Turn raw meeting notes into a clear summary with decisions and follow-ups. Use when the user asks to organize meeting notes.
---

# Meeting notes

Follow the workflow here. Read supporting files with paths relative to this Skill directory.
```

The description should say both what the Skill does and when it should be used. Pi places names and descriptions in its initial context, then loads the full instructions and supporting files on demand. Keep referenced paths relative so the entire directory remains portable.

The directory is the interoperable format. To use Workspace's importer, package that directory in `.zip` or `.skill`, or import a standalone file named `SKILL.md`. A standalone import requires a `name`; Pi reports other format diagnostics through its lenient validator.

Import safety checks reject absolute or traversing paths, symbolic links, more than 10,000 archive entries, archives larger than 100 MB, individual expanded files larger than 100 MB, and total expanded content larger than 500 MB. A standalone `SKILL.md` is limited to 2 MB. These checks reduce archive risk; they do not prove that imported scripts are safe. People should inspect an unfamiliar pack before installing it.

If a developer places a Skill directory into a standard Pi scope by another trusted mechanism, Workspace discovers it through Pi even though the desktop importer itself accepts files and archives rather than a raw directory picker.

## Extensions

A [Pi Extension](https://pi.dev/docs/latest/extensions) is executable code that can add tools, commands, providers, event behavior, or other runtime capabilities. Workspace uses Pi's normal extension loader and adapts supported extension UI requests—such as confirmation, selection, text/editor input, notifications, status and working messages, text widgets, title/editor updates, OAuth handoffs, clipboard actions, and external links—to desktop UI. Terminal-only custom components, custom headers/footers, custom editor components, and autocomplete providers are reported as unsupported rather than pretending their TUI can render in React.

Extensions are more powerful than Library materials and should be presented with their source, scope, load status, tools, commands, and diagnostics. Installing a native Pi Extension or registering a folder that already contains one is a full-user code-execution decision, not a content-import decision.

Pi's built-in tools remain available alongside loaded Extensions. Workspace does not replace them with a private tool registry.

### Declarative Extension surfaces

A loaded Extension may place a versioned `surface.json` manifest beside its entry point. For the model, the creation and lifecycle unit is the normal Pi package containing that Extension, its tools or connection logic, and the adjacent manifest. Workspace validates the static manifest and can contribute an app destination below the stable primary rail, a left-pane navigator, and Space-bound view tabs. The renderer owns every component; manifests cannot provide HTML, scripts, styles, React modules, event handlers, or direct renderer access. This is the **full-trust Pi Extension lane**.

Surface discovery follows Pi's loaded Extension catalog rather than scanning arbitrary files. Personal surfaces appear where their Personal Extension is loaded. This Space surfaces appear while their folder is registered and Pi loads the adjacent Extension. Invalid, oversized, linked, or unsupported manifests produce capability diagnostics and do not take down other Extensions. See [Extension surfaces](extension-surfaces.md) for the version 1 schema and limits.

The declarative surface does not reduce the trust level of its owning Extension. Extension code still runs with the current user's permissions and can make network requests. The UI must label these contributions as full-trust even though their visible blocks are host-rendered.

### Restricted app packages

Agent-created apps use a second package lane rather than pretending to be native Pi Extensions. A restricted package declares `agentApp` in `package.json` and a strict version-2 `agent-app.json` with a `sandboxed-web` HTML entry, an optional worker for Assistant actions and named automations, bounded host-tool schemas, exact network targets and auth modes, reviewed Space-file needs, and a required automation list that may be empty. Each automation names its handler, interval, catch-up and overlap policies, and an exact permission subset. The preflight rejects lifecycle scripts, binaries, native build metadata, `pi.extensions`, unsafe paths, links, excessive files, and oversized content. Dependency metadata may describe the toolchain used to produce the reviewed assets, but Workspace never installs dependencies or invokes npm. It copies the completed bytes into content-addressed application staging and revalidates the digest without importing JavaScript.

That parser feeds a machine-local reviewed-digest lifecycle and separate sandboxed Chromium hosts for visible UI and optional worker execution. A visible app gets an ephemeral `WebContentsView`, reviewed same-origin assets, CSP/direct-network denial, sender-bound IPC, and narrow context, tab, network, storage, storage-invalidation, and file bridges. The app occupies its Space rail navigator and may request normal persistent Space-owned tabs; Workspace derives every owner id and shell tab id. The normal proposal review and install decision appear in the owning Chat; Assistant tools manages installed apps, exact destination, Space-file, and reviewed notification grants, host-owned connections, each opt-in automation and its run history, local-data controls, removal, and the advanced local-install path. One machine-wide scheduler coordinates named jobs across Spaces with two execution slots, FIFO admission, same-job non-overlap, durable cadence, and bounded catch-up. Notifications use fixed reviewed copy and require an enabled automation, inclusion in that job's permission subset, and a current category grant. Installation and every authority remain separate. File and network grants can compose, so app code with both may send granted file content or other app data to a granted destination; the broker controls the route and bounds, not the meaning of the payload. Every launch revalidates the installed revision, intersects the job subset with current grants, and is serialized with authority-changing mutations. A Node child, worker, or `vm` is not the security boundary. Restricted packages must never declare `pi.extensions`, enter Pi's package manager, or be discovered through the loaded Extension catalog because Pi evaluates Extension factories during catalog loading. See [Restricted app authoring](restricted-app-authoring.md) for the package contract and [Restricted app runtime](restricted-app-runtime.md) for the security boundary.

## Scopes

| Product label | Pi scope | Typical location | Availability |
|---|---|---|---|
| **Personal** | User/global | The configured Pi agent directory, normally `~/.pi/agent` | Available across Spaces. |
| **This Space** | Project/local | `.pi/` inside the Space folder | Portable with that folder and authorized while it is registered as a Space. |

Personal Skills commonly live below `~/.pi/agent/skills`; personal Extensions below `~/.pi/agent/extensions`. Space-scoped equivalents live below `.pi/skills` and `.pi/extensions` in the Space. Pi also discovers global and project `.agents/skills` locations, packages, and paths added through settings. The Pi catalog is therefore the authority rather than a hard-coded directory scan in the renderer.

Personal scope is convenient for capabilities a person wants everywhere. This Space scope is appropriate when a capability belongs with one activity or should travel with that folder. Scope does not indicate safety: personal executable code still deserves inspection.

## Registered-Space authorization

Creating or registering a Space is Workspace's authorization to load project Skills, Extensions, packages, scripts, settings, and instructions from that exact folder. There is no second “Trust Space” prompt. The shared host authority derives from the Space registry and overrides Pi's independent project-trust decision only inside Workspace. Removing the Space revokes the Workspace authorization without rewriting Pi's trust store for other Pi clients.

This choice removes redundant ceremony; it does not certify the folder as safe. Existing native Pi Extension code can execute during the first catalog load, and `.pi` content can change later through local edits, source control, or a synchronization tool. Package installation review, restricted-app grants, external connections, provider credentials, and Chat attachments remain separate decisions.

Importing a Skill directly into **This Space** requires a registered Space. Importing it into **Personal** scope is an explicit global install action and does not write to the Space.

## Packages

[Pi packages](https://pi.dev/docs/latest/packages) are a distribution and lifecycle mechanism. A package source can provide one or more Skills, Extensions, prompts, themes, or related resources. Workspace delegates installation and discovery to Pi's package manager rather than defining another package format.

Supported Pi sources include npm packages, git sources, HTTPS sources, and local paths. Npm and git sources require their corresponding command-line tools on `PATH`; local paths and direct Skill imports do not. Packages can be personal or project-scoped.

In product language, lead with the outcome (“install this Skill” or “add this Extension”) and show package source, scope, resource types, load state, and diagnostics as provenance. A package can be mixed: installing an item presented as a Skill may also load Extensions, prompts, themes, dependencies, or install scripts. The review step must disclose that package boundary before installation. Do not add **Packages** as a peer to Space, Library, or Assistant tools unless the product model is deliberately revisited.

Workspace delegates package update and removal to Pi so its settings, installed paths, pinned references, and deduplication rules stay authoritative. Project package installation, update, and removal require a registered target Space. Capability mutations are rejected while an affected Space has an active Assistant turn or Chat compaction; switching tabs or minimizing the app must not let a catalog reload terminate background work.

Direct Skill imports and packages have different ownership semantics. Package-provided resources can be updated or removed through their package record. Direct-imported Skills do not yet have an ownership receipt and safe removal workflow; that remains separate follow-up work. Per-resource enable/disable and Pi package filters are likewise future controls, even though the catalog already distinguishes active tools from tools that are merely available.

## Discovery sources

The Discover view combines sources without pretending they have one trust level:

- official Pi documentation and maintained first-party/reference repositories;
- the public Pi Skills examples;
- compatible Skills from Anthropic's public repository; and
- npm packages that opt into discovery with the `pi-package` keyword.

Results expose their source and link back to it. Search, type filters, and sorting by first-party/reference status, downloads, recency, or name help navigation. “Official,” download counts, and recency are provenance or popularity signals—not signatures, malware scans, or endorsements. Every third-party package still requires source review, especially when it includes Extensions or lifecycle scripts.

## Authentication and external connections

Model-provider credentials belong to **Settings → Assistant** and application/Pi storage, never to a Space or Library. The desktop path supports API-key setup and exposes Pi's provider OAuth flows when a provider advertises one. Workspace opens the provider URL in the system browser, handles device-code and manual-code prompts in native desktop UI, and persists the result through its existing encrypted Pi AuthStorage host. Support must still be described provider by provider: the presence of a Pi OAuth implementation is not proof that every account tier, billing policy, or packaged release flow has been verified. Restricted-app connections, including an app's OAuth setup, instead live with that app in **Assistant tools**.

Restricted-app connection credentials use a separate encrypted namespace and host-owned setup UI; they do not reuse model-provider AuthStorage or pass secrets through app JavaScript. Public HTTPS targets can declare `none`, API key, bearer, basic, or OAuth 2 PKCE. PKCE accepts only a public issuer, a supplied client id for a provider registration that supports public clients without a client secret, and non-OIDC scopes; Workspace owns discovery, the system-browser callback, encrypted tokens, and refresh. It does not accept a client secret, device-code flow, or package-supplied endpoints. Credential replacement, **Disconnect**, app update, and app removal invalidate the OAuth binding generation so an in-flight browser connection or token refresh cannot restore a deleted local token. Revoking destination access leaves its separately stored connection in place; **Disconnect** deletes the local record but does not revoke or rotate the credential at its provider. Numeric `127.0.0.1` and `::1` targets are a separate anonymous-only permission with no DNS, redirects, or saved credentials; Workspace does not yet verify which process owns the port. The broker derives app and Space identity from the sandbox's sender, injects authorization, strips sensitive headers, and enforces target, method, redirect, size, and time bounds.

For app creation, Pi receives one host-owned `propose_space_app` tool rather than another loaded Extension. The model supplies only the completed package's Space-relative folder. Workspace derives the review and digest, persists the owning Space/Chat receipt, and returns a review-only result. Installation, destination grants, and connection setup remain later human actions; proposal data never carries a credential.

Likewise, an Extension can implement an external connection, but that does not make the core app a native integration with that service. Google Drive currently works by registering a folder synchronized through Google Drive for desktop. Direct Drive API synchronization remains future provider-adapter work.

## Capability checklist

For every new Assistant capability, keep these answers visible in code and UI:

1. What will the Assistant gain: instructions, files, tools, commands, or network access?
2. Where did it come from?
3. Is it Personal or This Space?
4. Is it a full-trust Pi Extension or a restricted app package?
5. Which Space, network destinations, file roots, notification categories, actions, connections, and named automations are granted?
6. Is it loaded, staged, disabled, or failing diagnostics?
7. How can the person update, disable, remove, or revoke it?

The current Pi catalog and import/install surfaces expose provenance, scope, status, diagnostics, and package update/removal. Fine-grained permissions and per-resource enable/disable for full-trust Pi resources, direct-import receipts/removal, and named Anthropic-pack selection remain lifecycle work to complete. Restricted Space apps already have their separate per-destination, file, notification, connection, and per-automation authority model.

Management adapters must preserve that checklist. Inventory is not authorization: seeing a capability through the kernel or CLI does not grant it to a Chat or permit another actor to mutate it.
