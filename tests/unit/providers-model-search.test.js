import { describe, expect, it } from "vitest";
import {
  matchesProviderSearch,
  matchesStatusFilter,
} from "@/app/(dashboard)/dashboard/providers/utils.js";

const codex = { name: "OpenAI Codex" };
const claude = { name: "Claude Code" };

describe("providers model search", () => {
  it.each(["", "   "])("keeps every provider for an empty query %j", (query) => {
    expect(matchesProviderSearch(query, "codex", codex)).toBe(true);
    expect(matchesProviderSearch(query, "unknown-provider", {})).toBe(true);
  });

  it.each(["OpenAI Codex", "codex", "cx"])("preserves provider search by %j", (query) => {
    expect(matchesProviderSearch(query, "codex", codex)).toBe(true);
  });

  it("finds a built-in model by its display name and model ID", () => {
    expect(matchesProviderSearch("Claude 4.5 Haiku", "claude", claude)).toBe(true);
    expect(matchesProviderSearch("claude-haiku-4-5-20251001", "claude", claude)).toBe(true);
    expect(matchesProviderSearch("haiku-4-5", "claude", claude)).toBe(true);
    expect(matchesProviderSearch("  CLAUDE 4.5 HAIKU  ", "claude", claude)).toBe(true);
  });

  it.each(["cx/gpt-6.1-sol", "codex/gpt-6.1-sol"])(
    "finds a built-in model using qualified model ID %j",
    (query) => {
      expect(matchesProviderSearch(query, "codex", codex)).toBe(true);
      expect(matchesProviderSearch(query, "claude", claude)).toBe(false);
    },
  );

  it("does not match unrelated model names or IDs", () => {
    expect(matchesProviderSearch("Claude 4.5 Haiku", "codex", codex)).toBe(false);
    expect(matchesProviderSearch("unregistered-model-xyz", "codex", codex)).toBe(false);
  });

  it("searches stored custom names and IDs only under their provider", () => {
    const options = {
      customModels: [
        { providerAlias: "ollama", id: "vendor/custom-chat", name: "Private Chat", type: "llm" },
        { providerAlias: "opencode-go", id: "vendor/custom-chat", name: "Remote Chat", type: "llm" },
      ],
    };

    expect(matchesProviderSearch("private chat", "ollama", { name: "Ollama" }, options)).toBe(true);
    expect(matchesProviderSearch("vendor/custom-chat", "ollama", {}, options)).toBe(true);
    expect(matchesProviderSearch("ollama/vendor/custom-chat", "ollama", {}, options)).toBe(true);
    expect(matchesProviderSearch("private chat", "opencode-go", {}, options)).toBe(false);
    expect(matchesProviderSearch("ollama/vendor/custom-chat", "opencode-go", {}, options)).toBe(false);
  });

  it("accepts custom models saved with a standard provider alias", () => {
    const options = {
      customModels: [{ providerAlias: "cx", id: "custom-reasoner", name: "My Reasoner" }],
    };

    expect(matchesProviderSearch("my reasoner", "codex", codex, options)).toBe(true);
    expect(matchesProviderSearch("cx/custom-reasoner", "codex", codex, options)).toBe(true);
  });

  it.each(["openai-compatible-chat-local", "anthropic-compatible-local"])(
    "searches compatible models through their public prefix and storage ID %j",
    (providerId) => {
      const provider = { name: "Private Endpoint", prefix: "production" };
      const options = {
        customModels: [
          { providerAlias: providerId, id: "vendor/private-model", name: "Internal Assistant", type: "llm" },
        ],
      };

      expect(matchesProviderSearch("internal assistant", providerId, provider, options)).toBe(true);
      expect(matchesProviderSearch("vendor/private-model", providerId, provider, options)).toBe(true);
      expect(matchesProviderSearch("production/vendor/private-model", providerId, provider, options)).toBe(true);
      expect(matchesProviderSearch(`${providerId}/vendor/private-model`, providerId, provider, options)).toBe(true);
      expect(matchesProviderSearch("production", providerId, provider, options)).toBe(true);
      expect(matchesProviderSearch("production/vendor/private-model", "ollama", {}, options)).toBe(false);
    },
  );

  it("finds legacy alias-only models without truncating model IDs containing slashes", () => {
    const options = {
      modelAliases: {
        "my-legacy-alias": "cc/vendor/legacy-model",
        "old-provider-id": "claude/second-legacy-model",
        "remote-alias": "ollama/remote-model",
      },
    };

    expect(matchesProviderSearch("my-legacy-alias", "claude", claude, options)).toBe(true);
    expect(matchesProviderSearch("vendor/legacy-model", "claude", claude, options)).toBe(true);
    expect(matchesProviderSearch("cc/vendor/legacy-model", "claude", claude, options)).toBe(true);
    expect(matchesProviderSearch("second-legacy-model", "claude", claude, options)).toBe(true);
    expect(matchesProviderSearch("remote-model", "claude", claude, options)).toBe(false);
    expect(matchesProviderSearch("my-legacy-alias", "codex", codex, options)).toBe(false);
  });

  it("keeps media models out of LLM provider search", () => {
    const options = {
      customModels: [
        { providerAlias: "cx", id: "custom-image", name: "Private Image", type: "image" },
        { providerAlias: "cx", id: "custom-speech", name: "Private Speech", kind: "tts" },
        { providerAlias: "cx", id: "custom-text", name: "Private Text" },
      ],
      modelAliases: {
        "image-shortcut": "cx/gpt-image-2.5",
        "custom-image-shortcut": "cx/custom-image",
        "custom-speech-shortcut": "cx/custom-speech",
      },
    };

    expect(matchesProviderSearch("gpt-image-2.5", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("private image", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("custom-speech", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("image-shortcut", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("custom-image-shortcut", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("custom-speech-shortcut", "codex", codex, options)).toBe(false);
    expect(matchesProviderSearch("private text", "codex", codex, options)).toBe(true);
  });

  it("composes model search with the existing connection status filter", () => {
    const providers = [
      { id: "codex", info: codex, stats: { total: 1, allDisabled: false } },
      { id: "claude", info: claude, stats: { total: 2, allDisabled: true } },
    ];
    const filter = (query, status) => providers.filter(({ id, info, stats }) =>
      matchesProviderSearch(query, id, info) && matchesStatusFilter(status, stats),
    ).map(({ id }) => id);

    expect(filter("gpt-6.1-sol", "active")).toEqual(["codex"]);
    expect(filter("gpt-6.1-sol", "inactive")).toEqual([]);
    expect(filter("haiku", "inactive")).toEqual(["claude"]);
    expect(filter("haiku", "all")).toEqual(["claude"]);
  });
});
