import assert from "node:assert/strict";
import test from "node:test";

import {
  appPlatformIdPrefixes,
  authorityStampFields,
  authorityStampMatchesProjection,
  authorityStampsEqual,
  advanceAuthorityStamp,
  canonicalizeJson,
  computeDeclarationDigest,
  copyAuthorityStamp,
  createAuthorityStamp,
  createCloudProjectId,
  createDataNamespaceId,
  createFeatureInstallationId,
  createPrincipalId,
  createProjectId,
  createRuntimeError,
  createRuntimeInstanceId,
  createTenantId,
  parseAuthorityStamp,
  parseAuthorityStampProjection,
  parseCloudProjectId,
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseProjectId,
  parseRuntimeInstanceContext,
  parseRuntimeInstanceId,
  parseTenantId,
  principalKinds,
  projectAuthorityStamp,
  runtimeErrorCategories,
  runtimeErrorCodes,
  type AuthorityStamp,
} from "../src/local/agent/app-platform-contract.js";

const idContracts = [
  ["projectId", appPlatformIdPrefixes.projectId, parseProjectId, createProjectId],
  ["cloudProjectId", appPlatformIdPrefixes.cloudProjectId, parseCloudProjectId, createCloudProjectId],
  ["runtimeInstanceId", appPlatformIdPrefixes.runtimeInstanceId, parseRuntimeInstanceId, createRuntimeInstanceId],
  ["featureInstallationId", appPlatformIdPrefixes.featureInstallationId, parseFeatureInstallationId, createFeatureInstallationId],
  ["dataNamespaceId", appPlatformIdPrefixes.dataNamespaceId, parseDataNamespaceId, createDataNamespaceId],
  ["tenantId", appPlatformIdPrefixes.tenantId, parseTenantId, createTenantId],
  ["principalId", appPlatformIdPrefixes.principalId, parsePrincipalId, createPrincipalId],
] as const;

test("opaque App-platform ids use distinct strict prefixes and generated values", () => {
  const generated = new Set<string>();
  for (const [label, prefix, parse, create] of idContracts) {
    const fixture = `${prefix}opaque-01`;
    assert.equal(parse(fixture), fixture, label);
    const first = create();
    const second = create();
    assert.match(first, new RegExp(`^${escapeRegExp(prefix)}[a-z0-9-]+$`));
    assert.doesNotThrow(() => parse(first));
    assert.notEqual(first, second);
    generated.add(first);

    for (const invalid of [
      null,
      1,
      "",
      prefix,
      `${prefix}Uppercase`,
      `${prefix}trailing-`,
      `${prefix}not_allowed`,
      `${prefix}${"a".repeat(129)}`,
      `wrong_${fixture}`,
    ]) {
      assert.throws(() => parse(invalid), new RegExp(label));
    }
  }
  assert.equal(generated.size, idContracts.length);
  assert.throws(() => parseTenantId(`${appPlatformIdPrefixes.projectId}opaque`), /tenantId/);
});

test("AuthorityStamp requires exactly seven independently typed fields and no scalar shortcut", () => {
  assert.deepEqual(authorityStampFields, [
    "runtimeInstanceGeneration",
    "featureInstallationGeneration",
    "grantGeneration",
    "connectionGeneration",
    "jobGeneration",
    "principalGeneration",
    "dataGeneration",
  ]);
  const parsed = parseAuthorityStamp(authorityFixture());
  assert.equal(Object.keys(parsed).length, 7);
  assert.ok(Object.isFrozen(parsed));

  for (const invalid of [
    "7",
    7,
    { authorityGeneration: "7" },
    { ...authorityFixture(), extraGeneration: "8" },
    withoutField(authorityFixture(), "dataGeneration"),
    { ...authorityFixture(), grantGeneration: 2 },
    { ...authorityFixture(), grantGeneration: "" },
    { ...authorityFixture(), grantGeneration: "contains work-folder" },
  ]) {
    assert.throws(() => parseAuthorityStamp(invalid), /AuthorityStamp|Generation|generation/);
  }
});

test("AuthorityStamp copy, equality, and projection preserve named domains only", () => {
  const source = authorityFixture();
  const parsed = parseAuthorityStamp(source);
  source.grantGeneration = "changed-after-parse";
  assert.equal(parsed.grantGeneration, "grant-3");

  const copied = copyAuthorityStamp(parsed);
  assert.notEqual(copied, parsed);
  assert.deepEqual(copied, parsed);
  assert.ok(authorityStampsEqual(parsed, copied));
  assert.equal(authorityStampsEqual(parsed, parseAuthorityStamp({ ...authorityFixture(), dataGeneration: "data-99" })), false);

  const projection = projectAuthorityStamp(parsed, ["grantGeneration", "dataGeneration"]);
  assert.deepEqual(projection, { grantGeneration: "grant-3", dataGeneration: "data-7" });
  assert.ok(Object.isFrozen(projection));
  assert.ok(authorityStampMatchesProjection(parsed, projection));
  assert.equal(authorityStampMatchesProjection(parsed, { grantGeneration: "other" } as never), false);
  assert.deepEqual(parseAuthorityStampProjection({ principalGeneration: "principal-6" }), {
    principalGeneration: "principal-6",
  });

  assert.throws(() => projectAuthorityStamp(parsed, []), /at least one/);
  assert.throws(
    () => projectAuthorityStamp(parsed, ["grantGeneration", "grantGeneration"]),
    /duplicated/,
  );
  assert.throws(() => projectAuthorityStamp(parsed, ["authorityGeneration"] as never), /Unknown/);
  assert.throws(() => parseAuthorityStampProjection("grant-3"), /object/);
  assert.throws(() => parseAuthorityStampProjection({}), /at least one/);
  assert.throws(() => parseAuthorityStampProjection({ authorityGeneration: "3" }), /Unknown/);
});

test("AuthorityStamp creation and advancement replace only named fencing domains", () => {
  const created = createAuthorityStamp();
  assert.equal(Object.keys(created).length, authorityStampFields.length);
  assert.ok(Object.isFrozen(created));
  const advanced = advanceAuthorityStamp(created, ["grantGeneration", "connectionGeneration"]);
  assert.notEqual(advanced.grantGeneration, created.grantGeneration);
  assert.notEqual(advanced.connectionGeneration, created.connectionGeneration);
  for (const field of authorityStampFields) {
    if (field === "grantGeneration" || field === "connectionGeneration") continue;
    assert.equal(advanced[field], created[field], `${field} must remain stable`);
  }
  assert.throws(() => advanceAuthorityStamp(created, []), /at least one/);
  assert.throws(() => advanceAuthorityStamp(created, ["jobGeneration", "jobGeneration"]), /duplicated/);
});

test("RuntimeInstanceContext is a strict release-less development or release-backed app union", () => {
  const runtimeInstanceId = `${appPlatformIdPrefixes.runtimeInstanceId}fixture`;
  const projectId = `${appPlatformIdPrefixes.projectId}fixture`;
  const releaseDigest = `sha256:${"a".repeat(64)}`;

  const development = parseRuntimeInstanceContext({
    kind: "development",
    runtimeInstanceId,
    workFolderId: "work-folder-123",
    projectId,
  });
  assert.deepEqual(development, {
    kind: "development",
    runtimeInstanceId,
    workFolderId: "work-folder-123",
    projectId,
  });
  assert.equal("releaseDigest" in development, false);

  for (const host of ["local", "hosted"] as const) {
    const app = parseRuntimeInstanceContext({ kind: "app", runtimeInstanceId, host, releaseDigest });
    assert.equal(app.kind, "app");
    assert.equal(app.host, host);
    assert.equal(app.releaseDigest, releaseDigest);
    assert.equal("projectId" in app, false);
  }

  for (const invalid of [
    { kind: "development", runtimeInstanceId, workFolderId: "work-folder-123", projectId, releaseDigest },
    { kind: "development", runtimeInstanceId, projectId },
    { kind: "app", runtimeInstanceId, host: "desktop", releaseDigest },
    { kind: "app", runtimeInstanceId, host: "local" },
    { kind: "app", runtimeInstanceId, host: "local", releaseDigest: "sha256:short" },
    { kind: "app", runtimeInstanceId, host: "local", releaseDigest: `sha256:${"A".repeat(64)}` },
    { kind: "other", runtimeInstanceId },
  ]) {
    assert.throws(() => parseRuntimeInstanceContext(invalid), /RuntimeInstanceContext|releaseDigest|host|kind/);
  }
});

test("Principal and runtime error vocabularies remain closed and stable", () => {
  assert.deepEqual(principalKinds, ["human", "agent", "service", "system"]);
  assert.equal(new Set(runtimeErrorCategories).size, runtimeErrorCategories.length);
  assert.equal(new Set(runtimeErrorCodes).size, runtimeErrorCodes.length);
  const error = createRuntimeError("AUTHORITY_EXPIRED", "Reconnect to refresh authority.", {
    retryable: true,
    retryAfterMs: 1_000,
    receiptId: "receipt-1",
  });
  assert.deepEqual(error, {
    code: "AUTHORITY_EXPIRED",
    category: "stale-authority",
    message: "Reconnect to refresh authority.",
    retryable: true,
    retryAfterMs: 1_000,
    receiptId: "receipt-1",
  });
  assert.ok(Object.isFrozen(error));
  assert.throws(
    () => createRuntimeError("TIMEOUT", "Timed out.", { retryable: true, retryAfterMs: -1 }),
    /non-negative/,
  );
});

test("canonical JSON follows RFC 8785 number formatting and recursive ordering", () => {
  assert.equal(
    canonicalizeJson({
      numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001, -0],
      literals: [null, true, false],
      nested: { z: 1, a: [{ d: 4, c: 3 }] },
    }),
    "{\"literals\":[null,true,false],\"nested\":{\"a\":[{\"c\":3,\"d\":4}],\"z\":1},\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}",
  );
  assert.equal(canonicalizeJson("\u000f\n\"\\"), "\"\\u000f\\n\\\"\\\\\"");
});

test("canonical property ordering compares raw UTF-16 code units", () => {
  const values = new Map<string, string>([
    ["€", "Euro Sign"],
    ["\r", "Carriage Return"],
    ["דּ", "Hebrew Letter Dalet With Dagesh"],
    ["1", "One"],
    ["😀", "Emoji: Grinning Face"],
    ["\u0080", "Control"],
    ["ö", "Latin Small Letter O With Diaeresis"],
  ]);
  const canonical = canonicalizeJson(Object.fromEntries(values));
  assertAppearsInOrder(canonical, ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);

  const utf16Order = canonicalizeJson({ "\ue000": "private-use", "😀": "astral" });
  assert.deepEqual(Object.keys(JSON.parse(utf16Order)), ["😀", "\ue000"]);
});

test("canonical JSON preserves Unicode normalization form and accepts valid astral pairs", () => {
  const composed = "é";
  const decomposed = "e\u0301";
  assert.notEqual(canonicalizeJson(composed), canonicalizeJson(decomposed));
  assert.notEqual(computeDeclarationDigest(composed), computeDeclarationDigest(decomposed));
  assert.deepEqual(Object.keys(JSON.parse(canonicalizeJson({ [composed]: 1, [decomposed]: 2 }))), [
    decomposed,
    composed,
  ]);
  assert.equal(canonicalizeJson("😀"), "\"😀\"");
  assert.equal(canonicalizeJson({ "😀": "ok" }), "{\"😀\":\"ok\"}");
});

test("canonical JSON rejects lone surrogates and every non-I-JSON runtime shape", () => {
  for (const invalid of ["\ud800", "\udc00", `valid then ${"\ud800"}`]) {
    assert.throws(() => canonicalizeJson(invalid), /lone Unicode surrogate/);
  }
  assert.throws(() => canonicalizeJson({ ["\ud800"]: "bad key" }), /lone Unicode surrogate/);
  assert.throws(() => canonicalizeJson({ value: "\udc00" }), /lone Unicode surrogate/);

  const hole = new Array(1);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
  const symbolProperty = { value: 1 } as Record<PropertyKey, unknown>;
  symbolProperty[Symbol("hidden")] = 2;

  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    1n,
    Symbol("value"),
    () => true,
    { value: undefined },
    [undefined],
    hole,
    new Date(0),
    new Map(),
    accessor,
    hidden,
    symbolProperty,
    cyclic,
  ]) {
    assert.throws(() => canonicalizeJson(invalid), /non-finite|unsupported|array hole|cyclic/);
  }
});

test("declaration digests hash the canonical UTF-8 bytes", () => {
  assert.equal(canonicalizeJson({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");
  assert.equal(
    computeDeclarationDigest({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
  assert.equal(computeDeclarationDigest({ a: 1, b: 2 }), computeDeclarationDigest({ b: 2, a: 1 }));
});

function authorityFixture(): Record<string, unknown> & {
  runtimeInstanceGeneration: string;
  featureInstallationGeneration: string;
  grantGeneration: string;
  connectionGeneration: string;
  jobGeneration: string;
  principalGeneration: string;
  dataGeneration: string;
} {
  return {
    runtimeInstanceGeneration: "runtime-1",
    featureInstallationGeneration: "installation-2",
    grantGeneration: "grant-3",
    connectionGeneration: "connection-4",
    jobGeneration: "job-5",
    principalGeneration: "principal-6",
    dataGeneration: "data-7",
  };
}

function withoutField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertAppearsInOrder(canonical: string, keys: string[]): void {
  let prior = -1;
  for (const key of keys) {
    const position = canonical.indexOf(JSON.stringify(key));
    assert.ok(position > prior, `${JSON.stringify(key)} must follow the previous canonical key`);
    prior = position;
  }
}

// Compile-time check: a parsed stamp is assignable to the public exact shape.
const _authorityStampTypeCheck: AuthorityStamp = parseAuthorityStamp(authorityFixture());
void _authorityStampTypeCheck;
