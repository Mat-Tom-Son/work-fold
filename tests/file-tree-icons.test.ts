import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import test from "node:test";

import { fileIconArtworkMarkup, fileIconGlyphs } from "../web-local/src/file-icons-data.js";
import {
  allFileTreeIconSpecs,
  fileTreeFileIcon,
  fileTreeFolderIcon,
  fileTreeIconGlyph,
} from "../web-local/src/file-tree-icons.js";

const fallback = fileTreeFileIcon("no-extension-here");

test("exact file names win over extensions", () => {
  assert.equal(fileTreeFileIcon("package.json").label, "npm package file");
  assert.equal(fileTreeFileIcon("data.json").label, "JSON file");
  assert.equal(fileTreeFileIcon("tsconfig.json").label, "TypeScript config");
  assert.equal(fileTreeFileIcon("AGENTS.md").label, "Agent instructions");
  assert.equal(fileTreeFileIcon("CLAUDE.md").label, "Claude instructions");
  assert.equal(fileTreeFileIcon("SKILL.md").label, "Skill instructions");
  assert.equal(fileTreeFileIcon("notes.md").label, "Markdown file");
  assert.equal(fileTreeFileIcon("Dockerfile").label, "Dockerfile");
  assert.equal(fileTreeFileIcon("Makefile").label, "Makefile");
  assert.equal(fileTreeFileIcon("CMakeLists.txt").label, "CMake file");
  assert.equal(fileTreeFileIcon("requirements.txt").label, "Python requirements");
  assert.equal(fileTreeFileIcon(".gitignore").label, "Git file");
  assert.equal(fileTreeFileIcon("LICENSE").label, "License");
  assert.equal(fileTreeFileIcon("Cargo.toml").label, "Cargo manifest");
  assert.equal(fileTreeFileIcon("GEMINI.md").label, "Gemini instructions");
  assert.equal(fileTreeFileIcon("Taskfile.yml").label, "Taskfile");
  assert.equal(fileTreeFileIcon("app.component.ts").label, "Angular component");
  assert.equal(fileTreeFileIcon("yarn.lock").label, "Yarn file");
  assert.equal(fileTreeFileIcon("other.lock").label, "Lock file");
});

test("config families and folder-aware rules resolve by pattern", () => {
  assert.equal(fileTreeFileIcon(".env").label, "Environment settings");
  assert.equal(fileTreeFileIcon(".env.production.local").label, "Environment settings");
  assert.equal(fileTreeFileIcon("tsconfig.node.json").label, "TypeScript config");
  assert.equal(fileTreeFileIcon("vite.local.config.ts").label, "Vite config");
  assert.equal(fileTreeFileIcon("vitest.config.mts").label, "Vitest config");
  assert.equal(fileTreeFileIcon("eslint.config.js").label, "ESLint config");
  assert.equal(fileTreeFileIcon("docker-compose.dev.yml").label, "Docker Compose file");
  assert.equal(fileTreeFileIcon("repo/.github/workflows/ci.yml").label, "GitHub Actions workflow");
  assert.equal(fileTreeFileIcon("repo/config/ci.yml").label, "YAML file");
  assert.equal(fileTreeFileIcon("src\\app\\.github\\workflows\\release.yaml").label, "GitHub Actions workflow");
  assert.equal(fileTreeFileIcon("server_test.go").label, "Go test");
  assert.equal(fileTreeFileIcon("test_models.py").label, "Python test");
});

test("multi-part extensions use the longest known suffix", () => {
  assert.equal(fileTreeFileIcon("types.d.ts").label, "TypeScript declarations");
  assert.equal(fileTreeFileIcon("chat.test.ts").label, "TypeScript test");
  assert.equal(fileTreeFileIcon("Button.spec.tsx").label, "React test");
  assert.equal(fileTreeFileIcon("Button.stories.tsx").label, "Storybook stories");
  assert.equal(fileTreeFileIcon("vendor.min.js").label, "Minified JavaScript file");
  assert.equal(fileTreeFileIcon("styles.module.css").label, "CSS module");
  assert.equal(fileTreeFileIcon("backup.tar.gz").label, "Archive file");
  assert.equal(fileTreeFileIcon("my.app.config.ts").label, "TypeScript config");
  assert.equal(fileTreeFileIcon("release.notes.ts").label, "TypeScript file");
});

test("matching ignores case", () => {
  assert.deepEqual(fileTreeFileIcon("REPORT.PDF"), fileTreeFileIcon("report.pdf"));
  assert.deepEqual(fileTreeFileIcon("Photo.JPeG"), fileTreeFileIcon("photo.jpeg"));
  assert.deepEqual(fileTreeFileIcon("readme.MD"), fileTreeFileIcon("README.md"));
  assert.deepEqual(fileTreeFileIcon("PACKAGE.JSON"), fileTreeFileIcon("package.json"));
});

test("a sampling of common types gets its own vscode-icons glyph", () => {
  const expected: Array<[string, string]> = [
    ["main.ts", "typescript"], ["index.js", "js"], ["App.tsx", "reactts"], ["page.html", "html"],
    ["Card.svelte", "svelte"], ["Card.vue", "vue"], ["theme.scss", "scss"], ["theme.css", "css"],
    ["data.yaml", "yaml"], ["query.sql", "sql"], ["Letter.docx", "word"], ["budget.xlsx", "excel"],
    ["deck.pptx", "powerpoint"], ["talk.key", "powerpoint"], ["server.key", "cert"], ["tls.key", "cert"], ["paper.pdf", "pdf"], ["photo.png", "image"],
    ["logo.svg", "svg"], ["song.mp3", "audio"], ["clip.mov", "video"], ["bundle.zip", "zip"],
    ["build.sh", "shell"], ["server.pem", "cert"], ["notes.txt", "text"], ["server.log", "log"],
    ["analysis.ipynb", "jupyter"], ["main.py", "python"], ["main.rs", "rust"], ["Main.java", "java"],
    ["main.go", "go"], ["main.cpp", "cpp"], ["Dockerfile", "docker"], ["package.json", "npm"],
    ["Inter.woff2", "font"], ["prompt.prompt.md", "ai"],
  ];
  for (const [name, glyph] of expected) assert.equal(fileTreeFileIcon(name).glyph, `vs:file-type-${glyph}`, name);
});

test("unknown and extensionless files fall back to the plain file icon", () => {
  assert.equal(fallback.label, "File");
  assert.deepEqual(fileTreeFileIcon("mystery.qqqzzz"), fallback);
  assert.deepEqual(fileTreeFileIcon("notes"), fallback);
  assert.deepEqual(fileTreeFileIcon("trailing-dot."), fallback);
  assert.equal(fallback.glyph, "vs:default-file");
});

test("every folder gets the same plain closed and open icon", () => {
  const names = ["docs", "src", "tests", ".github", "node_modules", "Assets", "My Projects", "a/b/scripts", ".pi", "skills"];
  const closed = fileTreeFolderIcon("anything", false);
  const open = fileTreeFolderIcon("anything", true);
  assert.equal(closed.glyph, "vs:default-folder");
  assert.equal(open.glyph, "vs:default-folder-opened");
  for (const name of names) {
    assert.deepEqual(fileTreeFolderIcon(name, false), closed, name);
    assert.deepEqual(fileTreeFolderIcon(name, true), open, name);
  }
  assert.equal(closed.label, "Folder");
});

test("every referenced glyph is vendored and nothing extra is shipped", () => {
  const referenced = new Set(allFileTreeIconSpecs().map((spec) => spec.glyph));
  for (const spec of allFileTreeIconSpecs()) {
    assert.ok(fileIconGlyphs[spec.glyph], `missing glyph ${spec.glyph}`);
    const glyph = fileTreeIconGlyph(spec);
    assert.match(glyph.viewBox, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    assert.match(glyph.body, /<(path|circle|rect|ellipse|polygon|use|g)\b/, spec.glyph);
  }
  assert.deepEqual(Object.keys(fileIconGlyphs).sort(), [...referenced].sort(), "rerun scripts/generate-file-icons.mjs");
});

test("every icon comes from vscode-icons and keeps its own colors", () => {
  for (const spec of allFileTreeIconSpecs()) {
    assert.match(spec.glyph, /^vs:/, spec.glyph);
    assert.equal("tone" in spec, false, spec.glyph);
  }
  const source = readFileSync(new URL("../web-local/src/components/tree/FileIconFrame.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /currentColor|tinted/, "icons are never recolored");
  assert.ok(fileTreeIconGlyph(fileTreeFileIcon("index.js")).light, "JavaScript carries a light-theme variant");
});

test("labels say what the file is", () => {
  assert.equal(fileTreeFileIcon(".npmrc").label, "npm config");
  assert.equal(fileTreeFileIcon("Cargo.lock").label, "Cargo lockfile");
  assert.equal(fileTreeFileIcon("go.sum").label, "Go checksums");
  assert.equal(fileTreeFileIcon("cache.pyc").label, "Compiled Python");
  assert.equal(fileTreeFileIcon("main.o").label, "Object file");
});

test("every glyph is light enough for a Files row", () => {
  for (const [id, glyph] of Object.entries(fileIconGlyphs)) {
    for (const artwork of [glyph, ...(glyph.light ? [glyph.light] : [])]) {
      assert.ok(Buffer.byteLength(artwork.body) <= 12 * 1024, `${id} is ${Buffer.byteLength(artwork.body)} bytes`);
    }
  }
  assert.ok(fileIconGlyphs["vs:file-type-audio"]?.contrast === "dark", "the near-black audio glyph is flagged for the dark theme");
});

test("vendored markup is inert and its ids are unique per rendered icon", () => {
  for (const [id, glyph] of Object.entries(fileIconGlyphs)) {
    for (const artwork of [glyph, ...(glyph.light ? [glyph.light] : [])]) {
      // Parsed as real SVG: only SVG elements, no text nodes, no handlers or
      // presentation attributes, links only to ids inside the icon.
      const dom = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${artwork.body.replaceAll("__WFID__", "wf")}</svg>`, { contentType: "image/svg+xml" });
      const root = dom.window.document.documentElement;
      assert.equal(dom.window.document.getElementsByTagName("parsererror").length, 0, id);
      for (const element of root.getElementsByTagName("*")) {
        assert.equal(element.namespaceURI, "http://www.w3.org/2000/svg", id);
        for (const attribute of element.attributes) {
          assert.doesNotMatch(attribute.name, /^on|^style$|^class$/i, `${id} ${attribute.name}`);
          if (attribute.name.endsWith("href")) assert.match(attribute.value, /^#/, id);
          assert.doesNotMatch(attribute.value, /url\(\s*(?!#)|javascript:/i, id);
        }
        for (const child of element.childNodes) if (child.nodeType === 3) assert.equal(child.nodeValue!.trim(), "", `${id} has text`);
      }
      const ids = [...artwork.body.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(Boolean(artwork.scoped), ids.length > 0, id);
      for (const name of ids) assert.ok(name.startsWith("__WFID__"), `${id} id ${name} is not scoped`);
    }
  }
  const gradient = Object.values(fileIconGlyphs).find((glyph) => glyph.scoped)!;
  const first = fileIconArtworkMarkup(gradient, "wfa");
  const second = fileIconArtworkMarkup(gradient, "wfb");
  assert.doesNotMatch(first, /__WFID__/);
  const idsOf = (markup: string) => new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const name of idsOf(first)) assert.ok(!idsOf(second).has(name));
  for (const reference of first.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)) assert.ok(idsOf(first).has(reference[1] ?? reference[2]!), "references resolve inside the icon");
});

test("the old icon theme is gone", () => {
  const source = readFileSync(new URL("../web-local/src/file-tree-icons.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
  assert.doesNotMatch(source, /material-icon-theme|\?url/);
  assert.equal(pkg.devDependencies?.["material-icon-theme"], undefined);
  assert.equal(pkg.dependencies?.["material-icon-theme"], undefined);
});
