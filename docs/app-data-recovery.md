# App data export and recovery

Implemented and verified in the 0.4.23 source candidate.

In **Add → Apps**, open the app's details. **Export data** downloads its complete
instance-owned JSON data. **Restore…** accepts a backup of the same installation
and exact app revision. **Undo data change** recovers the state before the most
recent clear or restore, while that result is still current. App Studio also
offers **Export data** for retained data after uninstall; it does not adopt that
data into another installation.

The versioned `work-fold.app-data` envelope contains its app id, exact package
digest, export time, completeness flag, SHA-256 integrity digest, and one
complete data snapshot. The snapshot records its owner class, Tenant, Runtime
Instance, Feature Installation, Data Namespace, storage revision, byte usage,
and entries. Its limits match storage: 512 keys, 128 KiB per value, 5 MiB of
data and a 6 MiB envelope/request ceiling. This is a data export, not an app
package, Space backup, connection export, or migration format. Host credentials,
grants, schedules, Chats and separately selected Space files are absent. Data
the app itself stored remains part of the export.

The service resolves installation/Project ownership from its registry. It
rejects foreign namespaces, changed app revisions, incomplete or corrupt
envelopes, extra control fields, and oversized input. Export records a bounded
content-free administrative receipt before returning data. Retained exports
resolve the package digest from their retained Release lineage and require the
owning source Project.

Restoration shares the desktop's capability-mutation reservation, so an active
Assistant or conflicting app operation cannot race setup. It validates the
backup and the expected current storage revision, stops the current app host,
and advances only data authority before replacement. The storage commit checks
the expected revision again under its namespace queue. Current network/file/
notification grants, connections, jobs, and all other authority remain current;
none are loaded from a backup. Runtime bridge calls cannot export, restore,
clear with recovery, or select another namespace through this management API.

One bounded `work-fold.app-data-recovery` record in the same namespace retains
the previous snapshot, operation id/time, exact app digest, and hash of the
intended replacement. It is synced before the atomic data replacement. Undo is
available only when the current data including its revision matches that result
and the app revision is unchanged. An interrupted attempt remains recorded but
is never presented as successful. Later app writes invalidate Undo; another
clear or restore replaces this single recovery point. Uninstall purge removes
it with its namespace; retain keeps it inert. Restore and Undo always advance
the current storage revision, never reset it to a past value.

Recovery is not automatic backup or cross-installation adoption. Save exports
outside the app before removing it when long-term access matters. Schema
migrations and adoption of retained data remain separate future operations.
