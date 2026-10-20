const METRICS = ["latencyMs", "ttftMs", "responseDurationMs", "tokensPerSecond", "outputTokens"];

/** Each successful key contributes once; failed requests never lower the average. */
export function aggregateModelTestResults(results = []) {
  const successful = results.filter((result) => result.ok === true);
  const samples = results.length === 1 ? results : successful;
  const metrics = Object.fromEntries(METRICS.map((field) => {
    const values = samples.map((sample) => sample[field]).filter((value) => Number.isFinite(value) && value >= 0);
    return [field, values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null];
  }));
  const errors = results.filter((result) => !result.ok).map((result) => ({
    connectionId: result.connectionId,
    connectionName: result.connectionName,
    error: result.error || "Model test failed",
  }));
  return {
    ...metrics,
    ok: results.length > 0 && errors.length === 0,
    error: errors.length === 1 ? errors[0].error : errors.length ? `${errors.length} keys failed` : null,
    tokensEstimated: samples.some((sample) => sample.tokensEstimated === true),
    note: [...new Set(samples.map((sample) => sample.note).filter(Boolean))].join(" ") || null,
    successCount: successful.length,
    totalCount: results.length,
    errors,
    results,
  };
}
