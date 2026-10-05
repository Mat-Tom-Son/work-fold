import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildMachinePathNeedles, containsBuildMachinePath, rustBuildEnvironment } from "../scripts/build-machine-paths.mjs";

const home = "C:\\Users\\builder";

test("Rust builds remap the build account's profile, Cargo and rustup paths", () => {
  const env = rustBuildEnvironment({ RUSTFLAGS: "-C target-cpu=x86-64-v2", PATH: "unchanged" }, home);
  assert.equal(env.RUSTFLAGS, undefined, "Cargo would ignore RUSTFLAGS beside the encoded flags");
  assert.equal(env.PATH, "unchanged");
  assert.deepEqual(env.CARGO_ENCODED_RUSTFLAGS.split("\x1f"), [
    "-C", "target-cpu=x86-64-v2",
    `--remap-path-prefix=${home}=~`,
    `--remap-path-prefix=${join(home, ".cargo")}=cargo`,
    `--remap-path-prefix=${join(home, ".rustup")}=rustup`,
  ]);
  const custom = rustBuildEnvironment({ CARGO_ENCODED_RUSTFLAGS: "-Cdebuginfo=0", CARGO_HOME: "D:\\cargo home" }, home);
  assert.deepEqual(custom.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 3), ["-Cdebuginfo=0", `--remap-path-prefix=${home}=~`, "--remap-path-prefix=D:\\cargo home=cargo"]);
});

test("the profile-path scan finds every spelling a binary or archive can carry", () => {
  const needles = buildMachinePathNeedles(home);
  for (const embedded of [
    `panic at ${home}\\.cargo\\registry\\src\\serde_json\\value.rs`,
    "file:///C:/Users/builder/AppData/Local/x.js",
    "c:\\users\\builder\\desktop\\source.map",
  ]) {
    assert.ok(containsBuildMachinePath(Buffer.from(embedded, "latin1"), needles), embedded);
    assert.ok(containsBuildMachinePath(Buffer.from(`\0\0${embedded}`, "utf16le"), needles), `${embedded} as UTF-16`);
  }
  assert.equal(containsBuildMachinePath(Buffer.from("C:\\Users\\builder2\\file and BUILDER_FORMAT_TYPE"), needles), false, "a longer profile name is a different account");
  assert.equal(containsBuildMachinePath(Buffer.from("cargo\\registry\\src\\itoa-1.0.18\\src\\lib.rs ~\\.cargo"), needles), false, "remapped paths are clean");
});
