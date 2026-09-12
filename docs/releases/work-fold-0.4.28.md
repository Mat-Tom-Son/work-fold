# work-fold 0.4.28

September 11, 2026

Native Pi Extensions can ask questions directly in their Space or fold Chat.
Selections, confirmations, text fields and editors stay with the conversation,
preserve drafts through refreshes, and recover pending questions after
reconnecting. A paired browser can answer questions from its own fold turn.
Stop cancels pending interactions; restarting never replays an answer.

Extension timers and helper callbacks created during session startup keep
working across later turns and reloads. Delayed callbacks from an ended turn
cannot attach themselves to a newer turn. Cancelled sessions can be disposed
and rebuilt without leaving the client permanently blocked.

For development and troubleshooting, **Inspect context** is available from
Chat model controls, the fold header, and Settings → Assistant. Enable
recording to compare assembled model context with the provider payload when
available. Long instruction blocks remain inspectable within the capture
budget. Recording starts off, stays in bounded local memory, and clears when
disabled or when the app quits. Images appear as metadata; captured text can
contain private information.

Shared Assistant guidance reinforces checking results through native Pi tools.
This release prepares the integration path; it does not bundle new computer,
Chrome, document or service-control backends.

On the web, Space headers now have a compact Refresh button beside the title.
The redundant Back to chat and Ask the fold header buttons are removed.

Availability and downloads: [the Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
