import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const builder = require(join(rootDir, "electron-builder.desktop.cjs"));
const forge = require(join(rootDir, "desktop", "forge.config.cjs"));

test("Electron Builder packages executable CLI shims outside ASAR and includes PATH hooks", () => {
  assert.deepEqual(builder.extraFiles, [{
    from: "desktop/cli",
    to: "bin",
    filter: ["workspace", "workspace.cmd", "workspace-cli.ps1", "workspace-cli.jxa.js"],
  }]);
  assert.equal(basename(builder.nsis.include), "cli-path.nsh");
  assert.equal(builder.asar, true);
  assert.equal(builder.electronFuses.runAsNode, false);
});

test("macOS DMG artwork is generated outside the tracked source tree", async () => {
  assert.equal(
    builder.dmg.background,
    join(rootDir, "out", "generated-assets", "dmg-background.png"),
  );

  const [generator, preflight] = await Promise.all([
    read("scripts/generate-dmg-background.mjs"),
    read("scripts/desktop-preflight.mjs"),
  ]);
  assert.match(generator, /join\(rootDir, "out", "generated-assets"\)/);
  assert.doesNotMatch(generator, /join\(assetsDir, "dmg-background\.png"\)/);
  assert.match(preflight, /out\/generated-assets\/dmg-background\.png/);
});

test("retained Forge packaging mirrors the package-root CLI bin layout", async () => {
  const hooks = forge.packagerConfig.afterComplete;
  assert.equal(Array.isArray(hooks), true);
  assert.equal(hooks.length, 1);
  const packageRoot = await mkdtemp(join(tmpdir(), "workspace-forge-cli-"));
  try {
    await hooks[0](packageRoot);
    for (const name of ["workspace", "workspace.cmd", "workspace-cli.ps1", "workspace-cli.jxa.js"]) {
      assert.equal(
        await readFile(join(packageRoot, "bin", name), "utf8"),
        await readFile(join(rootDir, "desktop", "cli", name), "utf8"),
      );
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("macOS CLI shim uses the same atomic bounded protocol-v1 handoff", async () => {
  const [shellShim, jxaHelper] = await Promise.all([
    read("desktop/cli/workspace"),
    read("desktop/cli/workspace-cli.jxa.js"),
  ]);
  assert.match(shellShim, /uname -s/);
  assert.match(shellShim, /osascript -l JavaScript/);
  for (const field of ["protocolVersion", "id", "argv", "cwd", "createdAt"]) {
    assert.match(jxaHelper, new RegExp(`\\b${field}:`), `request must include ${field}`);
  }
  assert.match(jxaHelper, /Library\/Application Support\/\$\{defaultStateName\}/);
  assert.match(jxaHelper, /WORKSPACE_CLI_STATE_DIR/);
  assert.match(jxaHelper, /Workspace Local Smoke/);
  assert.match(jxaHelper, /WORKSPACE_CLI_APP/);
  assert.match(jxaHelper, /WORKSPACE_CLI_TIMEOUT_MS/);
  assert.match(jxaHelper, /moveItemAtPathToPathError/);
  assert.match(jxaHelper, /--workspace-cli-request/);
  assert.match(jxaHelper, /fileHandleWithStandardOutput/);
  assert.match(jxaHelper, /fileHandleWithStandardError/);
  assert.match(jxaHelper, /\$\.exit\(exitCode\)/);
  assertActLaneShimContract(jxaHelper);
  const desktopMain = await read("desktop/src/main.ts");
  assert.match(desktopMain, /process\.env\.WORKSPACE_CLI_STATE_DIR = app\.getPath\("userData"\)/);
  assert.doesNotMatch(desktopMain, /process\.env\.WORKSPACE_DESKTOP_(?:USER_DATA|STATE)_DIR\s*=/);
  assert.match(desktopMain, /writeWorkspaceCliActTokenFile/);
  assert.match(desktopMain, /removeWorkspaceCliActTokenFile/);
});

test("Windows CLI shim uses an atomic bounded protocol-v1 handoff", async () => {
  const [shellShim, commandShim, powerShellShim] = await Promise.all([
    read("desktop/cli/workspace"),
    read("desktop/cli/workspace.cmd"),
    read("desktop/cli/workspace-cli.ps1"),
  ]);
  assert.match(shellShim, /^#!\/usr\/bin\/env sh/);
  assert.match(shellShim, /exec "\$script_dir\/workspace\.cmd" "\$@"/);
  assert.match(commandShim, /-NoProfile\s+-NonInteractive/);
  assert.match(commandShim, /workspace-cli\.ps1"\s+%\*/);
  assert.match(commandShim, /exit \/b %ERRORLEVEL%/);

  for (const field of ["protocolVersion", "id", "argv", "cwd", "createdAt"]) {
    assert.match(powerShellShim, new RegExp(`\\b${field}\\s*=`), `request must include ${field}`);
  }
  assert.match(powerShellShim, /\$script:WorkspaceCliRoot\s*=\s*Join-Path\s+\$stateDirectory\s+'cli'/);
  assert.match(powerShellShim, /'requests'/);
  assert.match(powerShellShim, /'responses'/);
  assert.match(powerShellShim, /CurrentFileSystemLocation\.ProviderPath/);
  assert.doesNotMatch(powerShellShim, /GetCurrentDirectory/);
  assert.match(powerShellShim, /\[IO\.FileMode\]::CreateNew/);
  assert.match(powerShellShim, /\$requestStream\.Flush\(\$true\)/);
  assert.doesNotMatch(powerShellShim, /\$requestId\.\$PID\.tmp/);
  assert.match(powerShellShim, /\[IO\.File\]::Move\(\$temporaryRequestPath,\s*\$requestPath\)/);
  assert.match(powerShellShim, /Start-Process[\s\S]*?'--workspace-cli-request'[\s\S]*?-WindowStyle Hidden/);
  assert.match(powerShellShim, /WORKSPACE_CLI_APP/);
  assert.match(powerShellShim, /WORKSPACE_CLI_STATE_DIR/);
  assert.match(powerShellShim, /Uninstall Workspace\.exe/);
  assert.match(powerShellShim, /Workspace Development/);
  assert.match(powerShellShim, /WORKSPACE_CLI_TIMEOUT_MS/);
  assert.match(powerShellShim, /ElapsedMilliseconds\s+-ge\s+\$script:WorkspaceCliTimeoutMs/);
  assert.match(powerShellShim, /\[Console\]::Out\.Write\(\[string\]\$Outcome\.Stdout\)/);
  assert.match(powerShellShim, /\[Console\]::Error\.Write\(\[string\]\$Outcome\.Stderr\)/);
  assert.match(powerShellShim, /ExitCode\s*=\s*\[Convert\]::ToInt32\(\$response\.exitCode/);
  assert.match(powerShellShim, /Remove-Item -LiteralPath \$path -Force/);
  assertActLaneShimContract(powerShellShim);
});

test("NSIS manages only the current-user PATH and broadcasts changes", async () => {
  const [nsis, powerShellShim] = await Promise.all([
    read("desktop/nsis/cli-path.nsh"),
    read("desktop/cli/workspace-cli.ps1"),
  ]);
  assert.match(nsis, /!macro customInstall/);
  assert.match(nsis, /!macro customUnInstall/);
  assert.match(nsis, /\$INSTDIR\\bin/);
  assert.match(nsis, /nsExec::ExecToStack/);
  assert.match(nsis, /-NoProfile\s+-NonInteractive/);
  assert.match(nsis, /--workspace-installer-manage-user-path \$\{ACTION\}/);
  assert.match(nsis, /\$\{HWND_BROADCAST\}\s+\$\{WM_SETTINGCHANGE\}/);
  assert.doesNotMatch(nsis, /HKLM|\$PROFILE|Documents\\PowerShell/i);

  assert.match(powerShellShim, /Microsoft\.Win32\.Registry\]::CurrentUser/);
  assert.match(powerShellShim, /RegistryValueOptions\]::DoNotExpandEnvironmentNames/);
  assert.match(powerShellShim, /RegistryValueKind\]::ExpandString/);
  assert.match(powerShellShim, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(powerShellShim, /DeleteValue\('Path',\s*\$false\)/);
});

test("packaged asset verification requires external CLI shims", async () => {
  const verifier = await read("scripts/verify-packaged-app-assets.mjs");
  assert.match(verifier, /join\(binDir, "workspace\.cmd"\)/);
  assert.match(verifier, /join\(binDir, "workspace"\)/);
  assert.match(verifier, /join\(binDir, "workspace-cli\.ps1"\)/);
  assert.match(verifier, /join\(binDir, "workspace-cli\.jxa\.js"\)/);
  assert.match(verifier, /CLI shim must remain outside app\.asar/);
});

test("management dogfood launches the dev app with the agent-facing CLI on PATH", async () => {
  const script = await read("scripts/management-dogfood.sh");
  assert.match(script, /PATH="\$BIN:\$PATH" "\$BIN\/app-wrapper\.sh"/);
  assert.match(script, /while \[ ! -f "\$DEVSTATE\/cli\/act-token\.json" \]/);
  assert.match(script, /out\/management-dogfood\/bin/);
  assert.doesNotMatch(script, /python3/);
});

/**
 * Shared act-lane contract both platform shims must keep: routing that never
 * lets content-bearing chat commands fall through to protocol v1, the
 * per-launch token file, the bounded message payload rewrite, the shim-side
 * wait loop, and the fail-fast unavailable path.
 */
function assertActLaneShimContract(shim: string): void {
  for (const routed of ["chat", "chats", "files", "manage", "checks", "spaces", "create", "register", "wait", "status", "task", "result"]) {
    assert.match(shim, new RegExp(`["']${routed}["']`), `act routing must reference ${routed}`);
  }
  assert.match(shim, /act-token\.json/);
  assert.match(shim, /\[A-Za-z0-9_-\]\{16,256\}/);
  assert.match(shim, /protocolVersion\s*[:=]\s*2/);
  assert.match(shim, /lane\s*[:=]\s*["']act["']/);
  assert.match(shim, /actToken/);
  assert.match(shim, /payload/);
  assert.match(shim, /messageFile/);
  assert.match(shim, /--message-file/);
  assert.match(shim, /--message-from-payload/);
  assert.match(shim, /262144/);
  assert.match(shim, /Open Workspace to run this command/);
  assert.match(shim, /exit\s*\(?6\)?/);
  assert.match(shim, /--task/);
  assert.match(shim, /task\.state/);
  assert.match(shim, /accepted/);
  assert.match(shim, /--timeout/);
  assert.match(shim, /timed out after/);
  assert.match(shim, /\b7\b/);
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(rootDir, relativePath), "utf8");
}
