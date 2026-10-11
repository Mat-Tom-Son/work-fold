// Loaded into every test-file process by scripts/run-tests.mjs. It records,
// and never blocks, any filesystem change a test makes beneath the
// developer's real Pi folder, so the runner can fail and name the test file
// instead of quietly leaving sessions, locks, or settings in ~/.pi. It only
// observes this process; the runner's isolated PI_CODING_AGENT_DIR is what
// keeps child processes away from the real folder.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const logFile = process.env.WORKFOLD_TEST_REAL_PI_WRITE_LOG;
const protectedRoots = (process.env.WORKFOLD_TEST_REAL_PI_DIRS ?? "")
  .split(delimiter)
  .filter(Boolean)
  .flatMap((root) => {
    const literal = resolve(root);
    try {
      return [literal, fs.realpathSync.native(literal)];
    } catch {
      return [literal];
    }
  });

if (logFile && protectedRoots.length) {
  const append = fs.appendFileSync;
  const testFile = process.argv.find((argument) => /\.test\.[cm]?[jt]s$/.test(argument)) ?? process.argv.slice(1).join(" ");
  const recorded = new Set();
  const record = (operation, target) => {
    const path = pathOf(target);
    if (!path || !protectedRoots.some((root) => path === root || path.startsWith(`${root}${sep}`))) return;
    const key = `${operation}\0${path}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    try {
      append(logFile, `${JSON.stringify({ testFile, operation, path })}\n`);
    } catch {
      // A missing log must never change the behavior under test.
    }
  };

  const first = ([path]) => [path];
  const both = ([from, to]) => [from, to];
  const second = ([, to]) => [to];
  const opened = ([path, flags]) => (writesOnOpen(flags) ? [path] : []);
  const pathArguments = {
    mkdir: first, writeFile: first, appendFile: first, rm: first, rmdir: first, unlink: first,
    truncate: first, utimes: first, chmod: first, open: opened,
    rename: both, cp: second, copyFile: second, link: second, symlink: second,
  };
  const watch = (api, name, paths) => {
    const original = api[name];
    if (typeof original !== "function") return;
    api[name] = function guardedFilesystemCall(...args) {
      for (const path of paths(args)) record(name, path);
      return Reflect.apply(original, this, args);
    };
  };
  for (const [name, paths] of Object.entries(pathArguments)) {
    watch(fs, name, paths);
    watch(fs, `${name}Sync`, paths);
    watch(fs.promises, name, paths);
  }
  watch(fs, "createWriteStream", ([path, options]) => {
    const flags = typeof options === "object" && options ? options.flags : undefined;
    return writesOnOpen(flags ?? "w") ? [path] : [];
  });
  syncBuiltinESMExports();
}

function writesOnOpen(flags) {
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0;
  }
  return typeof flags === "string" && /[wa+]/.test(flags);
}

function pathOf(target) {
  try {
    if (typeof target === "string") return resolve(target);
    if (target instanceof URL) return target.protocol === "file:" ? resolve(fileURLToPath(target)) : null;
    if (Buffer.isBuffer(target)) return resolve(target.toString());
  } catch {
    return null;
  }
  return null;
}
