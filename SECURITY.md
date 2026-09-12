# Security

The native Extension UI adapter scopes pending callbacks and
extension-managed editor text to a root and conversation, validates response
types and selection membership, bounds text and pending counts, and cancels
callbacks on Stop/session disposal. Its paired-web response operation requires
the exact originating management turn and browser grant, checks live
revocation before delivery, and excludes explicitly secret inputs. Standard
Pi text input has no secret classification, so Extension authors must use a
desktop setup path for credentials. This adapter is not a sandbox for native
Extensions and does not make their external effects reversible. See
[Extensions and computer work](docs/extension-foundation.md).

## Report a vulnerability privately

Please use a [GitHub private security advisory](https://github.com/Mat-Tom-Son/work-fold/security/advisories/new) to report a suspected vulnerability. Do not open a public issue for an unpatched security problem.

Include the affected version or commit, impact, reproduction steps or proof of concept, and any suggested mitigation you have. Remove real credentials, private documents, and unnecessary personal information from the report.

If a secret was exposed, revoke or rotate it with its provider first. Never paste API keys, tokens, certificate passwords, private keys, or signing material into an issue, discussion, screenshot, test fixture, or repository file.

## Supported versions

work-fold is an early-stage project. Security fixes target the current public release and the `main` branch. Upgrade to the newest release when a fix is published; older releases may not receive a backport.

## Security boundaries

work-fold is local first, but local does not mean that every action is sandboxed:

- A Space exposes an ordinary folder to the local application and Pi's filesystem tools.
- Selected chat attachments and later tool results may be sent to the configured model provider as part of an Assistant turn.
- Skills can influence model behavior and may include executable scripts.
- Extensions and Pi packages can execute code with the current user's permissions and can make network requests.
- Creating or registering a Space authorizes work-fold to load project configuration from its `.pi` and other Pi-supported project resource locations. Registration is authorization, not code review, signing, or malware detection.
- Personal capabilities are available across Spaces and should be reviewed even though they do not use registered-Space authorization.

work-fold intentionally treats successful Space creation or registration as the project-runtime grant and removes the redundant trust prompt. Native Pi Extensions in that folder can execute with the current user's permissions during catalog loading, and later local, source-control, or synchronization changes to `.pi` do not trigger another prompt. Removing the Space revokes work-fold's exact-root override; it does not rewrite Pi's independent trust store for other Pi clients.

### Included native integrations

Computer control, Chrome, Web, Documents and MCP use ordinary Pi Extensions
and the same full-user authority as other native tools. The reviewed source,
package versions, licenses and before/after patch digests are pinned in
[the integration manifest](patches/included-tools/manifest.json). Preparation
refuses unknown or partially patched input. The computer helper is built from
reviewed source and included in the app's signing lane; normal installation
does not run upstream helper downloads. These checks establish provenance,
not a sandbox or proof that every external action is safe.

Native resource enable/disable preserves Pi's filters and scopes, pins the
resource and settings identity, journals before effect, and refuses changes
while affected work is active. It is a lifecycle control, not a way to revoke
a hostile full-trust process. Included factories do not start connections,
watchers or setup work during catalog inspection. Native third-party code can
still execute its own factory during Pi loading.

Chrome's Store companion authenticates through an exact-origin native helper
and an app-owned selected-installation proof. Native Messaging authenticates
the extension ID, not the profile. The temporary HTTP lease stays in native
runtime and service-worker memory; the public ZIP contains no user secret.
HTTP polls/results require the selected origin, credential and connection ID,
with protocol/capabilities checked before command delivery. Disconnect and
profile changes refuse affected active work, then revoke stale queues/results
at the accepted safe point. Readiness requires authenticated transport evidence;
socket reachability and issuing a lease are insufficient. See
[Chrome distribution](docs/chrome-extension-distribution.md).
Computer setup names the actual helper identity for macOS permissions. Both
return requested observations through Pi; neither provides continuous screen
recording. External effects may survive Stop and are not made reversible by
receipts. Document scripts run full trust in a terminable worker, with bounded
helper outputs; independent child processes created by a script are outside
that worker's cancellation boundary. See the reviewed dependency mitigations
in [the integration notes](patches/included-tools/README.md).

MCP setup is a trusted local operation bound to an open setup session and an
exact registered Space/runtime. Credential writes and OAuth token commits
recheck the selected configuration revision inside the same capability fence.
Closing setup cancels OAuth and probes; restart does not resume them. Saved
secrets are not returned in status, native config errors omit source snippets,
and neither the CLI nor paired browser can enter these secrets. Native HTTP
and stdio transports remain upstream-owned; only the configured Pi files are
loaded, automatic other-app imports are disabled, and MCP sampling is disabled.
A Chat-owned question from a reused connection must not adopt a newer task's
identity or become available to an unrelated paired browser.

### Model context inspection (development)

The model-context inspector is an opt-in, memory-only local developer
surface reached explicitly through `?dev-context`, with no normal Chat, fold
or Settings entry. Its routes require the existing renderer authentication; Chat filters
check exact scope and conversation identity. It has no remote, CLI or
restricted-app operation. Capture excludes authentication options, headers and
environment, bounds snapshots and replaces image bytes with metadata, but
recorded message text can contain secrets. Clearing or disabling invalidates
late recorder callbacks. The observer preserves native Pi hooks and payloads,
does not consume model streams, and cannot gate model work. See
[the context inspection contract](docs/tool-feedback.md#inspect-model-context).

### Legacy containment and clean break

work-fold has a new application id, profile, updater cache, internal scheme, CLI, repositories, and `.work-fold/` metadata contract. It never opens, parses, imports, migrates, mutates, or deletes the legacy Workspace profile, `.workspace/` metadata, restricted-app registry, storage, connections, receipts, or artifacts. Those formats confer no work-fold identity or authority. Legacy `.workspace/` content remains hidden from Files and excluded from History, Search, Check targets, and restricted-app grants so registering the same ordinary folder cannot accidentally expose it. Pi's personal resources and auth may remain shared at the configured Pi root, but work-fold sessions use a separate `sessions/work-fold/` namespace.

This is a preservation boundary, not a wipe. Uninstalling work-fold does not remove legacy Workspace state, and the app must not offer an automatic cleanup or migration path for it. Any future import would require a separately designed, explicit, inspectable, and reversible product decision.

Loaded Extensions can contribute `surface.json` views. work-fold accepts these only beside an Extension Pi loaded, rejects links and oversized or invalid manifests, and renders a fixed plain-data block vocabulary through host-owned components. Surface manifests cannot inject HTML, scripts, styles, event handlers, or React code into the renderer. This protects the renderer boundary; it does not sandbox the owning Extension process or make that Extension safe.

Restricted app packages are a separate lane. work-fold validates the closed version-2 `agent-app.json` contract, including each named automation's schedule and exact permission subset; rejects lifecycle scripts, binaries, native build and Pi declarations, unsafe paths, links, and bounded-size violations; and installs only an exactly inspected content digest. Enumeration captures regular-file identity and bounds; exact file-handle reads recheck identity before and after, and one bounded byte snapshot supplies the manifest, totals, and digests, so concurrent replacement fails closed. Dependency metadata is inert because work-fold never resolves it or invokes npm; all runtime assets must already be in the inspected package. Inspection and installation do not evaluate package JavaScript. Installation grants every declared network destination, Space-file permission (a folder permission binds to the whole Space), notification category, and Check-result slot, and turns on every declared automation, because those declarations bound generated code rather than the person's own Assistant. Secrets are never granted: a destination that needs one stays disconnected until the person enters it on the trusted surface. The person can revoke any grant, disconnect any destination, and turn off any automation afterwards, and every change is receipted.

The direct Chat-bound or advanced package install is a source-Space Development preview, not a release-backed App. App Studio is the separate trusted management plane for the local Release lifecycle. It keeps the Project declaration in application data, snapshots inspected previews into an immutable `work-fold.app-release` format-version-2 closure, stores that canonical envelope under its digest, and records preparation before a separate local publication step. Publishing rechecks the exact preview stamps and does not upload, sign, list, host, or grant the Release. App-level title, description, and icon are part of the v2 digest-covered manifest, so installed presentation cannot float independently from executable identity. The Release store enforces per-object, object-count, and four-GiB aggregate byte limits with bounded directory iteration. Startup verifies each closure once and validates compact verified projections against the registry and placed packages before orphan pruning. Explicit deletion is blocked for an active Instance, either side of a prepared operation, or retained-data lineage; registry removal precedes safe, restart-retried physical pruning. A validated orphan that is temporarily locked remains inert and cleanup-pending without blocking startup, while referenced-object, canonical, path, and snapshot failures still fail closed.

Local install and update are two-phase management operations. Preparation durably records the operation id, target Space, Release digest, Runtime Instance and new Feature/Data allocations, continuity choice, and deterministic plan. Activation re-reads and verifies the published Release, rejects a stale source/active pointer or target Feature-id collision, recomputes an update plan byte-for-byte, places exact packages, stops predecessor hosts, and commits the new registry authority once. One App Instance is allowed per `(projectId, target Space)`, and a target cannot already contain the same Feature id in either runtime kind. The current local runtime rejects Releases with data schemas or migrations; it never executes an unimplemented migration. Rollback uses the same verified planner and activation path as a forward update.

Visible restricted-app UI runs from a verified in-memory snapshot in a sandboxed, context-isolated `WebContentsView` with Node disabled, a unique ephemeral session, restrictive CSP, direct network/navigation/frame/dialog/permission paths denied, sender-bound IPC, and lifecycle limits. Assistant actions and automations use a separate hidden sandbox with time and byte limits. Worker host powers exist only while an accepted action or automation is pending; automation powers are the intersection of the job's declared subset and current grants. Network, file, and tab powers from UI require an active visible view, and hidden UI is throttled. Notifications accept only a declared category id during an enabled automation that includes that category; the host supplies fixed single-line copy, rate limits by Space/app across renderer restarts and app updates, and revalidates click authority before opening the owning Space. A manual run while its schedule is disabled cannot notify. Brokered public HTTPS requires an installed-revision grant, enforces method/origin/redirect rules, rejects private and reserved DNS results, pins the resolved public address, and injects encrypted API-key, bearer, basic, or refreshed OAuth PKCE authorization only in main. OAuth discovery and token endpoints use the same public-address controls; client secrets, package-supplied endpoints, and device-code auth are rejected. Numeric loopback HTTP is a separate anonymous-only grant with no DNS or redirects; it verifies address and port, not process ownership. Network and file grants compose: app code with both powers can send user input, app storage, Assistant-action data, or content read from a granted Space file to a granted destination. The broker constrains where and how a request is sent, not the meaning or sensitivity of its body.

Revoking a network destination stops broker access but does not delete its separately stored connection; **Disconnect** deletes the local encrypted record but does not rotate an API key or bearer credential or revoke provider-side OAuth authorization. Current local connections bind the exact Tenant, Runtime Instance, Feature Installation, canonical Feature Revision, declaration, target, and Runtime Instance owner; Principal-owned consent and delegation remain future product work. Unsupported or legacy connection schemas remain inert and are never imported; an explicit connection in work-fold always creates a new work-fold-owned binding. Credential replacement, Disconnect, app update, and app removal invalidate the OAuth binding generation so an in-flight browser connection or refresh cannot restore a deleted local token. Every host effect callback also checks its captured launch generation, live-instance membership, abort state, and persistent seven-domain authority. Network authority is checked before DNS and each request or redirect; storage and Space-file authority is checked after temporary-file sync and immediately before atomic commit; OAuth authority is checked before browser/provider effects, token injection, encrypted-store calls, and encrypted-store commit.

Automation launches re-read installed-revision authority and current grants at launch and are serialized with grant, connection, update, and removal mutations; manual runs use the same Space capability-mutation authority lane. On process startup, scheduling remains deferred until pending Space removals have recovered; any still-pending Space ids are excluded before the first job can launch. Once a live Space-removal intent commits, a whole-Space runtime fence synchronously removes that Space's scheduled jobs and broker authority; queued runs recheck the fence after durable acceptance and immediately before host invocation. One host scheduler limits the machine to four active jobs and prevents same-job overlap; that number is a generous default, not a cap, and Settings → The fold → Limits shows it. The service durably records acceptance in an installation-independent ledger before starting a worker, then terminalizes by run id even if update or removal detached the installation. If startup finds an accepted run without a durable worker result, it records `interrupted`/`expired` and explicitly leaves external-effect completion unknown instead of guessing an outcome. Registry writes enforce the same 5 MiB ceiling as reads, and automation admission reserves worst-case terminal-receipt expansion before a worker may start. Durable receipts capture the accepting Tenant, runtime, installation, canonical revision, Data Namespace, effective Principal, exact authority, occurrence, attempt, and outcome without including app payloads or credentials. Unsupported, future, or legacy registries and receipts fail closed or remain inert; work-fold never imports a legacy Workspace registry or invents authority facts. A registry written by a newer work-fold version is never downgraded or rewritten: packaged startup offers the configured updater first and the public Releases page as a fallback, while malformed or ambiguous registry input still fails closed. The `local:api`, `local:dev`, non-packaged Electron, and uninstalled Windows package entrypoints use a separate platform application-data root by default so ordinary development and release-candidate QA cannot advance installed-product schemas; only the installer-owned Windows app selects production state. `WORKFOLD_STATE_DIR` and `WORKFOLD_DESKTOP_STATE_DIR` are explicit opt-in overrides; the child-only `WORKFOLD_CLI_STATE_DIR` cannot opt a desktop process into that state. Host-owned JSON storage is quota-bound and Tenant/Data-Namespace-owned; bounded storage-change hints go only to the active visible owning UI and are never queued for hidden views or workers. Update, removal, and Space-removal transitions commit idempotent cleanup obligations with the authority change, so interrupted credential, storage, or placed-package deletion is retried without making old authority reachable. File requests are grant-relative and reject traversal, links, `.work-fold`, legacy `.workspace`, `.pi`, oversized operations, and undeclared writes; grants are validated against existing ordinary targets, and writes are atomic and History-covered. The real-Electron preparation probe exercises both hosts, including direct loopback denial, out-of-lifecycle worker denial, storage, file write/read, automation notifications, storage invalidation, host-owned tab creation, and termination of a hung worker. A Node process, worker thread, or `vm` alone is not an acceptable boundary. Chromium exploit and CPU/memory denial-of-service risk still exist, so Electron must remain current and the runtime probe must stay release-gating. See [Restricted app runtime](docs/restricted-app-runtime.md).

Whole-App uninstall stops every Feature host, invalidates OAuth work, removes runtime and connection authority, and requires an explicit retain-or-purge data choice recorded in its administrative receipt. Retained namespaces have no live installation and can only be purged later in the current product; they are not silently adopted by a reinstall. Cleanup obligations remain restart-retried after the authority commit. work-fold blocks removal of either the Project's source Space or an App Instance's target Space while that release-backed Instance is active, so Space removal cannot bypass the whole-instance data decision. A retain choice also blocks source removal until explicit purge, while the former target may be removed. Neither uninstall nor purge deletes Project source or separately selected ordinary Space files. Once those obligations are gone, source removal clears its machine-local Project/Release lineage and safely reconciles unreferenced immutable Release objects; transient reconciliation failure is retried before later App mutations and at startup. Target removal cancels unactivated operations aimed at it.

Space removal itself is a durable two-phase operation. work-fold persists an intent before revoking trust, stopping clients, or clearing App state; that intent keeps the Space hidden and untrusted until idempotent startup recovery finishes. Managed-folder deletion is authorized only for the exact canonical directory and filesystem identity captured by the intent. work-fold atomically moves that identity to a random transaction-bound sibling on the same managed filesystem, revalidates it there, durably records the claim, and recursively deletes only the claimed path. A swap, failed restore, replacement directory, junction, symlink, retargeted parent, or uncertain I/O state remains preserved and cleanup-pending; recovery retries a mismatched-claim restore and never redirects deletion to a new occupant of the registered path. Node does not expose handle-relative recursive deletion, so a malicious process already running as the same operating-system user could still attempt to discover and race the high-entropy claim path after verification; hostile same-user filesystem manipulation is outside this local boundary. Post-commit cleanup failure is reported as pending rather than as a false rollback.

Only install Skills, Extensions, and packages whose source you understand. Review capability provenance and supporting scripts before use, especially when a package can run shell commands or access sensitive folders.

A GUI launch (Dock, Finder, Spotlight, `open`) resolves the current user's login-shell environment once at startup so the Assistant's shell tools see the same `PATH` a terminal `pi` session would. The probe executes the user's own profile files under the user's own account — the same code a new terminal tab runs, so it introduces no new trust boundary — with stdin closed, a bounded output size, a ten-second timeout, and a process-group kill on timeout; a failing or hanging profile leaves the launch environment untouched. Imported values never override explicit `WORKFOLD_*`, `PI_*`, or Electron runtime variables, `NODE_OPTIONS` and process-identity variables are never imported, and `WORKFOLD_DISABLE_LOGIN_SHELL_ENV=1` disables the probe. Provider requests use the same guarded, proxy-aware HTTP dispatcher and idle timeouts as the Pi CLI.

## Local management surfaces

On the development branch, restricted apps can make named
[Assistant requests](docs/app-assistant-tasks.md). A request is journaled and
dispatched at once as an ordinary full-trust Space Chat in the owning Space, not
a tool-restricted subagent, and the trusted Apps UI exposes its status, result,
Open Chat, and Stop. The app gets only its own task state and successful bounded
reply. Admission pins the installation, revision and authority; updates and grant
changes cannot overtake an active Space turn. Views and workers may request;
shared viewers and remote app views can neither request nor read these tasks.
Bounded inference is the separate, smaller lane: one model call on the Space's
configured model with no tools and no transcript, available on the same terms and
receipted with the effective model and usage. Restart never auto-replays an
uncertain acceptance.

Assistant work is tracked in machine-local request records under the
application-data `requests/` directory: which turn asked, which Spaces and
turns it spans, its open questions, and the results handed back. Those records
never enter a Space folder and are not captured by History. What crosses into a
Space Chat is only that Chat's assignment, an answer to a question it asked, a
payload someone deliberately released to it, and files copied through the
ordinary restore-pointed path — the request graph, other Spaces' results, and
the fold's transcript stay above Spaces. A question stops its own task rather
than holding a resource: the turn ends, one accepted answer starts exactly one
continuation turn, and a second answer, a late answer, or an answer from a
Space that does not own the question is refused. Requests carry a deadline and
child, depth, concurrency, and continuation limits so a runaway stops, and
every refusal names the limit it hit. An app's change hints carry ids and
revisions for that app's own Assistant tasks, its selected Checks, and its
granted folders — never content, never replayed after a view closes, and never
a reason to start a model turn.

The packaged main renderer and management popover talk to a loopback-only local API with a per-launch desktop session token and an app-specific allowed origin. That boundary is for trusted packaged renderers; it is not a network API intended for other local applications. The sandboxed popover uses a dedicated narrow preload exposing only that API session, dropped-file path resolution, hide/show-main actions, and window material; it does not inherit the main renderer's folder, restricted-app, update, settings, or shell bridges. Development mode has different local-origin assumptions and must not be exposed beyond the loopback interface.

Optional Remote access does not expose that loopback API. The public bridge
accepts only a closed list of semantic operations and routes opaque signed
envelopes to an authenticated desktop WebSocket. Password sign-in alone is not
Assistant authority: every new browser generates non-exportable signing and
key-agreement keys and a fresh pairing id. Browser and desktop independently
derive the displayed six-digit pairing code from that id, the browser
identity, and both P-256 public keys, so a relay substitution changes the code
the person compares unless it hits the short authentication string's six-digit
collision space.
The resulting desktop-signed grant is bound to the account, browser keys, and a
revocation generation. The desktop re-reads its operating-system-encrypted
grant state immediately before an operation and before each progress event a
live watch streams; disabling Remote access, revoking
one browser, revoking every grant generation, or deleting the address stops
later operations and silences an in-flight watch. The bridge enforces exact origins, host-only SameSite secure
cookies, stable session-bound CSRF tokens, bounded bodies, fresh signatures,
login/enrollment/operation rate limits, and security headers. Malformed login
addresses are rejected before scrypt; well-formed checks pass through bounded
IP-only admission and a fair queue with global and per-IP concurrency limits.
There is no attacker-triggerable account-wide pre-verification lockout. Its
PostgreSQL records contain a scrypt password verifier, public keys and certificates, hashed sessions, and
operation metadata—not device/browser private keys or durable decrypted
message/file bodies. Live presence, event streams, and bounded encrypted result
buffers are process-local in the private alpha, which therefore runs one
replica. Database and transient-memory cleanup runs throughout the process
lifetime; per-session operation limits, event-byte budgets, and event-stream
caps bound one paired browser's retention pressure. Device protocol errors
are finite and terminal instead of self-amplifying, unknown typed frames are
forward-compatible, stale replaced sockets are fenced, and SSE clients are
dropped only after an explicit queued-byte bound rather than an ordinary stream
high-water signal.

New-address enrollment is controlled by a server-side deployment switch and
bounded by per-IP and process-wide rate limits. The downloadable desktop carries
no shared enrollment secret: embedding one in a public app would not create a
meaningful authorization boundary. Closing enrollment does not disable or
weaken the independently authenticated device tokens for existing addresses.

A paired remote browser is nevertheless a powerful authority. It can send
prompts to the full-trust management Assistant, read bounded saved management
transcripts, inspect bounded Space-relative file-tree metadata and explicit
text/image previews, and upload
bounded files while the desktop is online. Selecting a Files tree never selects
another Assistant. The management Assistant may delegate through the attributed
act path; those child turns reuse the canonical registered-Space runtime, native
Pi resources and tools, conflict rules, and History path.
File previews exclude ignored and reserved paths, links and nested registered
Spaces, recheck file identity and registration after reading, and travel only
through the paired-browser encrypted operation lane. Revocation fences late
completion and cache insertion. HTML/SVG remain escaped text; shared viewers
have no preview operation. See [preview bounds](docs/fold-file-previews.md).
Private app views use a separate exact-installation adapter over the reviewed
web-entry/selected-data read surface. Both intermediary and app frames are
opaque; the management document keeps its restrictive script rules, and
the intermediary denies direct network access and non-blob child navigation.
An exact-source, per-view message channel exposes only bounded reads. Public
viewer hosts cannot load this adapter or its management operations. See
[browser app isolation](docs/fold-browser-apps.md).
The separate browser-action foundation requires exact installation and browser
provenance, an exact installed-revision digest, durable acceptance and a live
grant fence. Native broker effects recheck that fence even after dispatch.
Idempotent retry returns the original receipt; uncertain accepted work becomes
Interrupted at startup without replay. Revocation fences accepted runs. A
request from a paired browser's app view runs on acceptance, as the same app's
actions run on the desktop; the app frame can only ask, read, list, or stop its
own requests, neither the read bridge nor shared viewers can reach them, and
the private trusted parent outside the frame shows each request and offers
Stop. Forged frame request messages are refused before entering the encrypted
adapter.
Direct task-scoped request status, work details, addressed answers, explicit
continuation, and stop calls through the remote semantic adapter are bound to
the browser identity and exact grant that accepted the root management request.
These controls include its deliberately linked descendants; unrelated requests
are refused. Local trusted screens share the same host projection and journaled
action paths; restricted app bridges and public viewers gain no question access. Summary projections omit task ids and action details for other grants.
This is not isolation between mutually hostile paired browsers: each can
still prompt the same full-trust management Assistant inside the product's
personal single-user trust boundary.
The semantic adapter removes absolute roots and attachment targets and does not
expose capability/settings mutation or generic local calls, but each Assistant
itself remains taught rather than tool-restricted and may use ordinary local
tools under the current user's permissions.

Revocation and address removal attempt local task/upload/cache cleanup and
server cleanup independently. The desktop retains the only device credential
until account deletion is confirmed, treats a later unauthorized response as
confirmation that the stored device credential no longer authorizes that
account, and does not treat network or server failures as deletion success.
Bridge grant, session, operation, and event-stream cleanup is account-scoped.

One message accepts at most six plain-named uploads, 6 MB each and 8 MB total.
Uploads are temporary app-owned management references
with a 64 MB retained cap and a 24-hour retention window; revoking one browser
purges its holding folder, and disabling Remote access purges every remote
management holding folder. The Assistant may explicitly place one into a Space
through the normal restore-pointed path. Responses expose upload names and sizes,
never local holding paths.
Pair only browsers you control, revoke a lost browser promptly, and use a
unique password. The hosted web client and bridge are trusted parts of this
private alpha's authority boundary. Signed application-encrypted envelopes reduce
plaintext persistence and passive relay visibility, but same-origin hosted code
can use a paired browser's non-exportable key; they do not protect against an
active hosted-service compromise, a compromised paired browser, or a
compromised desktop endpoint. Public/full-trust release requires either a
separately installed and pinned signing client or another authority design that
does not grant mutable first-load web code this power.

The installed `work-fold` command uses a separate protocol-v1 file broker under the platform application-data directory (`%APPDATA%\work-fold\cli` on Windows and `~/Library/Application Support/work-fold/cli` on macOS). Requests and responses are UUID-named, atomic, size- and age-bounded, path-confined, and rejected when they are symbolic links or unsafe file types. Electron's single-instance host serializes accepted requests and cleans stale files.

That broker is same-operating-system-user coordination, not authenticated interprocess communication. Another process running as the same user may be able to submit a request or read its result. Protocol v1 — the read lane — therefore exposes only compact Space names/paths, running-task metadata, and capability provenance/status. It does not return file contents, conversation text, API keys, provider credentials, or signing material, and it never mutates anything.

Mutations ride a separately versioned act lane over the same broker files. Act requests must carry the per-launch act token the interactive app mints into `cli/act-token.json` on startup and removes on quit; without the running app there is no token match, no act facade, and nothing mutates. The token binds requests to one app run on a single-account machine — it does not distinguish same-user callers, and same-user processes remain inside the trust boundary. Every act command names its Space explicitly (no working-directory resolution for writes), reuses the interactive app's registered-Space trust grants, History checkpoints, capability-mutation locks, and active-turn conflict checks, and is executed at most once: a mandatory flushed `accepted` journal record is written to `cli/receipts/act.jsonl` before the mutation runs (an unwritable or damaged journal refuses the command), a terminal outcome record follows it, and a duplicated request id — including one replayed after the broker's response file was cleaned up — is refused rather than re-executed. The broker additionally refuses requests older than its freshness window, and the journal retains replay-relevant records for at least that window. Because act commands include starting Assistant turns, reading their results, searching content, and listing History, Library, and app records, act request and response files can briefly contain prompt, conversation, query, glance, and listing text; they remain bounded, local, and are deleted after completion, and the receipts journal itself stays metadata-only. The `manage` command group talks to the management conversation — a machine-local conversation scope above all Spaces whose transcript lives under the app profile's `management/` root. Its Pi session is granted that app-owned folder, whose only project configuration is what work-fold itself materializes there (the management `AGENTS.md` and `manage-spaces` Skill), plus the user's personal-scope capabilities. Those app-owned resources are mandatory: if they cannot be prepared as safe regular files and directories, the management scope remains unavailable instead of running uninstructed. It is a full-trust Assistant: like every work-fold Assistant it keeps ordinary local file and shell tools that can reach anything this user can. The materialized instructions teach it to prefer the `work-fold` commands — journaled, Space-explicit, restore-pointed — for cross-Space work, but that is guidance, not an enforced authority boundary. Management file/folder/link attachments are bounded references, not copies: missing or unsupported sources are refused, a symlink cannot be attached as the reference root, and their contents remain untrusted data. Readable files may enter model context; folders, binaries, oversized files, and links remain path/link references until tools inspect them. Downstream mutation lineage is explicit rather than ambient: the Assistant passes the active management task id as `--parent-task`, the act host validates it before the journaled mutation, and unrelated same-user commands are not credited to the request. Request projections and request-level stop state last for the app run; the transcript and act receipts are the durable records. Chat-scoped grants, confirmation ceremonies, and per-grant revocation remain future work for any surface that outgrows this personal single-user boundary. See [work-fold management layer](docs/management-layer.md).

**Receipts, not gates.** work-fold has one authority setting for acts: none. Every act-lane verb — including making bytes runnable, widening an app's or a page's standing power, and deleting — runs on its first call through the same prepare, pin, journal-first, fenced execution path the desktop uses, and returns a receipt. The security properties are the receipt and the pins, not a person's click: journal-before-effect, identity pins rechecked at effect time, at-most-once execution, failure without automatic retry, capability-mutation fences, and turn-conflict rejection all remain. A changed package identity or a moved target invalidates an act instead of executing something else. Receipts preserve the initiating surface and, for remote-originated acts, the exact browser and grant. A paired browser inherits the same lane; it gains no authority the desktop does not already hold.

Destruction is reversible. `files delete` always succeeds: History covers what its restore point can, and every other path is moved into a machine-local trash under the application-data root with a manifest per item (source Space, original Space-relative path, kind, size, deleted-at, restore-by, and the receipt that produced it). `spaces delete` moves the managed folder there and unregisters the Space; clearing an app's storage, purging retained data, and uninstalling with purge leave a recoverable copy there first. Items are restorable from Settings → The fold → Recently deleted and from `work-fold trash list|restore`, and are removed only when their retention window ends (30 days by default). No verb empties the trash, and retention never erases an item whose tree contains legacy `.workspace/` state. The clean-break rule for legacy `.workspace/` trees and the rule that `.work-fold/`, `.pi/`, and `.workspace/` are never valid file endpoints are unchanged.

The only human-only surfaces establish identity or secrets: entering a provider or app secret, pairing a browser, and enrolling or administering a remote address. They have no act verb and no remote operation, and no task needs them mid-flight. This boundary binds the product's lanes; the management Assistant remains full-trust and taught rather than tool-restricted, and same-user processes remain inside the local trust boundary, exactly as documented above.

Routings are the one thing above Spaces that runs unattended. A routing is a machine-local, closed, typed declaration — no code, no credentials, no expressions, and only the literal declared message plus a closed set of host-resolved placeholders — enabled by one receipted `routings enable` act that pins the exact declaration. The executor is app code on the shared scheduler discipline with its own bounded budget; every run and hop is journal-first receipted; a failed hop fails the run rather than being smoothed over; disable and Space removal stop the active run before the authority change reads as complete, and a suspended routing never retargets or resumes without a fresh enable. Unknown placeholders are refused at enable time; resolved text is bounded and recorded on the hop receipt, and a `fold` step reaches the management conversation through the same acceptance path as any other message. Nothing routing-shaped is written into any Space folder, routing-caused settles never trigger other routings, and no routing step can create or widen viewer exposure.

Checks do not treat portable data as authority. `.work-fold/checks/` may contain only strict code-free declarations; registration discovers but never enables them. Enablement binds a local grant to the exact declaration digest, installed sensor revision, and implementation/source digest. The runner rejects root, metadata, Pi configuration, nested-Space, link/junction, special-file, path-escape, Windows device/ADS, target-count, byte, depth, finding, and duration hazards. Sensors receive a host-created closed projection of designated inputs, not filesystem paths, and findings surface only after independent host re-verification; that boundary is checked again before an old finding is shown, so a target that later falls under another registered Space becomes blocked. Infrastructure, admission, skipped-input, persistence, timeout, and damaged-state failures fail closed as health errors. The Files tree fetches aggregate status first and receives only exact current target paths when a decoration is necessary; titles, details, evidence, decisions, runs, and aborts stay behind the trusted renderer's per-launch session token and allowed-origin local API boundary. Check operations reserve their Space before asynchronous work and participate in the same removal/capability fence until completion. Removal acquires its Check-cleanup lease before committing an intent, while Space creation and registration acquire an exclusive registry-mutation lease before changing target ownership; neither can interleave with evidence work. Run acceptance and terminal state are durable, incomplete startup state becomes `interrupted` without replay, and a terminal-write failure retains the same-process task/capability fence for retry instead of releasing a ghost run. Space removal keeps its durable intent until primary and backup Check state have been purged without parsing potentially damaged or future-version bytes; backup recovery strips enablement rather than resurrecting older authority. See [Checks](docs/checks.md).

### Published viewer pages

Optional publishing serves one explicitly designated Space file or an installed App Instance's declared viewer surface to anyone holding a share link while the desktop is online. App viewers receive only the declared release assets and permitted instance-owned data reads; this is desktop-served exposure, not a cloud execution service. Viewer traffic lives on separate `pages-<slug>.work-fold.com` origins that never set cookies, never serve the management client, and never appear in the management operation allowlist; the `pages` slug and `pages-` prefix are reserved at enrollment. Page content crosses the bridge as ciphertext under a per-publication key carried in the link fragment; the key lives in operating-system-encrypted secure settings, and the full share link is shown to the person transiently, appearing in no receipt, journal, or log; the bridge stores slot identifiers, budgets, and counters — no titles, paths, or content — and an explicitly labeled, default-off snapshot opt-in stores only ciphertext. The desktop rechecks the local publication grant immediately before every serve; revocation is desktop-first, bridge cleanup is retried until confirmed, and disabling Remote access or deleting the address revokes every publication. Hosted-app viewer serving enforces a fixed viewer-safe broker subset desktop-side: exact placed Release assets and manifest-flagged instance-owned reads only — never storage writes, Assistant actions, network egress, connections, Space files, notifications, automations, or OAuth — and viewers are never resolved to Principals. Unauthenticated viewer traffic is rate- and byte-bounded at the bridge before anything reaches the desktop. Residual risk is the same class already documented for the hosted client: an actively compromised bridge or hosted origin can serve viewer-shell code that captures link-fragment keys for pages fetched from then on, with a blast radius of those published pages, never management authority. A link is the whole credential — anyone holding it is a legitimate viewer until revocation. The fold cannot create an address to publish to; enrollment and Remote access administration stay desktop-human-only.

## Release integrity

Windows packaging and public distribution are inactive. Version tags do not
start a Windows workflow, and Windows artifacts are not Mac release authority.
The retained manual Windows scripts are development references only and must
not be presented as a supported or publicly trusted release lane.

Local Mac smoke candidates are ad hoc signed and are not public release artifacts. They use the distinct `work-fold Local Smoke` name, `com.work-fold.desktop.local-smoke` bundle id, build-channel marker and application-data directory, and never start the production updater. They must not be renamed or installed over `work-fold.app`; interactive release-workstation testing uses a Developer ID-signed candidate because a user-data override does not isolate macOS Keychain access control. Public Mac releases use the separate `Mat-Tom-Son/work-fold-mac-releases` feed and require an exact public source tag, Developer ID signing, hardened runtime, Apple notarization and stapling, Gatekeeper acceptance, matching DMG/ZIP update metadata, and remote size/SHA-256 verification. The manually installed first release establishes the new identity; a later higher work-fold release must prove the new updater path end to end.


### Recovery, text Checks, and folder triggers (September 2026)

History restore now checks safety-capture coverage before overwrite/deletion, preserves historically excluded descendants, rejects nested registered Space ownership, and holds an ownership/work reservation through capture and restore. Per-file restored bytes use an atomic sibling rename. Relocation of a registered folder rebinds this product's machine-local History/ignore state with a resumable marker; conflicting destination state is refused. External processes can still change ordinary files outside the app's reservations, so History is not a transactional backup against arbitrary concurrent writers.

The new text-review Check calls the native configured model transport with only a bounded rubric and explicit text snapshots. No Chat transcript, general tools, executable expressions, or tool-execution loop enters that request. Input files are no-follow bounded UTF-8 reads, rechecked by identity and content hashes; exact primary-file quotations and all reference hashes are independently admitted and re-verified. Model judgment is labeled as such and cannot establish factual truth. Incomplete/invalid responses fail instead of clearing results. The implementation digest is source-pinned by tests, so changing review authority requires re-enablement. Provider changes now respect the shared active-work fence.

Routing v3 folder triggers observe a reviewed, bounded metadata tree; links, reserved paths, and separately registered child Spaces cannot expand scope. They use the existing journal-before-hop and exact-grant execution path. Observers are invalidated on revocation, pause while routing work executes, and rebaseline on resume/restart; they never replay offline edits or turn generated output into recursive routing chains. The bridge test suite is part of every source/tag CI run. The existing private-alpha hosted-client authority boundary remains unchanged.

### Check proposal and correction review

Fold-led setup prepares an unsent draft and materializes inert Check proposals. One-time trials use exact declared shapes, can transmit designated text to the configured model provider, and never grant standing authority or replace live findings. Passive fold attention starts no agent turn. Corrections retain bounded proposed replacement text in machine-local Check state. Applying is a separate human action that re-verifies primary/reference evidence, preserves exact original bytes in History, journals before writing, and refuses stale or repeated application. An interrupted correction is recorded as failed and never replayed automatically. Space removal purges the same primary/backup Check state, including corrections. See [Checks](docs/checks.md).

### App data recovery and control invalidation (development)

Native views, Assistant tools and desktop app management controls retain exact
Feature Installation identity. CLI and receipted acts propagate the resolved
identity into the same domain services. Ambiguous name-only selectors refuse;
stale pins never fall back to a same-byte reinstall. See the
[runtime contract](docs/restricted-app-runtime.md) for selector behavior.

The development **Change this app** path verifies installed package bytes before
copying them into a fresh source-Space folder with History. It neither executes
package code nor copies runtime data/authority. Machine-local change receipts
pin source preview predecessors; validation rejects competing revisions and new
installation incarnations. The renderer endpoint shares affected-Space mutation
reservations and is not a restricted-app or shared-viewer capability. A prepared
Chat draft grants no model execution. See [app changes](docs/app-changes.md) for
interruption behavior and incomplete workflow edges.

The Apps management surface can export complete instance-owned JSON and restore
only the same installation and exact app revision. Restore validates the
integrity envelope and current storage revision, fences the prior runtime's
data authority, and journals a bounded previous snapshot before replacement.
It never imports grants, credentials, jobs or another namespace's authority.
Retained-data export checks the owning source Project; adoption remains absent.
The local authenticated control-event stream carries only invalidation kinds,
with bounded connections and no event replay or new remote authority. See
[App data recovery](docs/app-data-recovery.md).

Restricted app Check-result access is separately selected per exact installation
and Check revision. It shares only that Check's status, bounded finding details,
relative paths and quoted evidence. It never runs a sensor or contacts a model,
and grants no general file access. Changed declarations refuse; changed app
revisions reset selections. Workers and shared viewers cannot read Check results.

### Fold result navigation

Child-file links derive from full History differences recorded in terminal turn
metadata, never filenames inferred from model prose. Projection rechecks current
Space registration, path visibility, reserved metadata, symlinks and nested
Space boundaries; opening performs the complete bounded file-read checks again.
App result links bind executed installation evidence to an exact Space/app/
Feature Installation. Current revisions are resolved explicitly and disclosed;
removed/reinstalled apps cannot inherit old links. Browser ownership filtering
excludes file and app references from another browser's aggregate request view.
These links grant no app powers and do not widen the content-free CLI read lane.


The [collaboration contract](docs/collaboration-contract.md#completion-delivery-and-recovery)
tracks work across model turns: durable questions and answer delivery, bounded
continuations for each owner, and selected request results. The request graph
and original assignments remain machine-local. Only deliberately released
child reports enter a Space Chat; app task reads remain pinned to their own
installation. See the contract for stop, expiry and restart behavior.

The popover’s saved-chat list and explicitly selected summary use the authenticated renderer lane and read only management-scope transcripts. The paired web chat list adds request state and an answer indicator only for requests owned by that browser/grant; this does not widen question, answer, result, or Stop authority. Inline Space previews reuse the existing bounded inert preview broker. Preparing a Space/file chat draft is local UI state and does not execute work.
