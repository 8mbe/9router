import { TREG_CONFIG, TREG_ROUTES } from "../../config/treg.js";

export function buildTregHeaders(credentials, extraHeaders = {}) {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) throw new Error("Treg token required");
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...extraHeaders, "X-Treg-Token": token };
  const org = credentials?.providerSpecificData?.org;
  if (org) headers["X-Treg-Org"] = org;
  return headers;
}

export function buildTregCallUrl(endpoint, query = {}) {
  // Catalog IDs are local configuration, never caller-supplied URLs.
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(endpoint)) throw new Error("Invalid Treg endpoint");
  const url = new URL(`/call/${endpoint}`, TREG_CONFIG.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function getTregRoute(model, kind) {
  const route = Object.hasOwn(TREG_ROUTES, model) ? TREG_ROUTES[model] : null;
  if (!route || route.kind !== kind) throw new Error(`Unsupported Treg ${kind} model: ${model}`);
  return route;
}

export function valueAt(data, path) {
  return path?.split(".").reduce((value, key) => value?.[key], data);
}

export function sanitizeTregMessage(message, credentials = {}) {
  let sanitized = String(message);
  for (const secret of [credentials.apiKey, credentials.accessToken, credentials["X-Treg-Token"]]) {
    if (typeof secret === "string" && secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized;
}

export async function assertTregResponse(response, credentials = {}) {
  if (response.ok) return;
  const text = await response.text();
  let message = `Treg upstream error (${response.status})`;
  try {
    const data = JSON.parse(text);
    message = data?.detail?.message || data?.error?.message || data?.message || (typeof data?.detail === "string" ? data.detail : message);
  } catch { /* Keep the status when the response is not JSON. */ }
  const error = new Error(sanitizeTregMessage(message, credentials));
  error.status = response.status;
  throw error;
}

export function assertTregTask(data) {
  const code = Number(data?.base_resp?.status_code || 0);
  if (code) throw new Error(`Treg provider error (${code})`);
}

export function tregResponseHeaders(response) {
  const headers = {};
  for (const key of ["X-Treg-Call-Id", "X-Treg-Cost-Micro"]) {
    const value = response.headers.get(key);
    if (value != null) headers[key] = value;
  }
  return headers;
}

export async function pollTregTask(route, taskId, headers, signal) {
  const descriptor = route.async;
  const response = await fetch(buildTregCallUrl(descriptor.poll.endpoint, { [descriptor.poll.param.name]: taskId }), {
    headers, signal: signal || AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs), redirect: "error",
  });
  await assertTregResponse(response, headers);
  const data = await response.json();
  assertTregTask(data);
  return data;
}

export function tregTaskStatus(route, data) {
  const descriptor = route.async;
  const status = valueAt(data, descriptor.status.path);
  if (descriptor.status.failure.includes(status)) return "failed";
  if (descriptor.status.success.includes(status)) return "completed";
  return "pending";
}

export async function tregTaskResult(route, data, headers, signal) {
  const result = route.async.result;
  if (result.path) return valueAt(data, result.path);
  const value = valueAt(data, result.fetch_param.value_from);
  if (!value) throw new Error("Treg completed task returned no result reference");
  const response = await fetch(buildTregCallUrl(result.fetch, { [result.fetch_param.name]: value }), {
    headers, signal: signal || AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs), redirect: "error",
  });
  await assertTregResponse(response, headers);
  const payload = await response.json();
  assertTregTask(payload);
  return payload.file?.download_url;
}
