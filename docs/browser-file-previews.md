# File previews in paired browsers

A paired browser can open a file from a copied-file receipt or a completed
child task in the current work-fold agent request. The dialog shows the
work-folder and relative path, with Close and Refresh. Links come from host
receipts, not filenames inferred from reply text.

Child-task links come from differences between the turn's full pre/post History
checkpoints. The bounded machine-local turn journal retains checkpoint ids and
up to 64 changed/new relative paths with hashes and sizes. Missing or partial
checkpoints produce no links. These are observed changes during the turn;
concurrent edits may be included and are not attributed to the model. Deleted,
skipped and reserved files are excluded. Request projection checks every
recorded candidate against current visibility, and the paired client shows at
most 12 links. Opening reads the current file, not the historical snapshot.
These links follow the request's durable record and turn journal; previews add
no archive of their own. Another browser's aggregate task summary receives no
paths.

`management.summary`, `management.chats`, and `work-folders.list` advertise
`capabilities.filePreview`; only a desktop with that capability receives
`work-folders.filePreview` with explicit `workFolderId` and `path`.
This is a paired-browser read through the existing signed encrypted lane.
It neither publishes a file nor attaches it to a Chat, invokes a model, grants
an app access, or changes the conversation target. Shared viewers cannot call
it or load the management client.

The desktop re-resolves the registered work-folder and reads only visible regular
files. Traversal, reserved metadata, ignored paths, symbolic links and nested
registered work-folders are excluded. Open-file identity and the current registration,
path and visibility are rechecked before returning bytes. Browser-grant
revocation suppresses an in-flight completion and its replay-cache insertion.

UTF-8 previews read at most 256 KiB; a larger text file displays a truncation
notice without splitting its final code point. Markdown uses the client's inert
renderer; HTML and SVG remain escaped text. PNG, JPEG, GIF, WebP, BMP and AVIF
images are limited to 1 MiB. Binary, oversized and undecodable files have honest
unavailable states. `previewDigest` hashes the bytes read, not necessarily the
whole file. Relative path, size and timestamps describe that read, rather than
asserting the file will remain unchanged.

The browser keeps preview contents in memory, clears them on close, sign-out
and detected disconnection, and rejects responses belonging to an older view.
Reconnect asks for Refresh instead of silently replaying a read. These controls
cannot erase a copy already seen or saved by a paired browser. No preview
content is persisted at the bridge; existing bounded encrypted response handling
and the hosted-client trust boundary still apply.
