import { createHmac, randomBytes } from "node:crypto";
import { resolveConnectionProxyConfig } from "./connectionProxy";
import { fetchCustomApi } from "open-sse/utils/customApiFetch.js";
import { isCustomApiSessionPinningEnabled } from "open-sse/utils/customApiSession.js";

// Validation before saving a key still needs a private proxy session. A
// process-secret digest isolates those requests without storing the key.
const saltKey = Symbol.for("9router.customApiValidationSalt");
const validationSalt = globalThis[saltKey] ||= randomBytes(32);

/** Fetch a custom API diagnostic and finish its body before releasing the lease. */
export async function fetchCustomApiDiagnostic(connection, url, options = {}, proxy = null) {
  const data = connection.providerSpecificData || {};
  const connectionId = connection.connectionId || connection.id || `validation-${createHmac("sha256", validationSalt)
    .update(JSON.stringify([connection.provider, connection.apiKey || "", data.baseUrl || ""]))
    .digest("hex")}`;
  const effectiveProxy = proxy || await resolveConnectionProxyConfig(data);
  const proxyOptions = effectiveProxy.connectionProxyEnabled || effectiveProxy.vercelRelayUrl || effectiveProxy.strictProxy
    ? effectiveProxy : null;
  const response = await fetchCustomApi(connection.provider, {
    ...connection,
    connectionId,
    providerSpecificData: { ...data, ...effectiveProxy },
  }, url, options, proxyOptions);
  if (!isCustomApiSessionPinningEnabled(connection.provider, data)) return response;
  // Diagnostic callers often inspect only status. Buffering here means an
  // ignored error/models response cannot leave the account leased forever.
  const body = response.body ? await response.arrayBuffer() : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
