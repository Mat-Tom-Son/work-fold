import {
  assertArtifactReceipt,
  assertCompatibleReleaseState,
  computeReleaseFingerprint,
  nextIncompleteStage,
  readReleaseState,
  releaseStatePath,
} from "./mac-release-state.mjs";

// The direct publisher must prove the same source/artifact binding as :resume.
// A signed same-version artifact alone does not prove which checkout built it.
export async function assertPublishableMacState(rootDir, descriptor, requiredAssets) {
  const state = await readReleaseState(releaseStatePath(rootDir, descriptor.productName));
  if (!state || nextIncompleteStage(state)) {
    throw new Error("Publication requires a complete signed release checkpoint. Build and verify the candidate first.");
  }
  if (state.productName !== descriptor.productName) throw new Error("Release checkpoint product does not match publication.");
  const fingerprint = await computeReleaseFingerprint(rootDir, descriptor);
  assertCompatibleReleaseState(state, descriptor, fingerprint);
  const receipt = state.stages.verify.receipt;
  const expected = requiredAssets.map((name) => `out/builder/${name}`).sort();
  const actual = Object.keys(receipt ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Release checkpoint must cover every publication artifact exactly once.");
  }
  await assertArtifactReceipt(rootDir, receipt);
  return state;
}
