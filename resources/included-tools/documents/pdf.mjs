import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, utf8Prefix } from "./output.mjs";

/** One immutable byte snapshot and configured PDF.js loading task per handle. */
export function pdfHelpers({ pdfjs, canvas, pdfRoot, versions, limits, boundedRead, absolute, reviewRoot, imageOrigins, output }) {
  const handles = new Set();
  async function openPdf(path, options = {}) {
    const sourcePath = absolute(path);
    const maxSourceBytes = options.maxSourceBytes ?? limits.pdfBytes;
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) throw new Error("maxSourceBytes must be a positive safe integer; it is an explicit source-capture budget.");
    const bytes = await boundedRead(sourcePath, maxSourceBytes);
    const source = { path: sourcePath, sha256: digest(bytes), bytes: bytes.length };
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== source.sha256) throw new Error("PDF source changed; open the new source deliberately instead of continuing an old observation.");
    const loading = pdfjs.getDocument({ data: Uint8Array.from(bytes), password: options.password,
      standardFontDataUrl: join(pdfRoot, "standard_fonts") + "/", cMapUrl: join(pdfRoot, "cmaps") + "/", cMapPacked: true,
      wasmUrl: join(pdfRoot, "wasm") + "/", isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false });
    let document;
    try { document = await loading.promise; } catch (error) { await loading.destroy(); throw error; }
    let closed = false;
    let cachedText;
    const provenance = { source, totalPages: document.numPages, renderer: `pdfjs-dist@${versions["pdfjs-dist"]}` };
    const selection = (options, kind) => {
      if (closed) throw new Error("This PDF handle is closed.");
      const cursor = options.continuation;
      if (cursor && (cursor.version !== 1 || cursor.kind !== kind || cursor.sha256 !== source.sha256)) throw new Error("PDF continuation does not match this source and operation.");
      const pages = options.pages ?? cursor?.pages ?? Array.from({ length: document.numPages }, (_, i) => i + 1);
      if (!Array.isArray(pages) || !pages.length || new Set(pages).size !== pages.length || pages.some((n) => !Number.isInteger(n) || n < 1 || n > document.numPages)) throw new Error(`Choose distinct page numbers between 1 and ${document.numPages}.`);
      if (cursor && (JSON.stringify(cursor.pages) !== JSON.stringify(pages) || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index >= pages.length || !Number.isInteger(cursor.offset) || cursor.offset < 0)) throw new Error("Invalid PDF continuation position or page selection.");
      return { selected: pages, index: cursor?.index ?? 0, offset: cursor?.offset ?? 0 };
    };
    const continuation = (kind, selected, index, offset = 0) => index < selected.length ? { version: 1, kind, sha256: source.sha256, pages: selected, index, offset } : null;
    const handle = {
      source, totalPages: document.numPages,
      async readText(options = {}) {
        const { selected, index: start, offset: initialOffset } = selection(options, "text");
        const maxBytes = options.maxBytes ?? limits.pdfTextBytes;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > limits.textBytes) throw new Error(`maxBytes must be between 4 and ${limits.textBytes}; continue with the returned source-pinned cursor for more.`);
        let remaining = maxBytes, index = start, offset = initialOffset;
        const pages = [];
        while (index < selected.length && remaining >= 4) {
          const page = await document.getPage(selected[index]);
          try {
            if (cachedText?.page !== selected[index]) {
              const content = await page.getTextContent();
              cachedText = { page: selected[index], text: content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("") };
            }
            const text = cachedText.text;
            if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))) throw new Error("PDF continuation offset is outside the extracted text.");
            const admitted = utf8Prefix(text.slice(offset), remaining);
            remaining -= Buffer.byteLength(admitted);
            const nextOffset = offset + admitted.length;
            pages.push({ page: selected[index], text: admitted, offset, nextOffset, truncated: nextOffset < text.length });
            if (nextOffset < text.length) { offset = nextOffset; break; }
            index++; offset = 0;
            // Empty pages still have metadata; bound that as well as text.
            if (Buffer.byteLength(JSON.stringify(pages)) >= limits.textBytes) break;
          } finally { page.cleanup(); }
        }
        const next = continuation("text", selected, index, offset);
        const result = { ...provenance, selectedPages: selected, omittedPages: document.numPages - selected.length, pages, continuation: next, complete: next === null, textBytes: maxBytes - remaining };
        await output.observe({ kind: "pdf-text", ...result });
        return result;
      },
      async render(options = {}) {
        const { selected, index: start } = selection(options, "render");
        const requestedScale = options.scale ?? 1.5;
        if (!Number.isFinite(requestedScale) || requestedScale <= 0) throw new Error("PDF scale must be finite and greater than 0.");
        const temporary = options.outputDir === undefined;
        const outputDir = temporary ? await mkdtemp(join(reviewRoot, "pdf-")) : absolute(options.outputDir);
        await mkdir(outputDir, { recursive: true });
        const pages = [];
        let index = start;
        for (; index < selected.length; index++) {
          const number = selected[index];
          const page = await document.getPage(number);
          try {
            const base = page.getViewport({ scale: 1 });
            const region = options.region ?? { x: 0, y: 0, width: base.width, height: base.height };
            if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > base.width + 0.001 || region.y + region.height > base.height + 0.001) throw new Error("PDF region must fit the page's rotated viewport in scale-1, top-left coordinates.");
            const maxScale = Math.min(Math.sqrt(limits.pagePixels / (region.width * region.height)), limits.canvasDimension / region.width, limits.canvasDimension / region.height);
            let scale = Math.min(requestedScale, maxScale);
            let width = Math.ceil(region.width * scale), height = Math.ceil(region.height * scale);
            if (width * height > limits.pagePixels) { scale *= Math.sqrt(limits.pagePixels / (width * height)) * 0.99999; width = Math.ceil(region.width * scale); height = Math.ceil(region.height * scale); }
            if (options.fitToBudget === false && scale < requestedScale) throw new Error(`Page ${number} exceeds the canvas budget; choose a smaller region/scale or enable fitToBudget.`);
            const viewport = page.getViewport({ scale });
            const surface = canvas.createCanvas(width, height);
            await page.render({ canvasContext: surface.getContext("2d"), viewport, transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale] }).promise;
            const png = surface.toBuffer("image/png");
            const regionSuffix = options.region ? `-region-${digest(JSON.stringify(region)).slice(0, 12)}` : "";
            const outputPath = join(outputDir, `page-${number}-${source.sha256.slice(0, 12)}-scale-${scale}${regionSuffix}.png`);
            await writeFile(outputPath, png, { flag: "wx" });
            const artifact = temporary ? await output.artifact(`page-${number}.png`, png, "image/png") : { path: outputPath, sha256: digest(png), bytes: png.length, mediaType: "image/png" };
            const record = { ...provenance, page: number, requestedScale, scale, fitted: scale !== requestedScale, region, width, height, path: outputPath, sha256: digest(png), temporary, artifact };
            imageOrigins.set(outputPath, record);
            imageOrigins.set(artifact.path, { ...record, path: artifact.path, temporary: false });
            pages.push(record);
            await output.observe({ kind: "pdf-render", ...record });
            if (Buffer.byteLength(JSON.stringify(pages)) >= limits.textBytes / 2) { index++; break; }
          } finally { page.cleanup(); }
        }
        const next = continuation("render", selected, index);
        return { ...provenance, selectedPages: selected, omittedPages: document.numPages - selected.length, pages, continuation: next, complete: next === null };
      },
      async close() { if (!closed) { closed = true; cachedText = undefined; handles.delete(handle); await loading.destroy(); } },
    };
    handles.add(handle);
    return handle;
  }
  const withHandle = async (path, options, method) => {
    const handle = await openPdf(path, { ...options, expectedSha256: options.expectedSha256 ?? options.continuation?.sha256 });
    try { return await handle[method](options); } finally { await handle.close(); }
  };
  return { openPdf, readPdf: (path, options = {}) => withHandle(path, options, "readText"), renderPdf: (path, options = {}) => withHandle(path, options, "render"), close: () => Promise.all([...handles].map((handle) => handle.close())) };
}
