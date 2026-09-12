const assert = require('node:assert/strict');
const { app } = require('electron');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const [archive, output, repository] = process.argv.slice(2);
app.setPath('userData', join(output, 'electron-profile'));
(async () => {
  const { createJiti } = require(join(repository, 'node_modules', 'jiti'));
  const jiti = createJiti(__filename, { moduleCache: true, fsCache: false });
  const root = join(archive, 'resources', 'included-tools');
  const chrome = await jiti.import(join(root, 'chrome', 'index.ts'));
  const companionPath = join(output, 'companion');
  const result = await chrome.prepareIncludedChromeCompanion({ companionPath });
  assert.deepEqual(result, { path: companionPath });
  const configPath = join(companionPath, 'host-config.json');
  const firstConfig = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(firstConfig);
  assert.equal(config.mode, 'embedded'); assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  const source = join(archive, 'node_modules', 'pi-chrome', 'extensions', 'chrome-profile-bridge', 'browser-extension');
  let files = 0;
  async function verify(relative = '') {
    for (const entry of await fs.readdir(join(source, relative), { withFileTypes: true })) {
      if (entry.name === 'host-config.json') continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await verify(path);
      else { assert.deepEqual(await fs.readFile(join(companionPath, path)), await fs.readFile(join(source, path))); files++; }
    }
  }
  await verify(); assert.ok(files >= 3);
  await chrome.prepareIncludedChromeCompanion({ companionPath });
  assert.equal(await fs.readFile(configPath, 'utf8'), firstConfig);
  for (const name of ['computer', 'chrome', 'web', 'mcp', 'documents']) {
    const loaded = await jiti.import(join(root, name, 'index.ts'));
    assert.equal(typeof loaded.default, 'function', `${name} factory imports from ASAR`);
  }
  const { AuthStorage, ModelRegistry, SettingsManager } = await jiti.import('@earendil-works/pi-coding-agent');
  const { loadAgentSkillCatalog } = await jiti.import(join(repository, 'src/local/agent/skill-catalog.ts'));
  const agentDir = join(output, 'agent'), stateRoot = join(output, 'catalog-state');
  const authStorage = AuthStorage.inMemory(), modelRegistry = ModelRegistry.inMemory(authStorage);
  const provider = { resolveRuntime: async () => ({ agentDir, authStorage, modelRegistry, settingsManager: SettingsManager.inMemory(), projectTrust: { override: true }, includedTools: { rootPath: root, stateRoot, helperAppPath: join(output, 'Missing Computer.app') } }) };
  for (const name of ['space-a', 'space-b']) {
    const cwd = join(output, name); await fs.mkdir(cwd, { recursive: true });
    const catalog = await loadAgentSkillCatalog(cwd, provider);
    assert.deepEqual(catalog.diagnostics.filter(item => item.type === 'error' || item.type === 'collision'), []);
    assert.equal(catalog.extensions.filter(item => item.source.source === 'Included with work-fold').length, 5);
  }
  await assert.rejects(fs.stat(stateRoot));
  console.log(`PASS Electron ASAR: all five native factories load; ${files} companion files copied byte-for-byte with stable private credential`);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
