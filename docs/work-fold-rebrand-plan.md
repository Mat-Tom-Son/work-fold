# work-fold rebrand and clean-break launch plan

> **Mac launch status — August 1, 2026.** The public source and Mac artifact
> repositories are live, the legacy repositories are archived with redirects,
> and signed/notarized/stapled 0.1.1 completed the installed 0.1.0 to 0.1.1
> update and clean-profile/coexistence gates. The canonical domain is exactly
> [work-fold.com](https://work-fold.com); website work remains intentionally
> outside this implementation. Windows packaging and signing were explicitly
> deferred by the owner and remain a later platform operation.
>
> **Audited baseline:** `package.json` version `0.8.0` plus the current
> in-flight working-tree changes, including management conversation
> attachments, request lineage, menu-bar/tray management popover, generated
> template icons, supporting tests, and documentation. These changes are part
> of the first work-fold build. Record the exact accepted baseline commit
> before implementation begins.

## 1. Executive decision

Workspace becomes **work-fold**, always lowercase and always written with an
ASCII hyphen. A folder-backed working context remains a **Space**.

The first work-fold build is a clean new application identity, not an in-place
data migration and not an updater-driven wipe:

- work-fold receives new desktop, package, command, state, protocol,
  persistence, credential, and release identities;
- it starts with an empty Space registry, Chats, History, Library, product
  settings, Checks, App Platform state, product connections, restricted-app
  state, and renderer persistence;
- it does not import, mutate, or delete the former application profile;
- it never recursively deletes previously registered ordinary folders;
- it writes portable Space records beneath `.work-fold/`;
- `.workspace/` stays hidden, excluded, and non-authoritative;
- the final legacy application and work-fold may coexist safely until the three
  current testers remove the old app and demo state explicitly; and
- old updater feeds are frozen after one containment release, so the old app
  can never ingest a work-fold artifact.

Native Pi personal scope is the deliberate exception to application-profile
isolation. Pi's standard personal Skills, Extensions, model registry, settings,
and supported native auth remain under Pi's configured agent directory and may
be visible to both products. Pi's agent root stays shared, but work-fold session
files use a product namespace such as
`<pi-agent-dir>/sessions/work-fold/<space-key>` so the same folder cannot resume
or overwrite an old session. work-fold gets fresh Electron `safeStorage`
credentials and fresh product-owned registries, profiles, tasks, session
pointers, and overrides. Preserve `PI_CODING_AGENT_DIR`; rename
`WORKSPACE_AGENT_DIR` to `WORKFOLD_AGENT_DIR` with no fallback to the old
variable.

The lack of meaningful production data makes this clean break practical. It
does not weaken the permanent product boundary: linked Space folders belong to
the person, not the application.

## 2. Naming and language contract

| Context | Canonical form | Rule |
|---|---|---|
| Product display name | `work-fold` | Lowercase, including sentence starts |
| Spoken name | “workfold” | Pronunciation only, never display spelling |
| Possessive | `work-fold’s` | Typographic apostrophe where supported |
| Domain | `work-fold.com` | Purchased; public roles remain to be assigned |
| CLI | `work-fold` | No `workspace` compatibility alias |
| PascalCase product code | `WorkFold` | Product-wide identities only |
| camelCase product code | `workFold` | Product-wide identities only |
| Environment prefix | `WORKFOLD_` | Product-owned environment variables |
| Package slug | `work-fold-desktop` | Fixed package identity |
| Repository slug | `work-fold` | New source and Windows release repository |
| Folder-backed object | `Space`, `space`, `spaceId`, `spaceRoot` | Never call a Space a workspace |
| Working launch line | “Turn any folder into a place to work.” | Final copy review required |

Forbidden active display spellings are `Workspace`, `Work-Fold`, `Work-fold`,
`Workfold`, `workfold`, and `Work Fold`. Historical evidence and coexistence
safety literals are narrowly allowlisted by path and purpose.

The hyphen is part of the accessible identity, not decorative punctuation. Do
not replace it with an en dash or em dash in strings, URLs, commands, metadata,
or filenames. A wordmark may treat it visually as a hinge or fold.

The established product model remains intact:

- **Space** — one ordinary folder-backed working context;
- **Files**, **Chats**, and **History** — the stable primary rail;
- **Library** — passive personal material copied explicitly into a Space;
- **Checks** — manual expectations over explicitly designated files;
- **Assistant** and **Assistant tools** — the helper and capability surface;
- **Skill** and **Extension** — Pi-native ways of working and capabilities; and
- **App Project**, **Feature**, **Release**, **App Instance**, and
  **Development Instance** — the existing App Platform lifecycle.

Every old `workspace` token must be classified semantically:

1. Product proper noun → `work-fold`, `WorkFold`, or `workFold`.
2. Folder-backed context → `Space`, `space`, `spaceId`, or `spaceRoot`.
3. Whole shell → `app`, `desktop`, `product`, or `WorkFold`.
4. Genuine external/generic workspace → retain only where it is truly the
   third party's term, such as `github.workspace` or Electron's
   `setVisibleOnAllWorkspaces`.
5. Historical evidence → preserve and label as historical.

A blind replacement is prohibited; it would create product names where the
domain actually requires Space terminology.

## 3. Locked identity map

These values should live in one checked-in identity authority and be consumed
by build, runtime, packaging, and verification code wherever possible.

| Current | work-fold identity | Class |
|---|---|---|
| Product `Workspace` | `work-fold` | Brand |
| npm `workspace-desktop` | `work-fold-desktop` | Package |
| `Workspace.app` / `Workspace.exe` | `work-fold.app` / `work-fold.exe` | Artifact |
| Windows release artifacts | `work-fold-Setup-<version>.exe` and `.exe.blockmap` | Published artifacts |
| Mac release artifacts | `work-fold-<version>-mac-<arch>.dmg` / `.zip` plus matching blockmaps | Published artifacts |
| Update metadata | `latest.yml` / `latest-mac.yml` | Feed metadata |
| Checksums | `SHA256SUMS.txt` / `SHA256SUMS-mac.txt` | Release evidence |
| Mac release manifest | `work-fold-mac-release-manifest.json` / `.txt` | Release evidence |
| `Workspace Local Smoke` | `work-fold Local Smoke` | QA product |
| `Workspace Development` | `work-fold Development` | Development profile |
| `io.github.mattomson.workspace` | `com.work-fold.desktop` | Production app/bundle ID |
| `io.github.mattomson.workspace.local-smoke` | `com.work-fold.desktop.local-smoke` | Smoke ID |
| `workspace-desktop-updater` | `work-fold-desktop-updater` | Updater cache |
| old application-data root | lowercase `work-fold` | Machine state |
| `Workspace Safe Storage` / `Workspace Key` | `work-fold Safe Storage` / `work-fold Key` | Credential encryption |
| old encrypted credential paths | new work-fold profile paths | Product credentials |
| `workspace` / `workspace.cmd` | `work-fold` / `work-fold.cmd` | CLI shims |
| `workspace-cli.ps1` / `.jxa.js` | `work-fold-cli.ps1` / `.jxa.js` | Private helpers |
| `WORKSPACE_*` | `WORKFOLD_*` | Product environment |
| `workspace-desktop://` | `work-fold-desktop://` | Internal Electron scheme |
| `workspace:*` | `work-fold:*` | IPC namespace |
| `window.workspaceDesktop` | `window.workFoldDesktop` | Renderer bridge |
| `globalThis.workspaceRestrictedApp` | `globalThis.workFoldRestrictedApp` | App bridge |
| `/api/workspaces` | `/api/spaces` | Local HTTP |
| `x-workspace-session` | `x-work-fold-session` | Local session header |
| `workspaceId` / `workspaceRoot` | `spaceId` / `spaceRoot` | Space domain |
| `workspaces` collection | `spaces` | Space domain |
| `workspace-registry.json` | `space-registry.json` | Machine state |
| `state/workspaces/` | `state/spaces/` | Machine state |
| `state/workspaces/<key>/ignore.json` | `state/spaces/<key>/ignore.json` | Machine-local ignore state |
| `.workspaceignore` icon mapping | Remove stale mapping | Not an active format |
| `.workspace/` | `.work-fold/` | Portable product metadata |
| `.workspace.json` proposal | `.work-fold-appearance.json` | Appearance export |
| `.workspace-check.json` | `.work-fold-check.json` | Check export |
| `workspace.space-appearance` | `work-fold.space-appearance` | Format kind |
| `workspace.check-proposal` | `work-fold.check-proposal` | Check proposal kind |
| `workspace.check` | `work-fold.check` | Check declaration kind |
| `workspace.checks.experimental` | `work-fold.checks.experimental` | Check snapshot kind |
| `workspace.checks.renderer` | `work-fold.checks.renderer` | Check snapshot kind |
| `workspace.checks.decorations` | `work-fold.checks.decorations` | Check snapshot kind |
| `workspace.file-presence` | `work-fold.file-presence` | Sensor ID |
| `workspace.context` and peers | `work-fold.context` and peers | Management snapshots |
| resolution `workspace_id` | `space_id` | Management resolution |
| renderer `workspace.*` keys | `work-fold.*` | Fresh local persistence |
| `application/x-workspace-path` | `application/x-work-fold-space-path` | Drag contract |
| mode `workspaces` / action `switch-workspace` | `spaces` / `switch-space` | UI state |
| `Workspace-Capability-Registry` | `work-fold-Capability-Registry` | Network User-Agent |
| `manage-workspaces` Skill | `manage-spaces` | Product language |

Do not rename genuinely portable standards just to carry the brand: `.pi/`, Pi
scopes and APIs, `SKILL.md`, provider variables, signing standards,
`agent-app.json`, and third-party workspace terms remain. Prefer neutral
`agent-app-*` naming for truly portable App Platform artifact/digest/MIME
contracts; lock each branded-versus-neutral decision before implementation.

## 4. Decisions still requiring owner sign-off

| Decision | Recommendation | Deadline |
|---|---|---|
| Trademark/common-law clearance | Professional knock-out search for software/computer services; punctuation may not distinguish marks | Before final art or public announcement |
| First version | Choose continued `0.x`, reset, or `1.0.0`; do not infer from the rename | Before package changes |
| Source repository | Freeze `Mat-Tom-Son/workspace` without renaming; create `Mat-Tom-Son/work-fold` from accepted history | Before workflows/links change |
| Release feeds | Windows at `Mat-Tom-Son/work-fold`; Mac at `Mat-Tom-Son/work-fold-mac-releases`; freeze both old feeds | Before packaging changes |
| Website roles | Assign home, download, docs, privacy, security, support, and release URLs; define `www` redirect | Before public launch |
| Support identity | Decide `support@work-fold.com` and `security@work-fold.com` versus GitHub-only support | Before policy pages |
| Visual system | Wordmark, fold mark, palette, type guidance, spacing, motion, and voice | Before renderer restyling |
| First-launch copy | Fresh-start explanation without displaying the old brand | Before release candidate |

Exact app identities, lowercase profile names, package slug, CLI, and release
topology are locked by this plan rather than left as implementation options.

## 5. Launch baseline and source-control choreography

The current in-flight management work is part of work-fold and must not first
ship as an old-brand feature.

1. Finish review of the current working-tree changes.
2. Land them as one accepted baseline without publishing an old-brand artifact.
3. Record the exact commit as `WORK_FOLD_BASELINE_SHA` in the implementation
   issue or rebrand PR description; do not make this a runtime variable.
4. Recompute the active-surface inventory from that commit.
5. Create the rebrand branch from that exact commit.
6. Freeze unrelated feature additions until identity foundations compile and
   pass tests. Later features use work-fold vocabulary only.
7. Keep feature and identity commits distinct where practical so review stays
   intelligible.

The launch baseline explicitly includes:

- `desktop/src/management-popover.ts` and its preload;
- `src/local/management-attachments.ts`;
- `src/local/management-requests.ts`;
- `web-local/popover.html` and `web-local/src/popover/`;
- attachment, request, and management API tests;
- menu-bar template icon generation and package verification; and
- modified management prompts, CLI act behavior, preload bridge, local API,
  product model, management guide, architecture, UI parity, policies, and
  README.

The final legacy containment release described below is cut from the last
published old version with only its narrow safety patch. It does not absorb or
publish this in-flight feature baseline.

## 6. Dependency-ordered implementation phases

### Phase 0 — Brand, release, and contract ledger

Deliver:

- approved lowercase naming guide and trademark result;
- version, repository, feed, URL, support, signing, and machine token map;
- wordmark/icon brief and accessibility requirements;
- path-and-purpose-scoped historical allowlist;
- accepted baseline SHA; and
- a contract ledger recording every serialized current/new kind and version,
  storage path, reader policy, writer policy, and conformance test.

Keep CLI read protocol version `1` and act protocol version `2`. New
`work-fold.*` management snapshot kinds may start at snapshot version `1`.
Never change a serialized shape while retaining its kind/version.

Exit gate: every open row has one approved value and owner.

### Phase 1 — Identity and clean persistence boundaries

Establish before visible copy changes:

- new app-data, development, smoke, managed-content, CLI broker, updater cache,
  product-task, Pi-session, credential, and renderer-storage namespaces;
- production `com.work-fold.desktop` and smoke
  `com.work-fold.desktop.local-smoke` identities;
- new AppUserModelID, package, single-instance authority, executable, internal
  scheme, command, feed, and Safe Storage identities;
- `.work-fold/` paths plus new `space-registry.json`;
- shared native Pi resource/config/auth inputs and `PI_*` controls, but a new
  `sessions/work-fold/` namespace and no old product override fallback;
- no import of old profile state or old renderer storage;
- built-in `.work-fold/` self-exclusions plus old `.workspace/` safety
  exclusions without parsing either tree, including case-variant direct paths
  on Windows; and
- removal of normal-startup migration readers that would adopt old state.

Tests must prove:

- old profiles, keys, credential blobs, and Pi session files retain every byte;
- the same folder starts a new work-fold Pi session rather than resuming an old
  one; and
- after explicit folder registration, every pre-existing descendant retains its
  bytes, timestamps, and path; only new `.work-fold/` records may be added.
  Root-directory mtime/ctime may change unavoidably when the new child is
  created and is not asserted unchanged.

Primary authorities include `package.json`, lockfile, Electron Builder, Forge,
`desktop/src/main.ts`, `desktop/src/user-data-path.ts`, state paths, dev options,
`src/local/agent/agent-data-dir.ts`, and their tests.

Exit gate: development work-fold starts fresh beside an old profile and cannot
read, mutate, or delete it.

### Phase 2 — Core Space-domain refactor

Rename the folder domain in one controlled pass:

- `src/local/workspace.ts` → `src/local/space.ts`;
- registry, manifest, entry, location, removal, checkpoint, watch, ignore, and
  path authorities to Space terminology;
- `workspaceId`, `workspaceRoot`, source/target fields, summaries, entries, and
  collections to Space names;
- per-Space renderer types, hooks, props, modes, CSS variables, storage keys,
  fixtures, and focused tests; and
- per-Space services to Space names; product-wide services to responsibility
  names. The product kernel rename belongs to Phase 3.

Phases 2–5 are one non-releasable integration sequence. Phase 2's gate applies
to core Space modules only, with a narrow temporary contract allowlist until
the global no-`workspaceId` gate after Phase 5. Do not add dual-read aliases to
make an intermediate phase pass.

Exit gate: core folder authority/removal tests pass with `spaceId`.

### Phase 3 — Management, CLI, and Assistant contract

Land atomically because Assistant instructions invoke the command:

- product kernel, CLI adapter, snapshot kinds/fields/reasons/tasks/projections;
- public `work-fold` command and exact PowerShell/JXA/shell helpers;
- `work-fold:drive`, `work-fold:appearance`, and `work-fold:checks` scripts;
- drive options `--workspace` → `--space-root` and `--workspace-id` →
  `--space-id`;
- appearance options `--workspace-id`/`--workspace-name` →
  `--space-id`/`--space-name`;
- all corresponding help, examples, docs, and tests;
- broker roots, output, errors, act token, receipts, and PATH integration;
- materialized management `AGENTS.md`, `manage-spaces`, reference Skills, and
  restricted-app authoring prompts; and
- in-flight attachments, request lineage, popover commands, and tests.

Preserve the content-free read lane, per-launch act token, explicit `--space`
on writes, replay refusal, journal-first receipts, and task/History/concurrency
rules.

Exit gate: a real management turn uses `work-fold`, handles every attachment
and delegation, and never suggests the old command.

### Phase 4 — HTTP, IPC, bridge, and renderer contracts

Rename producers and consumers together:

- `/api/workspaces` → `/api/spaces`, `{ workspaces }` → `{ spaces }`, and all
  domain fields to `spaceId`;
- local session header, health payload, development identity, and outbound
  `User-Agent: work-fold-Capability-Registry`;
- IPC, preload additional arguments, `window` declarations, restricted-app
  global/host channels, and hidden bootstrap variables;
- renderer localStorage, drafts, type, tabs, attention, appearance, drag, and
  palette namespaces; and
- all Files, Chats, History, Library, Checks, App Studio, OAuth, notifications,
  automations, and restricted-app clients.

`work-fold-desktop://` is an internal Electron renderer scheme, not an
OS-registered protocol. Do not add `setAsDefaultProtocolClient`, `open-url`,
file-association migration, or unregister cleanup.

The restricted-app bridge global, preload, host, type declarations, examples,
and authoring instructions land atomically even where ownership crosses phases.

Exit gate: renderer, popover, app hosts, and CLI have no active old HTTP, IPC,
preload, header, or storage namespace.

### Phase 5 — Persisted product and App Platform contracts

Classify each format as product-owned, Space-domain, or portable-neutral, then
change atomically:

- Check kinds, sensor IDs, proposal suffixes, and `.work-fold/checks/`;
- appearance kind, target fields, CLI options, suffix, and CSS variables;
- Chat portable path/context and History state names;
- restricted-app headers, magic, MIME, digests, release envelopes, registries,
  receipts, storage owners, and OAuth sentinels selected for reset;
- App Platform fixtures and conformance verifier; and
- examples, authoring prompts, and normative docs.

Old registries, fields, Check/appearance kinds, branded headers/digests/MIME,
errors, and release envelopes are explicitly rejected or ignored according to
the ledger, never accidentally parsed. `agent-app.json` and the established
Tenant, Principal, Runtime Instance, Feature Installation, Data Namespace,
Release, connection, grant, job, and receipt concepts remain. Do not weaken
validation, authority fencing, quotas, atomicity, receipts, or forward-version
fail-closed behavior.

Exit gate: global no-`workspaceId` gate plus full App Platform and restricted
app lifecycle/conformance suites pass with one coherent contract family.

### Phase 6 — Brand and visual system

Replace every visible authority:

- HTML titles, loading/recovery, onboarding, Settings/About, update UI,
  permissions, errors, status, and accessibility names;
- native title/menu/About/Quit, tray/menu-bar labels, notifications, updater,
  OAuth, and startup recovery;
- management popover: “Tell work-fold,” “Reply to work-fold,” “Open work-fold,”
  and connection states;
- Assistant names, authored copy, notification prefixes, examples, local health
  payload, and restricted-app OAuth callback HTML;
- the packaged W/folder and separate onboarding W with one wordmark/fold mark;
- one master source generating PNG, ICO, ICNS, template, favicon, installer,
  DMG, and social assets; and
- global brand tokens separated from Space accents, with light/dark,
  high-contrast, reduced-motion, tiny-icon, and monochrome checks.

The current menu-bar generator extracts a W path from the icon source; replace
that structural assumption, not only the SVG.

Exit gate: no active UI, OS surface, notification, Assistant response, health
payload, OAuth response, or accessibility name displays an old/alternate form.

### Phase 7 — Packaging, signing, publishing, and public material

Update together:

- Electron Builder plus the retained Forge diagnostic lane;
- Windows executable, AUMID, deterministic NSIS identity, uninstall entry,
  shortcut, PATH shim, artifacts, blockmap, `latest.yml`, signing, and checks;
- production Windows NSIS `deleteAppDataOnUninstall: false`; the unpacked
  Windows smoke lane uses the distinct `work-fold Development` profile, while
  the Mac smoke bundle uses its distinct name/profile/bundle ID with updater
  disabled;
- macOS app/executable, smoke app, bundle IDs, DMG/ZIP, blockmaps,
  `latest-mac.yml`, hardened runtime, signing, notarization, stapling,
  Gatekeeper, cache, and installed-app checks;
- new feeds, CI names, checksums, package metadata, startup-recovery links, and
  the unused first work-fold tag;
- `work-fold.com`, public pages, screenshots, social assets, and release notes;
- a prominent legacy-repository README/banner directing visitors to
  `work-fold.com` and `Mat-Tom-Son/work-fold`, plus the new repository's
  description, homepage, topics, and social preview; and
- current contributor/product/security/privacy/build/release docs, examples,
  reference Skills, and a factual legacy release index.

Exit gate: signed artifacts and every current public authority agree on names,
paths, commands, feeds, behavior, and support channels.

## 7. Desktop and release cutover choreography

### A. Final legacy containment release

1. Record the last published old source commit, version, feeds, checksums, and
   signing evidence.
2. From that published source—not the in-flight feature baseline—prepare one
   minimal safety release that makes `.work-fold/` hidden/non-authoritative in
   Files, Search, History capture/restore, Checks, Chat/management attachments,
   restricted-app grants/hosts, and generated releases. If `.work-fold/`
   exists, legacy managed-Space recursive deletion fails closed; the person may
   unregister the old Space without deleting the folder.
3. Run bidirectional coexistence tests and have all three testers install it
   before the same folder is registered in work-fold.
4. Freeze `Mat-Tom-Son/workspace` without renaming it and freeze
   `Mat-Tom-Son/workspace-mac-releases`. Keep release downloads public.
5. Never publish a work-fold artifact to either old feed.
6. Keep the Apple Developer ID team/notarization account as publisher
   authority. Reuse a Windows certificate only if its subject is
   product-neutral; the current personal helper embeds the old product name and
   requires a new or neutral work-fold certificate.

### B. First work-fold candidate

1. Build from the accepted in-flight baseline plus the complete rebrand.
2. Use new app/bundle, profile, broker, cache, session, scheme, command, and
   feed identities.
3. Establish `app.setName("work-fold")`, `com.work-fold.desktop`, the new
   profile, and new Safe Storage identity before secure storage opens.
4. Install beside the containment release on Windows and macOS.
5. Verify work-fold starts at onboarding while the old app retains demo state.
6. Register a folder containing `.workspace/`; confirm it is hidden/ignored and
   `.work-fold/` is added without changing any pre-existing descendant. Allow
   only unavoidable root-directory metadata changes caused by adding the child.
7. Seed legacy Safe Storage/Keychain material and encrypted blobs. Cold-launch
   signed/notarized work-fold without a prompt and prove legacy keys/blobs are
   unchanged without using `security ... -g`.
8. Update the reset helper to target only work-fold's profile and discovered
   work-fold Keychain identity. No installer/updater invokes either reset tool.
9. Exercise the full product and package matrix.

### C. Tester transition

1. Send the three testers the new manual download and fresh-start notice.
2. Verify ordinary folder contents are present.
3. Uninstall the old app separately only after confirmation.
4. Remove old application data only by explicit documented manual cleanup.
5. Remove `.workspace/` from a demo folder only after inspecting that exact
   folder and choosing to remove it.

### D. Two-release update proof

1. Install the first work-fold release manually.
2. Publish a second higher version to the new feeds.
3. On Windows and macOS prove check, download, new updater-cache contents,
   restart, new version, signature/notarization, and preserved work-fold state.
4. Launch the final containment release and prove its updater cannot discover
   either work-fold feed.

Automatic updates are not considered mature before this complete proof.

## 8. Fixed repository and feed topology

1. `Mat-Tom-Son/workspace`: final containment release, then frozen legacy
   source/Windows feed. Never rename it.
2. `Mat-Tom-Son/workspace-mac-releases`: frozen legacy Mac feed.
3. `Mat-Tom-Son/work-fold`: new source repository and Windows releases.
4. `Mat-Tom-Son/work-fold-mac-releases`: new Mac releases.
5. If a legacy repository is archived, verify its release endpoints and assets
   stay public before and after archival.

An old updater seeing a work-fold artifact is release-blocking, even with only
three testers. This topology also lets the Windows publisher keep using its
repository-scoped GitHub token rather than inventing cross-repository auth.

## 9. Rollback policy

- **Before publication:** discard the candidate; old installs, profiles, feeds,
  and artifacts remain intact.
- **After possible consumption:** remove website links only, mark the GitHub
  release superseded, and publish a higher fixed version. Never delete or
  unpublish its tag/release/assets, replace consumed bytes, or reuse a tag.
- **After work-fold state exists:** never revert its app ID, profile, command,
  portable metadata, or feed. Back up the exact work-fold profile if needed and
  roll forward.
- **Signing/notarization/feed failure:** stop publication; never route a fix
  through an old feed.
- **Mac finalization:** an already notarized DMG may be finalized again only to
  refresh updater metadata before consumption; consumed bytes are immutable.
- **Operational fallback:** reopen/reinstall the exact containment release,
  possible because work-fold never migrates or deletes its state.

## 10. Verification matrix

### Static identity gates

Use a path-and-purpose-scoped allowlist limited to factual historical docs, this
plan, coexistence tests/safety deny literals, and genuine external APIs. Fail on
stale/unused entries. Assembled work-fold packages permit zero legacy brand,
configuration, or reader exceptions; the only old product literal permitted is
the explicit `.workspace/` safety-deny rule, verified never to parse or adopt
that directory.

Active code/package scans reject:

- visible old/alternate brand spellings;
- folder-domain `workspaceId`, `Workspace*`, `/api/workspaces`, and old fields;
- product IPC, preload, storage, header, package, executable, Skill, and
  `WORKSPACE_*` identities;
- product-owned errors/sentinels such as `WORKSPACE_CONTEXT_REQUIRED`,
  `ERR_WORKSPACE_APPEARANCE_VERSION`, `ERR_WORKSPACE_CHECKS_VERSION`,
  `WORKSPACE_RESTRICTED_APP_REGISTRY_DIRSYNC`, and
  `WORKSPACE_FILE_PRESENCE_*`;
- active `.workspace/` reads outside narrow coexistence exclusions;
- old bundle IDs, profiles, updater caches, artifact/feed URLs, CLI shims,
  health identity, OAuth copy, and outbound User-Agent; and
- broad historical file exceptions that could conceal new active content.

Positive packaged assertions cover:

- `Info.plist` bundle identifier, display name, and executable;
- Windows AUMID, deterministic NSIS identity, uninstall entry, install path,
  shortcuts, and production `deleteAppDataOnUninstall: false`;
- embedded `app-update.yml` owner/repository and cache identity;
- `latest.yml`/`latest-mac.yml` artifact name, size, and SHA-512;
- Authenticode signer, Developer ID team, hardened runtime, notarization
  staple, and Gatekeeper;
- only work-fold CLI shims;
- startup recovery links to the new repository; and
- an unused first work-fold tag.

### Required automated lanes

- TypeScript/check lane and full `npm test`.
- Desktop prepare and Electron Builder smoke package.
- Retained Forge package lane when affected.
- Windows installer/release verifier.
- macOS structural smoke and signed/notarized candidate lanes.
- App Platform digest/contract conformance.
- Packaged restricted-app real-Electron smoke.

Use the final rebranded npm script names; current names are inventory inputs,
not permanent public contracts.

### Fresh-state product matrix

On Windows and macOS verify:

- onboarding; managed and linked Space creation/move;
- Files reveal/drop/context menu; Chat send/retry/stop/background/search;
- History capture/restore; Library copy; appearance export/import;
- Checks proposal/enable/run/problem/decision/disable;
- Assistant tools capability mutation fencing;
- restricted app review, grants, files, storage, OAuth, connection, automation,
  notification, tabs, install/update/rollback/uninstall/retain/purge;
- management CLI read/act and management attachments/request lineage/
  delegation/stop/needs-you behavior;
- tray popover with main window closed; sleep/wake; second instance; quit;
- native Pi capabilities/auth remain available, while product state,
  connections, credentials, and session paths do not cross;
- `.pi/` project configuration loads only after Space registration, needs no
  redundant trust prompt, and stops loading after Space removal; and
- generated health/OAuth output contains only the new identity.

### Destruction safety and bidirectional coexistence

- work-fold starts empty beside an old profile.
- Both apps launch simultaneously; each second-instance/CLI request reaches
  only its own process and broker.
- The production Windows NSIS installer keeps
  `deleteAppDataOnUninstall: false`; smoke lanes remain isolated as specified
  in Phase 7.
- Uninstalling either app removes only its binaries, install registration,
  shortcuts, and exact PATH/bin entry; both products' profiles, credentials,
  updater caches, linked folders, and release metadata remain untouched.
- Seed `.workspace/space.json`, conversations, Checks, machine-local ignore
  state, credentials, and Pi sessions; register with work-fold; verify a new id
  is written to `.work-fold/space.json`, nothing old is imported, and every old
  byte stays unchanged.
- Every pre-existing linked-folder descendant retains its path, bytes, and
  timestamps; only explicit `.work-fold/` additions and the unavoidable root
  directory mtime/ctime change are permitted.
- work-fold cannot display, search, index, snapshot/restore, target with Checks,
  attach, grant, or package either `.work-fold/` or `.workspace/`; the
  containment release applies the same rule to `.work-fold/`. Windows tests
  include case variants such as `.WORK-FOLD` and `.WORKSPACE`.
- With `.work-fold/` present, a legacy managed-Space delete fails closed and
  offers registration removal only; a side-by-side test proves neither the
  folder nor either metadata tree is deleted.
- Same-folder Pi session paths do not collide.
- Symlinks/junctions, nested Spaces, damaged/future metadata, and replaced paths
  retain fail-closed behavior.
- No migration/cleanup invokes Space-removal deletion logic.

### CLI and Assistant

- `work-fold` version/help/context/spaces/tasks/capabilities/Chats/Files/manage/
  Checks commands and JSON all use new kinds/fields.
- Read lane remains content-free; act lane refuses missing/stale tokens and
  replays; receipts survive failures.
- No `workspace` alias is packaged.
- Both `bin` directories may coexist on PATH; each uninstaller removes its
  exact directory only.
- New helpers have no fallback to old executable/profile/flags or
  `WORKSPACE_CLI_*`.
- A real management turn invokes `work-fold`, `manage-spaces`, and accounts for
  every attachment and child task.
- Authoring prompts and reference Skills never teach the old command.

### Negative contracts

- `/api/workspaces` unavailable; old session header rejected.
- Old IPC channels, preload globals, CLI shims, snapshots, and schema fields
  absent.
- Old Check/appearance kinds, errors, artifact headers, branded digests, and
  MIME types fail closed per the ledger.
- Legacy restricted-app artifacts are rejected or deliberately rebuilt from
  neutral `agent-app.json`; never half-parsed.
- Final legacy updater cannot discover either work-fold feed.
- work-fold Safe Storage reset neither reads nor deletes legacy service/account
  or blobs, and neither install/update invokes a reset helper.

### Visual and public

- icon recognition at 16, 24, 32, 48, and 64 px;
- menu-bar template at actual light/dark size;
- Windows Start, shortcut, taskbar, installer, and Add/Remove Programs;
- macOS Finder, Dock, menu, About, DMG, Gatekeeper, and notifications;
- onboarding, title, Settings, updates, popover, dialogs, review, OAuth,
  empty/error/recovery states;
- keyboard, screen reader, contrast, high contrast, reduced motion, and 200%
  scaling; and
- DNS/TLS, downloads, checksums, feeds, badges, privacy, security, issues,
  advisories, support, and social metadata.

## 11. Risk register

| Risk | Severity | Release gate |
|---|---|---|
| A wipe deletes an ordinary/managed folder | Critical | New identity only; no migration deletion; byte/timestamp coexistence tests |
| Legacy managed-Space deletion destroys a shared folder | Critical | Containment release blocks recursive delete when `.work-fold/` exists; side-by-side deletion test |
| Old app modifies `.work-fold/` | Critical | Final containment release plus mirrored exclusion tests |
| Old updater consumes work-fold | Critical | Fixed feeds, frozen old repos, final negative updater check |
| Pi sessions collide for same folder | Critical | `sessions/work-fold/` namespace and collision test |
| Partial Space rename crosses authority | Critical | Phases 2–5 non-releasable; ledger and producer/consumer tests |
| Digest/format rename breaks authority | Critical | Atomic writer/reader/fixture/verifier change and conformance |
| Safe Storage reads or deletes legacy keys | Critical | New name/profile before access; signed cold launch; helper isolation |
| Assistant teaches old command | High | CLI, Skill, materialized instructions, prompts, examples land together |
| In-flight popover keeps old brand | High | Dirty baseline is explicit; popover acceptance pass |
| Old metadata becomes visible/grantable | High | Bidirectional Files/History/Checks/attachment/app tests |
| Windows installer replaces old app | High | New ID/exe/uninstaller/root; side-by-side install/uninstall |
| Repository redirect exposes new release | High | Never rename old repository |
| Lowercase name normalized by OS | Medium | Inspect package metadata and every OS surface |
| Brand constants drift | Medium | Central identity authority plus source/package scanners |
| Native Pi sharing mistaken for migration | Medium | Document shared resources/auth versus isolated sessions/product state |
| Historical evidence falsified | Medium | Preserve factual release docs and narrowly allowlist purpose |
| Trademark conflict after asset work | High | Clearance before final art/public launch |
| Baseline moves during implementation | Medium | Record SHA, freeze features, recompute inventory |

## 12. Documentation policy

Substantively update every current unversioned authority, including
`AGENTS.md`, README, contribution/security/privacy policy, environment examples,
product model, architecture, management, capabilities, Checks, visual design,
UI parity, customization, restricted-app, App Platform, Windows/macOS runbooks,
reference Skills, examples, research/adaptation docs, and website copy.

Preserve factual history in `docs/releases/**` and quoted legacy artifact names,
paths, bundle IDs, feeds, links, checksums, and signing evidence. A legacy note
must state which versions used the former identity and that those builds never
accept work-fold update artifacts. Historical allowlists are category- and
purpose-scoped, not entire-file exemptions.

## 13. Implementation fleet orchestration

Parallel work proceeds in dependency waves with explicit file ownership.

### Integration lead

Owns baseline SHA, identity map, contract ledger, shared types, phase gates,
conflicts, allowlist, and final verification. Only one concurrent owner edits
`src/local/server.ts`, `desktop/src/main.ts`, `web-local/src/App.tsx`, global CSS
tokens, or `AGENTS.md` unless a handoff is explicit.

### Wave 1 — Sequential foundations

One core agent owns Phase 1 and core Space-domain Phase 2, restoring typecheck
before downstream lanes fork.

### Wave 2 — Parallel contract lanes

- **CLI/management:** kernel, snapshots, broker/shims, instructions, Skills,
  attachments, requests, and tests.
- **Desktop:** identity, IPC/preload, Safe Storage, packages, installers,
  signing, feeds, updater, and desktop tests.
- **App Platform:** serialized contracts, bridges, digests, fixtures,
  conformance, examples, and tests.

The integration lead owns local-server merges and cross-lane contract changes.

### Wave 3 — Parallel experience lanes

- **Renderer:** clients/types, Space terms, persistence, visible copy,
  onboarding, Settings, and popover.
- **Visual:** wordmark, icons, tokens, generated assets, installer/DMG/social
  visuals, and visual QA.
- **Documentation/public:** normative docs, policy, README, links, site, and
  historical labeling.

### Wave 4 — Independent adversarial review

Separate reviewers own forbidden-token/contracts, destruction/coexistence,
Windows install/update, macOS signing/Keychain/update, and product-language/
visual/accessibility/Assistant behavior. A release-blocking fix receives a
second reviewer.

## 14. Audited active-surface inventory

The current audit found approximately:

- 14,865 case-insensitive `workspace` occurrences across 314 files;
- 1,841 `workspaceId` occurrences across 91 files;
- 3,573 `Workspace*` identifiers across 145 files;
- 233 `/api/workspaces` references across 21 files;
- 296 `workspace:` references across 60 files;
- 252 `WORKSPACE_*` references across 59 files;
- 73 renderer-visible old-brand mentions; and
- 205 desktop/local-runtime old-brand mentions.

These are discovery signals, never replacement instructions. Recompute after
the in-flight baseline lands. High-risk authorities include desktop icon/build/
CLI/updater/main/preload/host files; local Space/kernel/server/state/Pi/Checks/
restricted-app files; renderer `Workspace*`, `workspace-*`, storage, popover,
and onboarding files; package/workflow/verifier configuration; and all current
policy, product, release, example, and reference-Skill docs.

## 15. Definition of done

The launch is complete only when:

- the accepted in-flight features ship in the first work-fold build;
- every active surface uses lowercase `work-fold` and approved visual assets;
- the folder domain is Space/space across copy, active APIs, JSON, and code;
- work-fold installs beside the containment release with new identity and empty
  product state;
- neither install/launch/update/uninstall mutates the other's app, profile,
  credentials, cache, PATH, shortcut, binary, or folder metadata;
- native Pi personal resources/auth remain standard and shared, while session
  paths and product state are isolated;
- no automation deletes old state or ordinary Space folders;
- new portable data is written only under `.work-fold/`; `.workspace/` remains
  hidden and non-authoritative in work-fold, with the inverse guaranteed by the
  containment release;
- CLI, management, popover, Skills, and prompts all use `work-fold` and
  `manage-spaces`;
- HTTP, IPC, preload, renderer, Check, appearance, restricted-app, and App
  Platform contracts form one coherent new/neutral family and old contracts
  fail closed;
- Windows/macOS artifacts carry exact new IDs, names, icons, feeds, signatures,
  metadata, Safe Storage, and verification assertions;
- old feeds are frozen and cannot serve work-fold;
- manual-first and higher-second work-fold update continuity passes on both
  platforms;
- full static, automated, functional, destruction, CLI, visual, accessibility,
  and public matrices pass; and
- CI prevents old branding or semantically wrong Workspace identifiers from
  returning outside narrow reviewed historical/safety categories.
