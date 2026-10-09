import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

test("real tab dragging reorders, cancels, scrolls and respects groups and reduced motion", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("Chromium is required for real layout and animation coverage."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-tab-reorder-"));
  try {
    const css = (await Promise.all(["brand.css", "styles.css", "application-appearance.css"].map(name => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const source = await readFile(resolve("web-local/src/lib/surface-tab-reorder.ts"), "utf8");
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("export function", "function");
    const html = `<!doctype html><html data-theme="light" data-appearance-motion="system"><head><style>${css}
      .surface-tabbar { width:600px; } .surface-tab { flex:none!important; width:150px!important; }
      </style></head><body><div class="app-shell"><div class="surface-tabbar"><div class="surface-tabs">
      ${["a", "b", "c", "d"].map((id,index) => `<span class="surface-tab ${index === 0 ? "active" : ""}" data-tab-id="${id}" data-space-id="${index < 2 ? "one" : "two"}"><button class="surface-tab-main">${id}</button><button class="surface-tab-close">Close</button></span>`).join("")}
      </div></div><textarea id="draft">Unsent draft</textarea></div><pre id="result">pending</pre><script>${script}
      (async () => {
        const strip=document.querySelector('.surface-tabs'); const elements=[...strip.querySelectorAll('.surface-tab')];
        const draft=document.getElementById('draft'); let grouped=false; const commits=[],announcements=[];
        const controller=createSurfaceTabReorder(strip,{grouped:()=>grouped,commit:ids=>{commits.push(ids);ids.forEach(id=>strip.append(elements.find(el=>el.dataset.tabId===id)));controller.layout();},announce:(...args)=>announcements.push(args)});
        let pointerId=1;
        const event=(type,x,extra={})=>new PointerEvent(type,{pointerId,isPrimary:true,clientX:x,button:0,bubbles:true,cancelable:true,...extra});
        const left=el=>el.getBoundingClientRect().left;
        function begin(index){const el=elements[index];const x=left(el)+50;controller.begin(event('pointerdown',x),el.dataset.tabId,el.querySelector('button'));return x;}
        function move(x){document.dispatchEvent(event('pointermove',x));}
        function drop(x){document.dispatchEvent(event('pointerup',x));pointerId++;}
        const finishAnimations=async()=>{elements.flatMap(el=>el.getAnimations()).forEach(animation=>animation.finish());await Promise.resolve();await Promise.resolve();};
        const motionCount=()=>elements.flatMap(el=>el.getAnimations()).filter(animation=>animation.effect.getKeyframes().some(frame=>frame.transform!==undefined)).length;
        const result={}; let x=begin(0);move(x+3);drop(x+3);
        result.click={commits:commits.length,suppressed:controller.consumeClick(),state:strip.dataset.reordering};
        x=begin(0); move(x+320);
        result.drag={state:strip.dataset.reordering,lift:elements[0].dataset.dragging,shadow:getComputedStyle(elements[0]).boxShadow,bottomBorder:getComputedStyle(elements[0]).borderBottomWidth,bridge:getComputedStyle(elements[0],'::before').display,animations:elements.flatMap(el=>el.getAnimations()).length};
        drop(x+320);result.drop={ids:commits.at(-1),suppressed:controller.consumeClick(),animations:elements.flatMap(el=>el.getAnimations()).length};
        await finishAnimations();result.settled={state:strip.dataset.reordering,transforms:elements.map(el=>getComputedStyle(el).transform),draftSame:draft===document.getElementById('draft'),draft:draft.value};
        const count=commits.length;x=begin(0);move(x-300);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await finishAnimations();
        result.escape={commits:commits.length-count,ids:[...strip.querySelectorAll('.surface-tab')].map(el=>el.dataset.tabId),state:strip.dataset.reordering};
        x=begin(0);move(x-300);document.dispatchEvent(event('pointercancel',x));await finishAnimations();result.cancel=commits.length-count;
        grouped=true; x=begin(0);move(x+800);drop(x+800);await finishAnimations();result.grouped=commits.at(-1);
        grouped=false;strip.style.width='250px';strip.scrollLeft=0;x=begin(1);move(strip.getBoundingClientRect().right-1);await new Promise(resolve=>setTimeout(resolve,100));result.scroll=strip.scrollLeft;drop(x);await finishAnimations();
        document.documentElement.dataset.appearanceMotion='reduce';await Promise.resolve();x=begin(1);move(x+500);result.reducedDrag=motionCount();drop(x+500);result.reducedDrop=motionCount();await finishAnimations();
        document.documentElement.dataset.appearanceMotion='system';await Promise.resolve();x=begin(1);move(x-500);result.beforePreference=motionCount();document.documentElement.dataset.appearanceMotion='reduce';await Promise.resolve();result.afterPreference=motionCount();document.dispatchEvent(event('pointercancel',x));await finishAnimations();
        result.announcements=announcements;controller.dispose();document.getElementById('result').textContent=JSON.stringify(result);
      })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error.stack}));
      </script></body></html>`;
    const path = join(scratch, "fixture.html"); await writeFile(path, html);
    const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1500", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 25_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending");
    const result = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(result.error, undefined, result.stack);
    assert.deepEqual(result.click, { commits: 0, suppressed: false });
    assert.equal(result.drag.state, "dragging"); assert.equal(result.drag.lift, "true"); assert.equal(result.drag.shadow, "none", "dragging an active tab must keep its bottom open"); assert.equal(result.drag.bottomBorder,"0px"); assert.equal(result.drag.bridge,"block"); assert.ok(result.drag.animations > 0);
    assert.deepEqual(result.drop.ids, ["b", "c", "a", "d"]); assert.equal(result.drop.suppressed, true); assert.ok(result.drop.animations > 0);
    assert.deepEqual(result.settled, { transforms: ["none", "none", "none", "none"], draftSame: true, draft: "Unsent draft" });
    assert.deepEqual(result.escape, { commits: 0, ids: ["b", "c", "a", "d"] }); assert.equal(result.cancel, 0);
    assert.deepEqual(result.grouped, ["b", "c", "a", "d"], "grouped tab cannot cross into another folder");
    assert.ok(result.scroll > 0, "dragging near the edge reveals off-screen tabs");
    assert.equal(result.reducedDrag, 0); assert.equal(result.reducedDrop, 0); assert.ok(result.beforePreference > 0); assert.equal(result.afterPreference, 0);
    assert.ok(result.announcements.some(([id,position,count]: [string,number,number]) => id === "a" && position === 3 && count === 4));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
