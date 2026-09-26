import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MAIN_CI_JOBS = Object.freeze([
  "Repository & TypeScript",
  "Application tests (1/4)",
  "Application tests (2/4)",
  "Application tests (3/4)",
  "Application tests (4/4)",
  "Web bridge tests",
  "Electron integration",
]);
export const TAG_CI_JOBS = Object.freeze(["Release tag verification"]);

// Both callers use GitHub's source-repository evidence. The tag workflow checks
// main; the local publisher additionally checks the independent tag receipt.
export async function verifyReleaseCi({
  repo, sha, tag, requireTagCi = true, mainOnly = false, expectedTagObjectSha, api = githubApi,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("Invalid release source repository.");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Release verification requires an exact commit SHA.");
  if (!mainOnly && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
    throw new Error("Release verification requires a versioned source tag.");
  }
  if (mainOnly && expectedTagObjectSha) throw new Error("Main-only verification cannot check a pinned source tag.");
  const prefix = `repos/${repo}`;
  const source = await readSource();
  const mainRun = await verifyWorkflow("ci.yml", "main", MAIN_CI_JOBS);
  const tagRun = !mainOnly && requireTagCi
    ? await verifyWorkflow("release-tag.yml", tag, TAG_CI_JOBS)
    : undefined;

  // A ref change while fetching Actions evidence must not admit stale evidence.
  const current = await readSource();
  if (source.tagObjectSha !== current.tagObjectSha) throw new Error(`Source tag ${tag} changed during CI verification.`);
  return { repo, sha, ...(mainOnly ? {} : { tag, tagObjectSha: source.tagObjectSha }), mainRun, ...(tagRun ? { tagRun } : {}) };

  async function readSource() {
    const main = await api(`${prefix}/git/ref/heads/main`);
    if (main?.ref !== "refs/heads/main" || main.object?.type !== "commit" || main.object.sha !== sha) {
      throw new Error(`Release commit ${sha} is not the current pushed main commit in ${repo}.`);
    }
    if (mainOnly) return {};
    const ref = await api(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref?.ref !== `refs/tags/${tag}` || ref.object?.type !== "tag" || !/^[a-f0-9]{40}$/.test(ref.object.sha ?? "")) {
      throw new Error(`Source tag ${tag} must be an annotated tag in ${repo}.`);
    }
    if (expectedTagObjectSha && ref.object.sha !== expectedTagObjectSha) {
      throw new Error(`Source tag ${tag} changed since the release was verified.`);
    }
    const annotated = await api(`${prefix}/git/tags/${ref.object.sha}`);
    if (annotated?.sha !== ref.object.sha || annotated.tag !== tag || annotated.object?.type !== "commit" || annotated.object.sha !== sha) {
      throw new Error(`Annotated source tag ${tag} does not point directly to the exact release commit ${sha}.`);
    }
    return { tagObjectSha: ref.object.sha };
  }

  async function verifyWorkflow(filename, branch, requiredJobs) {
    const workflow = await api(`${prefix}/actions/workflows/${filename}`);
    const path = `.github/workflows/${filename}`;
    if (!Number.isSafeInteger(workflow?.id) || workflow.id <= 0 || workflow.path !== path || workflow.state !== "active") {
      throw new Error(`Trusted workflow ${path} is missing or inactive in ${repo}.`);
    }
    // Do not filter by status/conclusion: an older success must never hide the
    // newest matching queued, failed, cancelled, or rerun candidate.
    const query = new URLSearchParams({ event: "push", branch, head_sha: sha });
    const runs = await collect(`${prefix}/actions/workflows/${workflow.id}/runs?${query}`, "workflow_runs");
    if (!runs.length) throw new Error(`No pushed ${branch} run of ${path} exists for ${sha}.`);
    for (const run of runs) assertRunIdentity(run, { repo, sha, branch, workflowId: workflow.id, path });
    const run = runs.reduce((latest, item) => item.id > latest.id ? item : latest);
    assertSuccessfulRun(run);
    // Deleting/re-pushing the same tag or main commit must not manufacture a
    // clean receipt after a failed immutable candidate.
    for (const previous of runs) assertSuccessfulRun(previous);
    const jobs = await collect(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs");
    assertSuccessfulJobs(jobs, requiredJobs, run.id, sha);
    // Catch a rerun beginning while its job list was fetched.
    const refreshed = await api(`${prefix}/actions/runs/${run.id}`);
    assertRunIdentity(refreshed, { repo, sha, branch, workflowId: workflow.id, path });
    assertSuccessfulRun(refreshed);
    if (refreshed.run_attempt !== run.run_attempt) throw new Error(`CI run ${run.id} changed attempts during verification.`);
    return { id: run.id, url: run.html_url, attempt: run.run_attempt };
  }

  async function collect(endpoint, field) {
    const items = [];
    const ids = new Set();
    const separator = endpoint.includes("?") ? "&" : "?";
    let total;
    for (let page = 1; page <= 100; page++) {
      const value = await api(`${endpoint}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(value?.[field]) || value[field].length > 100 || !Number.isSafeInteger(value.total_count) || value.total_count < 0) {
        throw new Error(`Malformed GitHub ${field} evidence.`);
      }
      if (total !== undefined && total !== value.total_count) throw new Error(`GitHub ${field} evidence changed during pagination.`);
      total = value.total_count;
      for (const item of value[field]) {
        if (!Number.isSafeInteger(item?.id) || item.id <= 0 || ids.has(item.id)) throw new Error(`Duplicate or invalid GitHub ${field} evidence.`);
        ids.add(item.id);
        items.push(item);
      }
      if (items.length > total) throw new Error(`Malformed GitHub ${field} count.`);
      if (items.length === total) return items;
      if (!value[field].length) throw new Error(`Incomplete GitHub ${field} pagination.`);
    }
    throw new Error(`GitHub ${field} pagination exceeded its verification bound.`);
  }
}

export function assertRunIdentity(run, { repo, sha, branch, workflowId, path }) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run.workflow_id !== workflowId || run.path !== path
    || run.event !== "push" || run.head_sha !== sha || run.head_branch !== branch
    || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo
    || run.html_url !== `https://github.com/${repo}/actions/runs/${run.id}`) {
    throw new Error(`GitHub run does not match trusted ${path} push evidence for ${repo} ${branch} at ${sha}.`);
  }
}

export function assertSuccessfulRun(run) {
  if (run.run_attempt !== 1) throw new Error(`CI run ${run.id} was rerun; use a new release commit and unique version instead of reusing candidate evidence.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`CI run ${run.id} is ${run.status}/${run.conclusion ?? "pending"}; successful completed evidence is required.`);
  }
}

export function assertSuccessfulJobs(jobs, requiredNames, runId, sha) {
  const names = new Set();
  for (const job of jobs) {
    if (job.run_id !== runId || job.run_attempt !== 1 || job.head_sha !== sha || !requiredNames.includes(job.name) || names.has(job.name)) {
      throw new Error(`CI run ${runId} contains unexpected, duplicate, or wrong-attempt job evidence: ${job.name ?? "unnamed"}.`);
    }
    if (job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`CI job ${job.name} is ${job.status}/${job.conclusion ?? "pending"}; every required job must succeed.`);
    }
    names.add(job.name);
  }
  for (const name of requiredNames) {
    if (!names.has(name)) throw new Error(`CI run ${runId} is missing required job ${name}.`);
  }
}

export async function githubApi(endpoint) {
  const { stdout } = await execFileAsync("gh", [
    "api", "--hostname", "github.com", "--method", "GET", endpoint,
    "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}
