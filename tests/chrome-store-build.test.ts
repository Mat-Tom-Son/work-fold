import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { buildChromeStore, validateChromeDistribution } from "../scripts/build-chrome-store.mjs";

const distribution = JSON.parse(await readFile(new URL("../src/shared/chrome-distribution.json", import.meta.url), "utf8"));
function publicIdentity() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ format: "der", type: "spki" });
  const id = createHash("sha256").update(der).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  return { storeId: id, publicKey: der.toString("base64") };
}

test("production connector refuses missing or mismatched real Store identity", () => {
  const blank = { ...distribution, storeId: null, publicKey: null };
  assert.throws(() => validateChromeDistribution(blank), /actual Chrome Web Store/);
  assert.doesNotThrow(() => validateChromeDistribution(blank, { draft: true }));
  assert.doesNotThrow(() => validateChromeDistribution({ ...distribution, publicKey: null }));
  const pinned = { ...distribution, ...publicIdentity() };
  assert.doesNotThrow(() => validateChromeDistribution(pinned));
  assert.throws(() => validateChromeDistribution({ ...pinned, storeId: "b".repeat(32) }), /does not match/);
  assert.throws(() => validateChromeDistribution({ ...pinned, nativeHostName: "com.work-fold.chrome" }), /Invalid/);
  assert.throws(() => validateChromeDistribution({ ...pinned, leaseToken: "never package this" }), /Invalid/);
});

test("Store ZIP is reproducible, contains real icons/native bootstrap, and excludes local connection files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workfold-store-build-"));
  try {
    const pinned = { ...distribution, ...publicIdentity() };
    const a = await buildChromeStore({ distribution: pinned, output: join(directory, "a.zip") });
    const b = await buildChromeStore({ distribution: pinned, output: join(directory, "b.zip") });
    assert.equal(a.sha256, b.sha256); assert.equal(a.draft, false);
    const zip = await JSZip.loadAsync(await readFile(a.path));
    assert.equal(zip.file("host-config.json"), null);
    const names = Object.keys(zip.files);
    assert.equal(names.some(name => /token|credential|launch\.json|connection\.json|node_modules/.test(name)), false);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    assert.equal(manifest.manifest_version, 3); assert.equal(manifest.name, "work-fold");
    assert.equal(manifest.key, pinned.publicKey); assert.equal(manifest.version, pinned.extensionVersion);
    assert.equal(manifest.background.service_worker, "service_worker.js"); assert.equal(manifest.action.default_popup, "popup.html");
    assert.ok(manifest.permissions.includes("nativeMessaging")); assert.ok(manifest.permissions.includes("debugger"));
    assert.equal(manifest.permissions.includes("activeTab"), false);
    const generated = await zip.file("connection-config.js")!.async("string");
    assert.equal(/leaseToken|clientProof|bootstrapToken|\/Users\//.test(generated), false);
    assert.match(generated, new RegExp(pinned.storeId));
    assert.match(await zip.file("service_worker.js")!.async("string"), /^importScripts\("bootstrap\.js"\);/);
    for (const size of [16, 32, 48, 128]) {
      const actual = await zip.file(`icons/${size}.png`)!.async("nodebuffer");
      const source = await readFile(new URL(`../desktop/assets/brand/pack/png/transparent/work-fold-icon-${size}.png`, import.meta.url));
      assert.deepEqual(actual, source); assert.equal(actual.readUInt32BE(16), size); assert.equal(actual.readUInt32BE(20), size);
    }
    assert.match(await zip.file("LICENSE")!.async("string"), /MIT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
