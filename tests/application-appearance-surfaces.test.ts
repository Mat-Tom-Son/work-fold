import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { applicationAppearanceVariables, applicationPalettes, defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import { accentIdentityFromHex, resolveSpaceAppearance, wcagContrast } from "../src/shared/space-appearance.js";

const desktopSheets = ["brand.css", "styles.css", "professional-foundation.css", "professional-shell.css", "professional-surfaces.css", "professional-customization.css", "settings-window.css", "application-appearance.css"];
const popoverSheets = ["brand.css", "popover/popover.css", "application-appearance.css"];
const exec = promisify(execFile);

test("actual desktop and popover CSS honor appearance roles, reading, density and accessibility", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.WORKFOLD_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("A Chromium binary is required for the real cascade test; set WORKFOLD_CSS_BROWSER."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "work-fold-appearance-css-"));
  try {
    const sheets = async (names: string[]) => (await Promise.all(names.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const desktopCss = await sheets(desktopSheets);
    const popoverCss = await sheets(popoverSheets);
    const scenarios = Object.keys(applicationPalettes).flatMap((palette) => (["light", "dark"] as const).map((mode) => {
      const preferences = { ...defaultApplicationAppearance, palette: palette as keyof typeof applicationPalettes, mode, accent: "#f5e600", readingSize: 22, readingFont: "serif" as const, codeFont: "consolas" as const, textSize: "large" as const, density: "compact" as const, measure: "focused" as const, spacing: "relaxed" as const };
      const ground = applicationPalettes[preferences.palette];
      const identity = resolveSpaceAppearance({ primary: accentIdentityFromHex("#953ea3"), grounds: {
        light: { mode: "light", surface: ground.light.surface, canvas: ground.light.canvas, softAlpha: 0.13 },
        dark: { mode: "dark", surface: ground.dark.surface, canvas: ground.dark.canvas, softAlpha: 0.13 },
      } })[mode];
      return { palette, mode, variables: applicationAppearanceVariables(preferences, mode, null, true), identity };
    }));
    const desktopBody = `<div class="app-shell"><div class="space-layout"><nav class="professional-space-rail"></nav><section class="space-mode-pane"><button class="file-row selected"><span class="file-name">Workshop plan.docx</span></button><button class="file-row">Budget.xlsx</button></section></div><aside class="right-rail"><section class="chat-panel"><div class="message-list"><article class="message assistant"><div class="message-body"><h2>Workshop plan</h2><p>Readable paragraphs wrap naturally.</p><p>A second paragraph.</p><div class="message-code-block"><pre><code>const budget = 1200;</code></pre></div></div></article><article class="message user"><div class="message-surface"><div class="message-body"><p>Please update the plan.</p></div></div><span class="message-time">Today</span></article></div><form class="composer"><div class="composer-input-shell"><textarea>Plan a workshop</textarea><button class="send-button">Send</button></div></form></section></aside><section class="settings-modal settings-window"><button class="settings-tab active">Appearance</button><button class="primary-button">Save</button><button class="professional-button professional-button-primary">Install</button><div class="settings-field"><input value="Example"></div></section><span class="space-identity-icon" style="color:var(--space-accent-glyph)">Identity</span></div>`;
    const popoverBody = `<div class="popover"><header><button class="popover-new-chat">New chat</button></header><div class="popover-transcript"><article class="popover-message assistant"><div class="popover-message-body"><p>Workshop ready.</p><pre><code>const budget = 1200;</code></pre></div></article><article class="popover-message user"><div class="popover-message-body">Plan a workshop</div></article></div><form class="composer"><textarea>My draft</textarea><button class="primary">Send</button></form><p class="error-line">Example error</p></div>`;
    const payload = { desktopCss, popoverCss, desktopBody, popoverBody, scenarios };
    // A disposable, non-interactive browser evaluates the exact shipped CSS
    // cascade. It never loads app scripts, an account, or a personal profile.
    const html = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>
      (async () => {
      const payload = ${JSON.stringify(payload).replace(/</g, "\\u003c")};
      const results = [];
      let frame;
      function fixture(css, body, scenario) {
        frame?.remove(); frame = document.createElement('iframe'); frame.style.cssText = 'width:1200px;height:900px'; document.body.append(frame);
        const doc = frame.contentDocument;
        const variables = Object.entries(scenario.variables).map(([key,value]) => key+':'+value).join(';');
        const attributes = 'data-theme="'+scenario.mode+'" data-appearance-palette="'+scenario.palette+'" data-appearance-messages="'+(scenario.messages ?? 'tinted')+'" data-appearance-contrast="more" data-appearance-motion="reduce" data-appearance-transparency="opaque" data-window-material="vibrancy" style="'+variables.replaceAll('"','&quot;')+';color-scheme:'+scenario.mode+'"';
        const names = {solid:'solid', 'on-accent-solid':'onSolid', 'soft-fill':'softFill', 'text-body':'textBody', glyph:'glyph'};
        const identity = Object.entries(names).map(([key,role]) => (key === 'on-accent-solid' ? '--space-on-accent-solid' : '--space-accent-'+key)+':'+scenario.identity[role]).join(';');
        body = body.replace('class="app-shell"','class="app-shell" data-theme="'+scenario.mode+'" style="'+identity+'"');
        doc.open(); doc.write('<!doctype html><html '+attributes+'><head><style>'+css+'</style></head><body>'+body+'</body></html>'); doc.close();
        return selector => frame.contentWindow.getComputedStyle(doc.querySelector(selector));
      }
      function color(value) { const el = frame.contentDocument.createElement('i'); el.style.color = value; frame.contentDocument.body.append(el); const result = frame.contentWindow.getComputedStyle(el).color; el.remove(); return result; }
      for (const scenario of payload.scenarios) {
        const d = fixture(payload.desktopCss, payload.desktopBody, scenario);
        const expected = Object.fromEntries(Object.entries(scenario.variables).filter(([key]) => key.startsWith('--ui-')).map(([key,value]) => [key,color(value)]));
        const result = { name:scenario.palette+'/'+scenario.mode, expected, primary:[d('.primary-button').backgroundColor,d('.primary-button').color], professional:[d('.professional-button-primary').backgroundColor,d('.professional-button-primary').color],
          bodySize:d('body').fontSize, reading:[d('.message.assistant .message-body').fontSize,d('.message.assistant .message-body').fontFamily,d('.message.assistant .message-body').lineHeight], code:d('code').fontFamily,
          rowHeight:d('.file-row').minHeight, settingsRow:d('.settings-tab').minHeight, measure:d('.composer-input-shell').maxWidth, paragraph:d('.message-body p').marginBottom,
          surfaces:[d('body').backgroundColor,d('.professional-space-rail').backgroundColor,d('.space-mode-pane').backgroundColor], tinted:[d('.message.user .message-surface').backgroundColor,d('.message.user .message-body').color], space:[d('.file-row.selected').backgroundColor,d('.space-identity-icon').color],
          expectedSpace:[color(scenario.identity.softFill),color(scenario.identity.glyph),color(scenario.identity.textBody)], motion:d('.message').animationDuration, timeOpacity:d('.message-time').opacity };
        const spaciousScenario = { ...scenario, messages:'quiet', variables: { ...scenario.variables, '--work-fold-list-height':'46px', '--work-fold-list-padding':'11px' } };
        const quiet = fixture(payload.desktopCss, payload.desktopBody, spaciousScenario);
        result.quiet = [quiet('.message.user .message-surface').backgroundColor,quiet('.message.user .message-body').color];
        result.spacious = [quiet('.file-row').minHeight,quiet('.settings-tab').minHeight];
        const p = fixture(payload.popoverCss, payload.popoverBody, scenario);
        result.popoverPrimary = [p('button.primary').backgroundColor,p('button.primary').color];
        result.popoverReading = [p('.popover-message-body').fontSize,p('.popover-message-body').fontFamily]; result.popoverCode = p('code').fontFamily;
        result.popoverRow = p('.popover-new-chat').minHeight; result.surfaces.push(p('body').backgroundColor);
        const popoverQuiet = fixture(payload.popoverCss, payload.popoverBody, spaciousScenario);
        result.quiet.push(popoverQuiet('.popover-message.user').backgroundColor,popoverQuiet('.popover-message.user').color);
        result.spacious.push(popoverQuiet('.popover-new-chat').minHeight);
        results.push(result);
      }
      document.body.innerHTML = '<pre id="result"></pre>'; document.getElementById('result').textContent = JSON.stringify(results);
      })().catch(error => { document.body.innerHTML = '<pre id="result"></pre>'; document.getElementById('result').textContent = JSON.stringify({error:String(error),stack:error.stack}); });
    </script>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    const { stdout } = await exec(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending", "browser must finish the actual CSS fixture");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.length, 10);
    for (const item of results) {
      const expected = item.expected;
      for (const actual of [item.primary, item.professional, item.popoverPrimary]) assert.deepEqual(actual, [expected["--ui-accent-solid"], expected["--ui-on-accent"]], item.name + " primary uses matched solid/text roles");
      assert.equal(item.bodySize, "18px");
      assert.equal(item.reading[0], "22px"); assert.match(item.reading[1], /Georgia/); assert.equal(Number.parseFloat(item.reading[2]), 40.7);
      assert.equal(item.popoverReading[0], "22px"); assert.match(item.popoverReading[1], /Georgia/);
      assert.match(item.code, /Consolas/); assert.match(item.popoverCode, /Consolas/);
      assert.equal(item.rowHeight, "32px"); assert.equal(item.settingsRow, "32px"); assert.equal(item.popoverRow, "32px");
      assert.equal(item.measure, "600px"); assert.equal(Number.parseFloat(item.paragraph), 26.4);
      assert.deepEqual(item.surfaces, [expected["--ui-canvas"], expected["--ui-surface-subtle"], expected["--ui-surface"], expected["--ui-canvas"]], item.name + " opaque covers native material");
      assert.deepEqual(item.tinted, [item.expectedSpace[0], item.expectedSpace[2]], item.name + " tint keeps Space identity");
      assert.deepEqual(item.space, item.expectedSpace.slice(0, 2), item.name + " application accent does not recolor Space identity");
      assert.deepEqual(item.quiet, [expected["--ui-surface-subtle"], expected["--ui-text"], expected["--ui-surface-subtle"], expected["--ui-text"]], item.name + " quiet messages");
      assert.deepEqual(item.spacious, ["46px", "46px", "46px"]); assert.equal(item.motion, "1e-05s"); assert.equal(item.timeOpacity, "1");
      const hex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      assert.ok(wcagContrast(hex(item.primary[0]), hex(item.primary[1])) >= 4.5, item.name + " actual button contrast");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
