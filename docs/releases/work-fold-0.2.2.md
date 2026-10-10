# work-fold 0.2.2

August 5, 2026

work-fold 0.2.2 makes Remote access a focused extension of the desktop app:
saved Chats are available from the web, Space files use an ordinary folder
tree, and requests can run through the selected Space's real Assistant runtime.
The connected page now keeps its copy deliberately sparse and shows only state
or guidance that helps the person act.

## Remote Chats and Spaces

- The connected page lists saved management and Space Chats, opens complete
  transcripts, starts new saved Chats, and keeps user and Assistant messages in
  sync with the desktop app.
- A Space Chat uses the same registered Space root, project Pi configuration,
  tools, trust boundary, History behavior, and background-turn machinery as a
  Chat started in the desktop app.
- The Files pane presents a filtered, bounded folder tree without exposing an
  absolute local path. A visible file can be added explicitly to the next turn.
- The browser can stop the exact management or Space task it started. Revoking
  a browser, disabling Remote access, or removing the address stops tracked
  remote work before its authority and retained uploads are cleared.

## File uploads

- An approved browser can attach up to six files to a turn, with a 6 MB
  per-file limit and an 8 MB combined limit. File names, traversal, payload
  shape, and decoded size are validated before local use.
- Space uploads are placed in `Dropped/<date>` and receive an additive restore
  point before the Assistant turn begins. Failed admission rolls the files and
  checkpoint back.
- Management uploads use an app-owned temporary staging area with a bounded
  retained quota, expiry pruning, and browser-revocation cleanup. The bridge
  continues to relay encrypted envelopes and does not durably store prompts,
  replies, Space names, file names, or file contents.

## Interface and reliability

- The connected layout now prioritizes Saved Chats, the conversation, and an
  on-demand Files pane. Redundant connection slogans, role suffixes, alpha
  labels, and explanatory chrome were removed.
- Desktop, tablet, and phone layouts keep the conversation primary while
  preserving access to saved Chats, uploads, Files, and task controls.
- Remote request envelopes now accommodate the documented encrypted upload
  limits, and the bridge rejects oversized envelopes for operations that do not
  carry uploads.
- The desktop tracks every accepted remote management and Space task for
  revocation instead of silently evicting older live task records.
- Reviewed dependency overrides include current fixes for AJV, Electron's
  downloader, URI parsing, IP parsing, and Undici.

## Menu-bar process audit

Remote access runs one WebSocket inside the existing Electron process; it does
not spawn another work-fold process or menu-bar item. The production app keeps
its single-instance lock and idempotent tray creation. Development, Local Smoke,
and production builds intentionally use separate application profiles and may
each show a menu-bar icon when launched together.

## Mac distribution

The Apple silicon app and DMG are Developer ID-signed by Team `464JD5K8DC`,
notarized by Apple, stapled, and accepted by Gatekeeper. The separate Mac feed
contains the DMG, updater ZIP, both blockmaps, `latest-mac.yml`, checksums, and
the machine-readable and human-readable release manifests from one verified
build.

This is an explicit Mac-first release. Windows signing and publication remain
deferred; no unsigned Windows installer is presented as a public release.

## Qualification

- TypeScript checks, the complete automated suite, the bridge integration
  suite, and the high-severity dependency audit passed.
- Desktop preparation and the Electron packaging smoke lane passed.
- The production artifacts must pass signing, hardened-runtime, Apple
  notarization, stapling, Gatekeeper, mounted-DMG, updater metadata, checksum,
  release-manifest, and remote digest verification gates before publication.
