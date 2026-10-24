/** Linux's basic_text backend uses a public constant, not an OS-held key. */
export function secureStorageAvailable(
  storage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend(): string },
  platform: NodeJS.Platform = process.platform,
): boolean {
  return storage.isEncryptionAvailable() && (platform !== "linux"
    || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend()));
}
