import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkFoldCliActArgv } from "../src/local/cli/act-commands.js";
import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { piSkillBundleContentDigest } from "../src/local/agent/skill-import.js";
import { FOLD_POLICY_MATCHER_DESCRIPTORS, type FoldPolicyEligibleKind } from "../src/local/fold-policies.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Standing policies over the running local API (docs/fold-consecrations.md
 * §Standing policies): the renderer-session Settings routes hold the one
 * minted writer, staged-act admission evaluates policies host-side, and an
 * exercised policy rides the same decision path as a click — receipts with
 * `surface: "policy"`, the policy id, and the label snapshot — while the act
 * lane and remote vocabulary have no policy surface at all.
 */

async function withApi(
  run: (context: { api: LocalApiHandle; sandbox: string; stateBase: string }) => Promise<void>,
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-policy-settings-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await run({ api, sandbox, stateBase });
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("the policy Settings routes author, toggle, reattest, and refuse ineligible or open-registry policies", async () => {
  await withApi(async ({ api }) => {
    // The authoring contract is host-composed: eligible kinds only, with the
    // per-kind matcher descriptors the Settings pickers render.
    const initial = await getJson(api.origin, "/api/settings/fold-policies");
    assert.deepEqual(initial.policies, []);
    const status = initial.status as { damaged: boolean; attested: boolean; policyCount: number };
    assert.equal(status.damaged, false);
    assert.equal(status.attested, true);
    const contract = initial.contract as {
      cap: number;
      labelMaxChars: number;
      firstPartyRegistries: string[];
      kinds: Array<{ kind: string; category: string; categoryLabel: string; label: string; fields: Array<{ name: string; required: boolean; values?: string[] }> }>;
    };
    assert.equal(contract.cap, 64);
    assert.equal(contract.firstPartyRegistries.includes("official:anthropics/skills"), true);
    const offeredKinds = contract.kinds.map((item) => item.kind);
    for (const ineligible of ["space.delete-folder", "app.data.purge", "app.storage.clear", "files.destroy", "publish.viewer.expose", "routing.enable"]) {
      assert.equal(offeredKinds.includes(ineligible), false, `${ineligible} must not be offered in Settings`);
    }
    assert.deepEqual([...new Set(contract.kinds.map((item) => item.category))].sort(), ["make-runnable", "widen-power"]);
    const grantKind = contract.kinds.find((item) => item.kind === "app.grant.notifications");
    assert.equal(grantKind?.categoryLabel, "Grants a standing power");
    assert.equal(grantKind?.fields.find((field) => field.name === "appInstanceId")?.required, true);
    // The pickers derive from the store's exported matcher vocabulary: every
    // kind's field names, order, required flags, and value enums match the
    // per-kind descriptors one for one, so what Settings offers can never
    // drift from what the store accepts at write.
    for (const kindDescriptor of contract.kinds) {
      const descriptor = FOLD_POLICY_MATCHER_DESCRIPTORS[kindDescriptor.kind as FoldPolicyEligibleKind];
      assert.ok(descriptor, `${kindDescriptor.kind} must carry an exported matcher descriptor`);
      assert.deepEqual(
        kindDescriptor.fields.map((field) => ({
          name: field.name,
          required: field.required,
          ...(field.values !== undefined ? { values: field.values } : {}),
        })),
        Object.entries(descriptor.fields).map(([name, spec]) => ({
          name,
          required: spec.required,
          ...(spec.values !== undefined ? { values: [...spec.values] } : {}),
        })),
        `${kindDescriptor.kind} matcher fields must mirror the exported descriptor`,
      );
      for (const field of kindDescriptor.fields) {
        assert.equal(typeof field.name === "string" && field.name.length > 0, true);
      }
    }

    // Author, edit, toggle, delete — each answers with the fresh store status.
    const created = await postJson(api.origin, "/api/settings/fold-policies", {
      label: "Notify grants for the dashboard app",
      kind: "app.grant.notifications",
      match: { appInstanceId: "app-dash", spaceId: "" },
    });
    assert.equal(created.status, 201);
    const policy = (created.body as { policy: { id: string; enabled: boolean; match: Record<string, string> } }).policy;
    assert.equal(policy.enabled, true);
    // Blank optional matcher fields are omitted, not stored as empty strings.
    assert.deepEqual(policy.match, { appInstanceId: "app-dash" });

    const renamed = await fetch(new URL(`/api/settings/fold-policies/${policy.id}`, api.origin), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Dashboard notification grants" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json() as { policy: { label: string } }).policy).label, "Dashboard notification grants");

    const disabled = await postJson(api.origin, `/api/settings/fold-policies/${policy.id}/disable`, {});
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body as { policy: { enabled: boolean } }).policy.enabled, false);
    assert.equal((disabled.body as { status: { enabledCount: number } }).status.enabledCount, 0);
    const enabled = await postJson(api.origin, `/api/settings/fold-policies/${policy.id}/enable`, {});
    assert.equal((enabled.body as { policy: { enabled: boolean } }).policy.enabled, true);

    // The closed vocabulary refuses at write: ineligible kinds and
    // open-registry make-runnable matchers never become records.
    const destroyRefused = await postJson(api.origin, "/api/settings/fold-policies", {
      label: "Never",
      kind: "space.delete-folder",
      match: {},
    });
    assert.equal(destroyRefused.status, 400);
    assert.equal((destroyRefused.body as { code?: string }).code, "KIND_INELIGIBLE");
    const openRegistryRefused = await postJson(api.origin, "/api/settings/fold-policies", {
      label: "Anything from npm",
      kind: "capability.package.install",
      match: { source: "npm:left-pad" },
    });
    assert.equal(openRegistryRefused.status, 400);
    assert.equal((openRegistryRefused.body as { code?: string }).code, "OPEN_REGISTRY");

    assert.equal((await postJson(api.origin, "/api/settings/fold-policies/missing/enable", {})).status, 404);
    const reattested = await postJson(api.origin, "/api/settings/fold-policies/reattest", {});
    assert.equal(reattested.status, 200);
    assert.equal((reattested.body as { status: { attested: boolean } }).status.attested, true);

    const removed = await fetch(new URL(`/api/settings/fold-policies/${policy.id}`, api.origin), { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual((await getJson(api.origin, "/api/settings/fold-policies")).policies, []);

    // Policy authoring is never-list entry 4: no act-facade method, no act
    // CLI verb, and no remote operation touches the policy store. The store
    // rides the handle for reads; every mutation demands the Settings writer
    // the routes hold.
    assert.equal(Object.keys(api.actFacade).some((name) => /polic/i.test(name)), false);
    assert.throws(() => parseWorkFoldCliActArgv(["policies", "list"]));
    assert.throws(() => parseWorkFoldCliActArgv(["settings", "fold-policies"]));
    await assert.rejects(
      api.foldPolicies.createPolicy(
        { lane: "desktop-settings" },
        { label: "Forged writer", kind: "app.grant.notifications", match: { appInstanceId: "app-dash" } },
      ),
      /authored only in Settings/,
      "a plain object with the writer's shape must be refused",
    );
  });
});

test("a matching standing policy auto-approves at staging with policy-surface receipts, and mismatches fall back to cards", async () => {
  await withApi(async ({ api, sandbox, stateBase }) => {
    const space = await api.actFacade.createSpace({ name: "Policy Space" });
    const bundles = join(sandbox, "bundles");
    const bundlePath = join(bundles, "SKILL.md");
    const bytes = "---\nname: policy-helper\ndescription: Helps under a standing policy\n---\n\nHelp carefully.\n";
    await mkdir(bundles, { recursive: true });
    await writeFile(bundlePath, bytes, "utf8");
    const digest = piSkillBundleContentDigest(new TextEncoder().encode(bytes));

    // Person-authored in Settings: pin the exact reviewed bytes (the
    // recommended per-item identity shape for anything beyond the curated
    // marketplace).
    const created = await postJson(api.origin, "/api/settings/fold-policies", {
      label: "Reviewed helper bundle",
      kind: "capability.skills.import",
      match: { contentDigest: digest, scope: "space" },
    });
    assert.equal(created.status, 201);
    const policyId = (created.body as { policy: { id: string } }).policy.id;

    // Staging evaluates host-side and short-circuits through the same
    // decision path as a click: no card, executed import, honest response.
    const staged = await api.actFacade.toolsImportSkill({
      scope: "space",
      space: space.space.id,
      from: bundlePath,
      cwd: sandbox,
    });
    assert.equal(staged.staged.state, "approved");
    assert.equal(staged.staged.deduplicated, false);
    assert.equal(staged.staged.autoApproval?.policyId, policyId);
    assert.equal(staged.staged.autoApproval?.policyLabel, "Reviewed helper bundle");
    assert.equal(staged.staged.autoApproval?.executionOutcome, "executed");
    assert.equal(staged.staged.autoApproval?.receipted, true);
    assert.equal(
      existsSync(join(space.space.spaceRoot, ".pi", "skills")),
      true,
      "the approved import really lands in the Space's Pi skills",
    );
    assert.deepEqual(
      (await getJson(api.origin, "/api/management/decisions")).decisions,
      [],
      "an exercised policy leaves no needs-you card",
    );

    // The exercised receipts contain everything a clicked decision's receipts
    // contain, with surface "policy", the policy id, and the label snapshot.
    const receiptsProbe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const journal = (await readFile(receiptsProbe.path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const decisionReceipts = journal.filter((entry) => entry.command === "decision.approve");
    assert.deepEqual(decisionReceipts.map((entry) => entry.outcome), ["accepted", "ok"]);
    for (const entry of decisionReceipts) {
      assert.equal(entry.surface, "policy");
      assert.equal(entry.policyId, policyId);
      assert.equal(entry.decisionId, staged.staged.decisionId);
      assert.match(String(entry.detail), /auto-approved by standing policy "Reviewed helper bundle"/);
    }

    // After-the-fact visibility: the glance lists the policy-store change and
    // the policy-approved act distinctly from clicked approvals.
    const glance = await api.kernel.getGlance({ kind: "renderer" });
    const changeHeadlines = glance.changes.map((item) => item.headline);
    assert.equal(
      changeHeadlines.some((headline) => headline.includes('Standing policy "Reviewed helper bundle" created')),
      true,
      "policy-store changes reach the glance's change list",
    );
    assert.equal(
      changeHeadlines.some((headline) => headline.startsWith("Auto-approved by standing policy:")),
      true,
      "policy-approved acts are listed distinctly",
    );
    const policyChangeItem = glance.changes.find((item) => item.kind === "policy-changed");
    assert.equal(policyChangeItem?.ref?.policyId, policyId);

    // Different bytes do not match the pinned digest: the act stays staged
    // and waits on a person, exactly as if no policy existed.
    const otherPath = join(bundles, "other", "SKILL.md");
    await mkdir(join(bundles, "other"), { recursive: true });
    await writeFile(otherPath, "---\nname: other-helper\ndescription: Different bytes\n---\n\nOther.\n", "utf8");
    const pending = await api.actFacade.toolsImportSkill({
      scope: "space",
      space: space.space.id,
      from: otherPath,
      cwd: sandbox,
    });
    assert.equal(pending.staged.state, "staged");
    assert.equal(pending.staged.autoApproval, undefined);
    const cards = (await getJson(api.origin, "/api/management/decisions")).decisions as Array<{ id: string }>;
    assert.deepEqual(cards.map((card) => card.id), [pending.staged.decisionId]);

    // A policy authored after an act was staged does not reach the waiting
    // card: the deduplicated restaging returns the existing card undecided.
    const otherBytes = await readFile(otherPath, "utf8");
    const otherDigest = piSkillBundleContentDigest(new TextEncoder().encode(otherBytes));
    const latePolicy = await postJson(api.origin, "/api/settings/fold-policies", {
      label: "Late other-helper policy",
      kind: "capability.skills.import",
      match: { contentDigest: otherDigest },
    });
    assert.equal(latePolicy.status, 201);
    const deduplicated = await api.actFacade.toolsImportSkill({
      scope: "space",
      space: space.space.id,
      from: otherPath,
      cwd: sandbox,
    });
    assert.equal(deduplicated.staged.deduplicated, true);
    assert.equal(deduplicated.staged.state, "staged");
    assert.equal(deduplicated.staged.autoApproval, undefined, "policies bind future staged acts, never a waiting card");

    // A disabled policy is not exercised: cancel the pending card, disable
    // the late policy, and the same bytes stage a fresh pending card.
    await postJson(api.origin, `/api/management/decisions/${pending.staged.decisionId}/cancel`, {});
    const latePolicyId = (latePolicy.body as { policy: { id: string } }).policy.id;
    await postJson(api.origin, `/api/settings/fold-policies/${latePolicyId}/disable`, {});
    const disabledOutcome = await api.actFacade.toolsImportSkill({
      scope: "space",
      space: space.space.id,
      from: otherPath,
      cwd: sandbox,
    });
    assert.equal(disabledOutcome.staged.state, "staged");
    assert.equal(disabledOutcome.staged.autoApproval, undefined);
  });
});

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} must answer 200`);
  return await response.json() as Record<string, unknown>;
}

async function postJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
