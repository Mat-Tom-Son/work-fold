import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const platform = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform;
if (platform !== "darwin") {
  console.log("The included computer helper is built in the macOS desktop lane only.");
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
