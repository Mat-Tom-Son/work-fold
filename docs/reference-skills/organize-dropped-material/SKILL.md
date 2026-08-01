---
name: organize-dropped-material
description: Organize files dropped into this Chat into the right Space using the workspace CLI. Use when the person drops material and asks to file, sort, or organize it.
---

# Organize dropped material

You work inside one Space, but the installed `workspace` command gives you sight and hands across every registered Space. Use it to file material the person drops into this Chat instead of guessing from this folder alone.

## See before deciding

- `workspace spaces list --json` — every registered Space with ids, names, and folders.
- `workspace context --json` — the Space this Chat belongs to.
- Files dropped onto the composer were uploaded under this Space's `Dropped/` folder and attached to the conversation with Space-relative paths.

## Decide

Prefer an existing Space whose purpose clearly matches the material. Create a new Space only when nothing fits and the material starts a distinct ongoing activity:

- `workspace spaces create --name "<name>" --json`
- `workspace spaces register --path "<absolute-existing-folder>" --json` when the right folder already exists outside Workspace.

If the best destination is genuinely ambiguous, ask the person instead of choosing.

## Place

Copy material into the destination with a History restore point — use this instead of raw shell moves across Spaces:

- `workspace files add --space <destination-id> --from "<source-path>" [--from "<source-path>"...] [--to "<destination-folder>"] --json`

Relative `--from` paths resolve against your working directory. The response lists the copied Space-relative paths and the restore-point id. After a successful copy you may tidy the staged copy under this Space's `Dropped/` folder.

## Hand off (optional)

To have the destination Space's own Assistant continue the work there:

- `workspace chat send --space <destination-id> --new --message "<what arrived and what should happen>" --json` — the response includes a `taskId`.
- `workspace chat wait --space <destination-id> --task <taskId> --json` follows exactly that turn to its outcome and prints its response; a failed or aborted turn exits non-zero instead of showing an older message as success.
- `workspace chat status --space <destination-id> --task <taskId> --json` is the non-blocking check.

Never send to a Chat that is already working: `workspace chat status --conversation <id>` reports `running`, `compacting`, or `idle`, and a send into active work is rejected as a conflict.

## Report

Tell the person exactly what you placed where (Space names and paths), any Space you created or registered, the restore-point id, and any hand-off Chat you started. If a command answers "Open Workspace to run this command", the desktop app is not running — ask the person to open Workspace, then retry.
