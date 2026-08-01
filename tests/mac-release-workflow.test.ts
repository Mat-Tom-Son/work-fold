import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertArtifactReceipt,
  assertCompatibleReleaseState,
  captureArtifactReceipt,
  formatDuration,
  nextIncompleteStage,
  readReleaseState,
  summarizeReleaseState,
  writeReleaseState,
} from "../scripts/mac-release-state.mjs";

const descriptor = {
  productName: "work-fold",
  version: "0.1.1",
  arch: "arm64",
  mode: "release",
  nodeVersion: "v24.0.0",
  signIdentity: "Developer ID Application: Example (TEAMID)",
  teamId: "TEAMID",
  feedOwner: "Example",
  feedRepo: "work-fold-mac-releases",
};
const fingerprint = "a".repeat(64);

test("macOS release checkpoints are atomic, staged, and source-bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-release-state-"));
  const path = join(directory, "state.json");
  try {
    const state = await writeReleaseState(path, {
      productName: "work-fold",
      descriptor,
      fingerprint,
      startedAt: "2026-08-01T00:00:00.000Z",
      stages: {
        prepare: {
          startedAt: "2026-08-01T00:00:00.000Z",
          completedAt: "2026-08-01T00:00:14.000Z",
          durationMs: 14_000,
        },
      },
    });
    const loaded = await readReleaseState(path);
    assert.deepEqual(loaded, state);
    assert.equal(nextIncompleteStage(loaded), "package");
    assertCompatibleReleaseState(loaded, descriptor, fingerprint);
    assert.throws(
      () => assertCompatibleReleaseState(loaded, { ...descriptor, version: "0.1.2" }, fingerprint),
      /not release 0\.1\.2 arm64/,
    );
    assert.throws(
      () => assertCompatibleReleaseState(loaded, descriptor, "changed"),
      /Release inputs changed/,
    );
    assert.match(summarizeReleaseState(loaded).join("\n"), /done  prepare \(14s\)[\s\S]*next  package/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact receipts reject changed bytes instead of resuming unsafe output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-release-receipt-"));
  try {
    const artifact = join(directory, "candidate.zip");
    await writeFile(artifact, "accepted artifact", "utf8");
    const receipt = await captureArtifactReceipt(directory, ["candidate.zip"]);
    await assertArtifactReceipt(directory, receipt);
    await writeFile(artifact, "different artifact", "utf8");
    await assert.rejects(assertArtifactReceipt(directory, receipt), /changed (?:size|contents)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release state rejects out-of-order stages that could skip verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-release-order-"));
  const path = join(directory, "state.json");
  try {
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      productName: "work-fold",
      descriptor,
      fingerprint,
      stages: {
        prepare: { completedAt: "2026-08-01T00:00:01.000Z" },
        verify: { completedAt: "2026-08-01T00:00:02.000Z" },
      },
    })}\n`, "utf8");
    await assert.rejects(readReleaseState(path), /Out-of-order macOS release stages/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release timing labels stay compact for stage logs", () => {
  assert.equal(formatDuration(125), "125ms");
  assert.equal(formatDuration(1_250), "1.3s");
  assert.equal(formatDuration(13_740), "14s");
  assert.equal(formatDuration(125_000), "2m 5s");
});

test("macOS release commands expose separate RC, fresh, resume, status, and publish lanes", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const builder = await readFile(new URL("../scripts/build-mac-desktop.mjs", import.meta.url), "utf8");
  const candidate = await readFile(new URL("../scripts/build-mac-release-candidate.mjs", import.meta.url), "utf8");

  assert.match(packageJson.scripts["desktop:rc:mac"], /build-mac-release-candidate/);
  assert.match(packageJson.scripts["desktop:make:mac:release:resume"], /--release --resume/);
  assert.match(packageJson.scripts["desktop:release:mac:status"], /mac-release-status/);
  assert.match(packageJson.scripts["desktop:release:mac:resume"], /make:mac:release:resume/);
  assert.match(builder, /assertCompatibleReleaseState/);
  assert.match(builder, /assertSignedAppCheckpoint/);
  assert.match(builder, /captureArtifactReceipt/);
  assert.match(candidate, /WORKFOLD_DESKTOP_OUTPUT_DIR: outputDirectory/);
  assert.match(candidate, /--dir/);
});
