# Document verification

Design note, 2026-10-18. Approved by Mat on 2026-10-18: the tile says **Setup Needed** when LibreOffice is missing, and Set up guides the install without running it.

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
