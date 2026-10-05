import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderLanding } from "./public/landing.js";

function render(t, { reducedMotion = true, media, setup } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: "https://www.work-fold.com" });
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.window = dom.window;
  globalThis.matchMedia = media ?? (() => ({ matches: reducedMotion }));
  t.after(() => {
    dom.window.close();
    for (const key of ["window", "matchMedia"]) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  });
  const app = dom.window.document.querySelector("#app");
  setup?.(dom.window);
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
  assert.equal(brandImages.length, 1);
  assert.match(brandImages[0].getAttribute("src"), /^\/brand-lockup-(white|black)\.png$/);
  assert.equal(document.querySelectorAll("h1").length, 1);
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

// Reads the canvas size from a lossy (VP8) WebP header.
function webpSize(bytes) {
  assert.equal(bytes.toString("latin1", 0, 4), "RIFF");
  assert.equal(bytes.toString("latin1", 8, 12), "WEBP");
  assert.equal(bytes.toString("latin1", 12, 16), "VP8 ");
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

async function sources(img) {
  return [img.getAttribute("src"), ...(img.getAttribute("srcset") || "").split(",").map((entry) => entry.trim().split(" ")[0]).filter(Boolean)];
}

test("every workflow screen shares one frame size, has a description, and matches its file", async (t) => {
  const { document } = render(t);
  const screens = [...document.querySelectorAll(".landing-shot-media img")];
  assert.ok(screens.length >= 5);
  for (const img of screens) {
    assert.ok(img.alt.trim());
    assert.equal(img.getAttribute("width"), "1440");
    assert.equal(img.getAttribute("height"), "862");
    for (const src of await sources(img)) {
      assert.ok(src.startsWith("/screens/") && src.endsWith(".webp"), src);
      const size = webpSize(await readFile(new URL(`./public${src}`, import.meta.url)));
      const scale = Number(src.match(/-(\d+)\.webp$/)[1]) / 1440;
      assert.deepEqual(size, { width: 1440 * scale, height: 862 * scale });
    }
  }
});

test("every workflow is reachable by scrolling: nothing waits behind a tab, carousel, or disclosure", (t) => {
  const { document } = render(t);
  const main = document.querySelector("main");
  assert.equal(main.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"], details').length, 0);
  assert.equal(main.querySelectorAll("[hidden]").length, 0);
  const folders = [...main.querySelectorAll(".landing-folder")];
  assert.ok(folders.length >= 5);
  for (const folder of folders) {
    const title = document.getElementById(folder.getAttribute("aria-labelledby"));
    assert.ok(title && title.textContent.trim(), "each folder is named by its tab");
    assert.ok(folder.querySelector(".landing-shot-media img"), "each folder shows its screen");
    const zoom = folder.querySelector("button[data-zoom]");
    assert.ok(zoom && zoom.getAttribute("aria-label"), "each screen has a labelled full-size control");
  }
});

test("web access is shown with the real web client captures at their own proportions", async (t) => {
  const { document } = render(t);
  const captures = [...document.querySelectorAll(".landing-devices img")];
  assert.ok(captures.length >= 2);
  assert.ok(document.querySelector(".landing-devices .landing-phone img"), "a phone capture is shown");
  for (const img of captures) {
    assert.ok(img.alt.trim());
    const size = webpSize(await readFile(new URL(`./public${img.getAttribute("src")}`, import.meta.url)));
    assert.deepEqual(size, { width: Number(img.getAttribute("width")), height: Number(img.getAttribute("height")) });
  }
});

test("the full-size viewer opens the chosen screen at its largest size and closes", (t) => {
  const { document } = render(t);
  const dialog = document.querySelector("dialog.landing-zoom");
  const image = dialog.querySelector("img");
  document.querySelector("#folder-writing .landing-zoom-button").click();
  assert.ok(dialog.open);
  assert.equal(image.getAttribute("src"), "/screens/work-writing-2880.webp");
  assert.equal(image.alt, document.querySelector("#folder-writing .landing-shot-media img").alt);
  dialog.querySelector(".landing-zoom-close").click();
  assert.equal(dialog.open, false);
  document.querySelector("#folder-research .landing-shot-media img").click();
  assert.ok(dialog.open);
  assert.equal(image.getAttribute("src"), "/screens/work-research-1440.webp");
});

test("motion is opt-in: reduced motion leaves the page static", (t) => {
  const still = render(t).app;
  assert.equal(still.querySelector(".landing-shell").classList.contains("motion-ok"), false);
  assert.equal(still.querySelector(".landing-app .landing-shot-media").style.getPropertyValue("--reveal"), "");
});

test("with motion, scrolling drives the app reveal and device drift through custom properties", async (t) => {
  const { app, window } = render(t, { reducedMotion: false });
  assert.ok(app.querySelector(".landing-shell").classList.contains("motion-ok"));
  const media = app.querySelector(".landing-app .landing-shot-media");
  const devices = app.querySelector(".landing-devices");
  assert.match(media.style.getPropertyValue("--reveal"), /^[01]\.\d{3}$/);
  assert.match(devices.style.getPropertyValue("--drift"), /^[01]\.\d{3}$/);
  media.style.removeProperty("--reveal");
  window.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(media.style.getPropertyValue("--reveal"), /^[01]\.\d{3}$/);
  // Without room to stack (the stub reports no match), folders keep no stack state.
  for (const folder of app.querySelectorAll(".landing-stack .landing-folder")) assert.equal(folder.dataset.state, undefined);
});

test("keyboard focus on the hero copy returns a stacked page to its readable start", async (t) => {
  // A wide screen with motion: the stack is on, reduced motion is off.
  const { app, window } = render(t, { media: (query) => ({ matches: !query.includes("reduce") }) });
  const calls = [];
  window.scrollTo = (options) => { calls.push(options); };
  Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
  app.querySelector(".landing-hero-copy .landing-download").dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls.at(-1), { top: 0, behavior: "instant" });
});

test("the inbox reveal follows its frame rather than feeding the scaled image back into itself", async (t) => {
  const { app, window } = render(t, { reducedMotion: false });
  const media = app.querySelector(".landing-app .landing-shot-media");
  const frame = media.closest(".landing-shot");
  const frameTop = window.innerHeight * 0.6;
  frame.getBoundingClientRect = () => ({ top: frameTop });
  media.getBoundingClientRect = () => { assert.fail("motion must not measure its own transformed image"); };
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(media.style.getPropertyValue("--reveal"), "0.444", "the same scroll position produces the same reveal");
  }
});

test("native hero scrolling measures only on layout changes and leaves frame tracking to CSS", async (t) => {
  let heroReads = 0;
  const { app, window } = render(t, {
    media: (query) => ({ matches: !query.includes("reduce") }),
    setup(window) {
      window.CSS = { supports: () => true };
      Object.defineProperty(window.document.documentElement, "clientWidth", { value: 1280 });
      Object.defineProperty(window, "innerHeight", { value: 720 });
      window.Element.prototype.getBoundingClientRect = function () {
        if (this.classList.contains("landing-hero")) {
          heroReads++;
          return { bottom: 720 - window.scrollY };
        }
        if (this.classList.contains("landing-hero-copy")) return { top: 200 - window.scrollY, right: 500, height: 340 };
        return { top: 720 - window.scrollY, left: 200, width: 880, height: 612 };
      };
    },
  });
  const shell = app.querySelector(".landing-shell");
  const inner = app.querySelector(".landing-folder-inner");
  assert.ok(shell.classList.contains("css-scroll"));
  assert.ok(Number.isFinite(parseFloat(inner.style.getPropertyValue("--hero-scale"))));
  const endpoints = inner.style.cssText;
  const initialReads = heroReads;
  Object.defineProperty(window, "scrollY", { configurable: true, value: 320 });
  window.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(heroReads, initialReads, "scroll frames do not force hero layout reads");
  assert.equal(inner.style.cssText, endpoints, "scroll frames do not replace the compositor's transform");
  assert.equal(shell.querySelector(".landing-hero-copy").style.getPropertyValue("--fade"), "");
  window.dispatchEvent(new window.Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(heroReads > initialReads, "viewport changes update the endpoints");
});

test("the hero fallback reaches the same settled frame and retraces its start without remeasuring", async (t) => {
  let heroReads = 0;
  const { app, window } = render(t, {
    media: (query) => ({ matches: !query.includes("reduce") }),
    setup(window) {
      Object.defineProperty(window.document.documentElement, "clientWidth", { value: 1280 });
      Object.defineProperty(window, "innerHeight", { value: 720 });
      window.Element.prototype.getBoundingClientRect = function () {
        if (this.classList.contains("landing-hero")) { heroReads++; return { bottom: 720 - window.scrollY }; }
        if (this.classList.contains("landing-hero-copy")) return { top: 200 - window.scrollY, right: 500, height: 340 };
        return { top: 720 - window.scrollY, left: 200, width: 880, height: 612 };
      };
    },
  });
  const inner = app.querySelector(".landing-folder-inner");
  const start = inner.style.cssText;
  assert.ok(parseFloat(inner.style.getPropertyValue("--tx")) > 0);
  assert.ok(parseFloat(inner.style.getPropertyValue("--sc")) < 1);
  Object.defineProperty(window, "scrollY", { configurable: true, value: 720 });
  window.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(inner.style.getPropertyValue("--tx"), "0px");
  assert.equal(inner.style.getPropertyValue("--ty"), "0px");
  assert.equal(inner.style.getPropertyValue("--sc"), "1");
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  window.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(inner.style.cssText, start);
  assert.equal(heroReads, 1);
});

test("the apps chapter shows each slot as a real capture or a clearly labelled placeholder", async (t) => {
  const { document } = render(t);
  const chapter = document.querySelector(".landing-hands");
  assert.ok(chapter.querySelector('a[href="https://chromewebstore.google.com/detail/work-fold/ophmjbphcjmjcpcdpmfehbldiomkepgk"] use[href="#landing-icon-chrome"]'));
  const slots = [...chapter.querySelectorAll(".landing-handoff > figure")];
  assert.equal(slots.length, 3);
  for (const slot of slots) {
    const img = slot.querySelector("img");
    if (img) {
      assert.ok(img.alt.trim());
      const size = webpSize(await readFile(new URL(`./public${img.getAttribute("src")}`, import.meta.url)));
      assert.deepEqual(size, { width: Number(img.getAttribute("width")), height: Number(img.getAttribute("height")) });
    } else {
      // Never a stand-in image: an empty slot says plainly what real capture belongs there.
      assert.ok(slot.classList.contains("is-pending") && slot.dataset.captureNeeded);
      assert.ok(slot.textContent.trim());
    }
  }
});

test("each app capture opens full size from a labelled button, with its own description", (t) => {
  const { document } = render(t);
  const dialog = document.querySelector("dialog.landing-zoom");
  const buttons = [...document.querySelectorAll(".landing-handoff button[data-zoom]")];
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.ok(button.getAttribute("aria-label"));
    button.click();
    assert.ok(dialog.open);
    assert.match(dialog.querySelector("img").getAttribute("src"), /^\/screens\/apps-.+\.webp$/);
    assert.ok(dialog.querySelector("img").alt.trim());
    dialog.querySelector(".landing-zoom-close").click();
  }
});

test("with motion, web access lights one level of the hierarchy at a time", (t) => {
  const { app } = render(t, { reducedMotion: false });
  const section = app.querySelector(".landing-web");
  assert.match(section.dataset.step, /^[012]$/);
  assert.match(section.style.getPropertyValue("--route"), /^[01]\.\d{3}$/);
  const levels = [...section.querySelectorAll(".landing-route li")];
  const devices = [...section.querySelectorAll(".landing-devices > figure")];
  assert.equal(levels.length, 3);
  assert.equal(devices.length, levels.length, "one device per level, in the same order");
  assert.ok(devices[0].classList.contains("landing-phone"));
});
