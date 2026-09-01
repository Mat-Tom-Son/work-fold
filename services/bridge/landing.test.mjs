import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

// Static pins over the shipped landing page (public/landing.js). The bridge
// deploys separately from the desktop, so nothing else keeps this page's
// structure, its download and source links, or its screenshot paths honest.

async function clientSource(file) {
  return await readFile(new URL(`./public/${file}`, import.meta.url), "utf8");
}

const screenshots = [
  "/screens/desktop-space.png",
  "/screens/fold-popover.png",
  "/screens/web-chat.png",
  "/screens/web-phone.png",
];

test("the landing page keeps its product story in order", async () => {
  const landing = await clientSource("landing.js");

  const titles = [...landing.matchAll(/<h2>([^<]*)<\/h2>/g)].map(([, title]) => title.trim());
  assert.deepEqual(titles, [
    "Every Space keeps its own context.",
    "Automation you can account for.",
    "Your fold on the web",
    "The folder is the handoff.",
    "Keep the work. Keep the context.",
  ]);

  assert.match(landing, /<h1>AI work you can hand off\.<\/h1>/);
  assert.ok(landing.includes("Your files stay files. The Space remembers."));

  assert.ok(landing.includes('<span class="section-label">Private alpha</span>'));
  assert.ok(landing.includes("One private address opens the same conversation your menu bar does, while your desktop is online"));

  for (const term of ["Checks", "Routings", "Receipts", "Space apps"]) {
    assert.ok(landing.includes(`<dt>${term}</dt>`));
  }

  assert.ok(landing.includes("<dt>Travels with the Space</dt>"));
  assert.ok(landing.includes("<dt>Stays on each computer</dt>"));
  assert.ok(landing.includes("Credentials, model choices, Space instructions, trust settings, History restore points, sessions, and app preferences."));
});

test("the landing page keeps one download verb and an unlabeled source link", async () => {
  const landing = await clientSource("landing.js");

  // Hero and footer: the same literal action, twice, and nothing else.
  const downloads = landing.match(/<a class="primary-download" href="\/download\/macos">Download for macOS<\/a>/g);
  assert.equal(downloads?.length, 2);
  assert.match(landing, /href="https:\/\/github\.com\/Mat-Tom-Son\/work-fold"/);

  // The host belongs in the tooltip, never in the page text.
  assert.match(landing, /aria-label="View work-fold on GitHub" title="View work-fold on GitHub"/);
  assert.doesNotMatch(landing, />[^<]*\bGitHub\b[^<]*</);
});

test("the landing page shows the four app screenshots at a fixed aspect ratio", async () => {
  const landing = await clientSource("landing.js");
  const styles = await clientSource("landing.css");

  for (const path of screenshots) {
    assert.ok(landing.includes(`src="${path}"`), `${path} is referenced`);
    await access(new URL(`./public${path}`, import.meta.url));
  }

  // Intrinsic sizes plus a CSS aspect-ratio keep the layout stable while the
  // images load, and keep them from being stretched.
  assert.ok(landing.includes('width="1440" height="900"'));
  assert.ok(landing.includes('width="800" height="1120"'));
  assert.ok(landing.includes('width="1280" height="800"'));
  assert.ok(landing.includes('width="375" height="812"'));
  for (const rule of ["aspect-ratio: 16 / 10", "aspect-ratio: 400 / 560", "aspect-ratio: 375 / 812"]) {
    assert.ok(styles.includes(rule), `${rule} is declared`);
  }

  // Everything under the first screenshot loads lazily, and every screenshot
  // says what it shows.
  assert.equal(landing.match(/loading="lazy"/g)?.length, 3);
  assert.equal(landing.match(/<img src="\/screens\/[^"]+\.png"[^>]*alt="[^"]{40,}"/g)?.length, 4);
  assert.doesNotMatch(landing, /<img[^>]*src="\/screens\/[^"]*"[^>]*alt=""/);
});

test("the landing page never brings back the retired marketing copy", async () => {
  const landing = await clientSource("landing.js");
  const page = await clientSource("index.html");

  for (const retired of [
    "Folders first",
    "Work with your desktop folders.",
    "without turning your files into a proprietary workspace",
    "a running history, and simple Spaces",
    "work-fold is a Mac app that gives an ordinary folder an Assistant.",
  ]) {
    assert.equal(landing.includes(retired), false, `${retired} stays retired`);
    assert.equal(page.includes(retired), false, `${retired} stays retired in the page metadata`);
  }

  assert.doesNotMatch(landing, /restricted app/i);
});
