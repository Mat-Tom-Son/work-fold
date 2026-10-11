const assert = require("node:assert/strict");
const { app } = require("electron");
const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const [archiveArgument, rootArgument, documentFixture] = process.argv.slice(2);
const archive = resolve(archiveArgument), root = resolve(rootArgument);
const agentDir = join(root, "pi"), stateRoot = join(root, "state");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.WORKFOLD_DESKTOP_STATE_DIR = stateRoot;
process.env.WORKFOLD_STATE_DIR = stateRoot;
app.setPath("userData", join(root, "electron-profile"));
app.dock?.hide();

(async () => {
  await app.whenReady();
  const clients = [], errors = [], requests = [];
  let peer;
  try {
    const nativeRequire = createRequire(join(archive, "package.json"));
    assert.ok(nativeRequire.resolve("jiti").startsWith(`${archive}/node_modules/`), "Jiti must come from the built archive");
    const pptxRequire = createRequire(nativeRequire.resolve("pptxgenjs"));
    assert.equal(pptxRequire.resolve("image-size/package.json"), join(archive, "node_modules/image-size/package.json"), "PptxGenJS must resolve the hash-verified archived image parser, with no nested or ancestor replacement");
    const sdkPath = join(archive, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
    await fs.access(sdkPath);
    const { FileCredentialStore, ModelRuntime, SettingsManager } = await import(pathToFileURL(sdkPath).href);
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(archive, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
    const { PiConversationClient } = await import(pathToFileURL(join(archive, "dist/desktop/src/local/agent/pi-client.js")).href);
    const { loadIncludedMcpConfig } = await import(pathToFileURL(join(archive, "dist/desktop/src/local/agent/included-mcp-setup.js")).href);
    await fs.mkdir(agentDir, { recursive: true });
    const authStorage = FileCredentialStore.inMemory(), modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
    const provider = { resolveRuntime: async () => ({
      agentDir, credentials: authStorage, modelRuntime, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), projectTrust: { override: true },
      includedTools: { rootPath: join(archive, "resources/included-tools"), stateRoot, helperAppPath: join(root, "Unused Computer.app") },
    }) };
    async function client(name) {
      const cwd = join(root, name); await fs.mkdir(cwd, { recursive: true });
      const value = new PiConversationClient(`packaged-${name}`, cwd, provider); clients.push(value);
      const catalog = await value.getCatalog();
      assert.deepEqual(catalog.diagnostics.filter(item => item.type === "error" || item.type === "collision"), [], "Native session must have no loader errors");
      const state = await value.getState();
      for (const name of ["find_roots", "chrome_tab", "web_search", "codemode", "tool_search", "document_run", "document_engine"]) assert.ok(state.activeTools.includes(name), `Missing active packaged tool ${name}`);
      return { value, cwd };
    }
    async function call(owner, name, args) {
      const session = await owner.value.ensureSession();
      const tool = session.agent.state.tools.find(item => item.name === name);
      assert.ok(tool, `Missing native executable ${name}`);
      const result = await tool.execute("packaged-smoke", args, AbortSignal.timeout(20_000));
      assert.ok(!result.isError, JSON.stringify(result.content?.filter(item => item.type === "text")));
      return result;
    }
    peer = createServer(async (request, response) => {
      try {
        if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString()); requests.push(message.method);
        if (!("id" in message)) { response.writeHead(202); response.end(); return; }
        let result;
        if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "packaged-fixture", version: "1" } };
        else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Return the fixture note", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } }] };
        else if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.arguments.note }], structuredContent: { records: ["structured-record"], nextCursor: "packaged-next-page" } };
        else result = {};
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      } catch (error) { response.writeHead(500); response.end("Fixture protocol error"); }
    });
    await new Promise(resolve => peer.listen(0, "127.0.0.1", resolve));
    const configPath = join(agentDir, "mcp.json");
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { url: `http://127.0.0.1:${peer.address().port}/mcp`, exposure: "direct" } } }));
    try {
      // Cold product path: do not warm up Jiti with a differently configured loader.
      const first = await client("mcp-work-folder-a"), second = await client("mcp-work-folder-b");
      const until = async (owner) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await owner.value.ensureSession()).agent.state.tools.some(tool => tool.name === "mcp__fixture__echo")) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error("Native MCP did not connect");
      };
      await until(first); await until(second);
      const result = await call(first, "mcp__fixture__echo", { note: "packaged-mcp-ok" });
      assert.match(JSON.stringify(result), /packaged-mcp-ok/);
      // Native Pi exposes the complete CallToolResult to scripts. Direct
      // model calls receive the server's text/images rather than injected JSON.
      assert.deepEqual(result.structuredContent.structuredContent, { records: ["structured-record"], nextCursor: "packaged-next-page" });
      const faux = fauxProvider();
      modelRuntime.registerNativeProvider(faux.provider);
      const nativeSession = await first.value.ensureSession();
      await nativeSession.setModel(faux.getModel());
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: "text((await tools.mcp__fixture__echo({note:'scripted-mcp-ok'})).structuredContent);" }, { id: "packaged-script" })),
        fauxAssistantMessage("Packaged MCP script completed."),
      ]);
      await first.value.prompt("Run the packaged MCP script.");
      const scripted = nativeSession.messages.find(message => message.role === "toolResult" && message.toolCallId === "packaged-script");
      assert.ok(scripted, "the native Assistant loop persisted the scripted result");
      assert.match(JSON.stringify(scripted.content), /structured-record/);
      assert.match(JSON.stringify(scripted.content), /packaged-next-page/, "scripts can release pagination to model-visible content");
      assert.equal(requests.filter(method => method === "tools/call").length, 2, "one execution per explicit direct/scripted call");
      assert.ok(requests.includes("initialize") && requests.includes("tools/list") && requests.includes("tools/call"));
      await first.value.stop();
      assert.match(JSON.stringify(await call(second, "mcp__fixture__echo", { note: "sibling-still-active" })), /sibling-still-active/);
      await second.value.stop();
      await fs.writeFile(configPath, "{packaged-malformed-private-fixture");
      const malformed = await loadIncludedMcpConfig({ agentDir });
      assert.ok(malformed.errors.length > 0);
      assert.ok(!JSON.stringify(malformed).includes("packaged-malformed-private-fixture"));
      console.log("PASS packaged MCP: cold native loaders, two sessions, discovery/invocation and malformed-config redaction");
    } catch (error) { errors.push(`Packaged MCP: ${error.stack || error}`); }
    finally { await fs.rm(configPath, { force: true }); }

    try {
      const first = await client("document-work-folder-a"), second = await client("document-work-folder-b");
      const engineStatus = await call(first, "document_engine", { input: { operation: "status" } });
      assert.match(JSON.stringify(engineStatus.content), /libreoffice/);
      assert.match(JSON.stringify(engineStatus.content), /tesseract/);
      for (const owner of [first, second]) await fs.copyFile(documentFixture, join(owner.cwd, "create.mjs"));
      const results = await Promise.all([first, second].map(owner => call(owner, "document_run", { script: "create.mjs", timeoutMs: 20_000 })));
      for (const [index, result] of results.entries()) {
        assert.ok(result.content.some(item => item.type === "image" && item.data), "Native document tool returns image content");
        const origins = result.details?.runtime?.libraryOrigins;
        assert.ok(origins && Object.keys(origins).length >= 7, "Document runtime records actual library origins");
        for (const [name, origin] of Object.entries(origins)) assert.ok(String(origin).startsWith(pathToFileURL(`${archive}/node_modules/`).href), `${name} escaped bundled library resolution: ${origin}`);
        for (const name of ["launch-plan.docx", "budget.xlsx", "launch-plan.pptx", "launch-plan.pdf"]) assert.ok((await fs.stat(join([first, second][index].cwd, name))).size > 100);
      }
      await first.value.stop(); await second.value.stop();
      console.log("PASS packaged Documents: concurrent native tool runs, four file formats, PDF images and archive-owned library origins");
    } catch (error) { errors.push(`Packaged Documents: ${error.stack || error}`); }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("PASS full built-ASAR native tools");
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
  finally {
    for (const client of clients) await client.stop().catch(() => {});
    if (peer) { peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); }
    app.exit(process.exitCode || 0);
  }
})();
