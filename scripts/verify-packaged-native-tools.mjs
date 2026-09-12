import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/** Exercise the complete built bytes, with no model, accounts or production app launch. */
export async function verifyPackagedNativeTools(archivePath) {
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
    return output;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Pass the complete built app.asar path.");
  console.log(await verifyPackagedNativeTools(process.argv[2]));
}
