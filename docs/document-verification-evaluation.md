# Document verification evaluation

2026-10-18. This page records how Workers did on three seeded document tasks
with and without the optional engines, before and after the
[document verification](document-verification.md) changes.

## Short version

- **Seeing the page is what catches layout faults.** Across 9 Word reports
  made without LibreOffice, 7 had a fault visible on the page: words, amounts
  or headings broken mid-word in a narrow column, unreadably small text, or
  most of a page left empty. None of the 3 reports made with LibreOffice and
  the final Skill had one.
- **Rendering alone is not enough.** One engines run rendered its report
  four times and still missed that the summary was about 5 pt. The final
  Skill names the `docx` half-point size unit and asks for a zoomed look
  (`scale: 2` or a cropped region). No later run repeated the fault.
- **Numbers and slides were already right.** GPT-6 Luna wrote every budget
  correctly (24 of 24 checked values, both calculated and as cached in the
  file), and laid out every findings slide without overflow in every
  condition. The traps meant to break these (cross-sheet formulas to a sheet
  name with a space, eight long findings that overflow at the default size)
  did not.
- **The Skill made checking a habit and reporting honest.**
  - With engines and the new Skill, every run checked its file with an
    engine and said what it checked.
  - With `main`'s Skill and the same engines, neither budget run rendered
    its workbook, one ran no check at all, and neither said what it had
    checked.
  - Without engines, every run said exactly what it could not check. After
    two wording passes, every run also pointed to Skills & Extensions →
    Documents → Set Up.
- **Checking costs about a minute.** The median turn took 2.6 minutes with
  engines, against 1.8 minutes without them.
- **Quick Look closes most of the gap on a Mac.** With LibreOffice hidden
  but macOS Quick Look available, Workers previewed every slide of every
  deck and page 1 of every report. None of the 9 reports had a word or
  amount broken mid-word or unreadably small text, against 7 of 9 without
  any preview. The first Skill wording led one Worker to reshape its report
  into three sparse pages so each part could be previewed. The final wording
  forbids that, and also gets every report to point to Set Up.

## Setup

- **Model.** OpenRouter `openai/gpt-6-luna`, high thinking, which is Mat's
  default.
- **Driver.** Each turn ran through `npm run work-fold:drive -- --attach`
  against `scripts/document-eval/host.ts`. That host is the local API with
  the included tools, an isolated Pi folder, and disposable app state.
- **Tasks.** Each task started in a fresh, disposable work-folder.
  - **Budget workbook:** 24 transactions, `SUMIF` actuals, Over/OK status
    formulas, and cross-sheet totals to a sheet named "By Category", with
    dollar and percent formats.
  - **Slide deck:** exactly five 16:9 slides, with eight findings of about
    45 words each, word for word, on one slide.
  - **Word report:** a 12-row, 9-column workstream table on a portrait
    Letter page.
- **Conditions:**
  - *engines*: this branch, with LibreOffice and Tesseract visible.
  - *no engines*: this branch, with the host run under
    `scripts/document-eval/no-engines.sb`. That `sandbox-exec` profile hides
    LibreOffice, Tesseract and Microsoft Office from the host and every
    tool it starts.
  - *baseline*: `main`'s Skill and tool text, with engines visible.
- **Hidden checks.** `scripts/document-eval/check.ts` runs outside the
  Worker's folder and context. It covers:
  - for workbooks, recalculated and cached values, formulas, formats, and
    error results;
  - for decks, the slide count, the findings word for word, and text
    outside its box (including layout and master shapes), with and without
    shrink-to-fit;
  - for reports, the table's size, its content, the page size, and the page
    count.

  I also looked at every rendered page. Those notes are below.
- **Runs.** The first batch was 18 turns: 3 conditions × 3 tasks × 2. The
  Skill then changed three times, each followed by a rerun:
  - *v2* and *v3*: the "could not check" wording, rerun without engines
    (6 turns each).
  - *v4*: the Word guidance, rerun on the report task in both conditions
    (3 turns each).
  - *v5*: the final Skill, rerun on the budget and deck tasks with engines
    (4 turns).

## Results

### Budget workbook

| Condition | Runs | Correct after recalculation | Correct as delivered | Checked with an engine | Said what it checked |
| --- | --- | --- | --- | --- | --- |
| engines (first Skill) | 2 | 24/24, 24/24 | 24/24, 24/24 | 2 of 2 (recalculated and rendered) | 2 of 2 |
| engines (final Skill) | 2 | 24/24, 24/24 | 24/24, 24/24 | 2 of 2 | 2 of 2 |
| no engines (v1 to v3) | 6 | all 24/24 | all 24/24 | none available | 6 of 6 named the gap |
| baseline | 2 | 24/24, 24/24 | 24/24, 24/24 | 1 of 2 (recalculated; neither rendered) | 0 of 2 |

ExcelJS reads a calculated result of exactly 0 as a formula with no result.
The hidden checker fell into this, and so did one final-Skill Worker, which
noticed and confirmed the cell itself. The Skill now names the quirk.

### Slide deck

| Condition | Runs | Five slides, 8/8 findings | Text outside its box | Shrink-to-fit used | Rendered and looked |
| --- | --- | --- | --- | --- | --- |
| engines (first and final Skill) | 4 | all | none | 1 deck, title slide only | 4 of 4 (5 to 10 slide images each) |
| no engines (v1 to v3) | 6 | all | none | none | none available |
| baseline | 2 | all | none | every slide, in both decks | 2 of 2 |

Every Worker laid the eight findings out as two columns of cards at a
readable size, so the overflow trap did not fire. The baseline decks set
PptxGenJS shrink-to-fit on every slide. LibreOffice applies that flag when it
renders, but PowerPoint ignores it until someone edits the text, so a
LibreOffice check can hide an overflow that PowerPoint shows. Rendering those
decks without the flag still showed no overflow here. The Skill now says not
to rely on the flag.

### Word report

| Condition | Runs | Table, content and Letter page right | Faults visible on the rendered page |
| --- | --- | --- | --- |
| engines (first Skill) | 2 | 2 of 2 | 1: summary and risks at about 5 pt, missed despite four renders |
| engines (final Skill, v4) | 3 | 3 of 3 | none |
| baseline | 2 | 2 of 2 | none |
| no engines (v1 to v4) | 9 | 9 of 9 | 7 (see below) |

The hidden checks passed for every report. These are the faults I saw on the
rendered pages of the no-engines reports:

- **v1, run 1:** a heading split as "% complet / e", and two-thirds of page 1
  empty because the table moved to page 2.
- **v2, run 1:** amounts split as "$148,00 / 0" and "$101,50 / 0", plus
  "Complet / e" and "% comp / lete".
- **v2, run 2:** the summary and risks at about 5 pt, and the program lead
  printed twice.
- **v3, runs 1 and 2:** the "% complete" heading split mid-word.
- **v4, runs 2 and 3:** the "% complete" heading split mid-word, even with
  the new column-width guidance.
- **v4, run 1:** half of page 1 empty. This is mild and not counted among
  the 7.

The one remaining report (v1, run 2) was clean. macOS Quick Look draws the
same splits in the v2 run 1 report, so they are not LibreOffice artifacts.

### Quick Look preview without LibreOffice

After the `preview` operation landed (see the addendum to
[document verification](document-verification.md)), the report and deck tasks
ran three times each in a fourth condition, *no LibreOffice*. LibreOffice and
Tesseract were hidden from the tools and from the shell's `PATH`, while Quick
Look stayed available. Quick Look cannot start inside the sandbox profile.
No transcript touched LibreOffice, Microsoft Office or `qlmanage` directly.
The Skill wording changed twice between rounds:

| Round and Skill wording | Decks: previews, slides outside box | Reports: previews, faults seen on the page | Pointed to Set Up |
| --- | --- | --- | --- |
| v1: preview page 1 and every slide | 10 to 15 each, none | 7 or 8 each; none | 3 of 6 |
| v2: plus "a preview is not the full check" | 10 to 15 each, none | 2 to 17 each; one report reshaped into three sparse pages with its table split in two so each part could be previewed | 4 of 6 |
| v3: never reshape the deliverable; end with Set Up even when the preview showed everything | 10 each, none | 6 or 7 each; short dates wrapped at the space ("Nov / 21") in two reports, and one put its table on page 2 | 6 of 6 |

Across the 9 reports, none had a word or amount broken mid-word, and none had
5 pt text. Without any preview, 7 of 9 had such faults. Two caveats:
- **Different renderers.** LibreOffice wrapped short dates that Quick Look's
  own fonts probably fit, so a Quick Look check is not the same as a check
  in Word.
- **Page 1 only.** Word documents longer than a page were checked only
  through review copies.

Turns took about the same time as with LibreOffice: a median of 2.7
minutes, with one report at 9.4 minutes.

### Reports to the person

No run claimed a check it did not do. Without engines, every run said what it
could not check. Pointing to Set Up depended on the wording:

| Skill wording | Pointed to Set Up |
| --- | --- |
| v1 | 4 of 6 |
| v2: Set Up named in the report step | 4 of 6, still missing from both budgets |
| v3: a closing sentence to use for every file type | 6 of 6 |
| v4 | 3 of 3 |

The status summary in `status.md` says ten of twelve workstreams are on track
or complete, but its table shows seven. This crept into the fixture by
accident and is kept, so reruns match these results. Five of the later runs
flagged it, in both conditions.

## Limits

- **Small and narrow.** There were two or three runs per cell, with one
  model. Rates are indications, not measurements.
- **One renderer.** LibreOffice was both the Workers' engine and the
  checker's renderer, so their view of fonts and line breaks is the same.
  Quick Look, Apple's renderer, agreed on the split words it was shown.
- **Not re-measured.** The last Skill change, a column-width estimate for
  Word tables without engines, was not run again.
- **Not available to the Workers.** Computer Control and the person's own
  Office apps were not available in any condition. Quick Look could not
  start inside the sandbox profile either, so the no-engines Workers could
  not have used it. The no-LibreOffice condition hid LibreOffice only from
  the tools and the shell's `PATH`; its transcripts show no other route to
  it.

## Follow-ups

- **First-run setup.** First run's "Let your Worker use your Mac" step
  offers Chrome and Computer Control. It could offer LibreOffice too.
- **Harder numeric tasks.** These tasks never separated the conditions on
  correctness. A workbook with lookups, dates or circular references would
  test whether recalculation catches real formula mistakes.

## Rerunning

The provider key is read from Pi's `auth.json` into the host's environment
only; it is never printed or written.

```bash
npx tsx scripts/document-eval/run.ts --condition engines --repeat 2 --out /tmp/document-eval/engines
```

```bash
npx tsx scripts/document-eval/run.ts --condition no-engines --repeat 2 --out /tmp/document-eval/no-engines
```

```bash
npx tsx scripts/document-eval/run.ts --condition no-libreoffice --tasks report,deck --repeat 3 --out /tmp/document-eval/no-libreoffice
```

```bash
npx tsx scripts/document-eval/score.ts /tmp/document-eval engines no-engines no-libreoffice
```

`--host-repo <checkout>` runs the host from another checkout, such as a
baseline of `main`. `--tasks budget,deck,report` limits the tasks. Each
run's folder keeps the Worker's files, the turn report, the tools it called,
the hidden checks, and the page images.
