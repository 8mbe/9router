export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Build the models list once in the background so the first /v1/models
    // request is served from a warm cache instead of paying for every
    // provider's catalog fetch itself.
    const { prewarmModelsCache } = await import("@/lib/modelCatalog/prewarm.js");
    prewarmModelsCache();
  }
}
