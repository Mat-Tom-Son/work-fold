---
name: set-up-work-folder
description: Set up this work-folder for the person in one pass — work out what it is for, organize it if that helps, write instructions for future Workers, and give it a fitting banner, icon, and color. Also gives a work-folder just a fitting look without touching its files. Use when the person asks to set up, organize, tidy, or get started with this work-folder, or to give it a look, or clicks Set up for me or Just the look.
---

# Set up this work-folder

Turn this folder into a work-folder that is easy to work in, then show the person
exactly what changed. Do the work rather than asking permission: History took a
restore point before this turn, every change here can be undone, and you never
delete anything. Ask a question only when the folder is empty or you truly cannot
tell what it is for.

## 1. Look before you touch anything

- List the top level and one level down. Count files by type, note the biggest
  items, and the date range. On a big folder, read names everywhere but open only
  a sample: at most about twenty representative files (the first page or lines),
  and look at a few images with `read`.
- Decide in one sentence what this folder is for and who it serves, for example
  "household paperwork", "a writing practice", or "a downloads inbox".
- Find what to leave exactly where it is:
  - **Projects**: any folder holding `.git`, `package.json`, `pyproject.toml`,
    `Cargo.toml`, `go.mod`, an `.xcodeproj`, or similar. Never change anything
    inside one. You may move a whole project folder into a `Projects` folder when
    the top level is crowded.
  - **App-managed folders**: `.photoslibrary`, `.app` bundles, Obsidian vaults
    (`.obsidian`), exported sites, and anything whose layout another app depends
    on. Move them only as a whole, if at all.
  - **Hidden files and folders** (names starting with `.`): never touch them.
- Tell a deliberate system from a pile. Numbered or consistently named folders,
  a README or index, or links between files mean someone organized this on
  purpose: keep that structure and improve only what is actually loose. A long
  run of unrelated folders that arrived one by one (downloaded packs, exports,
  installers, old projects) is clutter, even though each one is a folder.

## 2. Organize, if it helps

- Aim for three to eight top-level folders named in the person's own plain words
  (`Receipts`, `Contracts`, `Photos`, `Installers & Archives`), never codes,
  numbers, or jargon. Keep it to two levels deep.
- File loose files first. Then look at the top level again. If it still has
  more than about a dozen items and they are a pile rather than a system, group
  the folders too: put each whole folder into the same few categories (for
  example `Game Assets`, `3D Print Models`, `Work Projects`, `Writing`).
  Moving a whole folder is safe; it never changes anything inside it. Keep a
  `.zip` beside the folder it was extracted to by moving the pair together.
  Aim to finish with a top level a person can take in at a glance.
- Only move and rename. Never delete, overwrite, unzip, or edit a file's
  contents. If two files look like duplicates, keep both and mention them.
- Rename a file only when its name says nothing (`IMG_2034.png`,
  `download (3).pdf`, `Screenshot 2026-10-11 at 1.23.43 AM.png`) and its content
  makes a clearly better name obvious. Keep the extension, and keep the date as a
  `YYYY-MM-DD` prefix when the file has one.
- Use `mkdir -p` and `mv -n` so nothing is ever overwritten; on a name clash, add
  ` (2)`. Check the result with a final listing.
- Keep a list of every move and rename as you go (old path → new path). You need
  it for the summary.

## 3. Leave instructions for future Workers

Write this work-folder's Worker instructions so every later Chat knows how the
folder works:

```bash
work-fold work-folders worker instructions --work-folder <this work-folder's id> --instructions-file <file> --json
```

Write the text to a temporary file outside the work-folder (for example in
`$TMPDIR`) first. Keep it to five to fifteen short lines: what the folder is
for, what each top-level folder holds, the naming conventions, and where new
things should go. Plain words, no headings beyond a title.

## 4. Give it a look

- Pick the icon from work-fold's catalog that names the subject most directly.
  Some of the names: nature `leaf`, `tree`, `grass`, `sun`, `mountains`,
  `beach`; home and life `home`, `coffee`, `cake`, `gift`, `heart`, `cat`,
  `dog`, `paw`, `bicycle`, `suitcase`, `airplane`, `map`; making and play
  `paintbrush`, `palette`, `music`, `guitar`, `camera`, `image`, `video`,
  `games`, `soccer`, `basketball`, `rocket`, `planet`; work and money
  `briefcase`, `building`, `money`, `receipt`, `scale`, `gavel`, `chart`,
  `calendar`, `checklist`, `tasks`, `mail`, `people-team`, `handshake`;
  knowledge `book`, `library`, `notebook`, `notepad`, `teaching`, `lightbulb`,
  `brain`, `beaker`, `microscope`; health `doctor`, `stethoscope`, `pill`;
  things and tech `code`, `laptop`, `server`, `database`, `package`, `boxes`,
  `toolbox`, `wrench`, `archive`, `folder`, `star`, `sparkles`.
- Pick an accent color that fits, as a hex value. Prefer calm, readable
  colors.
- Make a wide banner with `generate_image` and `temporary: true`, so the picture
  never lands in the person's folder. Show the folder's real subject as a scene
  or still life (illustrated or photographic) in colors that go with the accent,
  never app icons, interface elements, glowing "tech" effects, or abstract
  stock graphics. End the description with "no text, no letters, no logos".
- Apply all three at once, using the absolute path `generate_image` returned:

  ```bash
  work-fold work-folders appearance apply --work-folder <id> --banner-image "<absolute path>" --icon <name> --color <#rrggbb> --json
  ```

## 5. Point at what could come next

If the contents suggest a recurring job, name one or two Automations or apps the
person could ask you for, one line each: for example "a monthly receipts
summary", "sort new screenshots as they land", or "a reading list app for these
papers". Do not build them now.

## 6. Report

Finish with a short, scannable reply:

- one sentence on what this folder is;
- the new top-level folders with a file count each;
- a few notable renames, and the total number of moves and renames;
- what you left alone and why;
- the banner, icon, and color you set;
- a two-line summary of the Worker instructions;
- how to undo: "History has a restore point from just before setup. Restore it
  from the History tab to put everything back."

## Just the look

When the person asks only for a look (for example "Just the look"), do steps 1
and 4 and nothing else: read the folder to understand it, then set the banner,
icon, and color. Never move, rename, create, or delete a file or folder, and do
not write Worker instructions. Report in three or four lines: what the folder
is, and the banner, icon, and color you set. Undo is
`work-fold work-folders appearance undo --work-folder <id>`, or reset it in
Customize work-folder. If the folder is empty, go by its name and do not ask.

## An empty folder

If there is nothing to look at, ask one question: what the folder will be for.
Once you know, create a simple starting structure (three to six folders, plus a
short `Start here.md` saying what goes where), write the Worker instructions,
and give it a look, then report the same way.
