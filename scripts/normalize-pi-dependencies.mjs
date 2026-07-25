import { createRequire } from "node:module";
import { cp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPackage = await readJson(join(rootDir, "package.json"));
const piDir = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackage = await readJson(join(piDir, "package.json"));
const expectedPiVersion = rootPackage.dependencies?.["@earendil-works/pi-coding-agent"];

if (piPackage.version !== expectedPiVersion) {
  throw new Error(
    `Refusing to normalize unexpected Pi version ${piPackage.version}; package.json requires ${expectedPiVersion}.`,
  );
}

for (const dependency of [
  { name: "brace-expansion", fixedVersion: "5.0.8", replaceVersions: new Set(["5.0.6", "5.0.7"]) },
  { name: "protobufjs", fixedVersion: "7.6.5", replaceVersions: new Set(["7.6.4"]) },
]) {
  await normalizeDependency(dependency);
}

async function normalizeDependency({ name, fixedVersion, replaceVersions }) {
  const configuredVersion = rootPackage.overrides?.[name];
  if (configuredVersion !== fixedVersion) {
    throw new Error(
      `Refusing to normalize ${name} without the reviewed ${fixedVersion} override (found ${configuredVersion}).`,
    );
  }

  const sourceDir = join(rootDir, "node_modules", name);
  const sourcePackage = await readJson(join(sourceDir, "package.json"));
  if (sourcePackage.version !== fixedVersion) {
    throw new Error(`Root ${name} is ${sourcePackage.version}; expected the reviewed ${fixedVersion} package.`);
  }

  const nestedDir = join(piDir, "node_modules", name);
  const nestedPackagePath = join(nestedDir, "package.json");
  const nestedPackage = await readJsonIfPresent(nestedPackagePath);
  if (nestedPackage?.version !== fixedVersion) {
    if (nestedPackage && !replaceVersions.has(nestedPackage.version)) {
      throw new Error(
        `Refusing to replace unexpected Pi-nested ${name} ${nestedPackage.version}; review the upstream dependency first.`,
      );
    }

    // Pi publishes an npm-shrinkwrap that currently defeats root overrides.
    // Replace only reviewed vulnerable nested copies with the complete fixed
    // package so production pruning and desktop packaging retain the safe code.
    await rm(nestedDir, { recursive: true, force: true });
    await cp(sourceDir, nestedDir, { recursive: true });
  }

  const piRequire = createRequire(join(piDir, "package.json"));
  const resolvedPackagePath = piRequire.resolve(`${name}/package.json`);
  const resolvedPackage = await readJson(resolvedPackagePath);
  if (resolvedPackage.version !== fixedVersion) {
    throw new Error(
      `Pi resolves ${name} ${resolvedPackage.version} at ${resolvedPackagePath}; expected ${fixedVersion}.`,
    );
  }

  console.log(
    `Pi dependency normalization passed: ${name} ${fixedVersion} (${relativeToRoot(dirname(resolvedPackagePath))}).`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function relativeToRoot(path) {
  return path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
}
