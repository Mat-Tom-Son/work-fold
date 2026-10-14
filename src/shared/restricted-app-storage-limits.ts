/**
 * App storage is one JSON document per installation, read and rewritten whole
 * on every operation. The quota keeps that document comfortably under V8's
 * maximum string length (about 512 MiB), which is the real ceiling for this
 * design; bulk data still belongs in granted work-folder files.
 *
 * Shared so the desktop renderer checks a chosen backup against the same
 * numbers the host enforces (docs/app-data-recovery.md).
 */
export const restrictedAppStorageLimits = {
  appBytes: 256 * 1024 * 1024,
  keys: 65_536,
  keyBytes: 256,
  valueBytes: 16 * 1024 * 1024,
  transactionBytes: 64 * 1024 * 1024,
  transactionOperations: 4_096,
  jsonDepth: 32,
  /** The quota plus per-entry framing for every key and the file's own metadata. */
  fileBytes: 264 * 1024 * 1024,
} as const;

/**
 * The largest app-data restore request: one complete `work-fold.app-data`
 * export of a storage file at its largest (`fileBytes`, which already covers
 * the 256 MiB quota and its framing) plus the export's own header and the
 * restore request's fields. Every export work-fold makes therefore restores.
 */
export const restrictedAppDataRestoreBytes = restrictedAppStorageLimits.fileBytes + 1024 * 1024;
