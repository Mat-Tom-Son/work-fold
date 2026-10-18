# work-fold 0.11.0

October 18, 2026

This release makes Workers better at long, multi-step work, at working with each other, and at checking what they make.

- **Questions with choices.** When a Worker or the work-fold agent asks you something with a few likely answers, they appear as buttons. One click answers, and you can still type your own.
- **Follow up, redirect, copy.** A Worker can send more work to a Chat it already handed work to, and that Chat keeps what it learned. It can correct a Chat that's still running, or copy one to try another approach with the same history. **Make a Copy** is in every Chat's menu.
- **Long jobs run in the background.** Workers can start slow work — exports, conversions, installs, builds — keep going, and get woken with the result when it finishes.
- **A checklist for long tasks.** For multi-step work, a Worker keeps a visible checklist under the progress line. The checklist carries over when the work continues in a later turn.
- **Long turns keep their place.** When a Worker reads so much that its conversation is summarized partway through, it's reminded of its task, your request, and its checklist, and it re-checks its answer.
- **Workers remember.** Tell a Worker something with "from now on…" or "always…" and it saves that to the folder's Worker instructions and tells you what it saved.
- **Checked documents.** Workers now check Word, PowerPoint, and Excel files before saying they're done: they recalculate spreadsheets and look at the rendered pages. The Documents tile shows **Setup Needed** until LibreOffice is installed and links to the download. On a Mac without LibreOffice, Workers preview page 1 or any slide with Quick Look.
- **Workers know their place and time.** Every turn includes today's date, your time zone, and your computer type. Workers and the work-fold agent are introduced as general helpers rather than coding assistants.
- **Set up for me** organizes files with work-fold's own restore points, and it no longer promises that every change can be undone.

Fixes:

- When one Chat hands work to another and waits, the result now appears once instead of twice.
- Usage and cost include cached tokens, so a turn no longer looks almost free.
- A Worker's searches skip the hidden Chat history files in its folder.

For agents on the CLI:

- **Choices:** `chat ask --option`.
- **Following up, redirecting, copying:** `chat handoff --to-conversation`, `chat steer`, and `chat copy`.
- **Remembering:** `work-folders worker instructions --append`.
- **Background jobs:** `jobs start|list|show|output|stop`, plus the `job_start`, `job_output`, and `job_stop` tools.
- **Checklist:** the `checklist` tool.

See [Background jobs](../background-jobs.md), [Document verification](../document-verification.md), and the 2026-10-18 amendment in the [collaboration contract](../collaboration-contract.md).

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
