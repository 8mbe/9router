import { describe, it, expect, beforeEach, vi } from "vitest";

import { getRotatedModels, resetComboRotation, handleComboChat } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("manual combo order", () => {
  const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-reasoner"];
  const body = { messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
  ] }] };
  const log = { info: vi.fn(), warn: vi.fn() };

  it("tries the saved first model even when another model supports the request's capability", async () => {
    const handleSingleModel = vi.fn().mockImplementation(async () => new Response("ok"));
    for (let request = 0; request < 2; request++) {
      await handleComboChat({ body, models, handleSingleModel, log, comboName: "manual", comboStrategy: "manual" });
    }
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([models[0], models[0]]);
  });

  it("tries later models in saved order after failures without changing the configured array", async () => {
    const savedOrder = [...models];
    const success = new Response("ok");
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(success);
    const result = await handleComboChat({ body, models: savedOrder, handleSingleModel, log, comboStrategy: "manual" });
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual(models);
    expect(savedOrder).toEqual(models);
    expect(result).toBe(success);
  });

  it("preserves capability selection for the existing fallback strategy", async () => {
    const handleSingleModel = vi.fn().mockResolvedValue(new Response("ok"));
    await handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback" });
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([models[1]]);
  });
});
