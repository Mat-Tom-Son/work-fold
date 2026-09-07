# Changing an installed app

Implemented in work-fold 0.4.23. The Apps tab has
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
installed proposal provides one. Subsequent working copies also retain the
intended Release-backed update target without replacing their own exact base
identity. Provenance is not stored in `.work-fold/` or
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

App details offers **Open build Chat** when retained provenance identifies one;
opening it verifies that the Chat still exists in the source Space and sends
nothing. The source folder is supporting detail under **Package & runtime**.
**Review updates** opens the source Project's App Studio with the exact live
installation selected. This link follows the intended target through subsequent
working copies, even if a CLI proposal supplied the later review. The host
rechecks Project and installation identities and drops stale target links after
uninstall. Opening App Studio never prepares, publishes, or activates a Release;
subsequent manual target choices remain intact during refreshes.

A Release can also be installed in its own source Space alongside that Project's
Local preview. **Change this app** still pins the installed Feature and the
separate preview predecessor. Reviewing the changed preview preserves the
installed Release until its App Studio update is approved. The two installations
keep separate data, grants, connections, jobs and tabs; the rail adds **Preview**
only where needed to distinguish them. Removing a preview leaves the installed
Release running, and a new preview starts with fresh data and authority.
