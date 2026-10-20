import PropTypes from "prop-types";
import { formatLatency } from "@/shared/utils/latency";

const duration = (value) => Number.isFinite(value) ? formatLatency(value) : "N/A";

function regionSettingsLink(error) {
  if (!/RegionError|hosted in China|regionNotAllowed/i.test(error)) return null;
  const workspace = String(error).match(/wrk_[0-9A-Za-z]+/)?.[0];
  return workspace ? `https://opencode.ai/workspace/${workspace}/go` : "https://opencode.ai";
}

export function ModelTestControls({ onTest, isTesting = false, testingType, allowEssay = true }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Model tests">
      {(allowEssay ? ["ping", "essay"] : ["ping"]).map((testType) => (
        <button
          key={testType}
          type="button"
          onClick={() => onTest(testType)}
          disabled={isTesting}
          title={!allowEssay ? "Test this model" : testType === "essay" ? 'Send "write a small essay" and measure streaming speed' : "Send a short ping and request pong"}
          className="min-h-8 rounded border border-border px-2 text-xs text-text-main hover:bg-sidebar hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60"
        >
          {!allowEssay ? isTesting ? "Testing…" : "Test" : isTesting && testingType === testType ? `${testType === "essay" ? "Essay" : "Ping"}…` : testType === "essay" ? "Essay" : "Ping"}
        </button>
      ))}
    </div>
  );
}

ModelTestControls.propTypes = {
  onTest: PropTypes.func.isRequired,
  isTesting: PropTypes.bool,
  testingType: PropTypes.string,
  allowEssay: PropTypes.bool,
};

export default function ModelTestResults({ result, testType = "ping" }) {
  if (!result) return null;
  const multiple = result.totalCount > 1;
  const errors = result.errors?.length ? result.errors : result.error ? [{ error: result.error }] : [];
  const label = testType === "essay" ? "Essay" : "Ping";
  const speed = Number.isFinite(result.tokensPerSecond) ? `${result.tokensEstimated ? "~" : ""}${result.tokensPerSecond.toFixed(1)} tok/s` : "N/A";
  return (
    <div className="mt-2 min-w-0 space-y-1 text-xs" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium text-text-main">{label}</span>
        <span className="text-text-muted">
          {multiple ? `Average · ${result.successCount}/${result.totalCount} keys passed` : result.ok ? "Passed" : "Failed"}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
        {testType === "essay" ? (
          <>
            <div title="Time from sending the request to the first output token"><dt className="inline">First token </dt><dd className="inline font-mono text-text-main">{duration(result.ttftMs)}</dd></div>
            <div title={result.tokensEstimated ? "Estimated output tokens per second; provider did not report token usage" : "Output tokens per second during generation"}><dt className="inline">Speed </dt><dd className="inline font-mono text-text-main">{speed}</dd></div>
            <div title="Time from the first output token to the last output token"><dt className="inline">Response </dt><dd className="inline font-mono text-text-main">{duration(result.responseDurationMs)}</dd></div>
          </>
        ) : (
          <div><dt className="inline">Round trip </dt><dd className="inline font-mono text-text-main">{duration(result.latencyMs)}</dd></div>
        )}
      </dl>
      {testType === "essay" && <p className="text-text-muted">Response: first to last token.{result.tokensEstimated ? " Speed uses an estimated token count." : ""}</p>}
      {result.note && <p className="text-text-muted">{result.note}</p>}
      {errors.length > 0 && (
        <ul className="space-y-1 break-words text-red-700 dark:text-red-400" aria-label={`${label} errors`}>
          {errors.map((entry, index) => (
            <li key={entry.connectionId || index}>
              {entry.connectionName ? `${entry.connectionName}: ` : ""}{entry.error}
              {regionSettingsLink(entry.error) && <a className="ml-2 underline focus-visible:outline-2 focus-visible:outline-primary" href={regionSettingsLink(entry.error)} target="_blank" rel="noreferrer">Allow China-hosted models</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

ModelTestResults.propTypes = {
  result: PropTypes.object,
  testType: PropTypes.oneOf(["ping", "essay"]),
};
