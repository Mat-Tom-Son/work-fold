import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", join(root, "node_modules/@injaneity/pi-computer-use/native/linux/bridge-rs/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(root, "out/linux-computer-target") },
  });
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", join(root, "desktop/native/linux-wayland/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(root, "out/linux-wayland-target") },
  });
}
