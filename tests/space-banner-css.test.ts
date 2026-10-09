import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("the actual banner cascade repaints every pattern after an accent edit", { timeout: 45_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("Chromium is required for the banner cascade test."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-banner-css-"));
  try {
    const sheets = ["brand.css", "styles.css", "application-appearance.css"];
    const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const html = `<!doctype html><style>${css}</style><main class="app-shell"><div class="space-appearance-preview space-banner-surface"></div></main><pre id="result">pending</pre><script>
      const app = document.querySelector('.app-shell');
      const preview = document.querySelector('.space-appearance-preview');
      const results = [];
      for (const mode of ['light', 'dark']) {
        app.dataset.theme = mode;
        preview.style.setProperty('--space-banner-secondary-rgb', '92, 124, 46');
        for (const name of ['none', 'classic', 'mist', 'horizon', 'aurora', 'halftone', 'blueprint', 'pinstripe', 'ribbon', 'bold']) {
          preview.className = 'space-appearance-preview space-banner-surface preview-' + mode + ' banner-' + name;
          preview.style.setProperty('--space-banner-primary-rgb', '244, 114, 182');
          const before = getComputedStyle(preview).backgroundImage;
          preview.style.setProperty('--space-banner-primary-rgb', '59, 130, 246');
          const after = getComputedStyle(preview).backgroundImage;
          results.push({ mode, name, before, after, wash: getComputedStyle(preview).getPropertyValue('--space-banner-wash').trim() });
        }
        preview.className = 'space-appearance-preview space-banner-surface preview-' + mode + ' banner-classic has-banner-image';
        results.push({ mode, name: 'image', wash: getComputedStyle(preview).getPropertyValue('--space-banner-wash').trim() });
      }
      document.getElementById('result').textContent = JSON.stringify(results);
    </script>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    const { stdout } = await run(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.length, 22);
    for (const item of results) {
      if (item.name === "none" || item.name === "image") {
        assert.equal(item.wash, "none", `${item.mode} ${item.name} keeps its plain or image background`);
        if (item.name === "none") assert.equal(item.before, item.after);
      } else {
        assert.notEqual(item.before, item.after, `${item.mode} ${item.name} repaints after the primary color changes`);
        assert.match(item.after, /59, 130, 246/);
        if (item.name !== "bold") {
          assert.notEqual(item.wash, "none", `${item.mode} ${item.name} carries the primary color across the banner`);
          assert.match(item.after, /^linear-gradient\(rgba\(59, 130, 246, [\d.]+\), rgba\(59, 130, 246, [\d.]+\)\),/, `${item.mode} ${item.name} keeps its uniform tint above the pattern's neutral fades`);
        }
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
