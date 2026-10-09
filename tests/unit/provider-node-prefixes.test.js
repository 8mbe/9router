import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let cleanup = () => {};

function closeDb() {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
}

async function setupContext() {
  closeDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-prefixes-"));
  const shutdownEvents = ["beforeExit", "exit", "SIGINT", "SIGTERM"];
  const originalListeners = new Map(shutdownEvents.map((event) => [event, new Set(process.listeners(event))]));
  const originalEmit = process.emit;
  process.env.DATA_DIR = tempDir;
  cleanup = () => {
    for (const event of shutdownEvents) {
      for (const listener of process.listeners(event)) {
        if (!originalListeners.get(event).has(listener)) process.removeListener(event, listener);
      }
    }
    process.emit = originalEmit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return Response.json(body, { status: init.status || 200 });
      },
    },
  }));

  const { POST } = await import("@/app/api/provider-nodes/route.js");
  const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");
  const db = await import("@/models/index.js");
  return { POST, PUT, db };
}

function nodeData(prefix, type = "openai-compatible") {
  return {
    type,
    name: "Compatible Test Provider",
    prefix,
    apiType: "chat",
    baseUrl: "https://compatible.test/v1",
  };
}

function request(method, body) {
  return new Request("https://9router.local/api/provider-nodes", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  closeDb();
  vi.doUnmock("next/server");
  vi.resetModules();
  vi.clearAllMocks();
  cleanup();
  cleanup = () => {};
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("provider-node prefix validation", () => {
  const malformedPrefixes = [
    ["slash", "omni/model"],
    ["internal whitespace", "omni provider"],
    ["nonstring value", 42],
  ];

  it.each(malformedPrefixes)("rejects a prefix containing %s on creation", async (_, prefix) => {
    const ctx = await setupContext();
    const response = await ctx.POST(request("POST", nodeData(prefix)));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String), field: "prefix" });
    expect(await ctx.db.getProviderNodes()).toEqual([]);
  });

  it.each(malformedPrefixes)("rejects a prefix containing %s on edit without changing stored data", async (_, prefix) => {
    const ctx = await setupContext();
    const node = await ctx.db.createProviderNode({
      id: "openai-compatible-chat-edit",
      ...nodeData("valid-prefix"),
    });
    const connection = await ctx.db.createProviderConnection({
      provider: node.id,
      name: "Test Key",
      authType: "apikey",
      apiKey: "test-key",
      isActive: true,
      providerSpecificData: { prefix: node.prefix, baseUrl: node.baseUrl },
    });
    const storedNode = await ctx.db.getProviderNodeById(node.id);
    const storedConnection = await ctx.db.getProviderConnectionById(connection.id);

    const response = await ctx.PUT(request("PUT", {
      ...nodeData(prefix),
      name: "Rejected Rename",
      baseUrl: "https://replacement.test/v1",
    }), { params: Promise.resolve({ id: node.id }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String), field: "prefix" });
    expect(await ctx.db.getProviderNodeById(node.id)).toEqual(storedNode);
    expect(await ctx.db.getProviderConnectionById(connection.id)).toEqual(storedConnection);
  });

  it.each([
    ["vn", "venice", "openai-compatible"],
    ["cf", "cloudflare-ai", "anthropic-compatible"],
    ["openai", "openai", "custom-embedding"],
    ["xmtp", "xiaomi-tokenplan", "openai-compatible"],
  ])("rejects reserved prefix %s when creating a %s node", async (prefix, provider, type) => {
    const ctx = await setupContext();
    const response = await ctx.POST(request("POST", nodeData(` ${prefix} `, type)));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain(`Prefix "${prefix}" is reserved`);
    expect(body.error).toContain(`provider "${provider}"`);
    expect(await ctx.db.getProviderNodes()).toEqual([]);
  });

  it.each(["vn", "cf"])("rejects edits to reserved prefix %s without changing stored values", async (prefix) => {
    const ctx = await setupContext();
    const node = await ctx.db.createProviderNode({
      id: "openai-compatible-chat-test",
      ...nodeData("omni-test"),
    });
    const connection = await ctx.db.createProviderConnection({
      provider: node.id,
      name: "Test Key",
      authType: "apikey",
      apiKey: "test-key",
      isActive: true,
      providerSpecificData: { prefix: node.prefix, baseUrl: node.baseUrl },
    });

    const response = await ctx.PUT(request("PUT", nodeData(prefix)), { params: Promise.resolve({ id: node.id }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(`Prefix "${prefix}" is reserved`);
    expect(await ctx.db.getProviderNodeById(node.id)).toMatchObject({
      id: node.id,
      prefix: "omni-test",
      baseUrl: node.baseUrl,
    });
    expect(await ctx.db.getProviderConnectionById(connection.id)).toMatchObject({
      id: connection.id,
      provider: node.id,
      providerSpecificData: { prefix: "omni-test", baseUrl: node.baseUrl },
    });
  });

  it("accepts a unique prefix and persists the node", async () => {
    const ctx = await setupContext();
    const response = await ctx.POST(request("POST", nodeData(" omni-test ")));
    const { node } = await response.json();

    expect(response.status).toBe(201);
    expect(node.prefix).toBe("omni-test");
    expect(await ctx.db.getProviderNodeById(node.id)).toMatchObject({
      id: node.id,
      prefix: node.prefix,
      baseUrl: node.baseUrl,
    });
  });

  it("accepts a unique replacement prefix and syncs associated connections", async () => {
    const ctx = await setupContext();
    const node = await ctx.db.createProviderNode({
      id: "openai-compatible-chat-test",
      ...nodeData("vn"),
    });
    const connection = await ctx.db.createProviderConnection({
      provider: node.id,
      name: "Test Key",
      authType: "apikey",
      apiKey: "test-key",
      isActive: true,
      providerSpecificData: { prefix: "vn", baseUrl: node.baseUrl, extra: "retained" },
    });

    const response = await ctx.PUT(request("PUT", nodeData("omni-test")), { params: Promise.resolve({ id: node.id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).node.prefix).toBe("omni-test");
    expect((await ctx.db.getProviderConnectionById(connection.id)).providerSpecificData)
      .toMatchObject({ prefix: "omni-test", extra: "retained" });
    expect((await ctx.db.getProviderNodeById(node.id)).prefix).toBe("omni-test");
  });

  it.each([
    ["openai-compatible", "openai-compatible"],
    ["anthropic-compatible", "anthropic-compatible"],
    ["custom-embedding", "custom-embedding"],
    ["openai-compatible", "anthropic-compatible"],
    ["anthropic-compatible", "openai-compatible"],
    ["openai-compatible", "custom-embedding"],
    ["custom-embedding", "openai-compatible"],
    ["anthropic-compatible", "custom-embedding"],
    ["custom-embedding", "anthropic-compatible"],
  ])("rejects a prefix used by a %s node when creating a %s node", async (existingType, newType) => {
    const ctx = await setupContext();
    const created = await ctx.POST(request("POST", nodeData("shared-prefix", existingType)));
    expect(created.status).toBe(201);
    const { node } = await created.json();

    const response = await ctx.POST(request("POST", nodeData(" shared-prefix ", newType)));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("shared-prefix");
    expect(await ctx.db.getProviderNodes()).toEqual([node]);
  });

  it("keeps differently cased prefixes distinct, matching model routing", async () => {
    const ctx = await setupContext();
    const responses = await Promise.all([
      ctx.POST(request("POST", nodeData("CasePrefix"))),
      ctx.POST(request("POST", nodeData("caseprefix", "anthropic-compatible"))),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect((await ctx.db.getProviderNodes()).map((node) => node.prefix).sort()).toEqual(["CasePrefix", "caseprefix"]);
  });

  it("permits an edit that retains the node's own prefix", async () => {
    const ctx = await setupContext();
    const created = await ctx.POST(request("POST", nodeData("own-prefix")));
    expect(created.status).toBe(201);
    const { node } = await created.json();

    const response = await ctx.PUT(request("PUT", {
      ...nodeData(" own-prefix "),
      name: "Renamed Provider",
    }), { params: Promise.resolve({ id: node.id }) });

    expect(response.status).toBe(200);
    expect((await response.json()).node).toMatchObject({ id: node.id, prefix: "own-prefix", name: "Renamed Provider" });
    expect(await ctx.db.getProviderNodes()).toHaveLength(1);
  });

  it("rejects an edit to another node's prefix without changing either node or its connection", async () => {
    const ctx = await setupContext();
    const owner = await ctx.db.createProviderNode({
      id: "anthropic-compatible-owner",
      ...nodeData("occupied-prefix", "anthropic-compatible"),
    });
    const node = await ctx.db.createProviderNode({
      id: "openai-compatible-chat-edit",
      ...nodeData("editable-prefix"),
    });
    const connection = await ctx.db.createProviderConnection({
      provider: node.id,
      name: "Test Key",
      authType: "apikey",
      apiKey: "test-key",
      isActive: true,
      providerSpecificData: { prefix: node.prefix, baseUrl: node.baseUrl, extra: "retained" },
    });
    const storedConnection = await ctx.db.getProviderConnectionById(connection.id);
    const storedNode = await ctx.db.getProviderNodeById(node.id);
    const storedOwner = await ctx.db.getProviderNodeById(owner.id);

    const response = await ctx.PUT(request("PUT", {
      ...nodeData("occupied-prefix"),
      name: "Rejected Rename",
      baseUrl: "https://replacement.test/v1",
    }), { params: Promise.resolve({ id: node.id }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("occupied-prefix");
    expect(await ctx.db.getProviderNodeById(node.id)).toEqual(storedNode);
    expect(await ctx.db.getProviderNodeById(owner.id)).toEqual(storedOwner);
    expect(await ctx.db.getProviderConnectionById(connection.id)).toEqual(storedConnection);
  });

  it("stores exactly one node when two concurrent requests use the same prefix", async () => {
    const ctx = await setupContext();
    const responses = await Promise.all([
      ctx.POST(request("POST", nodeData("concurrent-prefix", "openai-compatible"))),
      ctx.POST(request("POST", nodeData("concurrent-prefix", "anthropic-compatible"))),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);

    const rejected = responses.find((response) => response.status === 400);
    expect((await rejected.json()).error).toContain("concurrent-prefix");
    const nodes = await ctx.db.getProviderNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].prefix).toBe("concurrent-prefix");
  });

  it("rejects a prefix equal to another node's raw provider ID", async () => {
    const ctx = await setupContext();
    const node = await ctx.db.createProviderNode({
      id: "openai-compatible-chat-raw-id",
      ...nodeData("raw-owner"),
    });
    const response = await ctx.POST(request("POST", nodeData(node.id, "anthropic-compatible")));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(node.id);
    expect(await ctx.db.getProviderNodes()).toEqual([node]);
  });
});
