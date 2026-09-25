import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Run as a separate disposable Electron process; never open a work-fold
// profile or preload. The parent test supplies desktop-sanitized HTML.
app.setPath("userData", join(process.argv[2], "profile"));
app.on("window-all-closed", () => {});
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

async function run() {
  const serverSource = await readFile(new URL("../../services/bridge/server.mjs", import.meta.url), "utf8");
  const policy = /const viewerPageShellContentSecurityPolicy = "([^"]+)"/.exec(serverSource)?.[1];
  if (!policy) throw new Error("The viewer page shell policy was not found.");
  const viewer = await readFile(new URL("../../services/bridge/public/viewer/viewer.js", import.meta.url), "utf8");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/viewer.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(viewer);
    } else if (request.url !== "/") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("h1 { font-weight: bold; }");
    } else {
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": policy });
      response.end('<!DOCTYPE html><main id="probe-root"></main>');
    }
  });
  let window;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const body = (await readFile(join(process.argv[2], "source.html"), "utf8")).replaceAll("__PROBE_ORIGIN__", origin);
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await window.loadURL(origin);
    await window.webContents.executeJavaScript(`import('/viewer.js').then(({ renderPayload }) => new Promise(resolve => {
      const root = document.getElementById('probe-root');
      renderPayload(root, { v: 1, mediaType: 'text/html', document: true, body: ${JSON.stringify(body)} });
      root.querySelector('iframe').addEventListener('load', resolve, { once: true });
    }))`);
    window.webContents.debugger.attach("1.3");
    const { targetInfos } = await window.webContents.debugger.sendCommand("Target.getTargets");
    const target = targetInfos.find(target => target.type === "iframe" && target.url.startsWith("blob:"));
    if (!target) throw new Error("The sandboxed document frame target was not found.");
    const { sessionId } = await window.webContents.debugger.sendCommand("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const { result } = await window.webContents.debugger.sendCommand("Runtime.evaluate", { returnByValue: true, expression: `(() => {
      let parentReadable = false;
      try { parentReadable = !!parent.document; } catch {}
      return {
        heading: document.querySelector('h1')?.textContent,
        color: getComputedStyle(document.querySelector('h1')).color,
        imageWidth: document.querySelector('#embedded').naturalWidth,
        scriptRan: globalThis.pageScriptRan === true,
        parentReadable,
      };
    })()` }, sessionId);
    const document = result.value;
    console.log(JSON.stringify({ requests, document }));
  } finally {
    window?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
