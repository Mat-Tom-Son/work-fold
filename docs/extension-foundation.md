# Extensions and computer work

Status: implemented in the development tree, 2026-09-11; public release
acceptance is tracked separately. This extends
[Assistant capabilities](assistant-capabilities.md). Pi remains the runtime,
package format, resource loader, and capability catalog.

## Product contract

People ask for an outcome in a Chat. The Assistant finds the relevant tools,
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
configuration, diagnostics, update, enable/disable and removal. **Everywhere**
and **This Space only** remain the scope groups; included provenance appears
within them. Account and OS setup stays on a trusted local surface. Generated
Space apps remain separate: they may request Assistant work through
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
requires the exact browser-owned management task and live browser grant.
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
| Computer control | `@injaneity/pi-computer-use` 0.5.1; existing native observations/input coordination with reviewed helper lifecycle changes | Apple-silicon macOS helper built from source and included in the app signing lane. Accessibility and Screen Recording setup names the actual helper. Requested observations and actions, no continuous recorder. |
| Chrome | `pi-chrome` 0.15.51; shared transport with independent Chat targets and embedded-host ownership | Prepare and load the supplied companion into the chosen Chrome profile. Local authenticated connection/version checks precede use. Signed-in account effects use that profile's authority; cleanup preserves user tabs. |
| Web | `pi-web-access` 0.29.0 pure search and readable-page functions through an additive native factory | DuckDuckGo search needs no key; optional Brave key is entered in tool setup. Explicit HTTP(S) reading, bounded output and cancellation. No automatic cookie/profile import, media service, global fetch replacement or hidden model call. Challenges and rate limits remain visible failures. |
| Documents | Ordinary JavaScript worker, maintained document libraries and a standard document-work Skill | DOCX/XLSX/PPTX/PDF creation, spreadsheet read/write, PDF text extraction and selected page rendering using bundled dependencies. No separate Node/Python required. Office visual rendering uses the person's existing compatible apps; formulas are preserved, not recalculated; PDF text extraction is not OCR. |
| Service connections | `pi-mcp-adapter` 2.33.0 using native MCP transport, discovery, schemas and cancellation | Configure HTTP or stdio servers in native Pi files. Trusted setup supports bearer credentials and loopback PKCE OAuth. Stdio commands need their own installed executable/runtime. Sampling is disabled for Pi 0.80.6 compatibility. No automatic imports from other applications. |

Email, calendars, databases and project services remain user-selected
connections. Included does not mean every account is connected or every server
starts. Factories stay cold during catalog inspection; credentials are read
when an operation needs them. The document worker imports its libraries on
requested execution or an explicit health check.

Documents run full trust in a worker so Stop can terminate a synchronous loop.
Its provided libraries resolve from the shipped bundle; a script's own imports
retain ordinary project-first resolution. Run metadata records library origins
and versions, and failed tools retain bounded engine diagnostics.
They are not sandboxed and independent child processes are outside the worker's
cancellation boundary. The helper bounds scripts, time, logs, PDF source size,
page/pixel count and selected PNGs, with omissions reported in the result.
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
until the relevant operation supplies evidence. Setup and failures remain
visible in the same tool detail rather than a new navigation destination.

Enable/disable persists through Pi's native filters, preserving unrelated
package selections, manifest defaults, resource aliases and scopes. Desktop
and `tools enable|disable --path <resource-path> --kind
extensions|skills|prompts|themes --scope personal|space [--space <id>]` share
`capability.resource.enabled`: prepare, pin resource and settings identity,
journal, recheck under the capability fence, execute once and return a receipt.
Active affected work refuses the change instead of losing its session. Included
resources use that same path; their updates arrive with work-fold. Pi does not
filter a package configured as one Extension file, so work-fold explains the
limitation and offers removal rather than pretending its switch worked.

MCP setup sessions bind the selected Space, authorized root and Pi agent
directory. Native global `mcp.json` and the registered Space's `.pi/mcp.json`
merge through the adapter; ambient other-app configuration is not imported.
Host-entered credentials use the native OS keyring with scope/endpoint-bound
identities. Save, removal and credential operations recheck the selected
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
Pi 0.80.6; its loader's disabled module cache is not process-global isolation.
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
disposable Spaces, real desktop/companion setup and recovery, computer-use
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
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
