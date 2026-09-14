/**
 * Render a probe's round-trip time. Sub-second values stay in whole ms (the
 * precision that distinguishes a fast upstream from a slow one); anything
 * longer reads better as seconds.
 * @param {number|null|undefined} ms
 * @returns {string} e.g. "420ms", "1.8s" — "" when there is nothing to show
 */
export function formatLatency(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
