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

test("native clipboard writes require a trusted top-level sender and expose no reads", async () => {
  const inspector = await readFile(new URL("../desktop/src/model-context-preload.cts", import.meta.url), "utf8");
  const restricted = await readFile(new URL("../desktop/src/restricted-app-preload.cts", import.meta.url), "utf8");
  for (const source of [...preloads, inspector]) {
    assert.match(source, /ipcRenderer\.invoke\("work-fold:clipboard:write", content\)/);
    assert.doesNotMatch(source, /clipboard:(?:read|clear)|clipboard\.read/);
  }
  assert.doesNotMatch(restricted, /work-fold:clipboard/);
  const handler = main.slice(main.indexOf('ipcMain.handle("work-fold:clipboard:write"'));
  const body = handler.slice(0, handler.indexOf("\n  });\n"));
  assert.match(body, /modelContextWindow\.assertSender\(event\)/);
  assert.match(body, /assertTrustedRenderer\(event\)/);
  assert.match(body, /frame\.processId !== mainFrame\.processId/);
  assert.match(body, /frame\.routingId !== mainFrame\.routingId/);
  assert.match(body, /writeDesktopClipboard\(value, \(content\) => clipboard\.write\(content\)\)/);
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
