import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const consumer = createRequire(require.resolve("pptxgenjs"));
const parserPath = consumer.resolve("image-size");
const fixtureRoot = fileURLToPath(new URL("./fixtures/included-tools/documents/images/", import.meta.url));

function box(name: string, payload = Buffer.alloc(0), declaredSize = payload.length + 8) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(declaredSize); header.write(name, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function icns(entries: Buffer[], declaredSize?: number) {
  // ICNS entries put type before length; ISO boxes have the reverse order.
  const payload = Buffer.concat(entries.map(entry => entry.length >= 8
    ? Buffer.concat([entry.subarray(4, 8), entry.subarray(0, 4), entry.subarray(8)]) : entry));
  const header = Buffer.alloc(8);
  header.write("icns"); header.writeUInt32BE(declaredSize ?? payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}
const jxlHeader = Buffer.concat([box("JXL ", Buffer.from([13, 10, 135, 10])), box("ftyp", Buffer.from("jxl "))]);
const heifHeader = box("ftyp", Buffer.from("avif\0\0\0\0"));
const heif = (property: Buffer) => Buffer.concat([heifHeader, box("meta", Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", property))]))]);

// Never let a regressed synchronous parser hang the test runner or exhaust its
// heap. No disabledTypes setting or document-worker wrapper masks these calls.
async function parseIsolated(cases: Array<{ name: string; bytes: Buffer }>) {
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    const parser=require(workerData.parserPath);
    parentPort.postMessage(workerData.cases.map(({name,bytes})=>{
      try{return{name,result:parser(bytes)}}catch(error){return{name,error:error.message}}
    }));`, { eval: true, workerData: { parserPath, cases }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
  try {
    return await new Promise<Array<{ name: string; result?: { width: number; height: number }; error?: string }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Image parser did not terminate")), 3_000);
      worker.once("message", value => { clearTimeout(timer); resolve(value); });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", code => { clearTimeout(timer); reject(new Error(`Image parser exited ${code} before returning a result`)); });
    });
  } finally { await worker.terminate(); }
}

test("PptxGenJS resolves the exact hash-verified image-size remediation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../patches/included-tools/manifest.json", import.meta.url), "utf8"));
  const entry = manifest.find((item: { package: string }) => item.package === "image-size");
  assert.ok(entry);
  const root = dirname(consumer.resolve("image-size/package.json"));
  assert.equal(consumer("image-size/package.json").version, entry.version);
  for (const file of entry.files) {
    const digest = createHash("sha256").update(await readFile(join(root, file.path))).digest("hex");
    assert.equal(digest, file.after, file.path);
  }
});

test("ICNS zero, undersized, oversized and truncated entries reject without looping", async () => {
  const cases = [
    { name: "short file header", bytes: Buffer.from("icns") },
    { name: "short declared file", bytes: icns([box("is32")], 8) },
    { name: "truncated second entry", bytes: icns([box("is32"), Buffer.from("is32")], 24) },
  ];
  for (const length of [...Array(8).keys(), 100, 0xffff_ffff]) {
    cases.push({ name: `first entry ${length}`, bytes: icns([box("is32", undefined, length)]) });
    cases.push({ name: `second entry ${length}`, bytes: icns([box("is32"), box("il32", undefined, length)]) });
  }
  const outcomes = await parseIsolated(cases);
  for (const outcome of outcomes) assert.match(outcome.error ?? "", /^Invalid ICNS/, outcome.name);
  // The file API reads only a bounded prefix. A complete header can describe a
  // larger payload; dimension probing must not require the entire image bytes.
  const prefix = icns([box("ic10", undefined, 600_000)], 600_008);
  const [valid] = await parseIsolated([{ name: "bounded file prefix", bytes: prefix }]);
  assert.equal(valid!.result!.width, 1024);
});

test("JXL and HEIF zero-size matching or skipped boxes cannot stall traversal", async () => {
  const cases: Array<{ name: string; bytes: Buffer }> = [];
  for (const size of [...Array(8).keys(), 100, 0xffff_ffff]) {
    cases.push({ name: `JXL partial ${size}`, bytes: Buffer.concat([jxlHeader, box("jxlp", Buffer.alloc(4), size)]) });
    cases.push({ name: `JXL skipped ${size}`, bytes: Buffer.concat([jxlHeader, box("junk", undefined, size)]) });
    cases.push({ name: `HEIF property ${size}`, bytes: heif(box("ispe", undefined, size)) });
    cases.push({ name: `HEIF skipped ${size}`, bytes: Buffer.concat([heifHeader, box("junk", undefined, size)]) });
  }
  cases.push({ name: "JXL truncated box header", bytes: Buffer.concat([jxlHeader, Buffer.from([0, 0, 0, 8, 106, 120, 108])]) });
  cases.push({ name: "HEIF truncated box header", bytes: Buffer.concat([heifHeader, Buffer.from([0, 0, 0, 8, 109, 101, 116])]) });
  const outcomes = await parseIsolated(cases);
  for (const outcome of outcomes) assert.ok(outcome.error, `${outcome.name}: ${JSON.stringify(outcome.result)}`);
});

test("real ICNS, JXL container and stream, AVIF and HEIC images retain dimensions", async () => {
  const expected = [
    ["icns-sample.icns", 16, 16], ["jxl-sample.jxl", 123, 456],
    ["jxl-stream-small_rect.jxl", 120, 80], ["heif-sample.avif", 123, 456], ["heif-sample.heic", 124, 456],
  ] as const;
  const cases = await Promise.all(expected.map(async ([name]) => ({ name, bytes: await readFile(join(fixtureRoot, name)) })));
  const results = await parseIsolated(cases);
  for (const [index, [name, width, height]] of expected.entries()) {
    assert.equal(results[index]!.error, undefined, name);
    assert.equal(results[index]!.result!.width, width, name); assert.equal(results[index]!.result!.height, height, name);
    // Exercise the unchanged legacy filesystem API as well as Uint8Array input.
    assert.equal(consumer("image-size")(join(fixtureRoot, name)).width, width);
  }
});

test("image-size dimensions remain usable in actual PptxGenJS PNG and JPEG output", async () => {
  const surface = createCanvas(15, 20), parser = consumer("image-size");
  const png = surface.toBuffer("image/png"), jpeg = surface.toBuffer("image/jpeg");
  assert.equal(parser(png).width, 15); assert.equal(parser(jpeg).height, 20);
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS(), slide = pptx.addSlide();
  const dimensions = parser(png);
  slide.addImage({ data: `image/png;base64,${png.toString("base64")}`, x: 0, y: 0, w: dimensions.width / 10, h: dimensions.height / 10 });
  slide.addImage({ data: `image/jpeg;base64,${jpeg.toString("base64")}`, x: 2, y: 0, w: 1.5, h: 2 });
  const archive = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
  const images = Object.values(archive.files).filter(file => /^ppt\/media\//.test(file.name) && !file.dir);
  assert.equal(images.length, 2);
  const embedded = await Promise.all(images.map(file => file.async("nodebuffer")));
  assert.ok(embedded.some(bytes => bytes.equals(png))); assert.ok(embedded.some(bytes => bytes.equals(jpeg)));
});
