ObjC.import("Foundation");
ObjC.import("stdlib");

var ACT_UNAVAILABLE_MESSAGE = "Open work-fold to run this command. Chat, Check, and Space actions need the work-fold app running.";
var ACT_MAX_MESSAGE_FILE_BYTES = 262144;

function run(rawArguments) {
  const argumentsList = Array.from(rawArguments);
  const scriptDirectory = argumentsList.shift();
  const fileManager = $.NSFileManager.defaultManager;
  let exitCode = 1;

  try {
    const configuredAppPath = environmentValue("WORKFOLD_CLI_APP");
    const bundledAppPaths = [
      `${scriptDirectory}/../MacOS/work-fold`,
      `${scriptDirectory}/../MacOS/work-fold Local Smoke`,
    ];
    const appPath = configuredAppPath || bundledAppPaths.find((path) => fileManager.fileExistsAtPath($(path))) || bundledAppPaths[0];
    if (!fileManager.fileExistsAtPath($(appPath))) {
      throw new Error(`work-fold executable was not found at ${appPath}.`);
    }

    const homeDirectory = environmentValue("HOME") || ObjC.unwrap($.NSHomeDirectory());
    const configuredStateRoot = environmentValue("WORKFOLD_CLI_STATE_DIR");
    const defaultStateName = appPath.endsWith("/work-fold Local Smoke") ? "work-fold Local Smoke" : "work-fold";
    const stateRoot = configuredStateRoot || `${homeDirectory}/Library/Application Support/${defaultStateName}`;
    const cliRoot = `${stateRoot}/cli`;
    createDirectory(`${cliRoot}/requests`);
    createDirectory(`${cliRoot}/responses`);

    const timeoutValue = environmentValue("WORKFOLD_CLI_TIMEOUT_MS");
    const timeoutMs = timeoutValue ? Number(timeoutValue) : 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) {
      throw new Error("WORKFOLD_CLI_TIMEOUT_MS must be an integer between 100 and 600000.");
    }

    const context = { fileManager, appPath, cliRoot, timeoutMs };

    if (isActCommand(argumentsList)) {
      // Chat, Space, and file writes ride the separately versioned act lane
      // and require the per-launch token the running app minted.
      const actToken = readActToken(cliRoot);
      if (!actToken) {
        writeHandle($.NSFileHandle.fileHandleWithStandardError, `work-fold: ${ACT_UNAVAILABLE_MESSAGE}\n`);
        $.exit(6);
      }
      const waitPlan = parseWaitCommand(argumentsList);
      if (waitPlan) {
        exitCode = runWaitLoop(context, waitPlan, actToken);
      } else {
        const prepared = prepareActArguments(argumentsList);
        const outcome = performRequest(context, prepared.argv, actToken, prepared.payload);
        emitOutcome(outcome);
        exitCode = outcome.exitCode;
      }
    } else {
      const outcome = performRequest(context, argumentsList, null, null);
      emitOutcome(outcome);
      exitCode = outcome.exitCode;
    }
  } catch (error) {
    if (error && typeof error.exitCode === "number") exitCode = error.exitCode;
    writeHandle($.NSFileHandle.fileHandleWithStandardError, `work-fold: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  $.exit(exitCode);
}

/** Leading positionals decide the lane; content-bearing chat reads are act-lane too. */
function isActCommand(argumentsList) {
  const positional = argumentsList.filter((token) => token !== "--json");
  const group = positional[0] || "";
  if (group === "chat" || group === "chats" || group === "files" || group === "manage") return true;
  if (group === "checks") return positional[1] !== "status";
  return group === "spaces" && (positional[1] === "create" || positional[1] === "register");
}

function parseWaitCommand(argumentsList) {
  const positional = argumentsList.filter((token) => token !== "--json");
  const group = positional[0];
  if ((group !== "chat" && group !== "manage" && group !== "checks") || positional[1] !== "wait") return null;
  const json = argumentsList.includes("--json");
  let space = "";
  let task = "";
  let timeoutSeconds = 600;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token === "--space") { space = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--task") { task = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--timeout") {
      timeoutSeconds = Number(argumentsList[index + 1]);
      index += 1;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
        throw usageFailure("--timeout must be an integer between 1 and 3600 seconds.");
      }
    } else if (token === group || token === "wait" || token === "--json") {
      // command tokens
    } else {
      throw usageFailure(`Unknown option for ${group} wait: ${token}`);
    }
  }
  if ((group === "chat" || group === "checks") && !space) throw usageFailure("Act commands require an explicit --space <id-or-name>.");
  if (group === "manage" && space) throw usageFailure("The management scope does not take --space.");
  if (!task) throw usageFailure(`Provide --task <id> from ${group === "checks" ? "checks run" : `${group} send`}.`);
  return { group, space, task, timeoutSeconds, json };
}

function runWaitLoop(context, plan, actToken) {
  // Waiting is task-scoped: it follows the exact turn the send accepted, so
  // an older assistant message can never read as this turn's success.
  const scopeArgv = plan.group === "chat" || plan.group === "checks" ? ["--space", plan.space] : [];
  const statusArgv = [plan.group, plan.group === "checks" ? "task" : "status"].concat(scopeArgv, ["--task", plan.task, "--json"]);
  const deadline = Date.now() + plan.timeoutSeconds * 1000;
  for (;;) {
    const status = performRequest(context, statusArgv, actToken, null);
    if (status.exitCode !== 0) {
      emitOutcome(status);
      return status.exitCode;
    }
    let state = "";
    try {
      state = JSON.parse(status.stdout).data.task.state;
    } catch (error) {
      throw new Error("work-fold returned an unreadable task status.");
    }
    if (state !== "accepted" && state !== "running") break;
    if (Date.now() >= deadline) {
      writeHandle($.NSFileHandle.fileHandleWithStandardError, `work-fold: ${plan.group} wait timed out after ${plan.timeoutSeconds}s.\n`);
      return 7;
    }
    $.NSThread.sleepForTimeInterval(2);
  }
  const resultArgv = [plan.group, "result"].concat(scopeArgv, ["--task", plan.task]);
  if (plan.json) resultArgv.push("--json");
  const result = performRequest(context, resultArgv, actToken, null);
  emitOutcome(result);
  return result.exitCode;
}

/** Rewrites --message-file <path> into a bounded payload the host can trust. */
function prepareActArguments(argumentsList) {
  const argv = [];
  let payload = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token !== "--message-file") {
      argv.push(token);
      continue;
    }
    const path = argumentsList[index + 1];
    index += 1;
    if (!path) throw usageFailure("--message-file requires a path.");
    if (payload) throw usageFailure("--message-file may be provided only once.");
    const text = readText(resolvePath(path));
    const byteLength = ObjC.unwrap($(text).dataUsingEncoding($.NSUTF8StringEncoding).length);
    if (byteLength > ACT_MAX_MESSAGE_FILE_BYTES) {
      throw usageFailure(`--message-file exceeds ${ACT_MAX_MESSAGE_FILE_BYTES} bytes.`);
    }
    payload = { messageFile: text };
    argv.push("--message-from-payload");
  }
  return { argv, payload };
}

function readActToken(cliRoot) {
  const path = `${cliRoot}/act-token.json`;
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) return null;
  try {
    const record = JSON.parse(readText(path));
    if (record.version !== 1 || typeof record.actToken !== "string") return null;
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(record.actToken)) return null;
    return record.actToken;
  } catch (error) {
    return null;
  }
}

function performRequest(context, argv, actToken, payload) {
  const fileManager = context.fileManager;
  const requestId = ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase();
  const requestPath = `${context.cliRoot}/requests/${requestId}.json`;
  const responsePath = `${context.cliRoot}/responses/${requestId}.json`;
  let temporaryRequestPath = `${context.cliRoot}/requests/${requestId}.${ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase()}.tmp`;

  try {
    const request = actToken
      ? {
          protocolVersion: 2,
          lane: "act",
          id: requestId,
          argv: argv,
          cwd: ObjC.unwrap(fileManager.currentDirectoryPath),
          createdAt: new Date().toISOString(),
          actToken: actToken,
        }
      : {
          protocolVersion: 1,
          id: requestId,
          argv: argv,
          cwd: ObjC.unwrap(fileManager.currentDirectoryPath),
          createdAt: new Date().toISOString(),
        };
    if (actToken && payload) request.payload = payload;
    writeText(temporaryRequestPath, JSON.stringify(request));
    if (!fileManager.moveItemAtPathToPathError($(temporaryRequestPath), $(requestPath), null)) {
      throw new Error("work-fold CLI request could not be committed.");
    }
    temporaryRequestPath = "";

    const task = $.NSTask.alloc.init;
    task.executableURL = $.NSURL.fileURLWithPath($(context.appPath));
    task.arguments = $(["--work-fold-cli-request", requestId]);
    if (!task.launchAndReturnError(null)) throw new Error("work-fold executable could not be launched.");

    const deadline = Date.now() + context.timeoutMs;
    while (!fileManager.fileExistsAtPath($(responsePath))) {
      if (Date.now() >= deadline) {
        throw transportTimeout(`work-fold did not answer CLI request ${requestId} within ${context.timeoutMs} ms.`);
      }
      $.NSThread.sleepForTimeInterval(0.05);
    }

    const response = JSON.parse(readText(responsePath));
    if (response.protocolVersion !== 1) throw new Error(`work-fold returned unsupported CLI protocol version ${response.protocolVersion}.`);
    if (response.id !== requestId) throw new Error("work-fold returned a CLI response with the wrong request id.");
    if (!Number.isInteger(response.exitCode)) throw new Error("work-fold returned an invalid CLI exit code.");
    return {
      exitCode: response.exitCode,
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
    };
  } finally {
    for (const path of [temporaryRequestPath, requestPath, responsePath]) {
      if (path && fileManager.fileExistsAtPath($(path))) fileManager.removeItemAtPathError($(path), null);
    }
  }
}

function emitOutcome(outcome) {
  writeHandle($.NSFileHandle.fileHandleWithStandardOutput, outcome.stdout);
  writeHandle($.NSFileHandle.fileHandleWithStandardError, outcome.stderr);
}

function resolvePath(path) {
  if (path.startsWith("/")) return path;
  const cwd = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
  return `${cwd}/${path}`;
}

function usageFailure(message) {
  const error = new Error(`${message}\nRun 'work-fold help' for usage.`);
  error.exitCode = 2;
  return error;
}

function transportTimeout(message) {
  const error = new Error(message);
  error.exitCode = 124;
  return error;
}

function environmentValue(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey($(name));
  const unwrapped = ObjC.unwrap(value);
  return typeof unwrapped === "string" ? unwrapped.trim() : "";
}

function createDirectory(path) {
  if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    $(path),
    true,
    $.NSDictionary.dictionary,
    null,
  )) {
    throw new Error(`work-fold CLI directory could not be created at ${path}.`);
  }
}

function writeText(path, text) {
  const data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  if (!data.writeToFileAtomically($(path), true)) throw new Error(`work-fold CLI request could not be written at ${path}.`);
}

function readText(path) {
  const value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!value) throw new Error(`work-fold CLI file could not be read at ${path}.`);
  return ObjC.unwrap(value);
}

function writeHandle(handle, text) {
  if (!text) return;
  handle.writeData($(text).dataUsingEncoding($.NSUTF8StringEncoding));
}
