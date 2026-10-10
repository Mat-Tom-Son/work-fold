# work-fold 0.3.4

August 20, 2026

work-fold 0.3.4 is an interaction pass over the three everyday surfaces — the
desktop app, the menu-bar fold, and your fold on the web. No new explanatory
copy was added anywhere: behavior now simply matches what fingers expect.
Enter sends everywhere, focus lands where typing goes, reading is never yanked
away mid-scroll, and the keyboard reaches tabs, files, and running work.

## Menu-bar fold

- Enter sends and Shift+Enter keeps the newline, matching every other
  work-fold composer. A mid-IME-composition Enter never sends and Escape never
  dismisses the surface mid-composition.
- The draft box grows with its content to about eight lines before scrolling.
- The transcript follows new entries only while pinned near the bottom, so
  reading scrollback is never dragged back down by the refresh cadence.
- What's new stays put while it is being read; marking-seen quiets items on
  the next look instead of collapsing the list mid-read. The main window's
  glance panel gains the same behavior.
- The composer takes focus back when a request settles and when the popover
  reopens, and keystrokes typed while a send was in flight survive it.
- Material dropped mid-turn stays visible as staged chips, a drop puts the
  cursor in the instruction box, and pasting a lone link stages it the way a
  dropped link would.
- Open work-fold is always reachable from the ⋯ menu, whose items answer to
  arrow keys; ⌘N starts a new chat; New chat waits while work runs instead of
  hiding a running request's live tail and Stop.
- Banners can be dismissed, chip removal has a comfortable target, strips and
  primary buttons show hover feedback, message roles reveal timestamps on
  hover, and the popover window pre-warms after launch so the first summon
  paints immediately.

## Your fold on the web

- On phones the return key writes a newline and the send button sends;
  hardware keyboards keep Enter-to-send with Shift+Enter for a new line.
- The browser back gesture walks Chat → Chats → Home instead of leaving the
  app, and a reload restores the screen and selected conversation.
- Draft text survives reloads and discarded tabs, the on-screen keyboard keeps
  the newest message visible, and scrolling past the top of a transcript no
  longer triggers the browser's pull-to-refresh.
- A sent message appears immediately as a pending bubble and returns to the
  composer — ahead of anything typed meanwhile — if it is not accepted.
- An expired session returns to sign-in once instead of repeating errors;
  reloading while the desktop is asleep keeps the app shell and its honest
  presence line; the offline gate continues to pairing by itself when the
  desktop comes online; a declined or expired pairing offers Try again with a
  fresh code.
- Returning from a locked phone or a network drop refreshes immediately and
  revives the event stream, and a waking desktop refreshes stale projections.
- Pending decisions badge the Home destination from every screen, and deciding
  a card shows a busy state.
- Loading states replace false empty answers, entering a chat lands on the
  newest message instantly, and a floating return-to-latest control appears
  after scrolling up.
- One oversized attachment no longer rejects its whole batch, banners carry a
  dismiss, touch targets grew to thumb size, sub-16px fields no longer trigger
  iOS page zoom, auth screens respect the notch, and iOS Chrome, Firefox, and
  Edge are named correctly in the pairing approval.

## Desktop app

- ⌘W closes the active surface tab and ⇧⌘W closes the window; ⌃Tab cycles
  tabs, ⌘1–9 jumps to one by position, ⌘T opens a new Chat tab, and ⌘. stops
  the running turn. The Keyboard Shortcuts window lists all of them.
- The chat composer takes focus whenever its tab becomes active, without
  stealing from a dialog or another text field. A failed send restores its
  message only into an empty composer — never over a newer draft — and puts
  the cursor back.
- In Files, arrow keys move the selection Finder-style without opening tabs,
  F2 renames, and Delete or ⌘⌫ deletes into the existing Undo window. Quick
  Look now works on nested rows, not only the top level.
- Extension questions ride the shared dialog contract: focus is contained,
  Escape cancels, and Enter answers an input.
- Settings tabs and choice groups answer to arrow keys, error banners carry a
  dismiss, the startup error state offers Try again, undo notices are no
  longer cut short by newer notices, and the glance panel closes on window
  resize instead of stranding its measured position.

## Safety and compatibility

- This pass changes renderer, popover, and hosted-client behavior only. No
  storage, trust, protocol, or release-lane contract changed, and the remote
  client's pinned copy and decision vocabulary are unchanged.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates are disabled; dormant Windows build code remains
  available for a future deliberate reactivation.
- The macOS updater still publishes Apple-silicon (`arm64`) artifacts only.

## Verification

- Node 24 dependency installation, TypeScript checks, full tests, and the
  high-severity dependency audit.
- The hosted client's bridge suite, including the updated composer-key
  contract.
- macOS Developer ID signing, hardened runtime, Apple notarization and
  stapling, Gatekeeper assessment, packaged-asset verification, updater
  metadata verification, release checksums, and remote digest audit.
