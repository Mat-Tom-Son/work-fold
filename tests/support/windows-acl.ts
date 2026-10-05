import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WindowsAccess { protected: boolean; owner: string; allowed: string[]; denied: string[] }

/** Reads a path's DACL as SIDs (never localized names) for Windows privacy assertions. */
export async function readWindowsAccess(path: string): Promise<WindowsAccess> {
  const script = [
    "$acl = Get-Acl -LiteralPath $env:WORKFOLD_ACL_PATH",
    "$sid = [System.Security.Principal.SecurityIdentifier]",
    "$rules = @($acl.GetAccessRules($true, $true, $sid))",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner($sid).Value;",
    "  allowed = @($rules | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique);",
    "  denied = @($rules | Where-Object AccessControlType -eq 'Deny' | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) } | ConvertTo-Json -Compress",
  ].join("\n");
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // A PowerShell 7 parent's PSModulePath stops Windows PowerShell loading Get-Acl.
  const { PSModulePath: _inherited, ...env } = process.env;
  const { stdout } = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...env, WORKFOLD_ACL_PATH: path }, windowsHide: true });
  const value = JSON.parse(stdout) as { protected: boolean; owner: string; allowed: string[] | string | null; denied: string[] | string | null };
  const list = (entry: string[] | string | null) => entry === null ? [] : Array.isArray(entry) ? entry : [entry];
  return { protected: value.protected, owner: value.owner, allowed: list(value.allowed), denied: list(value.denied) };
}
