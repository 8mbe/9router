import { Buffer } from "node:buffer";
import { CUSTOM_API_PROVIDER_PREFIXES } from "../../config/customApiPrivacy.js";
import { sanitizeCustomApiRequest } from "../../utils/customApiPrivacy.js";
import { fetchCustomApi } from "../../utils/customApiFetch.js";

export default {
  async synthesize(text, model, credentials, _responseFormat, options = {}) {
    const baseUrl = credentials?.providerSpecificData?.baseUrl?.trim().replace(/\/+$/, "");
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!baseUrl || !apiKey) throw new Error("Custom speech provider requires a base URL and API key");
    const provider = options.provider || CUSTOM_API_PROVIDER_PREFIXES[0];
    const request = sanitizeCustomApiRequest(provider, credentials, {
      url: `${baseUrl}/audio/speech`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: { model, input: text, voice: options.voice || "alloy" },
    });
    const response = await fetchCustomApi(provider, credentials, request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `Speech upstream returned ${response.status}`);
    }
    const format = response.headers.get("content-type")?.split("/")[1]?.split(";")[0] || "mpeg";
    return { base64: Buffer.from(await response.arrayBuffer()).toString("base64"), format };
  },
};
