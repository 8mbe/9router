import { CUSTOM_API_PROVIDER_PREFIXES } from "./customApiPrivacy.js";

export const CUSTOM_API_SESSION_CONFIG = Object.freeze({
  providerPrefixes: CUSTOM_API_PROVIDER_PREFIXES,
  storageKey: "9router.customApiSessions.v1",
  sessionBytes: 16,
  placeholder: "{session}",
  brightDataHost: "brd.superproxy.io",
  supportedProtocols: ["http:", "https:"],
  proxyErrorCode: "CUSTOM_API_SESSION_PROXY_INVALID",
});
