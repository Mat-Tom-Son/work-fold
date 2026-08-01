import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const version = String(packageJson.version ?? "").trim();
const arch = stringValue(process.env.WORKFOLD_DESKTOP_RELEASE_ARCH) || (process.arch === "x64" ? "x64" : "arm64");
const owner = stringValue(process.env.WORKFOLD_MAC_RELEASE_OWNER) || identity.sourceRepositoryOwner;
const repo = stringValue(process.env.WORKFOLD_MAC_RELEASE_REPO) || identity.macReleaseRepositoryName;
const releaseRepo = `${owner}/${repo}`;
const sourceRepo = stringValue(process.env.WORKFOLD_SOURCE_RELEASE_REPO) || `${identity.sourceRepositoryOwner}/${identity.sourceRepositoryName}`;
const tag = `v${version}`;
const macFirst = process.argv.includes("--mac-first");
const builderDir = join(rootDir, "out", "builder");
const stem = `${identity.productName}-${version}-mac-${arch}`;
const manifestName = `${identity.productName}-mac-release-manifest.json`;
const requiredAssets = [
  `${stem}.dmg`,
  `${stem}.dmg.blockmap`,
  `${stem}.zip`,
  `${stem}.zip.blockmap`,
  "latest-mac.yml",
  "SHA256SUMS-mac.txt",
  manifestName,
  `${identity.productName}-mac-release-manifest.txt`,
];

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS releases must be published from a Mac host.`);
if (!version) throw new Error("package.json does not declare a release version.");

assertSourceState();
run("gh", ["auth", "status"], "GitHub CLI authentication is required");
assertSourceReleasePublished();
const repoInfo = JSON.parse(run("gh", ["repo", "view", releaseRepo, "--json", "isPrivate,visibility,url"], `Mac release feed ${releaseRepo} was not found`));
if (repoInfo.isPrivate || repoInfo.visibility !== "PUBLIC") {
  throw new Error(`${releaseRepo} must be public so installed ${identity.productName} apps can update without a GitHub token.`);
}

const existingRelease = spawnSync("gh", ["release", "view", tag, "--repo", releaseRepo, "--json", "tagName,isDraft,url"], commandOptions());
if (existingRelease.status === 0) {
  const existing = JSON.parse(existingRelease.stdout);
  throw new Error(`${releaseRepo} already contains ${tag}${existing.isDraft ? " as a draft" : ""}. Bump the shared version or delete only a failed draft before retrying. ${existing.url}`);
}

for (const name of requiredAssets) {
  const path = join(builderDir, name);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Missing ${identity.productName} release asset ${path}. Run npm run desktop:make:mac:release first.`);
  }
}

runNpmScript("desktop:verify:release:mac");
const manifest = JSON.parse(readFileSync(join(builderDir, manifestName), "utf8"));
if (manifest.version !== version || manifest.platform !== "darwin" || manifest.arch !== arch || manifest.unsignedSmokeBuild !== false) {
  throw new Error(`The ${identity.productName} macOS manifest is not a signed release for the current version and architecture.`);
}
if (manifest.feed?.owner !== owner || manifest.feed?.repo !== repo) {
  throw new Error(`The ${identity.productName} manifest feed does not match ${releaseRepo}.`);
}

const notes = [
  `${identity.productName} ${version} for macOS`,
  "",
  `Signed with Apple Team ID ${stringValue(process.env.WORKFOLD_MAC_TEAM_ID) || "464JD5K8DC"}, notarized by Apple, and published for ${arch}.`,
  "Use the DMG for a first install. Existing updater-capable Mac installs consume the ZIP and latest-mac.yml assets.",
].join("\n");

console.log(`[${identity.productName} macOS release] Uploading ${tag} to ${releaseRepo} as a draft.`);
run(
  "gh",
  [
    "release", "create", tag,
    "--repo", releaseRepo,
    "--target", "main",
    "--title", `${identity.productName} ${version} for macOS`,
    "--notes", notes,
    "--draft",
    ...requiredAssets.map((name) => join(builderDir, name)),
  ],
  `Could not create draft ${identity.productName} macOS release ${tag}`,
  45 * 60_000,
);

verifyRemoteRelease(true);
run("gh", ["release", "edit", tag, "--repo", releaseRepo, "--draft=false", "--latest"], `Could not publish ${identity.productName} macOS release ${tag}`);
const release = verifyRemoteRelease(false);
console.log(`[${identity.productName} macOS release] Published ${release.url}`);

function assertSourceState() {
  const status = run("git", ["status", "--short"], `Could not inspect the ${identity.productName} source worktree`);
  if (status) throw new Error("Working tree is dirty. Commit and push the exact release source before publishing.");
  run("git", ["fetch", "--quiet", "origin", "main"], "Could not refresh origin/main before publishing");
  const head = run("git", ["rev-parse", "HEAD"], "Could not read local HEAD");
  const remoteHead = run("git", ["rev-parse", "origin/main"], "Could not read origin/main");
  if (head !== remoteHead) throw new Error(`Local HEAD ${head} does not match origin/main ${remoteHead}. Push the release commit first.`);
}

function assertSourceReleasePublished() {
  run("git", ["fetch", "--quiet", "origin", "tag", tag], `Could not refresh source tag ${tag}`);
  const head = run("git", ["rev-parse", "HEAD"], "Could not read local HEAD");
  const taggedCommit = run("git", ["rev-parse", `${tag}^{commit}`], `Could not resolve source tag ${tag}`);
  if (taggedCommit !== head) {
    throw new Error(`Source tag ${tag} points to ${taggedCommit}, not the exact release commit ${head}.`);
  }

  const sourceReleaseResult = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", sourceRepo, "--json", "tagName,isDraft,isPrerelease,assets,url"],
    commandOptions(),
  );
  if (sourceReleaseResult.status !== 0) {
    if (!macFirst) {
      throw new Error(`Source release ${sourceRepo} ${tag} must be public before publishing macOS: ${compactText(sourceReleaseResult.stderr || sourceReleaseResult.stdout)}`);
    }
    const sourceInfo = JSON.parse(run(
      "gh",
      ["repo", "view", sourceRepo, "--json", "isPrivate,visibility,url"],
      `Source repository ${sourceRepo} was not found`,
    ));
    if (sourceInfo.isPrivate || sourceInfo.visibility !== "PUBLIC") {
      throw new Error(`${sourceRepo} must be public before a Mac-first release can be published.`);
    }
    console.log(`[${identity.productName} macOS release] Windows release ${sourceRepo} ${tag} is explicitly deferred; source tag and public repository are verified.`);
    return;
  }

  const release = JSON.parse(sourceReleaseResult.stdout);
  if (release.tagName !== tag || release.isDraft || release.isPrerelease) {
    throw new Error(`Source release ${sourceRepo} ${tag} is not a public stable release.`);
  }
  const assetNames = new Set((release.assets ?? []).map((asset) => asset.name));
  for (const name of [
    `${identity.productName}-Setup-${version}.exe`,
    `${identity.productName}-Setup-${version}.exe.blockmap`,
    "latest.yml",
    "SHA256SUMS.txt",
  ]) {
    if (!assetNames.has(name)) throw new Error(`Source release ${sourceRepo} ${tag} is missing ${name}.`);
  }
}

function verifyRemoteRelease(expectDraft) {
  const release = JSON.parse(run(
    "gh",
    ["release", "view", tag, "--repo", releaseRepo, "--json", "tagName,isDraft,isPrerelease,assets,url"],
    `Could not verify ${identity.productName} macOS release ${tag}`,
  ));
  if (release.tagName !== tag || release.isDraft !== expectDraft || release.isPrerelease) {
    throw new Error(`${identity.productName} Mac release ${tag} has unexpected draft or prerelease state.`);
  }
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const name of requiredAssets) {
    const remote = assets.get(name);
    if (!remote) throw new Error(`${identity.productName} Mac release ${tag} is missing ${name}.`);
    const localSize = statSync(join(builderDir, name)).size;
    if (remote.size !== localSize) throw new Error(`${name} is ${remote.size} bytes remotely but ${localSize} bytes locally.`);
    const localDigest = createHash("sha256").update(readFileSync(join(builderDir, name))).digest("hex");
    if (remote.digest !== `sha256:${localDigest}`) {
      throw new Error(`${name} has remote digest ${remote.digest || "missing"}; expected sha256:${localDigest}.`);
    }
  }
  return release;
}

function runNpmScript(name) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, "run", name], `${name} failed`, 15 * 60_000);
    return;
  }
  run("npm", ["run", name], `${name} failed`, 15 * 60_000);
}

function run(command, args, label, timeout = 120_000) {
  const result = spawnSync(command, args, { ...commandOptions(), timeout });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${compactText(result.error?.message || output || `exit code ${result.status ?? 1}`)}`);
  }
  if (output) console.log(output);
  return String(result.stdout || "").trim();
}

function commandOptions() {
  return {
    cwd: rootDir,
    env: {
      ...process.env,
      WORKFOLD_DESKTOP_RELEASE_PLATFORM: "darwin",
      WORKFOLD_DESKTOP_RELEASE_ARCH: arch,
      WORKFOLD_MAC_RELEASE_BUILD: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1800);
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
