import assert from "node:assert/strict";
import test from "node:test";

import { foldDecisionCard } from "../src/local/fold-decision-cards.js";
import type { FoldStagedAct, FoldStagedActFields } from "../src/local/fold-staged-acts.js";

/**
 * The one needs-you card contract (docs/fold-consecrations.md; integration
 * reconciliation 6): host-composed from the typed record, deterministic, and
 * identical for every surface that renders it. Model prose never becomes card
 * copy — there is no field a persuasive paragraph could ride in on.
 */

let counter = 0;

function stagedAct(input: {
  kind: FoldStagedAct["kind"];
  category: FoldStagedAct["category"];
  parameters: FoldStagedActFields;
  pins: FoldStagedActFields;
  overrides?: Partial<FoldStagedAct>;
}): FoldStagedAct {
  counter += 1;
  return {
    schemaVersion: 1,
    id: `act-${counter}`,
    category: input.category,
    kind: input.kind,
    parameters: input.parameters,
    pins: input.pins,
    provenance: { stagedVia: "management-conversation", conversationId: "chat-9", requestId: `req-${counter}` },
    state: "staged",
    createdAt: "2026-08-11T08:00:00.000Z",
    expiresAt: "2026-08-12T08:00:00.000Z",
    ...input.overrides,
  };
}

test("category lines carry the plain-words copy, and make-runnable names its scope", () => {
  const personal = foldDecisionCard(stagedAct({
    kind: "capability.package.install",
    category: "make-runnable",
    parameters: { source: "npm:left-pad", scope: "personal" },
    pins: { packageId: "left-pad", version: "1.3.0", source: "npm:left-pad", scope: "personal", resourceSummary: "1 extension" },
  }));
  assert.equal(personal.categoryLine, "Installs code that can run as you · Personal — loads into the fold's own runtime");
  assert.equal(personal.title, "Install left-pad@1.3.0 from npm:left-pad");
  assert.equal(personal.desktopOnly, true, "Personal-scope make-runnable is desktop-decided");
  assert.equal(personal.secondConfirmation, false);

  const spaceScoped = foldDecisionCard(stagedAct({
    kind: "app.review.approve",
    category: "make-runnable",
    parameters: { spaceId: "space-1", proposalId: "prop-1" },
    pins: { proposalId: "prop-1", reviewDigest: "a".repeat(64) },
  }), { spaceNames: new Map([["space-1", "Client Work"]]) });
  assert.equal(spaceScoped.categoryLine, "Installs code that can run as you · This Space");
  assert.equal(spaceScoped.desktopOnly, false);
  assert.equal(spaceScoped.spaceName, "Client Work");

  const widen = foldDecisionCard(stagedAct({
    kind: "app.grant.network",
    category: "widen-power",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", declarationId: "api.example.com" },
    pins: { appInstanceId: "app-1", declarationId: "api.example.com", releaseDigest: "b".repeat(64) },
  }));
  assert.equal(widen.categoryLine, "Grants a standing power");
  assert.equal(widen.title, 'Grant the network destination "api.example.com" to app-1');

  const destroy = foldDecisionCard(stagedAct({
    kind: "space.delete-folder",
    category: "destroy",
    parameters: { spaceId: "space-2" },
    pins: { spaceId: "space-2", spaceRoot: "/home/person/spaces/old" },
  }));
  assert.equal(destroy.categoryLine, "Deletes something for good");
  assert.equal(destroy.title, "Delete the Space folder /home/person/spaces/old");
  assert.equal(destroy.secondConfirmation, true, "destroy cards demand a second explicit confirmation");
  assert.equal(destroy.spaceName, "space-2 (removed)", "an unregistered Space renders as removed, never as blank");
});

test("facts carry exactly the pinned identities, with digests as short ids and no prose channel", () => {
  const digest = "sha256:" + "c".repeat(64);
  const card = foldDecisionCard(stagedAct({
    kind: "capability.skills.import",
    category: "make-runnable",
    parameters: { source: "/tmp/bundle.zip", scope: "space", spaceId: "space-1" },
    pins: { source: "/tmp/bundle.zip", contentDigest: digest, skillNames: ["alpha", "beta"] },
  }), { spaceNames: new Map([["space-1", "Client Work"]]) });
  assert.equal(card.title, "Import 2 skills");
  const byLabel = new Map(card.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("Source"), "/tmp/bundle.zip");
  assert.equal(byLabel.get("Content digest"), "cccccccccccc…", "digests render as short ids");
  assert.equal(byLabel.get("Skills"), "alpha, beta");
  assert.equal(byLabel.get("Scope"), "This Space");
  assert.equal(byLabel.get("Space"), "Client Work");
  for (const fact of card.facts) {
    assert.equal(typeof fact.label, "string");
    assert.equal(typeof fact.value, "string");
  }
  // The card never says "consecration" — person-facing copy uses plain words.
  assert.doesNotMatch(JSON.stringify([card.categoryLine, card.title, card.facts]), /consecration/i);
});

test("a rootless app.grant.files card carries the desktop-chosen-folder rule as typed state", () => {
  // The staging contract pins the declaration identity but no root, so
  // approval binds to a folder chosen through the main window's picker; the
  // flag lets every surface state that up front instead of discovering the
  // typed refusal at click time. Denial stays available everywhere, so this
  // is deliberately not the desktopOnly rule.
  const files = foldDecisionCard(stagedAct({
    kind: "app.grant.files",
    category: "widen-power",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", declarationId: "workspace-files" },
    pins: { appInstanceId: "app-1", declarationId: "workspace-files", releaseDigest: "b".repeat(64) },
  }));
  assert.equal(files.needsDesktopChosenFolder, true);
  assert.equal(files.desktopOnly, false);

  const network = foldDecisionCard(stagedAct({
    kind: "app.grant.network",
    category: "widen-power",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", declarationId: "api.example.com" },
    pins: { appInstanceId: "app-1", declarationId: "api.example.com", releaseDigest: "b".repeat(64) },
  }));
  assert.equal(network.needsDesktopChosenFolder, false, "only the files grant binds to a person-chosen folder");
});

test("a connection card states that the secret never rides on it", () => {
  const card = foldDecisionCard(stagedAct({
    kind: "app.connection.save",
    category: "widen-power",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", destinationId: "crm" },
    pins: { appInstanceId: "app-1", declarationId: "crm", target: "https://crm.example.com", adapterKind: "http" },
  }));
  assert.equal(card.title, 'Save the "crm" connection for app-1');
  const credential = card.facts.find((fact) => fact.label === "Credential");
  assert.ok(credential);
  assert.match(credential.value, /never carried by this card/);
});

test("single-path destroys and page exposures compose exact titles", () => {
  const files = foldDecisionCard(stagedAct({
    kind: "files.destroy",
    category: "destroy",
    parameters: { spaceId: "space-1", paths: ["notes/secret.txt"] },
    pins: { spaceId: "space-1", paths: ["notes/secret.txt"], contentIdentities: ["d".repeat(64)] },
  }));
  assert.equal(files.title, "Permanently delete notes/secret.txt");
  assert.equal(files.facts.find((fact) => fact.label === "Observed content identities")?.value, "dddddddddddd…");

  const page = foldDecisionCard(stagedAct({
    kind: "publish.viewer.expose",
    category: "widen-power",
    parameters: { exposure: "page", spaceId: "space-1" },
    pins: {
      exposure: "page",
      spaceId: "space-1",
      relativePath: "report.html",
      title: "Quarterly report",
      snapshotEnabled: false,
      byteBudget: 1024,
      serveBudget: 60,
    },
  }));
  assert.equal(page.title, 'Share "Quarterly report" on the web');
  const pageFacts = new Map(page.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(pageFacts.get("Snapshot while asleep"), "no");
  assert.equal(pageFacts.get("Byte budget per day"), "1024");
});

test("provenance, denial memory, and settled outcomes project without invention", () => {
  const base = stagedAct({
    kind: "app.automation.enable",
    category: "widen-power",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", automationId: "daily-report" },
    pins: { appInstanceId: "app-1", automationId: "daily-report", reviewedDigest: "e".repeat(64), scheduleSummary: "daily 09:00" },
    overrides: { priorDenialAt: "2026-08-10T14:10:00.000Z" },
  });
  const pending = foldDecisionCard(base);
  assert.equal(pending.title, 'Enable the automation "daily-report" for app-1');
  assert.equal(pending.provenance.stagedVia, "management-conversation");
  assert.equal(pending.provenance.conversationId, "chat-9", "the card links the transcript that holds the reasoning");
  assert.equal(pending.priorDenialAt, "2026-08-10T14:10:00.000Z", "a restaged act states the prior denial");
  assert.equal(pending.decidedAt, undefined);

  const settled = foldDecisionCard({
    ...base,
    state: "approved",
    settledAt: "2026-08-11T09:00:00.000Z",
    decidedAt: "2026-08-11T09:00:00.000Z",
    decision: { decision: "approved", surface: "main-window" },
    execution: { outcome: "failed", at: "2026-08-11T09:00:01.000Z", errorDetail: "the app changed" },
  });
  assert.equal(settled.state, "approved");
  assert.equal(settled.decision?.surface, "main-window", "the approving surface is part of the record");
  assert.equal(settled.execution?.outcome, "failed");
  assert.equal(settled.execution?.errorDetail, "the app changed");

  const invalidated = foldDecisionCard({
    ...base,
    state: "invalidated",
    settledAt: "2026-08-11T09:00:00.000Z",
    invalidationReason: "The job's reviewed schedule changed after staging.",
  });
  assert.equal(invalidated.invalidationReason, "The job's reviewed schedule changed after staging.");
});

test("the card is deterministic over the typed record", () => {
  const act = stagedAct({
    kind: "routing.enable",
    category: "widen-power",
    parameters: { routingId: "routing-1" },
    pins: { routingId: "routing-1", declarationDigest: "f".repeat(64) },
  });
  assert.deepEqual(foldDecisionCard(act), foldDecisionCard(act));
  assert.equal(foldDecisionCard(act).title, "Enable the routing routing-1");
});

test("routing cards carry the exact host-composed declaration review", () => {
  const act = stagedAct({
    kind: "routing.enable",
    category: "widen-power",
    parameters: { routingId: "routing-1" },
    pins: { routingId: "routing-1", declarationDigest: "f".repeat(64) },
  });
  const routingFacts = new Map([[act.id, [
    { label: "Title", value: "Morning handoff" },
    { label: "Trigger", value: "Once · Sep 1, 2026, 9:00 PM local (2026-09-02T01:00:00.000Z) · Run if missed" },
    { label: "Step 1 · Chat · prepare", value: "Inbox — /Users/person/Inbox\nPrepare the daily handoff." },
  ]] as const]);
  const card = foldDecisionCard(act, { routingFacts });
  assert.deepEqual(card.facts.slice(-3), routingFacts.get(act.id));
  assert.match(card.facts.at(-1)?.value ?? "", /Prepare the daily handoff\./);
});
