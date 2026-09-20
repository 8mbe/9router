/**
 * Fuzzy model-id matching.
 *
 * Providers spell the same model differently: `gpt-5.6-sol`, `gpt-5-6-sol`,
 * `openai/gpt-5.6-sol`, `gpt-5.6-sol-latest`, `gpt-5.6-solm`. A client asking
 * for a bare model name means the model, not one provider's spelling of it, so
 * auto-combo resolution needs to recognize all of those as the same thing —
 * without ever letting a loose match outrank an exact one.
 *
 * Matching is tiered. Every candidate that matches at all comes back with the
 * tier it matched at plus a small penalty, and callers sort by that score, so
 * an exact hit on one provider always sorts ahead of a fuzzy hit on another.
 *
 *   0 EXACT      identical ids
 *   1 CANONICAL  identical once vendor prefix / separators / case are dropped
 *   2 DECORATED  identical once decoration suffixes (-latest, -preview, dates,
 *                -thinking, :free, …) are also dropped from either side
 *   3 VARIANT    one is the other plus a short variant affix (…-mini, …m, …-pro)
 *   4 NEAR       within a small edit distance — typos and stray separators
 *
 * Pure and dependency-free: no DB, no registry, no network.
 */

/** Match tiers, ordered from strongest to weakest. */
export const MATCH_TIER = {
  EXACT: 0,
  CANONICAL: 1,
  DECORATED: 2,
  VARIANT: 3,
  NEAR: 4,
};

/** Weakest tier accepted by default. Callers can tighten this. */
export const DEFAULT_MAX_TIER = MATCH_TIER.NEAR;

// Suffix tokens that name a release channel or snapshot rather than a different
// model. Dropping them lets `gpt-5.6-sol-latest` match `gpt-5.6-sol`.
const DECORATION_TOKENS = new Set([
  "latest", "stable", "ga", "preview", "exp", "experimental", "beta", "alpha",
  "free", "online", "nitro", "floor", "default", "cloud", "api",
  // Routing variants in this repo's registries (kiro/qoder/zed expose both).
  "thinking", "nothinking", "reasoning", "think",
]);

// Suffix tokens that DO name a different variant, but a close enough one that a
// combo should still consider it when nothing better exists (tier VARIANT).
const VARIANT_TOKENS = new Set([
  "m", "mini", "n", "nano", "s", "small", "l", "large", "lite", "light", "air",
  "p", "pro", "plus", "max", "ultra", "turbo", "flash", "fast", "hd", "xl", "xs",
  "chat", "instruct", "it", "base", "code", "coder", "vision", "v",
  "high", "medium", "low", "minimal",
]);

// A dated snapshot (`-20260918`, `-0325`) or a version bump (`-v2`).
const SNAPSHOT_RE = /^(?:\d{4}|\d{6}|\d{8}|v\d+)$/;

/**
 * Strip the parts of an id that identify the *catalog* rather than the model:
 * a vendor path (`openai/gpt-…`, `us.anthropic.claude-…`), a tag (`…:free`),
 * and a trailing parenthetical (`… (beta)`).
 */
function stripCatalogNoise(id) {
  let out = String(id).trim().toLowerCase();
  out = out.replace(/\([^()]*\)\s*$/, "");          // "model (beta)"
  const lastSlash = out.lastIndexOf("/");
  if (lastSlash !== -1) out = out.slice(lastSlash + 1); // "vendor/model"
  const colon = out.indexOf(":");
  if (colon !== -1) out = out.slice(0, colon);          // "model:free"
  return out.trim();
}

/**
 * Collapse an id to comparable form: no vendor, no separators, no case.
 * `gpt-5.6-sol` and `GPT_5_6_SOL` both become `gpt56sol`.
 */
export function canonicalModelId(id) {
  if (!id) return "";
  return stripCatalogNoise(id).replace(/[^a-z0-9]/g, "");
}

/**
 * Split an id into comparison tokens, breaking on separators AND on
 * letter/digit boundaries so `gpt-5.6-sol` and `gpt56sol` tokenize alike.
 */
export function modelTokens(id) {
  if (!id) return [];
  return stripCatalogNoise(id)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((part) => part.match(/\d+|[a-z]+/g) || []);
}

/**
 * Drop trailing decoration tokens (channel names, snapshot dates, version
 * bumps). Returns the surviving tokens and how many were removed — the count
 * becomes a tie-break penalty so a less-decorated match wins.
 */
function stripDecorations(tokens) {
  const kept = [...tokens];
  let stripped = 0;
  while (kept.length > 1) {
    const last = kept[kept.length - 1];
    if (!DECORATION_TOKENS.has(last) && !SNAPSHOT_RE.test(last)) break;
    kept.pop();
    stripped += 1;
  }
  return { tokens: kept, stripped };
}

/** Levenshtein distance, bailing out as soon as it exceeds `max`. */
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/** How far apart two canonical ids may be before they are different models. */
function nearThreshold(canonical) {
  return Math.max(1, Math.floor(canonical.length / 8));
}

/**
 * The extra text one id carries over the other, when one is a prefix of the
 * other. `gpt56sol` vs `gpt56solm` → "m".
 */
function affixRemainder(a, b) {
  if (a.startsWith(b)) return a.slice(b.length);
  if (b.startsWith(a)) return b.slice(a.length);
  return null;
}

/** A remainder that names a size/tier variant rather than a different model. */
function isVariantAffix(remainder) {
  if (!remainder) return false;
  if (remainder.length <= 2) return true;
  const parts = remainder.match(/\d+|[a-z]+/g) || [];
  return parts.length > 0 && parts.every((p) => VARIANT_TOKENS.has(p) || SNAPSHOT_RE.test(p));
}

/**
 * Score one candidate id against the requested id.
 *
 * @param {string} requested - What the client asked for.
 * @param {string} candidate - An id from a provider's catalog.
 * @returns {{tier: number, score: number, candidate: string}|null} null when unrelated.
 */
export function scoreModelMatch(requested, candidate) {
  if (!requested || !candidate) return null;
  if (requested === candidate) return { tier: MATCH_TIER.EXACT, score: 0, candidate };

  const reqCanon = canonicalModelId(requested);
  const candCanon = canonicalModelId(candidate);
  if (!reqCanon || !candCanon) return null;

  if (reqCanon === candCanon) return { tier: MATCH_TIER.CANONICAL, score: 10, candidate };

  const reqStripped = stripDecorations(modelTokens(requested));
  const candStripped = stripDecorations(modelTokens(candidate));
  const reqBare = reqStripped.tokens.join("");
  const candBare = candStripped.tokens.join("");
  if (reqBare && reqBare === candBare) {
    // Penalize by how much had to be thrown away to make them equal.
    return {
      tier: MATCH_TIER.DECORATED,
      score: 20 + reqStripped.stripped + candStripped.stripped,
      candidate,
    };
  }

  const remainder = affixRemainder(reqBare || reqCanon, candBare || candCanon);
  if (isVariantAffix(remainder)) {
    return { tier: MATCH_TIER.VARIANT, score: 30 + remainder.length, candidate };
  }

  const max = nearThreshold(reqCanon);
  const distance = editDistance(reqCanon, candCanon, max);
  if (distance <= max) {
    return { tier: MATCH_TIER.NEAR, score: 40 + distance, candidate };
  }

  return null;
}

/**
 * Best match for `requested` among `candidates`.
 *
 * @param {string} requested
 * @param {string[]} candidates
 * @param {{maxTier?: number}} [options] - maxTier caps how loose a match may be.
 * @returns {{tier: number, score: number, candidate: string}|null}
 */
export function bestModelMatch(requested, candidates, options = {}) {
  const maxTier = options.maxTier ?? DEFAULT_MAX_TIER;
  let best = null;
  for (const candidate of candidates || []) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const match = scoreModelMatch(requested, candidate);
    if (!match || match.tier > maxTier) continue;
    // Ties break on the shorter id: the plain model, not a decorated sibling.
    if (
      !best ||
      match.score < best.score ||
      (match.score === best.score && match.candidate.length < best.candidate.length)
    ) {
      best = match;
    }
  }
  return best;
}
