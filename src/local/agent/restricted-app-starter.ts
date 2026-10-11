import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export interface RestrictedAppStarterInput {
  id: string;
  title: string;
  description: string;
  icon: string;
}

const appIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const iconPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const reservedFolders = new Set([".work-fold", ".pi", ".workspace"]);

/**
 * A small, working app that already follows the platform's rules: the left
 * pane is home, a tab opens only from a click there, styling comes from the
 * kit and the --wf-* variables, and the rail dot is cleared once seen. A
 * Worker edits it into the real app, then proposes it.
 */
export function restrictedAppStarterFiles(input: RestrictedAppStarterInput): Record<string, string> {
  const id = input.id.trim();
  const title = input.title.trim();
  const description = input.description.trim();
  const icon = input.icon.trim();
  if (!appIdPattern.test(id)) throw new Error("The app id must be lowercase letters, numbers, and hyphens, starting with a letter or number (at most 64).");
  if (!title || title.length > 80 || /[\r\n]/.test(title)) throw new Error("The app title must be one line of at most 80 characters.");
  if (!description || description.length > 280 || /[\r\n]/.test(description)) throw new Error("The app description must be one line of at most 280 characters.");
  if (!iconPattern.test(icon)) throw new Error("The icon must be a name from work-fold's icon catalog, such as apps or checklist.");
  const manifest = {
    version: 2,
    id,
    title,
    description,
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    ui: { icon },
    tools: [],
    automations: [],
    permissions: { network: [] },
  };
  const packageJson = { name: id, version: "0.1.0", private: true, type: "module", agentApp: "agent-app.json" };
  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "agent-app.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <!-- work-fold's own look: fonts, colors, and controls that follow the theme and the work-folder's accent. -->
  <link rel="stylesheet" href="/__work-fold/kit.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body class="wf-app">
  <main id="app"></main>
  <!-- Scripts must be files: inline scripts and inline event handlers are blocked. -->
  <script type="module" src="app.js"></script>
</body>
</html>
`,
    "styles.css": `/* App-specific styles. Use the --wf-* variables so the app follows light and dark. */
#app {
  display: grid;
  gap: 8px;
}
`,
    "app.js": `// ${title.replace(/\*\//g, "* /")}: a work-fold app.
// The left pane (placement "navigator") is the app's home and must work on its
// own. A tab opens only from the person's click in the left pane, one per click.
const bridge = globalThis.workFoldRestrictedApp;
const root = document.querySelector("#app");
const appTitle = ${JSON.stringify(title)};
let context = bridge.context.get();
let items = (await bridge.storage.get("items")) ?? [];

bridge.context.onChanged((next) => {
  context = next;
  render();
});
bridge.storage.onChanged(async (event) => {
  if (!event.reset && !event.keys.includes("items")) return;
  items = (await bridge.storage.get("items")) ?? [];
  render();
});

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

async function addItem(itemTitle) {
  items = [{ id: crypto.randomUUID(), title: itemTitle, createdAt: new Date().toISOString() }, ...items];
  await bridge.storage.set("items", items);
  render();
}

function renderHome() {
  const input = element("input", { className: "wf-input", placeholder: "Add an item", "aria-label": "New item" });
  const form = element("form", {
    className: "wf-toolbar",
    onSubmit: (event) => {
      event.preventDefault();
      const itemTitle = input.value.trim();
      if (!itemTitle) return;
      input.value = "";
      void addItem(itemTitle);
    },
  }, input, element("button", { className: "wf-button wf-button-primary", type: "submit" }, "Add"));
  const list = items.length
    ? element("ul", { className: "wf-list" }, ...items.map((item) => element("li", {},
      element("button", {
        className: "wf-row",
        type: "button",
        // Call tabs.open inside the click handler; anywhere else it is refused.
        onClick: () => void bridge.tabs.open({ tabId: \`item:\${item.id}\`, title: item.title, route: \`/items/\${item.id}\`, state: { id: item.id } }),
      },
      element("span", { className: "wf-row-title" }, item.title),
      element("span", { className: "wf-row-meta" }, new Date(item.createdAt).toLocaleString())))))
    : element("div", { className: "wf-empty" },
      element("strong", {}, "Nothing here yet"),
      element("span", { className: "wf-small" }, "Add the first item above."));
  return [element("h1", { className: "wf-title" }, appTitle), form, list];
}

function renderTab() {
  const item = items.find((entry) => entry.id === context.state?.id);
  if (!item) return [element("div", { className: "wf-empty" }, "This item no longer exists.")];
  return [
    element("h1", { className: "wf-title" }, item.title),
    element("p", { className: "wf-muted" }, \`Added \${new Date(item.createdAt).toLocaleString()}\`),
  ];
}

function render() {
  document.documentElement.dataset.theme = context.theme;
  root.replaceChildren(...(context.placement === "tab" ? renderTab() : renderHome()));
}

render();
// The rail dot (bridge.attention.set({ count })) is the app's to clear once the person has looked.
if (context.placement === "navigator") void bridge.attention.clear().catch(() => {});
`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Writes the starter into a new or empty folder inside the work-folder, never over existing files. */
export async function writeRestrictedAppStarter(workFolderRoot: string, folder: string, files: Record<string, string>): Promise<string> {
  const trimmed = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed || isAbsolute(trimmed) || trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The app folder must be a relative folder inside this work-folder.");
  }
  if (reservedFolders.has(trimmed.split("/")[0]!.toLowerCase())) throw new Error("Apps cannot live in work-fold's own hidden folders.");
  const target = join(workFolderRoot, normalize(trimmed));
  const inside = relative(workFolderRoot, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) {
    throw new Error("The app folder must be inside this work-folder.");
  }
  const existing = await readdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length) throw new Error(`${trimmed} already has files. Choose a new folder for the app.`);
  await mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(target, name), content, { encoding: "utf8", flag: "wx" });
  }
  return trimmed;
}
