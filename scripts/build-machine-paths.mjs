import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Rust embeds dependency source paths in panic messages, and Cargo's registry
 * lives in the builder's profile. Remap them so a distributed binary never
 * carries the build account's name. The last matching prefix wins in rustc.
 */
export function rustBuildEnvironment(env = process.env, home = homedir()) {
  const inherited = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
    : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  const remaps = [[home, "~"], [env.CARGO_HOME || join(home, ".cargo"), "cargo"], [env.RUSTUP_HOME || join(home, ".rustup"), "rustup"]]
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const { RUSTFLAGS: _ignored, ...rest } = env;
  return { ...rest, CARGO_ENCODED_RUSTFLAGS: [...inherited, ...remaps].join("\x1f") };
}

/** The build account's profile path, as ASCII and UTF-16 text in both slash styles. */
export function buildMachinePathNeedles(home = homedir()) {
  const forms = new Set();
  for (const path of [home, home.replaceAll("\\", "/")]) {
    // A trailing separator keeps a short profile name from matching longer ones.
    const separator = path.includes("\\") ? "\\" : "/";
    forms.add(`${path}${separator}`);
    forms.add(`${path}${separator}`.toLowerCase());
  }
  return [...forms].flatMap((form) => [Buffer.from(form, "latin1"), Buffer.from(form, "utf16le")]);
}

export function containsBuildMachinePath(bytes, needles = buildMachinePathNeedles()) {
  return needles.some((needle) => bytes.indexOf(needle) !== -1);
}
