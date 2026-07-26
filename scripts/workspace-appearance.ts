import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  accentIdentityFromHex,
  createSpaceAppearanceProposal,
  normalizeHexColor,
  parseSpaceAppearanceProposal,
  resolveSpaceAppearance,
  spaceAppearanceBannerNames,
  type SpaceAppearanceBannerImagePosition,
  type SpaceAppearanceProposal,
} from "../src/shared/space-appearance.js";

const bannerNames = new Set<string>(spaceAppearanceBannerNames);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "create") {
    await createCommand(args);
    return;
  }
  if (command === "validate" || command === "resolve") {
    await inspectCommand(command, args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function createCommand(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      color: { type: "string" },
      secondary: { type: "string" },
      icon: { type: "string" },
      banner: { type: "string" },
      "banner-image": { type: "string" },
      position: { type: "string", default: "center" },
      "workspace-id": { type: "string" },
      "workspace-name": { type: "string" },
      "created-by": { type: "string", default: "other" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const color = requireHex(parsed.values.color, "--color");
  const secondary = parsed.values.secondary ? requireHex(parsed.values.secondary, "--secondary") : undefined;
  const bannerName = parsed.values.banner?.trim().toLowerCase();
  if (bannerName && !bannerNames.has(bannerName)) {
    throw new Error(`--banner must be one of: ${[...bannerNames].join(", ")}`);
  }
  const position = normalizePosition(parsed.values.position);
  const createdBy = normalizeCreatedBy(parsed.values["created-by"]);
  const bannerImage = parsed.values["banner-image"]
    ? await encodeBannerImage(resolve(parsed.values["banner-image"]))
    : undefined;
  const proposal = createSpaceAppearanceProposal({
    name: parsed.values.name?.trim() || "Workspace appearance",
    description: parsed.values.description,
    target: {
      workspaceId: parsed.values["workspace-id"],
      workspaceName: parsed.values["workspace-name"],
    },
    customization: {
      schema: 2,
      primary: accentIdentityFromHex(color),
      ...(secondary ? { secondary: accentIdentityFromHex(secondary) } : {}),
      ...(parsed.values.icon ? { iconName: parsed.values.icon } : {}),
      ...(bannerName ? { bannerName } : {}),
      ...(bannerImage ? { bannerImage, bannerImagePosition: position } : {}),
    },
    createdBy,
  });
  const outputPath = resolve(parsed.values.out ?? defaultProposalName(proposal.name));
  await writeFile(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, {
    encoding: "utf8",
    flag: parsed.values.force ? "w" : "wx",
    mode: 0o600,
  });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ created: true, path: outputPath, proposal }, null, 2)}\n`);
  } else {
    process.stdout.write(`Created code-free appearance proposal: ${outputPath}\n`);
    printAudit(proposal);
  }
}

async function inspectCommand(command: "validate" | "resolve", args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
    },
  });
  if (parsed.positionals.length !== 1) throw new Error(`${command} requires one proposal file.`);
  const path = resolve(parsed.positionals[0]!);
  const proposal = parseSpaceAppearanceProposal(JSON.parse(await readFile(path, "utf8")));
  const resolved = resolveProposal(proposal);
  if (parsed.values.json || command === "resolve") {
    process.stdout.write(`${JSON.stringify({ valid: true, path, proposal, resolved }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Valid Workspace appearance proposal: ${path}\n`);
  printAudit(proposal);
}

function resolveProposal(proposal: SpaceAppearanceProposal) {
  const primary = proposal.customization.primary
    ?? accentIdentityFromHex(proposal.customization.color ?? "#60646c");
  const secondary = proposal.customization.secondary
    ?? (proposal.customization.color2 ? accentIdentityFromHex(proposal.customization.color2) : primary);
  return resolveSpaceAppearance({
    primary,
    secondary,
    bannerName: proposal.customization.bannerName,
    hasBannerImage: Boolean(proposal.customization.bannerImage),
  });
}

function printAudit(proposal: SpaceAppearanceProposal): void {
  const result = resolveProposal(proposal);
  process.stdout.write(`Light and dark semantic roles: ${result.passes ? "PASS" : "NEEDS ATTENTION"}\n`);
  for (const palette of [result.light, result.dark]) {
    const weakest = [...palette.audit].sort((left, right) => {
      const leftScore = Math.min(left.wcag / left.wcagTarget, left.apcaTarget ? left.apca / left.apcaTarget : Number.POSITIVE_INFINITY);
      const rightScore = Math.min(right.wcag / right.wcagTarget, right.apcaTarget ? right.apca / right.apcaTarget : Number.POSITIVE_INFINITY);
      return leftScore - rightScore;
    })[0]!;
    process.stdout.write(`  ${palette.mode}: ${palette.textUi} text, ${palette.solid} solid; weakest ${weakest.role} ${weakest.wcag}:1 / Lc ${weakest.apca}\n`);
  }
  if (result.uncertified.length) {
    process.stdout.write(`  Advisory visual review: ${result.uncertified.join(", ")}\n`);
  }
}

async function encodeBannerImage(path: string): Promise<string> {
  const extension = extname(path).toLowerCase();
  const supported = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
  if (!supported.has(extension)) throw new Error("--banner-image must be PNG, JPEG, WebP, GIF, or BMP.");
  const source = await readFile(path);
  if (source.byteLength > 12 * 1024 * 1024) throw new Error("--banner-image is larger than 12 MB.");
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(source, { animated: false })
    .resize({ width: 1600, height: 640, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const dataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
  if (dataUrl.length > 700_000) throw new Error("Processed banner is too detailed. Choose a simpler or smaller image.");
  return dataUrl;
}

function requireHex(value: string | undefined, option: string): string {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value.trim())) throw new Error(`${option} requires a six-digit hex colour such as #0d74ce.`);
  return normalizeHexColor(value);
}

function normalizePosition(value: string | undefined): SpaceAppearanceBannerImagePosition {
  if (value === "top" || value === "center" || value === "bottom") return value;
  throw new Error("--position must be top, center, or bottom.");
}

function normalizeCreatedBy(value: string | undefined): SpaceAppearanceProposal["createdBy"] {
  if (value === "codex" || value === "claude-code" || value === "human" || value === "other") return value;
  throw new Error("--created-by must be codex, claude-code, human, or other.");
}

function defaultProposalName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space";
  return `${slug}.workspace.json`;
}

function printHelp(): void {
  process.stdout.write(`Workspace appearance proposal tool

Creates and verifies inert, typed appearance files. It never changes the running app.

Commands:
  create   --name "Client work" --color "#0d74ce" [options]
  validate <proposal.workspace.json> [--json]
  resolve  <proposal.workspace.json> [--json]

Create options:
  --secondary "#6550b9"     Optional paired banner colour
  --icon folder             Fluent Space identity icon id
  --banner classic          none, classic, mist, horizon, aurora, halftone,
                            blueprint, pinstripe, ribbon, or bold
  --banner-image <path>     Safe raster image; resized and encoded as WebP
  --position center         top, center, or bottom
  --workspace-id <id>       Advisory target shown during review
  --workspace-name <name>   Advisory target shown during review
  --created-by codex        codex, claude-code, human, or other
  --description <text>
  --out <path>              Defaults to <name>.workspace.json
  --force                   Replace the exact output file
  --json                    Machine-readable output
`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
