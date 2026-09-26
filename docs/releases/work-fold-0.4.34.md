# work-fold 0.4.34

September 25, 2026

**Unpublished candidate.** The immutable source tag is retained after its
[application CI failed](https://github.com/Mat-Tom-Son/work-fold/actions/runs/36157642044).
[0.4.35](work-fold-0.4.35.md) carries this work forward.

This update brings page sharing closer to your files and makes Automations
easier to find, understand, and control.

- Share a file from its tab or right-click menu. Copy its link, reopen the
  sharing controls, or stop sharing in place. Shared files have a quiet mark
  in Files and their tabs. Sharing requires Web access to be set up, and
  anyone with the link can read the page.
- Share self-contained HTML pages alongside Markdown, text, PNG, JPEG, and
  PDF files. HTML keeps inline styling and embedded images while scripts,
  forms, nested frames, and external resource loads are removed or blocked.
  Each page serves one designated file's current content; interactive sites
  and form submissions are not part of this release.
- Adjust page budgets and Sleep copy in Settings → Shared pages without
  changing the link. Sleep copy optionally keeps an encrypted copy at the
  relay, shown with its capture time while your desktop sleeps. Page states
  explain whether a page is live, asleep, resting, unavailable, or stopped.
- Turn on prepared Automation proposals from Ready to turn on in Settings.
  Invalid proposals explain what needs attention, and changed proposals
  cannot silently run different instructions from the ones shown.
- See relevant Automations in a Folder-owned tab, with their trigger, what
  they do in that Folder, last run, and Run now / Turn on / Turn off controls.
  Folder filters and a link to all Automations keep the management view close.
- Sharing stays attached to the correct file during fast navigation and
  repeated clicks cannot create duplicate links. Budget warnings remain
  until a successful page serve confirms recovery. Automation lists refresh
  when you return, and Refresh now sits beside the Files search and Add files.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
