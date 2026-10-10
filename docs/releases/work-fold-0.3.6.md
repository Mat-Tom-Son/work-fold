# work-fold 0.3.6

August 23, 2026

work-fold 0.3.6 brings the desktop Assistant much closer to native Pi while
making the everyday organization of Skills, Extensions, and Space apps clearer.
It also introduces the new work-fold application icon.

## Assistant parity

- Assistant shell commands now inherit the login-shell environment even when
  work-fold starts from Finder or the Dock, so familiar tools such as Node,
  npm, and GitHub CLI remain available.
- Turns no longer have a work-fold wall-clock limit by default. An optional
  environment setting can still apply one when a bounded runtime is wanted.
- Pi's proxy handling and guarded network dispatcher are used by the desktop,
  and each Chat now exposes and remembers its thinking level.
- Enter during a turn steers the Assistant after its current step, while
  Command-Enter queues a message for after the turn.
- PNG, JPEG, GIF, and WebP attachments reach the model as images, pasted
  screenshots use the normal Dropped-material flow, and every text segment in
  an Assistant response is retained in the saved transcript.

## Faster, smaller History

- History checkpoints now skip dependency trees, Git data, virtual
  environments, caches, and ignored folders while keeping individual ignored
  files recoverable.
- File hashing is parallel and large files are streamed, substantially reducing
  checkpoint size and capture time on development Spaces.

## Skills & Extensions

- Installed tools are grouped as **Everywhere** and **This Space only**, with
  their location chosen once during review.
- Discover cards are leaner, with clearer provenance, focused detail dialogs,
  and direct source links.
- Imported Skills can now be removed from their Details dialog. Removal stays
  inside work-fold's managed Skill roots, including when folders contain
  symbolic links.

## Apps and App Studio

- Space apps now have their own **Apps** tab, separate from Skills & Extensions.
  **Build with Assistant** opens a fresh Chat with a ready-to-edit starting
  request.
- App Studio is reached from an app's details, has a simpler editor, offers the
  full icon catalog, and follows manifest-authored name, description, and icon
  values until they are edited by hand.
- Product-facing app copy is plainer while the existing protected local runtime
  and explicit grants remain intact.

## New icon

- The macOS app, installer, and disk image now use the new Default work-fold
  icon supplied through the shared brand pack.

## Safety and compatibility

- Skill removal resolves real filesystem paths before recursive deletion so an
  intermediate symbolic link cannot redirect removal outside its managed root.
- This is an in-place work-fold update. It does not read, migrate, or modify
  legacy Workspace application state or `.workspace/` metadata.

## Current limitations

- macOS is the only active CI packaging and public distribution lane. Windows
  workflows and release gates are disabled; dormant Windows build code remains
  available for a future deliberate reactivation.
- The macOS updater publishes Apple-silicon (`arm64`) artifacts only.

## Verification

- Node 24 dependency installation, TypeScript checks, the complete 985-test
  suite, and the high-severity dependency audit.
- Desktop preparation, Electron preload and restricted-app sandbox smoke tests,
  and focused shell-environment, Skill-removal, and brand-asset coverage.
- macOS Developer ID signing, hardened runtime, Apple notarization and
  stapling, Gatekeeper assessment, packaged-asset verification, updater
  metadata verification, release checksums, and remote digest audit.
