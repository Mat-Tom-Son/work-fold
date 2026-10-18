# Document verification

Design note, 2026-10-18. Approved by Mat on 2026-10-18: the tile says **Setup Needed** when LibreOffice is missing, and Set up guides the install without running it. The [evaluation](document-verification-evaluation.md) records how Workers did with and without the engines.

A Worker that makes a Word report, a slide deck, or a budget workbook should
look at the result before it says the work is done: see the pages, read the
formula results, fix what is wrong. This note covers how the Documents tool
reports whether it can do that, how a person sets it up, and what the Skill
teaches.

## What happens today

- **Detection.** `document_engine status` looks for executable files only and
  starts nothing. LibreOffice is searched on `PATH`,
  `/Applications/LibreOffice.app`, `/opt/homebrew/bin`, and `/usr/local/bin`;
  Tesseract on `PATH`, `/opt/homebrew/bin`, and `/usr/local/bin`. A missing
  engine returns one setup sentence.
- **Strip.** Documents shows **Not Checked** until someone presses Check or a
  Worker runs `document_run`, then **Ready**. That check covers only the
  bundled libraries. The engines appear nowhere in the strip or the details.
  So a Mac without LibreOffice shows **Ready** while its Worker cannot see a
  Word or PowerPoint file or calculate a formula.
- **Set up.** Documents supports only `check`. Its details dialog is the
  generic one: a status word and a Check button.
- **Skill.** It describes the engines as optional, says the tool "does not
  install programs", and describes inspection without making it a habit. It
  says nothing about what to report when a check was not possible.

Without LibreOffice, a typical Mac gives a Worker:

| File | Can it see the result? |
| --- | --- |
| PDF | Yes: pages render to images with the bundled renderer. |
| Word, PowerPoint | No. Only the file structure (ZIP parts, text). |
| Excel | No calculated values. ExcelJS writes the formula and whatever cached result the script supplied. |

## Proposal

### 1. Status

- Every status refresh also looks for the engines with the same file checks,
  so nothing is launched. The status carries a `documentsSetup` record with
  each engine's path and, after a Check, its version or start problem.
- The status word:
  - **Ready**: the bundled libraries passed their check (or a Worker's
    `document_run` proved them) and LibreOffice is found.
  - **Not Checked**: LibreOffice is found but the bundled libraries have not
    been checked yet on this run of the app.
  - **Setup Needed**: LibreOffice is not found. The detail reads: "Your Worker
    can make documents but can't check how Word and PowerPoint files look or
    what spreadsheet formulas calculate. Install LibreOffice to turn that on."
  - **Unavailable**: only when the bundled libraries fail their check.
  - Tesseract never changes the word. It reads scanned pages only, so it is an
    optional row in the details.
- **Check** stays explicit. It runs the bundled-library probe and
  `--version` on each engine it finds, so an install that is blocked or broken
  shows as such, and it records the version.
- More places to look, because an app opened from the Finder gets a short
  `PATH`: `~/Applications/LibreOffice.app`, MacPorts (`/opt/local/bin`), and
  the usual Linux and Windows install folders.

### 2. Set up, in the Documents details

A two-row checklist in the style of Computer Control. As built, the rows read
"LibreOffice lets your Worker see Word and PowerPoint pages and calculate
spreadsheet formulas" with **Download**, and "Tesseract (optional) lets your
Worker read the text in scanned pages" with **Install guide**:

1. **Check layout and formulas: LibreOffice.** Free and open source, about
   800 MB. **Download LibreOffice** opens the official download page
   (libreoffice.org) in the browser. When Homebrew is present, a second line
   shows `brew install --cask libreoffice` with **Copy**. Hint: "After
   installing, open LibreOffice once so macOS can approve it."
2. **Read scanned pages: Tesseract (optional).** Tesseract has no official
   Mac installer; its own install guide points to Homebrew or MacPorts. Show
   `brew install tesseract` with **Copy** and a link to that guide. Linux shows
   the `apt` command, and Windows links the installer named in the same
   guide.

While the details are open, the dialog's ordinary status refresh (every five
seconds and whenever the window regains focus) runs the same file checks, so
each row ticks off soon after the engine appears, with no ten-minute limit
and no extra watcher. **Check** stays available. An installed engine's path
and version sit in the tooltip of its **Installed** label. work-fold itself
installs nothing: it opens the official page or shows a command the person
runs. Nothing is bundled.

### 3. The Skill

- **Verify by default.** After making or changing a document, check it before
  reporting:
  - Excel: recalculate a copy, reopen it, compare the key values with what the
    numbers should be, and look for error values (`#REF!`, `#DIV/0!`,
    `#NAME?`, `#VALUE!`).
  - Word and PowerPoint: render to PDF, render the pages to images, look at
    them, and fix clipped or overflowing text, broken tables, and wrong page
    or slide counts. Re-render after a fix.
  - PDF: render the pages directly.
  - Review copies go in `.worker/<task-id>/`, never beside the deliverable.
- **Without an engine,** still run the structural checks (reopen the
  workbook, check formula references, estimate whether text fits its box),
  then say exactly what could not be checked, for example "I couldn't see
  how the slides look." Point to Skills & Extensions → Documents → Set Up.
  Never claim a visual check or a calculated value that did not happen.
- **The report** includes one line on what was checked and how.
- Keep the honest wording on Calc vs Excel differences.
- Added after the evaluation:
  - the `docx` half-point font unit and explicit table column widths;
  - a zoomed look (`scale: 2` or a cropped region), because one Worker
    rendered a page and still missed 5 pt text;
  - the ExcelJS quirk that reads a calculated 0 as no result;
  - a closing Set Up sentence for every file type;
  - without engines, a column-width estimate for Word tables, because split
    words were the fault seen most often on pages nobody looked at.
- **Installing on request only.** If the person asks the Worker to install
  LibreOffice or Tesseract, it may run the same command Set up shows, visibly
  in the Chat. It never installs anything unasked.

### 4. Evaluation

- Three seeded tasks, each with a checker script kept outside the Worker's
  folder and context:
  - a budget workbook with formulas and a cross-sheet total;
  - a slide deck whose dense slide overflows unless the Worker fixes it;
  - a Word report with a wide table.
- Two conditions, run through `npm run work-fold:drive` with the same model:
  - engines visible;
  - engines hidden by a macOS `sandbox-exec` profile, so the Worker's shell
    cannot find them either.
- Scoring: is the output correct by the hidden checks, did the Worker
  actually verify it, and is its final report honest?

## Out of scope (possible follow-ups)

- A bundled, MIT-licensed JavaScript formula evaluator for formula checks
  without LibreOffice.
- One-click install through Homebrew from inside work-fold.
- Exporting through the person's own Word or PowerPoint with Computer Control.

## Addendum: a Quick Look preview without LibreOffice

Design note, 2026-10-18. Approved by Mat on 2026-10-18: Word page 1 plus any slide of a deck, with the partial preview mentioned in the Documents detail on macOS.

The evaluation found that the fault seen most often on pages nobody looked at
was a word or amount split across lines in a narrow table column. Every Mac
can already draw Office files without LibreOffice or Microsoft Office:
Quick Look's built-in generator (`/System/Library/QuickLook/Office.qlgenerator`)
handles Word, PowerPoint and Excel files, and `qlmanage -t` writes its
thumbnail as a PNG.

### What a survey of `qlmanage` showed

- **Fast and faithful enough.** About 0.1 seconds per file. A Word page came
  out at 1246 × 1600 pixels with `-s 1600`, and up to 3200 pixels on request.
  It showed the same split words and amounts LibreOffice did. Fonts are
  substituted differently from Word, as with LibreOffice.
- **One page only.** A thumbnail is the first page of a Word file, the first
  slide of a deck, or part of the first sheet of a workbook.
- **Any slide, via a private copy.** Reordering the slide list in a private
  copy of a deck makes Quick Look draw any chosen slide. A Word document has
  no such order to change, so only page 1 can be drawn.
- **Workbooks are not worth it.** Their thumbnails crop the sheet oddly
  (a two-column sheet showed only its first column and part of the second)
  and show cached values only.
- **It hangs on failure.** On a missing, empty or damaged file, `qlmanage`
  writes nothing and never exits. It needs a deadline and a kill.
- **No sandboxing.** It cannot start inside a `sandbox-exec` profile.
- `qlmanage --version` reports the Quick Look framework version.

### Proposal

1. **A `preview` operation on `document_engine`, macOS only.**
   - It takes a DOCX or PPTX source and a new PNG output path, plus an
     optional `slide` number for a deck.
   - For a slide other than the first, it makes a private copy with that
     slide moved to the front. The source file is never changed.
   - Otherwise it works exactly like `render`: it captures a private copy,
     reports source and output hashes and the Quick Look version, keeps a
     log, and supports Stop.
   - It has a 60-second default deadline, because a file Quick Look cannot
     draw never finishes. `timeoutMs` overrides it.
   - When no image appears, it says: "Quick Look couldn't draw this file. It
     may be damaged, or a kind Quick Look doesn't know."
2. **`status` lists Quick Look** as an engine: available on macOS, nothing
   to install, operations `["preview"]`. The tool and the Documents status
   look in the same places. A host's `documentEngineSearch` now reaches the
   tool as well as the strip.
3. **The Documents status word does not change.** It stays **Setup Needed**
   without LibreOffice, because Quick Look covers one page and calculates
   nothing. On macOS the detail becomes: "Your Worker can preview the first
   page of a Word file and each slide of a deck, but can't check every page
   or what spreadsheet formulas calculate. Install LibreOffice to turn that
   on." Set up is unchanged.
4. **The Skill: without LibreOffice on a Mac,**
   - preview page 1 of every Word file and every slide of a deck, look at
     them, fix, and preview again;
   - to see a later part of a Word document it made, build a review copy
     that starts with that part;
   - say in the report which pages were seen and which were not, and still
     point to Set Up.
5. **Evaluation.** Quick Look cannot run inside the sandbox profile, so a new
   no-LibreOffice condition hides LibreOffice and Tesseract through the
   host's `documentEngineSearch`, and drops Homebrew's folders from the
   host's `PATH`. Transcripts are checked for any use of `soffice`. The
   report and deck tasks are rerun, and the results are added to the
   evaluation page.

As built, the evaluation added two Skill rules:
- never reshape the deliverable to suit the preview, because one Worker
  split its report into three sparse pages so each part could be previewed;
- end the report with the Set Up sentence even when a preview showed the
  whole file.
