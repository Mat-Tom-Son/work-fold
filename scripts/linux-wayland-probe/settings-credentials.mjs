/** Real Settings/keyring persistence on a previously tested private VM profile. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const run = promisify(execFile);
assert.equal((await run('python3', ['/work/scripts/linux-wayland-probe/fixture-environment.py'])).stdout.trim(), 'vm');
const packageRoot = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
assert.match(root, /^\/tmp\/workfold-packaged-desktop-[A-Za-z0-9]+$/);
assert.equal(await realpath(root), root);
assert.equal((await lstat(root)).uid, process.getuid());
const agent = join(root, 'pi'), state = join(root, 'state');
const modelsPath = join(agent, 'models.json');
const models = JSON.parse(await readFile(modelsPath, 'utf8'));
assert.equal(models.providers['desktop-fixture'].apiKey, 'synthetic-not-a-secret');
const provider = 'native-credential-fixture';
const secret = 'synthetic-native-settings-key-never-used-with-a-provider';
assert.equal(models.providers[provider], undefined, 'Use a fresh fixture profile for each credential test');
models.providers[provider] = {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
  models: [{ id: 'keyring-fixture', name: 'Keyring fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
};
await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
const env = { ...process.env, WORKFOLD_DESKTOP_STATE_DIR: state, WORKFOLD_STATE_DIR: state, WORKFOLD_CLI_STATE_DIR: state,
  WORKFOLD_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, WORKFOLD_DISABLE_LOGIN_SHELL_ENV: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const executable = join(packageRoot, 'work-fold-desktop');
let app, browser, page, output = '';
async function until(test) {
  const deadline = Date.now() + 180_000;
  while (!await test()) { assert.ok(Date.now() < deadline, 'Private Settings condition timed out'); await delay(200); }
}
async function click(text) {
  await page.waitForFunction(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === text && !b.disabled), { polling: 200 }, text);
  await page.evaluate(text => {
    const matches = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === text && !b.disabled);
    if (matches.length !== 1) throw new Error('Ambiguous Settings control');
    matches[0].click();
  }, text);
}
async function open() {
  output = '';
  app = spawn(executable, ['--ozone-platform=wayland', '--remote-debugging-port=0'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { output = (output + data).slice(-32768); });
  await until(async () => { assert.equal(app.exitCode, null); return /DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//.test(output); });
  browser = await puppeteer.connect({ browserWSEndpoint: output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)[1], defaultViewport: null, protocolTimeout: 90_000 });
  await until(async () => { page = (await browser.pages()).find(p => p.url().startsWith('work-fold-desktop://app/')); return !!page; });
  page.setDefaultTimeout(180_000);
  await (await page.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForSelector('button[aria-label="Settings"]');
  await page.$eval('button[aria-label="Settings"]', b => b.click());
  await page.$eval('#settings-tab-assistant', b => b.click());
  await page.waitForSelector('select[aria-label="Provider"]');
  assert.deepEqual(await page.select('select[aria-label="Provider"]', provider), [provider]);
}
async function close() {
  await browser?.disconnect(); browser = undefined;
  if (app?.pid) {
    const signal = value => { try { process.kill(-app.pid, value); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    signal('SIGTERM');
    for (let i = 0; i < 100 && app.exitCode === null && app.signalCode === null; i++) await delay(100);
    if (app.exitCode === null && app.signalCode === null) signal('SIGKILL');
    app.stdout.destroy(); app.stderr.destroy(); app = undefined;
  }
}
try {
  await open();
  await page.waitForSelector('#assistant-api-key');
  await page.type('#assistant-api-key', secret);
  await click('Connect and save model');
  await page.waitForFunction(() => document.body.innerText.includes('Connected and model saved'), { polling: 200 });
  const encrypted = await readFile(join(state, 'secure-settings.bin'));
  assert.ok(encrypted.length > 32 && !encrypted.includes(Buffer.from(secret)));
  assert.equal(await page.$('#assistant-api-key'), null);
  console.log('PASS native Settings entry: synthetic provider key saved through the real login keyring, encrypted bytes verified');
  await close();
  await open();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove API key'), { polling: 200 });
  assert.equal(await page.$('#assistant-api-key'), null);
  console.log('PASS native Settings cold relaunch: persisted credential decrypts and the connection remains configured');
  await click('Remove API key');
  await page.waitForSelector('#assistant-api-key');
  assert.ok(!(await readFile(join(state, 'secure-settings.bin'))).equals(encrypted));
  console.log('PASS native Settings removal: connection returns to unconfigured without a provider request');
} catch (error) {
  console.error('Owned Settings diagnostics:', output);
  console.error('Owned Settings UI:', (await page?.evaluate(() => document.body.innerText).catch(() => '') || '').slice(0, 6000));
  throw error;
} finally { await close(); }
