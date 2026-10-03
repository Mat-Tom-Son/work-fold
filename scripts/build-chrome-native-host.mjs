import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { peContentSha256 } from "./pe-image.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function buildChromeNativeHost({ destination, distribution }) {
  const origin = distribution.storeId ? `chrome-extension://${distribution.storeId}/` : "";
  if (distribution.storeId && !/^[a-p]{32}$/.test(distribution.storeId)) throw new Error("Invalid Chrome Store identity.");
  await mkdir(destination, { recursive: true });
  const temporary = join(destination, `.build-${process.pid}`);
  await mkdir(temporary, { recursive: true });
  try {
    const source = await readFile(join(root, "desktop/native/chrome-bootstrap.swift"));
    const identity = `let WorkFoldChromeOrigin = ${JSON.stringify(origin)}\n`;
    await writeFile(join(temporary, "main.swift"), source);
    await writeFile(join(temporary, "identity.swift"), identity);
    const binary = join(temporary, "work-fold-chrome-host");
    execFileSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macosx12.0", join(temporary, "identity.swift"), join(temporary, "main.swift"), "-o", binary], { stdio: "inherit" });
    if (execFileSync("lipo", ["-archs", binary], { encoding: "utf8" }).trim() !== "arm64") throw new Error("Chrome native host must target arm64.");
    await rename(binary, join(destination, "work-fold-chrome-host"));
    await writeFile(join(destination, "source.json"), `${JSON.stringify({
      schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName,
      bootstrapVersion: distribution.bootstrapVersion, target: "arm64-apple-macosx12.0",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      distributionSha256: createHash("sha256").update(JSON.stringify(distribution)).digest("hex"),
      compiler: execFileSync("xcrun", ["swiftc", "--version"], { encoding: "utf8" }).trim(),
    }, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
/** The reviewed Windows host sources, in the order their combined digest covers them. */
export const windowsChromeHostSources = ["Cargo.toml", "Cargo.lock", "src/main.rs"].map((name) => `desktop/native/chrome-host-windows/${name}`);

/** Digest of every Windows host source, bound by path so files cannot trade bytes. */
export async function windowsChromeHostSourceSha256() {
  const digest = createHash("sha256");
  for (const path of windowsChromeHostSources) digest.update(`${path}\0`).update(await readFile(join(root, path))).update("\0");
  return digest.digest("hex");
}

export async function buildWindowsChromeNativeHost({ destination, distribution, targetDirectory = join(root, "out/included-tools/chrome-native-host-cargo") }) {
  const origin = distribution.storeId ? `chrome-extension://${distribution.storeId}/` : "";
  if (distribution.storeId && !/^[a-p]{32}$/.test(distribution.storeId)) throw new Error("Invalid Chrome Store identity.");
  const target = "x86_64-pc-windows-msvc";
  try { execFileSync("cargo", ["--version"], { stdio: "pipe" }); }
  catch { throw new Error("Building the Windows Chrome host requires Rust. Install rustup with the stable MSVC toolchain, then rerun desktop:prepare."); }
  // The Store origin is compiled in, as identity.swift is on macOS.
  execFileSync("cargo", ["build", "--release", "--locked", "--target", target, "--manifest-path", join(root, "desktop/native/chrome-host-windows/Cargo.toml"), "--target-dir", targetDirectory], {
    stdio: "inherit", env: { ...process.env, WORKFOLD_CHROME_ORIGIN: origin },
  });
  const bytes = await readFile(join(targetDirectory, target, "release", "work-fold-chrome-host.exe"));
  if (bytes.toString("latin1", 0, 2) !== "MZ" || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error("Chrome native host must be an x64 Windows executable.");
  await mkdir(destination, { recursive: true });
  const temporary = join(destination, `.build-${process.pid}.exe`);
  try {
    await writeFile(temporary, bytes);
    await rm(join(destination, "work-fold-chrome-host.exe"), { force: true });
    // Defender can hold a freshly written executable for seconds; retry only that.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, join(destination, "work-fold-chrome-host.exe")); break; }
      catch (error) {
        if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100 * (attempt + 1), 1_000)));
      }
    }
  } finally { await rm(temporary, { force: true }); }
  await writeFile(join(destination, "source.json"), `${JSON.stringify({
    schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName,
    bootstrapVersion: distribution.bootstrapVersion, target,
    sourceSha256: await windowsChromeHostSourceSha256(),
    distributionSha256: createHash("sha256").update(JSON.stringify(distribution)).digest("hex"),
    executableContentSha256: peContentSha256(bytes),
    compiler: execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" }).trim(),
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform;
  if (platform !== "darwin" && platform !== "win32") console.log("The Chrome native host is built in the macOS and Windows lanes only.");
  else {
    const distribution = JSON.parse(await readFile(join(root, "src/shared/chrome-distribution.json"), "utf8"));
    if (process.env.WORKFOLD_MAC_RELEASE_BUILD === "1" && !distribution.storeId) throw new Error("A Store-enabled release requires the actual Chrome Store identity.");
    const destination = join(root, "out/included-tools/chrome-native-host");
    if (platform === "win32") {
      if (process.platform !== "win32") throw new Error("Building the Windows Chrome host requires Windows and the Rust MSVC toolchain.");
      await buildWindowsChromeNativeHost({ destination, distribution });
    } else await buildChromeNativeHost({ destination, distribution });
    console.log("Built Chrome native bootstrap host.");
  }
}
