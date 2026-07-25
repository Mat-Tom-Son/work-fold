import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("Windows release configuration points at the public Workspace update feed", () => {
  const packageJson = JSON.parse(read("package.json"));
  const require = createRequire(import.meta.url);
  const builderPath = join(rootDir, "electron-builder.desktop.cjs");
  const builder = require(builderPath);
  const previousPlatform = process.env.WORKSPACE_DESKTOP_RELEASE_PLATFORM;
  const previousRepo = process.env.WORKSPACE_MAC_RELEASE_REPO;
  const previousUnsignedMac = process.env.WORKSPACE_ALLOW_UNSIGNED_MAC_BUILD;
  process.env.WORKSPACE_DESKTOP_RELEASE_PLATFORM = "darwin";
  process.env.WORKSPACE_MAC_RELEASE_REPO = "workspace-mac-releases";
  delete require.cache[require.resolve(builderPath)];
  const macBuilder = require(builderPath);
  process.env.WORKSPACE_ALLOW_UNSIGNED_MAC_BUILD = "1";
  delete require.cache[require.resolve(builderPath)];
  const macSmokeBuilder = require(builderPath);
  if (previousPlatform === undefined) delete process.env.WORKSPACE_DESKTOP_RELEASE_PLATFORM;
  else process.env.WORKSPACE_DESKTOP_RELEASE_PLATFORM = previousPlatform;
  if (previousRepo === undefined) delete process.env.WORKSPACE_MAC_RELEASE_REPO;
  else process.env.WORKSPACE_MAC_RELEASE_REPO = previousRepo;
  if (previousUnsignedMac === undefined) delete process.env.WORKSPACE_ALLOW_UNSIGNED_MAC_BUILD;
  else process.env.WORKSPACE_ALLOW_UNSIGNED_MAC_BUILD = previousUnsignedMac;
  delete require.cache[require.resolve(builderPath)];

  assert.equal(packageJson.repository.url, "https://github.com/Mat-Tom-Son/workspace.git");
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.9");
  assert.match(packageJson.scripts["desktop:make"], /electron-builder/);
  assert.match(packageJson.scripts["desktop:make"], /--win nsis --x64/, "the NSIS target and x64 architecture must use Electron Builder's supported argument order");
  assert.match(packageJson.scripts["desktop:make"], /--x64/, "the Windows release candidate must not inherit the build host architecture");
  assert.doesNotMatch(packageJson.scripts["desktop:make"], /prepackaged/);
  assert.deepEqual(builder.publish, [{
    provider: "github",
    owner: "Mat-Tom-Son",
    repo: "workspace",
    releaseType: "release",
  }]);
  assert.deepEqual(macBuilder.publish, [{
    provider: "github",
    owner: "Mat-Tom-Son",
    repo: "workspace-mac-releases",
    releaseType: "release",
  }]);
  assert.equal(macSmokeBuilder.productName, "Workspace Local Smoke");
  assert.equal(macSmokeBuilder.appId, "io.github.mattomson.workspace.local-smoke");
  assert.equal(macSmokeBuilder.extraMetadata.workspaceBuildChannel, "mac-local-smoke");
  assert.equal(macBuilder.productName, "Workspace");
  assert.equal(macBuilder.appId, "io.github.mattomson.workspace");
  assert.equal(macBuilder.extraMetadata.workspaceBuildChannel, "production");
  assert.equal(macSmokeBuilder.mac.executableName, "Workspace Local Smoke");
  assert.equal(macBuilder.mac.executableName, "Workspace");
  assert.equal(builder.electronFuses.runAsNode, false);
  assert.equal(builder.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(builder.win.verifyUpdateCodeSignature, false);
  assert.equal(builder.nsis.differentialPackage, true);
  assert.deepEqual(builder.mac.target, ["dmg", "zip"]);
  assert.equal(builder.mac.category, "public.app-category.productivity");
  assert.match(packageJson.scripts["desktop:make:mac"], /build-mac-desktop\.mjs/);
  assert.match(packageJson.scripts["desktop:make:mac:release"], /--release/);
  assert.match(packageJson.scripts["desktop:release:mac"], /desktop:publish:mac/);
  assert.match(packageJson.scripts["desktop:verify:installed:mac"], /verify-installed-mac-app/);
});

test("Updater and release workflow keep credentials out of the application", () => {
  const updaterSource = read("desktop/src/updater.ts");
  const workflow = read(".github/workflows/windows-release.yml");
  const macPublisher = read("scripts/publish-mac-release.mjs");

  assert.doesNotMatch(updaterSource, /setFeedURL/);
  assert.doesNotMatch(updaterSource, /GH_TOKEN|GITHUB_TOKEN/);
  assert.match(updaterSource, /checkForUpdates/);
  assert.match(updaterSource, /quitAndInstall/);
  assert.match(updaterSource, /platform === "darwin"/);
  assert.match(workflow, /tags:/);
  assert.match(workflow, /WIN_CSC_LINK/);
  assert.match(workflow, /WORKSPACE_TRUSTED_CODE_SIGNING/);
  assert.match(workflow, /latest\.yml/);
  assert.match(workflow, /docs\/releases\/\$version\.md/);
  assert.match(workflow, /--notes-file \$notes/);
  assert.doesNotMatch(workflow, /--generate-notes/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /--draft=false/);
  assert.match(macPublisher, /assertSourceReleasePublished\(\)/);
  assert.match(macPublisher, /Source release .* must be public before publishing macOS/);
  assert.match(macPublisher, /Workspace-Setup-\$\{version\}\.exe\.blockmap/);
  assert.match(macPublisher, /remote\.digest !== `sha256:\$\{localDigest\}`/);
  assert.doesNotMatch(macPublisher, /allow-dirty|allowDirty/);
});

function read(path: string): string {
  return readFileSync(join(rootDir, path), "utf8");
}
