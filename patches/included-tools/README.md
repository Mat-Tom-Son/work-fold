# Reviewed native integrations

The manifest pins the upstream package version, source, license, every input/output file digest, and patch digest. `scripts/prepare-included-tools.mjs` refuses mixed or unknown source states and verifies the result. Integrations remain ordinary native Pi Extensions; `resources/included-tools` supplies the explicit host context through Pi's event bus. Narrow runtime/dependency corrections use the same reviewed patch lane. No separate Pi package format or tool registry is introduced.

## Pi coding agent 1.1.0

Pi owns canonical context, recovery omission entries, native model/auth runtime,
MCP, codemode, tool discovery and cache warming. The remaining recovery patch
uses recorded session order for known messages, so a fresh retry at the same
millisecond as a compaction is not mistaken for retained context. Unknown
messages retain the upstream timestamp fallback. Pi still permits one native
compact-and-retry attempt; ordinary output exhaustion never replays effects.

The reviewed root exports expose Pi's file CredentialStore and the native MCP
configuration, transport, OAuth and credential backend APIs to the trusted host.
They add no protocol, legacy AuthStorage API or independent OAuth implementation.
All three changed files are hash verified in preparation and built archives.
The host's async CredentialStore durably serializes Electron encrypted saves.
MCP OAuth uses Pi's file/refresh locks around an Electron-encrypted backend;
browser/CLI development falls back to Pi's ordinary private profile files.

See [the integration trace](../../docs/pi-1.1-integration.md) and the pinned
[SDK example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

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

## Native MCP 1.1.0

Service Connections uses `createMcpExtension` from Pi. The old adapter and its
patch are removed. Catalog loaders supply an empty native server list and remain
cold. Real sessions connect enabled servers in the background, register native
`mcp__server__tool` names, and preserve codemode/deferred/direct/hidden exposure.
Pi owns schemas, structured results, resources, spill files and cancellation.
Native MCP currently has no elicitation or sampling path.

Trusted setup reuses Pi's config parser, transport and PKCE loopback flow. It
pins the defining file, name, URL and config revision; bearer credentials use
the host CredentialStore. OAuth commits only after a source recheck inside the
capability fence. Project overrides narrow Everywhere exposure/enablement and
cannot replace or revoke its credentials. Existing runtimes drain before auth
changes; their credential stores refuse late refresh writes after shutdown.
OAuth starts are serialized and cancelled setup never resumes after restart.
Only the configured agent root and authorized work-folder's `.pi` are loaded.
Chat `/mcp` is status only; setup commands direct the person to the trusted UI.

## Web 0.29.0

The additive `createWebAccessExtension` factory uses upstream DuckDuckGo/Brave search and local HTTP/Readability extraction. DuckDuckGo is the explicit zero-setup default; Brave credentials are fetched from the trusted host only when a search needs them. This baseline does not initialize the monolithic curator UI, import browser cookies, replace global fetch, or call another model. Explicit extraction options prevent hosted/media fallback and ambient browser/profile configuration. Bounded results include source URLs, fetch time, text digest, and honest error/cancellation outcomes.

## Verification

`tests/included-toolkit-native.test.ts` starts isolated child fixtures with real native Pi loaders and local HTTP/stdio servers. It covers cold loading, credential and session isolation, schema validation, source-bearing web extraction, challenge/rate-limit/error handling, cancellation, OAuth PKCE and stale-configuration rejection, and readiness probes. Setup fixtures use isolated synthetic credentials; they never touch personal credentials. `tests/included-mcp-settings-api.test.ts` exercises real local HTTP setup-session binding and restart behavior. Native Extension UI callback coverage remains in the shared bridge suites.

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

The install lane verifies every manifest file, including Pi's patched public
TypeScript declarations. Electron Builder removes dependency `.d.ts` files
from the shipped payload, so packaged verification requires the reviewed
runtime files and their exact hashes. Missing or replaced Pi runtime exports
and recovery code still reject the archive before signing or loading tools.

Pi 1.1.0 hoists brace-expansion 5.0.12 and protobufjs 7.6.5 through the
reviewed root overrides and resolves undici 8.10.2 from its own declared nested
dependency. The normalizer verifies actual resolution and only replaces known
nested exceptions; it does not invent copies absent from the lockfile. A fresh
`npm ci` and the dependency consumer tests verify the reproducible graph.

The September 30, 2026 release review advances brace-expansion to 5.0.12 for
bounded expansion and undici to 8.10.2 for its upstream transport security fixes.
That review pinned Pi 0.80.6; the current integration above advances it to 1.1.0.
Electron advances within major 42 to 42.11.10, which includes the sandboxed
preload-cache fix and upstream Chromium fixes. The reviewed image-size source
patch remains in place with its malformed-input and packaged-byte tests.
Upstream references: [brace-expansion 5.0.12](https://github.com/juliangruber/brace-expansion/releases/tag/v5.0.12),
[undici 8.10.2](https://github.com/nodejs/undici/releases/tag/v8.10.2), and
[Electron 42.11.10](https://github.com/electron/electron/releases/tag/v42.11.10).
