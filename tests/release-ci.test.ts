import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAIN_CI_JOBS, TAG_CI_JOBS, verifyReleaseCi } from "../scripts/release-ci.mjs";
import { verifyReleaseMain, verifyReleaseSource } from "../scripts/release-source.mjs";

const repo = "Mat-Tom-Son/work-fold";
const sha = "a".repeat(40);
const tagObjectSha = "b".repeat(40);
const tag = "v0.5.0";
const options = { repo, sha, tag };

function fixture() {
  const run = (id: number, branch: string, workflowId: number, filename: string) => ({
    id, workflow_id: workflowId, path: `.github/workflows/${filename}`, event: "push", head_sha: sha,
    head_branch: branch, repository: { full_name: repo }, head_repository: { full_name: repo },
    html_url: `https://github.com/${repo}/actions/runs/${id}`, run_attempt: 1, status: "completed", conclusion: "success",
  });
  const main = run(11, "main", 7, "ci.yml");
  const release = run(12, tag, 8, "release-tag.yml");
  const jobs = (runId: number, names: string[]) => names.map((name, index) => ({
    id: runId * 100 + index + 1, run_id: runId, run_attempt: 1, head_sha: sha, name, status: "completed", conclusion: "success",
  }));
  const data = {
    mainRef: { ref: "refs/heads/main", object: { type: "commit", sha } },
    tagRef: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObjectSha } },
    annotation: { sha: tagObjectSha, tag, object: { type: "commit", sha } },
    mainRuns: [main], tagRuns: [release],
    mainJobs: jobs(main.id, [...MAIN_CI_JOBS]), tagJobs: jobs(release.id, [...TAG_CI_JOBS]),
    workflows: {
      "ci.yml": { id: 7, path: ".github/workflows/ci.yml", state: "active" },
      "release-tag.yml": { id: 8, path: ".github/workflows/release-tag.yml", state: "active" },
    } as Record<string, { id: number; path: string; state: string }>,
    pageSize: 100,
  };
  const calls: string[] = [];
  const api = async (endpoint: string) => {
    calls.push(endpoint);
    const url = new URL(endpoint, "https://api.github.com/");
    const path = url.pathname.replace(`/repos/${repo}/`, "");
    let value: unknown;
    if (path === "git/ref/heads/main") value = data.mainRef;
    else if (path === `git/ref/tags/${tag}`) value = data.tagRef;
    else if (path === `git/tags/${data.tagRef.object.sha}`) value = data.annotation;
    else if (path.startsWith("actions/workflows/") && path.endsWith(".yml")) value = data.workflows[path.slice("actions/workflows/".length)];
    else if (/^actions\/workflows\/\d+\/runs$/.test(path)) {
      const items = path.includes("/7/") ? data.mainRuns : data.tagRuns;
      const page = Number(url.searchParams.get("page"));
      value = { total_count: items.length, workflow_runs: items.slice((page - 1) * data.pageSize, page * data.pageSize) };
    } else if (/^actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) {
      const runId = Number(path.split("/")[2]);
      const items = runId === main.id ? data.mainJobs : data.tagJobs;
      const page = Number(url.searchParams.get("page"));
      value = { total_count: items.length, jobs: items.slice((page - 1) * data.pageSize, page * data.pageSize) };
    } else if (/^actions\/runs\/\d+$/.test(path)) {
      const runId = Number(path.split("/")[2]);
      value = [...data.mainRuns, ...data.tagRuns].find((item) => item.id === runId);
    } else throw new Error(`Unexpected API endpoint ${endpoint}`);
    assert.notEqual(value, undefined, `fixture has a response for ${endpoint}`);
    return structuredClone(value);
  };
  return { data, calls, api };
}

test("optional CI diagnostics inspect exact main and lightweight tag evidence", async () => {
  const f = fixture();
  const evidence = await verifyReleaseCi({ ...options, api: f.api });
  assert.deepEqual(evidence, {
    ...options, tagObjectSha,
    mainRun: { id: 11, url: `https://github.com/${repo}/actions/runs/11`, attempt: 1 },
    tagRun: { id: 12, url: `https://github.com/${repo}/actions/runs/12`, attempt: 1 },
  });
  assert.equal(f.calls.filter((path) => path.endsWith("git/ref/heads/main")).length, 4);
  assert.equal(f.calls.filter((path) => path.includes("git/ref/tags/")).length, 4);
  assert.ok(f.calls.some((path) => path.includes("/attempts/1/jobs")));
  assert.ok(f.calls.every((path) => !path.includes("status=") && !path.includes("conclusion=")));
});

test("optional CI diagnostics can inspect main without depending on the tag run", async () => {
  const f = fixture();
  f.data.tagRuns[0]!.status = "in_progress";
  const evidence = await verifyReleaseCi({ ...options, requireTagCi: false, api: f.api });
  assert.equal(evidence.tagObjectSha, tagObjectSha);
  assert.equal(evidence.tagRun, undefined);
  assert.ok(f.calls.every((path) => !path.includes("release-tag.yml")));
});

test("release source verification reads only canonical main and annotated tag identity twice", async () => {
  const f = fixture();
  f.data.mainRuns[0]!.conclusion = "failure";
  f.data.tagRuns[0]!.status = "queued";
  const evidence = await verifyReleaseSource({ ...options, api: f.api });
  assert.deepEqual(evidence, { ...options, tagObjectSha });
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter((path) => path.endsWith("git/ref/heads/main")).length, 2);
  assert.equal(f.calls.filter((path) => path.includes("git/ref/tags/")).length, 2);
  assert.ok(f.calls.every((path) => !path.includes("/actions/")));
  const main = fixture();
  assert.deepEqual(await verifyReleaseMain({ repo, sha, api: main.api }), { repo, sha });
  assert.deepEqual(main.calls, [`repos/${repo}/git/ref/heads/main`, `repos/${repo}/git/ref/heads/main`]);
});

test("source verification rejects noncanonical repositories and malformed identity before any API call", async () => {
  const f = fixture();
  for (const override of [{ repo: "someone/fork" }, { sha: "main" }, { tag: "latest" }, { expectedTagObjectSha: "" }]) {
    await assert.rejects(verifyReleaseSource({ ...options, ...override, api: f.api }), /canonical repository|exact commit SHA|versioned source tag|annotated-tag object SHA/);
  }
  assert.deepEqual(f.calls, []);
});

test("source-only validation rejects wrong or moved main, lightweight tags, and recreated annotations", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.data.mainRef.object.sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.tagRef.object.type = "commit"; },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.object.sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.object.type = "tag"; },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.tag = "v0.1.0"; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyReleaseSource({ ...options, api: f.api }), /not the current pushed main|must be an annotated tag|does not point directly/);
  }
  const pinned = fixture();
  await assert.rejects(verifyReleaseSource({ ...options, expectedTagObjectSha: "c".repeat(40), api: pinned.api }), /changed since/);
  for (const field of ["main", "tag"] as const) {
    const f = fixture();
    let mainReads = 0;
    await assert.rejects(verifyReleaseSource({ ...options, api: async (endpoint: string) => {
      if (endpoint.endsWith("git/ref/heads/main") && ++mainReads === 2) {
        if (field === "main") f.data.mainRef.object.sha = "c".repeat(40);
        else {
          f.data.tagRef.object.sha = "c".repeat(40);
          f.data.annotation.sha = "c".repeat(40);
        }
      }
      return f.api(endpoint);
    } }), /not the current pushed main|changed during source verification/);
  }
});

test("main-only preflight requires pushed main but no new source tag", async () => {
  const f = fixture();
  const evidence = await verifyReleaseCi({ repo, sha, mainOnly: true, api: f.api });
  assert.equal(evidence.tag, undefined);
  assert.equal(evidence.tagRun, undefined);
  assert.ok(f.calls.every((path) => !path.includes("git/ref/tags/") && !path.includes("release-tag.yml")));
});

test("older successful runs cannot hide newer failed or pending candidate runs", async () => {
  for (const state of ["failure", "cancelled", "timed_out", "action_required", "pending"]) {
    const f = fixture();
    f.data.mainRuns.push({ ...f.data.mainRuns[0]!, id: 21, html_url: `https://github.com/${repo}/actions/runs/21`, conclusion: state, status: state === "pending" ? "queued" : "completed" });
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /successful completed evidence/);
  }
});

test("matching workflow runs and required jobs are fully paginated", async () => {
  const f = fixture();
  f.data.pageSize = 2;
  f.data.mainRuns.push(
    { ...f.data.mainRuns[0]!, id: 9, html_url: `https://github.com/${repo}/actions/runs/9` },
    { ...f.data.mainRuns[0]!, id: 8, html_url: `https://github.com/${repo}/actions/runs/8` },
  );
  await verifyReleaseCi({ ...options, api: f.api });
  assert.ok(f.calls.some((path) => path.includes("/7/runs?") && path.endsWith("page=2")));
  assert.ok(f.calls.some((path) => path.includes("/11/attempts/1/jobs?") && path.endsWith("page=4")));
});

test("a fresh successful push cannot erase a previous failed candidate with the same commit and tag", async () => {
  for (const key of ["mainRuns", "tagRuns"] as const) {
    const f = fixture();
    f.data[key].push({ ...f.data[key][0]!, id: 9, html_url: `https://github.com/${repo}/actions/runs/9`, conclusion: "failure" });
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /successful completed evidence/);
  }
});

test("missing, duplicate, skipped, failed, and wrong-attempt jobs cannot produce a green release", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs.pop(); },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.name = f.data.mainJobs[0]!.name; },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.conclusion = "skipped"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.conclusion = "failure"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.run_attempt = 2; },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.run_id = 99; },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.head_sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.mainJobs[1]!.name = "Application tests"; },
    (f: ReturnType<typeof fixture>) => { f.data.tagJobs[0]!.conclusion = "skipped"; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /missing required job|job evidence|every required job must succeed/);
  }
});

test("wrong workflow, event, repository, SHA, or ref is rejected", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.workflow_id = 99; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.path = ".github/workflows/untrusted.yml"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.event = "workflow_dispatch"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.repository.full_name = "someone/fork"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.head_repository.full_name = "someone/fork"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.head_sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.head_branch = "feature"; },
    (f: ReturnType<typeof fixture>) => { f.data.mainRuns[0]!.html_url = "https://example.com/fake"; },
    (f: ReturnType<typeof fixture>) => { f.data.tagRuns[0]!.head_branch = "v0.4.0"; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /does not match trusted/);
  }
});

test("rerun success does not erase failed candidate evidence", async () => {
  for (const key of ["mainRuns", "tagRuns"] as const) {
    const f = fixture();
    f.data[key][0]!.run_attempt = 2;
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /was rerun/);
  }
});

test("source commit and annotated tag must remain exact and unmoved", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.data.mainRef.object.sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.tagRef.object.type = "commit"; },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.object.sha = "c".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.object.type = "tag"; },
    (f: ReturnType<typeof fixture>) => { f.data.annotation.tag = "v0.1.0"; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyReleaseCi({ ...options, api: f.api }), /not the current pushed main|must be an annotated tag|does not point directly/);
  }
  const f = fixture();
  await assert.rejects(verifyReleaseCi({ ...options, expectedTagObjectSha: "c".repeat(40), api: f.api }), /changed since/);
});

test("ref changes and reruns during evidence retrieval are caught", async () => {
  const moved = fixture();
  await assert.rejects(verifyReleaseCi({ ...options, api: async (endpoint: string) => {
    if (endpoint.endsWith("actions/runs/12")) moved.data.mainRef.object.sha = "c".repeat(40);
    return moved.api(endpoint);
  } }), /not the current pushed main/);
  const retagged = fixture();
  await assert.rejects(verifyReleaseCi({ ...options, api: async (endpoint: string) => {
    if (endpoint.endsWith("actions/runs/12")) {
      retagged.data.tagRef.object.sha = "c".repeat(40);
      retagged.data.annotation.sha = "c".repeat(40);
    }
    return retagged.api(endpoint);
  } }), /changed during CI verification/);
  const rerun = fixture();
  await assert.rejects(verifyReleaseCi({ ...options, api: async (endpoint: string) => {
    if (endpoint.endsWith("actions/runs/11")) rerun.data.mainRuns[0]!.run_attempt = 2;
    return rerun.api(endpoint);
  } }), /was rerun/);
});

test("empty, malformed, incomplete, or duplicate API evidence fails closed", async () => {
  for (const response of [
    { total_count: 0, workflow_runs: [] },
    { total_count: 2, workflow_runs: [] },
    { workflow_runs: [] },
    { total_count: 1, workflow_runs: null },
  ]) {
    const f = fixture();
    await assert.rejects(verifyReleaseCi({ ...options, api: (endpoint: string) => endpoint.includes("/7/runs?") ? Promise.resolve(response) : f.api(endpoint) }), /No pushed|Malformed|Incomplete/);
  }
  const duplicate = fixture();
  duplicate.data.mainRuns.push({ ...duplicate.data.mainRuns[0]! });
  await assert.rejects(verifyReleaseCi({ ...options, api: duplicate.api }), /Duplicate or invalid/);
  const wrongCount = fixture();
  await assert.rejects(verifyReleaseCi({ ...options, api: async (endpoint: string) => {
    const response = await wrongCount.api(endpoint) as Record<string, unknown>;
    if (endpoint.includes("/7/runs?")) response.total_count = 0;
    return response;
  } }), /Malformed GitHub workflow_runs count/);
});

test("CLI rejects noncanonical source repositories and contradictory workflow context before using GitHub", () => {
  const path = fileURLToPath(new URL("../scripts/verify-release-ci.mjs", import.meta.url));
  for (const overrides of [
    { WORKFOLD_SOURCE_RELEASE_REPO: "someone/fork" },
    { GITHUB_REPOSITORY: "someone/fork" },
    { GITHUB_SHA: "c".repeat(40) },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: `refs/tags/${tag}` },
  ]) {
    assert.throws(() => execFileSync(process.execPath, [path, "--tag-check"], {
      env: { ...process.env, WORKFOLD_SOURCE_RELEASE_REPO: "", GITHUB_REPOSITORY: "", GITHUB_SHA: "", GITHUB_ACTIONS: "", ...overrides },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }), /canonical source repository|commit does not match|matching pushed source tag/);
  }
});

test("tag-check CLI succeeds while Actions is unavailable and verifies the package version's tag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-tag-source-"));
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const command = fileURLToPath(new URL("../scripts/verify-release-ci.mjs", import.meta.url));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const packageTag = `v${packageJson.version}`;
    const trace = join(directory, "calls.jsonl");
    const fakeGh = join(directory, "gh");
    await writeFile(fakeGh, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const endpoint = process.argv.find((argument) => argument.startsWith("repos/"));
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(endpoint) + "\\n");
if (!endpoint || endpoint.includes("/actions/")) throw new Error("Actions evidence is unavailable");
const responses = ${JSON.stringify({
      [`repos/${repo}/git/ref/heads/main`]: { ref: "refs/heads/main", object: { type: "commit", sha: head } },
      [`repos/${repo}/git/ref/tags/${packageTag}`]: { ref: `refs/tags/${packageTag}`, object: { type: "tag", sha: tagObjectSha } },
      [`repos/${repo}/git/tags/${tagObjectSha}`]: { sha: tagObjectSha, tag: packageTag, object: { type: "commit", sha: head } },
    })};
if (!responses[endpoint]) throw new Error("Unexpected source request " + endpoint);
console.log(JSON.stringify(responses[endpoint]));
`, "utf8");
    await chmod(fakeGh, 0o755);
    const output = execFileSync(process.execPath, [command, "--tag-check"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`,
        WORKFOLD_SOURCE_RELEASE_REPO: "", GITHUB_REPOSITORY: repo, GITHUB_SHA: head,
        GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: `refs/tags/${packageTag}`,
        GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/release-tag.yml@refs/tags/${packageTag}`,
      },
    });
    assert.deepEqual(JSON.parse(output), { repo, sha: head, tag: packageTag, tagObjectSha });
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((path) => !path.includes("/actions/")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
