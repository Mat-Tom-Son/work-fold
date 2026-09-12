import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createLocalEventSink, createLocalEventChannel, parseLocalEventSubscriptions } from "../src/local/local-event-stream.js";

// A synthetic renderer in development Electron, never the installed app or a
// user profile. Chromium's HTTP/1.1 pool is the failure mode Node fetch misses.
test("Chromium can start, answer and Stop with twelve mounted Chat streams plus file/control subscriptions", { skip: process.platform !== "darwin", timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-event-browser-"));
  const output = await build({ stdin: { contents: `import {api,createEventSource} from ${JSON.stringify(resolve("web-local/src/lib/api.ts"))}; window.fixture={api,createEventSource};`, resolveDir: process.cwd() }, bundle: true, format: "iife", platform: "browser", write: false });
  let activeStreams = 0; let maximumStreams = 0;
  const mutations: string[] = [];
  const batches: Array<ReturnType<typeof parseLocalEventSubscriptions>> = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><title>Isolated local transport fixture</title><script src="/fixture.js"></script>'); return; }
      if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(output.outputFiles[0]!.text); return; }
      if (req.url === "/api/events") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const subscriptions = parseLocalEventSubscriptions(JSON.parse(body)); batches.push(subscriptions);
        const parent = createLocalEventSink(res);
        activeStreams++; maximumStreams = Math.max(maximumStreams, activeStreams);
        parent.onClose(() => { activeStreams--; });
        for (const item of subscriptions) {
          const channel = createLocalEventChannel(parent, item.id);
          channel.send({ type: "turn_snapshot", running: true, text: "Synthetic active work" }, item.lastEventId ? Number(item.lastEventId) + 1 : 17);
          parent.send({ subscriptionId: item.id, ready: true });
        }
        return;
      }
      if (req.url?.startsWith("/fixture/") && req.method === "POST") { mutations.push(req.url); res.setHeader("content-type", "application/json"); res.end('{"accepted":true}'); return; }
      res.writeHead(404).end();
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
  const driver = join(root, "driver.cjs");
  await writeFile(driver, `const {app,BrowserWindow}=require("electron");
app.setPath('userData',${JSON.stringify(join(root, "profile"))}); app.disableHardwareAcceleration();
app.whenReady().then(async()=>{ const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
try { await window.loadURL(${JSON.stringify(origin)}); const result=await window.webContents.executeJavaScript(\`(async()=>{
 const {api,createEventSource}=window.fixture; const streams=[]; let ready=0; let frames=0;
 const paths=Array.from({length:12},(_,i)=>'/api/spaces/lab/conversations/chat-'+i+'/events'); paths.push('/api/spaces/lab/file-events','/api/management/control-events');
 for(const path of paths){const stream=createEventSource(path);stream.onopen=()=>ready++;stream.onmessage=()=>frames++;streams.push(stream);}
 const wait=async(predicate)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Stream pool admission stalled');await new Promise(r=>setTimeout(r,10));}};
 await wait(()=>ready===14); const before=performance.now();
 const accepted=await Promise.race([Promise.all(['start','answer','stop'].map(name=>api('/fixture/'+name,{method:'POST',body:{synthetic:true}}))),new Promise((_,reject)=>setTimeout(()=>reject(Error('Start/answer/Stop starved behind SSE')),1500))]);
 const elapsed=performance.now()-before; const added=createEventSource('/api/spaces/lab/conversations/new/events'); added.onopen=()=>ready++;streams.push(added);
 await wait(()=>ready===29); const cursors=streams.slice(0,14).map(stream=>stream.lastEventId);for(const stream of streams)stream.close();
 return {accepted:accepted.length,elapsed,frames,cursors}; })()\`);console.log('RESULT '+JSON.stringify(result));window.destroy();app.exit(0);}
catch(error){console.error(error.stack);window.destroy();app.exit(1);}});`);
  const electron = createRequire(import.meta.url)("electron") as string;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(electron, [driver], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); }); child.stderr.on("data", (data) => { stderr += String(data); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    child.once("error", reject); child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("RESULT "))!.slice(7));
  assert.equal(evidence.accepted, 3);
  assert.ok(evidence.elapsed < 1500);
  assert.deepEqual(mutations.sort(), ["/fixture/answer", "/fixture/start", "/fixture/stop"]);
  assert.equal(maximumStreams, 1, "all chat/file/control subscriptions share one physical connection, including reconnect");
  assert.equal(batches.length, 2);
  assert.ok(batches[1]!.slice(0, 14).every((item) => item.lastEventId === "17"));
  assert.ok(evidence.cursors.every((cursor: string) => cursor === "18"));
  assert.equal(activeStreams, 0, "renderer disposal closes the physical connection");
});
