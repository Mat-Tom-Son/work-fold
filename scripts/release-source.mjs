import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const identity = JSON.parse(readFileSync(new URL("../src/shared/product-identity.json", import.meta.url), "utf8"));
const sourceRepository = `${identity.sourceRepositoryOwner}/${identity.sourceRepositoryName}`;

// Source identity is independent of background GitHub Actions results. Both the
// publisher and the lightweight tag workflow use this read-only ref check.
export async function verifyReleaseSource({ repo, sha, tag, expectedTagObjectSha, api = githubApi }) {
  assertSourceInput(repo, sha);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
    throw new Error("Release verification requires a versioned source tag.");
  }
  if (expectedTagObjectSha !== undefined && !/^[a-f0-9]{40}$/.test(expectedTagObjectSha)) {
    throw new Error("A pinned source tag requires an exact annotated-tag object SHA.");
  }
  const initial = await readSource();
  const current = await readSource();
  if (initial.tagObjectSha !== current.tagObjectSha) throw new Error(`Source tag ${tag} changed during source verification.`);
  return { repo, sha, tag, tagObjectSha: initial.tagObjectSha };

  async function readSource() {
    await assertPushedMain(repo, sha, api);
    const ref = await api(`repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref?.ref !== `refs/tags/${tag}` || ref.object?.type !== "tag" || !/^[a-f0-9]{40}$/.test(ref.object.sha ?? "")) {
      throw new Error(`Source tag ${tag} must be an annotated tag in ${repo}.`);
    }
    if (expectedTagObjectSha && ref.object.sha !== expectedTagObjectSha) {
      throw new Error(`Source tag ${tag} changed since the release was verified.`);
    }
    const annotated = await api(`repos/${repo}/git/tags/${ref.object.sha}`);
    if (annotated?.sha !== ref.object.sha || annotated.tag !== tag || annotated.object?.type !== "commit" || annotated.object.sha !== sha) {
      throw new Error(`Annotated source tag ${tag} does not point directly to the exact release commit ${sha}.`);
    }
    return { tagObjectSha: ref.object.sha };
  }
}

export async function verifyReleaseMain({ repo, sha, api = githubApi }) {
  assertSourceInput(repo, sha);
  await assertPushedMain(repo, sha, api);
  await assertPushedMain(repo, sha, api);
  return { repo, sha };
}

function assertSourceInput(repo, sha) {
  if (repo !== sourceRepository) throw new Error(`Release source must be the canonical repository ${sourceRepository}.`);
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Release verification requires an exact commit SHA.");
}

async function assertPushedMain(repo, sha, api) {
  const main = await api(`repos/${repo}/git/ref/heads/main`);
  if (main?.ref !== "refs/heads/main" || main.object?.type !== "commit" || main.object.sha !== sha) {
    throw new Error(`Release commit ${sha} is not the current pushed main commit in ${repo}.`);
  }
}

export async function githubApi(endpoint) {
  const { stdout } = await execFileAsync("gh", [
    "api", "--hostname", "github.com", "--method", "GET", endpoint,
    "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}
