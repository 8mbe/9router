import createOpenAIAdapter from "./openai.js";

const base = createOpenAIAdapter("openai");

export default {
  ...base,
  buildUrl: (_model, credentials) => {
    const baseUrl = credentials?.providerSpecificData?.baseUrl?.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Custom image provider has no base URL");
    return `${baseUrl}/images/generations`;
  },
  buildBody: (model, body) => ({ ...body, model }),
};
