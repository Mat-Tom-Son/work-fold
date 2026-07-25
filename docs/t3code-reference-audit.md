# T3 Code reference audit

This audit records ideas worth adapting from [pingdotgg/t3code](https://github.com/pingdotgg/t3code) without turning Workspace into a coding-only shell or replacing its native Pi runtime.

## Reference snapshot

- Repository: `pingdotgg/t3code`
- Reviewed commit: [`5719e8ac`](https://github.com/pingdotgg/t3code/tree/5719e8ac4020dda0e375ef61d044b61f55a0df8a)
- Reviewed: July 25, 2026
- License: MIT
- Local reference clone: platform cache under `Workspace/reference-repos/pingdotgg/t3code`; it is not a Workspace dependency or vendored source

The implementation in Workspace should adapt product patterns to existing Pi and Workspace contracts. Do not import T3's provider SDK adapters, generated protocol bindings, service deployment, mobile clients, or source-control-specific UI as hidden dependencies.

## What T3 does especially well

T3's advantage is less about having a unique agent primitive and more about exposing runtime behavior as a coherent workbench:

- Chat makes model choice, provider health, context pressure, commands, Skills, plans, pending interactions, changed files, and runtime activity visible.
- Threads have lifecycle beyond “open”: archive, snooze, settled state, grouping, sorting, and fast navigation.
- Long-running work has explicit runtime modes, queueing behavior, durable receipts, quiescence, diagnostics, and reconnect behavior.
- Coding workflows compose terminals, diffs, source control, worktrees, pull requests, and browser previews around the thread.
- Provider runtimes sit behind driver contracts instead of leaking one provider's wire protocol across the product.
- Keybindings are commands with context predicates rather than scattered event handlers.

Useful implementation references include T3's [context-window meter](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/components/chat/ContextWindowMeter.tsx), [composer command menu](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/components/chat/ComposerCommandMenu.tsx), [plan sidebar](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/components/PlanSidebar.tsx), [provider status banner](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/components/chat/ProviderStatusBanner.tsx), [snooze rules](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/components/Sidebar.snooze.ts), and [keybinding engine](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/shared/src/keybindings.ts).

## Workspace already covers these areas

Avoid rebuilding features that Workspace already has in a form better aligned with its product:

- Space-bound tabs and background Chat continuity
- portable Chat logs inside ordinary Space folders
- draft persistence, cross-Space Chat search, copyable messages, activity streaming, retry reporting, abort, and manual compaction
- explicit file attachments with extraction provenance and token-budget previews
- Files, Library, and content-addressed History rather than a Git-only file model
- native Pi Skills, Extensions, packages, commands, tools, and project resources
- capability provenance, scopes, diagnostics, install/update/removal, and registered-Space authorization
- restricted apps with reviewed packages, sandboxed hosts, narrow brokers, grants, connections, local data, automations, and durable run receipts
- a shared `WorkspaceKernel` and read-only installed management CLI

## Ranked adaptations

| Priority | Adaptation | Why it fits Workspace | Cost | Decision |
| --- | --- | --- | --- | --- |
| 1 | Composer command and Skill discovery | Pi already exposes the authoritative command catalog, but Chat did not make it discoverable. This improves every kind of work, not only code. | Small | Implemented |
| 1 | Model and context visibility | Pi already reports the active model, current context estimate, window, processed tokens, and cost. Showing context pressure explains compaction and attachment tradeoffs. | Small | Context visibility implemented; direct model picker next |
| 2 | Chat archive and snooze | Chats need a lightweight “not now” lifecycle as their number grows. It is broadly useful and does not imply task/project management. | Medium | Implemented with portable append-only lifecycle events, automatic resurfacing, undo, and background attention state |
| 2 | First-class plans | Render structured plan updates as a collapsible Chat companion with status, copy, and save-to-Space actions. Preserve the transcript as the durable record. | Medium | Next after a provider-neutral Pi event contract |
| 2 | Provider health in Chat | Surface unavailable, unauthenticated, rate-limited, or degraded provider state beside the affected Chat with an actionable route to Settings. | Medium | Next |
| 3 | Interaction inbox | Consolidate pending confirmation, selection, text input, restricted-app review, and other Assistant questions so tab switches do not hide required attention. | Medium | Design with background continuity |
| 3 | Command-oriented keybindings | Route shortcuts through named commands and simple context predicates. This will make customization safer than binding directly to components. | Medium | Adopt incrementally |
| 3 | Runtime receipts and quiescence | T3's command receipts and “settled” model are useful inspiration for strengthening `WorkspaceKernel` task completion and future authenticated mutations. | Large | Adapt semantics, not architecture wholesale |
| 4 | Remote/mobile continuation | Valuable only after local task authority, reconnection, and credential boundaries have a complete remote threat model. | Very large | Defer |

## Coding-oriented features: use extension lanes

T3's terminal splits, worktrees, diff review, pull-request integrations, and embedded browser preview are strong features for a coding product. They should not become primary Workspace chrome.

When demand is proven:

- terminal or source-control power belongs in a full-trust Pi Extension surface;
- a constrained preview or workflow dashboard can be a restricted Space app when its permissions fit that runtime;
- GitHub, GitLab, Bitbucket, and Azure DevOps account connections should be explicit app/Extension connections, not ambient Chat context;
- Files, Chats, Library, and History must remain equally useful for non-code Spaces.

## Architecture guidance

Keep Pi as Workspace's provider-neutral agent runtime. T3's multiple driver architecture is relevant only if Workspace deliberately supports a second native runtime with different session, tool, permission, and persistence semantics. A compatibility shim that pretends Claude Code and Pi have identical events would create brittle behavior.

The parts worth carrying into Workspace's architecture are narrower:

1. Every accepted long-running command gets a stable receipt.
2. UI projections distinguish accepted, running, waiting for input, settled, failed, and cancelled.
3. Reconnection begins from a snapshot and then applies ordered events.
4. Provider health is modeled data, not inferred from toast strings.
5. Commands and keybindings name product actions instead of component functions.
6. Optional workbenches contribute surfaces without changing the stable rail.

## Implemented from this audit

Workspace now:

- loads Pi's authoritative command catalog in each Chat;
- opens a keyboard-navigable command and Skill menu by typing `/` or using the composer control;
- ranks Skills, prompts, Extensions, and built-ins without hard-coding installed capability names;
- exposes a read-only per-conversation runtime snapshot;
- shows the active model and estimated context-window pressure in the composer;
- distinguishes current context from total tokens processed across compacted history.

These changes use Workspace's existing Pi APIs and visual system; no T3 runtime code or generated provider bindings were copied.
