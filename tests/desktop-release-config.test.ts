import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("desktop release configuration uses the isolated work-fold identities and feeds", () => {
  const packageJson = JSON.parse(read("package.json"));
  const identity = JSON.parse(read("src/shared/product-identity.json"));
  const require = createRequire(import.meta.url);
  const builderPath = join(rootDir, "electron-builder.desktop.cjs");
  const builder = require(builderPath);
  const previousPlatform = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM;
  const previousRepo = process.env.WORKFOLD_MAC_RELEASE_REPO;
  const previousUnsignedMac = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD;
  const previousOutput = process.env.WORKFOLD_DESKTOP_OUTPUT_DIR;
  process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM = "darwin";
  process.env.WORKFOLD_MAC_RELEASE_REPO = identity.macReleaseRepositoryName;
  delete require.cache[require.resolve(builderPath)];
  const macBuilder = require(builderPath);
  process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD = "1";
  delete require.cache[require.resolve(builderPath)];
  const macSmokeBuilder = require(builderPath);
  process.env.WORKFOLD_DESKTOP_OUTPUT_DIR = "out/mac-rc";
  delete require.cache[require.resolve(builderPath)];
  const macCandidateBuilder = require(builderPath);
  if (previousPlatform === undefined) delete process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM;
  else process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM = previousPlatform;
  if (previousRepo === undefined) delete process.env.WORKFOLD_MAC_RELEASE_REPO;
  else process.env.WORKFOLD_MAC_RELEASE_REPO = previousRepo;
  if (previousUnsignedMac === undefined) delete process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD;
  else process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD = previousUnsignedMac;
  if (previousOutput === undefined) delete process.env.WORKFOLD_DESKTOP_OUTPUT_DIR;
  else process.env.WORKFOLD_DESKTOP_OUTPUT_DIR = previousOutput;
  delete require.cache[require.resolve(builderPath)];

  assert.equal(packageJson.name, identity.packageName);
  assert.equal(packageJson.productName, identity.productName);
  assert.equal(packageJson.repository.url, "https://github.com/Mat-Tom-Son/work-fold.git");
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.9");
  assert.match(packageJson.scripts["desktop:make"], /electron-builder/);
  assert.match(packageJson.scripts["desktop:make"], /--win nsis --x64/, "the NSIS target and x64 architecture must use Electron Builder's supported argument order");
  assert.match(packageJson.scripts["desktop:make"], /--x64/, "the Windows release candidate must not inherit the build host architecture");
  assert.doesNotMatch(packageJson.scripts["desktop:make"], /prepackaged/);
  assert.deepEqual(builder.publish, [{
    provider: "github",
    owner: "Mat-Tom-Son",
    repo: "work-fold",
    releaseType: "release",
  }]);
  assert.deepEqual(macBuilder.publish, [{
    provider: "github",
    owner: "Mat-Tom-Son",
    repo: "work-fold-mac-releases",
    releaseType: "release",
  }]);
  assert.equal(macSmokeBuilder.productName, identity.macSmokeProductName);
  assert.equal(macSmokeBuilder.appId, identity.macSmokeAppId);
  assert.equal(macSmokeBuilder.extraMetadata.workFoldBuildChannel, "mac-local-smoke");
  assert.equal(macBuilder.productName, identity.productName);
  assert.equal(macBuilder.appId, identity.productionAppId);
  assert.equal(macBuilder.extraMetadata.workFoldBuildChannel, "production");
  assert.equal(macSmokeBuilder.mac.executableName, identity.macSmokeProductName);
  assert.equal(macBuilder.mac.executableName, identity.productName);
  assert.equal(builder.directories.output, "out/builder");
  assert.equal(macCandidateBuilder.directories.output, "out/mac-rc");
  assert.equal(builder.artifactName, "work-fold-${version}-${os}-${arch}.${ext}");
  assert.equal(builder.dmg.artifactName, "work-fold-${version}-mac-${arch}.${ext}");
  assert.equal(builder.nsis.artifactName, "work-fold-Setup-${version}.${ext}");
  assert.equal(builder.nsis.uninstallDisplayName, identity.productName);
  assert.equal(builder.nsis.shortcutName, identity.productName);
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  assert.equal(builder.electronFuses.runAsNode, false);
  assert.equal(builder.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(builder.win.verifyUpdateCodeSignature, false);
  assert.equal(builder.nsis.differentialPackage, true);
  assert.deepEqual(builder.mac.target, ["dmg", "zip"]);
  assert.equal(builder.mac.category, "public.app-category.productivity");
  assert.match(packageJson.scripts["desktop:make:mac"], /build-mac-desktop\.mjs/);
  assert.match(packageJson.scripts["desktop:make:mac:release"], /--release/);
  assert.match(packageJson.scripts["desktop:release:mac"], /desktop:publish:mac/);
  assert.equal(packageJson.scripts["desktop:release:mac:first"], undefined);
  assert.equal(packageJson.scripts["desktop:release:mac:first:resume"], undefined);
  assert.match(packageJson.scripts["desktop:verify:installed:mac"], /verify-installed-mac-app/);
});

test("Mac-only CI and publication keep credentials out of the application", () => {
  const updaterSource = read("desktop/src/updater.ts");
  const workflow = read(".github/workflows/ci.yml");
  const macPublisher = read("scripts/publish-mac-release.mjs");

  assert.doesNotMatch(updaterSource, /setFeedURL/);
  assert.doesNotMatch(updaterSource, /GH_TOKEN|GITHUB_TOKEN/);
  assert.match(updaterSource, /checkForUpdates/);
  assert.match(updaterSource, /quitAndInstall/);
  assert.match(updaterSource, /platform === "darwin"/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /npm run desktop:prepare/);
  assert.doesNotMatch(workflow, /windows-latest|desktop:package:smoke/);
  assert.equal(existsSync(join(rootDir, ".github", "workflows", "windows-release.yml")), false);
  assert.match(macPublisher, /assertSourceTagPublished\(\)/);
  assert.match(macPublisher, /Source tag .* public repository are verified/);
  assert.doesNotMatch(macPublisher, /mac-first|Mac-first|Setup-\$\{version\}\.exe|latest\.yml/);
  assert.match(macPublisher, /remote\.digest !== `sha256:\$\{localDigest\}`/);
  assert.doesNotMatch(macPublisher, /allow-dirty|allowDirty/);
});

test("the macOS Safe Storage reset can target only the work-fold identity", () => {
  const reset = read("scripts/reset-mac-safe-storage.mjs");

  assert.match(reset, /src", "shared", "product-identity\.json"/);
  assert.match(reset, /Application Support", identity\.productName/);
  assert.match(reset, /`\/Applications\/\$\{identity\.productName\}\.app`/);
  assert.match(reset, /`\$\{identity\.productName\} Key`/);
  assert.match(reset, /`\$\{identity\.productName\} Safe Storage`/);
  assert.doesNotMatch(reset, /Application Support", "Workspace"/);
  assert.doesNotMatch(reset, /\/Applications\/Workspace\.app/);
  assert.doesNotMatch(reset, /["'`]Workspace (?:Key|Safe Storage)["'`]/);
  assert.doesNotMatch(reset, /security[\s\S]{0,300}["']-g["']/);
});

function read(path: string): string {
  return readFileSync(join(rootDir, path), "utf8");
}
