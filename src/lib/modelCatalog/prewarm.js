// Fill the upstream models cache shortly after boot.
//
// The cache makes /v1/models cheap, but only once something has populated it —
// the first caller after a restart still pays for every provider's catalog
// fetch (capped by the cold-wait budget, so ~1.5s rather than ~7s, but still
// the slowest request of the process's life). Doing that build ourselves at
// startup moves the cost off the critical path: by the time a client asks, the
// answer is already in memory.
//
// Deliberately best-effort. It never blocks boot, never throws, and if it fails
// the next real request simply behaves as it would have anyway.

const STARTUP_DELAY_MS = 3000;

let started = false;

export function prewarmModelsCache() {
  if (started) return;
  started = true;

  const timer = setTimeout(() => {
    (async () => {
      try {
        const { buildModelsList } = await import("@/app/api/v1/models/route.js");
        const t = Date.now();
        const models = await buildModelsList(["llm"], {});
        console.log(`Models cache prewarmed: ${models.length} models in ${Date.now() - t}ms`);
      } catch (err) {
        // A cold cache is the status quo, not an error worth failing boot over.
        console.log(`Models cache prewarm skipped: ${err?.message || err}`);
      }
    })();
  }, STARTUP_DELAY_MS);

  // Boot-time warming must never keep the process alive on its own.
  if (typeof timer.unref === "function") timer.unref();
}
