#!/usr/bin/env tsx
/**
 * work-fold-drive: programmatic test driver for the work-fold agent harness.
 *
 * Runs one real agent turn through the local API (same code path as the
 * desktop app: native Pi runtime, built-in tools, skills, and extensions) and emits
 * a structured turn report so an agent or script can assert on the outcome.
 *
 * Usage:
 *   tsx scripts/work-fold-drive.ts --space-root <folder> --prompt "..." [options]
 *
 * Options:
 *   --space-root <path> Folder to open as the Space (created if missing).
 *   --space-id <id>     Reuse an already-registered space instead.
 *   --prompt <text>         Prompt text. Use --prompt-file for long prompts.
 *   --prompt-file <path>    Read the prompt from a file ("-" for stdin).
 *   --conversation <id>     Continue an existing conversation (default: new).
 *   --context <space-path>  Space-relative file to attach as chat context
 *                           (repeatable).
 *   --attach <origin>       Drive an already-running local API (e.g.
 *                           http://127.0.0.1:4327) instead of starting one
 *                           in-process. Env overrides below do not apply.
 *   --port <n>              Port for the in-process server (default: ephemeral).
 *   --agent-dir <path>      Isolated Pi SDK config dir so
 *                           test runs never share state with the desktop app.
 *   --timeout <seconds>     Max wait for turn completion (default: 900).
 *   --json                  Emit a machine-readable JSON report on stdout.
 *   --quiet                 Suppress live event narration on stderr.
 *
 * Provider credentials come from Pi's auth storage or standard provider
 * environment variables. In-process runs use temporary work-fold app state
 * unless WORKFOLD_STATE_DIR is explicitly set.
 *
 * Exit codes: 0 = turn completed, 1 = turn errored, 2 = timeout, 3 = usage.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface DriveArgs {
  space?: string;
  spaceId?: string;
  prompt?: string;
  promptFile?: string;
  conversation?: string;
  context: string[];
  attach?: string;
  port?: number;
  agentDir?: string;
  timeoutSeconds: number;
  json: boolean;
  quiet: boolean;
}

interface ChatEvent {
  type: string;
  conversationId?: string;
  message?: string;
  text?: string;
  thinkingPhase?: string;
  toolCallId?: string;
  toolName?: string;
  phase?: string;
  detail?: string;
  receivedAt: string;
}

interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
  phases: string[];
  detail?: string;
  errored: boolean;
}

interface TurnReport {
  ok: boolean;
  outcome: "completed" | "error" | "timeout";
  durationMs: number;
  origin: string;
  spaceId: string;
  spaceRoot: string;
  conversationId: string;
  prompt: string;
  assistantText: string;
  toolCalls: ToolCallSummary[];
  statusMessages: string[];
  errors: string[];
  events: ChatEvent[];
}

function usage(message?: string): never {
  if (message) console.error(`work-fold-drive: ${message}`);
  console.error('Usage: tsx scripts/work-fold-drive.ts --space-root <folder> --prompt "..." [--json] [--timeout <s>]');
  console.error("Run with --help (or read the header of this file) for all options.");
  process.exit(3);
}

function parseArgs(argv: string[]): DriveArgs {
  const args: DriveArgs = { context: [], timeoutSeconds: 900, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage(`${flag} requires a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--space-root": args.space = next(); break;
      case "--space-id": args.spaceId = next(); break;
      case "--prompt": args.prompt = next(); break;
      case "--prompt-file": args.promptFile = next(); break;
      case "--conversation": args.conversation = next(); break;
      case "--context": args.context.push(next()); break;
      case "--attach": args.attach = next(); break;
      case "--port": args.port = Number(next()); break;
      case "--agent-dir": args.agentDir = next(); break;
      case "--timeout": args.timeoutSeconds = Number(next()); break;
      case "--json": args.json = true; break;
      case "--quiet": args.quiet = true; break;
      case "--help": case "-h": usage(); break;
      default: usage(`unknown option ${flag}`);
    }
  }
  if (!args.space && !args.spaceId) usage("--space-root <folder> or --space-id <id> is required");
  if (!args.prompt && !args.promptFile) usage('--prompt "..." or --prompt-file <path> is required');
  if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)) usage("--port must be 0-65535");
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) usage("--timeout must be a positive number of seconds");
  return args;
}

async function readPrompt(args: DriveArgs): Promise<string> {
  if (args.prompt) return args.prompt;
  if (args.promptFile === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return (await readFile(args.promptFile!, "utf8")).trim();
}

async function api<T>(origin: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload as T;
}

/** Subscribe to the conversation SSE stream. Resolves once connected. */
async function openChatStream(
  origin: string,
  spaceId: string,
  conversationId: string,
  onEvent: (event: ChatEvent) => void,
): Promise<{ done: Promise<"done" | "closed">; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(
    `${origin}/api/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/events`,
    { signal: controller.signal },
  );
  if (!response.ok || !response.body) throw new Error(`Chat event stream failed (${response.status}).`);

  const done = (async (): Promise<"done" | "closed"> => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const event: ChatEvent = { ...(parsed as object), type: String(parsed.type ?? "unknown"), receivedAt: new Date().toISOString() };
          onEvent(event);
          if (event.type === "done" || event.type === "error") return "done";
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    return "closed";
  })();

  return { done, close: () => controller.abort() };
}

function summarizeToolCalls(events: ChatEvent[]): ToolCallSummary[] {
  const calls = new Map<string, ToolCallSummary>();
  for (const event of events) {
    if (event.type !== "tool") continue;
    const id = event.toolCallId ?? `${event.toolName ?? "tool"}-${calls.size}`;
    const existing = calls.get(id) ?? { toolCallId: id, toolName: event.toolName ?? "unknown", phases: [], errored: false };
    if (event.phase && existing.phases.at(-1) !== event.phase) existing.phases.push(event.phase);
    if (event.detail) existing.detail = event.detail;
    if (event.phase === "error") existing.errored = true;
    calls.set(id, existing);
  }
  return [...calls.values()];
}

function renderMarkdownReport(report: TurnReport): string {
  const lines: string[] = [];
  const outcomeLabel = report.outcome === "completed" ? "completed" : report.outcome === "timeout" ? "TIMED OUT" : "ERRORED";
  lines.push(`# work-fold turn report — ${outcomeLabel} in ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push(`- Space: ${report.spaceId} (${report.spaceRoot})`);
  lines.push(`- Conversation: ${report.conversationId}`);
  lines.push(`- API: ${report.origin}`);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(report.prompt);
  lines.push("");
  lines.push("## Assistant response");
  lines.push("");
  lines.push(report.assistantText || "(no assistant text)");
  lines.push("");
  lines.push(`## Tool calls (${report.toolCalls.length})`);
  lines.push("");
  if (!report.toolCalls.length) lines.push("(none)");
  for (const call of report.toolCalls) {
    const marker = call.errored ? "ERROR" : call.phases.at(-1) ?? "?";
    lines.push(`- ${call.toolName} [${marker}]${call.detail ? ` — ${call.detail}` : ""}`);
  }
  lines.push("");
  if (report.errors.length) {
    lines.push("## Errors");
    lines.push("");
    for (const error of report.errors) lines.push(`- ${error}`);
    lines.push("");
  }
  if (report.statusMessages.length) {
    lines.push("## Status trail");
    lines.push("");
    for (const message of report.statusMessages) lines.push(`- ${message}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await readPrompt(args);
  if (!prompt) usage("prompt is empty");
  const narrate = (line: string) => {
    if (!args.quiet) console.error(line);
  };

  let origin: string;
  let closeServer: (() => Promise<void>) | null = null;
  let temporaryStateRoot: string | null = null;
  if (args.attach) {
    origin = args.attach.replace(/\/+$/, "");
    await api(origin, "GET", "/api/health");
    narrate(`work-fold-drive: attached to ${origin}`);
  } else {
    if (args.agentDir) process.env.PI_CODING_AGENT_DIR = resolve(args.agentDir);
    if (args.spaceId && !process.env.WORKFOLD_STATE_DIR) {
      usage("--space-id with an in-process server requires WORKFOLD_STATE_DIR, or use --attach");
    }
    const stateBase = process.env.WORKFOLD_STATE_DIR?.trim()
      ? resolve(process.env.WORKFOLD_STATE_DIR)
      : (temporaryStateRoot = await mkdtemp(join(tmpdir(), "work-fold-drive-state-")));
    const { startLocalApi } = await import("../src/local/server.js");
    const handle = await startLocalApi({ port: args.port ?? 0, appMode: "dev", stateBase });
    origin = handle.origin;
    closeServer = handle.close;
    narrate(`work-fold-drive: local API started at ${origin}`);
  }

  try {
    let space: { id: string; spaceRoot: string };
    if (args.spaceId) {
      const result = await api<{ spaces: Array<{ id: string; spaceRoot: string }> }>(origin, "GET", "/api/bootstrap");
      const selected = result.spaces.find((item) => item.id === args.spaceId);
      if (!selected) throw new Error(`Space not found: ${args.spaceId}`);
      space = selected;
    } else {
      const spaceRoot = resolve(args.space!);
      if (!existsSync(spaceRoot)) await mkdir(spaceRoot, { recursive: true });
      const result = await api<{ space: { id: string; spaceRoot: string } }>(
        origin, "POST", "/api/spaces/local-folder", { spaceRoot },
      );
      space = result.space;
    }
    narrate(`work-fold-drive: Space ${space.id} at ${space.spaceRoot}`);

    let conversationId = args.conversation;
    if (!conversationId) {
      const created = await api<{ conversation: { id: string } }>(
        origin, "POST", `/api/spaces/${encodeURIComponent(space.id)}/conversations`, { title: "work-fold-drive turn" },
      );
      conversationId = created.conversation.id;
    }
    narrate(`work-fold-drive: conversation ${conversationId}`);

    const events: ChatEvent[] = [];
    let sawError = false;
    const stream = await openChatStream(origin, space.id, conversationId, (event) => {
      events.push(event);
      if (event.type === "error") sawError = true;
      if (event.type === "status" && event.message) narrate(`  [status] ${event.message}`);
      if (event.type === "tool" && event.phase && event.phase !== "streaming") {
        narrate(`  [tool] ${event.toolName ?? "?"} ${event.phase}${event.detail ? ` — ${event.detail}` : ""}`);
      }
      if (event.type === "error" && event.message) narrate(`  [error] ${event.message}`);
    });

    const startedAt = Date.now();
    await api(origin, "POST", `/api/spaces/${encodeURIComponent(space.id)}/conversations/${encodeURIComponent(conversationId)}/messages`, {
      content: prompt,
      ...(args.context.length ? { contextPaths: args.context } : {}),
    });
    narrate("work-fold-drive: prompt accepted, waiting for turn to finish...");

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<"timeout">((resolvePromise) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolvePromise("timeout");
      }, args.timeoutSeconds * 1000);
    });
    const outcome = await Promise.race([stream.done, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome === "timeout") {
      narrate(`work-fold-drive: timed out after ${args.timeoutSeconds}s, aborting turn`);
      await api(origin, "POST", `/api/spaces/${encodeURIComponent(space.id)}/conversations/${encodeURIComponent(conversationId)}/abort`, {}).catch(() => undefined);
    }
    stream.close();
    const durationMs = Date.now() - startedAt;

    const { messages } = await api<{ messages: Array<{ role: string; content: string }> }>(
      origin, "GET", `/api/spaces/${encodeURIComponent(space.id)}/conversations/${encodeURIComponent(conversationId)}`,
    );
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const assistantEvent = [...events].reverse().find((event) => event.type === "assistant_message");

    const report: TurnReport = {
      ok: !timedOut && !sawError,
      outcome: timedOut ? "timeout" : sawError ? "error" : "completed",
      durationMs,
      origin,
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      conversationId,
      prompt,
      assistantText: lastAssistant?.content ?? assistantEvent?.text ?? "",
      toolCalls: summarizeToolCalls(events),
      statusMessages: events.filter((event) => event.type === "status" && event.message).map((event) => event.message!),
      errors: events.filter((event) => event.type === "error" && event.message).map((event) => event.message!),
      events,
    };

    console.log(args.json ? JSON.stringify(report, null, 2) : renderMarkdownReport(report));
    process.exitCode = report.outcome === "completed" ? 0 : report.outcome === "error" ? 1 : 2;
  } finally {
    await closeServer?.();
    if (temporaryStateRoot) await rm(temporaryStateRoot, { recursive: true, force: true });
  }
}

await main();
