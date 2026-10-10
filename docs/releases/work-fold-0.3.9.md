# work-fold 0.3.9

August 31, 2026

work-fold 0.3.9 makes model controls truthful before the first message and
removes the remaining noise from Chat reasoning and tab controls.

## Immediate model controls

- New Space Chats show their saved model and supported reasoning levels before
  a conversation session exists.
- The fold popover does the same for its separately selected model and default
  reasoning level. Once a Chat starts, its live Pi session becomes authoritative.
- Model-setting changes refresh the composer immediately instead of waiting for
  a message round trip.

## Quieter Chats

- Streamed reasoning now shows only text supplied by the model. The hardcoded
  heading, brain icon, completion badge, fallback copy, and separate Activity
  surface are gone.
- The New Chat menu keeps **Group by Space** concise by removing its redundant
  explanatory line.
- Reasoning and model controls share consistent typography and alignment.

## Stable automatic titles

- After the first successful turn, that Chat's selected model gets one small,
  isolated request to create a specific short title.
- Manual and previously generated titles prevent another title request. If the
  model request fails, work-fold saves a bounded first-message fallback so it
  does not retry on later turns.

## Safety and compatibility

- Title generation uses the existing Pi model registry and credential path; it
  does not add a hidden provider or write its prompt into the conversation.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates remain disabled.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.

## Verification

- Node 24 TypeScript checks, the complete 1,000-test suite with one intentional
  skip, and a dependency audit with zero known vulnerabilities.
- Real-browser review of empty Space and fold Chats, the reasoning selector,
  inline reasoning output, and the New Chat menu.
- Desktop preparation, Electron preload and restricted-app sandbox smoke tests,
  plus the guarded macOS signing, notarization, packaging, updater, checksum,
  and remote-digest release lanes.
