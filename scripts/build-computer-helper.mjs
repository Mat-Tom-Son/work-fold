import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCargoNotices } from "./cargo-license-notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const platform = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform;
if (platform === "linux") {
  await buildLinux();
} else if (platform !== "darwin") {
  console.log("The included computer helper is built in the macOS and Linux desktop lanes only.");
} else {
  if (process.platform !== "darwin") throw new Error("Building the computer helper requires macOS and Xcode Command Line Tools.");
  await build();
}

async function build() {
  const packageRoot = join(root, "node_modules", "@injaneity", "pi-computer-use");
  const manifest = JSON.parse(await readFile(join(root, "patches", "included-tools", "manifest.json"), "utf8"));
  const entry = manifest.find((item) => item.package === "@injaneity/pi-computer-use");
  if (!entry) throw new Error("Missing reviewed computer integration source manifest.");
  const upstream = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (upstream.version !== entry.version) throw new Error("Review the new computer helper source before building it.");
  const sourcePaths = ["scripts/build-native.mjs", ...["request_lifecycle.swift", "agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"].map((name) => `native/macos/${name}`)];
  const sources = [];
  for (const path of sourcePaths) {
    const actual = sha256(await readFile(join(packageRoot, path)));
    if (actual !== entry.files.find((file) => file.path === path)?.after) throw new Error(`Unreviewed computer helper source: ${path}. Run npm ci before rebuilding.`);
    sources.push({ path, sha256: actual });
  }
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
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function buildLinux() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build the Linux x64 helper on Linux x64.");
  const packageRoot = join(root, "node_modules/@injaneity/pi-computer-use");
  const entries = JSON.parse(await readFile(join(root, "patches/included-tools/manifest.json"), "utf8"));
  const entry = entries.find(item => item.package === "@injaneity/pi-computer-use");
  const sources = entry.files.filter(file => file.path.startsWith("native/linux/bridge-rs/"));
  if (!sources.length) throw new Error("Missing reviewed Linux helper sources.");
  for (const file of sources) if (sha256(await readFile(join(packageRoot, file.path))) !== file.after) throw new Error(`Unreviewed Linux helper source: ${file.path}`);
  const target = join(root, "out/linux-computer-target");
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(packageRoot, "native/linux/bridge-rs/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  const output = join(root, "out/included-tools/computer-helper");
  await mkdir(output, { recursive: true });
  await writeCargoNotices(join(packageRoot, "native/linux/bridge-rs/Cargo.toml"), join(output, "THIRD-PARTY-LICENSES.txt"));
  const binary = join(output, "linux-bridge");
  await copyFile(join(target, "release/linux-bridge"), binary); await chmod(binary, 0o755);
  await copyFile(join(packageRoot, "LICENSE"), join(output, "LICENSE.pi-computer-use"));
  await writeFile(join(output, "source.json"), `${JSON.stringify({
    schema: "work-fold.computer-helper-source.v1", package: entry.package, version: entry.version,
    source: entry.source, license: entry.license, integrationPatchSha256: entry.sha256,
    sources: sources.map(file => ({ path: file.path, sha256: file.after })),
    target: "x86_64-unknown-linux-gnu", protocolVersion: 4, binarySha256: sha256(await readFile(binary)),
    compiler: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  }, null, 2)}\n`);
  console.log(`Built included Linux computer helper: ${binary}`);
}
