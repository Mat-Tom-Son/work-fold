import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

/**
 * A real DOM for renderer tests.
 *
 * Most renderer coverage in this repository asserts on component source text,
 * which cannot observe focus, keyboard handling, or background isolation and
 * breaks on ordinary refactors. This harness renders components so those
 * behaviours can be asserted directly.
 *
 * React and react-dom are imported after the globals exist, because both read
 * them while binding their environment.
 */
export interface DomHarness {
  container: HTMLElement;
  render: (node: ReactNode) => Promise<void>;
  press: (key: string, options?: KeyboardEventInit) => Promise<void>;
  settle: () => Promise<void>;
  cleanup: () => Promise<void>;
}

const globalKeys = [
  "Element", "Event", "FocusEvent", "HTMLElement", "KeyboardEvent", "MouseEvent", "Node",
  "cancelAnimationFrame", "document", "getComputedStyle", "navigator", "requestAnimationFrame", "window",
] as const;

export async function createDomHarness(): Promise<DomHarness> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const scope = globalThis as unknown as Record<string, unknown>;
  // Some of these (navigator) are accessor-only globals in current Node, so
  // every one is installed and restored as a property descriptor.
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of globalKeys) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  void scope;

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  let disposed = false;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);

  // jsdom drives requestAnimationFrame off its own clock, so a frame has to be
  // awaited for effects that defer focus restoration to the next frame.
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    });
  };

  return {
    container: container as unknown as HTMLElement,
    render: async (node) => {
      await act(async () => { root.render(node); });
    },
    press: async (key, options = {}) => {
      await act(async () => {
        const target = dom.window.document.activeElement ?? dom.window.document.body;
        target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
      });
    },
    settle,
    // Tests register cleanup with t.after and may also tear down mid-test to
    // start a second harness, so this has to be safe to call twice.
    cleanup: async () => {
      if (disposed) return;
      disposed = true;
      await act(async () => { root.unmount(); });
      container.remove();
      dom.window.close();
      for (const [key, descriptor] of replaced) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      replaced.clear();
    },
  };
}
