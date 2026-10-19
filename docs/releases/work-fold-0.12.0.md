# work-fold 0.12.0

October 18, 2026

This release helps Workers carry complex work through long conversations, use focused helpers, and keep independent work moving.

- **Recover progress and evidence.** Workers and the work-fold agent can recover saved findings and earlier tool results after their conversation is summarized or a question is answered. Recovery stays within the current request, preserves file references and requested read ranges, and marks evidence whose source files have changed.
- **Focused reading helpers.** A Worker can delegate a narrow, read-only task to an in-process helper, select a connected model and reasoning level, and receive its result in the same turn. Helper activity and usage are attributed to the parent; Stop drains the helper before History capture.
- **Structured collaboration.** Workers can hand off, follow up, steer, wait for, and recover their own delegated Chats through typed tools. Delegated handles remain recoverable after conversation summarization.
- **Questions while work continues.** A Worker can ask a question while independent work continues. An accepted answer is queued behind an active turn and delivered once when it is idle.
- **Interactive terminals.** Background jobs can run terminal programs, accept input, and preserve accented text, CJK characters, and emoji. Independently running services retain their ownership and deletion protection without holding a request open.
- **Separate working copies.** Workers can create commit-pinned Git working copies for isolated edits, then archive or restore them. Archiving retains their files; changes are not merged automatically.

Fixes:

- Concurrent background-job starts reserve their slots before asynchronous checks, preventing over-admission.
- Background descendants are stopped and drained before a job settles or History is captured, including processes that ignore the first stop signal.
- Helper defaults handle omitted model, reasoning, tool, and path selections consistently.
- Recovery indexes and Code Mode results avoid repeating large evidence payloads.

Validation includes regression coverage, the complete local release check, and autonomous real-model tasks for research with exact quotations, reconciliation across an answer and source correction, and isolated code repair. The autonomous tasks specify outcomes without prescribing tools; saved evidence is checked independently. These acceptance runs do not establish a model success rate.

See [Worker tools](../worker-tools.md), [Background jobs](../background-jobs.md), and [the collaboration contract](../collaboration-contract.md).

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
