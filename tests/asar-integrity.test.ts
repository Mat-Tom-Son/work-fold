import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPackageWithOptions, getRawHeader } from "@electron/asar";
import { verifyAsarFileIntegrity } from "../scripts/asar-integrity.mjs";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "workfold-asar-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), archive = join(root, "app.asar");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "first entry");
  await writeFile(join(source, "b.txt"), "second entry");
  await writeFile(join(source, "empty.txt"), "");
  await writeFile(join(source, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 3, 97));
  await writeFile(join(source, "native.node"), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from("synthetic signing input")]));
  await writeFile(join(source, "worker.mjs"), "export const value = 1;");
  await createPackageWithOptions(source, archive, { unpack: "*.{node,mjs}" });
  return { source, archive };
}

test("ASAR integrity covers every packed file and block, with an explicit pre-sign unpacked check", async t => {
  const { source, archive } = await fixture(t);
  const verified = verifyAsarFileIntegrity(archive);
  assert.equal(verified.checkedFiles, 5); assert.equal(verified.unpackedFiles, 2); assert.equal(verified.signedNativeFiles, 1);
  assert.equal(verifyAsarFileIntegrity(archive, { includeUnpacked: true }).checkedFiles, 6);
  await writeFile(join(source, "a.txt"), "later source changes do not alter an immutable archive");
  verifyAsarFileIntegrity(archive);
  await writeFile(join(`${archive}.unpacked`, "native.node"), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from("synthetic new signature")]));
  verifyAsarFileIntegrity(archive); // Native signature validation owns these final bytes.
  assert.throws(() => verifyAsarFileIntegrity(archive, { includeUnpacked: true }), /native\.node: file hash mismatch/);
  await writeFile(join(`${archive}.unpacked`, "worker.mjs"), "export const value = 2;");
  assert.throws(() => verifyAsarFileIntegrity(archive), /worker\.mjs: file hash mismatch/, "unpacked JavaScript remains verified after signing");
});

test("ASAR integrity catches same-length corrupt bytes despite a valid header", async t => {
  const { archive } = await fixture(t), metadata = getRawHeader(archive);
  const bytes = await readFile(archive);
  bytes[8 + metadata.headerSize + Number((metadata.header.files["a.txt"] as any).offset)] ^= 1;
  await writeFile(archive, bytes);
  assert.throws(() => verifyAsarFileIntegrity(archive), /a\.txt: file hash mismatch/);
});

test("ASAR integrity catches a source-size race shifting following entries beyond the archive boundary", async t => {
  const { archive } = await fixture(t), metadata = getRawHeader(archive);
  const bytes = await readFile(archive);
  const offset = 8 + metadata.headerSize + Number((metadata.header.files["a.txt"] as any).offset);
  await writeFile(archive, Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + 2)]));
  assert.throws(() => verifyAsarFileIntegrity(archive), error => error instanceof Error && /a\.txt: file hash mismatch/.test(error.message) && /b\.txt: file hash mismatch/.test(error.message) && /extends beyond archive boundary/.test(error.message));
});
