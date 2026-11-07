import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

test("shared motion cancels running effects and removes exits when either Reduce Motion switch changes", { timeout: 60_000 }, async (t) => {
  let browser: string | undefined;
  for (const candidate of [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[]) {
    try { await access(candidate); browser = candidate; break; } catch {}
  }
  if (!browser) { t.skip("Chromium is required for motion verification."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-shared-motion-"));
  try {
    const css = (await Promise.all(["brand.css", "styles.css", "application-appearance.css", "motion.css"].map(name => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const source = await readFile(resolve("web-local/src/lib/motion.ts"), "utf8");
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("export function", "function");
    const html = `<!doctype html><html data-theme="light" data-appearance-motion="system"><head><style>${css}</style></head><body>
      <div id="mover" style="width:100px;height:30px"></div><span class="chat-activity-dot"></span><pre id="result">pending</pre>
      <script>${script}
      (async () => {
        const system = new EventTarget(); system.matches = false;
        window.matchMedia = () => system;
        const dispose = startExitMotion();
        const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
        const mover = document.getElementById('mover'), dot = document.querySelector('.chat-activity-dot');
        const results = [];
        for (const preference of ['app', 'system']) {
          document.documentElement.dataset.appearanceMotion = 'system'; system.matches = false;
          const dialog = document.createElement('div'); dialog.className = 'modal-backdrop';
          dialog.innerHTML = '<section role="dialog" aria-modal="true" id="qa-dialog"><input id="qa-input" data-tree-row="true" value="fixture"></section>';
          document.body.append(dialog); await flush(); dialog.remove(); await flush();
          const ghost = document.querySelector('[data-exit-ghost]');
          glideFrom(mover, {left: -50, top: -50}); settleIn([mover]); slideIn(mover, 'right'); celebrateFinish(dot);
          const effects = document.getAnimations().filter(a => a.effect instanceof KeyframeEffect && a.constructor.name !== 'CSSAnimation');
          effects.forEach(a => { a.pause(); a.currentTime = 50; });
          const result = {preference, started:effects.length, ghost:!!ghost, inert:ghost?.inert, hidden:ghost?.getAttribute('aria-hidden'), hooks:ghost?.querySelectorAll('[id], [role], [aria-modal], [data-tree-row]').length};
          if (preference === 'app') document.documentElement.dataset.appearanceMotion = 'reduce';
          else { system.matches = true; system.dispatchEvent(new Event('change')); }
          await flush();
          result.remaining = effects.filter(a => a.playState !== 'idle').length;
          result.ghosts = document.querySelectorAll('[data-exit-ghost]').length;
          glideFrom(mover, {left:-100, top:-100}); settleIn([mover]); slideIn(mover, 'left'); celebrateFinish(dot);
          result.newEffects = document.getAnimations().filter(a => a.effect instanceof KeyframeEffect && a.constructor.name !== 'CSSAnimation').length;
          results.push(result);
        }
        dispose(); document.getElementById('result').textContent = JSON.stringify(results);
      })().catch(error => document.getElementById('result').textContent=JSON.stringify({error:String(error), stack:error.stack}));
      </script></body></html>`;
    const path = join(scratch, "fixture.html"); await writeFile(path, html);
    const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 40_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending", "motion fixture must complete");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.error, undefined, results.stack);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.ok(result.started >= 7, `${result.preference}: dialog exit, glide, settle, slide, and both finish effects must run`);
      assert.equal(result.ghost, true); assert.equal(result.inert, true); assert.equal(result.hidden, "true"); assert.equal(result.hooks, 0);
      assert.equal(result.remaining, 0, `${result.preference}: running scripted effects must stop`);
      assert.equal(result.ghosts, 0, `${result.preference}: leaving copies must be removed immediately`);
      assert.equal(result.newEffects, 0, `${result.preference}: no new scripted effects while reduced`);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
