import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinuxHelperClient } from "@injaneity/pi-computer-use/src/platform/linux/helper.ts";

test("Linux helper cancellation drains the native process and never redispatches an uncertain action", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-linux-stop-")); t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, "helper"), started = join(root, "started"), effects = join(root, "effects");
  await writeFile(helper, `#!${process.execPath}
const fs=require('node:fs');
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));
process.stdin.once('data',data=>{
  const message=JSON.parse(data.toString());
  if(message.cmd==='diagnostics') {
    let overlap=false;
    try { process.kill(Number(fs.readFileSync(${JSON.stringify(started)},'utf8')),0); overlap=true; } catch {}
    process.stdout.write(JSON.stringify({protocolVersion:4,id:message.id,ok:true,result:{overlap}})+'\\n');
    return;
  }
  fs.writeFileSync(${JSON.stringify(started)},String(process.pid));
  fs.appendFileSync(${JSON.stringify(effects)},'dispatch\\n');
  setInterval(()=>fs.appendFileSync(${JSON.stringify(effects)},'effect\\n'),10);
});
`); await chmod(helper, 0o755);
  const old = process.env.PI_COMPUTER_USE_NO_RUNTIME_INSTALL;
  process.env.PI_COMPUTER_USE_NO_RUNTIME_INSTALL = "1";
  t.after(() => { if (old === undefined) delete process.env.PI_COMPUTER_USE_NO_RUNTIME_INSTALL; else process.env.PI_COMPUTER_USE_NO_RUNTIME_INSTALL = old; });
  const client = new LinuxHelperClient({ helperPath: helper }); t.after(() => client.dispose());
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.command("act", {}, { signal: cancelled.signal }), /abort/i);
  await assert.rejects(readFile(started), { code: "ENOENT" });
  const controller = new AbortController();
  const operation = client.command("act", {}, { signal: controller.signal });
  const rejected = assert.rejects(operation, (error: any) => error.code === "interrupted_unknown");
  let pid = 0;
  const deadline = Date.now() + 5_000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(started, "utf8")); } catch {}
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid, "helper accepted the action"); controller.abort();
  const recovery = client.command<{ overlap: boolean }>("diagnostics");
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "cancellation settles only after the helper exits");
  assert.equal((await recovery).overlap, false, "a concurrent observation waits for the old helper to drain before restarting");
  assert.equal((await readFile(effects, "utf8")).split("dispatch").length - 1, 1);
});
