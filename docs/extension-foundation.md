# Extensions and computer work

Status: implemented in the development tree, 2026-09-11; public release
acceptance is tracked separately. This extends
[Skills & Extensions](skills-and-extensions.md). Pi remains the runtime,
package format, resource loader, and capability catalog.

## Product contract

People ask for an outcome in a Chat. The agent finds the relevant tools,
does the work, shows the result, and asks in that Chat when a decision is
missing. Installation, successful loading, enabled scope, and readiness to
perform a particular job are distinct facts. Missing setup is named precisely;
it does not produce an approval queue or a turn suspended on a secret.

**Included with work-fold** describes maintenance: pinned dependencies,
reviewed compatibility changes, setup, and verification in the release lane.
It is not another execution tier. User-added Extensions use the same native
Pi loader and supported UI. Ordinary Pi packages need no work-fold manifest,
wrapper format or tool registry. Full-trust native code retains full-user
authority; host facilities cannot sandbox arbitrary shell access.

**Skills & Extensions** owns discovery, installation, source, scope,
configuration, diagnostics, update, enable/disable and removal. Since
2026-09-25 it is a popup dialog opened by the rail's Add button and pinned to
the work-folder it was opened from. Its Installed view starts with an **Included
with work-fold** strip holding the five included tools; **Everywhere** and
**This folder only** remain the scope groups below it, side by side. Account and OS setup stays on a trusted local surface. Generated
work-folder apps remain separate: they may request agent work through
`assistant.request`, but receive no native desktop-control bridge.

## Responsibilities

| Layer | Owns |
|---|---|
| Pi | Packages, Skills, Extensions, tool definitions, commands, session events, model conversion and native cancellation signals |
| work-fold host | Chat/request identity, supported UI, setup, capability mutation fences, resource lifecycle and diagnostics |
| Integration | Domain operations, valid observations, connection/helper protocol, readiness checks, bounded results and cleanup |
| Desktop and paired web | Presentation and input for the exact owning Chat; desktop-only identity, secret and OS setup |

Included resources live in `resources/included-tools` as ordinary native
Extensions and a standard document-work `SKILL.md`. Pi evaluates the same
resource filters used for user-added files. An optional versioned native event
bus query, `work-fold:extension-host:v1`, provides explicit runtime paths,
catalog/session mode and on-demand configuration callbacks. This context stays
inside the full-trust native runtime; it is not a renderer or restricted-app
API, and other native Extensions can use the same supported event bus.

Chrome production distribution, native bootstrap ownership and independent update
compatibility are defined in [Chrome extension distribution](chrome-extension-distribution.md).

## Live Extension interactions

Native Pi `select`, `confirm`, `input` and `editor` calls appear inline in their
owning Chat. Questions queue independently, survive tab switches and reconnect,
and validate typed answers before one callback settles. Wrong-owner,
duplicate, expired or invalid replies cannot advance them. Failed delivery
keeps the field available for retry; Stop and the composer remain reachable.

These are transient callbacks, not durable F27 questions. Stop, timeout,
session disposal and shutdown cancel them. Restart does not reconstruct or
auto-answer them. A question that ends its turn and resumes after an answer
uses the existing collaboration verbs. Native third-party confirmations keep
their meaning; included integrations add no recurring action confirmations.

While a turn is live, async context carries its explicit task identity. A
later question from a settled turn or a reused transport remains Chat-owned
without borrowing a newer turn's task. Session-start and reload callbacks also
retain session ownership. Stop cancels pending questions and rejects callbacks
while that native prompt drains. Once it drains, a surviving transport may ask
a new Chat-owned question; session disposal permanently cancels its UI access.
Unattributed questions remain local to their Chat: paired web input
requires the exact browser-owned work-fold agent task and live browser grant.
Legacy MCP stdio elicitation does not identify its originating `tools/call`;
the host must not guess its task from whichever turn is currently running.

The UI adapter bounds pending questions and text, scopes editor state by root
and conversation, and keeps live values outside the portable transcript and
replay journal. Native Extensions may themselves record their inputs. Standard
Pi input has no secret classification, so credentials and OAuth codes belong
in trusted setup, never ordinary Chat questions or paired-web answers.
Unsupported terminal component factories are diagnosed; arbitrary TUI or HTML
is not rendered as a desktop component.

## Included tools and limits

| Tool | Included implementation | Setup and supported boundary |
|---|---|---|
| Computer Control | `@injaneity/pi-computer-use` 0.5.1; existing native observations/input coordination with reviewed helper lifecycle changes | Apple-silicon macOS helper built from source in the signing lane; Linux x64 Rust helper built from pinned sources. Linux AT-SPI observations and semantic actions depend on target-app support. GNOME Wayland uses explicit portal sharing with a app-wide capture/input session; X11 has an upstream capture/input backend. Requested observations and actions, no continuous recorder. |
| Chrome | `pi-chrome` 0.15.51; shared transport with independent Chat targets and embedded-host ownership | Install work-fold from the Chrome Web Store and choose Connect in the selected profile. Native bootstrap and authenticated protocol/capability checks precede use. Signed-in account effects use that profile's authority; cleanup preserves user tabs. |
| Web | `pi-web-access` 0.29.0 pure search and readable-page functions through an additive native factory | DuckDuckGo search needs no key; optional Brave key is entered in tool setup. Explicit HTTP(S) reading, bounded output and cancellation. No automatic cookie/profile import, media service, global fetch replacement or hidden model call. Challenges and rate limits remain visible failures. |
| Documents | Ordinary JavaScript worker, maintained document libraries and a standard document-work Skill | DOCX/XLSX/PPTX/PDF creation, spreadsheet read/write, PDF text extraction and selected page rendering using bundled dependencies. No separate Node/Python required. The separate `document_engine` tool detects installed LibreOffice for Office rendering/XLSX recalculation and Tesseract for page-image OCR. These optional engines are not bundled; missing setup is explicit. Built-in PDF text extraction itself is not OCR. |
| Service Connections | Pi 1.1.0 `createMcpExtension` using native MCP transport, discovery, schemas and cancellation | Configure HTTP or stdio servers in native Pi files. Trusted setup supports bearer credentials and loopback PKCE OAuth. Stdio commands need their own installed executable/runtime. Native MCP currently has no elicitation or sampling path. No automatic imports from other applications. |

Email, calendars, databases and project services remain user-selected
connections. Included does not mean every account is connected or every server
starts. Factories stay cold during catalog inspection; credentials are read
when an operation needs them. The document worker imports its libraries on
requested execution or an explicit health check.

The packaged macOS Computer helper runs from a private, versioned directory outside
the enclosing work-fold app bundle so macOS attributes its Screen Recording
permission to `work-fold Computer`. On first requested setup or tool execution,
the host copies the exact signed bundle, verifies its bytes and signature, and
preserves its identity and icon. Catalog reads create no helper copy or process.
An update creates a new version without replacing a running helper; the host
still owns its launch, socket and shutdown. A Settings toggle alone does not
prove capture works; readiness uses the actual helper's permission evidence.
Changed helper bytes fail ordinary tool execution. Explicit Computer setup can
repair them from the verified app copy after accepted work has stopped; the
existing global capability fence holds through idle-helper shutdown and repair.

The Linux helper runs from the app's immutable resources after its executable
hash is checked, with runtime setup/download disabled. It uses the same Pi
factory and a shared scheduler. Aborting a dispatched command terminates and
awaits the helper, invalidates its observations and reports uncertain effects
without replay; other Chats may need to observe again. GNOME Wayland adds an
optional shared-screen backend to these same eight Pi tools, their state store
and scheduler. The native host event bus provides session-bound list, observe,
act and release facilities; catalog mode receives none. Trusted Computer setup
creates an app-wide portal grant without choosing or creating a Chat. Folder
Chats and the work-fold agent can use it, including Chats created later. Each
operation checks its explicit Chat and accepted-turn identity, consumes a current
observation for input, and holds an OS-backed seat lease until the turn settles.
Another Chat receives a busy result while that turn controls the desktop. Normal
completion releases control without ending sharing. Cancelling or disposing the
controlling Chat stops sharing; removing an idle Chat or Folder does not.

A shared monitor has its own target kind and no PID, window id or semantic tree.
Visual observation returns the granted PipeWire frame. Pixel actions use the
portal/EIS mapping and compositor geometry, including qualified fractional
scaling; semantic refs and semantic outcome assertions are rejected for that
target. libei and libxkbcommon own input transport and keymap interpretation.
The Linux tool descriptions explain monitor discovery (`kind: "shared_screen"`,
without application filters), visual observation, physical scrolling after
positioning the pointer (no accessibility ref), drag paths, and separate shortcut key
names (`["ctrl", "a"]`). A combined chord such as `["ctrl+a"]` is rejected
with corrective guidance during input preflight, rather than reported as an
unavailable compositor key. Unknown individual keys identify the failing name.
No model call opens a chooser or restores a grant. Portal closure, native GNOME/KDE lock,
sleep, app exit and Stop revoke it. Input is whole-seat work: keyboard events
affect the focused application, and the successor image verifies what happened.
The helper requires an identifiable GNOME or KDE session and revokes sharing if
its native lock service loses or changes ownership. KDE helper qualification is
limited to a single connected monitor; a multiple-monitor response is refused
before capture. The installed-desktop support baseline remains GNOME.
See [Linux builds](linux-build.md) and the [native acceptance harness](../scripts/linux-wayland-probe/README.md)
for packaging, supported geometry/layouts and remaining qualification.
Gatekeeper can run that quarantined helper from a temporary, randomized
location. A different executable path is admitted only beneath the current
user's AppTranslocation directory and only when its complete bounded bundle
(regular files, permissions and bytes, without symlinks) matches the current
expected helper. Both signatures must validate independently; protocol
compatibility is still required. Quarantine is preserved. Other locations,
changed resources and invalid seals fail without weakening Gatekeeper or
accepting a signing-team or filename shortcut. A failed inspection reports an
error without restarting a possibly busy helper.

Documents run full trust in a worker so Stop can terminate a synchronous loop.
Each worker has a 512 MiB V8 heap limit to contain accidental allocation loops;
native-library and external-buffer memory are outside that limit.
Its provided libraries resolve from the shipped bundle; a script's own imports
retain ordinary project-first resolution. Run metadata records library origins
and versions, and failed tools retain bounded engine diagnostics.
They are not sandboxed and independent child processes are outside the worker's
cancellation boundary. The helper bounds scripts, response bytes and canvas allocations. PDF source capture
has a model-overridable memory budget, text/render reads have continuation, and there
is no page-count or default time ceiling. Optional deadlines and Stop remain effective.
Complete overflow and partial-failure evidence stays in retained ordinary artifacts.
Rendering uses captured source bytes and records source/render digests, page,
scale and renderer identity. `emitImage` selects which PNGs enter native Pi
content. Files remain normal artifacts where the script writes them; creating
a file alone neither attaches it nor sends it to a model. See the
[document-work Skill](../resources/included-tools/documents/skills/documents/SKILL.md)
for exact helper limits and ordinary library access.

## Readiness and lifecycle

The Installed view distinguishes native resource enabled state, Pi load
diagnostics and observed tool readiness (`ready`, `setup_required`,
`unavailable`, `unknown`, with specific failure detail). A saved credential or
successful module import alone does not prove an operation works. An MCP connection check
performs bounded native connect and tool/resource/prompt discovery, without
invoking a server tool. Chrome checks its authenticated companion; computer
checks report actual helper/permission state. Web reports configured or unknown
until the relevant operation supplies evidence; the default keyless Web path
is available without setup. Included tiles in the Installed view's **Included with work-fold** strip read
cold host status. While the popup is visible they refresh every five seconds
and when the window returns to the foreground; hidden or closed surfaces stop
reading. A failed read keeps previously verified evidence neutral and historical
(including Last Connected for Chrome) with an error, rather than claiming live
readiness or discarding the timestamp. Opening the popup launches no helper, browser, or MCP server. Native
load state stays in Technical details and never establishes readiness.

Chrome uses recent authenticated contacts from the selected profile: compatible
polls, active-command heartbeats and accepted results. A lease alone is
Connecting; a selected profile with no recent contact says Not connected and
reconnects when Chrome opens. Transport startup failures show a bounded diagnosis.
Computer Control records actual helper and permission evidence after use or an
explicit **Check**. Use coalesces no-launch permission observations for thirty
seconds without delaying tool results. After five minutes a successful observation becomes neutral **Last
Check Passed**, preserving its timestamp, until another observation replaces it.
An idle helper is unverified rather than unavailable. **Check** never repairs the
helper or disposes Chat sessions. Setup (2026-10-11) is one **Allow Computer
Control** button: it asks macOS for both permissions, then watches every two
seconds for up to five minutes, with a checklist that shows each permission and
opens its System Settings pane, and the one sentence that names **work-fold
Computer** as what to turn on. Once macOS reports Screen Recording allowed but
the running helper cannot capture yet, setup restarts the helper once, because
macOS applies the permission only after a restart. Allow finishes at once when
both are already allowed, so a Not checked Computer Control offers **Set up**.
**Restart helper** under Technical details is the explicit repair, under the
existing capability mutation fence.

Documents uses the run worker's own library and canvas verification, with no
second readiness worker, or an explicit **Check**. That proof
belongs to the running build and remains valid until the host exits; a new host
starts unverified. Service Connections says **No Connections** or **Configured**
from the native configuration, without equating configuration with server health.
Individual connection details own their bounded native checks.

**Set up** appears only when a person can act. Explicit checks invalidate previous
evidence before work starts. Runtime-bound observation ordering prevents an older
probe from replacing a newer check; renderer reads cannot cross work-folders,
overwrite newer results, or survive a closed owner. Setup and failures remain in
the same tool detail rather than a new navigation destination.

Enable/disable persists through Pi's native filters, preserving unrelated
package selections, manifest defaults, resource aliases and scopes. Desktop
and `tools enable|disable --path <resource-path> --kind
extensions|skills|prompts|themes --scope everywhere|work-folder [--work-folder <id>]` share
`capability.resource.enabled`: prepare, pin resource and settings identity,
journal, recheck under the capability fence, execute once and return a receipt.
Active affected work refuses the change instead of losing its session. Included
resources use that same path; their updates arrive with work-fold. Pi does not
filter a package configured as one Extension file, so work-fold explains the
limitation and offers removal rather than pretending its switch worked.

MCP setup sessions bind the selected work-folder, authorized root and Pi agent
directory. Native global `mcp.json` and the registered work-folder's `.pi/mcp.json`
merge through Pi; ambient other-app configuration is not imported.
Bearer credentials use the encrypted desktop CredentialStore; OAuth state uses
an encrypted native Pi backend with scope/endpoint-bound identities. Development
without Electron uses native profile files. Save, removal and credential operations recheck the selected
revision, including at the eventual OAuth token commit. An active-work fence
covers the actual write. Closing setup cancels probes and OAuth; restart
resumes neither. Standard native configuration remains executable full trust,
and manually entered environment/header values must be treated accordingly.

## Observations and external effects

The [feedback contract](tool-feedback.md) applies across text, data, services,
files and UI work. Included tools return relevant native text/image content;
Pi owns the next model step. There is no universal screen recorder, automatic
renderer, second model scheduler or private observation format.

Computer/browser operations use their integration's target and observation
identities. Reobserve stale or uncertain state before acting. Physical input
is coordinated across the machine; browser background targets can work
independently. Stop withdraws queued work and signals owned operations, but
external input or submission may already have occurred. A failed observation
is not proof the preceding effect failed, and disconnect never authorizes an
automatic duplicate send or submission.

Selected observations can remain in Pi's machine-local session history. The
compact portable Chat trail does not replace that evidence and must not absorb
unrelated desktop captures. Document outputs use explicit normal file paths.
The developer inspector retains bounded metadata rather than another image
archive. These integration conventions do not constrain arbitrary full-trust
third-party code. Restart observes current reality without replaying input.

## Reviewed sources and verification

[The integration manifest](../patches/included-tools/manifest.json) pins source,
license, version, patch hash and each before/after file digest. Preparation
rejects unknown or partial source states. [Integration notes](../patches/included-tools/README.md)
record compatibility constraints and dependency mitigations. The host embeds
Pi 1.1.0; its loader's disabled module cache is not process-global isolation.
Patches make ownership and cold initialization explicit while retaining native
transport and default upstream behavior where applicable.

Focused fixtures cover real native loaders, simultaneous sessions, cold
catalog loading, cancellation, typed questions, exact web ownership, MCP HTTP
and stdio discovery, credential/config revision isolation, web source evidence
and failures, document structure/render provenance, and actual Electron module
loading. Relevant suites include `extension-interactions`,
`extension-questions-rendering`, `resource-lifecycle`, `included-toolkit-native`,
`included-mcp-settings-api`, `included-mcp-callbacks`, `included-computer-native`,
`included-chrome-native`, `included-documents` and
`included-documents-packaging` under `tests/`.

Passing isolated fixtures does not certify the signed installed user journey
or a model's judgment. Release acceptance still requires live model work in
disposable work-folders, real desktop/companion setup and recovery, computer-use
inspection, repository and desktop checks, and the normal signed/notarized
candidate lane. Record that evidence for the exact candidate rather than
inferring it from source or a previous build. Document acceptance must
catch a real layout defect; selected evidence must match the delivered
artifact, and concurrent Chat/Stop tests must preserve unrelated work.

## Primary references

- [Pi Extensions](https://pi.dev/docs/latest/extensions) and [Pi packages](https://pi.dev/docs/latest/packages)
- [pi-computer-use](https://github.com/injaneity/pi-computer-use)
- [pi-chrome](https://github.com/tianrendong/pi-chrome)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [Pi native MCP](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md)


### Optional installed document engines

`document_engine status` detects executable availability without launching applications.
The same detection (`resources/included-tools/readiness.ts`) feeds the Documents
status on every read, so an install shows up without a click; it looks on `PATH`
and in the usual macOS, Linux and Windows install folders, including
`~/Applications`. An explicit Check also runs `--version` on each found engine
and records the version or the start problem for that exact path. See
[Document verification](document-verification.md) for the status word and Set up.
`render` uses LibreOffice to produce PDF, `recalculate` uses an isolated LibreOffice
Calc profile configured to recalculate OOXML on load and writes a separate XLSX, and
`ocr` uses Tesseract on a selected page image. On macOS, `preview` uses Quick Look
(`/usr/bin/qlmanage -t`) to draw page 1 of a DOCX, or one chosen slide of a PPTX from a
private copy with that slide moved first, as a PNG. Quick Look never exits on a file it
cannot draw, so `preview` alone has a default 60-second deadline and reports that plainly.
A host's `documentEngineSearch` reaches the tool as well as the Documents status, so both
look in the same places. An explicit executable path is supported.
The engine tool runs in the parent native Extension, owns process-group cancellation
and session-shutdown cleanup, has no default deadline, and retains a complete log.
It captures a private source copy, reports source/output SHA-256 and engine version,
never overwrites the source or an existing output, and removes its temporary profile
and input copy. Macros are disabled in the isolated Office profile. The result names
compatibility/recognition limits; successful execution alone does not verify content.

These are optional standard programs with explicit setup, not bundled runtimes or
automatic downloads: Set up opens the official download page or shows a command the
person runs. LibreOffice rendering/recalculation has a real installed-engine
fixture; the Tesseract adapter's deterministic transport/cancellation fixture does not
certify OCR accuracy. A release claiming that workflow needs the installed-engine
acceptance case too. [LibreOffice parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html),
[Calc load settings](https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Calc.xcs),
and [Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)
define the external interfaces.
