import assert from "node:assert/strict";
import test from "node:test";

import {
  AppPlatformArtifactError,
  hashAppPlatformArtifact,
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactEntry,
  type AppPlatformArtifactErrorCode,
} from "../src/local/agent/app-platform-artifact.js";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

test("work-fold.artifact.v1 has stable tagged conformance digests independent of insertion order", () => {
  const fixture: readonly AppPlatformArtifactEntry[] = [
    { path: "index.html", bytes: bytes("<h1>Hello</h1>\n") },
    { path: "assets/app.js", bytes: bytes("console.log(\"hi\");\n") },
  ];
  const expected = "work-fold.artifact.v1:sha256:abf7504b40145dc6ca30ac893911e646897003659364e6c5c49eb89c34d6380e";

  assert.equal(hashAppPlatformArtifact(fixture), expected);
  assert.equal(hashAppPlatformArtifact([...fixture].reverse()), expected);
  assert.equal(
    hashAppPlatformArtifact([]),
    "work-fold.artifact.v1:sha256:1291c5cf7b2b906880bd9233a7f6e93d193ebdb4946f2656ee626c87f168e348",
  );
  assert.equal(parseAppPlatformArtifactDigest(expected), expected);
  assertArtifactError(() => parseAppPlatformArtifactDigest(expected.toUpperCase()), "ARTIFACT_INVALID");
  assertArtifactError(() => parseAppPlatformArtifactDigest("sha256:" + "0".repeat(64)), "ARTIFACT_INVALID");
});

test("length framing resists path/content prefix ambiguity", () => {
  const sameUnframedBytesA = hashAppPlatformArtifact([{ path: "a", bytes: bytes("bc") }]);
  const sameUnframedBytesB = hashAppPlatformArtifact([{ path: "ab", bytes: bytes("c") }]);
  const differentRecordCount = hashAppPlatformArtifact([
    { path: "a", bytes: bytes("b") },
    { path: "c", bytes: new Uint8Array() },
  ]);

  assert.notEqual(sameUnframedBytesA, sameUnframedBytesB);
  assert.notEqual(sameUnframedBytesA, differentRecordCount);
  assert.notEqual(sameUnframedBytesB, differentRecordCount);
});

test("Unicode artifact paths use stable bytewise UTF-8 ordering", () => {
  const fixture: readonly AppPlatformArtifactEntry[] = [
    { path: "z.txt", bytes: bytes("z") },
    { path: "é.txt", bytes: bytes("accent") },
    { path: "😀.txt", bytes: bytes("emoji") },
  ];
  const expected = "work-fold.artifact.v1:sha256:deb86ae019af8fa4d4fffcda6e575fb1c7843a8caefdce1adef8c79098f00108";

  assert.equal(hashAppPlatformArtifact(fixture), expected);
  assert.equal(hashAppPlatformArtifact([fixture[2]!, fixture[0]!, fixture[1]!]), expected);
  assert.match(hashAppPlatformArtifact([{ path: "emoji-😀.txt", bytes: bytes("valid scalar") }]), digestPattern());
});

test("paths must already be NFC and duplicate normalized paths are rejected", () => {
  const composed = "café.txt";
  const decomposed = "cafe\u0301.txt";
  assert.equal(decomposed.normalize("NFC"), composed);
  assert.match(hashAppPlatformArtifact([{ path: composed, bytes: bytes("ok") }]), digestPattern());

  assertArtifactError(
    () => hashAppPlatformArtifact([{ path: decomposed, bytes: bytes("not canonical") }]),
    "ARTIFACT_PATH_INVALID",
    /already be NFC/,
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([
      { path: composed, bytes: bytes("one") },
      { path: decomposed, bytes: bytes("two") },
    ]),
    "ARTIFACT_PATH_INVALID",
    /already be NFC/,
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([
      { path: composed, bytes: bytes("one") },
      { path: composed, bytes: bytes("two") },
    ]),
    "ARTIFACT_PATH_DUPLICATE",
    /duplicated/,
  );
});

test("case-distinct logical paths are intentionally distinct", () => {
  const fixture = [
    { path: "A.txt", bytes: bytes("upper") },
    { path: "a.txt", bytes: bytes("lower") },
  ];
  const expected = "work-fold.artifact.v1:sha256:a3f3d65cc35bc8a59684f53d4028230de58122e0990ccdcf3d0690b7620dd9d6";

  assert.equal(hashAppPlatformArtifact(fixture), expected);
  assert.equal(hashAppPlatformArtifact([...fixture].reverse()), expected);
  assert.notEqual(
    hashAppPlatformArtifact([{ path: "A.txt", bytes: bytes("upper") }]),
    hashAppPlatformArtifact([{ path: "a.txt", bytes: bytes("upper") }]),
  );
});

test("portable artifact paths reject unsafe and ambiguous forms", () => {
  const invalidPaths = [
    "",
    ".",
    "..",
    "/absolute",
    "C:/drive",
    "dir\\file",
    "dir//file",
    "dir/./file",
    "dir/../file",
    "dir/",
    "a:b",
    "a?b",
    "a*b",
    "a|b",
    "a<b",
    "a>b",
    "a\"b",
    "line\nbreak",
    "nul\0byte",
    "CON",
    "con.txt",
    "dir/NUL.json",
    "COM1.bin",
    "LPT9",
    "trailing.",
    "trailing ",
    "lone-high-\ud800.txt",
    "lone-low-\udc00.txt",
  ];

  for (const path of invalidPaths) {
    assertArtifactError(
      () => hashAppPlatformArtifact([{ path, bytes: new Uint8Array() }]),
      "ARTIFACT_PATH_INVALID",
    );
  }
});

test("file count, UTF-8 path, file size, and total size limits fail closed", () => {
  assertArtifactError(
    () => hashAppPlatformArtifact([
      { path: "one", bytes: new Uint8Array() },
      { path: "two", bytes: new Uint8Array() },
    ], { files: 1 }),
    "ARTIFACT_LIMIT_EXCEEDED",
    /more than 1 files/,
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([{ path: "é.txt", bytes: new Uint8Array() }], { pathBytes: 5 }),
    "ARTIFACT_LIMIT_EXCEEDED",
    /UTF-8 limit/,
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([{ path: "file", bytes: new Uint8Array(2) }], { fileBytes: 1 }),
    "ARTIFACT_LIMIT_EXCEEDED",
    /per-file limit/,
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([
      { path: "one", bytes: new Uint8Array(1) },
      { path: "two", bytes: new Uint8Array(1) },
    ], { totalBytes: 1 }),
    "ARTIFACT_LIMIT_EXCEEDED",
    /total limit/,
  );
  assert.match(hashAppPlatformArtifact([], { files: 0, fileBytes: 0, totalBytes: 0 }), digestPattern());
});

test("invalid entries and limit options are rejected", () => {
  assertArtifactError(
    () => hashAppPlatformArtifact([{ path: "file", bytes: "not bytes" as unknown as Uint8Array }]),
    "ARTIFACT_INVALID",
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([] as AppPlatformArtifactEntry[], { files: -1 }),
    "ARTIFACT_INVALID",
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([] as AppPlatformArtifactEntry[], { pathBytes: 0 }),
    "ARTIFACT_INVALID",
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([] as AppPlatformArtifactEntry[], { totalBytes: 1.5 }),
    "ARTIFACT_INVALID",
  );
  assertArtifactError(
    () => hashAppPlatformArtifact([], { unknown: true } as unknown as Parameters<typeof hashAppPlatformArtifact>[1]),
    "ARTIFACT_INVALID",
  );
});

test("a one-byte content mutation changes the artifact digest", () => {
  const content = new Uint8Array([0, 1, 2, 3]);
  const before = hashAppPlatformArtifact([{ path: "payload.bin", bytes: content }]);
  content[2] = 3;
  const after = hashAppPlatformArtifact([{ path: "payload.bin", bytes: content }]);

  assert.notEqual(before, after);
});

test("one-shot iterable input is consumed once and hashes like an array", () => {
  const fixture = [
    { path: "second", bytes: bytes("2") },
    { path: "first", bytes: bytes("1") },
  ];
  let iterations = 0;
  const iterable: Iterable<AppPlatformArtifactEntry> = {
    *[Symbol.iterator]() {
      iterations += 1;
      assert.equal(iterations, 1, "artifact iterable must not be restarted");
      yield* fixture;
    },
  };

  assert.equal(hashAppPlatformArtifact(iterable), hashAppPlatformArtifact(fixture));
  assert.equal(iterations, 1);
});

function assertArtifactError(
  operation: () => unknown,
  code: AppPlatformArtifactErrorCode,
  message?: RegExp,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof AppPlatformArtifactError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function digestPattern(): RegExp {
  return /^work-fold.artifact.v1:sha256:[0-9a-f]{64}$/;
}
