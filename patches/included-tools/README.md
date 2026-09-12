# Reviewed native integrations

The manifest pins the upstream package version, source, license, every input/output file digest, and patch digest. `scripts/prepare-included-tools.mjs` refuses mixed or unknown source states and verifies the result. These are ordinary native Pi Extensions; `resources/included-tools` supplies the explicit host context through Pi's event bus. No separate Pi package format or tool registry is introduced.

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

## MCP 2.33.0

The optional embedded-host factory settings suppress factory-time and catalog-session startup, preserve lazy connections on a cold cache, bind caches to the supplied native Pi agent directory, and keep OAuth/token setup on a trusted host surface. Default upstream Pi behavior remains intact.

An inspection-only host sets `initializeOnSessionStart:false` as well as `initializeAtLoad:false`: native catalog sessions emit `session_start`, so guarding only the factory still starts explicitly eager servers. Real sessions retain configured eager lifecycles; the default lazy baseline connects on use.

The public setup helpers reuse upstream configuration merging, credential storage, PKCE/loopback OAuth, and the MCP server manager. Only the exact native global file and registered Space's `.pi/mcp.json` are loaded; ambient other-app imports are not discovered. A nonsecret credential identity keeps identically named connections in different scopes separate. Configuration revisions are checked inside the host mutation fence at bearer writes and at the actual OAuth token commit. HTTP/stdio transports, schemas, cancellation, discovery, and result bounds remain upstream-owned.

Pi 0.80.6 does not supply the `ModelRegistry.complete` method used by this adapter's sampling implementation, so the included configuration disables MCP sampling. The upstream package pins its MCP client/core SDK to commit `3b205e7dd2f997b6a87e479e36421f7eaa2058e0`; the root lockfile pins those downloads. Re-test this seam before changing either native runtime or adapter versions.

Legacy stdio elicitation does not carry a reliable originating `tools/call` id. A question arriving on a reused transport remains owned by its Chat when its original turn has settled; it must not borrow the currently running task's identity. Explicit Stop still cancels the Chat's callbacks. Manual non-loopback OAuth callback entry is not exposed by the included desktop setup.

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
reviewed nested brace-expansion 5.0.9, protobufjs 7.6.5 and undici 8.10.0 entries;
`package-lock.json` records those resulting versions. Re-run normalization and
restore those exact lock entries after npm dependency resolution, then audit
the prepared tree. Changes to these exceptions require new source review and
consumer tests.
