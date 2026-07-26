# macOS release runbook

This runbook publishes the Apple silicon Workspace artifacts to the separate public feed at [`Mat-Tom-Son/workspace-mac-releases`](https://github.com/Mat-Tom-Son/workspace-mac-releases). Windows artifacts continue to use the source repository's releases. Both platforms use the same `package.json` version.

## One-time workstation setup

1. Install the `Developer ID Application: James Thompson (464JD5K8DC)` certificate and private key in the login Keychain.
2. Store notarization credentials with `xcrun notarytool store-credentials`. The existing local profile is `kai-workspace-notary`; profile names are not product-scoped.
3. Create ignored `.env.macos.local` using the non-secret variable template in [macOS build and release lane](macos-build.md).
4. Confirm `gh auth status` uses the `Mat-Tom-Son` account and that the Mac feed repository is public.

Do not export or commit the certificate, private key, app-specific password, or notary credentials.

## Release procedure

1. Sync `main`, complete the shared version bump/release notes, and finish the Windows/source-repository work for that version.
2. Run the normal gates with Node 24:

   ```bash
   npm ci
   npm run check
   npm test
   npm audit --audit-level=high
   ```

3. Confirm the worktree is clean and `HEAD` is pushed to `origin/main`.
4. Build, verify, and publish in one command:

   ```bash
   npm run desktop:release:mac
   ```

5. Confirm the command reports a public, non-draft `v<version>` release. It must contain the DMG, ZIP, both blockmaps, `latest-mac.yml`, checksums, and both release manifests.
6. Install or update the app, then verify the exact installed bundle:

   ```bash
   npm run desktop:verify:installed:mac
   ```

7. Open Workspace normally and check **Settings > About** and **Workspace > Check for Updates...**.

The publisher refuses a dirty/unpushed source tree, a source tag that does not point at the exact release commit, a missing/draft/incomplete Windows source release, a private Mac feed, an existing Mac tag, an unsigned manifest, a missing asset, or any remote size/digest mismatch. Installer-only artwork is generated under ignored `out/` build output so the release build cannot dirty its own source checkout. The publisher uploads a draft first and publishes only after every Mac asset's GitHub SHA-256 matches the local file.

## Updater evidence

Repeat a lower-version-to-current installed update whenever updater code, Electron, Electron Builder, signing identity, bundle id, feed, artifact names, or Squirrel.Mac behavior changes.

The accepted proof must show:

- the lower app is Developer ID-signed, notarized, stapled, and installed under `/Applications`;
- `Contents/Resources/app-update.yml` names `Mat-Tom-Son/workspace-mac-releases`;
- the lower app's update command offers the expected higher version and the Settings update surface reports the same state (version 0.2.9 uses **Help > Check for Updates...**; version 0.2.10 and later use **Workspace > Check for Updates...** with a native dialog);
- the cached ZIP SHA-256 equals the published GitHub asset digest;
- Workspace shuts down, replaces the app, and relaunches at the higher version;
- `npm run desktop:verify:installed:mac` passes;
- a full quit and reopen does not ask for repeated Keychain passwords.

Workspace 0.2.8 to 0.2.9 and 0.2.9 to 0.2.10 passed this proof on July 15, 2026. For 0.2.10, the installed 0.2.9 app discovered the public release, cached the final updater ZIP with SHA-256 `35f359e4042a0feaccd75feaca18ab0064d1c85b2500ee99295fdab773c62234`, replaced and relaunched `/Applications/Workspace.app`, passed installed-bundle verification, preserved the empty Space registry, survived last-window close/reopen in one process, and completed a full quit/reopen without a SecurityAgent or Keychain dialog. `updateNow()` intentionally downloads and restarts from one user action.

Workspace 0.2.10 to 0.2.11 passed the same proof on July 15, 2026. The installed 0.2.10 app offered 0.2.11 from **Workspace > Check for Updates...**, downloaded a ZIP whose SHA-256 matched the published GitHub digest `adeb9fac93452443d72364b85e2bc7ef07b2f0f1b09025aaa8dd302c0b3da6b7`, replaced itself, and relaunched as 0.2.11. Installed-bundle verification passed, the registered Space retained the same identity, application-menu Quit and Command-Q exited on their first request, the Dock/system termination path exited, and closing then reopening the last window reused the same process. No SecurityAgent or Keychain dialog appeared.

Workspace 0.2.11 to 0.3.0 passed the same proof on July 16, 2026. The installed 0.2.11 app offered 0.3.0 from **Workspace > Check for Updates...**, downloaded a ZIP whose SHA-256 matched the published GitHub digest `d8bb801498c2823f54b10340395b0ee2428b3154c33c0b4b49658106c269bcea`, replaced itself, and relaunched as 0.3.0. Installed-bundle verification passed; the registered Space retained the same identity and its 25-capability projection remained unchanged. Native About reported 0.3.0, the update command reported the app current, application-menu Quit, Command-Q, and the Dock/system termination path exited, and closing then reopening the last window reused the same process. No SecurityAgent or Keychain dialog appeared.

Workspace 0.4.0 to 0.4.1 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.0 app exposed a visible frontend button labeled **Download Workspace 0.4.1**. One click advanced through live download progress, entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched as 0.4.1. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `b2735c92f0a1cf73fb7e6abef8a413beeea7fd45c19d2e188d9de5b656396044`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, and Gatekeeper acceptance. A full quit and normal reopen kept 0.4.1 running and produced no SecurityAgent or Keychain dialog.

Workspace 0.4.1 to 0.4.2 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.1 app reported 0.4.2 available after **Settings > Desktop > Check for updates**, then exposed the visible frontend **Download update** button. Clicking that button entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.2. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `76aafcceaeb68836c21a81959705934bad53a263b8a8c220df04e308ab05cd7c`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.2, the registered Space reopened, and a full Command-Q exit followed by a normal cold launch produced a fresh 0.4.2 process with no SecurityAgent or Keychain dialog.

Workspace 0.4.2 to 0.4.3 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.2 app discovered the public Mac feed at launch and exposed the visible frontend **Download Workspace 0.4.3** button. Clicking that button closed the renderer for the updater handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.3. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `767ee2b0483a249452fb0b7888d5e3061a875b391c0ade796bfc7e11bc8425c2`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.3, Settings > Desktop reported the app current, and the registered Space, Chats, provider selection, imported Skill, and restricted-app preview remained available. A full quit and normal cold launch produced a fresh 0.4.3 process with no SecurityAgent process or Keychain dialog.

Workspace 0.4.3 to 0.4.4 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.3 app reported 0.4.4 available after **Settings > Desktop > Check for updates**, then exposed the visible frontend **Download update** button. Clicking that button showed live download progress, entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.4. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `072301488814d79dc176ad5f2935a663a635cfee7899252c3bb3b40bcc428702`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.4, the registered Space and open tabs were restored, and the redesigned rail loaded without the former standalone Capabilities entry. A full quit and normal cold launch produced a fresh 0.4.4 process with no SecurityAgent process or Keychain dialog.

Workspace 0.4.4 to 0.4.5 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.4 app reported 0.4.5 available after **Settings > Desktop > Check for updates**, then exposed the visible frontend **Download update** button. Clicking that button showed live download progress, entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.5. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `0e8f75d8cb08a230ee788f861e7cd3b0e8a43c31374d4d1937d0037703499a1e`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, a valid notarization staple, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.5; the registered Space and open tabs were restored; Library appeared as one Space-owned tab backed by the shared personal collection; the permanent Library rail destination was gone; and reopening Library from **Add or manage** reused the existing tab. A full Command-Q exit followed by a normal cold launch produced a fresh 0.4.5 process, restored the Library tab, and produced no SecurityAgent process or Keychain dialog.

Workspace 0.4.5 to 0.4.6 passed the same proof on July 25, 2026. The installed, Developer ID-signed and notarized 0.4.5 app reported 0.4.6 available after **Settings > Desktop > Check for updates**, then exposed the visible frontend **Download update** button. Clicking that button showed live download progress, entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.6. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `792ba3d2f130d3dddd4aae4ff07c85c16bc8172b9e74efc9e967cdbf1f71ad47`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, a valid notarization staple, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.6 and Settings > Desktop reported the app current. The registered Space, Space-owned Library and Assistant tools tabs, restricted QA Checklist tab and local state, and completed Chats all survived the update and cold launch. Real Assistant turns from both an existing Chat and a fresh draft completed in the background without taking focus from Library or Assistant tools, while the Chat tabs exposed working and finished states and persisted their correct file-backed results. A full Command-Q exit followed by a normal cold launch restored the tabs and restricted-app state under a fresh 0.4.6 process with no SecurityAgent process or Keychain dialog.

Workspace 0.4.6 to 0.4.7 passed the same proof on July 26, 2026. The installed, Developer ID-signed and notarized 0.4.6 app discovered the public Mac feed and exposed the visible frontend **Download Workspace 0.4.7** button. Clicking that button downloaded the published update, entered the updater shutdown handoff, replaced `/Applications/Workspace.app`, and relaunched under a new process as 0.4.7. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `da4c3d48d04c06d540a5c1106b83a4ba27aa0027232f24baa0337c79fe2b6f19`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, a valid notarization staple, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.7 and Settings > Desktop reported the app current. The registered Spaces, files, open Chats, provider selection, Space-owned Library and Assistant tools tabs, personal and Space Skills, and restricted QA Checklist app and local state all survived. The installed release loaded the 262-entry Discover catalog, exercised the redesigned Installed view, applied and undid a Space color preset and searched icon, and completed a real provider-backed Assistant turn with the expected result. A full application-menu Quit followed by a normal cold launch produced a fresh 0.4.7 process, restored the tabs, completed Chat, and restricted-app state, and produced no SecurityAgent process or Keychain dialog.

Workspace 0.4.7 to 0.4.8 passed the same proof on July 26, 2026. The installed, Developer ID-signed and notarized 0.4.7 app reported 0.4.8 available after **Settings > Desktop > Check for updates**, then exposed the visible frontend **Download update** button. Clicking that button showed live download progress, replaced `/Applications/Workspace.app`, and relaunched from process 89538 under process 14162 as 0.4.8. Both cached updater ZIPs and the local release ZIP matched the published GitHub digest `df31dd870324a931a3da118a27660bf255e3037e2a4938b38dd8212d9c16f199`. Installed-bundle verification passed with bundle id `io.github.mattomson.workspace`, Team ID `464JD5K8DC`, the public Mac feed, a valid notarization staple, notarized Developer ID Gatekeeper acceptance, and no Keychain secret access. Settings > About reported 0.4.8 and Settings > Desktop reported the app current. The installed release verified the streamlined rail and compact Space menu on ordinary, management, appearance, and restricted-app tabs; light and dark message readability; the hover-only icon Copy control and clipboard result; all eight curated Looks and Harbor persistence; active-Space-first Chats with a collapsed, expandable other-Space group; preserved QA Checklist local state; and a real provider-backed QA Space turn returning `qa-space-048-smoke`. Two full quit and normal cold-launch cycles produced fresh 0.4.8 processes, restored open tabs and restricted-app state, and produced no SecurityAgent process or Keychain dialog.

## Recovery rules

- Never replace assets in a published release. Correct a bad release with a higher shared version.
- A failed draft may be deleted only after confirming it was never published or consumed by an installed app.
- If a build fails after the DMG was notarized, rerun the finalizer. It detects an already valid signed/stapled DMG and refreshes only updater metadata.
- Never rename or install `Workspace Local Smoke.app` over the production app. A user-data override does not isolate Keychain; use the signed candidate or a disposable macOS account for interactive testing.
- If repeated Keychain prompts occur after replacing an old ad hoc build, quit Workspace and run `npm run desktop:reset:mac-safe-storage -- --yes --reopen`. Do not read the secret with `security ... -g`.
- The current public lane is arm64 only. Do not publish x64 until an Intel Mac passes launch and updater smoke.

## Release ownership

The source repository owns code, Windows releases, issues, and documentation. `workspace-mac-releases` is an artifact feed only. Do not develop or hand-edit release metadata in the feed repository, and do not add a second tag workflow that competes with the Windows publisher.
