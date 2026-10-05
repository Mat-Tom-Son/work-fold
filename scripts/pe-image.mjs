import { createHash } from "node:crypto";

/**
 * SHA-256 of a Windows PE image with any Authenticode signature removed, so a
 * build record stays valid after the release lane signs the executable.
 * Signing only sets the header checksum and the certificate-table directory
 * entry, pads the image to 8 bytes and appends the table; all four are
 * normalized. Keep in step with desktop/src/pe-image.ts.
 */
export function peContentSha256(bytes) {
  if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ") throw new Error("Not a PE executable.");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 > bytes.length || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE executable.");
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("Unknown PE optional header.");
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  if (security + 8 > bytes.length) throw new Error("Truncated PE optional header.");
  const tableOffset = bytes.readUInt32LE(security), tableSize = bytes.readUInt32LE(security + 4);
  const content = tableOffset && tableSize ? bytes.subarray(0, tableOffset) : bytes;
  const normalized = Buffer.alloc(Math.ceil(content.length / 8) * 8);
  content.copy(normalized);
  normalized.fill(0, optional + 64, optional + 68);
  normalized.fill(0, security, security + 8);
  return createHash("sha256").update(normalized).digest("hex");
}
