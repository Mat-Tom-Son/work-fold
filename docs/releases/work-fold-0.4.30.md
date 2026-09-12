# work-fold 0.4.30

September 12, 2026

Settings now has consistent navigation and compact controls. Model choices and
instruction drafts survive switching pages and Spaces. Menus and panels drop
redundant explanations, and narrow windows keep Settings tabs on one row.

Appearance adds five palettes, custom accents, conversation fonts and sizing,
reading width, line spacing, list density, and accessibility controls. Save,
import, and export presets; undo a change or reset to defaults. Space colors
and identity remain separate.

Background Chats share their local event connection so they cannot use up the
connections needed by Send, answers, and Stop. Reconnecting refreshes files and
settled transcripts. App inference history shows one current result per call;
interrupted calls and failed receipt writes no longer leave phantom running work.

Included tools distinguish loaded code from setup and connection readiness.
Chrome connects through the work-fold Chrome extension and a signed native
helper, with one selected browser profile and separate tabs for each Chat.
Computer control uses a verified helper outside the main app bundle so macOS
attributes Accessibility and Screen Recording permissions correctly. The helper
carries the work-fold icon and recovers when macOS restarts it.
Keyboard shortcuts verify the target window has focus before sending input.
Chrome connection checks report the live state, and disconnecting closes the
old connection so the same Chat can reconnect.
The Chrome Store listing becomes available after Google's review and approval.

Document workers contain accidental JavaScript allocation loops. Bundled image
readers reject malformed ICNS, JXL and HEIF records without hanging. Registry read
failures stay visible instead of making existing Spaces appear missing.
Developers can open the separate model-context inspector explicitly; recording
starts off, and the inspector has no normal Settings or Chat entry.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
