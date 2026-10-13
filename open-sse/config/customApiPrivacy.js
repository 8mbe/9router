export const CUSTOM_API_PROVIDER_PREFIXES = Object.freeze([
  "openai-compatible-", "anthropic-compatible-", "custom-embedding-",
]);

// Names are normalized by removing punctuation and lowercasing. This policy
// covers transport metadata, never message contents, tool arguments or schemas.
export const CUSTOM_API_PRIVATE_FIELDS = Object.freeze([
  "user", "userid", "username", "email", "phone", "accountid",
  "session", "sessionid", "conversationid", "threadid", "clientid",
  "deviceid", "machineid", "installationid", "visitorid", "distinctid",
  "requestid", "traceid", "correlationid", "safetyidentifier",
  "promptcachekey", "cachekey", "metadata", "clientmetadata", "useragent",
  "client", "device", "machine", "installation", "clientversion",
]);

export const CUSTOM_API_PRIVATE_HEADERS = Object.freeze([
  "user-agent", "cookie", "cookie2", "origin", "referer", "http-referer", "from",
  "forwarded", "via", "x-real-ip", "x-client-ip", "true-client-ip",
  "cf-connecting-ip", "cf-connecting-ipv6", "cf-ray", "fastly-client-ip",
  "traceparent", "tracestate", "baggage", "b3", "sentry-trace",
  "x-amzn-trace-id", "x-cloud-trace-context", "x-app", "x-initiator",
  "x-amp-thread-id", "x-codex-turn-metadata", "x-oai-web-search-eligible",
  "x-statsig-id", "x-title", "originator", "editor-version", "editor-plugin-version",
  "copilot-integration-id",
]);

export const CUSTOM_API_PRIVATE_HEADER_PREFIXES = Object.freeze([
  "x-forwarded-", "x-stainless-", "sec-ch-", "x-claude-code-",
  "x-client-", "x-app-", "x-b3-", "x-9router-", "sec-fetch-",
]);

export const CUSTOM_API_PRIVATE_HEADER_PATTERNS = Object.freeze([
  /(session|conversation|thread|device|machine|installation|tracking|trace|correlation)/,
  /(user|client|account|request|visitor|distinct)(id|identifier)/,
  /(email|username|userphone|accountphone|clientphone)/,
]);

export const CUSTOM_API_TRACKING_QUERY_PATTERN = /^utm_/i;

// Keep API authentication and protocol negotiation. Account credentials still
// identify the upstream account, even when request anonymization is enabled.
export const CUSTOM_API_AUTH_HEADERS = Object.freeze([
  "authorization", "proxy-authorization", "x-api-key", "api-key",
  "x-goog-api-key", "xi-api-key",
]);

export const CUSTOM_API_ANONYMOUS_AUDIO_FILENAME = "audio";
export const CUSTOM_API_AUDIO_EXTENSIONS = Object.freeze([
  "mp3", "mp4", "m4a", "wav", "ogg", "flac", "webm", "aac", "opus",
]);
