# Rebrand plan

> **Status:** Plan, 2026-11-07. The owner wants a clean break from the name
> "work-fold" and a new repository. The new name is not chosen yet. This plan
> records everything the name touches, the decisions each part needs, what
> must come along intact, and the order of work.

## The names that change

Four names carry the brand. Each needs its own decision, because a new
product name does not automatically decide the others.

| Today | What it names | Decision |
|---|---|---|
| **work-fold** | The product, the app, the command, the bundle ids, the portable metadata folder | The new name, in every spelling (see the identity file below) |
| **work-folder** | A folder with its own Worker | Keep, or a new noun that pairs with the new name. It must stay distinct from an ordinary "folder". |
| **work-fold agent** | The one agent above every work-folder (menu bar, agent panel, `agent` CLI verbs) | "<New name> agent", or a name of its own |
| **WORKFOLD_** and **wf-** | Environment variables, and the app kit's CSS classes and variables | Follow the new name (for example `NEWNAME_` and a new two-letter prefix) |

**Worker**, **Automation**, **Recently deleted**, **History**, **Checks**, and
**Skills & Extensions** are not brand words and can stay.

`src/shared/product-identity.json` is the single source for the brand-bearing
identity. Every field changes:

| Field | Today |
|---|---|
| `productName` | `work-fold` |
| `packageName` | `work-fold-desktop` |
| `productionAppId` | `com.work-fold.desktop` |
| `developmentProductName` | `work-fold Development` |
| `macSmokeProductName`, `macSmokeAppId` | `work-fold Local Smoke`, `com.work-fold.desktop.local-smoke` |
| `internalProtocol` | `work-fold-desktop` |
| `updaterCacheDirectoryName` | `work-fold-desktop-updater` |
| `cliCommand` | `work-fold` |
| `portableMetadataDirectory` | `.work-fold` |
| `managementScopeId` | `work-fold-agent` |
| `sourceRepositoryOwner`, `sourceRepositoryName`, `macReleaseRepositoryName` | `Mat-Tom-Son`, `work-fold`, `work-fold-mac-releases` |

## Where the names are

`node scripts/rebrand/inventory.mjs --markdown <file>` lists every use, sorted
by name, by where it lives, and by how it is written, with the contracts
pulled out and every file whose own name carries a brand word. Run it again
at any point; after the rename, `--check` fails while any old name remains.

On 2026-11-07 it found **49,562 uses in 875 files**:

| Name | Uses |
|---|---:|
| work-folder | 34,338 |
| work-fold | 12,810 |
| work-fold agent | 2,183 |
| wf (app kit) | 231 |

| Where | Uses |
|---|---:|
| Tests | 17,216 |
| Local server and agents (`src/local`) | 13,766 |
| Interface (`web-local`) | 9,485 |
| Documents | 3,507 |
| CLI (`src/local/cli`, `desktop/cli`) | 2,554 |
| Desktop process (`desktop/`) | 1,128 |
| Build, packaging, and scripts | 717 |
| Hosted services (`services/`) | 557 |
| Shared contracts (`src/shared`) | 419 |
| Agent Skills and harness files | 157 |
| Included tools (`resources/`) | 56 |

About 30,000 of the uses are code identifiers and 6,000 are identifier-like
strings (keys, routes, ids, paths); 137 files carry a brand word in their own
name. That is a codemod's job, not a hand edit: the 2026-10-10 vocabulary
migration renamed "Space" to "work-folder" across the same tree with
`scripts/vocabulary/rename.mjs`, which preserves each token's case style and
takes ambiguous tokens from an override table. Extend it with word rules for
the four names above.

## Contracts

A contract is a name that leaves the source code: written to disk, sent
between processes, or called by something work-fold does not ship. A plain
find-and-replace breaks these unless the decision is made first.

| Contract | Uses | Recommendation |
|---|---:|---|
| App and bundle ids, URL scheme, updater cache | 29 | New values. A new bundle id makes a separate app: it installs beside work-fold, has its own application data and Keychain entry, and never updates from work-fold. That is the clean break. |
| Portable `.work-fold/` folder inside each work-folder | 353 | New name, plus a one-time import. It holds each folder's identity and its Chats (`.work-fold/conversations/`); ignoring it would lose existing Chats. When a folder that has `.work-fold/` is put to work, copy it to the new folder name and leave the original. |
| The installed command (`work-fold …`) and its broker folder | 1,541 | Rename together with the CLI help, the Worker and agent instructions, and the shims in `desktop/cli/`. |
| Environment variables (`WORKFOLD_*`) | 620 | Rename. Development scripts and the release lane read them. |
| Local HTTP routes and headers (`/api/work-folders`, `x-work-fold-session`) | 755 | Rename freely: the desktop, the window, and the local server ship together. |
| Desktop IPC channels (`work-fold:…`) | 329 | Rename freely, as above. |
| Window storage keys (`work-fold.…`) | 356 | Rename freely: a new app id starts with empty storage anyway. |
| Schema ids and media types (`work-fold.app-release`, `application/vnd.work-fold.*`, `work-fold.page/1`) | 125 | Rename. Artifact digests include the prefix, so App releases get new identities; a new app starts with none. |
| Globals apps and pages call (`workFoldRestrictedApp`, `workFoldPage`, `workFoldDesktop`) | 222 | Rename. Apps and pages Workers already wrote in someone's folders stop working until a Worker updates them; decide whether one release keeps the old global as an alias. |
| App kit (`/__work-fold/kit.css`, `--wf-*`, `wf-*`) | 217 | Rename with the globals, same alias decision. |
| Agent Skill and folder names (`manage-work-folders`, `work-fold-agent`) | 143 | Rename; the agent's Skill is rewritten on every start. |
| Source and release repositories | 45 | New repositories (below). |

The window and machine-local state need no migration at all: a new app id
gets a new application-data folder, so nothing from work-fold is read unless
an import is built on purpose.

## What must come along intact

### The command line, for any agent harness

The installed command is how Claude Code, Codex, or any shell-capable agent
drives the product. Keep its whole shape: a content-free read lane (`context`,
`work-folders list`, `tasks list`, `capabilities list`, `checks status`) and the
act lane, where every verb runs at once, leaves a receipt, and takes `--json`:

- `chat`, `chats`: start, follow, and wait on a Worker's Chat.
- `chat report|ask|answer|handoff`: how work-folders hand each other results,
  questions, answers, and work.
- `agent`: the agent above every work-folder.
- `requests list|show`: follow one piece of work across work-folders.
- `automations`: enable, run, stop, and read receipts.
- `files`, `history`, `search`, `work-folders`, `tools`, `apps`, `checks`,
  `jobs`, `worktrees`, `recently-deleted`, `pages validate`.

The tests that hold it are `tests/work-fold-cli-*.test.ts`,
`tests/work-fold-collaboration-*.test.ts`, and
`tests/work-fold-request-*.test.ts`; rename them with everything else and
keep them passing.

Two gaps worth closing in the new product, because they decide how easily
"any agent can be handed it":

1. **Put the command on the person's PATH.** On a Mac it lives in
   `work-fold.app/Contents/bin` and is added to the PATH only for the app's
   own Workers. Claude Code or Codex in Terminal cannot find it without manual
   setup. Add an **Install Command Line Tool** action, as code editors do.
2. **One file that teaches an outside agent.** The agent above every
   work-folder learns the command from a Skill work-fold writes on every start
   (`manage-work-folders`, from `src/local/work-fold-agent-instructions.ts`).
   Generate the same guidance as a portable Skill or `AGENTS.md` section a
   person can drop into any harness, so it is never a second copy that drifts.

### The agent above every work-folder

The work-fold agent sees every registered work-folder, delegates to their
Workers with `--parent-task` lineage, follows requests to completion, reads the
overview, and runs Automation `agent` steps. Its parts:

- `src/local/work-fold-kernel.ts`: the shared read authority for context,
  work-folders, tasks, and capabilities.
- `src/local/work-fold-agent-instructions.ts`: the instructions and Skill it
  gets on every start.
- `src/local/overview.ts`: the digest behind "what's happening".
- The machine-local `management/` folder that holds its Chats.
- The menu-bar popover and the main window's agent panel.

### Work-folders working together

- **Durable requests** (`src/local/requests/`): every accepted turn belongs to
  one request; questions end their turn and one answer continues it once; a
  parent never waits on a child; results come back in one shape.
- **Handoffs** copy named files into another work-folder's Chat through the
  restore-pointed path.
- **@-mentioning a Worker** in a message addresses another work-folder.
- **Automations**: declared `chat`, `agent`, and `check` steps, run in order
  so one step can hand its result to the next, on an interval or a
  folder-change trigger, including the ready-made ones.
- **Background jobs**, **worktrees**, **Checks**, **History**, and
  **Recently deleted** all keep their receipts and limits.

### Sub work-folders

A work-folder can be registered inside another. The host treats each one as
separately owned: its own History, Search, Checks, Automations, and Chats.
Today:

- `src/shared/folder-nesting.ts` gives one reading of the shape (the parent is
  the deepest work-folder that contains it), shared by the host and the window.
- A Worker's turn context names the work-folders directly inside its own
  (`nestedFolders` in `src/local/agent/work-folder-turn-context.ts`).
- The parent's file list shows a sub work-folder as a folder you can open,
  and leaves its contents out of the parent's Search, delete, and Organize.
- **New 2026-11-07:** the file manager's sidebar nests sub work-folders under
  their parent behind a caret, remembers which are open, shows a closed
  parent's combined activity dot, and opens a sub work-folder's parents when
  you go into it. The arrow keys open and close a row.
- Right-clicking a folder inside a work-folder already offers **Make a
  work-folder**, which makes it a sub work-folder.

Still to design: whether the path bar shows the parent chain, how moving
files across a sub work-folder's edge reads, and whether a parent's Worker may
hand work to its children without the agent above.

## Leave behind in the new repository

The new repository should start from the finished file-manager tree without:

- `services/bridge` and `services/pages`, which the desktop no longer uses.
  They stay deployed from this repository until someone decides to turn them
  off.
- The October migrations for the older Workspace and "Space" names
  (`src/local/vocabulary-migration*`, `web-local/src/lib/storage-migration.ts`)
  and the read-only tolerance for retired record shapes. A new app has no such
  state.
- The inactive Windows lanes, `docs/archive/`, and `docs/releases/`.
- Decide separately: the classic layout, App Studio and apps, and page folders,
  which the file manager leaves out today.

## Order of work

1. Choose the name and the three companion names (noun, agent, prefixes).
2. Finish the file-manager work that must ship and merge it here, so the new
   repository starts from one known commit.
3. Run the inventory and save its report with the commit it describes.
4. In the new repository: update `src/shared/product-identity.json`, extend
   the vocabulary codemod with the new word rules, run the code pass, then the
   prose pass, then rename files with `git mv`, and review the diff by class.
5. Build the `.work-fold/` import and decide the app alias question.
6. Run `npm run check`, `npm test`, and `inventory.mjs --check`.
7. Set up the new release repository, signing, and notarization profile, and
   make a first local release candidate under the new bundle id.
