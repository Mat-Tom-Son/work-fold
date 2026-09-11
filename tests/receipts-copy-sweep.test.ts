import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = async (relativePath: string) => await readFile(join(repositoryRoot, relativePath), "utf8");

/**
 * docs/receipts-not-gates.md acceptance, last bullet: no user-facing copy
 * contains "staged", "approve", "policy", "Reviewed", or "Unrestricted"
 * outside history notes. This sweep pins the surfaces that speak to a person:
 * the public documents, the fold's materialized instructions, the desktop's
 * copy contract, and the remote client's shipped modules.
 *
 * "Reviewed" and "Unrestricted" are matched case-sensitively because they are
 * the retired authority-setting names; an ordinary sentence about a person
 * reviewing something is still allowed. Protocol identifiers that legitimately
 * survive — the pairing certificate fields and the stored grant status — are
 * neutralized by exact token so a newly written person-facing "approve" cannot
 * hide behind them. Browser app actions run on request, so no approve
 * operation survives there.
 */
const retiredGateWords = /\bstaged\b|\bstaging\b|\bapprove[sd]?\b|\bapproval\b|\bapprovals\b|\bapproving\b|\bpolic(y|ies)\b|\bconsecrat/i;
const retiredAuthorityNames = /\bReviewed\b|\bUnrestricted\b|authority mode|decision card|needs-you card/;

const surviving: Array<[string, string]> = [
  ["approvalCertificate", "pairingRecord"],
  ["approvalSignature", "pairingSignature"],
  ["acceptApproval", "acceptPairing"],
  ['"approved"', '"paired"'],
];

function speakableSource(text: string): string {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return surviving.reduce((value, [identifier, stand]) => value.replaceAll(identifier, stand), withoutComments);
}

test("public documents promise receipts and undo instead of gates", async () => {
  for (const document of ["README.md", "SECURITY.md", "PRIVACY.md", "CONTRIBUTING.md"]) {
    const text = await read(document);
    assert.doesNotMatch(text, retiredGateWords, `${document} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${document} still names a retired authority setting`);
  }

  // The promises the rewrite has to make, not just the words it drops.
  const readme = await read("README.md");
  assert.match(readme, /leaves a record you can read in the app/);
  assert.match(readme, /\*\*Recently deleted\*\* for 30 days/);

  const security = await read("SECURITY.md");
  assert.match(security, /\*\*Receipts, not gates\.\*\*/);
  assert.match(security, /Destruction is reversible\./);
  assert.match(security, /`work-fold trash list\|restore`/);
  assert.match(security, /The only human-only surfaces establish identity or secrets/);

  const privacy = await read("PRIVACY.md");
  assert.match(privacy, /Recently deleted items under the application-data `trash\/` directory/);
  assert.match(privacy, /runs at once and leaves a receipt; nothing waits for a further click/);
});

test("shared Skills and the fold's materialized instructions stay gate-free", async () => {
  for (const skill of [".agents/skills/ship-macos-release/SKILL.md"]) {
    const text = await read(skill);
    assert.doesNotMatch(text, retiredGateWords, `${skill} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${skill} still names a retired authority setting`);
  }

  // Both materialized resources live in this one module.
  const instructions = speakableSource(await read("src/local/management-instructions.ts"));
  assert.doesNotMatch(instructions, retiredGateWords);
  assert.doesNotMatch(instructions, retiredAuthorityNames);
  assert.match(instructions, /## Receipts, not gates/);
});

test("the desktop copy contract and the remote client never say approve or staged", async () => {
  for (const source of [
    "web-local/src/ui-contract.ts",
    "services/bridge/public/app.js",
    "services/bridge/public/landing.js",
    "services/bridge/public/browser-app-actions.js",
    "services/bridge/public/request-results.js",
    "services/bridge/public/fixtures.js",
  ]) {
    const text = speakableSource(await read(source));
    assert.doesNotMatch(text, retiredGateWords, `${source} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${source} still names a retired authority setting`);
  }

  // Pairing copy names identity, not permission to work.
  const client = await read("services/bridge/public/app.js");
  assert.ok(client.includes('eyebrow: "Confirm this browser once"'));
  assert.ok(client.includes("Once paired, this browser stays signed in until you remove it."));
  assert.ok(client.includes('throw new Error("This browser is not paired.");'));
});
