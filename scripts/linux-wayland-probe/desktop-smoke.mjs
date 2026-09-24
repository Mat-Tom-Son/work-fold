/** Electron UI + real Wayland portal acceptance on our private seat. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { createJiti } from 'jiti';
import { withDeadline } from './deadline.mjs';

assert.equal(process.env.WORKFOLD_ISOLATED_GNOME_TEST, '1');
assert.equal(existsSync('/tmp/workfold-input-fixture'), false);
const run = promisify(execFile);
const fixtureKind = (await run('python3', ['/work/scripts/linux-wayland-probe/fixture-environment.py'], { timeout: 10_000 })).stdout.trim();
const testSuspend = process.env.WORKFOLD_VM_SUSPEND_TEST === '1';
if (testSuspend) assert.equal(fixtureKind, 'vm', 'Suspend is restricted to the provisioned disposable VM');
// Software-emulated QEMU is deliberately slower than the native container lane.
// Extend only the test driver's deadlines; product/helper deadlines stay intact.
const testTime = milliseconds => milliseconds * (process.env.WORKFOLD_ISOLATED_VM_TEST ? 5 : 1);
const ui = command => run('python3', ['/work/scripts/linux-wayland-probe/portal-test-ui.py', command], { timeout: testTime(25_000) });
await ui('desktop-ready');
const root = await mkdtemp('/tmp/workfold-packaged-desktop-');
console.log(`Evidence: ${root}`);
const appLog = createWriteStream(join(root, 'app.log'), { mode: 0o600, flags: 'wx' });
const state = join(root, 'state'), agent = join(root, 'pi'), folder = join(root, 'Acceptance folder');
await Promise.all([state, agent, folder].map(p => mkdir(p, { mode: 0o700 })));
const development = process.argv[2] === '--development';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageRoot = resolve(development ? repoRoot : process.argv[2] || '/work/out/linux/linux-unpacked');
const executable = development ? 'npm' : join(packageRoot, 'work-fold-desktop');
const launchArgs = development ? ['start', '--', '--ozone-platform=wayland'] : ['--ozone-platform=wayland'];
const cli = development ? join(state, 'development-cli/work-fold') : join(packageRoot, 'bin/work-fold');
const helper = development ? join(repoRoot, 'out/included-tools/wayland-helper/work-fold-wayland')
  : join(packageRoot, 'resources/wayland-helper/work-fold-wayland');
console.log(`Launch mode: ${development ? 'prepared development app via npm start' : 'packaged app'}`);
const expected = 'The packaged app controlled this Wayland screen.';
let phase = 'seed', computerRequests = 0, snapshotRequests = 0, images = 0, continuityStarted = false, releaseContinuity;
const errors = [];
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; assert.ok(body.length < 40 * 1024 * 1024); }
    const payload = JSON.parse(body);
    let tool;
    if (phase === 'setup_snapshot') {
      const last = JSON.stringify(payload.messages.filter(m => m.role === 'tool').at(-1)?.content || '');
      assert.ok(++snapshotRequests <= 3);
      if (snapshotRequests === 1) tool = { name: 'find_roots', arguments: { kind: 'shared_screen' } };
      if (snapshotRequests === 2) {
        const ref = last.match(/@r-shared-[a-f0-9-]{36}/)?.[0]; assert.ok(ref);
        tool = { name: 'observe_ui', arguments: { root: ref, mode: 'visual' } };
      }
      if (snapshotRequests === 3) {
        const image = body.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1]; assert.ok(image);
        await writeFile(join(root, 'sharing-setup.png'), Buffer.from(image, 'base64'));
      }
    }
    if (phase === 'computer') {
      const last = JSON.stringify(payload.messages.filter(m => m.role === 'tool').at(-1)?.content || '');
      assert.ok(++computerRequests <= 4);
      if (body.includes('data:image/png;base64,')) images++;
      if (computerRequests === 1) tool = { name: 'find_roots', arguments: { kind: 'shared_screen' } };
      if (computerRequests === 2) {
        const ref = last.match(/@r-shared-[a-f0-9-]{36}/)?.[0]; assert.ok(ref);
        tool = { name: 'observe_ui', arguments: { root: ref, mode: 'visual' } };
      }
      if (computerRequests === 3) {
        const stateId = last.match(/@shared-[a-f0-9-]{36}/)?.[0]; assert.ok(stateId); assert.ok(images);
        tool = { name: 'act_ui', arguments: { stateId, actions: [
          { action: 'click', x: 500, y: 160 }, { action: 'typeText', text: expected },
          { action: 'keypress', keys: ['Ctrl', 's'] },
        ] } };
      }
      if (computerRequests === 4) assert.match(last, /Input sent; verify/);
    }
    if (phase === 'continuity') {
      continuityStarted = true;
      await new Promise(resolve => { releaseContinuity = resolve; });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta, reason) => response.write(`data: ${JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion.chunk', created: 1, model: 'desktop-fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    if (tool) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${computerRequests}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null);
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'Packaged desktop acceptance completed.' }, null); send({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  } catch (error) { errors.push(error); response.writeHead(500); response.end('Isolated fixture rejected unexpected behavior'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'desktop-fixture': {
  api: 'openai-completions', apiKey: 'synthetic-not-a-secret', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  models: [{ id: 'desktop-fixture', name: 'Desktop fixture', reasoning: false, input: ['text', 'image'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }), { mode: 0o600 });
const env = { ...process.env, WORKFOLD_DESKTOP_STATE_DIR: state, WORKFOLD_STATE_DIR: state, WORKFOLD_CLI_STATE_DIR: state,
  WORKFOLD_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, WORKFOLD_DISABLE_LOGIN_SHELL_ENV: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
delete env.WORKFOLD_CLI_APP;
// Only the external fixture driver needs this launcher. The app configures its
// own Worker environment, as exercised separately by the CLI regression lane.
const cliEnv = development ? { ...env, WORKFOLD_CLI_APP: join(state, 'development-cli/app') } : env;
let app, browser, fixture, output = '', page, automation;
async function until(test, milliseconds = 20_000) {
  const deadline = Date.now() + testTime(milliseconds);
  while (!await withDeadline('Packaged desktop condition', test(), Math.max(1, deadline - Date.now()))) {
    assert.ok(Date.now() < deadline, 'Packaged desktop condition timed out'); await delay(100);
  }
}
async function connectDebugger(endpoint) {
  // protocolTimeout bounds individual CDP calls, not Puppeteer's initial
  // target-discovery wait. The owned app is terminated in finally on failure.
  const connection = puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null,
    protocolTimeout: fixtureKind === 'vm' ? 180_000 : 15_000 });
  try { return await withDeadline('Private debugger attachment', connection, testTime(30_000)); }
  catch (error) {
    // Do not retain a debugger if discovery finishes after our deadline.
    connection.then(late => late.disconnect()).catch(() => {});
    throw error;
  }
}
async function command(...args) {
  const { stdout } = await run(cli, [...args, '--json'], { env: cliEnv, cwd: root, timeout: testTime(45_000), maxBuffer: 3 * 1024 * 1024 });
  const result = JSON.parse(stdout); assert.notEqual(result.ok, false); return result.data;
}
async function clickText(text, selector = 'button') {
  await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].some(b => b.textContent.trim() === text && !b.disabled), { polling: 100 }, text, selector);
  await page.evaluate((text, selector) => {
    const matches = [...document.querySelectorAll(selector)].filter(b => b.textContent.trim() === text && !b.disabled);
    if (matches.length !== 1) throw new Error(`Ambiguous button ${text}: ${matches.length}`);
    matches[0].click();
  }, text, selector);
}
async function changedDesktop(before, after) {
  const pixels = async data => sharp(Buffer.from(data, 'base64')).resize(128, 72).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([pixels(before), pixels(after)]);
  assert.equal(a.length, b.length);
  let changed = 0, count = 0;
  // Ignore the panel/cursor and title bar; minimize must change the actual
  // working area, not merely an indicator or focus decoration.
  for (let i = 128 * 12 * 3; i < a.length; i += 3) {
    count++;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 24) changed++;
  }
  return changed / count;
}
try {
  app = spawn(executable, [...launchArgs, '--remote-debugging-port=0'], { env, cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  app.once('exit', (code, signal) => console.log('Owned app exit:', JSON.stringify({ code, signal })));
  for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { appLog.write(data); output = (output + data).slice(-32768); });
  await until(async () => { assert.equal(app.exitCode, null, 'Packaged app exited during startup'); return /DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//.test(output); }, 45_000);
  const endpoint = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)[1];
  console.log('Packaged app opened its private debugging endpoint');
  // A native dialog can spend up to 75 seconds becoming actionable in TCG,
  // then still needs time to settle its renderer-side IPC promise after Cancel.
  browser = await connectDebugger(endpoint);
  console.log('Private debugger attached; waiting for the main renderer');
  await until(async () => { page = (await browser.pages()).find(p => p.url().startsWith('work-fold-desktop://app/')); return !!page; });
  console.log('Main renderer discovered; waiting for the desktop preload and onboarding');
  page.setDefaultTimeout(testTime(30_000));
  page.on('error', error => console.error('Owned renderer error:', error.message));
  page.on('close', () => console.log('Owned renderer closed'));
  page.on('framedetached', frame => console.log('Owned renderer frame detached:', frame.url()));
  browser.on('disconnected', () => console.log('Private debugger disconnected'));
  automation = await page.createCDPSession();
  // Keep test DOM commands responsive while the portal/fixture covers this
  // renderer. This debugger-only emulation is removed before testing native
  // focus, minimization and background continuity; production keeps throttling.
  await automation.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(() => window.workFoldDesktop?.desktop && document.querySelector('.onboarding-choose'), { polling: 100 });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const tokenPath = join(state, 'cli/act-token.json');
  await until(async () => existsSync(tokenPath), 45_000);
  const tokenMetadata = await lstat(tokenPath);
  assert.equal(tokenMetadata.uid, process.getuid());
  assert.equal(tokenMetadata.mode & 0o077, 0);
  assert.ok(tokenMetadata.isFile() && tokenMetadata.size <= 4096);
  console.log('Private installed CLI act lane is ready');
  await command('spaces', 'register', '--path', folder);
  const spaceId = JSON.parse(await readFile(join(folder, '.work-fold/space.json'), 'utf8')).id;
  await command('spaces', 'assistant', 'model', '--space', spaceId, '--provider', 'desktop-fixture', '--model', 'desktop-fixture');
  const conversationId = (await command('chat', 'create', '--space', spaceId)).conversation.id;
  await command('chat', 'rename', '--space', spaceId, '--conversation', conversationId, '--title', 'Wayland desktop acceptance');
  let task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Create the disposable desktop acceptance Chat.');
  assert.equal((await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)))).task.state, 'succeeded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[aria-label="Add or manage"]');
  await page.$eval('button[aria-label="Add or manage"]', button => button.click());
  await clickText('Skills & Extensions', '[role="menuitem"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.capabilities-resource-card strong')].some(b => b.textContent === 'Computer control'), { polling: 100 });
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.capabilities-resource-card')].find(b => b.querySelector('strong')?.textContent === 'Computer control')?.querySelector('button');
    if (!button) throw new Error('Computer card unavailable'); button.click();
  });
  const section = 'section[aria-label="Wayland screen sharing"]';
  const chooseChat = async () => {
    const selector = `${section} select`, value = `space:${conversationId}`;
    // The setup panel renders before its asynchronous Chat list arrives.
    // Selecting an absent option silently clears the select in Puppeteer.
    await page.waitForFunction((selector, value) => [...(document.querySelector(selector)?.options || [])].some(option => option.value === value),
      { polling: 100 }, selector, value);
    assert.deepEqual(await page.select(selector, value), [value]);
  };
  await chooseChat();
  await clickText('Choose screen');
  await ui('wait');
  await clickText('Stop sharing');
  await ui('closed');
  await page.waitForSelector(`${section} select`);
  console.log('PASS packaged setup: explicit Chat selection and Stop closes the real pending chooser');
  await chooseChat();
  await clickText('Choose screen'); await ui('choose-input');
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('This screen is shared with the chosen Chat.'), { polling: 100 }, section);
  // Capture the actual compositor through the shipped path. CDP screenshots
  // are not the product's Wayland backend and may stall on a background page.
  phase = 'setup_snapshot';
  task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Observe the disposable desktop setup once without sending input.');
  assert.equal((await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)))).task.state, 'succeeded');
  assert.equal(snapshotRequests, 3);
  // Present the test editor after setup so real seat input has an explicit,
  // independently checked foreground target. No personal desktop is involved.
  fixture = spawn('python3', ['/work/scripts/linux-wayland-probe/input-fixture.py'], { stdio: 'ignore' });
  await until(async () => existsSync('/tmp/workfold-input-fixture/events.json') && JSON.parse(await readFile('/tmp/workfold-input-fixture/events.json', 'utf8')).active);
  phase = 'computer';
  task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Complete the isolated screen edit and save task.');
  const settled = await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)));
  assert.equal(settled.task.state, 'succeeded', JSON.stringify(settled.task));
  assert.deepEqual(errors, []); assert.equal(computerRequests, 4); assert.ok(images >= 2);
  await until(async () => existsSync('/tmp/workfold-input-fixture/saved.txt'));
  assert.equal(await readFile('/tmp/workfold-input-fixture/saved.txt', 'utf8'), expected);
  fixture.kill('SIGTERM'); fixture = undefined;
  await clickText('Stop sharing');
  await page.waitForSelector(`${section} select`);
  console.log('PASS packaged UI → warm Chat → actual Pi → bundled portal/capture/input → exact saved bytes → Stop');
  if (testSuspend) {
    await chooseChat();
    await clickText('Choose screen'); await ui('choose-input');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('This screen is shared with the chosen Chat.'), { polling: 100 }, section);
    phase = 'continuity'; continuityStarted = false;
    task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Complete after this disposable computer wakes from sleep.');
    await until(async () => continuityStarted);
    console.log('WAITING_FOR_FIXTURE_RESUME: requesting guest suspend; observe sleep, then wake and unlock its virtual console');
    // The host observes QEMU enter suspended state before issuing system_wakeup.
    // No simulated Electron event stands in for the real logind sleep cycle.
    await run('sudo', ['systemctl', 'suspend', '--no-block']);
    const saverActive = async () => (await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'])).stdout.trim() === '(true,)';
    await until(saverActive, 30_000);
    await until(async () => !await saverActive(), 60_000);
    console.log('Guest unlocked; app process status:', JSON.stringify({ exitCode: app.exitCode, signalCode: app.signalCode }));
    assert.equal(app.exitCode, null);
    assert.equal(app.signalCode, null);
    // The private debugger socket can disconnect across actual OS sleep.
    // Reattach to the same still-running app; never relaunch or reload it to
    // make a continuity test pass. Product state is checked independently.
    await browser.disconnect();
    browser = await connectDebugger(endpoint);
    const wakePages = await withDeadline('Renderer discovery after wake', browser.pages(), testTime(30_000));
    console.log('Renderer targets after wake:', JSON.stringify(wakePages.map(p => ({ url: p.url(), closed: p.isClosed() }))));
    page = wakePages.find(p => p.url() === 'work-fold-desktop://app/index.html');
    assert.ok(page, 'The original app must retain its main window after sleep');
    page.setDefaultTimeout(testTime(30_000));
    automation = await page.createCDPSession();
    await automation.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.waitForSelector(`${section} select`);
    assert.ok(!(await page.$eval(section, el => el.textContent)).includes('This screen is shared with the chosen Chat.'));
    releaseContinuity();
    assert.equal((await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)))).task.state, 'succeeded');
    assert.equal(app.exitCode, null);
    await chooseChat();
    await clickText('Choose screen'); await ui('choose-input');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('This screen is shared with the chosen Chat.'), { polling: 100 }, section);
    phase = 'setup_snapshot'; snapshotRequests = 0;
    task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Verify the newly granted screen after waking without sending input.');
    assert.equal((await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)))).task.state, 'succeeded');
    assert.equal(snapshotRequests, 3);
    await clickText('Stop sharing'); await page.waitForSelector(`${section} select`);
    console.log('PASS real guest suspend/resume: accepted turn persisted, sharing stayed revoked, fresh chooser grant captured successfully');
  }
  await page.$eval('[aria-label="Close details"]', button => button.click());
  const folderDialog = page.evaluate(() => window.workFoldDesktop.space.chooseFolder());
  folderDialog.catch(() => {});
  await ui('cancel-folder');
  assert.equal(await folderDialog, null);
  await page.evaluate(spaceId => window.workFoldDesktop.space.revealFolder(spaceId), spaceId);
  await ui('folder-visible');
  console.log('PASS packaged native folder dialog/cancel and Show folder opens the exact Folder in Nautilus');
  await page.evaluate(() => window.workFoldDesktop.window.setCloseToTray(true));
  await automation.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  phase = 'continuity'; continuityStarted = false;
  task = await command('chat', 'send', '--space', spaceId, '--conversation', conversationId, '--message', 'Complete after this window is minimized.');
  await until(async () => continuityStarted);
  // Use the compositor's actual close-window shortcut. JavaScript window.close
  // is a web-content lifecycle command, not a desktop window-manager action.
  await run(executable, launchArgs, { env, cwd: repoRoot, timeout: testTime(15_000) });
  const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
  const { NativeWaylandTransport } = await jiti.import('/work/src/local/agent/wayland-transport.ts');
  const driver = await NativeWaylandTransport.launch(helper);
  try {
    const started = driver.call('start');
    started.catch(() => {});
    await ui('choose-input'); await started;
    const { lease } = await driver.call('begin', { turn: randomUUID() });
    const initial = await driver.call('observe', { lease });
    // Wayland may turn programmatic focus into a notification. A real click
    // on this known fixture's exposed title bar establishes the intended target
    // before Alt+F4; otherwise that shortcut could close Nautilus instead.
    await driver.call('act', { lease, observation: initial.observationId, actions: [{ action: 'click', x: 100, y: 50 }] });
    await delay(150);
    assert.equal(await page.evaluate(() => document.hasFocus()), true, 'The work-fold renderer must own focus before closing its window');
    const observation = await driver.call('observe', { lease });
    await writeFile(join(root, 'before-minimize.png'), Buffer.from(observation.image.data, 'base64'));
    await driver.call('act', { lease, observation: observation.observationId, actions: [{ action: 'keypress', keys: ['Alt', 'F4'] }] });
    await delay(500); assert.equal(app.exitCode, null);
    const minimized = await driver.call('observe', { lease });
    await writeFile(join(root, 'after-minimize.png'), Buffer.from(minimized.image.data, 'base64'));
    assert.ok(await changedDesktop(observation.image.data, minimized.image.data) > .15, 'Native close must remove the main window from the compositor image');
    // Chromium can suspend debugger evaluations on a minimized renderer. Check
    // the actual compositor and host-owned task instead of executing hidden JS.
    releaseContinuity();
    assert.equal((await command('chat', 'wait', '--space', spaceId, '--task', task.taskId, '--timeout', String(testTime(30)))).task.state, 'succeeded');
    const switcherTarget = JSON.parse((await ui('work-fold-switcher-target')).stdout.trim());
    const switcherObservation = await driver.call('observe', { lease });
    await driver.call('act', { lease, observation: switcherObservation.observationId, actions: [{ action: 'click', ...switcherTarget }] });
    await delay(500);
    const restored = await driver.call('observe', { lease });
    await writeFile(join(root, 'after-restore.png'), Buffer.from(restored.image.data, 'base64'));
    assert.ok(await changedDesktop(minimized.image.data, restored.image.data) > .15, 'The desktop switcher must restore the native window');
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    assert.equal(await page.evaluate(() => document.hasFocus()), true, 'The named native switcher entry must focus work-fold');
    assert.match(await page.evaluate(() => document.body.innerText), /Skills & Extensions/);
    await run(executable, launchArgs, { env, cwd: repoRoot, timeout: testTime(15_000) });
    console.log('PASS accepted turn survives main-window close/minimize, persists, desktop switcher restores it, and a second instance joins the running app');
    // Exercise the normal compositor close path with background retention off.
    // An OS signal in finally is cleanup, never evidence of a successful Quit.
    await page.evaluate(() => window.workFoldDesktop.window.setCloseToTray(false));
    const beforeQuit = await driver.call('observe', { lease });
    await driver.call('act', { lease, observation: beforeQuit.observationId, actions: [{ action: 'keypress', keys: ['Alt', 'F4'] }] });
    await until(async () => app.exitCode !== null || app.signalCode !== null, 20_000);
    assert.equal(app.exitCode, 0, 'Native Quit must exit successfully');
    assert.equal(app.signalCode, null, 'Native Quit must not require a process signal');
    assert.equal(existsSync(join(state, 'cli', 'act-token.json')), false, 'Quit must remove the per-launch act token');
    console.log('PASS native close with background retention off quits cleanly and removes the per-launch CLI token');
  } finally { await driver.close(); }
  console.log(`Evidence: ${root}`);
} catch (error) {
  console.error('Packaged desktop acceptance failed:', error);
  console.error('Private native UI at failure:', (await ui('dump').catch(() => ({ stdout: 'Unavailable' }))).stdout.slice(0, 14000));
  if (page) console.error('Owned UI at failure:', (await withDeadline('Failure UI diagnostics',
    page.evaluate(() => document.body.innerText), 5_000).catch(error => error.message)).slice(0, 7000));
  console.error('Owned app diagnostics:', output.slice(-4000));
  throw error;
} finally {
  releaseContinuity?.(); fixture?.kill('SIGTERM'); await browser?.disconnect();
  if (app?.pid) {
    const signal = value => { try { process.kill(-app.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    if (app.exitCode === null && app.signalCode === null) signal('SIGTERM');
    for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await delay(100);
    if (app.exitCode === null && app.signalCode === null) signal('SIGKILL');
    app.stdout.destroy(); app.stderr.destroy();
  }
  appLog.end();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
