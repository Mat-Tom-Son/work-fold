import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderLanding } from "./public/landing.js";

function render(t, { reducedMotion = true, observer } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: "https://www.work-fold.com" });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.window = dom.window;
  globalThis.matchMedia = () => ({ matches: reducedMotion });
  if (observer) {
    dom.window.IntersectionObserver = observer;
    globalThis.IntersectionObserver = observer;
  }
  t.after(() => {
    dom.window.close();
    for (const key of ["window", "matchMedia", "IntersectionObserver"]) {
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
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const link of document.querySelectorAll('a[href^="#"]')) assert.ok(document.querySelector(link.getAttribute("href")));
  assert.ok(document.querySelector('a[href="/download/macos"]'));
  assert.ok(document.querySelector('a[href="https://github.com/Mat-Tom-Son/work-fold"]'));
  assert.ok(document.querySelector('a[href$="/CONTRIBUTING.md"]'));
  for (const link of document.querySelectorAll("a")) {
    assert.ok(link.textContent.trim() || link.getAttribute("aria-label"), "links have accessible names");
    if (link.target === "_blank") assert.ok(link.rel.includes("noreferrer") || link.rel.includes("noopener"));
    assert.ok(["https:", "http:"].includes(new URL(link.href).protocol));
  }
});

test("every rendered screenshot exists, has a description, and declares dimensions and the correct format", async (t) => {
  const { document } = render(t);
  const screenshots = [...document.querySelectorAll('img[src^="/screens/"]')];
  assert.ok(screenshots.length > 0);
  for (const img of screenshots) {
    assert.ok(img.alt.trim());
    const bytes = await readFile(new URL(`./public${img.getAttribute("src")}`, import.meta.url));
    assert.ok(img.width > 0 && img.height > 0);
    if (img.src.endsWith(".png")) {
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.equal(img.width, bytes.readUInt32BE(16));
      assert.equal(img.height, bytes.readUInt32BE(20));
    } else {
      assert.ok(img.src.endsWith(".jpg"));
      assert.equal(bytes.toString("hex", 0, 3), "ffd8ff");
    }
  }
});

test("example tabs support clicks, arrow wraparound, Home/End and matching panels", (t) => {
  const { document, window } = render(t);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
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

test("optional capability details can be opened and closed", (t) => {
  const { document } = render(t);
  for (const details of document.querySelectorAll("details")) {
    const before = details.open;
    details.querySelector("summary").click();
    assert.equal(details.open, !before);
    details.querySelector("summary").click();
    assert.equal(details.open, before);
  }
});

test("reduced motion and missing observer keep content visible without a reveal dependency", (t) => {
  const { app } = render(t, { reducedMotion: false });
  assert.equal(app.querySelector(".landing-shell").classList.contains("motion-ready"), false);
});

test("scroll reveals unobserve visible sections and reduced motion bypasses observation", (t) => {
  const observed = [], removed = [];
  let deliver;
  class Observer {
    constructor(callback) { deliver = callback; }
    observe(element) { observed.push(element); }
    unobserve(element) { removed.push(element); }
  }
  const { app } = render(t, { reducedMotion: false, observer: Observer });
  assert.ok(observed.length);
  deliver([{ target: observed[0], isIntersecting: false }]);
  assert.equal(removed.length, 0);
  deliver([{ target: observed[0], isIntersecting: true }]);
  assert.ok(observed[0].classList.contains("is-visible"));
  assert.deepEqual(removed, [observed[0]]);
  globalThis.matchMedia = () => ({ matches: true });
  observed.length = 0;
  renderLanding(app);
  assert.equal(observed.length, 0);
  assert.equal(app.querySelector(".landing-shell").classList.contains("motion-ready"), false);
});
