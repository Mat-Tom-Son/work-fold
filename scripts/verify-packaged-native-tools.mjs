import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { extractFile } from "@electron/asar";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/** Reject a release containing the unpatched parser, before loading any tools. */
export async function verifyPackagedImageSize(archivePath) {
  const manifest = JSON.parse(await readFile(join(root, "patches/included-tools/manifest.json"), "utf8"));
  const entry = manifest.find(item => item.package === "image-size");
  if (!entry?.files?.length) throw new Error("Missing image-size security patch manifest.");
  const prefix = "node_modules/image-size";
  const read = path => {
    try { return extractFile(resolve(archivePath), `${prefix}/${path}`); }
    catch { throw new Error(`Packaged image-size security verification failed: missing ${path}`); }
  };
  const metadata = JSON.parse(read("package.json").toString("utf8"));
  if (metadata.name !== entry.package || metadata.version !== entry.version) throw new Error(`Packaged image-size security verification failed: expected ${entry.package}@${entry.version}`);
  for (const file of entry.files) {
    const digest = createHash("sha256").update(read(file.path)).digest("hex");
    if (digest !== file.after) throw new Error(`Packaged image-size security verification failed: ${file.path} does not match the reviewed patch`);
  }
  return `PASS packaged image-size ${entry.version}: ${entry.files.length} reviewed parser file hashes`;
}

/** Exercise the complete built bytes, with no model, accounts or production app launch. */
export async function verifyPackagedNativeTools(archivePath) {
  const security = await verifyPackagedImageSize(archivePath);
  const temporary = await mkdtemp(join(tmpdir(), "workfold-built-native-tools-"));
  try {
    const archive = join(temporary, "application", "app.asar");
    await mkdir(dirname(archive), { recursive: true });
    // A clone isolates dependency lookup and any loader caches from the source
    // artifact; APFS can clone these bytes without duplicating their storage.
    await cp(resolve(archivePath), archive, { mode: constants.COPYFILE_FICLONE });
    await cp(`${resolve(archivePath)}.unpacked`, `${archive}.unpacked`, { recursive: true, mode: constants.COPYFILE_FICLONE });
    // An unpacked worker must resolve its own libraries from the archive, even
    // when an ancestor has a package with the same name. Script imports retain
    // normal project-first behavior and are covered by the document unit lane.
    for (const name of ["docx", "exceljs", "pptxgenjs", "pdf-lib", "pdfjs-dist", "@napi-rs/canvas", "jszip"]) {
      const directory = join(temporary, "node_modules", name); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, main: "index.js" }));
      await writeFile(join(directory, "index.js"), `throw new Error(${JSON.stringify(`Unpacked document runtime escaped its archive into ${name}`)});\n`);
    }
    const canonicalArchive = await realpath(archive), canonicalRoot = await realpath(temporary);
    const output = await new Promise((resolveOutput, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT;
      const child = spawn(require("electron"), [join(root, "scripts/packaged-native-tools-electron-smoke.cjs"), canonicalArchive, join(canonicalRoot, "fixture"), join(root, "tests/fixtures/included-tools/documents/create-all.mjs")], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 75_000);
      const collect = chunk => { text += chunk.toString(); if (text.length > 256 * 1024) { child.kill("SIGKILL"); text = text.slice(0, 256 * 1024); } };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 && text.includes("PASS full built-ASAR native tools") ? resolveOutput(text) : reject(new Error(`Packaged native tool smoke ${timedOut ? "timed out" : "failed"}:\n${text}`)); });
    });
    return `${security}\n${output}`;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Verify the signed helper's actual materialization path without starting it or
 * requesting OS permissions. The implementation comes from the built archive. */
export async function verifyPackagedNativeHelpers(resourcesPath) {
  const temporary = await mkdtemp(join(tmpdir(), "workfold-built-native-helpers-"));
  try {
    const implementation = extractFile(join(resourcesPath, "app.asar"), "dist/desktop/desktop/src/computer-helper-installation.js");
    const modulePath = join(temporary, "installation.mjs"); await writeFile(modulePath, implementation);
    const { ComputerHelperInstallation } = await import(pathToFileURL(modulePath).href);
    const sourceAppPath = join(resourcesPath, "computer-helper", "work-fold Computer.app");
    const installation = await ComputerHelperInstallation.create({ sourceAppPath, stateRoot: join(temporary, "state") });
    await installation.prepare();
    if (!installation.helperAppPath.startsWith(join(temporary, "state", "native-helpers", "computer"))) throw new Error("Packaged Computer helper did not materialize outside the app bundle.");
    const binary = join(resourcesPath, "chrome-native-host", "work-fold-chrome-host");
    const reply = await new Promise((resolveReply, reject) => {
      const child = spawn(binary, ["chrome-extension://invalid-origin/"], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks = []; let size = 0, stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.stdout.on("data", data => { size += data.length; if (size > 65_540) child.kill("SIGKILL"); else chunks.push(data); });
      child.stderr.on("data", data => { stderr += data; if (stderr.length > 4096) child.kill("SIGKILL"); });
      child.stdin.on("error", () => {}); child.stdin.end();
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => {
        clearTimeout(timeout); const bytes = Buffer.concat(chunks);
        if (code !== 0 || stderr || bytes.length < 5 || bytes.readUInt32LE() !== bytes.length - 4) { reject(new Error("Packaged Chrome bootstrap did not fail closed with one bounded protocol frame.")); return; }
        try { resolveReply(JSON.parse(bytes.subarray(4).toString("utf8"))); } catch (error) { reject(error); }
      });
    });
    if (reply.version !== 1 || reply.state !== "status" || !["connection_error", "store_unavailable"].includes(reply.status?.state)) throw new Error("Packaged Chrome bootstrap admitted an unowned origin.");
    return "PASS signed native helpers: exact standalone Computer copy and Chrome bootstrap origin/frame rejection; no Computer launch or permissions";
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Pass the complete built app.asar path.");
  console.log(await verifyPackagedNativeTools(process.argv[2]));
}
