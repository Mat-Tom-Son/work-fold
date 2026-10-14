# Collaboration experience

The person asks for work in a Chat, the work-fold agent, or an App. That remains one
piece of work while agents divide it, ask questions, and combine results.
The interface follows the durable request, while streamed text and tool
activity still follow the current turn.

## Design

**Visual thesis:** calm, compact conversation surfaces using the existing
type, colors, and spacing, with attention reserved for a question or a result.

**Content plan:** the conversation is primary; a quiet work line describes
progress; an inline question supplies the next action; selected deliverables
finish the exchange. Origins, delegated work, and technical details expand
only when useful. This adds no navigation destination or approval ceremony.

**Interaction thesis:** progress updates in place without moving focus or
resetting a draft; disclosure opens with native keyboard behavior; new replies
follow the existing scroll pin instead of pulling someone away from reading.
Respect reduced motion and retain input through reconnects and failed sends.
Question drafts stay in session storage for the current renderer/browser tab;
acceptance clears them, and paired-browser sign-out or grant removal clears all
question drafts. Typing alone never sends an answer to the host or model.

## Shared behavior

- The host supplies status, a short label, outstanding person questions,
  selected results, and available actions. Renderers never infer completion
  or questions from punctuation, an idle model, or an ended stream.
- Working, collaborating, waiting for an agent, and needing the person
  are distinct. Only questions addressed to the person ask for their input.
  Partial results, stopped work, expiry, and interruptions retain their meaning.
- Questions show their exact text and origin. An answer names that question;
  double submission cannot start another continuation. A saved answer whose
  delivery failed shows that saved answer and offers Continue with the saved answer. Ordinary replies in
  the owning Chat continue to work. The accepted action response clears the
  sending state immediately; it does not wait for another read or for the
  continuation to finish. Before announcing a running turn, the host persists
  its accepted message. The owning Chat re-reads that message on an external
  turn start and retires the previous reply; an older transcript read cannot
  settle or overwrite a newer turn.
- Stop closes the selected request and its outstanding descendants, including
  waiting questions. It stays available between model turns. It does not stop
  independent work in the same work-folder.
- Host continuations have explicit message metadata and appear as quiet
  activity, never as messages apparently typed by the person. Older messages
  without that metadata retain their original presentation.
- Results show the summary and selected files with their owning work-folder.
  Structured data is secondary. Opening a file does not copy it into a Chat.
- Failed continuations expose saved work and an explicit continuation action
  where the request still permits one. Restart does not itself replay work.

## Surfaces and boundaries

work-folder Chats, the trusted Settings → Apps page, and the work-fold agent popover share the same React
work presentation. Each work-folder tab retains its identity.

The paired browser uses the same host projection through its encrypted remote
lane. Detailed work, answers, continuation, and Stop remain limited to the
browser's own work-fold agent requests and their descendants. Other overview items
remain summaries and direct the person to the desktop. Public viewers and
sandboxed App bridges gain no request-graph or question access.

## Acceptance

Exercise delegation, a person question, answer, continuation, selected files,
partial completion, and Stop from the originating surface. Also cover a
question in a delegated work-folder, repeated/stale answers, another browser grant,
restart with a saved answer, failure/reconnect with a draft, and keyboard/mobile
interaction. Host integration tests verify authority and exact-once delivery;
browser journeys verify visible state, controls, focus, and rendering.

## Implementation and verification

The host projection is `src/shared/request-presentation.ts`, served by the
local and remote adapters in `src/local/server.ts`. Desktop surfaces share
`web-local/src/components/chat/WorkRequest.tsx`; the paired browser uses
`services/bridge/public/work-request.js`. Both use the same scoped stylesheet
and session-draft helper. The browser's existing inert fixture lane accepts
`work=question`, `saved-answer`, `partial`, or `interrupted` for layout review.

`tests/work-fold-collaboration-journeys.test.ts` exercises actual host admission,
question ownership, repeat answers, request-wide Stop, restart, selected files,
and explicit continuation. `tests/work-request-rendering.test.ts` covers exact
question rendering, escaping, draft/focus retention, failed sends, and duplicate
submission. `tests/renderer-app-assistant-tasks.test.ts` covers results and Chat
navigation in the trusted Apps surface. These are development checks; packaged
Electron and signed-release verification remain separate release work.

## Conversation navigation and work-folder browsing

The work-fold agent popover has a searchable **Chats** view over saved machine-local fold
conversations, with titles, dates, and quiet working/answer indicators. Selecting
a chat pins its transcript, request, model state, and next message to that id;
background refresh never switches the selection. New chat opens a clean draft
without a success alert or confirmation. Text and attachment drafts remain with
their conversation while this renderer lives. A compact return link keeps
background work reachable, including its Stop action.

The paired web client focuses on New chat and saved Chats, with no separate
**Needs you** destination, activity-receipt feed, or Files/work-folder browser.
Questions and saved-answer recovery stay inside the owning Chat. Its sidebar
uses plain saved-chat titles, with questions and live progress shown only inside
the selected Chat. Result files and apps remain available through a collapsed
disclosure. This does not grant access to another browser’s request. The current
web client neither reads nor acknowledges the overview; host operations remain
compatible with older clients. Old Files/work-folder links return to New chat.

**Shared pages** sits beside Settings in the sidebar footer. It opens a compact
popup of up to 32 active publications from the desktop, refreshed on each open.
A click reveals that publication’s current key transiently through the existing
encrypted paired-browser lane, validates its exact isolated viewer origin and
path, and opens it in a new tab with no opener. Titles and health travel without
keys; links are never saved in browser storage. Empty, offline, unsupported,
blocked-popup, and failed-read states remain inside the popup. Closing or losing
the connection discards late reads. This reads existing shares only; desktop
Settings → Shared pages continues to own sharing controls. Chat result previews
retain their bounded inert file broker and exact app installation fences.
