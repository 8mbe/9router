import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import {
  clineHome,
  clineAuthDir,
  clineRealSettingsPath,
  buildPrompt,
  buildSystemPrompt,
  normalizeThinkingForCline,
  envDelta,
  envDoneText,
  throwIfAgentError,
  resolveClineCoreIndex,
  ClineFreeExecutor,
} from "open-sse/executors/cline-free.js";
import { CLINE_INPROCESS_URL } from "open-sse/config/providers.js";

// cline-free runs Cline inside this process (the cline-api bridge, vendored into
// the executor). These cover the seams that creates: no wire auth, an OpenAI body
// flattened into a Cline turn, and Cline's envelope stream re-emitted as SSE.

const FAKE_CORE = fileURLToPath(new URL("../fixtures/fake-cline-core/index.js", import.meta.url));
const ENV_KEYS = ["CLINE_CORE_INDEX", "CLINE_ENABLE_TOOLS", "CLINE_WORKSPACE_ROOT", "CLINE_DATA_DIR", "CLINE_HOME", "DATA_DIR"];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function readSse(response) {
  const text = await response.text();
  return text.split("\n\n")
    .map(b => b.replace(/^data: /, "").trim())
    .filter(b => b && b !== "[DONE]")
    .map(b => JSON.parse(b));
}

// The executor seeds its data dir from the real `cline auth` session; point
// CLINE_HOME at a throwaway one so tests never touch (or require) the user's ~/.cline.
async function stubClineLogin() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "9router-cline-test-"));
  const settingsDir = path.join(home, "data", "settings");
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(path.join(settingsDir, "providers.json"), JSON.stringify({ stub: true }));
  process.env.CLINE_HOME = home;
  return home;
}

describe("cline-free registry entry", () => {
  const entry = REGISTRY.find(r => r.id === "cline-free");

  it("is registered as a no-auth free provider", () => {
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("free");
    expect(entry.noAuth).toBe(true);
    expect(entry.authModes).toEqual(["none"]);
  });

  it("keeps a unique alias and exposes Cline's free default model", () => {
    const claimants = REGISTRY.filter(r => [r.alias, r.uiAlias, ...(r.aliases || [])].includes("clf"));
    expect(claimants.map(r => r.id)).toEqual(["cline-free"]);
    expect(PROVIDER_MODELS.clf.map(m => m.id)).toContain("cline-free/deepseek-v4.1-flash");
    expect(entry.passthroughModels).toBe(true);
  });

  it("declares the in-process marker rather than a dialable endpoint", () => {
    expect(PROVIDERS["cline-free"].baseUrl).toBe(CLINE_INPROCESS_URL);
    expect(CLINE_INPROCESS_URL.startsWith("cline://")).toBe(true);
  });
});

describe("cline-free executor wiring", () => {
  it("is the dedicated executor, reachable by id and alias", () => {
    expect(getExecutor("cline-free").constructor.name).toBe("ClineFreeExecutor");
    expect(getExecutor("clf").constructor.name).toBe("ClineFreeExecutor");
  });

  it("sends no headers and dials nothing — there is no wire", () => {
    const ex = getExecutor("cline-free");
    expect(ex.buildHeaders()).toEqual({});
    expect(ex.buildUrl()).toBe(CLINE_INPROCESS_URL);
  });

  it("finds @cline/core via CLINE_CORE_INDEX", async () => {
    process.env.CLINE_CORE_INDEX = FAKE_CORE;
    expect(await resolveClineCoreIndex()).toBe(FAKE_CORE);
  });
});

// Containers are the case these paths exist for: the login arrives on a read-only
// mount, and anything written outside the DATA_DIR volume dies with the container.
describe("cline-free path resolution (Docker)", () => {
  it("reads the login from CLINE_HOME, so a mounted host session is found", () => {
    process.env.CLINE_HOME = "/app/cline-home";
    expect(clineHome()).toBe("/app/cline-home");
    expect(clineRealSettingsPath()).toBe(path.join("/app/cline-home", "data", "settings", "providers.json"));
  });

  it("falls back to ~/.cline when CLINE_HOME is unset", () => {
    expect(clineHome()).toBe(path.join(os.homedir(), ".cline"));
  });

  it("writes its own SDK dir under DATA_DIR so it survives container restarts", () => {
    process.env.DATA_DIR = "/app/data";
    expect(clineAuthDir()).toBe(path.join("/app/data", "cline-9router"));
  });

  it("keeps the auth dir beside the login when DATA_DIR is unset (bare metal)", () => {
    process.env.CLINE_HOME = "/home/u/.cline";
    expect(clineAuthDir()).toBe(path.join("/home/u/.cline", "9router-data"));
  });

  it("never writes to the login source — it copies out of it", async () => {
    const home = await stubClineLogin();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-cline-data-"));
    process.env.DATA_DIR = dataDir;
    const { seedClineAuth } = await import("open-sse/executors/cline-free.js");
    const authDir = await seedClineAuth();
    expect(authDir).toBe(path.join(dataDir, "cline-9router"));
    // the seeded copy exists, and the mounted original is untouched
    await expect(fs.access(path.join(authDir, "settings", "providers.json"))).resolves.toBeUndefined();
    expect(await fs.readdir(path.join(home, "data", "settings"))).toEqual(["providers.json"]);
    expect(process.env.CLINE_DATA_DIR).toBe(authDir);
  });
});

describe("OpenAI body → Cline turn", () => {
  it("flattens the message history into one tagged prompt, minus system turns", () => {
    const prompt = buildPrompt([
      { role: "system", content: "ignore me" },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(prompt).toContain('<message role="user">\nhi\n</message>');
    expect(prompt).toContain('<message role="assistant">\nhello\n</message>');
    expect(prompt).not.toContain("ignore me");
  });

  it("hoists system messages into the system prompt, with a default when absent", () => {
    expect(buildSystemPrompt({ messages: [{ role: "system", content: "be terse" }] })).toBe("be terse");
    expect(buildSystemPrompt({ system: "explicit" })).toBe("explicit");
    expect(buildSystemPrompt({ messages: [] })).toMatch(/^You are Cline/);
  });

  it("collapses provider-native thinking shapes onto Cline's boolean + budget", () => {
    expect(normalizeThinkingForCline({ thinking: { type: "enabled" } }).thinking).toBe(true);
    expect(normalizeThinkingForCline({ thinking: { type: "disabled" } }).thinking).toBe(false);
    // zai's off switch
    expect(normalizeThinkingForCline({ enable_thinking: false }).thinking).toBe(false);
    const budgeted = normalizeThinkingForCline({ thinking: { type: "enabled", budget_tokens: 250000 } });
    expect(budgeted.thinkingBudgetTokens).toBe(100000); // clamped to Cline's ceiling
    expect(normalizeThinkingForCline({}).thinking).toBeUndefined();
  });
});

describe("Cline envelope stream", () => {
  it("extracts text deltas and the terminal done text, ignoring noise", () => {
    expect(envDelta(JSON.stringify({ type: "content_delta", contentType: "text", text: "hi" }))).toBe("hi");
    expect(envDelta(JSON.stringify({ type: "content_delta", contentType: "image", text: "x" }))).toBeNull();
    expect(envDelta("not json")).toBeNull();
    expect(envDoneText(JSON.stringify({ type: "done", text: "final" }))).toBe("final");
  });

  it("re-raises quota/billing text as real errors so account fallback can see them", () => {
    expect(() => throwIfAgentError("Daily free limit reached, try later")).toThrow(/Daily free limit/);
    try { throwIfAgentError("Insufficient balance"); } catch (e) { expect(e.status).toBe(402); }
    try { throwIfAgentError('{"error":{"message":"Error 429: slow down"}}'); } catch (e) { expect(e.status).toBe(429); }
    expect(() => throwIfAgentError("a normal answer")).not.toThrow();
  });
});

describe("cline-free turn execution (fake @cline/core)", () => {
  beforeEach(async () => {
    process.env.CLINE_CORE_INDEX = FAKE_CORE;
    await stubClineLogin();
  });

  it("streams Cline deltas as OpenAI SSE with a role frame and a stop frame", async () => {
    const ex = new ClineFreeExecutor();
    const { response, url } = await ex.execute({
      model: "cline-free/glm-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
    });
    expect(url).toBe(CLINE_INPROCESS_URL);
    const frames = await readSse(response);
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames.map(f => f.choices[0].delta.content).filter(Boolean).join("")).toBe("Hello");
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("answers a non-stream request with one chat.completion body", async () => {
    const ex = new ClineFreeExecutor();
    const { response } = await ex.execute({
      model: "cline-free/glm-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });
    const json = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello");
    // Cline reports no token counts.
    expect(json.usage).toBeNull();
  });

  it("keeps Cline's tools off unless CLINE_ENABLE_TOOLS=1", async () => {
    const { calls, ClineCore } = await import(FAKE_CORE);
    calls.length = 0;
    void ClineCore;
    const ex = new ClineFreeExecutor();
    await ex.execute({ model: "m", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: {} });
    expect(calls.find(c => c.type === "start").config.enableTools).toBe(false);

    calls.length = 0;
    process.env.CLINE_ENABLE_TOOLS = "1";
    await ex.execute({ model: "m", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: {} });
    expect(calls.find(c => c.type === "start").config.enableTools).toBe(true);
  });

  it("surfaces a missing Cline login as an auth error, not a blank answer", async () => {
    process.env.CLINE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "9router-cline-noauth-"));
    const ex = new ClineFreeExecutor();
    const { response } = await ex.execute({
      model: "m", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: {},
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toMatch(/cline auth/i);
  });

  it("rejects an empty prompt instead of starting a turn", async () => {
    const ex = new ClineFreeExecutor();
    const { response } = await ex.execute({ model: "m", body: { messages: [] }, stream: false, credentials: {} });
    expect(response.status).toBe(400);
  });
});
