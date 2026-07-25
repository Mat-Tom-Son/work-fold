import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Claude Code imports the canonical Codex contributor contract", async () => {
  const [claude, agents] = await Promise.all([
    readFile(join(root, "CLAUDE.md"), "utf8"),
    readFile(join(root, "AGENTS.md"), "utf8"),
  ]);

  assert.match(claude, /^@AGENTS\.md$/m);
  assert.match(claude, /canonical contributor contract/i);
  assert.match(agents, /Harness parity/);
  assert.match(agents, /Native full-trust Skills, Extensions, built-in tools, and their catalog\/runtime remain Pi-owned/);
  assert.match(agents, /Workspace owns the product documentation and restricted-app lane, but both remain harness-neutral/);
  assert.doesNotMatch(claude, /npm run desktop:make/);
});

test("canonical product docs keep Library and Assistant tools in Space-owned tabs", async () => {
  const files = [
    "README.md",
    "AGENTS.md",
    "docs/product-model.md",
    "docs/architecture.md",
    "docs/ui-parity.md",
    "docs/visual-design.md",
  ];
  const contents = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
  for (const content of contents) {
    assert.match(content, /Files[\s\S]*Chats[\s\S]*History/);
    assert.match(content, /Library[\s\S]*Space-owned[\s\S]*tab/i);
    assert.doesNotMatch(content, /primary (?:rail )?(?:navigation|surfaces?)[^\n.]{0,80}Files[^\n.]{0,20}Chats[^\n.]{0,20}Library[^\n.]{0,20}History/i);
  }
  const assistantCapabilities = await readFile(join(root, "docs/assistant-capabilities.md"), "utf8");
  assert.match(assistantCapabilities, /one persistent Library tab per Space/i);
  assert.match(assistantCapabilities, /same passive personal collection/i);
});

test("public and contributor docs route management behavior to one guide", async () => {
  const files = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "docs/product-model.md", "docs/architecture.md"];
  const contents = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
  for (const content of contents) {
    assert.match(content, /management-layer\.md/, "Each canonical doc must link the management guide.");
  }
});

test("App-platform docs route future behavior to one accepted foundation", async () => {
  const routedFiles = [
    "AGENTS.md",
    "docs/product-model.md",
    "docs/architecture.md",
    "docs/restricted-app-runtime.md",
    "docs/restricted-app-authoring.md",
  ];
  const contents = await Promise.all(routedFiles.map((file) => readFile(join(root, file), "utf8")));
  for (const content of contents) {
    assert.match(content, /app-platform-foundation\.md/, "Each canonical App document must link the accepted foundation.");
  }

  const foundation = await readFile(join(root, "docs/app-platform-foundation.md"), "utf8");
  assert.match(foundation, /Space.*may never become an App/s);
  assert.match(foundation, /kind: development/);
  assert.match(foundation, /kind: app/);
  assert.match(foundation, /host: local \| hosted/);
  assert.match(foundation, /projectId.*cloudProjectId/s);
  assert.match(foundation, /featureInstallationId.*dataNamespaceId/s);
  assert.match(foundation, /runtime-instance, feature-installation, grant,\s+connection, job, principal, and data generations/);
  assert.match(foundation, /Publish is not sync/);
  assert.match(foundation, /Every accepted effect has one effective Principal/);
  assert.doesNotMatch(foundation, /releaseLineageId|kind: app-local|kind: app-hosted/);
});
