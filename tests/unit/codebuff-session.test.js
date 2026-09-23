// Session/run lifecycle. Two classes of bug live here: buying more session
// hours than needed (each admission charges one), and drifting from the CLI's
// wire shape (which is what the free-mode gate fingerprints).
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { CodebuffExecutor } = await import("../../open-sse/executors/codebuff.js");

const sse = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
const admitted = (instanceId = "inst-1") =>
  new Response(JSON.stringify({ status: "active", instanceId, remainingMs: 3_600_000 }), { status: 200 });
const started = (runId = "run-1") => new Response(JSON.stringify({ runId }), { status: 200 });

function callsTo(fragment) {
  return proxyAwareFetch.mock.calls.filter(([url]) => String(url).includes(fragment));
}

function creds(connectionId) {
  return { accessToken: "tok-test", connectionId, providerSpecificData: { codebuffUserId: "user-123" } };
}

function run(connectionId, model = "z-ai/glm-5.3-flash") {
  return new CodebuffExecutor().execute({
    model,
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: creds(connectionId),
    log: null,
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

describe("Codebuff session lifecycle", () => {
  it("buys one session hour for concurrent requests on the same account", async () => {
    // Each admission is a charged hour. Two in-flight requests racing into
    // ensureSession must share the one admission, not buy two.
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) {
        await new Promise((r) => setTimeout(r, 20));
        return admitted();
      }
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    const key = `conn-concurrent-${Math.random()}`;
    await Promise.all([run(key), run(key), run(key)]);
    expect(callsTo("/admission")).toHaveLength(1);
  });

  it("reuses the admitted session across later requests", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    const key = `conn-reuse-${Math.random()}`;
    await run(key);
    await run(key);
    await run(key);
    expect(callsTo("/admission")).toHaveLength(1);
    expect(callsTo("/agent-runs")).toHaveLength(1);
  });

  it("sends the admission POST in the CLI's shape: no body, model + spend-limit + timezone headers", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    await run(`conn-shape-${Math.random()}`, "deepseek/deepseek-v4-flash");
    const [, options] = callsTo("/admission")[0];
    expect(options.method).toBe("POST");
    // The CLI sets Content-Type iff a body is present; the session POST has none.
    expect(options.body).toBeUndefined();
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(options.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
    expect(options.headers["x-fb-timezone"]).toBeTruthy();
  });

  it("keeps the ai-sdk User-Agent on chat only and the Bun UA on control calls", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    await run(`conn-ua-${Math.random()}`);
    expect(callsTo("/admission")[0][1].headers["User-Agent"]).toBe("Bun/1.3.14");
    expect(callsTo("/agent-runs")[0][1].headers["User-Agent"]).toBe("Bun/1.3.14");
    expect(callsTo("/chat/completions")[0][1].headers["User-Agent"]).toBe("ai-sdk/openai-compatible/1.0.0/codebuff");
  });

  it("sends agent-runs with both Authorization and x-codebuff-api-key", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    await run(`conn-dualauth-${Math.random()}`);
    const headers = callsTo("/agent-runs")[0][1].headers;
    expect(headers.Authorization).toBe("Bearer tok-test");
    expect(headers["x-codebuff-api-key"]).toBe("tok-test");
    expect(JSON.parse(callsTo("/agent-runs")[0][1].body)).toMatchObject({
      action: "START",
      agentId: "base3-free-glm-5-3-flash",
      ancestorRunIds: [],
    });
  });

  it("sends the acting-user-id only as the token's own account id", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    await run(`conn-acting-${Math.random()}`);
    expect(callsTo("/chat/completions")[0][1].headers["x-freebuff-acting-user-id"]).toBe("user-123");

    // No id resolved from /api/v1/me → the header is omitted rather than guessed.
    proxyAwareFetch.mockClear();
    await new CodebuffExecutor().execute({
      model: "z-ai/glm-5.3-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { accessToken: "tok-test", connectionId: `conn-noid-${Math.random()}`, providerSpecificData: {} },
      log: null,
    });
    expect(callsTo("/chat/completions")[0][1].headers["x-freebuff-acting-user-id"]).toBeUndefined();
  });

  it("re-admits and retries once when upstream rejects the session", async () => {
    let chatCalls = 0;
    let instance = 0;
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted(`inst-${++instance}`);
      if (String(url).includes("/agent-runs")) return started();
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error: "session_expired" }), { status: 403 });
      }
      return sse();
    });

    const result = await run(`conn-expired-${Math.random()}`);
    expect(result.response.status).toBe(200);
    expect(callsTo("/admission")).toHaveLength(2);
    // The retry rides the NEW instance id, not the dead one.
    expect(JSON.parse(callsTo("/chat/completions")[1][1].body).codebuff_metadata.freebuff_instance_id).toBe("inst-2");
  });

  it("starts a fresh run — without re-admitting — when upstream rejects the run", async () => {
    let chatCalls = 0;
    let runIdx = 0;
    proxyAwareFetch.mockImplementation(async (url, options) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) {
        // FINISH posts to the same path — only a START mints a new run id.
        const action = JSON.parse(options.body).action;
        return action === "START" ? started(`run-${++runIdx}`) : new Response("{}", { status: 200 });
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error: "free_mode_run_fanout" }), { status: 429 });
      }
      return sse();
    });

    const result = await run(`conn-fanout-${Math.random()}`);
    expect(result.response.status).toBe(200);
    // A dead run does not invalidate the purchased hour.
    expect(callsTo("/admission")).toHaveLength(1);
    const runBodies = JSON.parse(callsTo("/chat/completions")[1][1].body);
    expect(runBodies.codebuff_metadata.run_id).toBe("run-2");
  });

  it("surfaces an unrecognized upstream error instead of retrying blindly", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      return new Response(JSON.stringify({ error: "something_else" }), { status: 500 });
    });

    const result = await run(`conn-err-${Math.random()}`);
    expect(result.response.status).toBe(500);
    expect(callsTo("/chat/completions")).toHaveLength(1);
  });

  it("releases the old hour when the account switches model", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/admission")) return admitted();
      if (String(url).includes("/agent-runs")) return started();
      if (String(url).includes("/freebuff/session")) return new Response("{}", { status: 200 });
      return sse();
    });

    const key = `conn-switch-${Math.random()}`;
    await run(key, "z-ai/glm-5.3-flash");
    await run(key, "mimo/mimo-v2.5");
    // Give the fire-and-forget DELETE a tick to land.
    await new Promise((r) => setTimeout(r, 10));

    const deletes = proxyAwareFetch.mock.calls.filter(([, o]) => o?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1].headers["x-freebuff-instance-id"]).toBe("inst-1");
    expect(callsTo("/admission")).toHaveLength(2);
  });
});

describe("Codebuff model lock recovery", () => {
  // Observed in production: the account held a live glm-5.3-flash session and
  // a gpt-6-luna request 502'd on the admission 409.
  const LOCKED = () =>
    new Response(
      JSON.stringify({
        status: "model_locked",
        currentModel: "z-ai/glm-5.3-flash",
        requestedModel: "openai/gpt-6-luna",
        accessTier: "full",
      }),
      { status: 409 }
    );

  it("releases the locked session and retries when we hold no local record", async () => {
    // The restart case: upstream has a live session this process never saw,
    // so there is nothing local to release before admitting.
    let admissions = 0;
    proxyAwareFetch.mockImplementation(async (url, options) => {
      if (String(url).includes("/admission")) {
        admissions += 1;
        return admissions === 1 ? LOCKED() : admitted("inst-new");
      }
      if (String(url).includes("/agent-runs")) return started();
      if (options?.method === "DELETE") return new Response("{}", { status: 200 });
      return sse();
    });

    const result = await run(`conn-locked-${Math.random()}`, "openai/gpt-6-luna");
    expect(result.response.status).toBe(200);
    expect(admissions).toBe(2);

    const deletes = proxyAwareFetch.mock.calls.filter(([, o]) => o?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    // No id is known, so the header is omitted and upstream ends whatever
    // session the account currently holds.
    expect(deletes[0][1].headers["x-freebuff-instance-id"]).toBeUndefined();
  });

  it("releases by the id the refusal names when it carries one", async () => {
    let admissions = 0;
    proxyAwareFetch.mockImplementation(async (url, options) => {
      if (String(url).includes("/admission")) {
        admissions += 1;
        if (admissions === 1) {
          return new Response(
            JSON.stringify({ status: "model_locked", currentModel: "z-ai/glm-5.3-flash", instanceId: "inst-old" }),
            { status: 409 }
          );
        }
        return admitted("inst-new");
      }
      if (String(url).includes("/agent-runs")) return started();
      if (options?.method === "DELETE") return new Response("{}", { status: 200 });
      return sse();
    });

    await run(`conn-locked-id-${Math.random()}`, "openai/gpt-6-luna");
    const deletes = proxyAwareFetch.mock.calls.filter(([, o]) => o?.method === "DELETE");
    expect(deletes[0][1].headers["x-freebuff-instance-id"]).toBe("inst-old");
  });

  it("finishes releasing the old hour before admitting the new model", async () => {
    // A background release races the admission POST and upstream answers 409,
    // so the order of these two calls is the whole fix.
    const order = [];
    proxyAwareFetch.mockImplementation(async (url, options) => {
      if (options?.method === "DELETE") {
        order.push("delete-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("delete-end");
        return new Response("{}", { status: 200 });
      }
      if (String(url).includes("/admission")) {
        order.push("admit");
        return admitted();
      }
      if (String(url).includes("/agent-runs")) return started();
      return sse();
    });

    const key = `conn-order-${Math.random()}`;
    await run(key, "z-ai/glm-5.3-flash");
    order.length = 0;
    await run(key, "openai/gpt-6-luna");

    expect(order).toEqual(["delete-start", "delete-end", "admit"]);
  });

  it("gives up honestly when the retry is locked again", async () => {
    proxyAwareFetch.mockImplementation(async (url, options) => {
      if (String(url).includes("/admission")) return LOCKED();
      if (String(url).includes("/agent-runs")) return started();
      if (options?.method === "DELETE") return new Response("{}", { status: 200 });
      return sse();
    });

    // One release and one retry — never a loop against a lock that will not clear.
    await expect(run(`conn-relocked-${Math.random()}`, "openai/gpt-6-luna")).rejects.toThrow(/locked/i);
    expect(callsTo("/admission")).toHaveLength(2);
  });
});
