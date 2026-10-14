import { FileCredentialStoreBackend, McpOAuthCredentialStore } from "@earendil-works/pi-coding-agent";

type Backend = NonNullable<ConstructorParameters<typeof McpOAuthCredentialStore>[0]>;
export interface PiCredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Encrypt native Pi MCP state while retaining Pi's file locks and OAuth refresh locks. */
export function createEncryptedMcpCredentialBackend(path: string, encryption: PiCredentialEncryption): Backend {
  const native = new FileCredentialStoreBackend(path);
  function decode(current: string | undefined): string | undefined {
    if (!current?.trim() || current.trim() === "{}") return undefined; // Native backend's initial empty file.
    if (!encryption.isEncryptionAvailable()) throw new Error("Secure service credential storage is unavailable.");
    try {
      const envelope = JSON.parse(current);
      if (envelope.version !== 1 || typeof envelope.ciphertext !== "string" || !envelope.ciphertext) throw new Error();
      return encryption.decryptString(Buffer.from(envelope.ciphertext, "base64"));
    } catch { throw new Error("Secure service credentials could not be read."); }
  }
  function encode(next: string | undefined): string | undefined {
    if (next === undefined) return undefined;
    if (!encryption.isEncryptionAvailable()) throw new Error("Secure service credential storage is unavailable.");
    return JSON.stringify({ version: 1, ciphertext: encryption.encryptString(next).toString("base64") }) + "\n";
  }
  return {
    withLock(fn) { return native.withLock(current => { const changed = fn(decode(current)); return { result: changed.result, next: encode(changed.next) }; }); },
    withLockAsync(fn, options) { return native.withLockAsync(async current => { const changed = await fn(decode(current)); return { result: changed.result, next: encode(changed.next) }; }, options); },
  };
}
