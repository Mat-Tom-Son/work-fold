import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "puppeteer-core";
// @ts-expect-error Executable ESM test harness, separate from the application.
import { withDeadline } from "../scripts/linux-wayland-probe/deadline.mjs";

test("desktop deadline bounds Puppeteer discovery even when every CDP command responds", async () => {
  // Mimic a browser that attaches a tab but never delivers its page target.
  // All commands respond; protocolTimeout cannot detect the missing event.
  let commands = 0;
  const transport = {
    onmessage: undefined as ((message: string) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    send(message: string) {
      const { id, method, sessionId } = JSON.parse(message);
      commands++;
      queueMicrotask(() => {
        if (method === "Target.setAutoAttach" && !sessionId) this.onmessage?.(JSON.stringify({
          method: "Target.attachedToTarget", params: { sessionId: "tab-session", waitingForDebugger: false, targetInfo: {
            targetId: "stalled-tab", type: "tab", url: "about:blank", title: "", attached: true,
          } },
        }));
        this.onmessage?.(JSON.stringify({ id, sessionId, result: method === "Target.getBrowserContexts" ? { browserContextIds: [] } : {} }));
      });
    },
    close() { this.onclose?.(); },
  };
  const connection = puppeteer.connect({ transport, protocolTimeout: 10 });
  try {
    await assert.rejects(withDeadline("Private debugger attachment", connection, 100), /Private debugger attachment timed out/);
    assert.ok(commands >= 3, "Browser context, discovery and auto-attach commands must have responded");
  } finally { transport.close(); }
});

test("desktop deadlines retain successful values and the original failure", async () => {
  assert.equal(await withDeadline("ready", Promise.resolve(42), 100), 42);
  const failure = new Error("renderer exited");
  await assert.rejects(withDeadline("ready", Promise.reject(failure), 100), error => error === failure);
});
