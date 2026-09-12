# work-fold 0.4.29

September 11, 2026

work-fold now includes native Pi Extensions for computer control, Chrome,
web research, documents, and MCP service connections. They are available to
the fold and every Space through **Add → Skills & Extensions**, alongside
ordinary Pi Skills and Extensions you install yourself.

Computer control uses a bundled, signed **work-fold Computer** helper on
macOS 14 or later. macOS Accessibility and Screen Recording permissions are
set up from the Extension's details. Chrome uses an included companion loaded
into your profile once; its private connection keeps browser work with the
originating Chat. Both return selected screenshots directly to the model.
Stopping one Chat does not cancel another Chat's work.

Web research offers DuckDuckGo search and public page reading without setup,
with an optional Brave Search connection. Documents includes standard
libraries for Word, Excel, PowerPoint, and PDF files, plus a reusable Skill.
Selected PDF pages can be rendered and returned to the model for visual
checks; temporary review images are removed after the tool finishes. Office
files open in your existing apps. Excel formulas are preserved, not
recalculated by the bundled library.

Service connections accepts standard MCP URLs and local commands, with
Space-specific or Everywhere scope, secure sign-in, connection checks,
enablement, and removal. Local servers require their own installed runtimes.
Extensions and Skills can also be turned off and back on without uninstalling
them, through the UI or the receipted `work-fold tools enable|disable` verbs.

Questions from native Extensions remain attached to their Chat across turns,
including after a stopped turn has finished unwinding. Model-context
inspection is now a developer diagnostic with loaded-resource provenance,
rather than an extra control in normal Chats or Settings.

Provider credit or output-reservation failures now explain the actual problem
and preserve completed work for a later continuation.

These are native Pi tools and ordinary files. The restricted Space-app
runtime remains separate. See [the integration contract](../extension-foundation.md)
for setup, lifecycle, and compatibility details, and
[dependency notes](../../patches/included-tools/README.md) for the exact
upstream versions and reviewed patches.

Availability and downloads: [the Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
