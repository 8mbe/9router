import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let postConnection;
let putConnection;
let models;
const nodes = {};
let nextName = 0;

function request(method, body, id = "") {
  return new Request(`https://9router.local/api/providers${id ? `/${id}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function create(providerSpecificData, extras = {}, provider = nodes.openai.id) {
  return postConnection(request("POST", {
    provider,
    apiKey: "private-upstream-key",
    name: `Custom API ${++nextName}`,
    providerSpecificData,
    ...extras,
  }));
}

function edit(id, body) {
  return putConnection(request("PUT", body, id), { params: Promise.resolve({ id }) });
}

function pool(proxyUrl, extras = {}) {
  return models.createProxyPool({ name: `Proxy ${++nextName}`, proxyUrl, isActive: true, type: "http", ...extras });
}

describe("custom API privacy and account session configuration", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-api-options-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
        },
      },
    }));
    ({ POST: postConnection } = await import("@/app/api/providers/route.js"));
    ({ PUT: putConnection } = await import("@/app/api/providers/[id]/route.js"));
    models = await import("@/models/index.js");
    for (const [key, type] of Object.entries({ openai: "openai-compatible", anthropic: "anthropic-compatible", embedding: "custom-embedding" })) {
      nodes[key] = await models.createProviderNode({
        id: `${type}-options-test`, type, prefix: key, name: `Custom ${key}`, baseUrl: "https://custom.example/v1", apiType: "chat",
      });
    }
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

  it.each(["openai", "anthropic", "embedding"])("persists anonymization for custom %s nodes and trusts the node routing fields", async (key) => {
    const response = await create({ anonymizeRequests: true, customApiSessionPinning: false, baseUrl: "https://ignored.example/v1" }, {}, nodes[key].id);
    expect(response.status).toBe(201);
    const { connection } = await response.json();
    expect((await models.getProviderConnectionById(connection.id)).providerSpecificData).toMatchObject({
      anonymizeRequests: true,
      customApiSessionPinning: false,
      baseUrl: nodes[key].baseUrl,
      prefix: nodes[key].prefix,
    });
  });

  it.each(["anonymizeRequests", "customApiSessionPinning"])("rejects %s on built-in providers", async (field) => {
    const response = await create({ [field]: true }, {}, "openai");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("only supported for custom API");
  });

  it.each(["true", null, 1, {}])("rejects a non-boolean option %j", async (value) => {
    for (const field of ["anonymizeRequests", "customApiSessionPinning"]) {
      const response = await create({ [field]: value });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(`${field} must be a boolean`);
    }
  });

  it.each(["anonymizeRequests", "customApiSessionPinning"])("rejects server Claude Code with %s", async (field) => {
    const response = await create({ executionMode: "claude-code", [field]: true }, {}, nodes.anthropic.id);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("require direct execution");
  });

  it("requires a proxy when enabling pinning", async () => {
    const response = await create({ customApiSessionPinning: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("requires an active");
  });

  it("rejects an unsupported proxy without exposing its credentials", async () => {
    const proxy = await pool("http://private-name:private-password@proxy.example:8080");
    const response = await create({ customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("Bright Data or a {session}");
    expect(error).not.toMatch(/private-name|private-password/);
  });

  it.each([
    "http://brd-customer-private-zone-test:private-password@brd.superproxy.io:33335",
    "http://private-session-%7Bsession%7D:private-password@proxy.example:8080",
    "https://private-name:private-%7Bsession%7D@proxy.example:8080",
  ])("accepts a supported proxy %s", async (proxyUrl) => {
    const proxy = await pool(proxyUrl, { noProxy: "custom.example" });
    const response = await create({ anonymizeRequests: true, customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    expect(response.status).toBe(201);
    const { connection } = await response.json();
    expect((await models.getProviderConnectionById(connection.id)).providerSpecificData).toMatchObject({
      anonymizeRequests: true, customApiSessionPinning: true, proxyPoolId: proxy.id,
    });
  });

  it.each(["vercel", "cloudflare", "deno", "netlify"])("rejects %s relay pools", async (type) => {
    const proxy = await pool("https://relay.example", { type });
    const response = await create({ customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not a relay");
  });

  it("rejects SOCKS proxies because the request transport supports HTTP and HTTPS", async () => {
    const proxy = await pool("socks5://private-name:private-%7Bsession%7D@proxy.example:1080");
    const response = await create({ customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("HTTP or HTTPS proxy");
  });

  it("rejects inactive proxy pools for pinning", async () => {
    const proxy = await pool("http://user:pass@brd.superproxy.io:33335", { isActive: false });
    const response = await create({ customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    expect(response.status).toBe(400);
  });

  it("accepts a supported legacy connection proxy", async () => {
    const response = await create({ customApiSessionPinning: true }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://user:pass@brd.superproxy.io:33335",
      connectionNoProxy: "custom.example",
    });
    expect(response.status).toBe(201);
  });

  it("validates a saved execution mode when enabling anonymization through an edit", async () => {
    const response = await create({ executionMode: "claude-code" }, {}, nodes.anthropic.id);
    const { connection } = await response.json();
    const before = await models.getProviderConnectionById(connection.id);
    const update = await edit(connection.id, { name: "Must not save", providerSpecificData: { anonymizeRequests: true } });
    expect(update.status).toBe(400);
    expect((await update.json()).error).toContain("require direct execution");
    expect(await models.getProviderConnectionById(connection.id)).toEqual(before);

    const validUpdate = await edit(connection.id, { providerSpecificData: { executionMode: "direct", anonymizeRequests: true } });
    expect(validUpdate.status).toBe(200);
    expect((await models.getProviderConnectionById(connection.id)).providerSpecificData).toMatchObject({ executionMode: "direct", anonymizeRequests: true });
  });

  it("keeps existing proxy binding and routing data during an options-only edit", async () => {
    const proxy = await pool("http://user:pass@brd.superproxy.io:33335");
    const response = await create(undefined, { proxyPoolId: proxy.id });
    const { connection } = await response.json();
    const update = await edit(connection.id, { providerSpecificData: { customApiSessionPinning: true, anonymizeRequests: true } });
    expect(update.status).toBe(200);
    const stored = await models.getProviderConnectionById(connection.id);
    expect(stored.apiKey).toBe("private-upstream-key");
    expect(stored.providerSpecificData).toMatchObject({ proxyPoolId: proxy.id, baseUrl: nodes.openai.baseUrl, customApiSessionPinning: true, anonymizeRequests: true });
  });

  it("rejects removing or replacing a proxy while saved pinning remains enabled", async () => {
    const proxy = await pool("http://user:pass@brd.superproxy.io:33335");
    const unsupported = await pool("http://user:pass@proxy.example:8080");
    const response = await create({ customApiSessionPinning: true }, { proxyPoolId: proxy.id });
    const { connection } = await response.json();
    const before = await models.getProviderConnectionById(connection.id);
    for (const proxyPoolId of [null, unsupported.id]) {
      const update = await edit(connection.id, { proxyPoolId });
      expect(update.status).toBe(400);
      expect(await models.getProviderConnectionById(connection.id)).toEqual(before);
    }
    const validUpdate = await edit(connection.id, { proxyPoolId: null, providerSpecificData: { customApiSessionPinning: false } });
    expect(validUpdate.status).toBe(200);
    expect((await models.getProviderConnectionById(connection.id)).providerSpecificData).not.toHaveProperty("proxyPoolId");
  });

  it("rejects enabling server Claude Code when anonymization is already saved", async () => {
    const response = await create({ anonymizeRequests: true }, {}, nodes.anthropic.id);
    const { connection } = await response.json();
    const update = await edit(connection.id, { providerSpecificData: { executionMode: "claude-code" } });
    expect(update.status).toBe(400);
    expect((await models.getProviderConnectionById(connection.id)).providerSpecificData.executionMode).toBe("direct");
  });
});
