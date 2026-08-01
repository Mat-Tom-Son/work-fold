import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  normalizeWorkspaceCheckProposal,
  type WorkspaceCheckProposal,
  type WorkspaceCheckSeverity,
} from "../src/shared/checks.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "create-file-presence") {
    await createFilePresence(args);
    return;
  }
  if (command === "validate") {
    await validateProposal(args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function createFilePresence(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      title: { type: "string" },
      name: { type: "string" },
      file: { type: "string", multiple: true },
      expect: { type: "string", default: "present" },
      severity: { type: "string", default: "warning" },
      "created-by": { type: "string", default: "assistant" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const title = parsed.values.title?.trim();
  if (!title) throw new Error("--title is required.");
  const files = parsed.values.file ?? [];
  if (!files.length) throw new Error("Provide at least one --file <Space-relative-path>.");
  const expect = parsed.values.expect;
  if (expect !== "present" && expect !== "absent") throw new Error("--expect must be present or absent.");
  const severity = normalizeSeverity(parsed.values.severity);
  const createdBy = normalizeCreator(parsed.values["created-by"]);
  const proposal = normalizeWorkspaceCheckProposal({
    kind: "workspace.check-proposal",
    version: 1,
    name: parsed.values.name?.trim() || title,
    createdBy,
    createdAt: new Date().toISOString(),
    check: {
      title,
      severity,
      trigger: "manual",
      sensor: { id: "workspace.file-presence", revision: 1, parameters: { expect } },
      targets: files.map((path) => ({ kind: "file", role: "primary", path })),
    },
  });
  const outputPath = resolve(parsed.values.out ?? defaultProposalName(proposal.name));
  await writeFile(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, {
    encoding: "utf8",
    flag: parsed.values.force ? "w" : "wx",
    mode: 0o600,
  });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ created: true, path: outputPath, proposal }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Created inert Check proposal: ${outputPath}\n`);
  printScope(proposal);
  process.stdout.write("Nothing was enabled or run. Review it, then use workspace checks enable with an explicit Space.\n");
}

async function validateProposal(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  });
  if (parsed.positionals.length !== 1) throw new Error("validate requires one proposal file.");
  const path = resolve(parsed.positionals[0]!);
  const proposal = normalizeWorkspaceCheckProposal(JSON.parse(await readFile(path, "utf8")));
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ valid: true, path, proposal }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Valid inert Check proposal: ${path}\n`);
  printScope(proposal);
}

function printScope(proposal: WorkspaceCheckProposal): void {
  process.stdout.write(`  ${proposal.check.title} (${proposal.check.severity}, manual only)\n`);
  process.stdout.write(`  Sensor: ${proposal.check.sensor.id}@${proposal.check.sensor.revision}\n`);
  for (const target of proposal.check.targets) {
    const future = target.kind === "tree" ? `; ${target.recursive ? "recursive" : "one level"}; ${target.extensions.join(", ")}` : "";
    process.stdout.write(`  - ${target.role} ${target.kind}: ${target.path}${future}\n`);
  }
}

function normalizeSeverity(value: string | undefined): WorkspaceCheckSeverity {
  if (value === "info" || value === "warning" || value === "error") return value;
  throw new Error("--severity must be info, warning, or error.");
}

function normalizeCreator(value: string | undefined): WorkspaceCheckProposal["createdBy"] {
  if (value === "human" || value === "assistant" || value === "codex" || value === "claude-code" || value === "other") return value;
  throw new Error("--created-by must be human, assistant, codex, claude-code, or other.");
}

function defaultProposalName(name: string): string {
  const slug = name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "check";
  return `${slug}.workspace-check.json`;
}

function printHelp(): void {
  process.stdout.write(`Workspace Check proposal tool

Creates and validates inert, typed proposal files. It never enables or runs a Check.

Commands:
  create-file-presence --title "Signed delivery exists" --file "Delivery/signed.pdf" [options]
  validate <proposal.workspace-check.json> [--json]

Create options:
  --file <path>           Exact Space-relative file; repeat for more files
  --expect present       present or absent
  --severity warning     info, warning, or error
  --name <text>          Review/proposal name; defaults to the title
  --created-by assistant human, assistant, codex, claude-code, or other
  --out <path>           Defaults to <name>.workspace-check.json
  --force                Replace the exact output file
  --json                 Machine-readable output
`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
