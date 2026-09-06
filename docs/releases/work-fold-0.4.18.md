# work-fold 0.4.18

September 6, 2026

Checks now have a simple path from an idea to a reviewed correction.

- **Tell the fold what to check** prepares an unsent setup request. The fold can
  save a proposal for review; manual setup remains available.
- **Try it** runs the proposed Check once without enabling it or replacing live
  findings. Turn it on separately when its criteria and selected files are right.
- The fold shows a compact Checks inbox. **Review** opens the correct Space;
  finding help starts a fresh, unsent conversation with that Space's Assistant.
- Assistants can prepare a single-file correction. Checks shows the before and
  after text; applying revalidates the evidence, saves History, and rechecks.
  Changed inputs, unsafe paths, and interrupted application fail closed.
- Enabled Check details are collapsed. Setup drafts and status copy stay short,
  completed trials no longer duplicate live results, and overlapping status
  refreshes recover without leaving the page unavailable.

Trials do not grant standing authority or trigger Routing handoffs. Corrections
require a current text finding and remain inert until reviewed. Live prose
reviews use the fold's selected model and the explicitly designated files.
Check authoring changes create separate proposals; existing Checks remain as
configured until explicitly changed or turned off.

The workflow has coverage for proposal and trial isolation, exact evidence,
stale primary and reference files, correction review and application, History
preservation, interruption recovery, and renderer/CLI integration. The prior
developer candidate passed 1,079 tests with one Windows-only skip, signed app
verification, and native Checks, History, and folder-handoff smoke tests.
Release gates and installed updater testing are recorded separately.

This release retains the folder-change Routings and recovery improvements in
0.4.17. No bridge deployment is needed for this desktop workflow.
