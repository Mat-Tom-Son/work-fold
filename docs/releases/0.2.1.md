# work-fold 0.2.1

August 4, 2026

work-fold 0.2.1 is the corrective release for Remote access address creation.
Version 0.2.0 exposed the setup UI in the packaged app but incorrectly expected
an enrollment credential from the release workstation's runtime environment.
An app launched normally from `/Applications` cannot receive that local
configuration, so **Create private address** failed before contacting the
bridge.

## Fix

- The packaged desktop no longer reads or sends a shared enrollment secret.
  Embedding such a credential in a publicly downloadable app would be
  extractable and would not create a meaningful authorization boundary.
- New-address creation is now controlled by an explicit server-side deployment
  switch. Closing enrollment leaves existing independently authenticated
  desktop devices and addresses working.
- The bridge keeps its atomic database uniqueness constraint for address names
  and now composes per-IP enrollment limits with a process-wide enrollment
  ceiling.
- Production qualification created a disposable address through the public
  `www.work-fold.com` bridge, verified that a second request for the same name
  was rejected, and removed the disposable account again.
- A packaging regression test fails if the desktop reintroduces an enrollment
  credential or enrollment header.

## Mac distribution

The Apple silicon app and DMG are Developer ID-signed by Team `464JD5K8DC`,
notarized by Apple, stapled, and accepted by Gatekeeper. The separate Mac feed
contains the DMG, updater ZIP, both blockmaps, `latest-mac.yml`, checksums, and
the machine-readable and human-readable release manifests from one verified
build.

This is an explicit Mac-first release. Windows signing and publication remain
deferred; no unsigned Windows installer is presented as a public release.

## Qualification

- TypeScript checks, the complete automated suite, and the bridge integration
  suite passed.
- Desktop preparation and the Electron packaging smoke lane passed.
- The production artifacts passed signing, hardened-runtime, Apple
  notarization, stapling, Gatekeeper, mounted-DMG, updater metadata, checksum,
  release-manifest, and remote digest verification gates.
