# work-fold 0.2.0

August 4, 2026

work-fold 0.2.0 introduces private-alpha Remote access, so an approved browser
can use the same management conversation and inspect bounded Space file trees
while the desktop remains the local execution endpoint. It also tightens the
desktop and browser chat experience, makes saved settings feel saved, and
refreshes the public work-fold site around ordinary desktop folders.

## Highlights

- Create a private `<name>.work-fold.com` address from Settings with a password,
  then approve each new browser by matching a one-time code on the desktop.
  Approved browsers remain paired until they are individually revoked, every
  browser is revoked, Remote access is disabled, or the address is removed.
- The hosted bridge relays a closed set of signed, application-encrypted
  browser-to-desktop operations. It stores authentication, grant, session, and
  bounded operation metadata in PostgreSQL, while prompts, replies, Space
  names, file names, and file contents are not durably stored by the bridge.
- The remote browser uses the real saved management conversation: messages and
  Assistant replies synchronize between the web and menu-bar surfaces, Markdown
  is rendered, Enter sends, Shift+Enter adds a line, and **New chat** starts a
  clean saved conversation without deleting the previous transcript.
- Remote Space selection is explicit and preserved through the management turn,
  so requests referring to the Space visible in the browser inspect that Space
  instead of an unrelated registered folder. The browser can also show a
  filtered, bounded file tree without exposing absolute local paths.
- The web chat has a quieter header and composer, clearer send behavior, the
  work-fold app icon, and a simplified connection surface. The public landing
  page now leads with working from desktop folders and links directly to the
  latest Mac download and the GitHub repository.
- Settings tabs are compact again, the modal close control is aligned, saved
  fields give immediate confirmation, unchanged forms no longer imply pending
  work, and an existing provider credential must be explicitly removed before
  a replacement can be entered. Remote-access enrollment configuration is
  build-owned rather than asking the person for an invitation code.
- The menu-bar chat refreshes reliably while open, records accepted user turns
  immediately, and follows the same transcript and conversation-switching rules
  as the hosted browser.
- Reviewed dependency normalization now includes the current `brace-expansion`
  and `undici` fixes used by the packaged native Pi runtime.

## Private-alpha authority boundary

Remote access is optional and disabled by default. An approved browser can send
requests to the same full-trust management Assistant that runs locally, so only
browsers you control should be approved. Signed encrypted envelopes reduce
plaintext persistence and passive relay visibility, but the hosted client and
bridge remain trusted parts of this private alpha and do not protect against an
active hosted-service compromise. The desktop must be online to execute work.

## Mac distribution

The Apple silicon app and DMG are Developer ID-signed by Team `464JD5K8DC`,
notarized by Apple, stapled, and accepted by Gatekeeper. The separate Mac feed
contains the DMG, updater ZIP, both blockmaps, `latest-mac.yml`, checksums, and
the machine-readable and human-readable release manifests from one verified
build.

This is an explicit Mac-first release. Windows signing and publication remain
deferred; no unsigned Windows installer is presented as a public release.

## Qualification

- TypeScript checks and the complete automated suite passed.
- Desktop preparation and the Electron packaging smoke lane passed.
- The production artifacts passed signing, hardened-runtime, Apple
  notarization, stapling, Gatekeeper, mounted-DMG, updater metadata, checksum,
  release-manifest, and remote digest verification gates.
