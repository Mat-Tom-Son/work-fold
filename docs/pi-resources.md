# Pi resource compatibility reference

Workspace exposes Pi resources directly instead of maintaining a parallel Assistant tool registry. In this document, “resource” is Pi's technical term for runtime-discovered configuration; it is distinct from the user-facing **Library** of reusable personal files.

Start with [Assistant capabilities](assistant-capabilities.md) for the product concepts, safety model, scopes, and package boundary. This page is the compact compatibility reference for implementation and verification.

The [Workspace management layer](management-layer.md) reports this same native catalog through versioned read snapshots and the installed `workspace capabilities list --json` command. That projection includes tools, packages, prompts, themes, commands, trust, scope, provenance, and diagnostics; it is not a second discovery path or an install/activation surface.

In the product navigation, **Capabilities** is the single Space-aware surface for Skills and Extensions. A Skill describes a reusable way of working; an Extension adds an executable capability or connection. Installed and Discover views retain the item type, source, scope, load state, diagnostics, and package lifecycle. Provider and model setup lives under **Settings → Assistant**.

## Extensions

Global extensions are discovered from the user's Pi agent directory. Pi project extensions are discovered from `.pi/extensions` inside a registered Space folder. Creating or registering the Space is Workspace's authorization to load that exact folder; removing it revokes the Workspace override. Extension commands, tools, providers, events, and resource discovery remain available through Pi's normal runtime.

The desktop preflight creates isolated global and project extensions and verifies that Pi loads both. It also verifies that Pi's built-in `read`, `bash`, `edit`, and `write` tools remain active.

## Skills

The base unit is an [Agent Skill](https://agentskills.io) directory containing `SKILL.md` and any relative `scripts/`, `references/`, `assets/`, templates, or examples it needs. Import must preserve the entire directory. Product copy describes a Skill as a reusable way of working; `SKILL.md` remains the interoperable technical format. Pi implements the standard with [lenient validation and documented discovery locations](https://pi.dev/docs/latest/skills).

Pi may discover a standard Skill directory placed in a configured resource location. The Workspace desktop importer accepts:

- A single `SKILL.md`.
- ZIP and `.skill` archives containing one skill.
- Bundles containing `skills/*/SKILL.md`.
- Compatible plugin or marketplace archives, importing only their skill components by default.

Hooks, MCP servers, agents, binaries, and other plugin features outside discovered skill directories are not imported. Archive extraction rejects path traversal, symlinks, excessive file counts, and unreasonable expanded sizes. Importing a personal Skill is an explicit install action and makes its preserved scripts available to Pi; project-scoped imports (shown as Space-scoped in the product) are allowed only for a registered Space.

Workspace's importer writes personal Skills under the configured Pi agent directory and Space-scoped Skills under `.pi/skills`. Pi may additionally discover standard `.agents/skills`, package, settings, and explicit resource locations; the native Pi catalog remains authoritative.

Pi packages remain the installation, update, and removal mechanism for full-trust npm, git, HTTPS, and local sources. Workspace surfaces Pi's diagnostics, scope, source, resource types, and load state rather than inventing a second full-trust format. Project-scoped mutations require the target to be a registered Space. Capability mutations are rejected while an affected Space has an active turn or Chat compaction so changing the catalog cannot terminate background work.

Packages are distribution plumbing, not a separate top-level user concept. The interface should describe what a person is installing—a Skill, Extension, or mixed capability package—while retaining package source and diagnostic details. The Discover catalog may combine first-party/reference sources with npm packages tagged `pi-package`; popularity and download counts are discovery signals, not security endorsements.

## Restricted Space apps are not Pi resources

A restricted app is package-shaped because the Assistant needs a portable set of completed web assets, but it is not a Pi package, Skill, Extension, or catalog item. Workspace inspects its `agent-app.json` and files without invoking npm or importing JavaScript, stages the exact reviewed digest in application data, and runs it only through the separate sandbox hosts. Its grants, encrypted connections, storage, background state, notifications, and lifecycle are managed in **Assistant tools → Installed → Apps in this Space** and are intentionally absent from `workspace capabilities list` protocol v1.

Use [Restricted app authoring](restricted-app-authoring.md) for the package and bridge contract and [Restricted app runtime](restricted-app-runtime.md) for the security boundary. Never add `pi.extensions` to a restricted package or route it through Pi's package manager merely to make it visible to the model; `propose_space_app` is the host-owned review path.

When adding a management consumer, query `WorkspaceKernel` or its adapter rather than scanning `.pi/`, `.agents/`, or package directories independently. Writes must continue through the owning Pi and Workspace domain operations so trust and active-turn protections remain in force.
