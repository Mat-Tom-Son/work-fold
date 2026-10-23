/**
 * browser_*: the built-in browser's tools, carried by every Worker and the
 * work-fold agent in the desktop app (docs/built-in-browser.md). The browser
 * is shared with the person: its tabs sit in their tab strip, a tab a Worker
 * opens appears there too, and a Worker can read and use the tab the person
 * is looking at. The desktop host behind these tools drives each page through
 * Chromium's own debugging protocol.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { BrowserActionResult, BrowserTabSummary, BrowserToolHost } from "../../shared/browser.js";

export interface BrowserToolsInput {
  host: BrowserToolHost;
  /** This Chat's identity: tabs it opens are its own, and it may close only those. */
  owner?: string;
}

export const browserToolNames = [
  "browser_tabs",
  "browser_open",
  "browser_navigate",
  "browser_read",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_evaluate",
  "browser_wait",
  "browser_close",
] as const;

const tabParameter = {
  type: "string",
  description: "The tab id from browser_tabs or browser_open. Defaults to the tab this Chat last used, else the tab the person is looking at.",
} as const;

const refParameter = {
  type: "string",
  description: "An element ref such as e42 from browser_read's structure. Refs stay valid until the page changes.",
} as const;

/** One line naming a tab: its id, title, address, and whether it is loading or in front. */
export function describeBrowserTab(tab: BrowserTabSummary): string {
  const notes = [
    tab.loading ? "still loading" : "",
    tab.viewing ? "the person is looking at it" : "",
  ].filter(Boolean);
  const title = tab.title ? ` "${tab.title}"` : "";
  const line = `Tab ${tab.tab}${title} · ${tab.url || "blank"}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  const lines = [line];
  if (tab.error) lines.push(`The page did not load: ${tab.error}`);
  // Only the person answers a site's request; a Worker says what is waiting.
  if (tab.asking) lines.push(`${tab.asking} Only the person can answer; tell them it is waiting in the tab.`);
  return lines.join("\n");
}

function describeAction(result: BrowserActionResult, done: string): string {
  const after = result.navigated
    ? "It led to a new page; read it again before the next step."
    : "Read the page again if what you do next depends on the change.";
  return `${done}\n${describeBrowserTab(result.tab)}\n${after}`;
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
}

export function createBrowserTools(input: BrowserToolsInput): ToolDefinition<any>[] {
  const { host, owner } = input;
  /** This Chat's identity on every call, so the person sees whose Worker is using a page. */
  const by = owner ? { owner } : {};
  /** The tab this Chat last opened or used. */
  let lastTab: string | null = null;

  async function resolveTab(value: unknown): Promise<string> {
    const named = optionalString(value, "tab")?.trim();
    if (named) return named;
    const tabs = await host.tabs();
    if (lastTab && tabs.some((tab) => tab.tab === lastTab)) return lastTab;
    const viewing = tabs.find((tab) => tab.viewing);
    if (viewing) return viewing.tab;
    throw new Error("No browser tab is in use yet. Open a page with browser_open, or pick a tab from browser_tabs.");
  }

  function used(tab: string): void {
    lastTab = tab;
  }

  const tabs: ToolDefinition<any> = {
    name: "browser_tabs",
    label: "Browser tabs",
    description: "List the open tabs of work-fold's built-in browser: each tab's id, title, address, and which one the person is looking at. The person's own tabs are included; you can read and use them.",
    promptSnippet: "List the built-in browser's open tabs",
    promptGuidelines: [
      "work-fold has a built-in browser shared with the person: its tabs sit in their tab strip, and tabs you open appear there too. Use the browser_* tools to look at web pages, sites you are building or a local server you started, and to work in pages. Its sign-ins are its own, separate from the person's Chrome; use the chrome_* tools only when the task needs their Chrome profile.",
      "When the person refers to the page they have open, call browser_tabs and use the tab they are looking at.",
      "Read a page with browser_read: its structure lists headings, text, and the elements you can use, each with a ref such as e42. Click and type with those refs, and read again after the page changes. Use browser_screenshot when how the page looks matters.",
      "browser_open puts a tab behind the person's work unless they asked to see it (show:true). Close the tabs you opened only as steps; leave open what the person will want to look at.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false } as any,
    async execute() {
      const list = await host.tabs();
      if (!list.length) return text("No browser tabs are open. Open one with browser_open.", { tabs: 0 });
      return text(["Browser tabs:", ...list.map((tab) => `- ${describeBrowserTab(tab)}`)].join("\n"), { tabs: list.length });
    },
  };

  const open: ToolDefinition<any> = {
    name: "browser_open",
    label: "Open web page",
    description: "Open a web address in a new tab of the built-in browser and wait for it to load. Accepts full addresses, bare hosts (example.com), local servers (localhost:3000), absolute file paths, or words to search for. The tab opens behind the person's work unless show is true.",
    promptSnippet: "Open a web page in a new built-in browser tab",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "The address, file path, or search words." },
        show: { type: "boolean", description: "Bring the new tab to the front of the person's window. Defaults to false." },
      },
      required: ["url"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { url?: unknown; show?: unknown };
      const url = optionalString(value.url, "url");
      if (!url?.trim()) throw new Error("browser_open needs an address.");
      const tab = await host.open({ url, ...(value.show === true ? { show: true } : {}), ...(signal ? { signal } : {}), ...by });
      used(tab.tab);
      return text(`Opened a tab.\n${describeBrowserTab(tab)}`, { tab: tab.tab, url: tab.url });
    },
  };

  const navigate: ToolDefinition<any> = {
    name: "browser_navigate",
    label: "Go to web page",
    description: "Load an address in an existing tab, or go back, forward, or reload it, and wait for the page to load.",
    promptSnippet: "Load an address, go back or forward, or reload a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        to: { type: "string", minLength: 1, description: "An address or search words, or back, forward, or reload." },
      },
      required: ["to"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; to?: unknown };
      const to = optionalString(value.to, "to");
      if (!to?.trim()) throw new Error("browser_navigate needs an address, or back, forward, or reload.");
      const tab = await host.navigate({ tab: await resolveTab(value.tab), to, ...(signal ? { signal } : {}), ...by });
      used(tab.tab);
      return text(describeBrowserTab(tab), { tab: tab.tab, url: tab.url });
    },
  };

  const read: ToolDefinition<any> = {
    name: "browser_read",
    label: "Read web page",
    description: "Read a browser tab. structure (the default) lists the page's headings, text, and the elements you can use, each with a ref for browser_click and browser_type. text returns the page's visible text. console returns its recent console messages and failed requests. find keeps only the lines that mention it. Long pages come in parts: pass nextOffset as offset to read on.",
    promptSnippet: "Read a browser tab's structure, text, or console",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        mode: { type: "string", enum: ["structure", "text", "console"], description: "What to read. Defaults to structure." },
        find: { type: "string", description: "Keep only lines that mention this, ignoring case." },
        offset: { type: "integer", minimum: 0, description: "Where to continue a long page, from a previous nextOffset." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const value = params as { tab?: unknown; mode?: unknown; find?: unknown; offset?: unknown };
      const tabId = await resolveTab(value.tab);
      const mode = value.mode === "text" || value.mode === "console" ? value.mode : "structure";
      used(tabId);
      if (mode === "console") {
        const result = await host.console({ tab: tabId, ...by });
        const find = optionalString(value.find, "find")?.toLowerCase();
        const entries = find ? result.entries.filter((entry) => entry.toLowerCase().includes(find)) : result.entries;
        return text([describeBrowserTab(result.tab), entries.length ? entries.join("\n") : "No console messages or failed requests."].join("\n"), { tab: tabId, entries: entries.length });
      }
      const offset = optionalNumber(value.offset, "offset");
      const find = optionalString(value.find, "find");
      const result = await host.read({ tab: tabId, mode, ...(find ? { find } : {}), ...(offset !== undefined ? { offset: Math.max(0, Math.floor(offset)) } : {}), ...by });
      const parts = [describeBrowserTab(result.tab)];
      if (!result.text) parts.push(find ? `Nothing on the page mentions "${find}".` : "The page has no readable content yet.");
      else parts.push("", result.text);
      if (result.nextOffset !== null) parts.push("", `Showing up to character ${result.nextOffset} of ${result.total}. Read on with offset ${result.nextOffset}.`);
      return text(parts.join("\n"), { tab: tabId, mode, total: result.total, nextOffset: result.nextOffset });
    },
  };

  const screenshot: ToolDefinition<any> = {
    name: "browser_screenshot",
    label: "Look at web page",
    description: "Take a picture of a browser tab as it looks now: the visible part of the page, one element (ref), or the whole page (fullPage). Picture coordinates are page pixels that browser_click accepts as x and y.",
    promptSnippet: "See how a browser tab looks",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        ref: refParameter,
        fullPage: { type: "boolean", description: "Capture the whole page instead of the visible part, up to 8,000 pixels tall." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const value = params as { tab?: unknown; ref?: unknown; fullPage?: unknown };
      const tabId = await resolveTab(value.tab);
      const ref = optionalString(value.ref, "ref");
      used(tabId);
      const shot = await host.screenshot({ tab: tabId, ...(ref ? { ref } : {}), ...(value.fullPage === true ? { fullPage: true } : {}), ...by });
      return {
        content: [
          { type: "text" as const, text: `${describeBrowserTab(shot.tab)}\nPicture: ${shot.width}×${shot.height} page pixels.` },
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
        ],
        details: { tab: tabId, width: shot.width, height: shot.height },
      };
    },
  };

  const click: ToolDefinition<any> = {
    name: "browser_click",
    label: "Click in web page",
    description: "Click an element by ref, or a point by x and y in page pixels from a screenshot. Waits briefly for what the click starts, and says whether it led to a new page.",
    promptSnippet: "Click an element in a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        ref: refParameter,
        x: { type: "number", minimum: 0, description: "Horizontal position in page pixels, with y, when there is no ref." },
        y: { type: "number", minimum: 0, description: "Vertical position in page pixels, with x, when there is no ref." },
        double: { type: "boolean", description: "Double-click." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; ref?: unknown; x?: unknown; y?: unknown; double?: unknown };
      const tabId = await resolveTab(value.tab);
      const ref = optionalString(value.ref, "ref");
      const x = optionalNumber(value.x, "x");
      const y = optionalNumber(value.y, "y");
      used(tabId);
      const result = await host.click({ tab: tabId, ...(ref ? { ref } : {}), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(value.double === true ? { double: true } : {}), ...(signal ? { signal } : {}), ...by });
      return text(describeAction(result, ref ? `Clicked ${ref}.` : `Clicked at ${x}, ${y}.`), { tab: tabId, navigated: result.navigated });
    },
  };

  const type: ToolDefinition<any> = {
    name: "browser_type",
    label: "Type in web page",
    description: "Type text into a field. With a ref, the field's current contents are replaced unless clear is false; for a drop-down list, text picks the option whose value or label matches. Without a ref, the text goes where the cursor is. submit presses Enter afterwards.",
    promptSnippet: "Type into a field in a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        ref: refParameter,
        text: { type: "string", description: "The text to type, or the option to choose. Empty text with a ref clears the field." },
        clear: { type: "boolean", description: "Replace what the field holds. Defaults to true with a ref, false without." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["text"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; ref?: unknown; text?: unknown; clear?: unknown; submit?: unknown };
      if (typeof value.text !== "string") throw new Error("browser_type needs text.");
      const tabId = await resolveTab(value.tab);
      const ref = optionalString(value.ref, "ref");
      used(tabId);
      const result = await host.type({
        tab: tabId,
        text: value.text,
        ...(ref ? { ref } : {}),
        ...(typeof value.clear === "boolean" ? { clear: value.clear } : {}),
        ...(value.submit === true ? { submit: true } : {}),
        ...(signal ? { signal } : {}),
        ...by,
      });
      return text(describeAction(result, `Typed ${value.text.length} characters${ref ? ` into ${ref}` : ""}${value.submit === true ? " and pressed Enter" : ""}.`), { tab: tabId, navigated: result.navigated });
    },
  };

  const press: ToolDefinition<any> = {
    name: "browser_press",
    label: "Press keys in web page",
    description: "Press keys in a browser tab, in order: names such as Enter, Tab, Escape, ArrowDown, PageDown, or combinations such as Shift+Tab and Meta+A, separated by spaces.",
    promptSnippet: "Press keys in a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        keys: { type: "string", minLength: 1, description: "For example \"Enter\", \"Tab Tab Enter\", or \"Meta+A Backspace\"." },
      },
      required: ["keys"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; keys?: unknown };
      const keys = optionalString(value.keys, "keys");
      if (!keys?.trim()) throw new Error("browser_press needs keys.");
      const tabId = await resolveTab(value.tab);
      used(tabId);
      const result = await host.press({ tab: tabId, keys, ...(signal ? { signal } : {}), ...by });
      return text(describeAction(result, `Pressed ${keys.trim()}.`), { tab: tabId, navigated: result.navigated });
    },
  };

  const scroll: ToolDefinition<any> = {
    name: "browser_scroll",
    label: "Scroll web page",
    description: "Scroll a browser tab: to an element (ref), or by screenfuls in a direction (down by one by default).",
    promptSnippet: "Scroll a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        ref: refParameter,
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Defaults to down." },
        amount: { type: "number", exclusiveMinimum: 0, description: "How many screenfuls. Defaults to 1." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; ref?: unknown; direction?: unknown; amount?: unknown };
      const tabId = await resolveTab(value.tab);
      const ref = optionalString(value.ref, "ref");
      const direction = value.direction === "up" || value.direction === "left" || value.direction === "right" ? value.direction : "down";
      const amount = optionalNumber(value.amount, "amount");
      used(tabId);
      const result = await host.scroll({ tab: tabId, ...(ref ? { ref } : { direction }), ...(amount !== undefined ? { amount } : {}), ...(signal ? { signal } : {}), ...by });
      return text(`${ref ? `Scrolled to ${ref}.` : `Scrolled ${direction}.`}\n${describeBrowserTab(result.tab)}`, { tab: tabId });
    },
  };

  const evaluate: ToolDefinition<any> = {
    name: "browser_evaluate",
    label: "Run script in web page",
    description: "Run JavaScript in a browser tab's page and return its result as text (promises are awaited, values returned as JSON). Use it to read what the page structure does not show, or to check a page you are building.",
    promptSnippet: "Run JavaScript in a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        script: { type: "string", minLength: 1, description: "An expression, for example document.title or (async () => { … })()." },
      },
      required: ["script"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; script?: unknown };
      const script = optionalString(value.script, "script");
      if (!script?.trim()) throw new Error("browser_evaluate needs a script.");
      const tabId = await resolveTab(value.tab);
      used(tabId);
      const result = await host.evaluate({ tab: tabId, script, ...(signal ? { signal } : {}), ...by });
      return text(`${describeBrowserTab(result.tab)}\nResult:\n${result.result}`, { tab: tabId });
    },
  };

  const wait: ToolDefinition<any> = {
    name: "browser_wait",
    label: "Wait for web page",
    description: "Wait until text appears in a browser tab, or until it finishes loading, for up to seconds (10 by default).",
    promptSnippet: "Wait for text or loading in a browser tab",
    parameters: {
      type: "object",
      properties: {
        tab: tabParameter,
        text: { type: "string", description: "Text to wait for, ignoring case. Omit it to wait for loading to finish." },
        seconds: { type: "number", minimum: 0, description: "The longest to wait. Defaults to 10." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const value = params as { tab?: unknown; text?: unknown; seconds?: unknown };
      const tabId = await resolveTab(value.tab);
      const wanted = optionalString(value.text, "text");
      const seconds = optionalNumber(value.seconds, "seconds") ?? 10;
      used(tabId);
      const result = await host.wait({ tab: tabId, seconds: Math.max(0, seconds), ...(wanted ? { text: wanted } : {}), ...(signal ? { signal } : {}), ...by });
      const outcome = result.found === true
        ? `"${wanted}" is on the page.`
        : result.found === false ? `"${wanted}" did not appear within ${seconds} s.` : result.tab.loading ? `Still loading after ${seconds} s.` : "The page has finished loading.";
      return text(`${outcome}\n${describeBrowserTab(result.tab)}`, { tab: tabId, found: result.found });
    },
  };

  const close: ToolDefinition<any> = {
    name: "browser_close",
    label: "Close browser tab",
    description: "Close a browser tab this Chat opened. The person's tabs, and tabs another Chat opened, stay open.",
    promptSnippet: "Close a browser tab you opened",
    parameters: {
      type: "object",
      properties: { tab: { type: "string", minLength: 1, description: "The tab id to close." } },
      required: ["tab"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const value = params as { tab?: unknown };
      const tabId = optionalString(value.tab, "tab");
      if (!tabId) throw new Error("browser_close needs a tab id.");
      await host.close({ tab: tabId, ...by });
      if (lastTab === tabId) lastTab = null;
      return text(`Closed tab ${tabId}.`, { tab: tabId });
    },
  };

  return [tabs, open, navigate, read, screenshot, click, type, press, scroll, evaluate, wait, close];
}
