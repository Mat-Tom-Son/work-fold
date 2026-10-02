# work-fold 0.4.41

October 2, 2026

This update makes included tool status follow real use and adds nested
work-folders and direct Worker mentions.

- Skills & Extensions refreshes status while open and when you return to it.
  Successful document and computer work updates its status automatically.
  Older computer checks keep their timestamp and say **Last Check Passed**.
- Computer **Check** observes without restarting the helper or disposing Chats.
  **Start and Check** starts it without interrupting other Chats; repair is
  separate under **Repair and Recheck**.
  Readiness observations do not delay computer actions or add a document worker.
  Freshly downloaded helpers also work when Gatekeeper relocates them: the
  running bundle must match the expected signed helper exactly.
- Chrome stays Connected during long operations using authenticated command
  heartbeats. Selected profiles reconnect automatically; connection failures
  show useful recovery guidance instead of repeated Store setup.
- Browser input reports DOM fallback explicitly and never repeats a click,
  fill or submission after native input may already have taken effect.
  Multiline text keeps its line breaks without pressing Enter, and field-value
  mismatches are reported for verification.
- Service Connections distinguishes **No Connections** from **Configured**;
  individual connection checks continue to report actual server health.
- Organize work-folders beneath other work-folders and address a Worker with
  an **@mention**. Multiword Worker names match correctly, and retrying an
  accepted message keeps its original request identity.
- Files and Chats use a quieter layout with less repeated decoration, and
  product copy consistently calls the working context a **work-folder**.

The separately built Chrome companion 1.0.2 includes fixes for hidden-page
input, multiline field replacement, targeted typing, tab grouping and recovery
from interrupted long polls. Those companion-side fixes require its separate
extension update. The Chrome Web Store item remains unpublished pending Store
review; this desktop release does not claim Store approval.

The release uses exact-commit local verification, Developer ID signing, Apple
notarization and strict artifact checks. GitHub Actions remains disabled.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
