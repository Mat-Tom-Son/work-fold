import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";

test("work-folder act mutations invalidate the visible registry without carrying content in the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-work-folder-events-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), workFolderBase: join(root, "work-folders"), loadEnv: false });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${api.origin}/api/work-fold-agent/control-events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    const nextWorkFolderHint = async () => {
      let text = "";
      while (!text.includes('data: {"type":"work-folders"}\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      for (const line of text.split("\n").filter((line) => line.startsWith("data: "))) {
        assert.deepEqual(Object.keys(JSON.parse(line.slice(6))), ["type"]);
      }
    };
    const created = await api.actFacade.createWorkFolder({ name: "Purchasing QA" });
    await nextWorkFolderHint();
    await api.actFacade.workFoldersRename({ workFolder: created.workFolder.id, name: "Purchasing renamed" });
    await nextWorkFolderHint();
    const folder = join(root, "existing"); await mkdir(folder); await writeFile(join(folder, "brief.md"), "Original bytes");
    const registered = await api.actFacade.registerWorkFolder({ workFolderRoot: folder });
    await nextWorkFolderHint();
    await api.actFacade.workFoldersUnregister({ workFolder: registered.workFolder.id });
    await nextWorkFolderHint();
    assert.equal(await readFile(join(folder, "brief.md"), "utf8"), "Original bytes");
    const bootstrap = await (await fetch(`${api.origin}/api/bootstrap`)).json() as { workFolders: Array<{ id: string; name: string }> };
    assert.deepEqual(bootstrap.workFolders.map(({ id, name }) => ({ id, name })), [{ id: created.workFolder.id, name: "Purchasing renamed" }]);
  } finally { clearTimeout(timeout); abort.abort(); await api.close(); await rm(root, { recursive: true, force: true }); }
});
