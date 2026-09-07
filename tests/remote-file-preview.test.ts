import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";
import { remoteFilePreviewLimits, type RemoteFilePreview } from "../src/local/remote-file-preview.js";
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";

test("approved-browser file previews are bounded, explicitly Space-scoped and need no model or publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-remote-preview-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false });
  const principal = { browserId: "browser", grantId: "grant", requestId: "read-one" };
  try {
    const { space } = await api.actFacade.createSpace({ name: "Preview files" });
    const { space: other } = await api.actFacade.createSpace({ name: "Other Space" });
    const preview = async (path: string, spaceId = space.id) => (await api.remoteFacade.execute("spaces.filePreview", { spaceId, path }, principal) as { preview: RemoteFilePreview }).preview;
    await writeFile(join(space.spaceRoot, "brief.md"), "# Plan\n\nHello 🌍\n");
    await writeFile(join(other.spaceRoot, "brief.md"), "A different Space");
    const summary = await api.remoteFacade.execute("spaces.list", {}, principal) as { capabilities: { filePreview: boolean } };
    assert.equal(summary.capabilities.filePreview, true);
    const md = await preview("brief.md");
    assert.equal(md.kind, "text");
    if (md.kind !== "text") assert.fail();
    assert.equal(md.format, "markdown");
    assert.equal(md.text, "# Plan\n\nHello 🌍\n");
    assert.equal(md.truncated, false);
    assert.equal(md.path, "brief.md");
    assert.equal(md.spaceId, space.id);
    assert.ok(!JSON.stringify(md).includes(root), "absolute paths never leave the desktop");
    assert.notDeepEqual(await preview("brief.md", other.id), md);
    await writeFile(join(space.spaceRoot, "large.txt"), "a".repeat(remoteFilePreviewLimits.textBytes - 1) + "🐈 more");
    const truncated = await preview("large.txt");
    assert.equal(truncated.kind, "text");
    if (truncated.kind !== "text") assert.fail();
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.text.length, remoteFilePreviewLimits.textBytes - 1);
    assert.ok(!truncated.text.includes("�"));
    assert.ok(Buffer.byteLength(JSON.stringify(truncated)) < 2 * 1024 * 1024);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(space.spaceRoot, "pixel.png"), png);
    const image = await preview("pixel.png");
    assert.equal(image.kind, "image");
    if (image.kind !== "image") assert.fail();
    assert.equal(image.base64, png.toString("base64"));
    await writeFile(join(space.spaceRoot, "big.png"), Buffer.alloc(remoteFilePreviewLimits.imageBytes + 1));
    assert.equal((await preview("big.png")).kind, "none");
    await writeFile(join(space.spaceRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(space.spaceRoot, "invalid.txt"), Buffer.from([255, 254, 253]));
    assert.equal((await preview("binary.bin")).kind, "none");
    assert.equal((await preview("invalid.txt")).kind, "none");
    await writeFile(join(space.spaceRoot, "unsafe.svg"), '<svg onload="alert(1)"><script>bad()</script></svg>');
    assert.equal((await preview("unsafe.svg")).kind, "text", "SVG is source text, never executable image markup");
    await writeFile(join(space.spaceRoot, "empty.txt"), "");
    assert.equal((await preview("empty.txt")).kind, "text");
    assert.equal(await readFile(join(space.spaceRoot, "brief.md"), "utf8"), md.text);

    for (const path of ["", "/etc/passwd", "../Other Space/brief.md", "nested/../brief.md", "brief.md\0", "a\\brief.md", ".work-fold/space.json", ".workspace/state.json", ".pi/auth.json", "missing.txt"]) {
      await assert.rejects(preview(path));
    }
    await assert.rejects(api.remoteFacade.execute("spaces.filePreview", { spaceId: space.id, path: "brief.md", encoding: "raw" }, principal));
    await assert.rejects(api.remoteFacade.execute("spaces.filePreview", { spaceId: space.id, path: "brief.md" }, { ...principal, grantId: "" }));
    await setSpaceIgnoreState(space.spaceRoot, ["brief.md"], true);
    await assert.rejects(preview("brief.md"));
    await mkdir(join(space.spaceRoot, "nested"));
    await writeFile(join(space.spaceRoot, "nested", "private.txt"), "Other registered ownership");
    const nested = await api.actFacade.registerSpace({ spaceRoot: join(space.spaceRoot, "nested") });
    await assert.rejects(preview("nested/private.txt"));
    assert.equal((await preview("private.txt", nested.space.id)).kind, "text");
    if (process.platform !== "win32") {
      await symlink(join(other.spaceRoot, "brief.md"), join(space.spaceRoot, "escape.txt"));
      await symlink(other.spaceRoot, join(space.spaceRoot, "escape-dir"));
      await assert.rejects(preview("escape.txt"));
      await assert.rejects(preview("escape-dir/brief.md"));
    }
    await api.actFacade.spacesUnregister({ space: other.id });
    await assert.rejects(preview("brief.md", other.id));
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});
