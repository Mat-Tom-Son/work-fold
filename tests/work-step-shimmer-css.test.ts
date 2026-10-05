import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const sheets = ["brand.css", "styles.css", "professional-foundation.css", "professional-shell.css", "professional-surfaces.css", "professional-customization.css", "settings-window.css", "application-appearance.css"];

// Windows UAT: with animation effects off, the dark theme painted the shimmer's
// gradient as a box behind "Working…" instead of falling back to plain text.
test("the running-step shimmer clips to text when animated and is plain text under reduced motion, in both themes", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("A Chromium binary is required for the real cascade test; set WORKFOLD_CSS_BROWSER."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-shimmer-css-"));
  try {
    const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"), "the shimmer keeps a reduced-motion fallback");
    // Rewrite the media query so both states are evaluated whatever the host's motion setting is.
    const variants = { animated: css.replaceAll("@media (prefers-reduced-motion: reduce)", "@media not all"), reduced: css.replaceAll("@media (prefers-reduced-motion: reduce)", "@media all") };
    const body = (theme: string) => `<div class="app-shell" data-theme="${theme}"><section class="work-steps running open"><div class="work-steps-rows"><div class="work-steps-list"><div class="work-step working active"><div class="work-step-line"><span class="work-step-verb work-step-shimmer">Working…</span></div></div><div class="work-step tool running active"><div class="work-step-body"><div class="work-step-line"><span class="work-step-verb work-step-shimmer">Running</span><span class="work-step-target command work-step-shimmer">npm test</span><button type="button" class="work-step-target file work-step-shimmer">notes.md</button></div></div></div></div></div></section></div>`;
    const html = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>
      const variants = ${JSON.stringify(variants)};
      const results = [];
      for (const [motion, css] of Object.entries(variants)) for (const theme of ["light", "dark"]) {
        document.head.innerHTML = "<style>" + css + "</style>";
        document.body.innerHTML = ${JSON.stringify(body("light"))}.replace('data-theme="light"', 'data-theme="' + theme + '"');
        for (const element of document.querySelectorAll(".work-step-shimmer")) {
          const style = getComputedStyle(element);
          results.push({ motion, theme, text: element.textContent, clip: style.backgroundClip, image: style.backgroundImage, color: style.color });
        }
      }
      document.body.innerHTML = '<pre id="result"></pre>'; document.getElementById('result').textContent = JSON.stringify(results);
    </script>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    const { stdout } = await exec(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 20_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending", "browser must finish the actual CSS fixture");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Array<{ motion: string; theme: string; text: string; clip: string; image: string; color: string }>;
    assert.equal(results.length, 16);
    for (const item of results) {
      const where = `${item.motion} ${item.theme} "${item.text}"`;
      if (item.motion === "animated") {
        assert.equal(item.clip, "text", `${where}: the gradient is clipped to the glyphs`);
        assert.match(item.image, /linear-gradient/, where);
        assert.equal(item.color, "rgba(0, 0, 0, 0)", `${where}: glyphs show the gradient`);
      } else {
        assert.equal(item.image, "none", `${where}: no gradient box remains behind the text`);
        assert.notEqual(item.color, "rgba(0, 0, 0, 0)", `${where}: text stays visible`);
      }
    }
    const reducedDark = results.find((item) => item.motion === "reduced" && item.theme === "dark")!;
    const reducedLight = results.find((item) => item.motion === "reduced" && item.theme === "light")!;
    assert.notEqual(reducedDark.color, reducedLight.color, "the dark theme keeps its own readable fallback color");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
