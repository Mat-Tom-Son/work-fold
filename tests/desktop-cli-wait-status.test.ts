import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

// The installed work-fold.cmd runs Windows PowerShell 5.1 with strict mode on.
test("Windows CLI wait reads each status shape under strict mode", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const script = await readFile(new URL("../desktop/cli/work-fold-cli.ps1", import.meta.url), "utf8");
  const parser = /^function Read-WorkFoldWaitStatus \{[\s\S]*?^\}$/m.exec(script)?.[0];
  assert.ok(parser, "the wait status parser is a standalone function");
  const status = (data: unknown) => JSON.stringify({ ok: true, command: "chat.status", data });
  const task = (state: string) => ({ taskId: "turn-1", state, conversationId: "chat-1", messageId: null, error: null, endedAt: null });
  const cases = {
    // The shape the installed app returned during Windows UAT: request, no requestGraph.
    request: status({ space: { id: "space-1" }, task: task("running"), waiting: null, request: { id: "req-1", state: "working" } }),
    graph: status({ task: task("running"), waiting: null, requestGraph: { state: "waiting" } }),
    neither: status({ task: task("completed") }),
    waiting: status({ task: task("running"), waiting: { questionId: "q-1" }, request: { state: "working" } }),
  };
  const command = [
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference = 'Stop'",
    parser,
    "$cases = $env:WORKFOLD_WAIT_CASES | ConvertFrom-Json",
    "$out = [ordered]@{}",
    "foreach ($name in @('request', 'graph', 'neither', 'waiting')) { $parsed = Read-WorkFoldWaitStatus -Json ([string]$cases.$name); $out[$name] = [ordered]@{ state = $parsed.State; requestState = $parsed.RequestState; waiting = $null -ne $parsed.Waiting } }",
    "try { Read-WorkFoldWaitStatus -Json '{\"ok\":true}' | Out-Null; $out['noData'] = 'accepted' } catch { $out['noData'] = 'refused' }",
    "$out | ConvertTo-Json -Compress",
  ].join("\n");
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { PSModulePath: _inherited, ...env } = process.env;
  const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { env: { ...env, WORKFOLD_WAIT_CASES: JSON.stringify(cases) }, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), {
    request: { state: "running", requestState: "working", waiting: false },
    graph: { state: "running", requestState: "waiting", waiting: false },
    neither: { state: "completed", requestState: "", waiting: false },
    waiting: { state: "running", requestState: "working", waiting: true },
    noData: "refused",
  });
});
