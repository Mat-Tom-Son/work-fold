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
Chrome uses the bundled Pi Chrome Connector, loaded once through Chrome's
**Load unpacked** control. Computer control uses the signed helper and macOS
Accessibility and Screen Recording permissions. The helper carries the work-fold
icon in macOS Settings.

Document workers contain accidental JavaScript allocation loops. Bundled image
readers reject malformed ICNS, JXL and HEIF records without hanging. Registry read
failures stay visible instead of making existing Spaces appear missing.
Developers can open the separate model-context inspector explicitly; recording
starts off, and the inspector has no normal Settings or Chat entry.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
