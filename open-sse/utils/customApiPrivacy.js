import {
  CUSTOM_API_PROVIDER_PREFIXES,
  CUSTOM_API_PRIVATE_FIELDS,
  CUSTOM_API_PRIVATE_HEADERS,
  CUSTOM_API_PRIVATE_HEADER_PREFIXES,
  CUSTOM_API_PRIVATE_HEADER_PATTERNS,
  CUSTOM_API_TRACKING_QUERY_PATTERN,
  CUSTOM_API_AUTH_HEADERS,
  CUSTOM_API_ANONYMOUS_AUDIO_FILENAME,
  CUSTOM_API_AUDIO_EXTENSIONS,
} from "../config/customApiPrivacy.js";

const privateFields = new Set(CUSTOM_API_PRIVATE_FIELDS);
const privateHeaders = new Set(CUSTOM_API_PRIVATE_HEADERS);
const authHeaders = new Set(CUSTOM_API_AUTH_HEADERS);
const audioExtensions = new Set(CUSTOM_API_AUDIO_EXTENSIONS);
const normalizeField = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

export function isCustomApiProvider(provider) {
  return CUSTOM_API_PROVIDER_PREFIXES.some((prefix) => provider?.startsWith?.(prefix));
}

export function shouldAnonymizeCustomApi(provider, credentials) {
  return isCustomApiProvider(provider) && credentials?.providerSpecificData?.anonymizeRequests === true;
}

function isPrivateHeader(name) {
  const lower = name.toLowerCase();
  if (authHeaders.has(lower)) return false;
  if (privateHeaders.has(lower) || CUSTOM_API_PRIVATE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  const normalized = normalizeField(name);
  // Catch provider-specific spellings such as OAI-Device-ID and X-Mavis-Session-Id.
  return CUSTOM_API_PRIVATE_HEADER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function anonymizeHeaders(headers) {
  const entries = headers instanceof Headers ? headers.entries()
    : Array.isArray(headers) ? headers : Object.entries(headers || {});
  return Object.fromEntries(Array.from(entries).filter(([name]) => !isPrivateHeader(name)));
}

function anonymousFilename(file) {
  const extension = typeof file.name === "string" ? file.name.split(".").pop().toLowerCase() : "";
  return audioExtensions.has(extension)
    ? `${CUSTOM_API_ANONYMOUS_AUDIO_FILENAME}.${extension}` : CUSTOM_API_ANONYMOUS_AUDIO_FILENAME;
}

function anonymizeBody(body) {
  if (typeof body === "string") {
    try { return JSON.stringify(anonymizeBody(JSON.parse(body))); } catch { return body; }
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const result = new FormData();
    for (const [name, value] of body.entries()) {
      if (privateFields.has(normalizeField(name))) continue;
      if (value instanceof Blob) result.append(name, value, anonymousFilename(value));
      else result.append(name, value);
    }
    return result;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) return body;
  return Object.fromEntries(Object.entries(body).filter(([name]) => !privateFields.has(normalizeField(name))));
}

function anonymizeUrl(url) {
  if (!url) return url;
  const parsed = new URL(url);
  let changed = false;
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (privateFields.has(normalizeField(name)) || CUSTOM_API_TRACKING_QUERY_PATTERN.test(name)) {
      parsed.searchParams.delete(name);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

/**
 * Apply privacy after all provider transformations and header overrides, on
 * every outbound attempt. Original objects remain usable for other accounts.
 *
 * Credentials, network IP, message/media contents and functional upstream
 * references (previous_response_id and Responses conversation) remain visible.
 * Those references are required to resume context; removing them would change
 * the requested conversation. Metadata/client_metadata are omitted entirely,
 * since arbitrary metadata keys can contain identity. No recursive content
 * rewriting: tool IDs, JSON schemas and media payloads must remain intact.
 */
export function sanitizeCustomApiRequest(provider, credentials, { url, headers, body }) {
  if (!shouldAnonymizeCustomApi(provider, credentials)) return { url, headers, body };
  return { url: anonymizeUrl(url), headers: anonymizeHeaders(headers), body: anonymizeBody(body) };
}
