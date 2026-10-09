import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let createConnection;
let updateConnection;
let getStoredConnection;
let createStoredConnection;
let node;
let connectionIndex = 0;

function request(method, body, id = "") {
  return new Request(`https://9router.local/api/providers${id ? `/${id}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addConnection(providerSpecificData, provider = node.id) {
  return createConnection(request("POST", {
    provider,
    name: `Custom upstream ${++connectionIndex}`,
    apiKey: "upstream-api-key",
    providerSpecificData,
  }));
}

function editConnection(id, body) {
  return updateConnection(request("PUT", body, id), { params: Promise.resolve({ id }) });
}

describe("custom Anthropic connection execution mode", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-claude-code-mode-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));

    ({ POST: createConnection } = await import("@/app/api/providers/route.js"));
    ({ PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js"));
    const models = await import("@/models/index.js");
    getStoredConnection = models.getProviderConnectionById;
    createStoredConnection = models.createProviderConnection;
    node = await models.createProviderNode({
      id: "anthropic-compatible-execution-mode-test",
      type: "anthropic-compatible",
      name: "Custom Anthropic",
      prefix: "custom-claude",
      baseUrl: "https://upstream.example/v1",
    });
  });

  afterAll(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("defaults new connections to direct and keeps node routing data", async () => {
    const response = await addConnection();
    expect(response.status).toBe(201);
    const { connection } = await response.json();
    expect(connection.providerSpecificData).toMatchObject({
      executionMode: "direct",
      baseUrl: node.baseUrl,
      prefix: node.prefix,
      nodeName: node.name,
    });
    expect((await getStoredConnection(connection.id)).providerSpecificData.executionMode).toBe("direct");
  });

  it("stores Claude Code mode and extra settings while keeping the node URL authoritative", async () => {
    const response = await addConnection({
      executionMode: "claude-code",
      customHeader: "saved-header",
      baseUrl: "https://ignored.example",
    });
    expect(response.status).toBe(201);
    const { connection } = await response.json();
    expect((await getStoredConnection(connection.id)).providerSpecificData).toMatchObject({
      executionMode: "claude-code",
      customHeader: "saved-header",
      baseUrl: node.baseUrl,
    });
  });

  it.each(["server", "", null, true, 1, {}, []].map((executionMode) => ({ executionMode })))("rejects invalid create mode $executionMode", async ({ executionMode }) => {
    const response = await addConnection({ executionMode });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Execution mode must be direct or claude-code");
  });

  it.each(["anthropic", "openai-compatible-other"])("rejects a mode for ineligible provider %s", async (provider) => {
    const response = await addConnection({ executionMode: "claude-code" }, provider);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("only supported for custom Anthropic-compatible");
  });

  it("switches mode without changing credentials, routing, or other settings", async () => {
    const response = await addConnection({ executionMode: "claude-code", customHeader: "saved-header" });
    const { connection } = await response.json();
    const before = await getStoredConnection(connection.id);

    const updated = await editConnection(connection.id, { providerSpecificData: { executionMode: "direct" } });
    expect(updated.status).toBe(200);
    const after = await getStoredConnection(connection.id);
    expect(after.apiKey).toBe(before.apiKey);
    expect(after.providerSpecificData).toEqual({ ...before.providerSpecificData, executionMode: "direct" });
  });

  it("keeps Claude Code mode when an unrelated edit omits it", async () => {
    const response = await addConnection({ executionMode: "claude-code" });
    const { connection } = await response.json();

    const updated = await editConnection(connection.id, { name: "Renamed", providerSpecificData: { customHeader: "new-header" } });
    expect(updated.status).toBe(200);
    expect((await getStoredConnection(connection.id)).providerSpecificData).toMatchObject({
      executionMode: "claude-code",
      customHeader: "new-header",
      baseUrl: node.baseUrl,
    });
  });

  it("rejects an invalid edit before updating any saved fields", async () => {
    const response = await addConnection({ executionMode: "claude-code" });
    const { connection } = await response.json();
    const before = await getStoredConnection(connection.id);

    const updated = await editConnection(connection.id, {
      name: "Should not save",
      providerSpecificData: { executionMode: "automatic" },
    });
    expect(updated.status).toBe(400);
    expect(await getStoredConnection(connection.id)).toEqual(before);
  });

  it("treats existing custom connections without a mode as direct", async () => {
    const connection = await createStoredConnection({
      provider: node.id,
      authType: "apikey",
      name: "Legacy connection",
      apiKey: "saved-api-key",
      providerSpecificData: { baseUrl: node.baseUrl, customHeader: "saved-header" },
    });

    const updated = await editConnection(connection.id, { name: "Renamed legacy connection" });
    expect(updated.status).toBe(200);
    expect((await getStoredConnection(connection.id)).providerSpecificData).toEqual({
      baseUrl: node.baseUrl,
      customHeader: "saved-header",
      executionMode: "direct",
    });
  });

  it("rejects enabling server mode on an existing built-in provider", async () => {
    const response = await addConnection(undefined, "anthropic");
    const { connection } = await response.json();

    const updated = await editConnection(connection.id, { providerSpecificData: { executionMode: "claude-code" } });
    expect(updated.status).toBe(400);
    expect((await getStoredConnection(connection.id)).providerSpecificData).not.toHaveProperty("executionMode");
  });
});
