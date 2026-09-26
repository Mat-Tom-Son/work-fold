import { githubApi, verifyReleaseMain, verifyReleaseSource } from "./release-source.mjs";
export { githubApi } from "./release-source.mjs";

export const MAIN_CI_JOBS = Object.freeze([
  "Repository & TypeScript",
  "Application tests (1/4)",
  "Application tests (2/4)",
  "Application tests (3/4)",
  "Application tests (4/4)",
  "Web bridge tests",
  "Electron integration",
  "Linux x64 candidate",
]);
export const TAG_CI_JOBS = Object.freeze(["Release tag verification"]);

// Optional diagnostic only. Publication uses local verification and the
// independent source-ref verifier, without waiting for GitHub Actions.
export async function verifyReleaseCi({
  repo, sha, tag, requireTagCi = true, mainOnly = false, expectedTagObjectSha, api = githubApi,
}) {
  if (mainOnly && expectedTagObjectSha) throw new Error("Main-only verification cannot check a pinned source tag.");
  const prefix = `repos/${repo}`;
  const readSource = () => mainOnly
    ? verifyReleaseMain({ repo, sha, api })
    : verifyReleaseSource({ repo, sha, tag, expectedTagObjectSha, api });
  const source = await readSource();
  const mainRun = await verifyWorkflow("ci.yml", "main", MAIN_CI_JOBS);
  const tagRun = !mainOnly && requireTagCi
    ? await verifyWorkflow("release-tag.yml", tag, TAG_CI_JOBS)
    : undefined;

  // A ref change while fetching Actions evidence must not admit stale evidence.
  const current = await readSource();
  if (source.tagObjectSha !== current.tagObjectSha) throw new Error(`Source tag ${tag} changed during CI verification.`);
  return { repo, sha, ...(mainOnly ? {} : { tag, tagObjectSha: source.tagObjectSha }), mainRun, ...(tagRun ? { tagRun } : {}) };

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
