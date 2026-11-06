import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCargoNotices } from "./cargo-license-notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
if ((process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform) === "linux") {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux x64 packages on Linux x64.");
  const target = join(root, "out/linux-native-target");
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(root, "desktop/native/linux/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  const cli = join(root, "out/included-tools/linux-cli");
  const chrome = join(root, "out/included-tools/chrome-native-host");
  await mkdir(cli, { recursive: true }); await mkdir(chrome, { recursive: true });
  await writeCargoNotices(join(root, "desktop/native/linux/Cargo.toml"), join(cli, "THIRD-PARTY-LICENSES.txt"));
  await copyFile(join(cli, "THIRD-PARTY-LICENSES.txt"), join(chrome, "THIRD-PARTY-LICENSES.txt"));
  for (const [name, directory] of [["work-fold-cli", cli], ["work-fold-chrome-host", chrome]]) {
    await copyFile(join(target, "release", name), join(directory, name));
    await chmod(join(directory, name), 0o755);
  }
  const distribution = JSON.parse(await readFile(join(root, "src/shared/chrome-distribution.json"), "utf8"));
  const sources = await Promise.all(["Cargo.toml", "Cargo.lock", "src/lib.rs", "src/cli.rs", "src/chrome.rs"].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(root, "desktop/native/linux", path))).digest("hex") })));
  const provenance = {
    target: "x86_64-unknown-linux-gnu", sources,
    distributionSha256: createHash("sha256").update(JSON.stringify(distribution)).digest("hex"),
    compiler: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  };
  await writeFile(join(cli, "source.json"), `${JSON.stringify({
    ...provenance, schema: "work-fold.linux-cli-source.v1", binarySha256: createHash("sha256").update(await readFile(join(cli, "work-fold-cli"))).digest("hex"),
  }, null, 2)}\n`);
  await writeFile(join(chrome, "source.json"), `${JSON.stringify({
    ...provenance,
    schema: "work-fold.chrome-native-host-source.v1", origin: `chrome-extension://${distribution.storeId}/`,
    nativeHostName: distribution.nativeHostName, bootstrapVersion: distribution.bootstrapVersion,
    binarySha256: createHash("sha256").update(await readFile(join(chrome, "work-fold-chrome-host"))).digest("hex"),
  }, null, 2)}\n`);
  console.log("Built Linux CLI and Chrome native hosts.");
  const waylandManifest = join(root, "desktop/native/linux-wayland/Cargo.toml");
  const waylandTarget = join(root, "out/linux-wayland-target");
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", waylandManifest], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: waylandTarget },
  });
  const wayland = join(root, "out/included-tools/wayland-helper");
  await mkdir(wayland, { recursive: true });
  await copyFile(join(waylandTarget, "release/work-fold-wayland"), join(wayland, "work-fold-wayland"));
  await chmod(join(wayland, "work-fold-wayland"), 0o755);
  await writeCargoNotices(waylandManifest, join(wayland, "THIRD-PARTY-LICENSES.txt"));
  const waylandFiles = ["Cargo.toml", "Cargo.lock", "build.rs", "src/lib.rs", "src/main.rs", "src/capture.rs", "src/ei.rs", "src/keyboard.rs", "src/portal.rs", "src/seat.rs"];
  await writeFile(join(wayland, "source.json"), JSON.stringify({
    schema: "work-fold.wayland-helper-source.v1", protocolVersion: 1, target: "x86_64-unknown-linux-gnu",
    compiler: provenance.compiler,
    binarySha256: createHash("sha256").update(await readFile(join(wayland, "work-fold-wayland"))).digest("hex"),
    sources: await Promise.all(waylandFiles.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(root, "desktop/native/linux-wayland", path))).digest("hex") }))),
    systemLibraries: Object.fromEntries(["gstreamer-1.0", "gstreamer-app-1.0", "gstreamer-video-1.0", "libei-1.0", "xkbcommon"].map(name => [name,
      execFileSync("pkg-config", ["--modversion", name], { encoding: "utf8" }).trim()])),
  }, null, 2) + "\n");
  console.log("Built the Wayland portal/capture/input helper with source and dependency evidence.");
}
