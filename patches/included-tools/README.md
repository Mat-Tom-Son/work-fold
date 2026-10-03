# Reviewed native integrations

The manifest pins the upstream package version, source, license, every input/output file digest, and patch digest. `scripts/prepare-included-tools.mjs` refuses mixed or unknown source states and verifies the result. Integrations remain ordinary native Pi Extensions; `resources/included-tools` supplies the explicit host context through Pi's event bus. Narrow runtime/dependency corrections use the same reviewed patch lane. No separate Pi package format or tool registry is introduced.

## Pi coding agent 0.80.6

Native overflow recovery removes the failed assistant before compaction, but
rebuilding context from the session can restore it. The retry cleanup previously
removed only `error`, leaving an empty `length` overflow response as the last
message; native continuation then failed before contacting the provider. The
patch also removes `length` within the existing `willRetry` path and prevents
another length response from resetting the recovery counter. Compaction freshness
uses recorded session order for known messages, so a retry in the same millisecond
is not mistaken for retained context; unknown messages retain the upstream timestamp
fallback. Pi still decides
whether an overflow occurred and permits only its existing one
compact-and-retry attempt. Ordinary output exhaustion does not gain automatic
continuation or effect replay. Actual native provider fixtures cover both overflow
forms, repeated overflow with matching timestamps and ordinary partial output, and packaged verification pins the corrected
runtime file. Remove the patch when a reviewed upstream release passes these cases.

## Chrome 0.15.51

The optional embedded factory registers ordinary Pi tools per session and stays
cold during catalog reads. Its shared loopback transport accepts optional native
host connection callbacks, retains an app-owned connection independently of Pi
sessions, and fences queued/dispatched commands on lease revocation. A turn holds
the selected connection through gaps between tools. Protocol3 checks the exact
HTTP extension origin, connection ID, credential and required capabilities
before dequeue, independently of Store/package version. Native-origin paths end
in `/`; HTTP Origin comparison trims that exact validated suffix rather than
using Node's `URL.origin`, which is `null` for chrome-extension URLs.

Store bootstrap and UI are packaged separately under the app-owned Chrome
resource. They retain a local installation proof, expose only content-free
status, resume only an explicitly connected profile, and serialize setup actions
against stale status responses. The ordinary standalone and manually prepared
protocol2 behavior remains available. Native-host onboarding and doctor use
the trusted connection surface and bounded protocol check. Native screenshot
results, session-owned cleanup, unknown-effect cancellation and no replay remain
the upstream tool path. See [distribution](../../docs/chrome-extension-distribution.md)
and the package's maintained `docs/EMBEDDED-HOST.md` for the additive interface.

Text snapshots return the actual selected body range, its page revision, capture time
and target. `textOffset` with `expectedTextVersion` continues a page and rejects
changed text or URLs by exact comparison, including ordinary HTTP pages. Compact snapshots preserve their complete captured JSON in private
temporary files; large results also use native Pi `read` instead of clipping
JSON. Files remain available for the owning session, including reload, and are
removed on session shutdown. Storage is bounded at 32 MiB per result and 256 MiB
per session, without eviction; failures say the result was not stored. Native
structure remains sampled, with captured control/query counts and refinement
guidance. Explicit navigation/wait timeouts also govern the companion deadline.

Authenticated active-command heartbeats and accepted results also refresh the
app's connection observation. Only requests from the authenticated companion
supply liveness; writing a server response is not evidence of browser contact. Wrong
origins, credentials, generations, epochs and unknown command IDs remain inert.

Focused upstream browser corrections are backported without replacing the
reviewed embedded factory: new groups name the target window; hidden pages fail
before trusted input rather than claiming success; click/fill may use their
existing disclosed DOM fallback. Fill selects all of a multiline field and
targeted type moves to its end. A forty-five-second fetch/body deadline recovers
a half-open long poll without timing out or replaying a command. These fixes
follow upstream 0.15.53–0.15.56
([source and changelog](https://github.com/tianrendong/pi-chrome)); the pinned
0.15.51 runtime, standalone behavior and Stop/lease fences remain reviewed here.
The native worker harness covers hidden input, multiline replacement, caret
behavior, window grouping and socket timeout as well as authenticated liveness.
Companion-side changes require the separately built Chrome extension update;
Store approval is not implied by a desktop build.

## Computer Control 0.5.1

The native protocol check preserves its canonical executable comparison. A
Gatekeeper-translocated helper may also pass only when it is beneath the current
user's temporary AppTranslocation directory, its entire bounded regular-file
bundle matches the expected helper's modes and bytes, and both strict code
signatures validate. Every comparison rechecks the current artifact. It never
removes quarantine, admits another protocol, or accepts a filename or signing
team alone. Native regression tests cover the initial and after-relaunch paths,
altered executables, metadata and resources, symlinks, unrelated copies,
invalid seals, cancellation and inspection failures without a helper restart.
Packaged checks pin the verifier and caller
bytes to this manifest.

The Windows client patch keeps the upstream JSON-lines stdio protocol and adds
host ownership. With `PI_COMPUTER_USE_NO_RUNTIME_INSTALL=1` it never re-enters
`process.execPath` with `ELECTRON_RUN_AS_NODE` (packaged work-fold disables that
fuse); a missing helper is an error instead. With
`PI_COMPUTER_USE_HOST_OWNED_HELPER=1`, ending one session no longer kills the
helper shared by every Chat. The child starts hidden and its stderr is drained
and bounded. A `launch: false` command only reaches a live helper, so readiness
checks cannot start one. Cancelled or timed-out reads are abandoned; a
dispatched `act`, `actBatch`, `focusWindow` or `openBrowserLocation` waits for
its own reply (at most two seconds) and then fails as `interrupted_unknown`, as
the macOS transport does. A helper exit or host disposal makes pending effects
uncertain, and responses are bounded to 16 MiB. The Windows Rust crate is
unpatched; its build inputs are pinned with equal before/after digests so a
changed upstream crate fails preparation before reaching cargo. The embedded
isolation check orders its two configuration sessions with an explicit gate
rather than 5 and 10 ms timers, which Windows' coarse timer resolution can fire
in the same tick under load.

The Windows helper's `send_text` is patched because Windows 11 Notepad
(WinUI/TSF) garbled injected text in UAT: one burst of Unicode packets
dropped characters and typed later ones in their place, and U+000A was not
a line break. Text is now typed like a keyboard, one stroke per SendInput
call: characters the foreground window's layout produces with at most Shift
are real key presses (Caps Lock and dead keys respected), Enter and Tab are
real keys, and only other characters are Unicode packets, isolated by 120 ms
on both sides. Keys are 40 ms apart, 150 ms after Enter or Tab, and Shift is
held 15 ms around its key. These values were measured against Notepad,
where 10 ms lost keys and case. `vk_for` no longer maps punctuation to the
virtual key with the same code ("." was VK_DELETE); it uses the layout and
refuses a key that needs Shift or AltGr.

## MCP 2.33.0

The optional embedded-host factory settings suppress factory-time and catalog-session startup, preserve lazy connections on a cold cache, bind caches to the supplied native Pi agent directory, and keep OAuth/token setup on a trusted host surface. Default upstream Pi behavior remains intact.

An inspection-only host sets `initializeOnSessionStart:false` as well as `initializeAtLoad:false`: native catalog sessions emit `session_start`, so guarding only the factory still starts explicitly eager servers. Real sessions retain configured eager lifecycles; the default lazy baseline connects on use.

The public setup helpers reuse upstream configuration merging, credential storage, PKCE/loopback OAuth, and the MCP server manager. Only the exact native global file and registered Space's `.pi/mcp.json` are loaded; ambient other-app imports are not discovered. A nonsecret credential identity keeps identically named connections in different scopes separate. Configuration revisions are checked inside the host mutation fence at bearer writes and at the actual OAuth token commit. HTTP/stdio transports, schemas, cancellation, discovery, and result bounds remain upstream-owned.

Pi 0.80.6 does not supply the `ModelRegistry.complete` method used by this adapter's sampling implementation, so the included configuration disables MCP sampling. The upstream package pins its MCP client/core SDK to commit `3b205e7dd2f997b6a87e479e36421f7eaa2058e0`; the root lockfile pins those downloads. Re-test this seam before changing either native runtime or adapter versions.

Legacy stdio elicitation does not carry a reliable originating `tools/call` id. A question arriving on a reused transport remains owned by its Chat when its original turn has settled; it must not borrow the currently running task's identity. Explicit Stop still cancels the Chat's callbacks. Manual non-loopback OAuth callback entry is not exposed by the included desktop setup.

Structured MCP results accompany text summaries in model-visible content, unless
an existing JSON block already contains the same value. The native output guard
spills large combined results without replaying the call. Searches distinguish
undiscovered lazy servers from empty catalogs and provide the existing `connect`
operation; discovery itself remains cold until explicitly requested.

## Web 0.29.0

The additive `createWebAccessExtension` factory uses upstream DuckDuckGo/Brave search and local HTTP/Readability extraction. DuckDuckGo is the explicit zero-setup default; Brave credentials are fetched from the trusted host only when a search needs them. This baseline does not initialize the monolithic curator UI, import browser cookies, replace global fetch, or call another model. Explicit extraction options prevent hosted/media fallback and ambient browser/profile configuration. Bounded results include source URLs, fetch time, text digest, and honest error/cancellation outcomes.

## Verification

`tests/included-toolkit-native.test.ts` starts isolated child fixtures with real native Pi loaders and local HTTP/stdio servers. It covers cold loading, credential and session isolation, schema validation, source-bearing web extraction, challenge/rate-limit/error handling, cancellation, OAuth PKCE and stale-configuration rejection, and readiness probes. Setup fixtures stub only the OS keyring boundary; they never touch personal credentials. `tests/included-mcp-settings-api.test.ts` exercises real local HTTP setup-session binding and restart behavior. `tests/included-mcp-callbacks.test.ts` exercises reused native MCP elicitation through work-fold's real Chat UI bridge.

The optional `WORKFOLD_LIVE_WEB_TEST=1` fixture runs an actual DuckDuckGo search. It is excluded from the normal network-free test lane. Packaged Electron, live model use, OS permission setup, and the Chrome companion in a real profile still need the release acceptance lane; passing local fixtures does not certify those user paths.

## Document dependency review

ExcelJS 4.4.0 uses only the CommonJS `uuid.v4()` API in its extended conditional
formatting writer. The narrowly scoped `exceljs → uuid@11.1.1` override retains
that API and fixes the [buffer-bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
`tests/included-document-dependencies.test.ts` writes and reopens a real workbook
with that extended format. No formula recalculation is implied by the test.

PptxGenJS 4.0.1 depends on image-size 1.2.1. As of 2026-09-12, neither the
legacy 1.2.1 nor latest 2.0.2 release fixes
[GHSA-w3rx-r6r6-pgpr (ICNS)](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) or
[GHSA-5p2g-fcmc-qvqq (JXL/HEIF)](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
The manifest's `image-size-1.2.1.patch` fixes the installed CommonJS parsers:
ICNS file and entry headers must be complete; each entry advances at least
eight bytes within the declared file length. Shared JXL/HEIF box traversal
requires a complete eight-byte header and an explicit size between eight bytes
and the remaining input length. Matching boxes obey that bound too, closing
the partial-JXL zero-size loop. Unsupported zero/extended-size boxes reject
rather than claiming a parsed size. Bounded ICNS header-only file probing is
preserved; this remains dimension detection, not full image validation.

The source patch replaces the former worker-only format disabling, so ordinary
imports of the bundled dependency receive the fix as well. The normal install
lane verifies patch, upstream version and before/after file hashes; packaged
verification requires the same patched bytes in the archive. Regression tests
run malformed entry/box lengths in a worker with a deadline and memory bound,
verify real upstream ICNS, JXL container/codestream, AVIF and HEIC fixtures, and
write a PowerPoint containing actual PNG/JPEG bytes. The document worker keeps
its separate execution timeout and Stop cleanup.

Package metadata is unchanged. Raw `npm audit` still reports the two upstream
advisories and their PptxGenJS dependency path because it checks version ranges,
not the verified source patch. This is a local remediation with explicit
source evidence, not a clean upstream audit or a guarantee for separately
installed copies. Do not suppress the advisories or apply npm audit's obsolete
PptxGenJS 1.1.5 downgrade. Remove the patch only after a reviewed upstream fix
passes the same compatibility and packaged checks.

Pi 0.80.6 carries a shrinkwrap. The checked normalizer replaces only the
reviewed nested brace-expansion 5.0.12, protobufjs 7.6.5 and undici 8.10.2 entries;
`package-lock.json` records those resulting versions. Re-run normalization and
restore those exact lock entries after npm dependency resolution, then audit
the prepared tree. Changes to these exceptions require new source review and
consumer tests.

The September 30, 2026 release review advances brace-expansion to 5.0.12 for
bounded expansion and undici to 8.10.2 for its upstream transport security fixes.
Pi remains at 0.80.6; the normalizer still rejects unreviewed nested versions.
Electron advances within major 42 to 42.11.10, which includes the sandboxed
preload-cache fix and upstream Chromium fixes. The reviewed image-size source
patch remains in place with its malformed-input and packaged-byte tests.
Upstream references: [brace-expansion 5.0.12](https://github.com/juliangruber/brace-expansion/releases/tag/v5.0.12),
[undici 8.10.2](https://github.com/nodejs/undici/releases/tag/v8.10.2), and
[Electron 42.11.10](https://github.com/electron/electron/releases/tag/v42.11.10).
