import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Release orchestration is executable ESM, separate from the app.
import { digestFile, readCandidate } from "../scripts/stage-linux-repository.mjs";

test("signed Linux staging admits only exact regular artifacts from its build record", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workfold-repository-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = [];
  for (const suffix of ["amd64.deb", "x86_64.rpm", "x86_64.AppImage"]) {
    const name = `work-fold-1.2.3-linux-${suffix}`;
    await writeFile(join(root, name), "fixture");
    artifacts.push({ name, bytes: 7, sha256: await digestFile(join(root, name)) });
  }
  const record = { version: "1.2.3", platform: "linux", arch: "x64", sourceCommit: "a".repeat(40), sourceDirty: true,
    createdAt: new Date().toISOString(), automaticUpdates: false, artifacts };
  const save = (value: unknown) => writeFile(join(root, "linux-build.json"), JSON.stringify(value));
  await save(record);
  assert.equal((await readCandidate(root)).version, "1.2.3");
  const archive = { name: "work-fold-1.2.3-linux-source.tar.gz", bytes: 7, sha256: "" };
  await writeFile(join(root, archive.name), "archive");
  archive.sha256 = await digestFile(join(root, archive.name));
  const sourceManifest = { schema: "work-fold.linux-source.v1", version: record.version, sourceCommit: record.sourceCommit, sourceDirty: record.sourceDirty, archive };
  const manifestName = "work-fold-1.2.3-linux-source.json", manifestText = JSON.stringify(sourceManifest);
  await writeFile(join(root, manifestName), manifestText);
  const sourceEvidence = { archive, manifest: { name: manifestName, bytes: Buffer.byteLength(manifestText), sha256: await digestFile(join(root, manifestName)) } };
  await save({ ...record, sourceEvidence });
  assert.deepEqual((await readCandidate(root)).sourceEvidence, sourceEvidence);
  await writeFile(join(root, archive.name), "altered");
  await assert.rejects(readCandidate(root), /Source evidence does not match/);
  await writeFile(join(root, archive.name), "archive");
  await save({ ...record, sourceEvidence: { ...sourceEvidence, additional: { name: "../secret" } } });
  await assert.rejects(readCandidate(root), /Invalid source evidence fields/);
  await save({ ...record, sourceEvidence: { ...sourceEvidence, archive: { ...archive, name: "../secret" } } });
  await assert.rejects(readCandidate(root), /Invalid source evidence/);
  await save({ ...record, sourceCommit: "b".repeat(40), sourceEvidence });
  await assert.rejects(readCandidate(root), /Source manifest identity/);
  const sbomFiles = [];
  for (const kind of ["npm", "computer", "hosts", "wayland"]) {
    const name = `work-fold-1.2.3-linux-${kind}.cdx.json`, bytes = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" });
    await writeFile(join(root, name), bytes);
    sbomFiles.push({ name, bytes: Buffer.byteLength(bytes), sha256: await digestFile(join(root, name)) });
  }
  await save({ ...record, sourceEvidence, sbomEvidence: { files: sbomFiles } });
  assert.equal((await readCandidate(root)).sbomEvidence.files.length, 4);
  await writeFile(join(root, sbomFiles[0].name), "altered");
  await assert.rejects(readCandidate(root), /SBOM evidence does not match/);
  await save({ ...record, sbomEvidence: { files: [...sbomFiles.slice(1), sbomFiles[1]] } });
  await assert.rejects(readCandidate(root), /Invalid SBOM evidence set/);
  await save({ ...record, sbomEvidence: { files: [{ ...sbomFiles[0], name: "../secret" }, ...sbomFiles.slice(1)] } });
  await assert.rejects(readCandidate(root), /Invalid SBOM evidence/);
  await save(record);
  const target = join(root, artifacts[0].name);
  await writeFile(target, "changed");
  await assert.rejects(readCandidate(root), /does not match/);
  await writeFile(target, "fixture");
  await save({ ...record, artifacts: [artifacts[0], artifacts[0], artifacts[2]] });
  await assert.rejects(readCandidate(root), /exactly one/);
  await save({ ...record, artifacts: [{ ...artifacts[0], name: "../foreign.deb" }, ...artifacts.slice(1)] });
  await assert.rejects(readCandidate(root), /Invalid artifact/);
  await save({ ...record, sourceCommit: null });
  await assert.rejects(readCandidate(root), /Invalid Linux candidate/);
  await save(record);
  if (process.platform !== "win32") {
    await rm(target); await symlink(join(root, artifacts[1].name), target);
    await assert.rejects(readCandidate(root), /does not match/);
    assert.equal(await readFile(join(root, artifacts[1].name), "utf8"), "fixture");
  }
});
