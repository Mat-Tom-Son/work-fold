import assert from "node:assert/strict";
import test from "node:test";

import { nativeTabMenuItems, parseNativeTabMenuRequest } from "../desktop/src/tab-context-menu.js";

const snooze = [
  { id: "hour", label: "In 1 hour", detail: "3:45 PM" },
  { id: "tomorrow", label: "Tomorrow", detail: "9:00 AM" },
];

function outline(value: unknown): unknown[] {
  return nativeTabMenuItems(parseNativeTabMenuRequest(value)).map((item) => {
    if (item.type === "separator") return "—";
    if (item.type === "submenu") return { [item.label]: item.items.map((child) => child.type === "item" ? `${child.label} (${child.sublabel})` : "—") };
    return item.enabled === false ? `${item.label} (off)` : item.label;
  });
}

test("a Chat tab's native menu holds the Chat's actions, then the tab strip's", () => {
  assert.deepEqual(outline({ chat: { lifecycle: "active", snooze }, tab: { hasOthers: true }, point: { x: 10.4, y: 20.6 } }), [
    "Rename…", "Make a Copy", "—",
    { Snooze: ["In 1 hour (3:45 PM)", "Tomorrow (9:00 AM)"] }, "Archive", "Delete Chat", "—",
    "Close Tab", "Close Other Tabs",
  ]);
  const snoozeItems = nativeTabMenuItems(parseNativeTabMenuRequest({ chat: { lifecycle: "active", snooze }, point: { x: 0, y: 0 } }))
    .flatMap((item) => item.type === "submenu" ? item.items : []);
  assert.deepEqual(snoozeItems.map((item) => item.type === "item" && item.command), ["snooze:hour", "snooze:tomorrow"]);
});

test("snoozed and archived Chats offer the way back, and the Chats list has no tab actions", () => {
  assert.deepEqual(outline({ chat: { lifecycle: "snoozed", snooze }, point: { x: 0, y: 0 } }), [
    "Rename…", "Make a Copy", "—", "Resume Now", "Archive", "Delete Chat",
  ]);
  assert.deepEqual(outline({ chat: { lifecycle: "archived", snooze }, point: { x: 0, y: 0 } }), [
    "Rename…", "Make a Copy", "—", "Restore to Active", "Delete Chat",
  ]);
});

test("any other tab can be closed from its menu", () => {
  assert.deepEqual(outline({ tab: { hasOthers: false }, point: { x: 0, y: 0 } }), ["Close Tab", "Close Other Tabs (off)"]);
  assert.deepEqual(parseNativeTabMenuRequest({ tab: { hasOthers: true }, point: { x: -5, y: 2_000_000.2 } }).point, { x: 0, y: 1_000_000 });
});

test("tab menu requests take only data, never labels or commands", () => {
  assert.throws(() => parseNativeTabMenuRequest({ point: { x: 0, y: 0 } }), /invalid/);
  assert.throws(() => parseNativeTabMenuRequest({ tab: { hasOthers: true }, label: "Run", point: { x: 0, y: 0 } }), /invalid/);
  assert.throws(() => parseNativeTabMenuRequest({ chat: { lifecycle: "gone", snooze: [] }, point: { x: 0, y: 0 } }), /invalid/);
  assert.throws(() => parseNativeTabMenuRequest({ chat: { lifecycle: "active", snooze: [{ ...snooze[0], command: "delete" }] }, point: { x: 0, y: 0 } }), /snooze/);
  assert.throws(() => parseNativeTabMenuRequest({ chat: { lifecycle: "active", snooze: [{ ...snooze[0], id: "Hour:Now" }] }, point: { x: 0, y: 0 } }), /snooze/);
  assert.throws(() => parseNativeTabMenuRequest({ chat: { lifecycle: "active", snooze: [{ ...snooze[0], label: "x".repeat(81) }] }, point: { x: 0, y: 0 } }), /snooze/);
  assert.throws(() => parseNativeTabMenuRequest({ tab: { hasOthers: "yes" }, point: { x: 0, y: 0 } }), /invalid/);
  assert.throws(() => parseNativeTabMenuRequest({ tab: { hasOthers: true }, point: { x: Number.NaN, y: 0 } }), /position/);
});
