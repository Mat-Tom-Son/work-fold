/**
 * A browser page's structure as a Worker reads it: the accessibility tree
 * Chromium already computes, written as indented lines. Every element a
 * Worker can act on carries a ref (`e<backend node id>`), which stays valid
 * until the page navigates, so a Worker can read once and act several times.
 */

/** The parts of a Chrome DevTools Protocol `Accessibility.AXNode` this formatter reads. */
export interface AccessibilityNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Containers that add nothing a reader needs; their children are written in their place. */
const transparentRoles = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak", "ListMarker", "RootWebArea", "WebArea"]);
const interactiveRoles = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "listbox", "treeitem",
]);
const valueRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

const maxNameLength = 200;
const maxValueLength = 300;
const maxUrlLength = 160;

/** The ref a Worker uses for the element with this backend node id. */
export function browserRef(backendNodeId: number): string {
  return `e${backendNodeId}`;
}

/** The backend node id behind a ref, or null when it is not one. */
export function backendNodeIdForRef(ref: string): number | null {
  const match = /^e(\d{1,12})$/.exec(ref.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function formatAccessibilitySnapshot(nodes: AccessibilityNode[]): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
  if (!root) return "";
  const lines: string[] = [];
  const visited = new Set<string>();

  const textOf = (node: AccessibilityNode): string => cleanText(node.name?.value, maxNameLength);

  /** The text inside a container whose only readable content is text, or null. */
  const onlyText = (node: AccessibilityNode, depth = 0): string[] | null => {
    if (depth > 12) return null;
    const parts: string[] = [];
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      const role = roleOf(child);
      if (role === "StaticText") {
        const text = textOf(child);
        if (text) parts.push(text);
        continue;
      }
      if (child.ignored || transparentRoles.has(role)) {
        const inner = onlyText(child, depth + 1);
        if (!inner) return null;
        parts.push(...inner);
        continue;
      }
      return null;
    }
    return parts;
  };

  const walk = (node: AccessibilityNode, depth: number, parentName: string): void => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = roleOf(node);
    if (node.ignored || transparentRoles.has(role)) {
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) walk(child, depth, parentName);
      }
      return;
    }
    const indent = "  ".repeat(depth);
    const name = textOf(node);
    if (role === "StaticText") {
      if (name && name !== parentName) lines.push(`${indent}- text: ${name}`);
      return;
    }
    const properties = propertyMap(node);
    const refable = node.backendDOMNodeId !== undefined && (interactiveRoles.has(role) || properties.get("focusable") === true);
    const parts = [`${indent}- ${role}`];
    if (name) parts.push(JSON.stringify(name));
    parts.push(...attributes(role, properties));
    if (valueRoles.has(role)) {
      const value = cleanText(node.value?.value, maxValueLength);
      if (value && value !== name) parts.push(`value=${JSON.stringify(value)}`);
    }
    if (role === "link") {
      const url = typeof properties.get("url") === "string" ? String(properties.get("url")) : "";
      if (url && !url.startsWith("javascript:")) parts.push(`→ ${truncate(url, maxUrlLength)}`);
    }
    if (refable) parts.push(`[ref=${browserRef(node.backendDOMNodeId!)}]`);
    const text = name ? null : onlyText(node);
    if (text && text.length) {
      lines.push(`${parts.join(" ")}: ${truncate(text.join(" "), maxNameLength)}`);
      return;
    }
    lines.push(parts.join(" "));
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1, name);
    }
  };

  walk(root, 0, "");
  return lines.join("\n");
}

/** Lines of a snapshot that mention `query`, ignoring case; refs come along with their line. */
export function findInSnapshot(snapshot: string, query: string): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return snapshot;
  return snapshot.split("\n").filter((line) => line.toLowerCase().includes(needle)).map((line) => line.trimStart()).join("\n");
}

function roleOf(node: AccessibilityNode): string {
  return typeof node.role?.value === "string" ? node.role.value : "";
}

function propertyMap(node: AccessibilityNode): Map<string, unknown> {
  return new Map((node.properties ?? []).map((property) => [property.name, property.value?.value]));
}

function attributes(role: string, properties: Map<string, unknown>): string[] {
  const result: string[] = [];
  const checked = properties.get("checked");
  if (checked === true || checked === "true") result.push("[checked]");
  else if (checked === "mixed") result.push("[checked=mixed]");
  else if ((checked === false || checked === "false") && (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox")) result.push("[unchecked]");
  if (properties.get("pressed") === true || properties.get("pressed") === "true") result.push("[pressed]");
  if (properties.get("selected") === true) result.push("[selected]");
  const expanded = properties.get("expanded");
  if (expanded === true) result.push("[expanded]");
  else if (expanded === false) result.push("[collapsed]");
  if (properties.get("disabled") === true) result.push("[disabled]");
  if (properties.get("required") === true) result.push("[required]");
  if (properties.get("readonly") === true) result.push("[readonly]");
  if (properties.get("focused") === true) result.push("[focused]");
  const level = properties.get("level");
  if (typeof level === "number" && role === "heading") result.push(`[level=${level}]`);
  return result;
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return truncate(String(value).replace(/\s+/g, " ").trim(), limit);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
