import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

assertSupportedNode();
assertPath("package.json");
assertPath("dist/web-local/index.html");
assertPath("dist/desktop/desktop/src/main.js");
assertPath("dist/desktop/desktop/src/preload.cjs");
assertPath("dist/desktop/desktop/src/restricted-app-host.js");
assertPath("dist/desktop/desktop/src/restricted-app-preload.cjs");
assertPath("desktop/assets/icon.ico");
assertPath("desktop/assets/icon.png");
if (desktopReleasePlatform() === "darwin") {
  assertPath("desktop/assets/icon.icns");
  assertPath("out/generated-assets/dmg-background.png");
  assertPath("desktop/cli/workspace-cli.jxa.js");
}

verifyPiDependencyNormalization();
await verifyNativePiResources();

if (failures.length) {
  console.error("Workspace desktop preflight failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Workspace desktop preflight passed.");

function assertSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    failures.push(`Node ${process.versions.node} is unsupported; use Node 22.19.0 or newer.`);
  }
}

function assertPath(relativePath) {
  if (!existsSync(join(rootDir, relativePath))) failures.push(`Missing ${relativePath}.`);
}

function desktopReleasePlatform() {
  const configured = process.env.WORKSPACE_DESKTOP_RELEASE_PLATFORM?.trim();
  return configured || process.platform;
}

function verifyPiDependencyNormalization() {
  const piDir = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent");
  const expectedVersions = new Map([
    ["brace-expansion", "5.0.8"],
    ["protobufjs", "7.6.5"],
  ]);
  for (const [name, expectedVersion] of expectedVersions) {
    try {
      const piRequire = createRequire(join(piDir, "package.json"));
      const resolvedPackage = piRequire(`${name}/package.json`);
      if (resolvedPackage.version !== expectedVersion) {
        failures.push(`Pi resolves ${name} ${resolvedPackage.version}; expected the reviewed ${expectedVersion} fix.`);
      }
    } catch (error) {
      failures.push(`Pi ${name} normalization check failed: ${formatError(error)}`);
    }
  }
}

async function verifyNativePiResources() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "workspace-pi-preflight-"));
  const projectDir = join(fixtureRoot, "project");
  const agentDir = join(fixtureRoot, "agent");
  try {
    await Promise.all([
      mkdir(join(projectDir, ".pi", "extensions"), { recursive: true }),
      mkdir(join(projectDir, ".pi", "skills", "project-preflight"), { recursive: true }),
      mkdir(join(projectDir, ".agents", "skills", "portable-preflight"), { recursive: true }),
      mkdir(join(agentDir, "extensions"), { recursive: true }),
      mkdir(join(agentDir, "skills", "global-preflight"), { recursive: true }),
    ]);

    await Promise.all([
      writeFile(
        join(projectDir, ".pi", "extensions", "project-preflight.js"),
        `export default function (pi) { pi.registerCommand("project-preflight", { description: "Project extension fixture", handler: async () => {} }); }\n`,
        "utf8",
      ),
      writeFile(
        join(agentDir, "extensions", "global-preflight.js"),
        `export default function (pi) { pi.registerCommand("global-preflight", { description: "Global extension fixture", handler: async () => {} }); }\n`,
        "utf8",
      ),
      writeFile(
        join(projectDir, ".pi", "skills", "project-preflight", "SKILL.md"),
        `---\nname: project-preflight\ndescription: Confirms trusted project skill discovery.\n---\n\nProject skill fixture.\n`,
        "utf8",
      ),
      writeFile(
        join(projectDir, ".agents", "skills", "portable-preflight", "SKILL.md"),
        `---\nname: portable-preflight\ndescription: Confirms portable Agent Skill discovery.\n---\n\nPortable skill fixture.\n`,
        "utf8",
      ),
      writeFile(
        join(agentDir, "skills", "global-preflight", "SKILL.md"),
        `---\nname: global-preflight\ndescription: Confirms global skill discovery.\n---\n\nGlobal skill fixture.\n`,
        "utf8",
      ),
      writeFile(join(projectDir, "AGENTS.md"), "# Project context fixture\n", "utf8"),
    ]);

    const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
    const resourceLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });
    await resourceLoader.reload();

    const extensions = resourceLoader.getExtensions();
    if (extensions.errors.length) {
      failures.push(`Pi extension discovery failed: ${extensions.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
    }
    const commandNames = new Set(
      extensions.extensions.flatMap((extension) => Array.from(extension.commands.keys())),
    );
    for (const expected of ["global-preflight", "project-preflight"]) {
      if (!commandNames.has(expected)) failures.push(`Pi did not load the ${expected} extension command.`);
    }

    const skillNames = new Set(resourceLoader.getSkills().skills.map((skill) => skill.name));
    for (const expected of ["global-preflight", "project-preflight", "portable-preflight"]) {
      if (!skillNames.has(expected)) failures.push(`Pi did not discover the ${expected} skill.`);
    }
    if (!resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.path.endsWith("AGENTS.md"))) {
      failures.push("Pi did not load trusted project context files.");
    }

    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const result = await createAgentSession({
      cwd: projectDir,
      agentDir,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(projectDir),
    });
    const activeTools = new Set(result.session.getActiveToolNames());
    for (const expected of ["read", "bash", "edit", "write"]) {
      if (!activeTools.has(expected)) failures.push(`Pi built-in tool ${expected} is not active by default.`);
    }
    result.session.dispose();
  } catch (error) {
    failures.push(`Native Pi resource smoke failed: ${formatError(error)}`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
