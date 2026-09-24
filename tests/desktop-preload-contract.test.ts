import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const preloads = await Promise.all([
  readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/management-popover-preload.cts", import.meta.url), "utf8"),
]);

test("sandboxed desktop preloads only require Electron", () => {
  for (const source of preloads) {
    const requires = [...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]);
    assert.deepEqual(requires, ['"electron"']);
    assert.doesNotMatch(source, /product-identity\.json/);
  }
});

test("main passes centralized product identity into both sandboxed preloads", () => {
  assert.equal((main.match(/\.\.\.productRendererArguments\(\)/g) ?? []).length, 2);
  assert.match(main, /rendererArgument\("product-name", productName\)/);
  assert.match(main, /rendererArgument\("internal-protocol", appProtocol\)/);
  for (const source of preloads) {
    assert.match(source, /argumentValue\("product-name"\)/);
    assert.match(source, /argumentValue\("internal-protocol"\)/);
  }
});

test("desktop preparation runs the real sandboxed preload smoke", () => {
  assert.match(packageJson.scripts["desktop:prepare"], /desktop:preload:smoke/);
  assert.equal(packageJson.scripts["desktop:preload:smoke"], "electron scripts/desktop-preload-electron-smoke.mjs");
});

test("Open with reaches the host only as a Space file reference and launches only the app the dialog returned", () => {
  const [preload] = preloads;
  assert.match(preload, /openPathWith: \(spaceId: string, path: string\) => ipcRenderer\.invoke\("work-fold:space:open-path-with", \{ spaceId, path \}\)/);
  const handler = main.slice(main.indexOf('ipcMain.handle("work-fold:space:open-path-with"'));
  const body = handler.slice(0, handler.indexOf("\n  });\n") + 1);
  assert.match(body, /assertTrustedRenderer\(event\);/);
  assert.match(body, /spacePathRequest\(value, false\)/);
  assert.match(body, /resolveSpaceItem\(request\.spaceId, request\.path\)/);
  assert.match(body, /dialog\.showOpenDialog\(window, options\)/);
  assert.match(body, /return openFileWithPickedApp\(process\.platform, \{/);
  assert.match(body, /return choice\.canceled \? null : choice\.filePaths\[0\] \?\? null;/);
  assert.match(body, /launch: launchOpenWith/);
  assert.doesNotMatch(body, /shell: true|exec\(/);
  assert.match(main, /spawn\(plan\.command, plan\.args, \{ detached: true, stdio: "ignore" \}\)/);
});
