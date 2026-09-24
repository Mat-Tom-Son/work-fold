// A disposable editor, controlled only through the bundled AT-SPI helper.
// Requires a real desktop accessibility bus; never targets another application.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");
let helper, editorProcess, root;
const pending = new Map();
let sequence = 0;
function command(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out`)); }, 10_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    helper.stdin.write(`${JSON.stringify({ id, protocolVersion: 4, cmd, args })}\n`);
  });
}
function nodes(node) { return [node, ...(node.children || []).flatMap(nodes)]; }
(async () => {
  try {
    assert.equal(process.platform, "linux");
    root = await mkdtemp(join(tmpdir(), "workfold-accessibility-"));
    editorProcess = spawn("python3", ["-c", `
import sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title="work-fold Linux acceptance editor")
window.set_default_size(560, 360)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(box)
box.pack_start(Gtk.Label(label="Temporary acceptance test. This window closes automatically."), False, False, 0)
text = Gtk.TextView()
text.get_accessible().set_name("Document text")
box.pack_start(text, True, True, 0)
button = Gtk.Button(label="Save document")
def save(_):
    buffer = text.get_buffer()
    with open(sys.argv[1], "w") as file: file.write(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True))
button.connect("clicked", save)
box.pack_start(button, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
`, join(root, "Linux-ready.txt")], { env: { ...process.env, GTK_MODULES: "atk-bridge", NO_AT_BRIDGE: "0" }, stdio: ["ignore", "ignore", "pipe"] });
    editorProcess.stderr.on("data", data => process.stderr.write(data));
    editorProcess.on("error", error => { console.error(error); process.exitCode = 1; });
    helper = spawn(resolve(process.argv[2] || "out/included-tools/computer-helper/linux-bridge"), [], { stdio: ["pipe", "pipe", "pipe"] });
    helper.on("error", error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
    createInterface({ input: helper.stdout }).on("line", line => {
      const response = JSON.parse(line), request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      response.ok ? request.resolve(response.result) : request.reject(new Error(JSON.stringify(response.error)));
    });
    helper.stderr.on("data", data => process.stderr.write(data));
    const diagnostics = await command("diagnostics", {});
    assert.equal(diagnostics.accessibility, true, "The desktop accessibility bus must be available");
    let owned;
    const ownPids = [editorProcess.pid];
    const seen = [];
    for (let attempt = 0; attempt < 30 && !owned; attempt++) {
      for (const pid of ownPids) {
        const roots = await command("listRoots", { pid });
        seen.push(...roots.roots.map(({ title, pid }) => ({ title, pid })));
        owned = roots.roots.find(candidate => candidate.title.includes("Linux acceptance editor") && ownPids.includes(candidate.pid));
        if (owned) break;
      }
      if (!owned) await delay(300);
    }
    assert.ok(owned, `The disposable editor must expose its own accessible root: ${JSON.stringify(seen)}`);
    let look = await command("look", { rootRef: owned.rootRef, includeImage: false });
    const editor = nodes(look.outline).find(node => node.title === "Document text" && node.canSetValue);
    assert.ok(editor, `The document text field must be editable through AT-SPI: ${JSON.stringify(look.outline)}`);
    const sentence = "work-fold can edit and save this document through Linux accessibility.";
    const edited = await command("act", { lookId: look.lookId, action: "setText", target: { ref: editor.ref }, params: { text: sentence }, policy: "ax_only" });
    assert.equal(edited.outcome, "worked");
    look = await command("look", { rootRef: owned.rootRef, includeImage: false });
    const save = nodes(look.outline).find(node => node.title === "Save document" && node.canPress);
    assert.ok(save, "The Save button must expose an accessible action");
    const saved = await command("act", { lookId: look.lookId, action: "press", target: { ref: save.ref }, policy: "ax_only" });
    assert.equal(saved.outcome, "worked");
    let contents;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { contents = await readFile(join(root, "Linux-ready.txt"), "utf8"); break; } catch { await delay(100); }
    }
    assert.equal(contents, sentence);
    console.log(`PASS Linux accessibility: ${diagnostics.sessionType}; observed own editor, set text, pressed Save, verified file bytes; no physical input`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    if (helper && helper.exitCode === null) { const closed = new Promise(resolve => helper.once("close", resolve)); helper.kill("SIGTERM"); await closed; }
    if (editorProcess && editorProcess.exitCode === null) { const closed = new Promise(resolve => editorProcess.once("close", resolve)); editorProcess.kill("SIGTERM"); await closed; }
    if (root) await rm(root, { recursive: true, force: true });

  }
})();
