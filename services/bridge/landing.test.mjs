import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderLanding } from "./public/landing.js";

function render(t, { reducedMotion = true } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: "https://www.work-fold.com" });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.window = dom.window;
  globalThis.matchMedia = () => ({ matches: reducedMotion });
  t.after(() => {
    dom.window.close();
    for (const key of ["window", "matchMedia"]) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  });
  const app = dom.window.document.querySelector("#app");
  renderLanding(app);
  return { app, document: dom.window.document, window: dom.window };
}

test("landing landmarks, local anchors and product/source links work without pinning copy", (t) => {
  const { document } = render(t);
  assert.equal(document.querySelectorAll("main").length, 1);
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(document.querySelectorAll("header").length, 1);
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const link of document.querySelectorAll('a[href^="#"]')) assert.ok(document.querySelector(link.getAttribute("href")));
  assert.ok(document.querySelector('a[href="/download/macos"]'));
  assert.ok(document.querySelector('a[href="https://github.com/Mat-Tom-Son/work-fold"]'));
  assert.ok(document.querySelector('a[href="https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk"]'));
  assert.ok(document.querySelector('a[href$="/CONTRIBUTING.md"]'));
  for (const link of document.querySelectorAll("a")) {
    assert.ok(link.textContent.trim() || link.getAttribute("aria-label"), "links have accessible names");
    if (link.target === "_blank") assert.ok(link.rel.includes("noreferrer") || link.rel.includes("noopener"));
    assert.ok(["https:", "http:"].includes(new URL(link.href).protocol));
  }
});

test("one brand treatment: the horizontal lockup appears once and is never rebuilt from pieces", (t) => {
  const { document } = render(t);
  const brandImages = [...document.querySelectorAll("img")].filter((img) => /brand-|icon-\d/.test(img.getAttribute("src")));
  assert.deepEqual(brandImages.map((img) => img.getAttribute("src")), ["/brand-lockup-black.png"]);
});

test("Mac and Windows downloads are ordinary links with the supplied platform icons", (t) => {
  const { document } = render(t);
  const downloads = [...document.querySelectorAll(".landing-download")];
  assert.ok(downloads.length >= 2);
  for (const link of downloads) {
    assert.ok(link.getAttribute("href"));
    assert.equal(link.getAttribute("aria-disabled"), null);
    const icon = link.querySelector("use")?.getAttribute("href");
    assert.ok(/^#landing-icon-(apple|windows)$/.test(icon));
    assert.ok(/Download for (Mac|Windows)/.test(link.textContent));
  }
  assert.ok(downloads.some((link) => link.textContent.includes("Windows")));
  assert.equal(/coming soon|waitlist|waiting list/i.test(document.body.textContent), false);
});

test("the sprite carries the four supplied icons verbatim", async (t) => {
  const { document } = render(t);
  const supplied = {
    apple: "ant-design--apple-filled.svg",
    windows: "dinkie-icons--windows.svg",
    chrome: "ant-design--chrome-filled.svg",
    github: "akar-icons--github-fill.svg",
  };
  for (const [name, file] of Object.entries(supplied)) {
    const symbol = document.getElementById(`landing-icon-${name}`);
    assert.ok(symbol, `${name} symbol exists`);
    assert.ok(document.querySelector(`use[href="#landing-icon-${name}"]`), `${name} icon is used`);
    const original = await readFile(new URL(`./landing-icons/${file}`, import.meta.url), "utf8");
    const path = original.match(/<path fill="currentColor"[^>]*? d="([^"]+)"/)[1];
    assert.equal(symbol.querySelector('path[fill="currentColor"]').getAttribute("d"), path);
    assert.equal(symbol.getAttribute("viewBox"), original.match(/viewBox="([^"]+)"/)[1]);
  }
});

test("every rendered screen exists, shares one frame size, has a description, and matches its format", async (t) => {
  const { document } = render(t);
  const screens = [...document.querySelectorAll('.landing-frame img')];
  assert.ok(screens.length >= 5);
  for (const img of screens) {
    assert.ok(img.alt.trim());
    assert.equal(img.getAttribute("width"), "1440");
    assert.equal(img.getAttribute("height"), "862");
    const candidates = [img.getAttribute("src"), ...(img.getAttribute("srcset") || "").split(",").map((entry) => entry.trim().split(" ")[0]).filter(Boolean)];
    for (const src of candidates) {
      assert.ok(src.startsWith("/screens/") && src.endsWith(".webp"), src);
      const bytes = await readFile(new URL(`./public${src}`, import.meta.url));
      assert.equal(bytes.toString("latin1", 0, 4), "RIFF");
      assert.equal(bytes.toString("latin1", 8, 12), "WEBP");
      const scale = Number(src.match(/-(\d+)\.webp$/)[1]) / 1440;
      // VP8 (lossy) stores 14-bit width/height at byte 26 of the file.
      assert.equal(bytes.toString("latin1", 12, 16), "VP8 ");
      assert.equal(bytes.readUInt16LE(26) & 0x3fff, 1440 * scale);
      assert.equal(bytes.readUInt16LE(28) & 0x3fff, 862 * scale);
    }
  }
});

test("example tabs support clicks, arrow wraparound, Home/End and matching panels", (t) => {
  const { document, window } = render(t);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.ok(tabs.length >= 4);
  const assertSelected = (index) => {
    tabs.forEach((tab, i) => {
      assert.equal(tab.getAttribute("aria-selected"), String(i === index));
      assert.equal(tab.tabIndex, i === index ? 0 : -1);
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      assert.equal(panel.hidden, i !== index);
      assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
      assert.ok(panel.textContent.trim());
    });
  };
  const key = (index, name) => tabs[index].dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  assertSelected(0);
  tabs[1].click(); assertSelected(1);
  key(1, "End"); assertSelected(tabs.length - 1);
  key(tabs.length - 1, "ArrowRight"); assertSelected(0);
  assert.equal(document.activeElement, tabs[0]);
  key(0, "ArrowLeft"); assertSelected(tabs.length - 1);
  key(tabs.length - 1, "Home"); assertSelected(0);
});

test("the full-size viewer opens the selected screen at its largest size and closes", (t) => {
  const { document } = render(t);
  const dialog = document.querySelector("dialog.landing-zoom");
  const image = dialog.querySelector("img");
  document.querySelector('[role="tab"][aria-controls="work-panel-writing"]').click();
  document.querySelector("#work-panel-writing .landing-zoom-button").click();
  assert.ok(dialog.open);
  assert.equal(image.getAttribute("src"), "/screens/work-writing-2880.webp");
  assert.equal(image.alt, document.querySelector("#work-panel-writing img").alt);
  dialog.querySelector(".landing-zoom-close").click();
  assert.equal(dialog.open, false);
  document.querySelector("#work-panel-research img").click();
  assert.ok(dialog.open);
  assert.equal(image.getAttribute("src"), "/screens/work-research-1440.webp");
});

test("motion is opt-in: reduced motion leaves the page static", (t) => {
  assert.equal(render(t).app.querySelector(".landing-shell").classList.contains("motion-ok"), false);
  assert.equal(render(t, { reducedMotion: false }).app.querySelector(".landing-shell").classList.contains("motion-ok"), true);
});
