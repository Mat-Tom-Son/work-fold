import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const apply = process.argv.includes("--yes");
const reopen = process.argv.includes("--reopen");
const userDataDir = join(homedir(), "Library", "Application Support", identity.productName);
const keychainPath = join(homedir(), "Library", "Keychains", "login.keychain-db");
const protectedFiles = [
  "secure-settings.bin",
  "secure-settings.bin.bak",
  "restricted-app-connections.bin",
  "restricted-app-connections.bin.bak",
];

if (process.platform !== "darwin") throw new Error(`${identity.productName} Safe Storage reset is only available on macOS.`);

if (!apply) {
  console.log(`This removes the ${identity.productName} Safe Storage key and encrypted provider/restricted-app credentials.`);
  console.log("Spaces, chats, History, preferences, and ordinary app data are preserved.");
  console.log(`Quit ${identity.productName}, then rerun with: npm run desktop:reset:mac-safe-storage -- --yes --reopen`);
  process.exitCode = 2;
} else {
  assertWorkFoldIsClosed();
  deleteSafeStorageKey();
  const removed = [];
  for (const name of protectedFiles) {
    const path = join(userDataDir, name);
    if (!existsSync(path)) continue;
    await rm(path, { force: true });
    removed.push(name);
  }

  console.log(`[${identity.productName} Keychain reset] Removed ${removed.length ? removed.join(", ") : "no encrypted credential files"}.`);
  console.log(`[${identity.productName} Keychain reset] Spaces and ordinary app data were preserved. Re-enter provider or app credentials as needed.`);
  if (reopen) run("open", [`/Applications/${identity.productName}.app`], `Could not reopen ${identity.productName}`);
}

function assertWorkFoldIsClosed() {
  const result = spawnSync("pgrep", ["-f", `^/Applications/${identity.productName}\\.app/`], commandOptions());
  if (result.status === 0) throw new Error(`${identity.productName} is running. Quit it completely before resetting Safe Storage.`);
  if (result.status !== 1) throw new Error(`Could not inspect ${identity.productName} processes: ${compactText(result.stderr)}`);
}

function deleteSafeStorageKey() {
  const result = spawnSync("security", [
    "delete-generic-password",
    "-a", `${identity.productName} Key`,
    "-s", `${identity.productName} Safe Storage`,
    keychainPath,
  ], commandOptions());
  if (result.status === 0) {
    console.log(`[${identity.productName} Keychain reset] Removed the stale Safe Storage key.`);
    return;
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/could not be found/i.test(output)) {
    console.log(`[${identity.productName} Keychain reset] No Safe Storage key was present.`);
    return;
  }
  throw new Error(`Could not remove ${identity.productName} Safe Storage: ${compactText(output)}`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, commandOptions());
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${compactText(result.error?.message || result.stderr || result.stdout)}`);
  }
}

function commandOptions() {
  return { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 900);
}
