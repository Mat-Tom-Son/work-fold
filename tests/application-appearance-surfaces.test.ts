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

const desktopSheets = ["brand.css", "styles.css", "application-appearance.css"];
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
    const desktopBody = `<div class="app-shell"><div class="space-layout"><nav class="professional-space-rail"></nav><section class="space-mode-pane"><button class="file-row selected"><span class="file-name">Workshop plan.docx</span></button><button class="file-row">Budget.xlsx</button></section></div><aside class="right-rail"><section class="chat-panel"><div class="message-list"><article class="message assistant"><div class="message-body"><h2>Workshop plan</h2><p>Readable paragraphs wrap naturally.</p><p>A second paragraph.</p><div class="message-code-block"><pre><code>const budget = 1200;</code></pre></div></div></article><article class="message user"><div class="message-surface"><div class="message-body"><p>Please update the plan.</p></div></div><footer class="message-footer"><span class="message-footer-meta"><div class="message-actions"><button class="message-copy-button" aria-label="Copy message">Copy</button></div><time class="message-time">Today</time></span></footer></article></div><form class="composer"><div class="composer-input-shell"><textarea>Plan a workshop</textarea><button class="send-button">Send</button></div></form><section class="work-steps running open"><div class="work-steps-rows"><div class="work-steps-list"><div class="work-step tool complete">Read</div><div class="work-step tool running active">Reading</div></div></div></section></section></aside><section class="settings-modal settings-window"><button class="settings-tab active">Appearance</button><button class="ui-control ui-control--primary">Save</button><button class="ui-control ui-control--primary">Install</button><div class="settings-field"><input value="Example"></div></section><span class="space-identity-icon" style="color:var(--space-accent-glyph)">Identity</span><div class="chat-space-row-shell"><button class="chat-space-row"><strong>Project notes</strong></button></div><div class="surface-tabbar"><div class="surface-tabs"><div class="surface-tab"><button class="surface-tab-main">First Chat</button><button class="surface-tab-close">Close</button></div><div class="surface-tab active"><button class="surface-tab-main">Second Chat</button><button class="surface-tab-close">Close</button></div></div></div><form class="history-file-picker"><label>Compare a file <input placeholder="notes.txt"></label></form><div class="file-preview-markdown"><div class="message-body"><h1>Document</h1><p>A readable file.</p></div></div></div>`;
    const popoverBody = `<div class="popover"><header><button class="popover-new-chat">New Chat</button></header><div class="popover-transcript"><article class="popover-message assistant"><div class="popover-message-body"><p>Workshop ready.</p><pre><code>const budget = 1200;</code></pre></div></article><article class="popover-message user"><div class="popover-message-body">Plan a workshop</div></article></div><form class="composer"><textarea>My draft</textarea><button class="primary">Send</button></form><p class="error-line">Example error</p></div>`;
    // Attribute selectors have the same specificity as these pseudo-classes;
    // this makes each hover/focus cascade deterministic in headless Chromium.
    // Native pointer and keyboard behavior is checked in the dev app too.
    const chatStateCss = desktopCss.replaceAll(":hover", "[data-test-hover]").replaceAll(":active", "[data-test-pressed]").replaceAll(":focus-visible", "[data-test-focus-visible]").replaceAll(":focus-within", "[data-test-focus-within]") + "\n* { transition: none !important; animation: none !important; }";
    const payload = { desktopCss, popoverCss, desktopBody, popoverBody, scenarios, chatStateCss };
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
        const attributes = 'data-platform="'+(scenario.platform ?? '')+'" data-theme="'+scenario.mode+'" data-appearance-palette="'+scenario.palette+'" data-appearance-messages="'+(scenario.messages ?? 'tinted')+'" data-appearance-chat-steps="'+(scenario.chatSteps ?? 'every')+'" data-appearance-contrast="more" data-appearance-motion="reduce" data-appearance-transparency="opaque" data-window-material="'+(scenario.material ?? 'vibrancy')+'" style="'+variables.replaceAll('"','&quot;')+';color-scheme:'+scenario.mode+'"';
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
        const result = { name:scenario.palette+'/'+scenario.mode, expected, primary:[d('.ui-control--primary').backgroundColor,d('.ui-control--primary').color], professional:[d('.ui-control--primary').backgroundColor,d('.ui-control--primary').color],
          bodySize:d('body').fontSize, reading:[d('.message.assistant .message-body').fontSize,d('.message.assistant .message-body').fontFamily,d('.message.assistant .message-body').lineHeight], code:d('code').fontFamily,
          rowHeight:d('.file-row').minHeight, settingsRow:d('.settings-tab').minHeight, measure:d('.composer-input-shell').maxWidth, paragraph:d('.message-body p').marginBottom,
          surfaces:[d('body').backgroundColor,d('.professional-space-rail').backgroundColor,d('.space-mode-pane').backgroundColor], tinted:[d('.message.user .message-surface').backgroundColor,d('.message.user .message-body').color], space:[d('.file-row.selected').backgroundColor,d('.space-identity-icon').color],
          expectedSpace:[color(scenario.identity.softFill),color(scenario.identity.glyph),color(scenario.identity.textBody)], motion:d('.message').animationDuration, timeOpacity:d('.message-time').opacity,
          steps:[d('.work-step.complete').display, d('.work-step.active').display] };
        const q = fixture(payload.chatStateCss, payload.desktopBody, scenario);
        const qa = frame.contentDocument;
        const box = (selector) => qa.querySelector(selector).getBoundingClientRect();
        const user = qa.querySelector('.message.user');
        const shell = qa.querySelector('.composer-input-shell');
        shell.setAttribute('data-test-focus-within','');
        qa.querySelector('.composer textarea').setAttribute('data-test-focus-visible','');
        result.design = { shellOutline:q('.composer-input-shell').outlineStyle, shellOutlineWidth:q('.composer-input-shell').outlineWidth, textareaOutline:q('.composer textarea').outlineWidth,
          copyRight:box('.message.user .message-copy-button').right, bubbleRight:box('.message.user .message-surface').right,
          timeRight:box('.message.user .message-time').right, copyLeft:box('.message.user .message-copy-button').left,
          restTime:q('.message.user .message-time').opacity, tabs:[q('.surface-tab').backgroundColor,q('.surface-tab.active').backgroundColor], close:[q('.surface-tab-close').width,q('.surface-tab-close').opacity],
          fileHeight:box('.file-row').height, chatHeight:box('.chat-space-row-shell').height, documentFont:q('.file-preview-markdown').fontFamily, documentSize:q('.file-preview-markdown').fontSize, documentParagraph:q('.file-preview-markdown p').fontSize, historyField:[q('.history-file-picker input').backgroundColor,q('.history-file-picker input').borderTopWidth,q('.history-file-picker input').borderRadius], settingsField:[q('.settings-field input').backgroundColor,q('.settings-field input').borderTopWidth,q('.settings-field input').borderRadius] };
        qa.documentElement.setAttribute('data-appearance-contrast','system');
        result.design.regularTime=q('.message.user .message-time').opacity;
        user.setAttribute('data-test-hover','');
        result.design.hoverTime=q('.message.user .message-time').opacity;
        const spaciousScenario = { ...scenario, messages:'quiet', variables: { ...scenario.variables, '--work-fold-list-height':'38px', '--work-fold-list-padding':'7px' } };
        const quiet = fixture(payload.desktopCss, payload.desktopBody, spaciousScenario);
        result.quiet = [quiet('.message.user .message-surface').backgroundColor,quiet('.message.user .message-body').color];
        result.spacious = [quiet('.file-row').minHeight,quiet('.settings-tab').minHeight];
        const currentStep = fixture(payload.desktopCss, payload.desktopBody, { ...scenario, chatSteps:'current' });
        result.steps.push(currentStep('.work-step.complete').display, currentStep('.work-step.active').display);
        const p = fixture(payload.popoverCss, payload.popoverBody, scenario);
        result.popoverPrimary = [p('button.primary').backgroundColor,p('button.primary').color];
        result.popoverReading = [p('.popover-message-body').fontSize,p('.popover-message-body').fontFamily]; result.popoverCode = p('code').fontFamily;
        result.popoverRow = p('.popover-new-chat').minHeight; result.surfaces.push(p('body').backgroundColor);
        const popoverQuiet = fixture(payload.popoverCss, payload.popoverBody, spaciousScenario);
        result.quiet.push(popoverQuiet('.popover-message.user').backgroundColor,popoverQuiet('.popover-message.user').color);
        result.spacious.push(popoverQuiet('.popover-new-chat').minHeight);
        result.otherFolder = [];
        const chatBody = '<div class="app-shell"><section class="professional-chats"><div class="chat-other-space"><div class="chat-other-space-header"><button class="chat-other-space-toggle"><span class="space-identity-icon chat-other-space-icon"></span><span>Other folder</span><svg width="16" height="16"></svg><span class="chat-activity-indicator running"><span class="chat-activity-dot"></span></span></button><button class="ui-control ui-control--icon" aria-label="New Chat"></button></div></div></section></div>';
        const c = fixture(payload.chatStateCss, chatBody, scenario);
        const doc = frame.contentDocument;
        const folder = doc.querySelector('.chat-other-space');
        const header = doc.querySelector('.chat-other-space-header');
        const toggle = doc.querySelector('.chat-other-space-toggle');
        const newChat = doc.querySelector('.ui-control--icon');
        const folderName = toggle.children[1];
        for (const width of [160, 320]) {
          folder.style.width = width + 'px';
          folderName.textContent = width === 160 ? 'A very long other work-folder name' : 'Other folder';
          for (const state of ['idle', 'row-hover', 'button-hover', 'row-focus', 'button-focus']) {
            folder.toggleAttribute('data-test-hover', state.endsWith('hover'));
            header.toggleAttribute('data-test-focus-within', state.endsWith('focus'));
            toggle.toggleAttribute('data-test-hover', state === 'row-hover');
            toggle.toggleAttribute('data-test-focus-visible', state === 'row-focus');
            newChat.toggleAttribute('data-test-hover', state === 'button-hover');
            newChat.toggleAttribute('data-test-focus-visible', state === 'button-focus');
            const name = folderName.getBoundingClientRect();
            const text = doc.createRange(); text.selectNodeContents(folderName);
            const visibleNameEnd = Math.min(name.right, text.getBoundingClientRect().right);
            const caret = toggle.querySelector('svg').getBoundingClientRect();
            const row = toggle.getBoundingClientRect();
            const background = ['.chat-other-space', '.chat-other-space-header', '.chat-other-space-toggle', '.ui-control--icon'].map(selector => c(selector).backgroundColor);
            result.otherFolder.push({ width, state, background, border:c('.ui-control--icon').borderTopWidth, shadow:c('.ui-control--icon').boxShadow, opacity:c('.ui-control--icon').opacity, pointer:c('.ui-control--icon').pointerEvents, gap:caret.left-visibleNameEnd, contained:caret.right <= row.right, outline:c(state === 'row-focus' ? '.chat-other-space-toggle' : '.ui-control--icon').outlineStyle, touch:frame.contentWindow.matchMedia('(hover: none)').matches });
          }
        }
        result.windowChrome = [];
        const shellBody = '<div class="app-shell"><main class="space-layout"><nav class="space-mode-rail professional-space-rail"><div class="space-rail-nav"><button class="space-rail-button">Files</button></div></nav><section class="space-mode-pane"><div class="space-pane-header-wrap space-identity-header-wrap"><div class="space-pane-current space-pane-header professional-pane-header space-identity-header"><button class="space-pane-switch-trigger">Folder banner</button></div></div></section><div class="space-resizer"></div><aside class="right-rail"><div class="surface-tabbar"><div class="surface-tabs"><div class="surface-tab active"><button class="surface-tab-main"><span class="surface-tab-icon">Icon</span>Chat tab</button></div></div></div></aside></main></div>';
        for (const platform of ['', 'darwin', 'win32']) {
          for (const material of ['none', 'vibrancy']) {
            const chrome = fixture(payload.desktopCss, shellBody, {...scenario,platform,material});
            const doc = frame.contentDocument;
            const rect = selector => doc.querySelector(selector).getBoundingClientRect();
            const drag = frame.contentWindow.getComputedStyle(doc.querySelector('.app-shell'), '::before');
            const header = rect('.space-pane-header-wrap'), banner = rect('.space-pane-current'), bar = rect('.surface-tabbar'), tab = rect('.surface-tab');
            const activeTab = doc.querySelector('.surface-tab.active');
            const bridge = frame.contentWindow.getComputedStyle(activeTab,'::before');
            const shoulders = frame.contentWindow.getComputedStyle(activeTab,'::after');
            result.windowChrome.push({platform,material,iconDisplay:chrome('.surface-tab-icon').display,padding:chrome('.space-layout').paddingTop,
              bannerGaps:[banner.top-header.top,header.bottom-banner.bottom],tabGaps:[tab.top-bar.top,bar.bottom-tab.bottom],
              tops:['.professional-space-rail','.space-pane-current','.space-pane-switch-trigger','.surface-tabbar','.surface-tab-main','.space-rail-button'].map(selector=>rect(selector).top),
              bottoms:['.professional-space-rail','.space-mode-pane','.right-rail'].map(selector=>rect(selector).bottom),
              bottom:rect('.space-layout').bottom,height:frame.contentWindow.innerHeight,
              rightEdges:[rect('.right-rail').right,bar.right],width:frame.contentWindow.innerWidth,
              paneTopCorners:[chrome('.space-mode-pane').borderTopLeftRadius,chrome('.space-mode-pane').borderTopRightRadius,chrome('.right-rail').borderTopLeftRadius,chrome('.right-rail').borderTopRightRadius],
              connection:{background:chrome('.surface-tab.active').backgroundColor,workBackground:chrome('.right-rail').backgroundColor,bottomBorder:chrome('.surface-tab.active').borderBottomWidth,
                bridgeDisplay:bridge.display,bridgeHeight:bridge.height,bridgeBottom:bridge.bottom,bridgeBackground:bridge.backgroundColor,
                shouldersDisplay:shoulders.display,shouldersBackground:shoulders.backgroundImage,scrollAreaBottom:rect('.surface-tabs').bottom,tabBarBottom:bar.bottom},
              dragHeight:drag.height,dragRegion:drag.getPropertyValue('-webkit-app-region')});
          }
        }
        const feedbackBody = '<div class="app-shell"><button id="neutral" class="ui-control">Open</button><button id="primary" class="ui-control ui-control--primary">Save</button><button id="icon" class="ui-control ui-control--icon">Icon</button><button id="disabled" class="ui-control" disabled>Disabled</button><button id="danger" class="ui-control danger">Delete</button><nav class="professional-space-rail"><button id="rail" class="space-rail-button">Files</button><button id="selectedRail" class="space-rail-button active">Chats</button><div class="space-rail-settings-control"><button id="settings" class="space-rail-account-button">Settings</button></div></nav><div class="surface-tab-new-chat"><button id="newChat" class="surface-tab-action surface-tab-new-chat-main">New</button></div><button id="commands" class="composer-command-trigger">Commands</button><div class="context-menu"><button id="menu">Rename</button></div><div class="chat-actions-menu"><button id="chatMenu">Rename</button><button id="chatDanger" class="danger">Delete</button></div><button id="chatBack" class="chat-actions-back">Back</button><div class="chat-rename-actions"><button id="renameSave" class="primary">Save</button></div><button id="manual" class="checks-manual-button">Set up manually</button><button id="nameSave" class="space-name-save">Save</button><button id="done" class="spaces-pane-done">Done</button><button id="upload" class="space-banner-upload-button">Upload</button><button id="modelTrigger" class="model-catalog-trigger">Model</button><button id="modelOption" class="model-catalog-option">Model option</button><div class="composer-menu"><button id="composerOption">Reasoning</button></div><button id="send" class="send-button">Send</button><div class="space-header-switcher"><button id="switcher" class="space-header-switcher-row">Folder</button></div><button id="palette" class="command-palette-option">Open file</button><div class="composer-command-menu"><button id="model">Model</button></div><button id="copy" class="message-copy-button">Copy</button><button id="file" class="file-row">File</button><button id="selectedFile" class="file-row selected">Selected file</button><div id="chat" class="chat-space-row-shell"><button class="chat-space-row">Chat</button></div><button id="history" class="history-entry">History</button><button id="included" class="capabilities-included-tile">Tool</button><button id="resource" class="capabilities-resource-row">Skill</button><button id="routing" class="fold-routing-list-row">Automation</button><section class="settings-window"><button id="settingsTab" class="settings-tab">Appearance</button></section><div id="search" class="file-tree-search"><input></div><div class="surface-tabbar"><div id="tab" class="surface-tab"><button id="tabMain" class="surface-tab-main">Tab</button><button class="surface-tab-close">Close</button></div></div></div>';
        const feedback = fixture(payload.chatStateCss,feedbackBody,scenario);
        const feedbackDoc = frame.contentDocument;
        const targets = ['neutral','primary','icon','disabled','danger','rail','selectedRail','settings','newChat','commands','menu','chatMenu','chatDanger','chatBack','renameSave','manual','nameSave','done','upload','modelTrigger','modelOption','composerOption','send','switcher','palette','model','copy','file','selectedFile','chat','history','included','resource','routing','settingsTab','search','tab'];
        result.feedback = targets.map(id=>{
          const el=feedbackDoc.getElementById(id), selector='#'+id;
          const sample=()=>{const c=feedback(selector),r=el.getBoundingClientRect();return {background:c.backgroundColor,color:c.color,outline:c.outlineStyle,shadow:c.boxShadow,transform:c.transform,width:r.width,height:r.height};};
          const rest=sample(); el.setAttribute('data-test-hover',''); const hover=sample();
          el.setAttribute('data-test-pressed',''); const pressed=sample(); el.removeAttribute('data-test-pressed'); el.removeAttribute('data-test-hover');
          const focusTarget=el.matches('button') ? el : el.querySelector('button,input') ?? el;
          focusTarget.setAttribute('data-test-focus-visible',''); el.setAttribute('data-test-focus-within','');
          const focus=sample(); if(focus.outline==='none') focus.outline=frame.contentWindow.getComputedStyle(focusTarget).outlineStyle;
          focusTarget.removeAttribute('data-test-focus-visible'); el.removeAttribute('data-test-focus-within');
          return {id,rest,hover,pressed,focus};
        });
        feedbackDoc.getElementById('tabMain').setAttribute('data-test-hover','');
        result.tabMainHover = feedback('#tabMain').backgroundColor;
        result.floating = ['.chat-rename-popover','.file-share-popover','.surface-tab-space-menu','.composer-mention-menu','.composer-menu','.space-header-switcher','.model-catalog-menu'].map(selector=>{ const el=feedbackDoc.createElement('div');el.className=selector.slice(1); feedbackDoc.querySelector('.app-shell').append(el);const c=feedback(selector);return {selector,background:c.backgroundColor,shadow:c.boxShadow}; });
        result.settingsFrames = ['assistant-scope-control','assistant-connection-panel','fold-publication-list','fold-publication-row'].map(name=>{ const window=feedbackDoc.createElement('section');window.className='settings-window';const el=feedbackDoc.createElement(name==='assistant-scope-control'?'fieldset':'div');el.className=name;window.append(el);feedbackDoc.querySelector('.app-shell').append(window);return feedback('.'+name).borderTopWidth; });
        result.feedbackExpected = {hover:color('var(--ui-surface-hover)'),pressed:color('var(--ui-control-pressed)'),primaryHover:color('var(--ui-primary-hover)'),primaryPressed:color('var(--ui-primary-pressed)'),danger:color('var(--ui-danger)'),sendHover:color('color-mix(in srgb,'+scenario.identity.solid+' 28%,var(--ui-surface))'),sendPressed:color('color-mix(in srgb,'+scenario.identity.solid+' 38%,var(--ui-surface))')};
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
      for (const actual of [item.primary, item.professional]) assert.deepEqual(actual, [expected["--ui-accent-soft"], expected["--ui-accent"]], item.name + " desktop primary uses matched soft/text roles");
      assert.deepEqual(item.popoverPrimary, [expected["--ui-accent-solid"], expected["--ui-on-accent"]], item.name + " send uses matched solid/text roles");
      assert.equal(item.bodySize, "18px");
      assert.equal(item.reading[0], "22px"); assert.match(item.reading[1], /Georgia/); assert.equal(Number.parseFloat(item.reading[2]), 40.7);
      assert.equal(item.popoverReading[0], "22px"); assert.match(item.popoverReading[1], /Georgia/);
      assert.match(item.code, /Consolas/); assert.match(item.popoverCode, /Consolas/);
      assert.equal(item.rowHeight, "28px"); assert.equal(item.settingsRow, "28px"); assert.equal(item.popoverRow, "28px");
      assert.equal(item.measure, "600px"); assert.equal(Number.parseFloat(item.paragraph), 26.4);
      assert.deepEqual(item.surfaces, [expected["--ui-canvas"], expected["--ui-surface-subtle"], expected["--ui-surface"], expected["--ui-canvas"]], item.name + " opaque covers native material");
      assert.deepEqual(item.tinted, [item.expectedSpace[0], item.expectedSpace[2]], item.name + " tint keeps Space identity");
      assert.deepEqual(item.space, item.expectedSpace.slice(0, 2), item.name + " application accent does not recolor Space identity");
      assert.deepEqual(item.quiet, [expected["--ui-surface-subtle"], expected["--ui-text"], expected["--ui-surface-subtle"], expected["--ui-text"]], item.name + " quiet messages");
      assert.deepEqual(item.spacious, ["38px", "38px", "38px"]); assert.equal(item.motion, "1e-05s"); assert.equal(item.timeOpacity, "1");
      assert.deepEqual(item.steps, ["grid", "grid", "none", "grid"], item.name + " current-step view hides finished rows while running");
      for (const row of item.otherFolder) {
        const label = item.name + '/' + row.width + '/' + row.state;
        assert.deepEqual(row.background, Array(4).fill("rgba(0, 0, 0, 0)"), label + " keeps the row and New Chat unfilled");
        assert.equal(row.border, "0px", label + " keeps New Chat borderless");
        assert.equal(row.shadow, "none");
        assert.equal(Number(row.opacity), row.state === "idle" ? row.touch ? 0.72 : 0 : 1, label + " reveals New Chat on hover/focus");
        assert.equal(row.pointer, row.state === "idle" && !row.touch ? "none" : "auto");
        assert.ok(Math.abs(row.gap - 7) < 1 && row.contained, label + " keeps the caret beside the name within the row");
        if (row.state.endsWith("focus")) assert.equal(row.outline, "solid", label + " retains a keyboard focus indicator");
      }
      assert.equal(item.design.shellOutline, "solid", item.name + " whole composer owns focus");
      assert.equal(item.design.shellOutlineWidth, "2px"); assert.equal(item.design.textareaOutline, "0px");
      assert.ok(Math.abs(item.design.copyRight - item.design.bubbleRight) <= 1, item.name + " copy aligns with the user bubble right edge");
      assert.ok(item.design.timeRight <= item.design.copyLeft - 7, item.name + " timestamp appears left of copy");
      assert.equal(item.design.restTime, "1", item.name + " higher contrast preserves timestamps"); assert.equal(item.design.hoverTime, "1"); assert.equal(item.design.regularTime, "0");
      assert.notEqual(...item.design.tabs, item.name + " active and resting tabs have distinct surfaces");
      assert.deepEqual(item.design.close, ["24px", "0.7"]); assert.equal(item.design.fileHeight, item.design.chatHeight, item.name + " Files and Chats share density");
      assert.deepEqual(item.design.historyField, item.design.settingsField, item.name + " History uses the shared field style");
      for (const chrome of item.windowChrome) {
        const label = item.name + '/' + chrome.platform + '/' + chrome.material;
        assert.equal(chrome.padding, chrome.platform === 'darwin' ? '32px' : '12px', label + ' uses one compact native title-bar strip without adding another outer gutter');
        assert.deepEqual(chrome.bannerGaps,[8,8],label + ' gives the folder banner equal top/bottom space');
        assert.equal(chrome.iconDisplay,'grid',label+' keeps the folder icon in narrow work panes');
        assert.deepEqual(chrome.tabGaps,[8,8],label + ' gives tabs equal top/bottom space without inherited top padding');
        assert.deepEqual(chrome.rightEdges,[chrome.width,chrome.width],label + ' carries the work area and tab strip to the window edge');
        assert.deepEqual(chrome.paneTopCorners,['0px','11px','11px','0px'],label + ' rounds exposed corners and squares edges that join the rail or window');
        assert.equal(chrome.connection.background,chrome.connection.workBackground,label + ' active tab uses the work surface color');
        assert.equal(chrome.connection.bottomBorder,'0px',label + ' active tab has no bottom separator');
        assert.equal(chrome.connection.bridgeDisplay,'block'); assert.equal(chrome.connection.bridgeHeight,'8px'); assert.equal(chrome.connection.bridgeBottom,'-8px');
        assert.equal(chrome.connection.bridgeBackground,chrome.connection.workBackground,label + ' extends the work background through the bottom gap');
        assert.equal(chrome.connection.shouldersDisplay,'block'); assert.match(chrome.connection.shouldersBackground,/radial-gradient/,label + ' keeps curved shoulders');
        assert.equal(chrome.connection.scrollAreaBottom,chrome.connection.tabBarBottom,label + ' leaves the connection inside the scroll area rather than clipping it');
        assert.ok(chrome.bottom <= chrome.height, label + ' stays within the window');
        assert.ok(chrome.bottoms.every((bottom: number) => bottom <= chrome.height), label + ' keeps every pane within the window');
        if (chrome.platform === 'darwin') {
          assert.equal(chrome.dragHeight, '32px'); assert.equal(chrome.dragRegion, 'drag');
          assert.ok(chrome.tops.every((top: number) => top >= 32), label + ' banner, tabs and Files target clear traffic lights and the drag strip');
        }
      }
      const neutralControls = new Set(['neutral','icon','rail','settings','newChat','commands','menu','chatMenu','chatBack','manual','nameSave','done','upload','modelTrigger','modelOption','composerOption','switcher','palette','model','copy']);
      const neutralRows = new Set(['file','chat','history','included','resource','routing','settingsTab','search']);
      for(const target of item.feedback) {
        const label=item.name+'/'+target.id;
        if(neutralControls.has(target.id)||neutralRows.has(target.id)) assert.equal(target.hover.background,item.feedbackExpected.hover,label+' receives the full demo hover fill');
        if(neutralControls.has(target.id)) assert.equal(target.pressed.background,item.feedbackExpected.pressed,label+' has a distinct pressed fill');
        if(target.id==='primary'||target.id==='renameSave') {
          assert.equal(target.hover.background,item.feedbackExpected.primaryHover); assert.equal(target.pressed.background,item.feedbackExpected.primaryPressed);
          assert.notEqual(target.rest.background,target.hover.background,label+' changes its fill instead of drawing a hover border');
          assert.equal(target.hover.shadow,'none');
        }
        if(target.id==='send') { assert.equal(target.hover.background,item.feedbackExpected.sendHover); assert.equal(target.pressed.background,item.feedbackExpected.sendPressed); assert.equal(target.hover.shadow,'none'); }
        if(target.id==='selectedRail'||target.id==='selectedFile') assert.notEqual(target.rest.background,target.hover.background,label+' strengthens the selected fill on hover');
        if(target.id==='disabled') assert.equal(target.rest.background,target.hover.background,label+' never reacts while disabled');
        if(target.id==='danger'||target.id==='chatDanger') assert.equal(target.hover.color,item.feedbackExpected.danger,label+' retains its destructive intent');
        assert.deepEqual([target.hover.width,target.hover.height],[target.rest.width,target.rest.height],label+' keeps its hit area stable');
        if(target.id==='icon') assert.deepEqual([target.rest.width,target.rest.height],[30,30],label+' retains a square hit area');
        if(neutralControls.has(target.id)) assert.equal(target.hover.transform,'none',label+' never lifts or scales');
        if(target.id!=='disabled') assert.equal(target.focus.outline,'solid',label+' keeps keyboard focus distinct from hover');
      }
      assert.deepEqual(item.settingsFrames,Array(4).fill('0px'),item.name+' Settings uses spacing rather than retained frames');
      for(const floating of item.floating) { assert.equal(floating.background,expected['--ui-surface'],item.name+'/'+floating.selector+' is an opaque menu above content'); assert.notEqual(floating.shadow,'none'); }
      assert.equal(item.tabMainHover,'rgba(0, 0, 0, 0)',item.name+' the whole tab owns hover, including dark mode');
      assert.match(item.design.documentFont, /Georgia/); assert.equal(item.design.documentSize, "22px"); assert.equal(item.design.documentParagraph, "22px");
      const hex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      assert.ok(wcagContrast(hex(item.primary[0]), hex(item.primary[1])) >= 4.5, item.name + " actual button contrast");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
