import { createHash } from "node:crypto";
import { proxyAwareFetch } from "./proxyFetch.js";
import { isCustomApiProvider, sanitizeCustomApiRequest } from "./customApiPrivacy.js";
import { acquireCustomApiSession, isCustomApiSessionPinningEnabled } from "./customApiSession.js";

// Keep a session leased until the upstream body stops, including cancellation.
// Releasing at response headers would let a live stream outlast its session.
function leaseResponse(response, lease, signal) {
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let cancelling = false;
  let cancellation;
  let controller;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    lease.release();
  };
  const cancel = (reason) => {
    if (cancellation) return cancellation;
    cancelling = true;
    cancellation = (async () => {
      try { await reader.cancel(reason); }
      finally { finish(); }
    })();
    return cancellation;
  };
  const onAbort = () => {
    cancel(signal.reason).catch(() => {}).finally(() => {
      try { controller.error(signal.reason); } catch {}
    });
  };
  const body = new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      try {
        const next = await reader.read();
        if (finished || cancelling) return;
        if (next.done) {
          finish();
          value.close();
        } else value.enqueue(next.value);
      } catch (error) {
        if (cancelling || finished) return;
        if (signal?.aborted !== true) lease.markDraining();
        finish();
        value.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Preserve fetch metadata used by downstream response handling.
  for (const key of ["url", "redirected", "type"]) {
    Object.defineProperty(wrapped, key, { value: response[key] });
  }
  return wrapped;
}

/** Outbound boundary shared by custom chat, media and diagnostic requests. */
export async function fetchCustomApi(provider, credentials, url, options = {}, proxyOptions = null) {
  if (!isCustomApiProvider(provider)) {
    return proxyOptions ? proxyAwareFetch(url, options, proxyOptions) : fetch(url, options);
  }
  const data = credentials?.providerSpecificData || {};
  const sanitized = sanitizeCustomApiRequest(provider, credentials, {
    url, headers: options.headers, body: options.body,
  });
  const requestOptions = { ...options, headers: sanitized.headers, body: sanitized.body };
  const effectiveProxy = {
    connectionProxyEnabled: data.connectionProxyEnabled === true,
    connectionProxyUrl: data.connectionProxyUrl || "",
    connectionNoProxy: data.connectionNoProxy || "",
    vercelRelayUrl: data.vercelRelayUrl || "",
    strictProxy: data.strictProxy === true,
    ...proxyOptions,
  };
  if (!isCustomApiSessionPinningEnabled(provider, data)) {
    // Preserve the normal fetch path when no connection proxy is configured.
    const hasProxy = effectiveProxy.connectionProxyEnabled || effectiveProxy.vercelRelayUrl || effectiveProxy.strictProxy;
    return hasProxy || proxyOptions
      ? proxyAwareFetch(sanitized.url, requestOptions, effectiveProxy)
      : fetch(sanitized.url, requestOptions);
  }
  if (!effectiveProxy.connectionProxyEnabled || effectiveProxy.vercelRelayUrl) {
    throw new Error("Custom API session pinning requires a supported connection proxy");
  }
  const lease = acquireCustomApiSession({
    provider,
    connectionId: credentials.connectionId || credentials.id,
    accountFingerprint: createHash("sha256").update(credentials.apiKey || credentials.accessToken || "").digest("hex"),
    providerSpecificData: data,
    proxyUrl: effectiveProxy.connectionProxyUrl,
  });
  if (!lease) {
    throw new Error("Custom API account is draining; select another account");
  }
  try {
    const response = await proxyAwareFetch(sanitized.url, requestOptions, {
      ...effectiveProxy,
      connectionProxyUrl: lease.proxyUrl,
      url: lease.proxyUrl,
      enabled: true,
      connectionNoProxy: "",
      noProxy: "",
      strictProxy: true,
    });
    return leaseResponse(response, lease, options.signal);
  } catch (error) {
    if (options.signal?.aborted !== true && error?.name !== "AbortError") lease.markDraining();
    lease.release();
    throw error;
  }
}
