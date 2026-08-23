import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  applyLoginShellEnvironment,
  defaultLoginShell,
  loginShellArguments,
  loginShellProbeCommand,
  mergeLoginShellEnvironment,
  parseLoginShellEnvironment,
  resolveLoginShellEnvironment,
  shouldResolveLoginShellEnvironment,
} from "../desktop/src/shell-environment.js";

const launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin";

test("GUI launches resolve the login shell; terminal launches, Windows, probes, and opt-outs do not", () => {
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath }, "darwin").resolve, true);
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath }, "linux").resolve, true);
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath, TERM: "xterm-256color" }, "darwin").resolve, false);
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath }, "win32").resolve, false);
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath, WORKFOLD_DISABLE_LOGIN_SHELL_ENV: "1" }, "darwin").resolve, false);
  assert.equal(shouldResolveLoginShellEnvironment({ PATH: launchdPath, WORKFOLD_RESOLVING_LOGIN_SHELL: "1" }, "darwin").resolve, false);
});

test("the probe command and arguments match each shell family", () => {
  assert.deepEqual(loginShellArguments("/bin/zsh", "x"), ["-ilc", "x"]);
  assert.deepEqual(loginShellArguments("/opt/homebrew/bin/fish", "x"), ["-ilc", "x"]);
  assert.deepEqual(loginShellArguments("/bin/tcsh", "x"), ["-ic", "x"]);
  const command = loginShellProbeCommand("MARK");
  assert.match(command, /\/usr\/bin\/env -0/);
  assert.equal(command.split("'MARK'").length, 3);
});

test("parsing keeps only the NUL-separated block between the markers", () => {
  const marker = "__m__";
  const output = `Welcome banner from .zshrc\n${marker}PATH=/opt/homebrew/bin:/usr/bin\0MULTI=line one\nline two\0EMPTY=\0not-a-pair\0BAD KEY=1\0${marker}trailing noise`;
  assert.deepEqual(parseLoginShellEnvironment(output, marker), {
    PATH: "/opt/homebrew/bin:/usr/bin",
    MULTI: "line one\nline two",
    EMPTY: "",
  });
  assert.equal(parseLoginShellEnvironment("no markers here", marker), null);
  assert.equal(parseLoginShellEnvironment(`${marker}PATH=/bin`, marker), null);
});

test("merging prefers the shell PATH order, keeps process-only entries, and protects explicit configuration", () => {
  const processEnv: NodeJS.ProcessEnv = {
    PATH: `${launchdPath}${delimiter}/Applications/work-fold.app/Contents/bin`,
    HOME: "/Users/mat",
    SHLVL: "0",
    TMPDIR: "/var/folders/launchd",
    WORKFOLD_AGENT_DIR: "/explicit/agent",
    ELECTRON_RUN_AS_NODE: "1",
    XPC_FLAGS: "0x0",
    LANG: "en_US.UTF-8",
  };
  const shellEnv = {
    PATH: `/opt/homebrew/bin${delimiter}/Users/mat/.local/bin${delimiter}/usr/bin${delimiter}/bin`,
    HOME: "/Users/someone-else",
    SHLVL: "2",
    TMPDIR: "/var/folders/shell",
    PWD: "/Users/mat",
    _: "/usr/bin/env",
    NODE_OPTIONS: "--require evil",
    WORKFOLD_AGENT_DIR: "/profile/agent",
    WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS: "120000",
    ELECTRON_RUN_AS_NODE: "0",
    XPC_FLAGS: "0x1",
    LANG: "en_US.UTF-8",
    EDITOR: "vim",
    NVM_DIR: "/Users/mat/.nvm",
  };
  const merged = mergeLoginShellEnvironment(processEnv, shellEnv);
  assert.equal(
    merged.env.PATH,
    ["/opt/homebrew/bin", "/Users/mat/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Applications/work-fold.app/Contents/bin"].join(delimiter),
  );
  assert.equal(merged.pathEntriesAdded, 2);
  assert.equal(merged.env.EDITOR, "vim");
  assert.equal(merged.env.NVM_DIR, "/Users/mat/.nvm");
  assert.equal(merged.env.WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS, "120000", "unset product variables may come from the profile");
  for (const key of ["HOME", "SHLVL", "TMPDIR", "PWD", "_", "NODE_OPTIONS", "WORKFOLD_AGENT_DIR", "ELECTRON_RUN_AS_NODE", "XPC_FLAGS", "LANG"]) {
    assert.equal(key in merged.env, false, `${key} must not be imported`);
  }
  assert.deepEqual(merged.importedKeys, ["EDITOR", "NVM_DIR", "PATH", "WORKFOLD_CHAT_CONTEXT_BUDGET_TOKENS"]);
});

test("a login shell that prints profile noise still yields its environment end to end", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "work-fold-shell-env-"));
  try {
    const fakeShell = join(sandbox, "fake-shell");
    writeFileSync(fakeShell, [
      "#!/bin/sh",
      'echo "motd: welcome"',
      'echo "warning on stderr" 1>&2',
      'export PATH="/opt/homebrew/bin:/fake/tools:$PATH"',
      "export EDITOR=nano",
      'eval "$2"',
      'echo "logout noise"',
    ].join("\n"));
    chmodSync(fakeShell, 0o755);
    const target: NodeJS.ProcessEnv = { PATH: launchdPath, HOME: sandbox };
    const result = await applyLoginShellEnvironment({ shell: fakeShell, target, env: target, platform: "darwin", timeoutMs: 10_000 });
    assert.equal(result.status, "applied", result.reason);
    assert.equal(result.shell, fakeShell);
    assert.equal(target.PATH, `/opt/homebrew/bin:/fake/tools:${launchdPath}`);
    assert.equal(target.EDITOR, "nano");
    assert.equal(result.pathEntriesAdded, 2);
    assert.ok(result.importedKeys.includes("PATH"));
    assert.equal("WORKFOLD_RESOLVING_LOGIN_SHELL" in target, false, "the probe marker never leaks into the live environment");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a hanging or missing login shell leaves the launch environment untouched", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "work-fold-shell-env-"));
  try {
    const hangingShell = join(sandbox, "hanging-shell");
    writeFileSync(hangingShell, "#!/bin/sh\nsleep 30\n");
    chmodSync(hangingShell, 0o755);
    const target: NodeJS.ProcessEnv = { PATH: launchdPath };
    const timedOut = await applyLoginShellEnvironment({ shell: hangingShell, target, env: target, platform: "darwin", timeoutMs: 300 });
    assert.equal(timedOut.status, "failed");
    assert.match(timedOut.reason, /did not answer/);
    assert.equal(target.PATH, launchdPath);

    const missing = await resolveLoginShellEnvironment({ shell: join(sandbox, "missing-shell"), env: target, platform: "darwin" });
    assert.ok("error" in missing && /not found/.test(missing.error));

    const skipped = await applyLoginShellEnvironment({ shell: hangingShell, target: { PATH: launchdPath, TERM: "xterm" }, platform: "darwin", timeoutMs: 300 });
    assert.equal(skipped.status, "skipped");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the default login shell follows $SHELL and falls back to a platform shell that exists", () => {
  assert.equal(defaultLoginShell({ SHELL: "/definitely/missing/shell" }, "darwin"), "/bin/zsh");
  assert.equal(defaultLoginShell({}, "linux"), "/bin/bash");
  assert.equal(defaultLoginShell({ SHELL: "/bin/sh" }, "darwin"), "/bin/sh");
});
