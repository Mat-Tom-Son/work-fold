# Changing an installed app

Status: development branch, not a public-release claim. The Apps tab now has
**Change this app**, which creates a working copy and opens an unsent Chat draft
in the App Project's source Space. The person adds the requested change and sends
it. This does not invoke a model, install code, or grant authority by itself.

## Exact source and provenance

The host reads and verifies the installed package snapshot, including every
file and the manifest, against its installed digest. It copies those bytes into
a fresh visible `<app-id>-change-<request-id>` folder in the source Space and
records the addition in History. It never substitutes the original mutable
source folder or executes build scripts. Runtime data, grants, credentials,
target Space files, and conversations are not copied.

The machine-local proposal registry retains a change receipt with the exact
base revision, original installation/runtime/release identity, source working
path, source preview predecessor, and original building Chat id when a retained
installed proposal provides one. Provenance is not stored in `.work-fold/` or
included in a portable Chat. The draft receives only the app name, version,
and source working path. Missing original Chat history does not prevent
reconstruction from the verified installed package; source toolchains not present
in that package cannot be reconstructed automatically.

An exact request id returns the same ready copy on retry, including after a
restart. A durable preparing receipt precedes filesystem work. After interruption,
an exact existing copy can finish History/receipt preparation; a changed copy is
preserved and requires a fresh change request. A History failure removes only
the newly created copy if it still matches the expected bytes. Linked paths,
corrupt provenance, and mismatched request identities fail closed. The registry
holds at most 1,000 change receipts; reaching the limit refuses new changes rather
than forgetting predecessor guards. Removing the source registration removes
its machine-local change records, never the ordinary working files. Removing a
target retains the source working copy's predecessor guard and provenance.

## Preview and update

The Assistant edits the copy and submits its package using `propose_space_app`.
The proposal host recognizes its source path and pins the source preview's
installation identity and digest. An absent preview is pinned as absent. Review
cannot overwrite a different/newer/reinstalled preview that appeared after the
edit began. A successfully reviewed change advances its working copy's own
predecessor so that further edits can be proposed from the same folder.
If the source already has a different reviewed preview when starting from an
installed Release, preparation asks the person to review that work in App Studio
first; it does not silently replace it with a copy of an older installed version.

Preview installation still uses the existing digest-pinned, reviewed domain
path. Changed code preserves eligible installation/data identity and resets its
external powers. A release-backed target continues using its existing Release
until the person prepares, publishes locally, and reviews an update through
App Studio. The target's identity is retained only in machine-local provenance;
the source Assistant never receives the target's private context or cross-Space
control merely because the person started an edit there.

The complete journey still needs direct navigation to the original building
Chat and the relevant Release/update review. A Release installed in its own
source Space also needs a separate preview placement: the current one-Feature-
per-Space rule refuses this case before copying rather than replacing its live
App Instance. These remain tracked work in [Apps and the fold](apps-fold-workflows.md).
