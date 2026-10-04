import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDocumentScript, DOCUMENT_LIMITS } from "../resources/included-tools/documents/runtime.mjs";
import { documentResultText } from "../resources/included-tools/documents/output.mjs";

test("combined document result and logs fit one valid envelope while full return stays readable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-document-envelope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "script.mjs"), 'export default async () => { console.log("L".repeat(70000)); return { value: "V".repeat(60000) }; };');
  const result = await runDocumentScript({ script: "script.mjs", cwd: root, stateRoot: root });
  const serialized = documentResultText(result, DOCUMENT_LIMITS.textBytes);
  assert.ok(Buffer.byteLength(serialized) <= DOCUMENT_LIMITS.textBytes);
  const content = JSON.parse(serialized);
  assert.equal(content.envelopeTruncated, true);
  assert.match(content.continuation, /Do not rerun/);
  const manifest = JSON.parse(await readFile(content.artifacts.manifest, "utf8"));
  assert.equal(JSON.parse(manifest.value).value, "V".repeat(60000));
  assert.equal(await readFile(content.artifacts.logs, "utf8"), "L".repeat(70000) + "\n");
});
