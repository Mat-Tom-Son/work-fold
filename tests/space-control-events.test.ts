import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";

test("Space act mutations invalidate the visible registry without carrying content in the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-space-events-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${api.origin}/api/management/control-events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    const nextSpaceHint = async () => {
      let text = "";
      while (!text.includes('data: {"type":"spaces"}\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      for (const line of text.split("\n").filter((line) => line.startsWith("data: "))) {
        assert.deepEqual(Object.keys(JSON.parse(line.slice(6))), ["type"]);
      }
    };
    const created = await api.actFacade.createSpace({ name: "Purchasing QA" });
    await nextSpaceHint();
    await api.actFacade.spacesRename({ space: created.space.id, name: "Purchasing renamed" });
    await nextSpaceHint();
    const folder = join(root, "existing"); await mkdir(folder); await writeFile(join(folder, "brief.md"), "Original bytes");
    const registered = await api.actFacade.registerSpace({ spaceRoot: folder });
    await nextSpaceHint();
    await api.actFacade.spacesUnregister({ space: registered.space.id });
    await nextSpaceHint();
    assert.equal(await readFile(join(folder, "brief.md"), "utf8"), "Original bytes");
    const bootstrap = await (await fetch(`${api.origin}/api/bootstrap`)).json() as { spaces: Array<{ id: string; name: string }> };
    assert.deepEqual(bootstrap.spaces.map(({ id, name }) => ({ id, name })), [{ id: created.space.id, name: "Purchasing renamed" }]);
  } finally { clearTimeout(timeout); abort.abort(); await api.close(); await rm(root, { recursive: true, force: true }); }
});
