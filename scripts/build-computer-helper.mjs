import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containsBuildMachinePath, rustBuildEnvironment } from "./build-machine-paths.mjs";
import { peContentSha256 } from "./pe-image.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(root, "node_modules", "@injaneity", "pi-computer-use");
const platform = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform;
if (platform === "darwin") {
  if (process.platform !== "darwin") throw new Error("Building the computer helper requires macOS and Xcode Command Line Tools.");
  await build();
} else if (platform === "win32") {
  if (process.platform !== "win32") throw new Error("Building the Windows computer helper requires Windows and the Rust MSVC toolchain.");
  await buildWindows();
} else {
  console.log("The included computer helper is built in the macOS and Windows desktop lanes only.");
}

/** Every build input must match the reviewed integration manifest. */
async function reviewedSources(sourcePaths) {
  const manifest = JSON.parse(await readFile(join(root, "patches", "included-tools", "manifest.json"), "utf8"));
  const entry = manifest.find((item) => item.package === "@injaneity/pi-computer-use");
  if (!entry) throw new Error("Missing reviewed computer integration source manifest.");
  const upstream = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (upstream.version !== entry.version) throw new Error("Review the new computer helper source before building it.");
  const sources = [];
  for (const path of sourcePaths) {
    const actual = sha256(await readFile(join(packageRoot, path)));
    if (actual !== entry.files.find((file) => file.path === path)?.after) throw new Error(`Unreviewed computer helper source: ${path}. Run npm ci before rebuilding.`);
    sources.push({ path, sha256: actual });
  }
  return { entry, sources };
}

async function build() {
  const sourcePaths = ["scripts/build-native.mjs", ...["request_lifecycle.swift", "agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"].map((name) => `native/macos/${name}`)];
  const { entry, sources } = await reviewedSources(sourcePaths);
  const outputDir = join(root, "out", "included-tools", "computer-helper");
  const output = join(outputDir, "work-fold Computer.app");
  const temporary = join(outputDir, `work-fold Computer.build-${process.pid}.app`);
  const executable = join(temporary, "Contents", "MacOS", "bridge");
  const resources = join(temporary, "Contents", "Resources");
  await mkdir(join(temporary, "Contents", "MacOS"), { recursive: true });
  await mkdir(resources, { recursive: true });
  try {
    // No downloader, setup script, self-signed identity or Keychain mutation.
    execFileSync(process.execPath, [join(packageRoot, "scripts", "build-native.mjs"), "--arch", "arm64", "--no-sign", "--output", executable], { cwd: root, stdio: "inherit" });
    const architecture = execFileSync("lipo", ["-archs", executable], { encoding: "utf8" }).trim();
    if (architecture !== "arm64") throw new Error(`Unexpected computer helper architecture: ${architecture}.`);
    await writeFile(join(temporary, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.work-fold.desktop.computer</string>
<key>CFBundleName</key><string>work-fold Computer</string>
<key>CFBundleDisplayName</key><string>work-fold Computer</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${entry.version}</string>
<key>CFBundleShortVersionString</key><string>${entry.version}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Let work-fold observe the windows you ask your Assistant to work with.</string>
<key>NSAccessibilityUsageDescription</key><string>Let work-fold interact with the applications you ask your Assistant to use.</string>
</dict></plist>
`);
    await copyFile(join(root, "desktop", "assets", "icon.icns"), join(resources, "icon.icns"));
    await copyFile(join(packageRoot, "LICENSE"), join(resources, "LICENSE.pi-computer-use"));
    await writeFile(join(resources, "source.json"), `${JSON.stringify({
      schema: "work-fold.computer-helper-source.v1", package: entry.package, version: entry.version,
      source: entry.sourceURL || entry.source, license: entry.license, integrationPatchSha256: entry.sha256,
      sources, target: "arm64-apple-macosx14.0", protocolVersion: 7,
      compiler: execFileSync("xcrun", ["swiftc", "--version"], { encoding: "utf8" }).trim(),
      buildVersion: execFileSync("xcrun", ["vtool", "-show-build", executable], { encoding: "utf8" }).trim().split("\n").slice(1).join("\n"),
    }, null, 2)}\n`);
    execFileSync("plutil", ["-lint", join(temporary, "Contents", "Info.plist")], { stdio: "inherit" });
    await rm(output, { force: true, recursive: true });
    await rename(temporary, output);
    console.log(`Built included computer helper: ${resolve(output)}`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
/** Windows builds the reviewed Rust UI Automation helper from source; the upstream prebuilt is never shipped. */
async function buildWindows() {
  const crate = "native/windows/bridge-rs";
  const sourcePaths = ["Cargo.toml", "Cargo.lock", ...["capture", "error", "input", "lib", "main", "protocol", "refs", "state", "uia", "window"].map((name) => `src/${name}.rs`)].map((name) => `${crate}/${name}`);
  const { entry, sources } = await reviewedSources(sourcePaths);
  const target = "x86_64-pc-windows-msvc";
  const cargo = (args, options = {}) => execFileSync("cargo", args, { cwd: root, encoding: "utf8", ...options });
  try { cargo(["--version"], { stdio: "pipe" }); }
  catch { throw new Error("Building the Windows computer helper requires Rust. Install rustup with the stable MSVC toolchain, then rerun desktop:prepare."); }
  const targetDir = join(root, "out", "included-tools", "computer-helper-cargo");
  // --locked keeps the reviewed Cargo.lock authoritative; the target directory
  // stays outside node_modules so the pinned crate bytes are never rewritten.
  cargo(["build", "--release", "--locked", "--target", target, "--manifest-path", join(packageRoot, crate, "Cargo.toml"), "--target-dir", targetDir], { stdio: "inherit", env: rustBuildEnvironment() });
  const built = join(targetDir, target, "release", "windows-bridge.exe");
  const executableBytes = await readFile(built);
  assertWindowsConsoleExecutable(executableBytes);
  if (containsBuildMachinePath(executableBytes)) throw new Error("The Windows computer helper embeds this build account's profile path.");
  const outputDir = join(root, "out", "included-tools", "computer-helper");
  const output = join(outputDir, "work-fold Computer");
  const temporary = join(outputDir, `work-fold Computer.build-${process.pid}`);
  await rm(temporary, { force: true, recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    await writeFile(join(temporary, "work-fold Computer.exe"), executableBytes);
    await copyFile(join(packageRoot, "LICENSE"), join(temporary, "LICENSE.pi-computer-use"));
    await writeFile(join(temporary, "source.json"), `${JSON.stringify({
      schema: "work-fold.computer-helper-source.v1", package: entry.package, version: entry.version,
      source: entry.sourceURL || entry.source, license: entry.license, integrationPatchSha256: entry.sha256,
      sources, target, protocolVersion: 4, executableContentSha256: peContentSha256(executableBytes),
      compiler: execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" }).trim(),
      cargo: cargo(["--version"]).trim(),
    }, null, 2)}\n`);
    await rm(output, { force: true, recursive: true });
    // Defender can briefly hold a freshly written executable; retry only that.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, output); break; }
      catch (error) {
        if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100 * (attempt + 1), 1_000)));
      }
    }
    console.log(`Built included computer helper: ${resolve(output)}`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

/** The helper speaks JSON lines over stdio, so it must be an x64 console program. */
function assertWindowsConsoleExecutable(bytes) {
  if (bytes.length < 0x100 || bytes.toString("latin1", 0, 2) !== "MZ") throw new Error("The Windows computer helper is not a PE executable.");
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("The Windows computer helper has no PE header.");
  if (bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error("The Windows computer helper is not an x64 executable.");
  const optional = pe + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error("The Windows computer helper is not a PE32+ executable.");
  if (bytes.readUInt16LE(optional + 68) !== 3) throw new Error("The Windows computer helper is not a console-subsystem executable.");
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
