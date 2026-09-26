import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseCi } from "./release-ci.mjs";
import { verifyReleaseSource } from "./release-source.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(new URL("../src/shared/product-identity.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repo = `${identity.sourceRepositoryOwner}/${identity.sourceRepositoryName}`;
const tag = `v${packageJson.version}`;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
const options = process.argv.slice(2);
if (options.some((option) => option !== "--tag-check" && option !== "--main-only") || options.length > 1) {
  throw new Error("Usage: node scripts/verify-release-ci.mjs [--tag-check | --main-only]");
}
if (process.env.WORKFOLD_SOURCE_RELEASE_REPO && process.env.WORKFOLD_SOURCE_RELEASE_REPO !== repo) {
  throw new Error(`Release CI can only be verified in the canonical source repository ${repo}.`);
}
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repo) throw new Error("GitHub Actions repository does not match the canonical source repository.");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) throw new Error("GitHub Actions commit does not match this checkout.");
if (process.env.GITHUB_ACTIONS === "true" && options.includes("--tag-check")) {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== `refs/tags/${tag}`
    || process.env.GITHUB_WORKFLOW_REF !== `${repo}/.github/workflows/release-tag.yml@refs/tags/${tag}`) {
    throw new Error("Release-tag verification requires the matching pushed source tag and trusted workflow.");
  }
}

const evidence = options.includes("--tag-check")
  ? await verifyReleaseSource({ repo, sha, tag })
  : await verifyReleaseCi({ repo, sha, tag, mainOnly: options.includes("--main-only") });
console.log(JSON.stringify(evidence, null, 2));
