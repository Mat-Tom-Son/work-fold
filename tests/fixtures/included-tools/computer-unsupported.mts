import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

// Faking the platform on Windows breaks the loader's absolute-path handling,
// so a Windows host is presented as a release older than Windows 10 instead.
if (process.platform === "win32") {
  os.release = () => "6.1.7601";
  syncBuiltinESMExports();
} else Object.defineProperty(process, "platform", { value: "linux" });
await import("./computer-native.mts");
