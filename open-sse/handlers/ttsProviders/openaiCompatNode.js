import { Buffer } from "node:buffer";

export default {
  async synthesize(text, model, credentials, _responseFormat, options = {}) {
    const baseUrl = credentials?.providerSpecificData?.baseUrl?.trim().replace(/\/+$/, "");
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!baseUrl || !apiKey) throw new Error("Custom speech provider requires a base URL and API key");
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text, voice: options.voice || "alloy" }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `Speech upstream returned ${response.status}`);
    }
    const format = response.headers.get("content-type")?.split("/")[1]?.split(";")[0] || "mpeg";
    return { base64: Buffer.from(await response.arrayBuffer()).toString("base64"), format };
  },
};
