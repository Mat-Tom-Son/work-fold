import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const fixturePath = process.argv[2];
if (!fixturePath || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/verify-app-platform-conformance.mjs <fixture.json>");
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assertExactKeys(fixture, ["formatVersion", "declarations", "artifacts"], "fixture");
if (fixture.formatVersion !== 1) throw new Error("Unsupported conformance fixture version.");
if (!Array.isArray(fixture.declarations) || !Array.isArray(fixture.artifacts)) {
  throw new Error("Conformance declarations and artifacts must be arrays.");
}

for (const vector of fixture.declarations) {
  assertExactKeys(vector, ["name", "value", "canonical", "digest"], "declaration vector");
  const canonical = canonicalize(vector.value);
  const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  if (canonical !== vector.canonical || digest !== vector.digest) {
    throw new Error(`Declaration conformance failed: ${vector.name}`);
  }
}

for (const vector of fixture.artifacts) {
  assertExactKeys(vector, ["name", "entries", "digest"], "artifact vector");
  const forward = hashArtifact(vector.entries);
  const reverse = hashArtifact([...vector.entries].reverse());
  if (forward !== vector.digest || reverse !== vector.digest) {
    throw new Error(`Artifact conformance failed: ${vector.name}`);
  }
}

process.stdout.write(
  `verified ${fixture.declarations.length} declaration and ${fixture.artifacts.length} artifact vectors\n`,
);

// This verifier deliberately shares no work-fold implementation code. It is a
// second executable reading the language-neutral vectors and normative framing.
function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertScalarString(value, "canonical JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ArrayBuffer.isView(value)) {
    throw new Error("Canonical JSON contains an unsupported value.");
  }
  if (stack.has(value)) throw new Error("Canonical JSON cannot be cyclic.");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("Canonical JSON objects must be ordinary records.");
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      assertScalarString(key, "canonical JSON key");
      return `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`;
    }).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function hashArtifact(rawEntries) {
  if (!Array.isArray(rawEntries)) throw new Error("Artifact entries must be an array.");
  const entries = rawEntries.map((entry) => {
    assertExactKeys(entry, ["path", "bytesBase64"], "artifact entry");
    const path = entry.path;
    assertPortablePath(path);
    const bytes = decodeCanonicalBase64(entry.bytesBase64);
    return { path, pathBytes: Buffer.from(path, "utf8"), bytes };
  });
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (Buffer.compare(entries[index - 1].pathBytes, entries[index].pathBytes) === 0) {
      throw new Error(`Duplicate artifact path: ${entries[index].path}`);
    }
  }

  const hash = createHash("sha256");
  hash.update(Buffer.from("work-fold.artifact", "ascii"));
  hash.update(unsigned32(1));
  hash.update(unsigned32(entries.length));
  for (const entry of entries) {
    hash.update(unsigned32(entry.pathBytes.length));
    hash.update(entry.pathBytes);
    hash.update(unsigned64(entry.bytes.length));
    hash.update(entry.bytes);
  }
  return `work-fold.artifact.v1:sha256:${hash.digest("hex")}`;
}

function assertPortablePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
      || value.includes("\\") || /[:<>"|?*\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid artifact path: ${JSON.stringify(value)}`);
  }
  assertScalarString(value, "artifact path");
  if (value.normalize("NFC") !== value) throw new Error("Artifact paths must already be NFC.");
  for (const segment of value.split("/")) {
    const stem = segment.split(".")[0].toUpperCase();
    const reserved = ["CON", "PRN", "AUX", "NUL"].includes(stem)
      || /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem);
    if (!segment || segment === "." || segment === ".." || reserved
        || segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error(`Invalid artifact path segment: ${JSON.stringify(segment)}`);
    }
  }
}

function assertScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} has a lone surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} has a lone surrogate.`);
    }
  }
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Artifact bytes must use canonical base64.");
  }
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) throw new Error("Artifact base64 is not canonical.");
  return result;
}

function unsigned32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Unsigned 32-bit framing value is out of range.");
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function unsigned64(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid unsigned 64-bit framing value.");
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields.`);
  }
}
