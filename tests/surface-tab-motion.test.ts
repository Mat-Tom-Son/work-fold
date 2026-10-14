import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

test("connected tab motion retargets, settles on layout changes and honors reduced motion in Chromium", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("A Chromium binary is required; set WORKFOLD_CSS_BROWSER."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-tab-motion-"));
  try {
    const css = (await Promise.all(["brand.css", "styles.css", "application-appearance.css"].map(name => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const source = await readFile(resolve("web-local/src/lib/surface-tab-motion.ts"), "utf8");
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("export function", "function");
    const html = `<!doctype html><html data-theme="light" data-appearance-motion="system"><head><style>${css}
      .surface-tabbar { width:700px; } .surface-tab { flex:none!important; max-width:none!important; }
      </style></head><body><div class="app-shell"><div class="surface-tabbar"><div class="surface-tabs" role="tablist">
      <span class="surface-tab-active-chrome" aria-hidden="true"></span>
      <span id="first" class="surface-tab active" style="width:120px"><button class="surface-tab-main">First</button><button class="surface-tab-close">Close</button></span>
      <span id="second" class="surface-tab" style="width:180px"><button class="surface-tab-main">Second</button><button class="surface-tab-close">Close</button></span>
      <span class="surface-tab-group"><span class="surface-tab-group-label">Other folder</span><span class="surface-tab-group-tabs"><span id="third" class="surface-tab" style="width:160px"><button class="surface-tab-main">Third</button><button class="surface-tab-close">Close</button></span></span></span>
      </div></div></div><pre id="result">pending</pre><script>${script}
      (async () => {
        const strip=document.querySelector('.surface-tabs'), chrome=document.querySelector('.surface-tab-active-chrome');
        const tabs=['first','second','third'].map(id=>document.getElementById(id));
        const motion=createSurfaceTabMotion(strip,chrome);
        function select(index,animate=true) { tabs.forEach((tab,i)=>tab.classList.toggle('active',i===index)); motion.select(tabs[index]??null,animate); }
        const box=el=>{const r=el.getBoundingClientRect();return [r.left,r.top,r.width,r.height];};
        select(0,false);
        const result={initial:[box(chrome),box(tabs[0])],tops:tabs.map(tab=>box(tab)[1]),pointer:getComputedStyle(chrome).pointerEvents,hidden:chrome.getAttribute('aria-hidden'),system:matchMedia('(prefers-reduced-motion: reduce)').matches};
        select(1);
        let animation=chrome.getAnimations()[0];
        result.selection={count:chrome.getAnimations().length,duration:animation?.effect.getTiming().duration};
        if(animation) { animation.pause(); animation.currentTime=80; }
        const interrupted=box(chrome);
        select(2);
        animation=chrome.getAnimations()[0];
        result.retarget={from:interrupted,target:box(tabs[2]),keyframe:animation?.effect.getKeyframes()[0]};
        animation?.finish();
        result.settled=[box(chrome),box(tabs[2])];
        strip.scrollLeft=20;
        result.scroll=[box(chrome),box(tabs[2])];
        select(0);
        motion.select(tabs[0],false);
        result.layout={count:chrome.getAnimations().length,boxes:[box(chrome),box(tabs[0])]};
        select(1);
        document.documentElement.dataset.appearanceMotion='reduce';
        await Promise.resolve();
        result.preferenceChange=chrome.getAnimations().length;
        select(2);
        result.reduced={count:chrome.getAnimations().length,boxes:[box(chrome),box(tabs[2])],style:chrome.getAttribute('style'),transform:getComputedStyle(chrome).transform};
        document.documentElement.dataset.appearanceMotion='system';
        select(0);
        strip.style.width='500px'; tabs[0].style.width='135px';
        await new Promise(resolve=>setTimeout(resolve,40));
        result.resize={count:chrome.getAnimations().length,boxes:[box(chrome),box(tabs[0])]};
        tabs[0].remove(); motion.select(null);
        result.empty={visible:getComputedStyle(chrome).visibility,enhanced:strip.dataset.activeChrome,count:chrome.getAnimations().length};
        motion.dispose();
        document.getElementById('result').textContent=JSON.stringify(result);
      })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error.stack}));
      </script></body></html>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    for (const systemReduce of [false, true]) {
      const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", ...(systemReduce ? ["--force-prefers-reduced-motion"] : []), `--user-data-dir=${join(scratch, systemReduce ? "reduced-profile" : "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 25_000, maxBuffer: 5_000_000 });
      const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
      assert.ok(serialized && serialized !== "pending", "browser must finish the motion fixture");
      const result = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
      assert.equal(result.error, undefined, result.stack);
      const aligned = (boxes: number[][], context: string) => boxes[0].forEach((value,index) => assert.ok(Math.abs(value-boxes[1][index])<0.1, `${context}: chrome ${boxes[0]} must align with tab ${boxes[1]}`));
      for (const context of ["initial","settled","scroll"]) aligned(result[context],context);
      for (const context of ["layout","reduced","resize"]) aligned(result[context].boxes,context);
      assert.equal(result.pointer,"none"); assert.equal(result.hidden,"true");
      assert.equal(new Set(result.tops).size,1,"grouped and ungrouped tabs share their top edge");
      assert.equal(result.system,systemReduce);
      assert.equal(result.selection.count,systemReduce ? 0 : 1);
      if (!systemReduce) {
        assert.equal(result.selection.duration,180);
        const offset=Number(/translateX\(([-\d.]+)px\)/.exec(result.retarget.keyframe.transform)![1]);
        assert.ok(Math.abs(offset-(result.retarget.from[0]-result.retarget.target[0]))<0.1,"rapid selection starts at the current interpolated position");
        assert.ok(Math.abs(Number.parseFloat(result.retarget.keyframe.width)-result.retarget.from[2])<0.1,"rapid selection retains the interpolated width");
      }
      for (const key of ["layout","reduced","resize","empty"]) assert.equal(result[key].count,0,key+" settles immediately");
      assert.equal(result.preferenceChange,0,"changing Reduce Motion cancels an in-flight selection");
      assert.equal(result.empty.visible,"hidden"); assert.equal(result.empty.enhanced,undefined);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
