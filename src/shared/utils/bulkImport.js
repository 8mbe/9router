import { validateBulkEntry } from "./bulkValidation.js";

// Validate and save in order so one failed entry does not stop the batch.
export async function importBulkApiKeys({ provider, entries, priority = 1, proxyPoolId = null, providerSpecificData, defaultModel, onProgress }, fetcher = fetch) {
  const result = { success: 0, failed: 0, modelsPassed: 0, modelsFailed: 0, failedIndexes: [] };
  for (const [index, entry] of entries.entries()) {
    try {
      const connectionData = { ...providerSpecificData, ...entry.providerSpecificData };
      const validation = await validateBulkEntry({
        provider, apiKey: entry.apiKey, providerSpecificData: connectionData, model: defaultModel,
      }, fetcher);
      if (validation.modelResult?.supported) {
        if (validation.modelResult.ok) result.modelsPassed++;
        else result.modelsFailed++;
      }
      const response = await fetcher("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider, apiKey: entry.apiKey, name: entry.name, priority, proxyPoolId,
          defaultModel, testStatus: validation.testStatus,
          ...(Object.keys(connectionData).length ? { providerSpecificData: connectionData } : {}),
        }),
      });
      if (!response.ok) throw new Error("Connection could not be saved");
      result.success++;
    } catch {
      result.failed++;
      result.failedIndexes.push(index);
    }
    onProgress?.({ completed: index + 1, total: entries.length });
  }
  return result;
}
