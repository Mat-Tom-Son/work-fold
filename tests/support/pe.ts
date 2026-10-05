/** A minimal PE32+ image carrying `label`, for digest and provenance fixtures. */
export function syntheticPe(label: string, magic: 0x10b | 0x20b = 0x20b): Buffer {
  const optional = 0x40 + 24;
  const header = Buffer.alloc(optional + (magic === 0x20b ? 112 : 96) + 16 * 8);
  header.write("MZ", 0, "latin1");
  header.writeUInt32LE(0x40, 0x3c);
  header.write("PE\0\0", 0x40, "latin1");
  header.writeUInt16LE(0x8664, 0x44);
  header.writeUInt16LE(magic, optional);
  return Buffer.concat([header, Buffer.from(label)]);
}

/** Applies what Authenticode signing changes: checksum, 8-byte padding, a certificate table and its directory entry. */
export function simulateSignature(image: Buffer): Buffer {
  const optional = image.readUInt32LE(0x3c) + 24;
  const security = optional + (image.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8;
  const padded = Buffer.alloc(Math.ceil(image.length / 8) * 8);
  image.copy(padded);
  const table = Buffer.alloc(64, 0xa5);
  const signed = Buffer.concat([padded, table]);
  signed.writeUInt32LE(0x1234_5678, optional + 64);
  signed.writeUInt32LE(padded.length, security);
  signed.writeUInt32LE(table.length, security + 4);
  return signed;
}
