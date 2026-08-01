import assert from "node:assert/strict";
import test from "node:test";

import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";

const fileRequest = {
  spaceId: "space-1",
  path: "Reports/Q3.xlsx",
  kind: "file",
  capabilities: { open: true, attach: true, history: true, upload: false, rename: true, delete: true },
  point: { x: 23.6, y: 42.2 },
} as const;

test("native file menus use host-owned labels and a bounded command set", () => {
  const request = parseNativeFileMenuRequest(fileRequest);
  assert.deepEqual(request.point, { x: 24, y: 42 });
  assert.deepEqual(nativeFileMenuItems(request), [
    { type: "item", label: "Open in Excel", command: "open" },
    { type: "item", label: "Show in Finder", command: "reveal" },
    { type: "item", label: "Copy File Path", command: "copy-path" },
    { type: "item", label: "Attach to Chat", command: "attach-chat" },
    { type: "item", label: "Version History", command: "version-history" },
    { type: "separator" },
    { type: "item", label: "Rename…", command: "rename" },
    { type: "item", label: "Delete File", command: "delete" },
  ]);
});

test("native folder menus expose only applicable fixed actions", () => {
  const request = parseNativeFileMenuRequest({
    ...fileRequest,
    path: "Notes",
    kind: "folder",
    capabilities: { open: true, attach: true, history: true, upload: true, rename: false, delete: false },
  });
  assert.deepEqual(nativeFileMenuItems(request).map((item) => item.type === "separator" ? "separator" : item.command), [
    "open", "reveal", "copy-path", "separator", "upload-here",
  ]);
});

test("native file menu requests reject unbounded or path-escaping renderer input", () => {
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, label: "Run arbitrary command" }), /invalid/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "../outside.txt" }), /safe relative/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "/tmp/outside.txt" }), /safe relative/i);
  const { path: _path, ...missingPath } = fileRequest;
  assert.throws(() => parseNativeFileMenuRequest(missingPath), /safe relative/i);
  assert.throws(() => parseNativeFileMenuRequest({
    ...fileRequest,
    capabilities: { ...fileRequest.capabilities, callback: "evil" },
  }), /capabilities/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "", kind: "file" }), /root must be a folder/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, point: { x: Number.NaN, y: 10 } }), /position/i);
});
