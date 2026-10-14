# work-fold 0.4.46

October 9, 2026

This fixes the macOS title-bar regression in 0.4.45. The shared desktop layout now preserves the native 38px strip above the rail, work-folder banner and tabs, keeping Files clear of the traffic lights and leaving a dedicated area for window dragging.

The title-bar strip and layout use one inset value. Real Chromium tests measure the banner, switcher, tabs and Files target against that strip across light/dark palettes and native-material settings, rather than only checking that a macOS CSS rule exists.

Saved work-folder artwork and application personalization retain their existing behavior. The correction is limited to native macOS window spacing.
