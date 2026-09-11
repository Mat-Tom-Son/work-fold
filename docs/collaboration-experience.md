# Collaboration experience

The person asks for work in a Chat, the fold, or an App. That remains one
piece of work while Assistants divide it, ask questions, and combine results.
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
- Working, collaborating, waiting for an Assistant, and needing the person
  are distinct. Only questions addressed to the person ask for their input.
  Partial results, stopped work, expiry, and interruptions retain their meaning.
- Questions show their exact text and origin. An answer names that question;
  double submission cannot start another continuation. A saved answer whose
  delivery failed shows that saved answer and offers Continue with the saved answer. Ordinary replies in
  the owning Chat continue to work.
- Stop closes the selected request and its outstanding descendants, including
  waiting questions. It stays available between model turns. It does not stop
  independent work in the same Space.
- Host continuations have explicit message metadata and appear as quiet
  activity, never as messages apparently typed by the person. Older messages
  without that metadata retain their original presentation.
- Results show the summary and selected files with their owning Space.
  Structured data is secondary. Opening a file does not copy it into a Chat.
- Failed continuations expose saved work and an explicit continuation action
  where the request still permits one. Restart does not itself replay work.

## Surfaces and boundaries

Space Chats, the trusted Apps tab, and the fold popover share the same React
work presentation. The main-window glance opens a question inline, without
making the person hunt through Chats. Each Space tab retains its identity.

The paired browser uses the same host projection through its encrypted remote
lane. Detailed work, answers, continuation, and Stop remain limited to the
browser's own management requests and their descendants. Other glance items
remain summaries and direct the person to the desktop. Public viewers and
sandboxed App bridges gain no request-graph or question access.

## Acceptance

Exercise delegation, a person question, answer, continuation, selected files,
partial completion, and Stop from the originating surface. Also cover a
question in a delegated Space, repeated/stale answers, another browser grant,
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
