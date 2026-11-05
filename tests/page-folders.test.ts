import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { PageProblem } from "../src/shared/pages/index.js";
import { classifyPageReference } from "../src/local/pages/page-document.js";
import { findPageFolders, normalizePagePath, pageFolderLimits } from "../src/local/pages/page-folder-files.js";
import { analyzePageFolder, assemblePageFolder, inspectPageFolder } from "../src/local/pages/page-inspection.js";
import { scanCss, scanHtml } from "../src/local/pages/page-markup.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";

/**
 * Page folders (docs/pages.md, "A page is a folder", "How a page runs"):
 * finding them, validating page.json, the entry, references, and limits, and
 * assembling one self-contained document, against a small fixture page.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages", "sign-up-sheet");

async function workFolder(t: TestContext): Promise<{ root: string; write(path: string, text: string): Promise<void>; page(name?: string): Promise<string> }> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-page-folders-"));
  configureWorkFoldStateRoot(join(sandbox, "state"));
  t.after(async () => {
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const root = join(sandbox, "work-folder");
  await mkdir(root, { recursive: true });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text, "utf8");
  };
  return {
    root,
    write,
    async page(name = "Sign up") {
      await cp(fixture, join(root, name), { recursive: true });
      return name;
    },
  };
}

const errors = (problems: PageProblem[]) => problems.filter((problem) => problem.severity === "error");

test("the fixture page validates, with its unused extra page reported as a warning", async (t) => {
  const folder = await workFolder(t);
  const path = await folder.page("Events/Sign up");
  const inspection = await inspectPageFolder(folder.root, path);
  assert.equal(inspection.page.path, "Events/Sign up");
  assert.equal(inspection.page.title, "Volunteer Sign-up");
  assert.equal(inspection.page.description, "Pick a shift for the spring fair.");
  assert.equal(inspection.page.entry, "index.html");
  assert.deepEqual(inspection.page.tables.map((table) => table.name), ["signups"]);
  assert.deepEqual(inspection.problems, [{
    file: "thanks.html",
    message: "Only index.html is the page, so this file isn't used. A page that needs several screens switches them in script.",
    severity: "warning",
  }]);
  assert.equal(inspection.summary.files, 9);
  assert.ok(inspection.summary.bytes > 1_000);
});

test("assembly inlines every local file into one document and leaves links and the policy to the host", async (t) => {
  const folder = await workFolder(t);
  const path = await folder.page();
  const { html, problems } = await assemblePageFolder(folder.root, path);
  assert.equal(errors(problems).length, 0);
  assert.ok(html);
  // Nothing in the document still points at a page file.
  for (const file of ["css/style.css", "css/fonts.css", "fonts.css", "images/logo.svg", "images/bg.svg", "fonts/display.woff2", "app.js"]) {
    assert.equal(html.includes(`"${file}"`) || html.includes(`(${file})`) || html.includes(`'${file}'`) || html.includes(`${file} `), false, file);
  }
  assert.doesNotMatch(html, /<link rel="stylesheet"/u);
  assert.match(html, /<style media="screen">[\s\S]*@font-face[\s\S]*src: url\("data:font\/woff2;base64,/u, "@import is inlined with its fonts");
  assert.match(html, /\.hero \{ background: url\("data:image\/svg\+xml;base64,/u, "url() relative to the stylesheet");
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml;base64,/u);
  assert.match(html, /<img class="logo" src="data:image\/svg\+xml;base64,[^"]+" srcset="data:image\/svg\+xml;base64,[^ ]+ 1x, data:image\/svg\+xml;base64,[^ ]+ 2x"/u);
  assert.match(html, /style="background: url\(&quot;data:image\/svg\+xml;base64,[^&]+&quot;\) no-repeat"/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/example.com\/sign-up">/u, "non-loading links stay as they are");
  assert.match(html, /<a href="https:\/\/example.com\/fair">/u, "ordinary links stay");
  // The deferred script moved to the end of the body, inline, with </script> escaped.
  const deferred = html.indexOf("const marker");
  assert.ok(deferred > html.indexOf("<p class=\"count\">"), "a deferred script runs after the page is parsed");
  assert.ok(deferred < html.indexOf("</body>"));
  assert.match(html, /const marker = "<\\\/script>";/u);
  assert.doesNotMatch(html, /\bdefer\b/u);
  assert.doesNotMatch(html, /workFoldPage = |page-frame/u, "the page runtime and policy are the frame host's job");
  // The comment's url() is left alone.
  assert.match(html, /\/\* url\(images\/ignored-in-a-comment\.png\) \*\//u);
});

test("references to the internet, outside the folder, or missing files are errors naming the file", async (t) => {
  const folder = await workFolder(t);
  const path = await folder.page();
  await folder.write("secret.png", "not part of the page");
  await folder.write(`${path}/.hidden/thing.png`, "hidden");
  await folder.write(`${path}/index.html`, `<!doctype html>
<link rel="stylesheet" href="https://cdn.example.com/kit.css">
<link rel="preconnect" href="https://fonts.gstatic.com">
<script src="//cdn.example.com/lib.js"></script>
<link rel="stylesheet" href="css/style.css">
<img src="../secret.png">
<img src="images/missing.png">
<img src=".hidden/thing.png">
<img srcset="images/logo.svg 1x, http://example.com/big.png 2x">
<video poster="https://example.com/poster.jpg"></video>
<iframe src="https://example.com/embed"></iframe>
<base href="/assets/">
<a href="mailto:hi@example.com">Write to us</a>
<script type="module">import { thing } from "./thing.js"; thing();</script>
<script type="module" src="app.js"></script>
`);
  await folder.write(`${path}/app.js`, "export { helper } from './helper.js';\n");
  await folder.write(`${path}/css/style.css`, "@import url(https://fonts.example.com/css); .a { background: url(../../secret.png); } .b { background: url(/images/logo.svg); }");
  const inspection = await inspectPageFolder(folder.root, path);
  const messages = errors(inspection.problems).map((problem) => `${problem.file}: ${problem.message}`);
  const expectFile = (file: string, pattern: RegExp) => assert.ok(messages.some((message) => message.startsWith(`${file}: `) && pattern.test(message)), `${file} ${pattern}\n${messages.join("\n")}`);
  expectFile("index.html", /Loads "https:\/\/cdn.example.com\/kit.css" from the internet/);
  expectFile("index.html", /Loads "https:\/\/fonts.gstatic.com" from the internet/);
  expectFile("index.html", /Loads "\/\/cdn.example.com\/lib.js" from the internet/);
  expectFile("index.html", /"\.\.\/secret\.png", which is outside the page folder/);
  expectFile("index.html", /"images\/missing\.png", which isn't in the page folder/);
  expectFile("index.html", /"\.hidden\/thing\.png", which isn't in the page folder/);
  expectFile("index.html", /Loads "http:\/\/example.com\/big.png"/);
  expectFile("index.html", /Loads "https:\/\/example.com\/poster.jpg"/);
  expectFile("index.html", /<iframe> can't load/);
  expectFile("index.html", /<base> element isn't supported/);
  expectFile("index.html", /A module script imports another file/);
  expectFile("app.js", /This module script imports another file/);
  expectFile("css/style.css", /Loads "https:\/\/fonts.example.com\/css"/);
  expectFile("css/style.css", /"\.\.\/\.\.\/secret\.png", which is outside the page folder/);
  assert.equal(messages.some((message) => message.includes("mailto")), false, "ordinary links are fine");
  assert.equal(messages.some((message) => message.includes("/images/logo.svg")), false, "a leading / means the page folder");
  const { html } = await assemblePageFolder(folder.root, path);
  assert.equal(html, null, "errors prevent assembly");
});

test("page.json problems, a missing entry, and an alternate entry are reported", async (t) => {
  const folder = await workFolder(t);
  const path = await folder.page();
  await folder.write(`${path}/page.json`, JSON.stringify({ format: "work-fold.page/1", title: "Broken", colour: "red", tables: { rsvps: { columns: { name: { type: "words" } } } } }));
  const broken = await inspectPageFolder(folder.root, path);
  assert.equal(broken.page.title, "Broken", "the title still shows");
  assert.deepEqual(errors(broken.problems).map((problem) => [problem.file, problem.message]), [
    ["page.json", "colour: isn't a known field."],
    ["page.json", "tables.rsvps.columns.name.type: must be one of: text, long-text, number, boolean, date, email, url, choice."],
  ]);
  assert.deepEqual(broken.page.tables, []);

  await folder.write(`${path}/page.json`, JSON.stringify({ format: "work-fold.page/1", title: "Moved", entry: "site/home.html" }));
  const missing = await inspectPageFolder(folder.root, path);
  assert.deepEqual(errors(missing.problems), [{ file: "site/home.html", message: "The page's entry file site/home.html isn't in the page folder.", severity: "error" }]);

  await folder.write(`${path}/site/home.html`, `<link rel="stylesheet" href="../css/style.css"><img src="/images/logo.svg"><p>Home</p>`);
  const moved = await analyzePageFolder(folder.root, path, "assemble");
  assert.equal(errors(moved.problems).length, 0, JSON.stringify(moved.problems));
  assert.equal(moved.page.entry, "site/home.html");
  assert.ok(moved.problems.some((problem) => problem.file === "index.html" && problem.severity === "warning"), "the old entry is now unused");
  assert.match(moved.html ?? "", /<style>[\s\S]*@font-face/u);

  await folder.write(`${path}/page.json`, "{ not json");
  const unreadable = await inspectPageFolder(folder.root, path);
  assert.match(errors(unreadable.problems)[0]!.message, /page.json isn't valid JSON/);
  assert.equal(unreadable.page.title, "Sign up", "falls back to the folder name");
});

test("nested pages, links, and the file limits are errors; data.sqlite and hidden files aren't part of the page", async (t) => {
  const folder = await workFolder(t);
  const path = await folder.page();
  await folder.write(`${path}/data.sqlite`, "real visitors' data");
  await folder.write(`${path}/data.sqlite-wal`, "wal");
  await folder.write(`${path}/.DS_Store`, "finder");
  await folder.write(`${path}/.work-fold/work-folder.json`, "{}");
  const clean = await inspectPageFolder(folder.root, path);
  assert.equal(clean.summary.files, 9, "data.sqlite, its side files, and hidden files are left out");
  assert.equal(errors(clean.problems).length, 0);

  await folder.write(`${path}/extras/page.json`, JSON.stringify({ format: "work-fold.page/1", title: "Inner" }));
  await folder.write(`${path}/extras/index.html`, "<p>inner</p>");
  await symlink(join(folder.root, "outside.txt"), join(folder.root, path, "linked.txt")).catch(() => undefined);
  const nested = await inspectPageFolder(folder.root, path);
  assert.ok(errors(nested.problems).some((problem) => problem.file === "extras/page.json" && /can't contain another page folder/.test(problem.message)));
  if (process.platform !== "win32") {
    assert.ok(errors(nested.problems).some((problem) => problem.file === "linked.txt" && /Links aren't allowed/.test(problem.message)));
  }
  const inner = await inspectPageFolder(folder.root, `${path}/extras`);
  assert.ok(errors(inner.problems).some((problem) => problem.file === "" && /inside another page folder \(Sign up\)/.test(problem.message)));

  const big = await workFolder(t);
  const bigPath = await big.page("Big");
  await writeFile(join(big.root, bigPath, "huge.bin"), "");
  await truncate(join(big.root, bigPath, "huge.bin"), pageFolderLimits.maxFileBytes + 1);
  for (const name of ["a.bin", "b.bin"]) {
    await writeFile(join(big.root, bigPath, name), "");
    await truncate(join(big.root, bigPath, name), 9 * 1024 * 1024);
  }
  const heavy = await inspectPageFolder(big.root, bigPath);
  assert.ok(errors(heavy.problems).some((problem) => problem.file === "huge.bin" && /at most 10 MiB/.test(problem.message)));
  assert.ok(errors(heavy.problems).some((problem) => problem.file === "" && /at most 25 MiB in all/.test(problem.message)));

  const many = await workFolder(t);
  const manyPath = await many.page("Many");
  await mkdir(join(many.root, manyPath, "files"), { recursive: true });
  await Promise.all(Array.from({ length: pageFolderLimits.maxFiles }, (_, index) => writeFile(join(many.root, manyPath, "files", `${index}.txt`), "x")));
  const crowded = await inspectPageFolder(many.root, manyPath);
  assert.ok(errors(crowded.problems).some((problem) => /at most 500 files/.test(problem.message)));
});

test("page folders are found inside a work-folder; hidden, node_modules, and nested pages are skipped", async (t) => {
  const folder = await workFolder(t);
  await folder.page("Sign up");
  await folder.page("Events/2026/RSVP");
  await folder.write("Events/notes.md", "# notes");
  await folder.write("loose.html", "<p>just a file</p>");
  await folder.write(".private/page.json", "{}");
  await folder.write("node_modules/pkg/page.json", "{}");
  await folder.write("Sign up/extras/page.json", "{}");
  await folder.write("page.json", "{}");
  const found = await findPageFolders(folder.root);
  assert.deepEqual(found, { pages: ["Events/2026/RSVP", "Sign up"], truncated: false });
});

test("page paths stay inside the work-folder and never name hidden or reserved folders", async (t) => {
  const folder = await workFolder(t);
  await folder.page();
  for (const bad of ["", "/Sign up", "../Sign up", "Sign up/../..", ".work-fold", "a\\b", ".pi/x"]) {
    assert.throws(() => normalizePagePath(bad), (error: unknown) => (error as { statusCode?: number }).statusCode === 400, bad);
  }
  assert.equal(normalizePagePath("Sign up/"), "Sign up");
  await assert.rejects(inspectPageFolder(folder.root, "Events"), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
  await folder.write("Plain/index.html", "<p>no page.json</p>");
  await assert.rejects(inspectPageFolder(folder.root, "Plain"), /isn't a page folder/);
  if (process.platform !== "win32") {
    await symlink(join(folder.root, "Sign up"), join(folder.root, "Linked page"));
    await assert.rejects(inspectPageFolder(folder.root, "Linked page"), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  }
});

test("the markup scanners find references without being fooled by comments, strings, or raw text", () => {
  const tags = scanHtml(`<!-- <img src="commented.png"> --><p title='a > b'>x</p><script>const s = "<img src=x.png>";</script><textarea><img src="no.png"></textarea><IMG SRC=photo.jpg alt=x>`);
  const images = tags.filter((tag) => tag.name === "img");
  assert.equal(images.length, 1);
  assert.equal(images[0]!.attributes.find((attribute) => attribute.name === "src")?.value, "photo.jpg");
  assert.equal(tags.find((tag) => tag.name === "p")?.attributes[0]?.value, "a > b");
  assert.deepEqual(scanCss(`/* url(a.png) */ .x { content: "url(b.png)"; background: url( 'c.png' ) } @import 'd.css' screen;`).map((item) => [item.kind, item.url]), [
    ["url", "c.png"], ["import", "d.css"],
  ]);
  assert.deepEqual(classifyPageReference("../img/a%20b.png?v=2#top", "css"), { kind: "file", path: "img/a b.png", fragment: "#top" });
  assert.deepEqual(classifyPageReference("/img/a.png", "deep/er"), { kind: "file", path: "img/a.png", fragment: "" });
  assert.equal(classifyPageReference("data:image/png;base64,AAAA", "").kind, "skip");
  assert.equal(classifyPageReference("#section", "").kind, "skip");
  assert.equal(classifyPageReference("HTTPS://x.example/a.js", "").kind, "remote");
  assert.equal(classifyPageReference("\\\\server\\share\\a.png", "").kind, "remote");
  assert.equal(classifyPageReference("file:///etc/passwd", "").kind, "scheme");
  assert.equal(classifyPageReference("../../x.png", "css").kind, "outside");
});
