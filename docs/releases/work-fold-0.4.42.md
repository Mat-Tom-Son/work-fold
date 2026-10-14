# work-fold 0.4.42

October 8, 2026

This update improves Settings and Skills & Extensions and fixes the reliability
issues found in the app audit.

- Skills & Extensions uses the Blocks icon, clearer Installed and Discover
  tabs, and a quieter **Add Custom** button below Search. Its five included
  tools remain at the top, and the Add dialog's close button is centered.
- Appearance starts with a labeled Preview, with Presets underneath. Shared
  Pages has clearer summaries and grouped actions; Save Model sits on the
  right. Apps and Web Access have distinct icons. Colors retain the inherited
  theme and accent.
- AI Models groups provider setup in a connection panel. API keys are masked
  with a show/hide control, and a saved key can be replaced without removing
  it first. Cancel discards the replacement; saving a model alone leaves an
  unsaved key replacement untouched.
- The work-folder header's context menu appears above pane dividers and
  prevents a dismissing click from starting a resize.
- File, Chat, and work-folder deletion waits until affected work has settled,
  including unanswered questions and stopped work that is still draining.
  Parent deletion requires removing nested work-folder registrations first.
  File changes also respect nested work-folder ownership.
- Interrupted trash moves preserve History. Assistant results use the latest
  child turn and actual request outcome; completed replies survive transient
  transcript-read failures.
- Remote watch cancellation and revocation remain responsive, empty HTTP
  responses no longer break restricted-app connections, and startup recovery
  points to the current Mac release feed.

The Pi runtime remains at its existing version. This release uses exact-commit
local verification, Developer ID signing, Apple notarization, and strict
artifact checks.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
