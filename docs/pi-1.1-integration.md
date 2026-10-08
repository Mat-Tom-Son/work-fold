# Pi 1.1 integration trace

The application advances both Pi packages from 0.80.6 to 1.1.0. This is a
native SDK migration: `ModelRuntime`, asynchronous `CredentialStore`, canonical
transcript context and `agent.streamFunction` replace the removed APIs.
The separate MCP adapter is removed. No legacy runtime shim is retained.

## Upstream contracts

The implementation follows the pinned [SDK guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/sdk.md),
[auth example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts),
[codemode/MCP example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts),
[codemode guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md),
[MCP guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md),
and [session format](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/session-format.md).
Copies and examples ship in the installed coding-agent package. The reviewed
patch exports native trusted-setup APIs and retains the equal-timestamp
compaction guard; it does not implement another model or protocol layer.

## Traced paths

| Path | Host boundary and resulting behavior | Verification |
|---|---|---|
| Worker / work-fold agent | API/CLI accepts one durable request, Pi owns canonical session context; streamed text and tools become portable Chat projections | Native runtime, request, cancellation, Chat presentation and CLI suites |
| Provider setup | Settings → host → async CredentialStore → ModelRuntime; encrypted saves publish only after durable persistence | Concurrent save/rotation/failure/abort tests and synthetic Azure transport |
| Auxiliary model work | Titles, Checks and app inference normalize their own bounded context; no Chat transcript or general tools | Existing bounded request, admission and source-digest tests |
| Codemode | Native factory plus default tool modifiers; nested ordinary/MCP calls preserve tool ids and duration, and execute once | Native sessions execute scripts, write real disposable files and cancel MCP calls |
| Image / classifier models | Native typed catalog and operations; all provider connections visible in Settings, chat picker only offers chat models | Native codemode dispatch, separate inspector owners and accepted-turn usage |
| Cache warming | Native economical one-token warming during streaming; off respected, idle bounded to streaming without rewriting personal settings | Real native timer, usage entry, correct inspector owner and no calls after settle |
| Service Connections | Native MCP namespaces/exposure/config/OAuth; catalog cold, session connections background; setup source/revision fenced | HTTP/stdio/PKCE fixtures, scopes, overrides, cancellation and late-write rejection |
| Packaging | Reviewed native runtime/exports hash verified, prepared Electron uses ordinary included Extensions | Desktop preparation, ASAR fixture and tamper checks |

## Adversarial runtime pass

The pass examined persistence, async ownership, cancellation, replay, provider
selection and source-pinned setup. It found and corrected these seams:

- Settings reload discarded startup tool modifiers. Apply them after native
  resource loading; honor explicit tool selections and built-in filters.
- Cache warming reads global settings directly. Bound the host getter, preserve
  the saved preference, observe calls separately, and stop at settlement.
- OAuth callback races need a pending fallback prompt; native per-prompt aborts
  cancel the losing input. Preserve secret classification and browser failures.
- Async secure saves must serialize across providers and not publish failed
  writes. A failed operation does not poison later credential operations.
- Image/classifier-only providers must be connectable without appearing as
  chat models. Their native usage contributes to the accepted turn.
- Project MCP overrides must not copy global provider auth or revoke shared
  credentials. Runtime teardown precedes auth changes and blocks late refresh
  commits. OAuth jobs recheck configuration at actual token commit.
- Generic provider finish errors still require retry normalization. Preserve
  the native EventStream contract and the native one-retry overflow boundary.
- Canonical context includes system/tool deltas. Inspector digests replay those
  deltas; auxiliary calls normalize separate contexts. Do not write agent state
  to change future session context.
- Pi 1.1 hoists reviewed dependencies. Fresh installation must not manufacture
  nested copies absent from the lockfile.

## Frontend and cross-cutting pass

The second pass checks the prepared UI, API, CLI, resource catalog and package
projection. Tool durations survive host events, saved Chat trails and renderer
previews. Nested tools retain distinct identities. Provider connection setup
covers all model types, while model selection remains chat-only. The five
included tools and work-folder navigation remain unchanged in structure.
Native built-in factories appear once under Core Tools, without duplicate raw
Extension rows. Connection setup derives its guidance from the current list,
and a probe names the selected connection instead of implying every service
was checked.
The live pass also exposed a pre-existing History preview race: listing and
previewing competed for the same host fence. The renderer now sequences those
reads, drains obsolete inspections before newer effects, and retains the
domain's ownership fence. Regression coverage includes Strict Mode replay.

The isolated unpackaged Electron acceptance pass used a loopback synthetic
OpenAI-compatible provider and a real local HTTP MCP peer. Computer use verified
folder registration, native codemode writing and reading a disposable file,
nested activity trails, file links/previews, History preview/file comparison,
model settings, the five included
tools, connection setup/probing and MCP invocation from a Worker. A held stream
continued across tab changes; Stop closed the provider request and left an
aborted durable result. Reopening retained completed/stopped Chats and their
activity without replaying provider calls. The normal macOS CLI shim completed
its own native codemode turn, followed the exact task to a persisted succeeded
result and reported no remaining active tasks. Final command results are
recorded in the PR.

## Deliberate boundaries

Native MCP 1.1 currently provides tools and resources, with no elicitation or
sampling support. HTTP servers without explicit auth use native OAuth on 401;
servers start in the background for real sessions. The default exposure is
codemode, and native deferred/direct/hidden exposure remains supported.
Direct calls expose server text/images with Pi's bounded output policy;
codemode scripts receive the complete structured result and can release selected
records and pagination cursors to the model.
Chat `/mcp` displays status and routes setup to Skills & Extensions. Desktop
bearer and OAuth credentials are encrypted; browser/CLI development uses native
private Pi profile files. OS permissions, real provider billing/account policy,
external OAuth accounts and signed release installation require their own live
acceptance evidence. Local synthetic providers and peers do not certify them.
