import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function buildChromeNativeHost({ destination, distribution }) {
  const origin = distribution.storeId ? `chrome-extension://${distribution.storeId}/` : "";
  if (distribution.storeId && !/^[a-p]{32}$/.test(distribution.storeId)) throw new Error("Invalid Chrome Store identity.");
  await mkdir(destination, { recursive: true });
  const temporary = join(destination, `.build-${process.pid}`);
  await mkdir(temporary, { recursive: true });
  try {
    const source = await readFile(join(root, "desktop/native/chrome-bootstrap.swift"));
    const identity = `let WorkFoldChromeOrigin = ${JSON.stringify(origin)}\n`;
    await writeFile(join(temporary, "main.swift"), source);
    await writeFile(join(temporary, "identity.swift"), identity);
    const binary = join(temporary, "work-fold-chrome-host");
    execFileSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macosx12.0", join(temporary, "identity.swift"), join(temporary, "main.swift"), "-o", binary], { stdio: "inherit" });
    if (execFileSync("lipo", ["-archs", binary], { encoding: "utf8" }).trim() !== "arm64") throw new Error("Chrome native host must target arm64.");
    await rename(binary, join(destination, "work-fold-chrome-host"));
    await writeFile(join(destination, "source.json"), `${JSON.stringify({
      schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName,
      bootstrapVersion: distribution.bootstrapVersion, target: "arm64-apple-macosx12.0",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      distributionSha256: createHash("sha256").update(JSON.stringify(distribution)).digest("hex"),
      compiler: execFileSync("xcrun", ["swiftc", "--version"], { encoding: "utf8" }).trim(),
    }, null, 2)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if ((process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM || process.platform) !== "darwin") console.log("The Chrome native host is built in the macOS lane only.");
  else {
    const distribution = JSON.parse(await readFile(join(root, "src/shared/chrome-distribution.json"), "utf8"));
    if (process.env.WORKFOLD_MAC_RELEASE_BUILD === "1" && !distribution.storeId) throw new Error("A Store-enabled release requires the actual Chrome Store identity.");
    await buildChromeNativeHost({ destination: join(root, "out/included-tools/chrome-native-host"), distribution });
    console.log("Built Chrome native bootstrap host.");
  }
}
