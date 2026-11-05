// Node cannot import Fluent's icons by name: the package's ESM build re-exports
// extensionless chunks, and its CommonJS build hides the names from Node's
// named-export detection. The renderer imports them by name through Vite, so
// every test process serves the real CommonJS icons as a module with named
// exports. A test that registers its own stand-in for the package still wins:
// hooks registered later run first.
import { createRequire, registerHooks } from "node:module";

const require = createRequire(import.meta.url);
const shimUrl = "work-fold-test:fluent-icons";
let source = null;

registerHooks({
  resolve(specifier, context, next) {
    // Only ESM imports need names; require() (including this file's own) reads the package directly.
    const imported = specifier === "@fluentui/react-icons" && context.conditions?.includes("import") && !context.conditions.includes("require");
    return imported ? { url: shimUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== shimUrl) return next(url, context);
    if (source === null) {
      const entry = require.resolve("@fluentui/react-icons");
      const names = Object.keys(require(entry)).filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
      source = [
        `import { createRequire } from "node:module";`,
        `const icons = createRequire(${JSON.stringify(entry)})(${JSON.stringify(entry)});`,
        ...names.map((name) => `export const ${name} = icons.${name};`),
        `export default icons;`,
      ].join("\n");
    }
    return { format: "module", source, shortCircuit: true };
  },
});
