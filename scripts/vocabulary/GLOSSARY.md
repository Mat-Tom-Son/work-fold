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
`space-<16 hex>` (and a removal transaction `space-removal_<uuid>`) because
that identity is written into every registered folder's portable
`.work-fold/` metadata. Machine-local ids (Automations, Recently deleted
entries) follow the new words and are migrated in app state.

The folder that holds app-managed work-folders keeps its name (`spaces/` in
app state), and path-derived storage keys keep their old fallback segment:
moving or re-keying them would move user content and detach History,
per-folder state, and Pi chat sessions from existing folders.
