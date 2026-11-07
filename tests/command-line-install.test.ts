import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  appleScriptString,
  commandBinDirectory,
  commandLineStatus,
  installCommandOnPath,
  installSkill,
  pathInstallCommand,
  pathUnsupportedReason,
  removeCommandFromPath,
  removeSkill,
  shellQuote,
  skillFile,
  type CommandLineEnvironment,
} from "../desktop/src/command-line-install.js";
import { outsideAgentSkill } from "../src/shared/outside-agent-skill.js";
import { productIdentity } from "../src/shared/product-identity.js";

/**
 * Settings → Command Line (owner request, 2026-11-07): the command on the
 * Terminal's PATH through /etc/paths.d, and the skill in other agents'
 * skills folders. Tests stand in a temporary folder for /etc/paths.d and run
 * the administrator command as an ordinary shell.
 */

const run = promisify(execFile);
const command = productIdentity.cliCommand;

async function sandbox(t: test.TestContext, appName = `${productIdentity.productName}.app`) {
  const root = await mkdtemp(join(tmpdir(), "command-line-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "Applications", appName, "Contents", "MacOS", productIdentity.productName);
  await mkdir(join(dirname(executablePath), "..", "bin"), { recursive: true });
  await writeFile(join(dirname(executablePath), "..", "bin", command), "#!/bin/sh\n");
  const prompts: string[] = [];
  const environment: CommandLineEnvironment = {
    platform: "darwin",
    isPackaged: true,
    executablePath,
    home: join(root, "home"),
    pathsDirectory: join(root, "paths.d"),
    async runAsAdministrator(shellCommand, prompt) {
      prompts.push(prompt);
      await run("/bin/sh", ["-c", shellCommand]);
    },
  };
  return { root, environment, prompts };
}

test("only an installed Mac app, run from its own place, can put its command on the PATH", () => {
  const app = "/Applications/Acme.app/Contents/MacOS/Acme";
  assert.equal(pathUnsupportedReason({ platform: "darwin", isPackaged: true, executablePath: app }), null);
  assert.match(pathUnsupportedReason({ platform: "linux", isPackaged: true, executablePath: app })!, /on a Mac/);
  assert.match(pathUnsupportedReason({ platform: "darwin", isPackaged: false, executablePath: app })!, /Only the installed/);
  assert.match(pathUnsupportedReason({ platform: "darwin", isPackaged: true, executablePath: "/private/var/folders/x/AppTranslocation/ABC/d/Acme.app/Contents/MacOS/Acme" })!, /Applications folder/);
  assert.equal(commandBinDirectory(app), "/Applications/Acme.app/Contents/bin");
});

test("the PATH entry names the app's bin folder exactly, whatever its path holds", async (t) => {
  // A space and a quote in the app's folder must reach the file unchanged.
  const { environment, prompts } = await sandbox(t, "Bob's Apps/Acme Tools.app");
  const before = await commandLineStatus(environment);
  assert.equal(before.path.supported, true);
  assert.equal(before.path.state, "missing");
  assert.equal(before.path.entryFile, join(environment.pathsDirectory, command));

  const after = await installCommandOnPath(environment);
  assert.equal(after.path.state, "installed");
  assert.equal(await readFile(after.path.entryFile, "utf8"), `${commandBinDirectory(environment.executablePath)}\n`);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, new RegExp(`add the ${command} command to Terminal`));

  // Another copy's entry reads as pointing elsewhere; removing clears it.
  await writeFile(after.path.entryFile, "/Applications/Other.app/Contents/bin\n");
  assert.equal((await commandLineStatus(environment)).path.state, "elsewhere");
  assert.equal((await removeCommandFromPath(environment)).path.state, "missing");
});

test("shell and AppleScript quoting keep every character literal", async () => {
  const tricky = "/tmp/it's a \"test\" $(rm -rf ~) `x`\\y";
  const { stdout } = await run("/bin/sh", ["-c", `printf '%s' ${shellQuote(tricky)}`]);
  assert.equal(stdout, tricky);
  assert.equal(appleScriptString('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
  assert.throws(() => pathInstallCommand("relative/bin", "/etc/paths.d/x"), /can't be used/);
  assert.throws(() => pathInstallCommand("/bin\nrm -rf /", "/etc/paths.d/x"), /can't be used/);
});

test("the skill goes into Claude Code and Codex only on request, and only this app's skill is removed", async (t) => {
  const { environment } = await sandbox(t);
  let status = await commandLineStatus(environment);
  assert.equal(status.skills.claude.available, false, "no Claude Code on this computer yet");
  assert.equal(status.skills.claude.installed, "none");

  await mkdir(join(environment.home, ".claude"), { recursive: true });
  status = await installSkill(environment, "claude");
  assert.equal(status.skills.claude.available, true);
  assert.equal(status.skills.claude.installed, "current");
  assert.equal(await readFile(skillFile(environment.home, "claude"), "utf8"), outsideAgentSkill());
  assert.equal(status.skills.codex.installed, "none", "Codex is untouched");

  // An older copy reads as outdated until it is added again.
  await writeFile(skillFile(environment.home, "claude"), outsideAgentSkill().replace("## Rules", "## Old rules"));
  assert.equal((await commandLineStatus(environment)).skills.claude.installed, "outdated");

  // A skill someone else put at the same place is left alone.
  await mkdir(dirname(skillFile(environment.home, "codex")), { recursive: true });
  await writeFile(skillFile(environment.home, "codex"), "---\nname: something-else\ndescription: not ours\n---\n");
  await assert.rejects(removeSkill(environment, "codex"), /left alone/);
  assert.equal((await removeSkill(environment, "claude")).skills.claude.installed, "none");
});
