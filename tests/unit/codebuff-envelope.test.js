// The Codebuff free-mode gate is a prefix test on the first system message plus
// a set of reserved identifiers in codebuff_metadata. Every case below is a way
// a request gets refused upstream (403 free_mode_cli_required /
// free_mode_run_fanout), so they are locked here rather than discovered live.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The executor calls upstream through proxyAwareFetch, not global fetch —
// stubbing globalThis.fetch would let these tests hit codebuff.com for real.
const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { CodebuffExecutor } = await import("../../open-sse/executors/codebuff.js");

const BASE2 =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
const BASE3 = "You are Buffy, the coding agent behind Codebuff.";

const CREDS = {
  accessToken: "tok-test",
  connectionId: "conn-1",
  providerSpecificData: { codebuffUserId: "user-123" },
};

// Drives execute() with the network stubbed, and returns the body that would
// have been POSTed to the chat endpoint.
async function envelopeFor(model, body, { connectionId = `conn-${Math.random()}` } = {}) {
  let chatBody = null;
  proxyAwareFetch.mockImplementation(async (url, options) => {
    if (String(url).includes("/freebuff/session/admission")) {
      return new Response(JSON.stringify({ status: "active", instanceId: "inst-1", remainingMs: 3_600_000 }), { status: 200 });
    }
    if (String(url).includes("/agent-runs")) {
      return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
    }
    chatBody = JSON.parse(options.body);
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });

  const executor = new CodebuffExecutor();
  await executor.execute({
    model,
    body,
    stream: true,
    credentials: { ...CREDS, connectionId },
    log: null,
  });
  return chatBody;
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

describe("Codebuff request envelope", () => {
  it("prepends the base3 identity for a model whose CLI root is base3", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(env.messages[0].role).toBe("system");
    expect(env.messages[0].content).toBe(BASE3);
  });

  it("merges the marker into an existing system message instead of replacing it", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [
        { role: "system", content: "Always answer in French." },
        { role: "user", content: "hi" },
      ],
    });
    expect(env.messages[0].content).toBe(`${BASE3}\n\nAlways answer in French.`);
  });

  it("leaves a prompt that already opens with a canonical identity untouched", async () => {
    // The gate is any-of-five: re-prepending would push the existing opening
    // off position 0 and break a request that already passes.
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [
        { role: "system", content: `${BASE2}\n\nExtra rules.` },
        { role: "user", content: "hi" },
      ],
    });
    expect(env.messages[0].content).toBe(`${BASE2}\n\nExtra rules.`);
    expect(env.messages[0].content.startsWith(BASE3)).toBe(false);
  });

  it("scrubs foreign harness markers that upstream refuses", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [
        { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Be terse." },
        { role: "user", content: "hi" },
      ],
    });
    expect(env.messages[0].content).not.toContain("You are Claude Code");
    expect(env.messages[0].content).not.toContain("Anthropic's official CLI");
    // Surrounding instructions survive the scrub.
    expect(env.messages[0].content).toContain("Be terse.");
    expect(env.messages[0].content.startsWith(BASE3)).toBe(true);
  });

  it("scrubs markers inside array-shaped system content", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [
        { role: "system", content: [{ type: "text", text: "You are Claude Code. Do the thing." }] },
        { role: "user", content: "hi" },
      ],
    });
    const texts = env.messages[0].content.map((p) => p.text).join("");
    expect(texts).not.toContain("You are Claude Code");
    expect(texts).toContain("Do the thing.");
  });

  it("stamps the reserved identifiers and forces the CLI envelope", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(env.codebuff_metadata.run_id).toBe("run-1");
    expect(env.codebuff_metadata.freebuff_instance_id).toBe("inst-1");
    expect(env.codebuff_metadata.cost_mode).toBe("free");
    expect(env.codebuff_metadata.llm_step_number).toBe("1");
    expect(env.provider).toEqual({ data_collection: "deny" });
    expect(env.stream).toBe(true);
  });

  it("mints a client_id in the ai-sdk shape, never a proxy-looking one", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
    });
    const clientId = env.codebuff_metadata.client_id;
    // 13 chars of base36. The sess:/run:/wf- forms are what upstream
    // fingerprints as proxy traffic.
    expect(clientId).toMatch(/^[a-z0-9]{13}$/);
    expect(clientId.startsWith("sess:")).toBe(false);
    expect(clientId.startsWith("run:")).toBe(false);
    expect(clientId).not.toMatch(/^wf-/);
  });

  it("repeats one client_id across the calls of a run and increments the step", async () => {
    // A fresh draw per call inside one run_id is exactly the fan-out shape
    // upstream refuses with free_mode_run_fanout.
    const connectionId = "conn-stable";
    const first = await envelopeFor("z-ai/glm-5.3-flash", { messages: [{ role: "user", content: "a" }] }, { connectionId });
    const second = await envelopeFor("z-ai/glm-5.3-flash", { messages: [{ role: "user", content: "b" }] }, { connectionId });
    expect(second.codebuff_metadata.client_id).toBe(first.codebuff_metadata.client_id);
    expect(second.codebuff_metadata.run_id).toBe(first.codebuff_metadata.run_id);
    expect(second.codebuff_metadata.trace_session_id).toBe(first.codebuff_metadata.trace_session_id);
    expect(first.codebuff_metadata.llm_step_number).toBe("1");
    expect(second.codebuff_metadata.llm_step_number).toBe("2");
  });

  it("never lets a caller supply its own reserved identifiers", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
      codebuff_metadata: { run_id: "forged", client_id: "forged", keep_me: "yes" },
    });
    expect(env.codebuff_metadata.run_id).toBe("run-1");
    expect(env.codebuff_metadata.client_id).not.toBe("forged");
    // Non-reserved extras pass through, like the CLI's extraCodebuffMetadata.
    expect(env.codebuff_metadata.keep_me).toBe("yes");
  });

  it("mirrors reasoning_effort into the field the upstream effort authority reads", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });
    expect(env.codebuff_metadata.freebuff_reasoning_effort).toBe("high");
  });

  it("omits the effort field entirely when the caller asked for none", async () => {
    const env = await envelopeFor("z-ai/glm-5.3-flash", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect("freebuff_reasoning_effort" in env.codebuff_metadata).toBe(false);
  });
});
