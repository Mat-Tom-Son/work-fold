// Container-only real Electron/keyring test. An optional installed ASAR selects
// the actual packaged store code; the test host remains the pinned dev Electron.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { app, safeStorage } from "electron";

assert.equal(process.platform, "linux");
assert.equal(process.env.WORKFOLD_CONTAINER_INSTALL_TEST, "1");
assert.ok(existsSync("/.dockerenv") || existsSync("/run/.containerenv"));
assert.notEqual(process.getuid(), 0, "Electron smoke must run as a non-root user");
const [rootArg, phase, asar] = process.argv.slice(2);
assert.ok(rootArg && ["seed", "verify", "corrupt", "reject-basic", "reject-missing", "reject-locked"].includes(phase));
const root = resolve(rootArg);
assert.equal(process.env.XDG_DATA_HOME, join(root, "data"), "Require an isolated keyring data directory");
assert.equal(process.env.XDG_CONFIG_HOME, join(root, "config"));
app.setName("work-fold Linux credential smoke");
app.setPath("userData", join(root, "electron"));
app.commandLine.appendSwitch("password-store", phase === "reject-basic" ? "basic" : "gnome-libsecret");
let failed = false;
void app.whenReady().then(runSmoke).catch((error) => {
  failed = true; console.error(error);
}).finally(() => app.exit(failed ? 1 : 0));

async function runSmoke() {
  const moduleRoot = asar ? join(resolve(asar), "dist/desktop") : fileURLToPath(new URL("../dist/desktop", import.meta.url));
  const module = relative => import(pathToFileURL(join(moduleRoot, relative)).href);
  const { SecureSettingsStore } = await module("desktop/src/settings.js");
  const { createRestrictedAppConnectionStore } = await module("desktop/src/restricted-app-connections.js");
  const { secureStorageAvailable } = await module("desktop/src/secure-storage.js");
  const metadata = JSON.parse(await readFile(join(moduleRoot, "../../package.json"), "utf8"));
  assert.equal(metadata.name, "work-fold-desktop");
  const identity = { name: metadata.name, productName: metadata.productName, electron: process.versions.electron };
  if (phase !== "seed") assert.deepEqual(JSON.parse(await readFile(join(root, "identity.json"), "utf8")), identity);
  const credential = "synthetic-test-credential-never-used-with-a-provider";
  const credentials = { fixture: { type: "api_key", key: credential } };
  const connection = { kind: "bearer", token: credential };
  const binding = {
    tenantId: "tenant_linux-test", runtimeInstanceId: "runtime-instance_linux-test",
    featureId: "linux-test", featureInstallationId: "feature-installation_linux-test",
    featureRevisionDigest: `work-fold.artifact.v1:sha256:${"b".repeat(64)}`,
    declarationId: "test-api", declarationDigest: `sha256:${"a".repeat(64)}`,
    targetIdentity: "https://example.invalid", owner: { kind: "instance", runtimeInstanceId: "runtime-instance_linux-test" },
  };
  const settingsPath = join(root, "credentials.enc"), connectionsPath = join(root, "connections.enc");
  const stores = [
    { path: settingsPath, load: () => new SecureSettingsStore(settingsPath).load(),
      save: () => new SecureSettingsStore(settingsPath).save(credentials), expected: credentials, error: /could not read secure settings/ },
    { path: connectionsPath, load: () => createRestrictedAppConnectionStore(connectionsPath).get(binding),
      save: () => createRestrictedAppConnectionStore(connectionsPath).set(binding, connection), expected: connection, error: /could not read restricted app connections/ },
  ];
  const unavailable = ["reject-basic", "reject-missing", "reject-locked"].includes(phase);
  if (unavailable) {
    if (phase === "reject-basic") assert.equal(safeStorage.getSelectedStorageBackend(), "basic_text");
    assert.equal(secureStorageAvailable(safeStorage), false, "A missing keyring cannot masquerade as secure storage");
  } else {
    assert.equal(safeStorage.getSelectedStorageBackend(), "gnome_libsecret");
    assert.equal(secureStorageAvailable(safeStorage), true);
  }
  for (const store of stores) {
    if (unavailable) {
      const before = await readFile(store.path);
      await assert.rejects(store.load(), /secure storage is unavailable/i);
      await assert.rejects(store.save(), /secure storage is unavailable/i);
      assert.deepEqual(await readFile(store.path), before, "Unavailable storage cannot overwrite credentials");
    } else if (phase === "seed") {
      assert.equal(existsSync(store.path), false, "Seed cannot overwrite credentials");
      await store.save();
      assert.ok(!(await readFile(store.path)).includes(Buffer.from(credential)), "Saved bytes must be encrypted");
    } else if (phase === "verify") {
      assert.deepEqual(await store.load(), store.expected, "A new process decrypts persisted credentials");
    } else {
      const original = await readFile(store.path), invalid = Buffer.from("invalid synthetic ciphertext");
      assert.equal(existsSync(`${store.path}.bak`), false, "Corrupt-primary case has no recovery backup");
      try {
        await writeFile(store.path, invalid);
        await assert.rejects(store.load(), store.error);
        await assert.rejects(store.save(), store.error);
        assert.deepEqual(await readFile(store.path), invalid, "Unreadable credentials must not be silently replaced");
      } finally { await writeFile(store.path, original); }
    }
  }
  if (phase === "seed") {
    await writeFile(join(root, "identity.json"), JSON.stringify(identity));
    await writeFile(join(root, "complete"), "seed-complete");
  }
  console.log(`PASS Linux credentials ${phase}: provider and Folder-app stores, real ${safeStorage.getSelectedStorageBackend()}, ${asar ? "installed ASAR" : "compiled source"} ${metadata.version}`);
}
