import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A closed agent panel stays mounted (its chat keeps its place) and is only
// `hidden`. If any display rule outranks the hidden rule, the closed panel
// still takes a grid cell and the work area wraps into a second row.
test("a closed agent panel takes no space, with the sidebar shown or hidden, in both themes", { timeout: 30_000 }, async (t) => {
  let browser: string | undefined;
  for (const candidate of [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    if (!candidate) continue;
    try { await access(candidate); browser = candidate; break; } catch {}
  }
  if (!browser) { t.skip("Chromium is required for actual layout coverage."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-agent-panel-layout-"));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const sheets = ["brand.css", "styles.css", "application-appearance.css", "panels.css"];
  const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
  const script = `const results=[];const layout=document.querySelector('.work-folder-layout');
  for(const theme of ['light','dark'])for(const collapsed of [false,true])for(const open of [true,false]){
    document.documentElement.dataset.theme=theme;document.querySelector('.app-shell').dataset.theme=theme;
    layout.classList.toggle('sidebar-collapsed',collapsed);layout.classList.toggle('agent-panel-open',open);
    for(const node of layout.querySelectorAll('.agent-panel,.agent-panel-resizer'))node.hidden=!open;
    const panel=document.querySelector('.agent-panel'),tabs=document.querySelector('.right-rail');
    results.push({theme,collapsed,open,panelDisplay:getComputedStyle(panel).display,rows:getComputedStyle(layout).gridTemplateRows.split(' ').length,
      tabsHeight:Math.round(tabs.getBoundingClientRect().height),layoutHeight:Math.round(layout.getBoundingClientRect().height)});
  }document.documentElement.innerHTML='<head></head><body><pre id="result"></pre></body>';document.querySelector('#result').textContent=JSON.stringify(results);`;
  const html = `<!doctype html><html data-theme="light" data-platform="darwin"><head><style>${css}</style></head><body><div class="app-shell" data-theme="light" style="height:700px"><main class="work-folder-layout agent-panel-open" style="height:700px"><nav class="professional-work-folder-rail"></nav><section class="work-folder-mode-pane"></section><button class="work-folder-resizer"></button><aside class="right-rail"></aside><button class="work-folder-resizer agent-panel-resizer"></button><aside class="agent-panel"><div class="popover agent-panel-chat">Chat</div></aside></main></div><script>${script}</script></body></html>`;
  const path = join(scratch, "fixture.html"); await writeFile(path, html);
  const output = await new Promise<string>((done, fail) => {
    const child = spawn(browser!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", "--window-size=1400,800", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { stdio: ["ignore", "pipe", "ignore"] });
    let text = ""; let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); child.stdout.destroy(); error ? fail(error) : done(text); };
    const timer = setTimeout(() => finish(new Error("Chrome did not return the layout fixture.")), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { text += chunk; if (/<pre id="result">\[[^<]+<\/pre>/u.test(text)) finish(); });
    child.on("error", (error) => finish(error));
    child.on("close", () => { if (!settled) finish(new Error("Chrome closed before returning the layout fixture.")); });
  });
  const serialized = /<pre id="result">([^<]*)<\/pre>/u.exec(output)?.[1]; assert.ok(serialized);
  const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Array<{ theme: string; collapsed: boolean; open: boolean; panelDisplay: string; rows: number; tabsHeight: number; layoutHeight: number }>;
  assert.equal(results.length, 8);
  for (const result of results) {
    assert.equal(result.rows, 1, `one grid row: ${JSON.stringify(result)}`);
    assert.equal(result.panelDisplay, result.open ? "flex" : "none", JSON.stringify(result));
    assert.ok(result.tabsHeight >= result.layoutHeight - 60, `the work area keeps its height: ${JSON.stringify(result)}`);
  }
});
