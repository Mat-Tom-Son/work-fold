/** Real logind/GNOME lock revocation in a provisioned disposable QEMU guest. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';

const run = promisify(execFile);
assert.equal((await run('python3', ['/work/scripts/linux-wayland-probe/fixture-environment.py'])).stdout.trim(), 'vm');
const { stdout: display } = await run('loginctl', ['show-user', String(process.getuid()), '-p', 'Display', '--value']);
const session = display.trim();
assert.match(session, /^[A-Za-z0-9]+$/);
const { stdout: properties } = await run('loginctl', ['show-session', session, '-p', 'User', '-p', 'Type', '-p', 'Active', '-p', 'Service']);
for (const expected of [`User=${process.getuid()}`, 'Type=wayland', 'Active=yes', 'Service=gdm-password']) assert.ok(properties.split('\n').includes(expected));
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const { NativeWaylandTransport } = await jiti.import('/work/src/local/agent/wayland-transport.ts');
const binary = join(resolve(process.argv[2]), 'resources/wayland-helper/work-fold-wayland');
const ui = command => run('python3', ['/work/scripts/linux-wayland-probe/portal-test-ui.py', command], { timeout: 90_000 });
const screenLocked = async () => (await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'])).stdout.trim() === '(true,)';
assert.equal(await screenLocked(), false);
let driver;
async function share() {
  driver = await NativeWaylandTransport.launch(binary);
  const started = driver.call('start'); started.catch(() => {});
  await ui('choose-input'); await started;
  const { lease } = await driver.call('begin', { turn: randomUUID() });
  const observation = await driver.call('observe', { lease });
  assert.equal(observation.kind, 'shared_screen'); assert.ok(observation.image.data.length > 1024);
  return lease;
}
try {
  const lease = await share();
  let ended = false;
  driver.onClose(() => { ended = true; });
  await run('loginctl', ['lock-session', session]);
  const deadline = Date.now() + 30_000;
  while (!ended) { assert.ok(Date.now() < deadline, 'Sharing must revoke after the real GNOME lock'); await delay(100); }
  assert.equal(await screenLocked(), true);
  await assert.rejects(driver.call('observe', { lease }), /sharing ended/);
  console.log('PASS real GNOME lock revokes the native grant and rejects its old lease');
  console.log('WAITING_FOR_FIXTURE_UNLOCK: unlock this disposable guest through its virtual console');
  const unlockDeadline = Date.now() + 180_000;
  while (await screenLocked()) { assert.ok(Date.now() < unlockDeadline, 'The fixture console did not unlock'); await delay(500); }
  await assert.rejects(driver.call('observe', { lease }), /sharing ended/);
  await driver.close();
  await share();
  console.log('PASS unlock does not restore the old grant; a fresh chooser grant captures successfully');
} finally { await driver?.close(); }
