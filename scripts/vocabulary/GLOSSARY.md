# work-fold vocabulary migration (2026-10-10)

The desktop interface is the source of truth for product names. Code,
HTTP routes, CLI verbs and flags, JSON keys, storage paths, and schemas follow
it. This file records each decision the codemod in this folder applies.

| Interface | Code (camel / Pascal) | Kebab (routes, CLI, files, CSS) | Replaces |
|---|---|---|---|
| work-folder | `workFolder`, `WorkFolder` | `work-folder` | Space, `space` |
| Worker | `worker`, `Worker` | `worker` | Space Assistant, product-sense `assistant` |
| work-fold agent | `workFoldAgent`, `WorkFoldAgent` | `work-fold-agent` (CLI verb `agent`) | management conversation, the fold, `manage` |
| Automation | `automation`, `Automation` | `automation` | routing |
| app automation | `appAutomation`, `AppAutomation` | `app-automation` | an app's declared named automations |
| Recently deleted | `recentlyDeleted`, `RecentlyDeleted` | `recently-deleted` | trash |
| overview | `overview`, `Overview` | `overview` | glance |
| Everywhere | `everywhere` | `everywhere` | the `personal` capability scope |

Not renamed, because they are not product vocabulary:

- The LLM message role `assistant` and everything that names the model's
  reply (`assistantText`, `assistant_delta`, `AssistantPresentation`,
  streaming-assistant state). These follow the model provider's protocol.
- Pi's own scopes (`global`, `project`), Pi types, and Pi directories.
- `work-fold` itself, and the plain word "folder" for an ordinary directory.
- CSS values and keyboard names that merely contain "space"
  (`white-space`, `space-between`, `userSpaceOnUse`, the `Space` key).
- Dated release notes and archived documents.

Rules for a case-preserving rename of one token:

- camelCase / PascalCase tokens map word by word (`spaceRoot` → `workFolderRoot`,
  `SpaceSummary` → `WorkFolderSummary`); UPPER_SNAKE maps to UPPER_SNAKE
  (`SPACE_ID` → `WORK_FOLDER_ID`); kebab, dotted, and lowercase file/route
  tokens map to kebab (`space-ignore.ts` → `work-folder-ignore.ts`,
  `spaces.list` → `work-folders.list`).
- `work-fold` + `management` → `work-fold` + `agent` (never `workFoldWorkFoldAgent`).
- An override table (`overrides.json`) lists every ambiguous token by hand;
  an entry mapping a token to itself means "keep".

Opaque identifiers keep their established prefix: a work-folder id is
`space-<16 hex>` (and a removal transaction `space-removal_<uuid>`, whose
claimed folder is `.space-removal-<uuid>`) because
that identity is written into every registered folder's portable
`.work-fold/` metadata, and a Recently deleted entry id stays
`trash-<timestamp>-<hex>` because entries name their own directories.
Machine-local Automation ids follow the new words (`automation-…`) and are
migrated in app state.

The folder that holds app-managed work-folders keeps its name (`spaces/` in
app state), as does the work-fold agent's working folder (`management/`), and
path-derived storage keys keep their old fallback segment: moving or
re-keying them would move user content and detach History, per-folder state,
and Pi chat sessions from existing folders. The paired-web wire operations
(`management.*`) and the restricted-app bridge API (`assistant.request`,
`assistant.infer`, `assistantActions`) also keep their names; "worker" already
means an app's background runtime there.

## Existing data

Two one-time migrations carry a profile from before 2026-10-10 forward:

- `src/local/vocabulary-migration.ts` runs at desktop and local-API startup.
  It renames the app-state stores whose names changed (for example
  `space-registry.json` → `work-folder-registry.json`, `routings/` →
  `automations/`, `trash/` → `recently-deleted/`), rewrites the JSON keys and
  enum values inside an allowlist of app-owned stores using
  `vocabulary-migration-tables.json` (generated from this codemod's report),
  and moves each registered folder's `.work-fold/space.json` to
  `.work-fold/work-folder.json`. It never rewrites a person's words, file
  paths, conversation logs, History objects, or deleted folders' contents,
  keeps every original under `vocabulary-migration-backup/`, and records
  `vocabulary-migration.json` so it runs once. A folder that arrives later
  from another machine is migrated when it is registered or read.
- `web-local/src/lib/storage-migration.ts` moves the renderer's saved tabs,
  unsent Chat drafts, and view preferences from `work-fold.space.*` to
  `work-fold.work-folder.*` keys.

The generated `manage-spaces` Skill in the work-fold agent's folder is
replaced by `manage-work-folders` on the next start.

## Re-running the codemod

`node scripts/vocabulary/rename.mjs` (code pass) and `--prose` (comments,
strings, and documents) are idempotent over already-migrated code. After a
pass, review: Electron's `frame.routingId` (an Electron API, not ours),
property names that became kebab strings in `Omit<>`/`in` checks, icon search
keywords, CLI parser phrases, and English uses of "space", "routing", and
"glance" that a word rule cannot tell apart.
