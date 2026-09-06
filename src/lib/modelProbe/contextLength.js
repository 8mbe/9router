// Upstream /models payloads have no agreed field for the context window. Each
// gateway invented its own name, so importing a model list means checking all of
// them. Ordered most-specific first: OpenRouter's top_provider.context_length is
// the window the route actually serves, which can be smaller than the model's
// nominal context_length.
const CONTEXT_PATHS = [
  ["top_provider", "context_length"],
  ["context_length"],
  ["context_window"],
  ["contextWindow"],
  ["max_context_length"],
  ["maxContextLength"],
  ["contextLength"],
  ["max_model_len"],          // vLLM
  ["max_input_tokens"],       // LiteLLM
  ["maxInputTokens"],
  ["limit", "context"],       // models.dev
  ["config", "max_context_length"],
  ["meta", "context_length"],
  ["architecture", "context_length"],
];

// Anything beyond this is a unit mix-up (bytes, characters) rather than a token
// count — 20M tokens is already far past any shipping model.
const MAX_PLAUSIBLE_CONTEXT = 20_000_000;

function readPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Coerce a raw field to a positive integer token count, or null if implausible. */
export function normalizeContextLength(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw.replace(/[_,\s]/g, "")) : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0 || i > MAX_PLAUSIBLE_CONTEXT) return null;
  return i;
}

/** Pull a context window out of one upstream /models entry. Returns null when absent. */
export function extractContextLength(model) {
  if (!model || typeof model !== "object") return null;
  for (const path of CONTEXT_PATHS) {
    const value = normalizeContextLength(readPath(model, path));
    if (value !== null) return value;
  }
  return null;
}

/** "128k" / "1M" / "4096" — compact enough for a badge. */
export function formatContextLength(value) {
  const n = normalizeContextLength(value);
  if (n === null) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(n);
}
