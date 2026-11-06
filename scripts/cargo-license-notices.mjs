import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Retain the notices of the statically bundled Rust dependency graph. */
export async function writeCargoNotices(manifestPath, output) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", "x86_64-unknown-linux-gnu", "--manifest-path", manifestPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const included = new Set();
  function visit(id) {
    if (included.has(id)) return;
    included.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some(kind => kind.kind !== "dev")) visit(dependency.pkg);
    }
  }
  visit(metadata.resolve.root);
  const sections = [];
  for (const dependency of metadata.packages.filter(pkg => included.has(pkg.id) && pkg.source).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = dirname(dependency.manifest_path);
    const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /^(licen[cs]e|copying|copyright|notice)([.-]|$)/i.test(file.name)).map(file => join(directory, file.name));
    if (dependency.license_file) files.push(resolve(directory, dependency.license_file));
    if (!files.length) throw new Error(`Missing bundled license notice for ${dependency.name}@${dependency.version}.`);
    sections.push(`${dependency.name} ${dependency.version}\n${dependency.repository ?? dependency.source}\nDeclared license: ${dependency.license ?? "see text"}\n\n${(await Promise.all([...new Set(files)].sort().map(file => readFile(file, "utf8")))).join("\n\n")}`);
  }
  await writeFile(output, `Third-party Rust components distributed with work-fold\n\n${sections.join("\n\n====================\n\n")}\n`);
}
