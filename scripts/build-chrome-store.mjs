import { createHash, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repository = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

export function validateChromeDistribution(config, { draft = false } = {}) {
  if (!config || Object.keys(config).some(key => !["version", "storeId", "publicKey", "extensionVersion", "nativeHostName", "bootstrapVersion", "bridge"].includes(key))
    || config.version !== 1 || config.bootstrapVersion !== 1 || config.nativeHostName !== "com.work_fold.chrome"
    || !/^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(config.extensionVersion) || config.extensionVersion.split(".").some(value => Number(value) > 65535)
    || config.bridge?.major !== 3 || Object.keys(config.bridge).some(key => !["major", "minor", "capabilities"].includes(key))
    || !Number.isSafeInteger(config.bridge.minor) || config.bridge.minor < 0
    || !Array.isArray(config.bridge.capabilities) || config.bridge.capabilities.length > 16
    || !["cancellation", "hard-background", "profile-binding"].every(value => config.bridge.capabilities.includes(value))
    || config.bridge.capabilities.some(value => !/^[a-z][a-z0-9-]{0,63}$/.test(value))) throw new Error("Invalid Chrome distribution contract.");
  if (draft && config.storeId === null && config.publicKey === null) return;
  if (!/^[a-p]{32}$/.test(config.storeId ?? "")) throw new Error("Pin the actual Chrome Web Store item ID before building a production connector.");
  if (config.publicKey === null) return; // The Store signs the upload with its assigned identity.
  if (typeof config.publicKey !== "string" || config.publicKey.length > 4096
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(config.publicKey)) throw new Error("Invalid optional Chrome Web Store public key.");
  const der = Buffer.from(config.publicKey, "base64");
  createPublicKey({ key: der, format: "der", type: "spki" });
  const expected = sha256(der).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  if (expected !== config.storeId) throw new Error("Chrome Web Store item ID does not match its public key.");
}

/** Builds only reviewed static code. It never reads host configuration or user state. */
export async function buildChromeStore({ root = repository, output, distribution, draft = false } = {}) {
  const config = distribution ?? await readJson(join(root, "src/shared/chrome-distribution.json"));
  validateChromeDistribution(config, { draft });
  const identity = await readJson(join(root, "src/shared/product-identity.json"));
  const upstreamRoot = join(root, "node_modules/pi-chrome");
  const upstream = await readJson(join(upstreamRoot, "package.json"));
  const patch = (await readJson(join(root, "patches/included-tools/manifest.json"))).find(entry => entry.package === "pi-chrome");
  if (!patch || upstream.version !== patch.version) throw new Error("Chrome package version is not reviewed.");
  if (sha256(await readFile(join(root, "patches/included-tools", patch.patch))) !== patch.sha256) throw new Error("Chrome integration patch digest changed.");
  for (const file of patch.files) if (sha256(await readFile(join(upstreamRoot, file.path))) !== file.after) throw new Error(`Chrome integration bytes changed: ${file.path}`);
  const source = join(upstreamRoot, "extensions/chrome-profile-bridge/browser-extension");
  const owned = join(root, "resources/included-tools/chrome/store");
  const manifest = await readJson(join(source, "manifest.json"));
  manifest.name = identity.productName;
  manifest.description = `Connect Chrome to ${identity.productName}.`;
  manifest.version = config.extensionVersion;
  manifest.minimum_chrome_version = "114";
  manifest.permissions = [...new Set([...manifest.permissions.filter(value => value !== "activeTab"), "nativeMessaging"])];
  manifest.icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/${size}.png`]));
  manifest.action = { default_title: identity.productName, default_popup: "popup.html", default_icon: manifest.icons };
  if (config.publicKey) manifest.key = config.publicKey;
  const files = new Map();
  const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  files.set("manifest.json", json(manifest));
  files.set("connection-config.js", Buffer.from(`globalThis.WORK_FOLD_CHROME_CONFIG = Object.freeze(${JSON.stringify(config)});\n`));
  files.set("service_worker.js", Buffer.concat([Buffer.from('importScripts("bootstrap.js");\n'), await readFile(join(source, "service_worker.js"))]));
  files.set("snapshot_injected.js", await readFile(join(source, "snapshot_injected.js")));
  for (const name of ["bootstrap.js", "popup.html", "popup.css", "popup.js"]) files.set(name, await readFile(join(owned, name)));
  files.set("welcome.html", files.get("popup.html"));
  files.set("LICENSE", await readFile(join(upstreamRoot, "LICENSE")));
  for (const size of [16, 32, 48, 128]) files.set(`icons/${size}.png`, await readFile(join(root, `desktop/assets/brand/pack/png/transparent/work-fold-icon-${size}.png`)));
  const zip = new JSZip();
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) zip.file(path, bytes, { date: new Date("1980-01-01T00:00:00Z"), createFolders: false, unixPermissions: 0o100644 });
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const target = resolve(output ?? join(root, "out/chrome-store", `work-fold-chrome-${config.extensionVersion}${draft ? "-draft" : ""}.zip`));
  const evidence = { version: 1, path: target, sha256: sha256(bytes), bytes: bytes.length, extensionVersion: config.extensionVersion, storeId: config.storeId,
    draft, upstream: { package: "pi-chrome", version: upstream.version, source: patch.source, license: patch.license, patchSha256: patch.sha256 },
    files: [...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length })) };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  await writeFile(`${target}.json`, json(evidence));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== "--draft")) throw new Error("Usage: node scripts/build-chrome-store.mjs [--draft]");
  console.log(JSON.stringify(await buildChromeStore({ draft: args.includes("--draft") }), null, 2));
}
