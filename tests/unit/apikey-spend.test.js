import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDir;
let db;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spend-"));
  process.env.DATA_DIR = tmpDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("getApiKeySpend", () => {
  it("rolls money up per API key, splitting attributed vs keyless traffic", async () => {
    const a = await db.createApiKey("Key A", "machine-aaaaaaaa");
    const b = await db.createApiKey("Key B", "machine-aaaaaaaa");

    // Priced so cost is deterministic regardless of bundled provider pricing.
    await db.updatePricing({ openai: { "gpt-test": { input: 1, output: 2 } } });

    const now = new Date().toISOString();
    const save = (apiKey, prompt, completion) =>
      db.saveRequestUsage({
        timestamp: new Date(Date.now() - Math.random() * 1000).toISOString(),
        provider: "openai",
        model: "gpt-test",
        apiKey,
        endpoint: "/v1/chat/completions",
        tokens: { prompt_tokens: prompt, completion_tokens: completion },
      });

    await save(a.key, 1_000_000, 1_000_000); // $1 in + $2 out = $3
    await save(a.key, 1_000_000, 0);         // $1
    await save(b.key, 0, 1_000_000);         // $2
    await save(null, 1_000_000, 0);          // $1, no key

    const spend = await db.getApiKeySpend();

    const byName = Object.fromEntries(spend.keys.map((k) => [k.name, k]));
    expect(byName["Key A"].spend.total.cost).toBeCloseTo(4, 6);
    expect(byName["Key A"].spend.total.requests).toBe(2);
    expect(byName["Key B"].spend.total.cost).toBeCloseTo(2, 6);
    expect(byName["Key B"].spend.total.requests).toBe(1);

    // Keyless traffic is reported separately, never folded into a key
    expect(spend.unattributed.spend.total.cost).toBeCloseTo(1, 6);
    expect(spend.totals.total.cost).toBeCloseTo(7, 6);

    // 24h window (exact timestamps) agrees with the day rollup here
    expect(byName["Key A"].spend.last24h.cost).toBeCloseTo(4, 6);
    expect(byName["Key A"].lastUsed).toBeTruthy();

    // Masked, never the raw secret
    expect(byName["Key A"].apiKeyMasked).not.toBe(a.key);
    expect(a.key.startsWith(byName["Key A"].apiKeyMasked.replace("***", ""))).toBe(true);
    expect(now).toBeTruthy();
  });

  it("keeps spend from deleted keys visible instead of losing it", async () => {
    const c = await db.createApiKey("Key C", "machine-aaaaaaaa");
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-test", apiKey: c.key,
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 },
    });
    await db.deleteApiKey(c.id);

    const spend = await db.getApiKeySpend();
    expect(spend.keys.find((k) => k.name === "Key C")).toBeUndefined();
    expect(spend.deleted.length).toBe(1);
    expect(spend.deleted[0].spend.total.cost).toBeCloseTo(1, 6);
  });
});
