import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WORKSPACE_CLI_ACT_MAX_PAYLOAD_BYTES,
  WORKSPACE_CLI_ACT_PROTOCOL_VERSION,
  createWorkspaceCliActRequest,
  isWorkspaceCliActRequest,
  parseWorkspaceCliActRequest,
  parseWorkspaceCliRequestEnvelope,
} from "../src/local/cli/index.js";

const cwd = resolve(tmpdir());
const token = "a".repeat(64);
const createdAt = new Date().toISOString();

test("act request parsing enforces exact keys, token shape, and payload bounds", () => {
  const id = randomUUID();
  const parsed = parseWorkspaceCliActRequest({
    protocolVersion: 2,
    lane: "act",
    id,
    argv: ["chat", "status", "--space", "space-1"],
    cwd,
    createdAt,
    actToken: token,
    payload: { messageFile: "hello" },
  });
  assert.equal(parsed.protocolVersion, WORKSPACE_CLI_ACT_PROTOCOL_VERSION);
  assert.equal(parsed.id, id);
  assert.equal(parsed.payload?.messageFile, "hello");

  const base = { protocolVersion: 2, lane: "act", id: randomUUID(), argv: [], cwd, createdAt, actToken: token };
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, extra: true }), /unsupported field: extra/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, lane: "read" }), /lane/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, actToken: "short" }), /token is malformed/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, actToken: `${token}!` }), /token is malformed/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, cwd: "relative/path" }), /absolute path/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, createdAt: "not-a-date" }), /ISO timestamp/);
  assert.throws(() => parseWorkspaceCliActRequest({ ...base, payload: { other: 1 } }), /unsupported field: other/);
  assert.throws(
    () => parseWorkspaceCliActRequest({ ...base, payload: { messageFile: 42 } }),
    /messageFile must be text/,
  );

  const boundary = "y".repeat(WORKSPACE_CLI_ACT_MAX_PAYLOAD_BYTES);
  assert.equal(
    parseWorkspaceCliActRequest({ ...base, id: randomUUID(), payload: { messageFile: boundary } }).payload?.messageFile,
    boundary,
  );
  assert.throws(
    () => parseWorkspaceCliActRequest({ ...base, payload: { messageFile: `${boundary}z` } }),
    /exceeds/,
  );
});

test("the request envelope dispatches versions to their lanes", () => {
  const v1 = parseWorkspaceCliRequestEnvelope({
    protocolVersion: 1,
    id: randomUUID(),
    argv: ["context"],
    cwd,
    createdAt,
  });
  assert.equal(v1.protocolVersion, 1);
  assert.equal(isWorkspaceCliActRequest(v1), false);

  const act = parseWorkspaceCliRequestEnvelope({
    protocolVersion: 2,
    lane: "act",
    id: randomUUID(),
    argv: ["chat", "create", "--space", "space-1"],
    cwd,
    createdAt,
    actToken: token,
  });
  assert.equal(isWorkspaceCliActRequest(act), true);

  assert.throws(
    () => parseWorkspaceCliRequestEnvelope({ protocolVersion: 3, id: randomUUID(), argv: [], cwd, createdAt }),
    /Unsupported CLI protocol version/,
  );
});

test("createWorkspaceCliActRequest validates and normalizes like the parser", () => {
  const id = randomUUID();
  const request = createWorkspaceCliActRequest({
    id: id.toUpperCase(),
    argv: ["spaces", "create", "--name", "Home"],
    cwd: join(cwd, "."),
    actToken: token,
  });
  assert.equal(request.id, id.toLowerCase());
  assert.equal(request.cwd, cwd);
  assert.equal(request.lane, "act");
});
