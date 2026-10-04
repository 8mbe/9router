import { describe, expect, it, vi } from "vitest";
import { checkFallbackError, isModelUnavailableError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn() };
const models = ["first/claude-opus-5", "second/claude-opus-4.8", "third/claude-opus-4.7"];

describe("model availability errors", () => {
  it.each([
    "The model `claude-opus-5` does not exist",
    "model not found",
    "Model claude-opus-5 is not supported",
    "unsupported model",
    "Requested model is unavailable",
    "model: claude-opus-5 is not available",
    "Unknown model name: claude-opus-5",
  ])("falls back for a model-specific 400: %s", (message) => {
    expect(isModelUnavailableError(400, message)).toBe(true);
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: true,
      cooldownMs: expect.any(Number),
    });
    expect(checkFallbackError(400, message).cooldownMs).toBeGreaterThan(0);
  });

  it.each([
    "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
    "The model does not support image input",
    "Unsupported parameter 'temperature' for this model",
    "Unsupported model parameter: temperature",
    "messages: invalid role",
    "Invalid model response format",
  ])("preserves a request-specific 400: %s", (message) => {
    expect(isModelUnavailableError(400, message)).toBe(false);
    expect(checkFallbackError(400, message)).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("restricts availability wording to 400 while preserving existing quota rules", () => {
    expect(isModelUnavailableError(422, "model not found")).toBe(false);
    expect(checkFallbackError(422, "model not found")).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });
});

describe("combo fallback after model availability errors", () => {
  it("tries every later member after model errors and returns the successful response intact", async () => {
    const body = { model: "claude-opus-5", messages: [{ role: "user", content: "Hello" }], stream: true };
    const success = new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream", "x-selected-provider": "third" },
    });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 400 }))
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback" });

    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual(models);
    expect(models).toEqual(["first/claude-opus-5", "second/claude-opus-4.8", "third/claude-opus-4.7"]);
    expect(response).toBe(success);
    expect(response.headers.get("x-selected-provider")).toBe("third");
    expect(await response.text()).toBe("data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
  });

  it("returns a malformed-request error intact without trying or dropping later models", async () => {
    const errorBody = JSON.stringify({ error: { message: "messages: invalid role" } });
    const error = new Response(errorBody, { status: 400, headers: { "x-error-provider": "first" } });
    const handleSingleModel = vi.fn().mockResolvedValue(error);

    const response = await handleComboChat({ body: { messages: [] }, models, handleSingleModel, log, comboStrategy: "fallback" });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(response).toBe(error);
    expect(response.headers.get("x-error-provider")).toBe("first");
    expect(await response.text()).toBe(errorBody);
    expect(models).toHaveLength(3);
  });
});
