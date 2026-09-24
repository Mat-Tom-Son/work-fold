import { safeStorage } from "electron";
import { secureStorageAvailable } from "./secure-storage.js";

import { EncryptedRestrictedAppConnectionStore } from "../../src/local/agent/restricted-app-connection-store.js";

export function createRestrictedAppConnectionStore(filePath: string): EncryptedRestrictedAppConnectionStore {
  return new EncryptedRestrictedAppConnectionStore(filePath, {
    isAvailable: () => secureStorageAvailable(safeStorage),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext)),
  });
}
