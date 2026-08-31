# work-fold 0.3.11

August 31, 2026

work-fold 0.3.11 makes active Assistant work visible again, repairs automatic
Chat naming, and gives the fold a smaller, more familiar conversation layout.

## Visible Assistant work

- Space Chats show a compact **Thinking…** trail while reasoning is active and
  retain the model-supplied reasoning text after it settles.
- Real tool calls appear in that same trail with their bounded runtime detail
  and queued, running, completed, or failed state.
- The work trail has no brain icon, synthetic reasoning copy, oversized status
  card, completion badge, or separate Activity drawer.

## Reliable automatic titles

- The one title request after a Chat's first successful turn now uses the live
  Pi session's authenticated model transport, including OpenRouter models from
  the refreshed catalog.
- A failed title request leaves the Chat as **New Chat** and is recorded once;
  later turns do not silently retry it or present the first message as a title.
- Existing titles created by the old first-message fallback become eligible for
  one real model-generated replacement without overriding manual renames.

## A cleaner fold chat

- Person messages are colored bubbles aligned right, while Assistant replies
  are unboxed and aligned left. Redundant speaker labels and divider lines are
  gone.
- Streaming text, activity, and transcript changes follow the bottom of the
  conversation automatically, while deliberate scrollback remains respected.
- Running work uses one compact live line so the transcript and composer retain
  the popover's limited space. The composer's action still becomes **Stop** for
  the active request.

## Safety and compatibility

- Title generation stays isolated from the visible transcript and cannot turn
  a successful Assistant response into a failed turn.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates remain disabled.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.

## Verification

- Node 24 TypeScript checks, the complete 1,002-test suite with one intentional
  skip, and the high-severity dependency audit.
- Focused coverage for live title transport, one-time failure recording, legacy
  fallback repair, real reasoning/tool activity, compact fold geometry, and
  streaming-aware autoscroll.
- Real-browser review of running and settled work trails plus the menu-bar fold
  at its production dimensions.
- Desktop preparation, Electron preload and restricted-app sandbox smoke tests,
  plus the guarded macOS signing, notarization, packaging, updater, checksum,
  and remote-digest release lanes.
