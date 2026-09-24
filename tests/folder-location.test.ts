import assert from "node:assert/strict";
import test from "node:test";

import { shortFolderLocation } from "../web-local/src/lib/folder-location.js";

test("a folder inside the known home directory reads as a ~ path", () => {
  assert.equal(shortFolderLocation("/Users/mat/Documents/Test Workspace", "/Users/mat"), "~/Documents/Test Workspace");
  assert.equal(shortFolderLocation("/Users/mat/Documents/Test Workspace/", "/Users/mat/"), "~/Documents/Test Workspace");
  assert.equal(shortFolderLocation("C:\\Users\\You\\Documents\\Home projects", "c:\\users\\you"), "~/Documents/Home projects");
  assert.equal(shortFolderLocation("/Users/mat", "/Users/mat"), "~");
});

test("the usual home roots read as ~ without a home directory; otherwise the last two segments stand in", () => {
  assert.equal(shortFolderLocation("/Users/mat/Documents/Test Workspace"), "~/Documents/Test Workspace");
  assert.equal(shortFolderLocation("/home/mat/plans"), "~/plans");
  assert.equal(shortFolderLocation("C:\\Users\\You\\Documents\\Plans"), "~/Documents/Plans");
  assert.equal(shortFolderLocation("/Users/mat"), "~");
  assert.equal(shortFolderLocation("/Users/matt/Documents/Plans", "/Users/mat"), "Documents/Plans");
  assert.equal(shortFolderLocation("G:\\My Drive\\Japan trip"), "My Drive/Japan trip");
  assert.equal(shortFolderLocation("/Projects"), "Projects");
  assert.equal(shortFolderLocation(""), "");
});
