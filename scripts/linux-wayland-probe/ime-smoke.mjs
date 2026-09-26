/** Native Pinyin preedit/commit through the packaged helper in an owned VM. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import puppeteer from 'puppeteer-core';

const run = promisify(execFile);
assert.equal((await run('python3', ['/work/scripts/linux-wayland-probe/fixture-environment.py'])).stdout.trim(), 'vm');
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const { NativeWaylandTransport } = await jiti.import('/work/src/local/agent/wayland-transport.ts');
const binary = join(resolve(process.argv[2]), 'resources/wayland-helper/work-fold-wayland');
const root = await mkdtemp('/tmp/workfold-ime-');
const inputRoot = join(root, 'input');
console.log('IME evidence:', root);
const setting = ['org.gnome.desktop.input-sources', 'sources'];
const previousSources = (await run('gsettings', ['get', ...setting])).stdout.trim();
const previousEngine = (await run('ibus', ['engine'])).stdout.trim();
assert.match((await run('ibus', ['list-engine'])).stdout, /libpinyin/);
const events = async () => JSON.parse(await readFile(join(inputRoot, 'events.json'), 'utf8'));
async function until(check, label) {
  const end = Date.now() + 30_000;
  while (!await check()) { assert.ok(Date.now() < end, label); await delay(100); }
}
let fixture, driver, lease, observation;
async function act(actions) {
  observation = await driver.call('observe', { lease });
  return driver.call('act', { lease, observation: observation.observationId, actions });
}
async function capture(name) {
  observation = await driver.call('observe', { lease });
  await writeFile(join(root, name + '.png'), Buffer.from(observation.image.data, 'base64'));
}
async function checkComposer() {
  const packageRoot = resolve(process.argv[2]);
  const state = join(root, 'state'), agent = join(root, 'pi'), folder = join(root, 'IME folder');
  await Promise.all([state, agent, folder].map(path => mkdir(path, { mode: 0o700 })));
  const env = { ...process.env, WORKFOLD_DESKTOP_STATE_DIR: state, WORKFOLD_STATE_DIR: state,
    WORKFOLD_CLI_STATE_DIR: state, WORKFOLD_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, WORKFOLD_DISABLE_LOGIN_SHELL_ENV: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  let output = '', browser, page, phase = 'startup';
  const app = spawn(join(packageRoot, 'work-fold-desktop'), ['--ozone-platform=wayland', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-65536); });
  try {
    await until(async () => { assert.equal(app.exitCode, null); return output.includes('DevTools listening on ws://127.0.0.1:'); }, 'The installed app did not start');
    browser = await puppeteer.connect({ browserWSEndpoint: output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)[1], defaultViewport: null });
    await until(async () => { page = (await browser.pages()).find(item => item.url().startsWith('work-fold-desktop://app/')); return !!page; }, 'App renderer unavailable');
    const automation = await page.createCDPSession();
    await automation.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    phase = 'onboarding';
    await page.waitForSelector('.onboarding-choose');
    const registered = JSON.parse((await run(join(packageRoot, 'bin/work-fold'), ['spaces', 'register', '--path', folder, '--json'], { env, timeout: 30_000 })).stdout);
    assert.notEqual(registered.ok, false);
    phase = 'Chat navigation';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[aria-label="Chats"]');
    await page.$eval('button[aria-label="Chats"]', button => button.click());
    await page.waitForSelector('button[title="New Chat"]');
    await page.$eval('button[title="New Chat"]', button => button.click());
    await page.waitForSelector('.space-surface-body:not([hidden]) textarea[aria-label="Message worker"]');
    phase = 'native focus';
    await automation.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await act([{ action: 'click', x: 500, y: 400 }]);
    await page.$eval('.space-surface-body:not([hidden]) textarea[aria-label="Message worker"]', field => {
      window.imeEvidence = [];
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']) {
        field.addEventListener(type, event => window.imeEvidence.push({ type, data: event.data, key: event.key,
          keyCode: event.keyCode, isComposing: event.isComposing, value: field.value }));
      }
      field.focus();
    });
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    assert.equal(await page.$eval('.space-surface-body:not([hidden]) textarea[aria-label="Message worker"]', field => document.activeElement === field), true);
    await capture('composer-focused');
    phase = 'composition';
    await act([{ action: 'typeText', text: 'nihao' }]);
    await until(async () => page.evaluate(() => window.imeEvidence.some(event => event.type === 'compositionstart')), 'Electron did not receive native composition');
    await capture('composer-preedit');
    await act([{ action: 'keypress', keys: ['space'] }]);
    await until(async () => page.$eval('.space-surface-body:not([hidden]) textarea[aria-label="Message worker"]', field => field.value === '你好'), 'Electron did not commit the Pinyin candidate');
    assert.equal(await page.$$eval('.message.user', nodes => nodes.length), 0, 'Composition must not send a Worker message');
    await capture('composer-committed');
    const starts = await page.evaluate(() => window.imeEvidence.filter(event => event.type === 'compositionstart').length);
    await act([{ action: 'typeText', text: 'nihao' }]);
    await until(async () => page.evaluate(starts => window.imeEvidence.filter(event => event.type === 'compositionstart').length > starts, starts), 'A second composition did not start');
    await act([{ action: 'keypress', keys: ['Enter'] }]);
    await until(async () => page.$eval('.space-surface-body:not([hidden]) textarea[aria-label="Message worker"]', field => field.value === '你好nihao'), 'Pinyin Enter confirmation did not retain the draft');
    assert.equal(await page.$$eval('.message.user', nodes => nodes.length), 0, 'IME Enter must not send a Worker message');
    await writeFile(join(root, 'composer-events.json'), JSON.stringify(await page.evaluate(() => window.imeEvidence), null, 2));
    await page.evaluate(() => window.workFoldDesktop.window.setCloseToTray(false));
    await act([{ action: 'keypress', keys: ['Alt', 'F4'] }]);
    await until(async () => app.exitCode !== null || app.signalCode !== null, 'App did not quit');
    assert.equal(app.exitCode, 0); assert.equal(app.signalCode, null);
    console.log('PASS installed Electron Worker composer receives native IBus preedit, exact Chinese candidate commit, and Enter composition confirmation without sending; native Quit succeeds');
  } catch (error) {
    console.error('Composer failure during', phase, error);
    if (page) {
      console.error('Owned composer UI:', (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 4000));
      await writeFile(join(root, 'composer-events.json'), JSON.stringify(await page.evaluate(() => window.imeEvidence ?? []).catch(() => []), null, 2));
    }
    throw error;
  } finally {
    await writeFile(join(root, 'app.log'), output);
    await browser?.disconnect();
    if (app.exitCode === null && app.signalCode === null) {
      const done = new Promise(resolve => app.once('exit', resolve)); app.kill('SIGTERM'); await done;
    }
  }
}
try {
  await run('gsettings', ['set', ...setting, "[('ibus', 'libpinyin')]"]);
  await until(async () => (await run('ibus', ['engine'])).stdout.trim() === 'libpinyin', 'GNOME did not select libpinyin');
  fixture = spawn('python3', ['/work/scripts/linux-wayland-probe/input-fixture.py'], {
    env: { ...process.env, GTK_IM_MODULE: 'ibus', WORKFOLD_NATIVE_INPUT_FIXTURE: inputRoot }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  fixture.stderr.on('data', bytes => process.stderr.write(bytes));
  await until(async () => (await events().catch(() => ({}))).mapped, 'Owned GTK fixture did not map');
  driver = await NativeWaylandTransport.launch(binary);
  const started = driver.call('start'); started.catch(() => {});
  await run('python3', ['/work/scripts/linux-wayland-probe/portal-test-ui.py', 'choose-input'], { timeout: 90_000 });
  await started;
  ({ lease } = await driver.call('begin', { turn: randomUUID() }));
  await act([{ action: 'click', x: 500, y: 160 }]);
  await until(async () => (await events()).entryFocused, 'Native click did not focus the input');
  assert.equal((await run('ibus', ['engine'])).stdout.trim(), 'libpinyin');
  // Latin keys enter the real input method. No Unicode setter, clipboard,
  // candidate injection or composition API participates in this phase.
  await act([{ action: 'typeText', text: 'nihao' }]);
  await until(async () => (await events()).preedit.length > 0, 'The input method did not expose preedit');
  const preedit = await events();
  assert.equal(preedit.text, '', 'Pinyin must remain uncommitted before selecting a candidate');
  await writeFile(join(root, 'preedit.json'), JSON.stringify(preedit, null, 2));
  await capture('preedit');
  await act([{ action: 'keypress', keys: ['space'] }]);
  await until(async () => (await events()).text === '你好' && (await events()).preedit === '', 'Pinyin candidate did not commit exact Chinese text');
  await act([{ action: 'keypress', keys: ['Ctrl', 's'] }]);
  await until(async () => (await readFile(join(inputRoot, 'saved.txt'), 'utf8').catch(() => null)) === '你好', 'Committed IME text did not save exactly');
  await capture('committed');
  if (process.env.WORKFOLD_VM_IME_APP === '1') {
    const done = new Promise(resolve => fixture.once('exit', resolve)); fixture.kill('SIGTERM'); await done;
    await checkComposer();
  }
  await driver.call('end', { lease });
  console.log('PASS real IBus/libpinyin preedit → native Space candidate commit → exact GTK saved bytes: 你好; packaged portal/libei input');
} finally {
  await driver?.close();
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    const done = new Promise(resolve => fixture.once('exit', resolve)); fixture.kill('SIGTERM'); await done;
  }
  await run('gsettings', ['set', ...setting, previousSources]);
  // GNOME owns the Wayland layout. `ibus engine xkb:…` additionally invokes
  // X11 setxkbmap; restoring the GNOME sources restores the engine itself.
  await until(async () => (await run('ibus', ['engine'])).stdout.trim() === previousEngine, 'GNOME did not restore the original input method');
}
