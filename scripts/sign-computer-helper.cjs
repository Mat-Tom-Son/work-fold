const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** Sign the nested native app before Electron seals the parent app resources. */
module.exports = async function signComputerHelper(context) {
  const { verifyAsarFileIntegrity } = await import("./asar-integrity.mjs");
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const verified = verifyAsarFileIntegrity(join(resources, "app.asar"), { includeUnpacked: true });
  console.log(`Verified ${verified.checkedFiles} ASAR file hashes before signing.`);
  if (context.electronPlatformName !== "darwin") return;
  const { verifyPackagedNativeTools } = await import("./verify-packaged-native-tools.mjs");
  console.log(await verifyPackagedNativeTools(join(resources, "app.asar")));
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const helper = join(app, "Contents", "Resources", "computer-helper", "work-fold Computer.app");
  const source = JSON.parse(readFileSync(join(helper, "Contents", "Resources", "source.json"), "utf8"));
  if (source.schema !== "work-fold.computer-helper-source.v1" || source.protocolVersion !== 7) throw new Error("Missing reviewed computer helper provenance.");
  const release = process.env.WORKFOLD_MAC_RELEASE_BUILD === "1";
  const identity = release ? process.env.WORKFOLD_MAC_SIGN_IDENTITY?.trim() : "-";
  if (release && !identity?.startsWith("Developer ID Application:")) throw new Error("The computer helper needs the release Developer ID Application identity.");
  const args = ["--force", "--identifier", "com.work-fold.desktop.computer"];
  if (release) args.push("--options", "runtime", "--timestamp");
  else args.push("--timestamp=none");
  args.push("--sign", identity, helper);
  execFileSync("codesign", args, { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", helper], { stdio: "inherit" });
  const chrome = join(app, "Contents", "Resources", "chrome-native-host", "work-fold-chrome-host");
  const chromeSource = JSON.parse(readFileSync(join(app, "Contents", "Resources", "chrome-native-host", "source.json"), "utf8"));
  if (chromeSource.schema !== "work-fold.chrome-native-host-source.v1" || chromeSource.bootstrapVersion !== 1) throw new Error("Missing Chrome bootstrap provenance.");
  const chromeArgs = ["--force", "--identifier", "com.work-fold.desktop.chrome-native-host"];
  if (release) chromeArgs.push("--options", "runtime", "--timestamp");
  else chromeArgs.push("--timestamp=none");
  chromeArgs.push("--sign", identity, chrome);
  execFileSync("codesign", chromeArgs, { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", chrome], { stdio: "inherit" });
  const { verifyPackagedNativeHelpers } = await import("./verify-packaged-native-tools.mjs");
  console.log(await verifyPackagedNativeHelpers(resources));
};
