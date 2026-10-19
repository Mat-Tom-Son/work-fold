# Worker tools and working copies

The Worker has five complementary ways to keep complex work moving. All use
the accepted turn's request, authority, Stop and receipts. The CLI remains
available to every shell-capable agent.

## Structured collaboration

`chat_handoff`, `chat_steer`, `chat_copy`, `chat_report`, `chat_ask`,
`chat_answer`, `chat_stop`, `chat_children` and `chat_wait` call the existing act facade directly. The host
supplies the Worker's own current task and work-folder. Assignment text is
ordinary structured input, so code, quotes, dollar signs and newlines never
pass through a shell. A handoff defaults to the same work-folder; another
destination must be named explicitly. Child ownership, file copies, selected
results and one-time delivery are the collaboration contract's existing rules.
After compaction, `chat_children` (CLI `chat children --work-folder <id>
--task <own-task-id> --json`) recovers the caller's delegated task handles so
`chat_wait` can read a result again. It exposes no unrelated Chats.

## Asynchronous questions

`chat_ask` with `asynchronous: true`, or `chat ask --asynchronous`, records a
durable question while independent work continues. The request reads working
while its turn runs, then waiting if an answer is still outstanding. Trusted
surfaces can accept an answer during the running turn. It is journaled at once;
the response says queued and has no continuation yet. Once the Chat is idle,
one answer continuation incorporates the recorded answer. Stop closes that
path. Restart preserves the answer but never automatically replays a turn;
the existing answer retry is the explicit recovery path. Ordinary blocking
questions retain their existing behavior.

## Interactive terminals and services

`job_start` accepts `interactive: true`. `job_input` sends exact text, including
newlines or Ctrl-C, with an optional EOF. The CLI equivalents are `jobs start
--interactive` and `jobs input --work-folder <id> --task <own-task-id> --job
<id> --text <text> [--eof]`. Input is limited to 64 KiB per call and is never
copied into an act receipt. Inspect output before retrying uncertain input.

The terminal relay uses macOS's `/usr/bin/expect`, which allocates a PTY without
requiring Electron to have a controlling terminal. Other POSIX hosts need
that executable; Windows interactive jobs are unavailable. Both the relay and
the terminal's process group are stopped and drained before settlement and
History. Restart checks recorded process start identities before killing.

`job_start` with `service: true` (CLI `jobs start --service`) runs a server or
watcher independently of request completion. The job remains attributable to
its starting request, but does not hold it working and does not wake a model
when it exits. `job_output` lists it and `job_stop` ends it. It still holds a
kernel reservation against deletion/restore/registration removal, and quit
stops it. End services explicitly when the task no longer needs them.

## Managed working copies

`worktree` creates, lists, archives or restores an isolated Git working copy.
The CLI is `worktrees manage --work-folder <source-id> --task <own-task-id>
--action create|list|archive|restore [--ref <committed-ref>] [--id <copy-id>]`.
The source work-folder must be the repository root. Creation resolves and pins
a committed revision (HEAD by default), journals before checkout, disables
checkout hooks, excludes source `.work-fold/` identity/transcripts from
materialization, leaves legacy `.workspace/` metadata unmaterialized, and
registers a new work-folder. Local uncommitted source
changes are left untouched and are not copied. Delegate edits to the returned
workFolderId through the ordinary handoff path.

Records live under application-data `worktrees/`; copies live in the sibling
`<application-data>-working-copies/` directory so linked work-folder content
never contains application state. Every copy is a normal folder and a normal
Git worktree. Archive refuses active work, removes only the registration, and
retains tracked changes, untracked files, conversations and Git history.
Restore validates the Git repository identity and re-registers that same
folder. There is no automatic merge, dependency setup, file deletion or purge.
The creating work-folder owns these management operations. A child edits and
reports from its own copy; it cannot list or archive its parent's copies.

## Read-only helpers

The `helper` tool runs a focused task in a fresh context inside the current
Worker turn. It sees the assignment, selected paths and Worker instructions,
and returns the standard summary/data/files/outcome envelope. It creates no
Chat, request, or session file. Paths resolve inside this work-folder and
refuse `.work-fold`, `.pi`, `.workspace`, and links out. Traversal skips Git
and dependency directories. Tools are read, grep, find and ls, optionally
narrowed further with `tools`. It has no shell, edits, browser, MCP or nested
helper. Read-only helpers may run in parallel through native Pi scheduling.

An optional `model: { provider, id }` selects an already-connected model;
`thinking` selects a supported reasoning level. Otherwise it uses its parent's
model and reasoning. Steps appear in the Chat activity, usage joins the
parent's turn/request totals, and content-free helper records remain on the
turn journal, including stopped runs. Stop aborts and drains helpers before
History and turn reservations settle. A helper ends partial after 64 model
calls. Use durable handoff when work needs questions, edits or later follow-up.
