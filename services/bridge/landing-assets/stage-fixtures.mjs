import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const assets = dirname(fileURLToPath(import.meta.url));
const repository = resolve(assets, "../../..");
const target = resolve(repository, process.argv[2] ?? "output/playwright/landing-demos-next-release");
const manifest = JSON.parse(await readFile(join(assets, "manifest.json"), "utf8"));
// Refuse to overwrite an earlier capture or a work-folder's portable identity.
await mkdir(dirname(target), { recursive: true });
await mkdir(target);
const projects = [];
for (const workflow of manifest.workflows) {
  const source = join(assets, "fixtures", workflow.slug);
  const root = join(target, workflow.title);
  await cp(join(source, "inputs"), root, { recursive: true, errorOnExist: true, force: false });
  const request = (await readFile(join(source, "request.txt"), "utf8")).replaceAll("{repoRoot}", repository);
  const promptFile = join(target, `${workflow.slug}-request.txt`);
  await writeFile(promptFile, request);
  projects.push({ slug: workflow.slug, root, promptFile });
}
await writeFile(join(target, "projects.json"), JSON.stringify(projects, null, 2) + "\n");
console.log(`Staged ${projects.length} demo work-folders in ${target}`);
