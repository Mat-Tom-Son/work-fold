import { createHash } from "node:crypto";
import { extractFile, getRawHeader, uncache } from "@electron/asar";

/** Verify the bytes Electron will read, not just the signed archive header.
 * Unpacked Mach-O binaries are signed after ASAR creation, so their old header
 * hashes are checked only before signing; codesign owns their final integrity.
 * Unpacked scripts and other resources keep their byte-level checks afterward.
 */
export function verifyAsarFileIntegrity(archivePath, { includeUnpacked = false } = {}) {
  uncache(archivePath);
  const { header } = getRawHeader(archivePath);
  const failures = [];
  let checkedFiles = 0, checkedBytes = 0, unpackedFiles = 0, signedNativeFiles = 0;
  function visit(directory, prefix = "", parentUnpacked = false) {
    for (const [name, entry] of Object.entries(directory.files)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const unpacked = parentUnpacked || entry.unpacked === true;
      if (entry.files) { visit(entry, path, unpacked); continue; }
      if (entry.link) continue; // The target entry is verified in its own location.
      if (unpacked) unpackedFiles++;
      const integrity = entry.integrity;
      if (!integrity || integrity.algorithm !== "SHA256" || !/^[a-f0-9]{64}$/.test(integrity.hash)
        || !Number.isSafeInteger(integrity.blockSize) || integrity.blockSize < 1
        || !Array.isArray(integrity.blocks) || integrity.blocks.length !== Math.max(1, Math.ceil(entry.size / integrity.blockSize))
        || integrity.blocks.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
        failures.push(`${path}: missing or invalid SHA256 integrity metadata`); continue;
      }
      try {
        const bytes = extractFile(archivePath, path);
        if (unpacked && !includeUnpacked && isMachO(bytes)) { signedNativeFiles++; continue; }
        checkedFiles++; checkedBytes += bytes.length;
        if (bytes.length !== entry.size) failures.push(`${path}: expected ${entry.size} bytes, read ${bytes.length}`);
        if (sha256(bytes) !== integrity.hash) failures.push(`${path}: file hash mismatch`);
        for (let block = 0; block < integrity.blocks.length; block++) {
          const start = block * integrity.blockSize;
          if (sha256(bytes.subarray(start, Math.min(start + integrity.blockSize, bytes.length))) !== integrity.blocks[block]) {
            failures.push(`${path}: block ${block} hash mismatch`);
          }
        }
      } catch (error) { failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  visit(header);
  if (failures.length) throw new Error(`ASAR file integrity failed:\n${failures.map(message => `- ${message}`).join("\n")}`);
  return { checkedFiles, checkedBytes, unpackedFiles, signedNativeFiles };
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isMachO(bytes) {
  return bytes.length >= 4 && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0));
}
