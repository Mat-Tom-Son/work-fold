# File previews in the fold browser

An approved browser can open a file from a Space's Files tree or a copied-file
receipt in a fold request. The dialog shows the Space and relative path, with
Close and Refresh. Review links open the exact staged decision in Needs you.
Links come from host receipts, not inferred filenames in Assistant prose.

`spaces.list` advertises `capabilities.filePreview`; only a desktop with that
capability receives `spaces.filePreview` with explicit `spaceId` and `path`.
This is an approved-browser read through the existing signed encrypted lane.
It neither publishes a file nor attaches it to a Chat, invokes a model, grants
an app access, or changes the conversation target. Shared viewers cannot call
it or load the management client.

The desktop re-resolves the registered Space and reads only visible regular
files. Traversal, reserved metadata, ignored paths, symbolic links and nested
registered Spaces are excluded. Open-file identity and the current registration,
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
cannot erase a copy already seen or saved by an approved browser. No preview
content is persisted at the bridge; existing bounded encrypted response handling
and the hosted-client trust boundary still apply.
