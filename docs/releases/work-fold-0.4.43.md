# work-fold 0.4.43

October 8, 2026

This update brings Pi 1.1 to Workers and the work-fold agent, adds its native
codemode and Service Connections runtime, and cleans up the Chats navigator.

- Native codemode lets a Worker combine tool calls in a JavaScript script and
  save values for later turns. Tool search and MCP service connections use the
  same native runtime, including nested activity details and cancellation.
- Conversation context, compaction, provider setup, and model-call accounting
  use Pi's new SDK. Existing explicit tool selections remain authoritative.
- Providers with image or classifier models can be connected in AI Models;
  the Chat model picker continues to show only models that support Chats.
- Provider-key saves serialize and become visible only after persistence.
  Service Connection changes stop obsolete runtimes and reject stale
  credential writes. Cache warming respects the saved preference and stops
  when a turn settles.
- Chats omits the Other work-folders heading and other-folder conversation
  counts. The caret sits beside the folder name, and the row and revealed
  New Chat button stay unfilled while retaining keyboard focus indicators.
- History preview sequences listing and inspection so they do not invalidate
  each other's reads.

The upgrade passed both runtime and frontend adversarial reviews, the full
application suite, and real OpenRouter acceptance with GPT-4.1 Mini and
GPT-5 Mini. Live tests covered native tools and MCP, codemode state across
restart and compaction, reasoning, background work, Stop and recovery, the
work-fold agent, and a bounded text Check with admitted file evidence.
The detailed trace is recorded in [Pi 1.1 integration](../archive/pi-1.1-integration.md).

This release uses exact-commit local verification, Developer ID signing,
Apple notarization, and strict artifact checks.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
