import { createHash } from "node:crypto";
import { open, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const { limits } = workerData;
const bundledUrl = import.meta.url.replace(/\.asar\.unpacked\//, ".asar/");
const require = createRequire(bundledUrl);
const archivePrefix = bundledUrl.match(/^.*?\.asar\//)?.[0];
function bundledOrigin(specifier, url) {
  if (archivePrefix && !url.startsWith(archivePrefix)) throw new Error(`Bundled document dependency ${specifier} resolved outside the application archive. Reinstall work-fold to repair its bundled libraries.`);
  return url;
}
function bundledResolve(specifier) {
  const path = require.resolve(specifier);
  bundledOrigin(specifier, pathToFileURL(path).href);
  return path;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bare = (specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");

// Resolve ordinary project imports first, then the bundled tool libraries. Hooks
// live only in this run's worker. The entry module uses the exact captured bytes;
// relative imports keep the real script's normal location and Node semantics.
const scriptUrl = workerData.script ? pathToFileURL(workerData.script.path).href : undefined;
let entryFormat;
const libraryOrigins = {};
registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real worker lives outside app.asar. Resolving its own dependencies
    // there first can escape into an ancestor checkout's node_modules. Pin
    // host libraries to the archive; only user scripts use project-first lookup.
    if (bare(specifier) && context.parentURL === import.meta.url) {
      const resolved = nextResolve(specifier, { ...context, parentURL: bundledUrl });
      libraryOrigins[specifier] = bundledOrigin(specifier, resolved.url);
      return resolved;
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" && error.code !== "MODULE_NOT_FOUND") throw error;
      if (!bare(specifier) || context.parentURL === bundledUrl) throw error;
      if (context.conditions.includes("require")) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
      return nextResolve(specifier, { ...context, parentURL: bundledUrl });
    }
  },
  load(url, context, nextLoad) {
    if (url !== scriptUrl) return nextLoad(url, context);
    const extension = extname(workerData.script.path);
    const format = extension === ".mjs" ? "module" : extension === ".cjs" ? "commonjs" : nextLoad(url, context).format;
    entryFormat = format;
    return { format, source: workerData.script.source, shortCircuit: true };
  },
});

async function boundedRead(path, limit) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`${path} must be a file of at most ${limit} bytes.`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error(`${path} exceeds ${limit} bytes.`);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function main() {
  // The build verifies image-size's reviewed parser-bounds patch. Resolve the
  // actual PptxGenJS dependency here so provenance also covers its image reader.
  const pptxRequire = createRequire(bundledResolve("pptxgenjs"));
  const imageSizePath = pptxRequire.resolve("image-size");
  bundledOrigin("image-size", pathToFileURL(imageSizePath).href);
  const imageSize = pptxRequire(imageSizePath);
  // PDF.js also requires canvas. Load its native binding once before concurrent
  // ESM imports so a binding failure keeps its original error and code instead
  // of Node's secondary CJS-cache assertion during a competing import.
  const canvasPath = bundledResolve("@napi-rs/canvas");
  const canvas = require(canvasPath);
  libraryOrigins["@napi-rs/canvas"] = pathToFileURL(canvasPath).href;
  const [docx, exceljs, pptxgenjs, pdfLib, pdfjs, zip] = await Promise.all([
    import("docx"), import("exceljs"), import("pptxgenjs"), import("pdf-lib"),
    import("pdfjs-dist/legacy/build/pdf.mjs"), import("jszip"),
  ]);
  const versions = {};
  for (const name of ["docx", "exceljs", "pptxgenjs", "pdf-lib", "pdfjs-dist", "@napi-rs/canvas", "jszip"]) {
    let directory = dirname(bundledResolve(name));
    for (;;) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (metadata.name === name) { versions[name] = metadata.version; break; }
      } catch { /* Walk to the package boundary when exports hide package.json. */ }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot identify bundled ${name}.`);
      directory = parent;
    }
  }
  const runtime = { node: process.versions.node, electron: process.versions.electron ?? null, libraryOrigins };
  const canvasCheck = canvas.createCanvas(2, 2).toBuffer("image/png");
  if (!canvasCheck.length) throw new Error("The bundled canvas could not encode PNG.");
  if (workerData.mode === "probe") return { versions, runtime };

  const cwd = workerData.cwd;
  const imageOrigins = new Map();
  const images = [];
  let imageBytes = 0;
  const absolute = (path) => resolve(cwd, path);
  const pdfRoot = dirname(bundledResolve("pdfjs-dist/package.json"));

  async function withPdf(path, options, callback) {
    const sourcePath = absolute(path);
    const bytes = await boundedRead(sourcePath, limits.pdfBytes);
    const source = { path: sourcePath, sha256: digest(bytes), bytes: bytes.length };
    const loading = pdfjs.getDocument({
      data: Uint8Array.from(bytes), password: options.password,
      // PDF.js's Node data factory passes these directly to fs.readFile.
      standardFontDataUrl: join(pdfRoot, "standard_fonts") + "/",
      cMapUrl: join(pdfRoot, "cmaps") + "/", cMapPacked: true,
      wasmUrl: join(pdfRoot, "wasm") + "/",
      isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false,
    });
    try {
      const document = await loading.promise;
      const selected = options.pages ?? Array.from({ length: Math.min(document.numPages, limits.pdfPages) }, (_, i) => i + 1);
      if (!Array.isArray(selected) || !selected.length || selected.length > limits.pdfPages || new Set(selected).size !== selected.length || selected.some((n) => !Number.isInteger(n) || n < 1 || n > document.numPages)) {
        throw new Error(`Choose 1–${limits.pdfPages} distinct page numbers between 1 and ${document.numPages}.`);
      }
      return await callback(document, selected, { source, totalPages: document.numPages, omittedPages: document.numPages - selected.length, renderer: `pdfjs-dist@${versions["pdfjs-dist"]}` });
    } finally { await loading.destroy(); }
  }

  const context = {
    cwd, args: workerData.args, versions,
    script: { path: workerData.script.path, sha256: workerData.script.sha256 },
    libraries: { docx, ExcelJS: exceljs.default, PptxGenJS: pptxgenjs.default, pdfLib, pdfjs, canvas, JSZip: zip.default },
    resolve: absolute,
    async readPdf(path, options = {}) {
      return withPdf(path, options, async (document, selected, provenance) => {
        let remaining = limits.textBytes;
        const pages = [];
        for (const number of selected) {
          const page = await document.getPage(number);
          const content = await page.getTextContent();
          const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
          const buffer = Buffer.from(text);
          const admitted = buffer.subarray(0, remaining);
          remaining -= admitted.length;
          pages.push({ page: number, text: admitted.toString("utf8"), truncated: admitted.length < buffer.length });
          page.cleanup();
        }
        return { ...provenance, pages };
      });
    },
    async renderPdf(path, options = {}) {
      const scale = options.scale ?? 1.5;
      if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("PDF scale must be greater than 0 and at most 4.");
      return withPdf(path, options, async (document, selected, provenance) => {
        const temporary = options.outputDir === undefined;
        const outputDir = temporary ? await mkdtemp(join(workerData.reviewRoot, "pdf-")) : absolute(options.outputDir);
        await mkdir(outputDir, { recursive: true });
        const pages = [];
        for (const number of selected) {
          const page = await document.getPage(number);
          const viewport = page.getViewport({ scale });
          const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
          if (width * height > limits.pagePixels) throw new Error(`Page ${number} exceeds ${limits.pagePixels} pixels; lower scale.`);
          const surface = canvas.createCanvas(width, height);
          await page.render({ canvasContext: surface.getContext("2d"), viewport }).promise;
          const png = surface.toBuffer("image/png");
          const outputPath = join(outputDir, `page-${number}-${provenance.source.sha256.slice(0, 12)}-scale-${scale}.png`);
          // Never overwrite an existing render, including a person's unrelated file.
          await writeFile(outputPath, png, { flag: "wx" });
          const record = { ...provenance, page: number, scale, width, height, path: outputPath, sha256: digest(png), temporary };
          imageOrigins.set(outputPath, record);
          pages.push(record);
          page.cleanup();
        }
        return { ...provenance, pages };
      });
    },
    async emitImage(path) {
      if (images.length >= limits.images) throw new Error(`At most ${limits.images} images can enter one tool result.`);
      const imagePath = absolute(path);
      const bytes = await boundedRead(imagePath, limits.imageBytes);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("emitImage accepts PNG files. Convert other formats with the bundled canvas library.");
      // The standard PNG metadata reader inspects IHDR before a native decoder
      // can allocate memory for a highly compressed, oversized image.
      const dimensions = imageSize(bytes);
      if (dimensions.type !== "png" || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("The selected PNG has invalid dimensions.");
      if (dimensions.width * dimensions.height > limits.pagePixels) throw new Error("The selected image exceeds the pixel limit.");
      if (imageBytes + bytes.length > limits.totalImageBytes) throw new Error("Selected images exceed the 8 MiB combined limit.");
      const sha256 = digest(bytes);
      const origin = imageOrigins.get(imagePath);
      if (origin && origin.sha256 !== sha256) throw new Error("A rendered image changed before emission. Render it again to preserve source provenance.");
      const decoded = await canvas.loadImage(bytes);
      if (decoded.width * decoded.height > limits.pagePixels) throw new Error("The selected image exceeds the pixel limit.");
      if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) throw new Error("The selected PNG's decoded dimensions disagree with its header.");
      imageBytes += bytes.length;
      images.push({ data: bytes.toString("base64"), mimeType: "image/png", provenance: origin ?? { path: imagePath, sha256, width: decoded.width, height: decoded.height } });
      return { path: imagePath, sha256 };
    },
  };
  // Ordinary top-level JS executes normally. A default function receives helpers;
  // CJS module.exports is also exposed as default by native import().
  const module = await import(scriptUrl);
  const value = typeof module.default === "function" ? await module.default(context) : undefined;
  const serialized = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.from(serialized ?? "");
  return {
    value: bytes.subarray(0, limits.textBytes).toString("utf8"), valueTruncated: bytes.length > limits.textBytes,
    images, versions, runtime, script: context.script, cwd,
  };
}

try { parentPort.postMessage({ result: await main() }); }
catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError && workerData.script) {
    try {
      // Native Node execution remains authoritative. Acorn is used only after
      // failure to locate a syntax error in the exact captured entry bytes.
      // A dependency's parse failure must never be attributed to this script.
      const { parse } = await import("acorn");
      parse(workerData.script.source, { ecmaVersion: "latest", sourceType: entryFormat === "commonjs" ? "script" : "module", allowHashBang: true, allowReturnOutsideFunction: entryFormat === "commonjs", locations: true });
    } catch (diagnostic) {
      if (diagnostic instanceof SyntaxError && diagnostic.loc) {
        const { line, column } = diagnostic.loc;
        const sourceLine = workerData.script.source.split(/\r?\n/)[line - 1] ?? "";
        const start = Math.max(0, column - 70);
        const excerpt = sourceLine.slice(start, start + 180);
        message += `\n${workerData.script.path}:${line}:${column + 1}\n${excerpt}\n${" ".repeat(Math.max(0, Math.min(column - start, 180)))}^`;
      }
    }
  }
  const frames = typeof error?.stack === "string" ? error.stack.split("\n")
    .filter((line) => /^\s+at\s/.test(line)).slice(0, 10).map((line) => line.trim().slice(0, 400)) : [];
  // Preserve bounded engine diagnostics, never environment variables, arbitrary
  // Error properties, or the stack's repeated message/source preamble.
  parentPort.postMessage({ error: {
    message: Buffer.from(message).subarray(0, limits.textBytes).toString("utf8"),
    diagnostic: {
      name: error instanceof Error ? error.name.slice(0, 80) : "Error",
      ...(typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? { code: error.code } : {}),
      frames,
    },
  } });
}
