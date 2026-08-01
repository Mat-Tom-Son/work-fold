import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productIdentity = JSON.parse(await readFile(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const expected = {
  apiBaseUrl: "http://127.0.0.1:43123",
  appVersion: "preload-smoke",
  productName: productIdentity.productName,
  internalProtocol: productIdentity.internalProtocol,
};

app.on("window-all-closed", () => {});

let failed = false;
void app.whenReady()
  .then(runSmoke)
  .then(() => console.log("Desktop preload Electron sandbox smoke passed."))
  .catch((error) => {
    failed = true;
    console.error(error);
  })
  .finally(() => app.exit(failed ? 1 : 0));

async function runSmoke() {
  await verifyPreload("preload.cjs", false);
  await verifyPreload("management-popover-preload.cjs", true);
}

async function verifyPreload(filename, managementOnly) {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(rootDir, "dist", "desktop", "desktop", "src", filename),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        rendererArgument("product-name", expected.productName),
        rendererArgument("internal-protocol", expected.internalProtocol),
        rendererArgument("api-base-url", expected.apiBaseUrl),
        rendererArgument("app-version", expected.appVersion),
        rendererArgument("window-material", "vibrancy"),
      ],
    },
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") errors.push(details.message);
  });
  try {
    const document = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
      + "<title>preload smoke</title>";
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
    const bridge = await window.webContents.executeJavaScript(`(() => {
      const value = window.workFoldDesktop;
      return {
        desktop: value?.desktop,
        apiBaseUrl: value?.api?.baseUrl,
        hasSessionHeaders: typeof value?.api?.getSessionHeaders === "function",
        name: value?.app?.name,
        version: value?.app?.version,
        platform: value?.app?.platform,
        iconUrl: value?.app?.iconUrl,
        material: value?.window?.material,
        hasManagement: Boolean(value?.management),
        hasSpace: Boolean(value?.space),
        hasShell: Boolean(value?.shell),
      };
    })()`);

    assert.deepEqual(errors, [], `${filename} must load without sandbox console errors`);
    assert.deepEqual(bridge, {
      desktop: true,
      apiBaseUrl: expected.apiBaseUrl,
      hasSessionHeaders: true,
      name: expected.productName,
      version: expected.appVersion,
      platform: process.platform,
      iconUrl: `${expected.internalProtocol}://app/_desktop-assets/icon-32.png`,
      material: "vibrancy",
      hasManagement: managementOnly,
      hasSpace: !managementOnly,
      hasShell: !managementOnly,
    });
  } finally {
    window.destroy();
  }
}

function rendererArgument(name, value) {
  return `--work-fold-${name}=${encodeURIComponent(value)}`;
}
