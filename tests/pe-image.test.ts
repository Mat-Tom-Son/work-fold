import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { peContentSha256 } from "../desktop/src/pe-image.js";
import { peContentSha256 as scriptPeContentSha256 } from "../scripts/pe-image.mjs";
import { simulateSignature, syntheticPe } from "./support/pe.js";

test("PE content digests survive Authenticode signing but not content changes", () => {
  for (const magic of [0x10b, 0x20b] as const) {
    const image = syntheticPe("reviewed helper bytes, not 8-aligned", magic);
    assert.notEqual(image.length % 8, 0, "the fixture exercises signing's alignment padding");
    const digest = peContentSha256(image);
    assert.equal(peContentSha256(simulateSignature(image)), digest, "signing keeps the recorded build digest");
    assert.equal(scriptPeContentSha256(image), digest, "the build script and desktop host agree");
    assert.equal(scriptPeContentSha256(simulateSignature(image)), digest);
    const altered = Buffer.from(image); altered[altered.length - 1] ^= 1;
    assert.notEqual(peContentSha256(altered), digest, "a changed instruction byte is never hidden");
  }
  assert.throws(() => peContentSha256(Buffer.from("#!/bin/sh\necho not a PE\n")), /Not a PE/);
  const truncated = syntheticPe("x").subarray(0, 0x60);
  assert.throws(() => peContentSha256(truncated), /Truncated|Not a PE/);
});

test("the built Windows binaries match their recorded content digests", { skip: process.platform !== "win32" }, (t) => {
  for (const [executable, record] of [
    ["out/included-tools/computer-helper/work-fold Computer/work-fold Computer.exe", "out/included-tools/computer-helper/work-fold Computer/source.json"],
    ["out/included-tools/chrome-native-host/work-fold-chrome-host.exe", "out/included-tools/chrome-native-host/source.json"],
  ]) {
    const path = fileURLToPath(new URL(`../${executable}`, import.meta.url));
    if (!existsSync(path)) { t.diagnostic(`${executable} has not been built; run desktop:prepare.`); continue; }
    const source = JSON.parse(readFileSync(fileURLToPath(new URL(`../${record}`, import.meta.url)), "utf8"));
    assert.equal(peContentSha256(readFileSync(path)), source.executableContentSha256, executable);
  }
});
