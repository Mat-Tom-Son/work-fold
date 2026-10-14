# work-fold 0.3.12

August 31, 2026

work-fold 0.3.12 makes new Chat naming reliable, cleans up the Assistant work
trail, and adds durable per-Space instructions that the fold can manage.

## Reliable new Chat titles

- The one title request after a Chat's first successful turn now leaves enough
  output headroom for reasoning models to return the actual title.
- Title generation uses provider-compatible defaults instead of forcing an
  optional sampling setting that some models reject.
- Existing Chats are left untouched, and a title failure is still recorded once
  rather than retried on every turn.

## A clearer Assistant work trail

- Reasoning text repairs stray Markdown markers after parsing without changing
  valid emphasis, inline code, or fenced code blocks.
- Tool calls use concise labels such as **Read file** and **Ran command**, with a
  small completion mark and the useful invocation target.
- Raw command output and file contents no longer leak into the compact tool-call
  summary; the Assistant response remains the readable result.

## Per-Space Assistant instructions

- **Settings → Assistant** now includes custom instructions for each Space.
  They are stored locally by the Space's portable identity and apply to
  subsequent turns in that Space.
- Model choices remain per Space and are explicitly described as defaults for
  new Chats.
- The fold can inspect and update a Space's model and instructions through the
  authenticated management lane. Those writes use the same mutation fence and
  durable receipt path as other managed changes.
- Provider credentials and connection setup remain human-only in Settings; the
  fold can choose only from models whose provider is already connected.

## Privacy and compatibility

- Space instructions are machine-local application state. Like any system
  prompt, they are sent to the selected model provider when that Space chats.
- Management receipts record only the model identifier or instruction character
  count, never the instruction text.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates remain disabled.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.

## Verification

- Node 24 TypeScript checks, the complete 1,006-test suite with one intentional
  skip, and the high-severity dependency audit with zero vulnerabilities.
- Focused coverage for reasoning-model title generation, safe Markdown repair,
  bounded tool summaries, per-Space preference isolation, management commands,
  mutation fencing, and content-free receipts.
- Real-browser review of the cleaned work trail and the per-Space Assistant
  settings at production desktop dimensions.
- Desktop preparation plus the guarded macOS signing, notarization, packaging,
  updater, checksum, and remote-digest release lanes.
